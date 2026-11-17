"use client";

import { compileTimeline, estimateDuration, type AudioInfo, type SceneInput, type Timeline } from "@/lib/board/timeline";
import type { BoardElement } from "@/lib/board/layout";
import type { Level, Outline, QuizItem, Scene, Segment } from "@/lib/lesson/schema";
import type { SavedLesson } from "@/lib/lesson/saved";
import { pcm16ToBuffer, unlockAudio } from "@/lib/player/audio";
import { LessonPlayer } from "@/lib/player/player";

/**
 * Orchestrates one lesson in the browser:
 *   outline (fast) → intro starts playing
 *   3 chapters in parallel → appended as they arrive
 *   recap + quiz, written from what the chapters actually said
 *   every segment voiced through a small priority queue
 * The timeline is recompiled whenever content or audio arrives; the player
 * keeps playing up to the "ready" edge and waits there if it catches up.
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
  if (buf.trim()) yield JSON.parse(buf) as T;
}

const SCENE_ESTIMATE = { chapter: 32, recap: 14 };

export class LessonSession {
  readonly player: LessonPlayer;
  private ctx: AudioContext | null;
  private audio = new Map<string, AudioInfo>();
  private buffers = new Map<string, AudioBuffer>();
  private order = new Map<string, number>();
  private queue: Segment[] = [];
  private active = 0;
  private aborter = new AbortController();
  private listeners = new Set<() => void>();
  private outline: Outline | null = null;
  private audioBase: string | null = null;
  private disposed = false;
  private autoplay = false;
  state: SessionState;

  constructor(opts: { topic: string; level: Level; ctx: AudioContext | null; source?: "live" | "sample"; autoplay?: boolean }) {
    this.ctx = opts.ctx;
    this.autoplay = !!opts.autoplay;
    this.player = new LessonPlayer({ ctx: opts.ctx });
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
    const intro = (segments: Segment[], status: SceneStatus): SessionScene => ({ scene: { id: "intro", kind: "intro", title: introTitle, segments }, status });
    let hook: Segment | null = null;
    let outline: Outline | null = null;
    try {
      const res = await openStream("/api/lesson/outline", { topic, level }, this.aborter.signal);
      for await (const msg of readNdjson<{ hook?: Segment; outline?: Outline; agenda?: Segment; refusal?: string; error?: string }>(res)) {
        if (msg.refusal) {
          this.set({ phase: "error", refusal: msg.refusal, error: msg.refusal });
          return;
        }
        if (msg.error) throw new ApiError(msg.error, 502);
        if (msg.hook) {
          // The opening line arrives first: start voicing it while the plan is written.
          hook = msg.hook;
          this.set({ phase: "lesson", scenes: [intro([hook], "streaming")] });
          this.enqueue([hook]);
          this.recompile();
        }
        if (msg.outline && msg.agenda) {
          outline = msg.outline;
          this.outline = outline;
          this.set({
            phase: "lesson",
            title: outline.title,
            summary: outline.summary,
            scopeNote: outline.scope_note,
            clarify: outline.clarify,
            chapters: outline.chapters.map((c) => ({ title: c.title, goal: c.goal })),
            scenes: [
              intro(hook ? [hook, msg.agenda] : [msg.agenda], "ready"),
              ...outline.chapters.map((c, i): SessionScene => ({ scene: { id: `c${i + 1}`, kind: "chapter", title: c.title, segments: [] }, status: "pending" })),
              { scene: { id: "recap", kind: "recap", title: "Recap", segments: [] }, status: "pending" },
            ],
          });
          this.enqueue([msg.agenda]);
          this.recompile();
        }
      }
      if (!outline) throw new ApiError("The lesson plan could not be written. Please try again.", 502);
    } catch (e) {
      if ((e as Error).name !== "AbortError") this.set({ phase: "error", error: (e as Error).message });
      return;
    }
    await Promise.all(outline.chapters.map((_, i) => this.loadChapter(i)));
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
      for await (const msg of readNdjson<{ segment?: Segment; done?: boolean; error?: string }>(res)) {
        if (msg.segment) {
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
      if (attempt < 2 && !(e instanceof ApiError && e.status === 429)) return this.loadChapter(index, attempt + 1);
      const title = this.outline?.chapters[index]?.title ?? `Chapter ${index + 1}`;
      // Skip this chapter so the lesson keeps going; the panel offers a retry.
      this.replaceScene(index + 1, {
        scene: { id: `c${index + 1}`, kind: "chapter", title, segments: [] },
        status: "failed",
        error: (e as Error).message,
      });
    }
    this.recompile();
  }

  private async loadRecap(): Promise<void> {
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
      const idx = this.state.scenes.findIndex((s) => s.scene.kind === "recap");
      this.replaceScene(idx, { ...this.state.scenes[idx], status: "failed", error: (e as Error).message });
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

  private enqueue(segments: Segment[]) {
    for (const seg of segments) {
      if (!this.order.has(seg.id)) this.order.set(seg.id, this.globalIndex(seg.id));
      this.queue.push(seg);
    }
    this.queue.sort((a, b) => (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0));
    this.set({ voice: { ...this.state.voice, total: this.state.voice.total + segments.length } });
    this.pump();
  }

  private globalIndex(segmentId: string) {
    const [sceneId, n] = [segmentId.slice(0, segmentId.lastIndexOf("-")), Number(segmentId.slice(segmentId.lastIndexOf("-") + 1))];
    const sceneOrder = sceneId === "intro" ? 0 : sceneId === "recap" ? 9 : Number(sceneId.replace(/\D/g, "")) || 5;
    return sceneOrder * 100 + (Number.isFinite(n) ? n : 0);
  }

  private pump() {
    const limit = this.audioBase ? 6 : 4;
    while (this.active < limit && this.queue.length) {
      const seg = this.queue.shift()!;
      this.active++;
      this.voice(seg).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async voice(seg: Segment) {
    let ok = false;
    if (this.ctx) {
      for (let attempt = 1; attempt <= 2 && !ok && !this.disposed; attempt++) {
        try {
          const buffer = await this.fetchAudio(seg);
          this.buffers.set(seg.id, buffer);
          this.audio.set(seg.id, { duration: buffer.duration, ok: true });
          this.player.setAudio(seg.id, buffer);
          ok = true;
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          if (e instanceof ApiError && (e.status === 403 || e.status === 400 || e.status === 503)) break;
        }
      }
    }
    if (!ok) this.audio.set(seg.id, { duration: estimateDuration(seg.narration), ok: false });
    const v = this.state.voice;
    this.set({ voice: { ...v, ready: v.ready + 1, failed: v.failed + (ok ? 0 : 1) }, degraded: this.state.degraded || !ok });
    this.recompile();
  }

  private async fetchAudio(seg: Segment): Promise<AudioBuffer> {
    if (!this.ctx) throw new Error("no audio");
    const url = this.audioBase ? `${this.audioBase}/${seg.id}.mp3` : `/api/tts?t=${encodeURIComponent(seg.narration)}&s=${encodeURIComponent(seg.sig)}`;
    const res = await fetch(url, { signal: this.aborter.signal });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new ApiError(j.error ?? `Voice failed (${res.status})`, res.status);
    }
    const bytes = await res.arrayBuffer();
    return this.audioBase ? await this.ctx.decodeAudioData(bytes) : pcm16ToBuffer(this.ctx, bytes);
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
        estimatedDuration: s.scene.kind === "recap" ? SCENE_ESTIMATE.recap : SCENE_ESTIMATE.chapter,
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
    await unlockAudio(this.ctx);
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
export function playAnswer(scene: Scene, base: BoardElement[], ctx: AudioContext | null, onUpdate: (tl: Timeline) => void): AnswerPlayback {
  const player = new LessonPlayer({ ctx });
  const audio = new Map<string, AudioInfo>();
  const inputs: SceneInput[] = [{ scene, base, showTitle: base.length === 0 }];
  let timeline = compileTimeline(inputs, audio, { complete: false });
  player.setTimeline(timeline);

  const ready = Promise.all(
    scene.segments.map(async (seg) => {
      try {
        if (!ctx) throw new Error("no audio");
        const res = await fetch(`/api/tts?t=${encodeURIComponent(seg.narration)}&s=${encodeURIComponent(seg.sig)}`);
        if (!res.ok) throw new Error("voice failed");
        const buffer = pcm16ToBuffer(ctx, await res.arrayBuffer());
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
