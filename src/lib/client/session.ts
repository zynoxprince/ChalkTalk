"use client";

import { compileTimeline, estimateDuration, type AudioInfo, type SceneInput, type Timeline } from "@/lib/board/timeline";
import type { BoardElement } from "@/lib/board/layout";
import type { Level, Outline, QuizItem, Scene, Segment } from "@/lib/lesson/schema";
import type { SavedLesson } from "@/lib/lesson/saved";
import { pcm16ToBuffer, unlockAudio } from "@/lib/player/audio";
import { LessonPlayer } from "@/lib/player/player";
import { BrowserNarrator } from "@/lib/player/narrator";
import { isNetworkError, mergeIntro, wait, whenVisible } from "./resilience";

/**
 * Orchestrates one lesson in the browser:
 *   outline (fast) → intro starts playing
 *   3 chapters in parallel → appended as they arrive
 *   recap + quiz, written from what the chapters actually said
 *   every segment voiced through a small priority queue
 * The timeline is recompiled whenever content or audio arrives; the player
 * keeps playing up to the "ready" edge and waits there if it catches up.
 * A dropped connection never ends the lesson: requests are retried once the
 * page is visible again, and a plan that has arrived is never thrown away.
 */

export type SceneStatus = "pending" | "streaming" | "ready" | "failed";

export interface SessionScene {
  scene: Scene;
  status: SceneStatus;
  error?: string;
}

export interface SessionState {
  phase: "planning" | "lesson" | "error";
  error: string | null;
  topic: string;
  level: Level;
  source: "live" | "sample";
  title: string;
  summary: string;
  scopeNote: string | null;
  refusal: string | null;
  clarify: { question: string; options: string[] } | null;
  chapters: { title: string; goal: string }[];
  scenes: SessionScene[];
  quiz: QuizItem[];
  suggestions: string[];
  timeline: Timeline | null;
  voice: { ready: number; total: number; failed: number };
  /** Some narration could not be voiced: captions carry the lesson there. */
  degraded: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status}).`, res.status);
  return json as T;
}

/** Sample rate of a raw-PCM speech response (24 kHz unless the server says otherwise). */
function sampleRateOf(res: Response): number {
  const rate = Number(res.headers.get("x-audio-format")?.match(/rate=(\d+)/)?.[1]);
  return rate >= 8000 && rate <= 96000 ? rate : 24000;
}

/** Decodes a speech response: MP3 (what the app asks for) or raw 16-bit PCM. */
function toAudioBuffer(ctx: AudioContext, res: Response, bytes: ArrayBuffer): Promise<AudioBuffer> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("audio/mpeg") && !res.url.endsWith(".mp3")) return Promise.resolve(pcm16ToBuffer(ctx, bytes, sampleRateOf(res)));
  // The callback form also works on older Safari, where decodeAudioData doesn't return a promise.
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject) as Promise<AudioBuffer> | undefined;
    p?.then(resolve, reject);
  });
}

/** One line being voiced (shared by every segment with the same text). */
interface VoiceJob {
  url: string;
  /** Lesson order: scene, then line. Lower is needed sooner. */
  order: number;
  segments: Segment[];
  state: "queued" | "running" | "done";
  /** The audio, or null if it couldn't be voiced. */
  buffer: AudioBuffer | null;
}

/** POSTs JSON and returns the response for streaming, with friendly errors. */
async function openStream(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));
    throw new ApiError(j.error ?? `Request failed (${res.status}).`, res.status);
  }
  return res;
}

/** Yields one parsed object per line of an NDJSON response. */
async function* readNdjson<T>(res: Response): AsyncGenerator<T> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  const last = buf.trim();
  if (last) {
    let item: T | undefined;
    try {
      item = JSON.parse(last) as T;
    } catch {
      // A last line cut off by a dropped connection.
    }
    if (item !== undefined) yield item;
  }
}

/** Server trouble worth another try (a model that failed or timed out), unlike "too many requests" or a refusal. */
const retryable = (e: unknown) => isNetworkError(e) || (e instanceof ApiError && (e.status === 500 || e.status === 502 || e.status === 504));

/** Browsers word dropped connections tersely ("Load failed"); say what happened instead. */
const friendly = (e: unknown) => (isNetworkError(e) ? "The connection dropped while your lesson was being written. Please try again." : (e as Error).message);

const SCENE_ESTIMATE = { intro: 12, chapter: 32, recap: 14 };

export class LessonSession {
  readonly player: LessonPlayer;
  private ctx: AudioContext | null;
  private audio = new Map<string, AudioInfo>();
  private buffers = new Map<string, AudioBuffer>();
  private jobs = new Map<string, VoiceJob>();
  private queued: VoiceJob[] = [];
  private active = 0;
  private aborter = new AbortController();
  private listeners = new Set<() => void>();
  private outline: Outline | null = null;
  private audioBase: string | null = null;
  private disposed = false;
  private autoplay = false;
  /** The speech provider said it's unavailable: stop asking, use the browser voice. */
  private ttsDown = false;
  private narrator: BrowserNarrator | null;
  state: SessionState;

  constructor(opts: { topic: string; level: Level; ctx: AudioContext | null; source?: "live" | "sample"; autoplay?: boolean }) {
    this.ctx = opts.ctx;
    this.autoplay = !!opts.autoplay;
    this.narrator = BrowserNarrator.create();
    this.player = new LessonPlayer({ ctx: opts.ctx, narrator: this.narrator });
    this.state = {
      phase: "planning",
      error: null,
      topic: opts.topic,
      level: opts.level,
      source: opts.source ?? "live",
      title: "",
      summary: "",
      scopeNote: null,
      refusal: null,
      clarify: null,
      chapters: [],
      scenes: [],
      quiz: [],
      suggestions: [],
      timeline: null,
      voice: { ready: 0, total: 0, failed: 0 },
      degraded: !opts.ctx,
    };
  }

  /* ---------------------------- subscription ---------------------------- */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<SessionState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  dispose() {
    this.disposed = true;
    this.aborter.abort();
    this.player.dispose();
    this.listeners.clear();
  }

  /* ----------------------------- live lessons ---------------------------- */

  async startLive() {
    const { topic, level } = this.state;
    // The intro board is titled with the learner's own question.
    const introTitle = topic.charAt(0).toUpperCase() + topic.slice(1);
    let introSegments: Segment[] = [];
    let introDone = false;
    let outline: Outline | null = null;
    let chapters: Promise<void> | null = null;

    const introScene = (): SessionScene => ({
      scene: { id: "intro", kind: "intro", title: introTitle, segments: introSegments },
      status: introDone ? "ready" : introSegments.length ? "streaming" : "pending",
    });
    const publish = () => {
      const rest = this.state.scenes.slice(1);
      this.set({ phase: "lesson", scenes: [introScene(), ...rest] });
      this.recompile();
    };

    // Chapter 1 is written by the same call as the plan and streams in on this response.
    let chapterOne = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await openStream("/api/lesson/outline", { topic, level }, this.aborter.signal);
        for await (const msg of readNdjson<{
          intro?: Segment;
          outline?: Outline;
          voice?: { id: string; narration: string; sig: string };
          segment?: Segment;
          introDone?: boolean;
          done?: boolean;
          refusal?: string;
          error?: string;
        }>(res)) {
          if (msg.refusal) {
            this.set({ phase: "error", refusal: msg.refusal, error: msg.refusal });
            return;
          }
          if (msg.error) {
            // A failure after the plan only costs chapter 1, which can be asked for separately.
            if (outline) break;
            throw new ApiError(msg.error, 502);
          }
          if (msg.outline && !outline) {
            // The plan: lay out the chapter list and start writing chapters 2 and 3 now.
            outline = msg.outline;
            this.outline = outline;
            this.set({
              title: outline.title,
              summary: outline.summary,
              scopeNote: outline.scope_note,
              clarify: outline.clarify,
              chapters: outline.chapters.map((c) => ({ title: c.title, goal: c.goal })),
              scenes: [
                introScene(),
                ...outline.chapters.map((c, i): SessionScene => ({ scene: { id: `c${i + 1}`, kind: "chapter", title: c.title, segments: [] }, status: "pending" })),
                { scene: { id: "recap", kind: "recap", title: "Recap", segments: [] }, status: "pending" },
              ],
            });
            const plan = outline;
            chapters = Promise.all(plan.chapters.map((_, i) => (i === 0 ? Promise.resolve() : this.loadChapter(i)))).then(() => undefined);
            this.recompile();
          }
          if (msg.intro && !introDone) {
            // Intro lines, in order: voiced as soon as they arrive (a retried stream repeats some).
            const line = mergeIntro(introSegments, msg.intro);
            if (line) {
              introSegments = [...introSegments, line];
              this.enqueue([line]);
              publish();
            }
          }
          if (msg.introDone && !introDone) {
            introDone = true;
            publish();
          }
          if (msg.voice) this.prefetch(msg.voice);
          if (msg.segment && outline) {
            chapterOne++;
            const cur = this.state.scenes[1].scene;
            this.replaceScene(1, { scene: { ...cur, segments: [...cur.segments, msg.segment] }, status: "streaming" });
            this.enqueue([msg.segment]);
            this.recompile();
          }
          if (msg.done) {
            introDone = true;
            publish();
          }
        }
        if (!outline) throw new ApiError("The lesson plan could not be written. Please try again.", 502);
        break;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        // Once the plan is here, a dropped connection costs at most the rest of chapter 1.
        if (outline) break;
        if (attempt < 3 && retryable(e)) {
          await whenVisible();
          await wait(700 * attempt);
          if (this.disposed) return;
          continue;
        }
        this.set({ phase: "error", error: friendly(e) });
        return;
      }
    }
    if (!chapters) return;
    if (!introDone) {
      introDone = true;
      publish();
    }
    if (chapterOne > 0) {
      this.replaceScene(1, { scene: this.state.scenes[1].scene, status: "ready" });
      this.recompile();
    } else {
      await this.loadChapter(0);
    }
    await chapters;
    await this.loadRecap();
  }

  private async loadChapter(index: number, attempt = 1): Promise<void> {
    const { topic, level } = this.state;
    const slot = index + 1;
    const base = this.state.scenes[slot].scene;
    let received = 0;
    try {
      const res = await openStream("/api/lesson/chapter", { topic, level, outline: this.outline, index }, this.aborter.signal);
      // NDJSON: one segment per line as soon as the model has written it.
      let streamError: string | null = null;
      for await (const msg of readNdjson<{ voice?: { id: string; narration: string; sig: string }; segment?: Segment; done?: boolean; error?: string }>(res)) {
        if (msg.voice) {
          // The line's text is written; its drawings are still coming. Start voicing now.
          this.prefetch(msg.voice);
        } else if (msg.segment) {
          received++;
          const cur = this.state.scenes[slot].scene;
          this.replaceScene(slot, { scene: { ...cur, segments: [...cur.segments, msg.segment] }, status: "streaming" });
          this.enqueue([msg.segment]);
          this.recompile();
        } else if (msg.error) {
          streamError = msg.error;
        }
      }
      if (received === 0) throw new ApiError(streamError ?? "This chapter came back empty.", 502);
      this.replaceScene(slot, { scene: this.state.scenes[slot].scene, status: "ready" });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (received > 0) {
        // Keep what arrived; the lesson simply moves on sooner.
        this.replaceScene(slot, { scene: this.state.scenes[slot].scene, status: "ready" });
        this.recompile();
        return;
      }
      this.replaceScene(slot, { scene: base, status: "pending" });
      // A dropped connection (often a tab in the background) gets more tries, once the page is visible again.
      const network = isNetworkError(e);
      if (attempt < (network ? 4 : 2) && !(e instanceof ApiError && e.status === 429)) {
        if (network) {
          await whenVisible();
          await wait(600 * attempt);
        }
        if (this.disposed) return;
        return this.loadChapter(index, attempt + 1);
      }
      const title = this.outline?.chapters[index]?.title ?? `Chapter ${index + 1}`;
      // Skip this chapter so the lesson keeps going; the panel offers a retry.
      this.replaceScene(index + 1, {
        scene: { id: `c${index + 1}`, kind: "chapter", title, segments: [] },
        status: "failed",
        error: friendly(e),
      });
    }
    this.recompile();
  }

  private async loadRecap(attempt = 1): Promise<void> {
    const { topic, level } = this.state;
    const taught = this.state.scenes.filter((s) => s.scene.kind === "chapter").map((s) => s.scene.segments.map((g) => g.narration).join(" "));
    try {
      const recap = await postJson<{ scene: Scene; quiz: QuizItem[]; suggestions: string[] }>(
        "/api/lesson/recap",
        { topic, level, outline: this.outline, taught },
        this.aborter.signal,
      );
      const idx = this.state.scenes.findIndex((s) => s.scene.kind === "recap");
      this.replaceScene(idx, { scene: recap.scene, status: "ready" });
      this.set({ quiz: recap.quiz, suggestions: recap.suggestions });
      this.enqueue(recap.scene.segments);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (attempt < 3 && retryable(e)) {
        await whenVisible();
        await wait(800 * attempt);
        if (!this.disposed) return this.loadRecap(attempt + 1);
        return;
      }
      const idx = this.state.scenes.findIndex((s) => s.scene.kind === "recap");
      this.replaceScene(idx, { ...this.state.scenes[idx], status: "failed", error: friendly(e) });
    }
    this.recompile();
  }

  /** Retry a chapter that failed to generate. */
  async retryChapter(index: number) {
    this.replaceScene(index + 1, { ...this.state.scenes[index + 1], status: "pending", error: undefined });
    this.recompile();
    await this.loadChapter(index);
  }

  private replaceScene(i: number, s: SessionScene) {
    const scenes = [...this.state.scenes];
    scenes[i] = s;
    this.set({ scenes });
  }

  /* ------------------------------ samples -------------------------------- */

  async loadSaved(lesson: SavedLesson) {
    this.audioBase = lesson.audioBase ?? null;
    this.set({
      phase: "lesson",
      source: "sample",
      title: lesson.title,
      summary: lesson.summary,
      scopeNote: lesson.scopeNote,
      chapters: lesson.scenes.filter((s) => s.kind === "chapter").map((s) => ({ title: s.title, goal: "" })),
      scenes: lesson.scenes.map((scene) => ({ scene, status: "ready" as const })),
      quiz: lesson.quiz,
      suggestions: lesson.suggestions,
    });
    for (const s of lesson.scenes) this.enqueue(s.segments);
    this.recompile();
  }

  /* ------------------------------- voice --------------------------------- */
  //
  // Every line is voiced through a small scheduler. Jobs are keyed by audio URL,
  // so a line whose text arrived early ("voice" message) and the full segment
  // that follows share one request. Jobs run in lesson order, a few at a time;
  // the next lines the learner is about to hear may run beyond that limit, so
  // they never wait behind lines from later chapters.

  private urlFor(narration: string, sig: string, id?: string) {
    return this.audioBase && id ? `${this.audioBase}/${id}.mp3` : `/api/tts?t=${encodeURIComponent(narration)}&s=${encodeURIComponent(sig)}&f=mp3`;
  }

  private jobFor(url: string, order: number): VoiceJob {
    let job = this.jobs.get(url);
    if (!job) {
      job = { url, order, segments: [], state: "queued", buffer: null };
      this.jobs.set(url, job);
      this.queued.push(job);
    } else {
      job.order = Math.min(job.order, order);
    }
    return job;
  }

  /** A line's text arrived before its drawings: start voicing it now. */
  private prefetch(v: { id: string; narration: string; sig: string }) {
    if (!this.ctx || this.ttsDown || this.disposed) return;
    this.jobFor(this.urlFor(v.narration, v.sig), this.globalIndex(v.id));
    this.pump();
  }

  private enqueue(segments: Segment[]) {
    for (const seg of segments) {
      const job = this.jobFor(this.urlFor(seg.narration, seg.sig, seg.id), this.globalIndex(seg.id));
      job.segments.push(seg);
      if (job.state === "done") this.settleSegment(seg, job.buffer);
    }
    this.set({ voice: { ...this.state.voice, total: this.state.voice.total + segments.length } });
    this.pump();
  }

  private globalIndex(segmentId: string) {
    const [sceneId, n] = [segmentId.slice(0, segmentId.lastIndexOf("-")), Number(segmentId.slice(segmentId.lastIndexOf("-") + 1))];
    const sceneOrder = sceneId === "intro" ? 0 : sceneId === "recap" ? 9 : Number(sceneId.replace(/\D/g, "")) || 5;
    return sceneOrder * 100 + (Number.isFinite(n) ? n : 0);
  }

  /** Lesson order of the line being played now (lines before it are no longer urgent). */
  private playheadOrder(): number {
    const tl = this.state.timeline;
    if (!tl) return -1;
    const t = this.player.getSnapshot().time;
    let current = tl.segments[0];
    for (const s of tl.segments) if (s.start <= t + 0.05) current = s;
    return current ? this.globalIndex(current.id) : -1;
  }

  private pump() {
    if (this.disposed) return;
    const base = this.audioBase ? 6 : 5;
    const max = base + 3;
    this.queued.sort((a, b) => a.order - b.order);
    // The next two lines to be heard (from the playhead on) are urgent.
    const from = this.playheadOrder();
    const upcoming = [...this.jobs.values()].filter((j) => j.state !== "done" && j.order >= from).map((j) => j.order).sort((a, b) => a - b);
    const urgentUpTo = upcoming[1] ?? upcoming[0] ?? -1;
    while (this.queued.length) {
      const next = this.queued[0];
      const urgent = next.order >= from && next.order <= urgentUpTo;
      if (this.active >= base && !(urgent && this.active < max)) break;
      this.queued.shift();
      void this.run(next);
    }
  }

  private async run(job: VoiceJob) {
    job.state = "running";
    this.active++;
    let buffer: AudioBuffer | null = null;
    if (this.ctx && !this.ttsDown) {
      // Two real attempts. A dropped connection (a tab in the background, a network blip) isn't
      // counted: it's retried once the page is visible, so the line isn't left to the browser voice.
      let failures = 0;
      for (let tries = 0; failures < 2 && tries < 6 && !buffer && !this.disposed; tries++) {
        try {
          buffer = await this.fetchAudio(job.url);
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            this.active--;
            return;
          }
          if (isNetworkError(e)) {
            await whenVisible();
            await wait(400 * (tries + 1));
            continue;
          }
          failures++;
          if (e instanceof ApiError && e.status === 503) this.ttsDown = true;
          if (e instanceof ApiError && (e.status === 403 || e.status === 400 || e.status === 503)) break;
        }
      }
    }
    job.state = "done";
    job.buffer = buffer;
    this.active--;
    for (const seg of job.segments) this.settleSegment(seg, buffer);
    if (job.segments.length) this.recompile();
    this.pump();
  }

  private settleSegment(seg: Segment, buffer: AudioBuffer | null) {
    if (this.audio.has(seg.id)) return;
    if (buffer) {
      this.buffers.set(seg.id, buffer);
      this.audio.set(seg.id, { duration: buffer.duration, ok: true });
      this.player.setAudio(seg.id, buffer);
    } else {
      this.audio.set(seg.id, { duration: estimateDuration(seg.narration), ok: false });
    }
    const v = this.state.voice;
    this.set({ voice: { ...v, ready: v.ready + 1, failed: v.failed + (buffer ? 0 : 1) }, degraded: this.state.degraded || !buffer });
  }

  private async fetchAudio(url: string): Promise<AudioBuffer> {
    if (!this.ctx) throw new Error("no audio");
    const res = await fetch(url, { signal: this.aborter.signal });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new ApiError(j.error ?? `Voice failed (${res.status})`, res.status);
    }
    return toAudioBuffer(this.ctx, res, await res.arrayBuffer());
  }

  /* ------------------------------ timeline ------------------------------- */

  private complete() {
    const allScenesSettled = this.state.scenes.length > 0 && this.state.scenes.every((s) => s.status === "ready" || s.status === "failed");
    const allVoiced = this.state.scenes.every((s) => s.scene.segments.every((g) => this.audio.has(g.id)));
    return allScenesSettled && allVoiced;
  }

  private recompile() {
    if (!this.state.scenes.length) return;
    const inputs: SceneInput[] = this.state.scenes
      .filter((s) => !(s.status === "failed" && s.scene.segments.length === 0))
      .map((s) => ({
        scene: s.scene,
        pending: s.status === "pending",
        partial: s.status === "streaming",
        estimatedDuration: s.scene.kind === "recap" ? SCENE_ESTIMATE.recap : s.scene.kind === "intro" ? SCENE_ESTIMATE.intro : SCENE_ESTIMATE.chapter,
      }));
    const timeline = compileTimeline(inputs, this.audio, { complete: this.complete() });
    this.player.setTimeline(timeline);
    if (this.autoplay) {
      this.autoplay = false;
      this.player.play();
    }
    this.set({ timeline });
  }

  /* ----------------------------- answers --------------------------------- */

  /** Elements fully drawn on the main board at time t (context + base for answers). */
  boardAt(t: number): BoardElement[] {
    const tl = this.state.timeline;
    if (!tl) return [];
    let idx = 0;
    for (let i = 0; i < tl.scenes.length; i++) if (tl.scenes[i].start <= t) idx = i;
    return tl.scenes[idx]?.elements.filter((e) => e.start <= t && !e.transient) ?? [];
  }

  get audioContext() {
    return this.ctx;
  }

  fail(message: string) {
    this.set({ phase: "error", error: message });
  }

  /** Call from a click/tap: browsers only allow sound after a user gesture. */
  async unlock() {
    this.narrator?.prime();
    await unlockAudio(this.ctx);
  }

  get fallbackNarrator() {
    return this.narrator;
  }
}

/* ------------------------------------------------------------------ */
/* Answer playback                                                     */
/* ------------------------------------------------------------------ */

export interface AnswerPlayback {
  player: LessonPlayer;
  timeline: Timeline;
  ready: Promise<void>;
}

/** Voices an answer scene and builds its own small timeline drawn over `base`. */
export function playAnswer(scene: Scene, base: BoardElement[], ctx: AudioContext | null, onUpdate: (tl: Timeline) => void, narrator: BrowserNarrator | null = null): AnswerPlayback {
  const player = new LessonPlayer({ ctx, narrator });
  const audio = new Map<string, AudioInfo>();
  const inputs: SceneInput[] = [{ scene, base, showTitle: base.length === 0 }];
  let timeline = compileTimeline(inputs, audio, { complete: false });
  player.setTimeline(timeline);

  const ready = Promise.all(
    scene.segments.map(async (seg) => {
      try {
        if (!ctx) throw new Error("no audio");
        const res = await fetch(`/api/tts?t=${encodeURIComponent(seg.narration)}&s=${encodeURIComponent(seg.sig)}&f=mp3`);
        if (!res.ok) throw new Error("voice failed");
        const buffer = await toAudioBuffer(ctx, res, await res.arrayBuffer());
        audio.set(seg.id, { duration: buffer.duration, ok: true });
        player.setAudio(seg.id, buffer);
      } catch {
        audio.set(seg.id, { duration: estimateDuration(seg.narration), ok: false });
      }
      timeline = compileTimeline(inputs, audio, { complete: audio.size === scene.segments.length });
      player.setTimeline(timeline);
      onUpdate(timeline);
    }),
  ).then(() => undefined);

  return {
    player,
    get timeline() {
      return timeline;
    },
    ready,
  };
}
