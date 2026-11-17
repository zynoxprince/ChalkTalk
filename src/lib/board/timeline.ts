import type { Scene, SceneKind } from "@/lib/lesson/schema";
import { FULL_VIEW, planCamera, unite, type CameraKey } from "./camera";
import { CUE_LEAD, SCENE_GAP, SEGMENT_GAP, WORDS_PER_SECOND } from "./constants";
import { layoutScene, type BoardElement, type Rect, type SceneLayout } from "./layout";

/**
 * Compiles scenes + measured audio durations into an absolute timeline.
 * Everything downstream (renderer, captions, seek bar) reads only this, so
 * the board at time t is a pure function of the timeline.
 */

export interface TimedElement extends BoardElement {
  start: number;
  dur: number;
  sceneId: string;
  /** Times when an annotation points at this element (it gives a little bump). */
  emphasis?: number[];
}

export interface Word {
  text: string;
  start: number;
}

export type SegmentStatus = "ready" | "silent" | "pending";

export interface TimedSegment {
  id: string;
  sceneId: string;
  narration: string;
  sig: string;
  start: number;
  end: number;
  status: SegmentStatus;
  words: Word[];
}

export interface TimedScene {
  id: string;
  kind: SceneKind;
  title: string;
  start: number;
  /** End of the last narration in this board. */
  contentEnd: number;
  /** Start of the next board (or the end of the lesson). */
  end: number;
  pending: boolean;
  elements: TimedElement[];
  warnings: string[];
  /** Planned camera moves for this board. */
  camera: CameraKey[];
}

export interface Timeline {
  duration: number;
  scenes: TimedScene[];
  segments: TimedSegment[];
  /** Playback can run up to here without waiting for generation or audio. */
  readyUntil: number;
  /** All scenes generated and every segment's audio settled. */
  complete: boolean;
}

export interface SceneInput {
  scene: Scene;
  /** Content still being generated: reserve time so the seek bar can show it. */
  pending?: boolean;
  /** Some segments are here but more are still streaming in: playback must wait at its end. */
  partial?: boolean;
  estimatedDuration?: number;
  /** Elements already on the board when this scene starts (answer overlays). */
  base?: BoardElement[];
  /** Draw the scene title at the top. Defaults to true. */
  showTitle?: boolean;
}

export interface AudioInfo {
  duration: number;
  /** false = speech failed; play silently with captions for `duration`. */
  ok: boolean;
}

/* ------------------------------------------------------------------ */
/* Speech-timing model                                                 */
/* ------------------------------------------------------------------ */

/** How long each character "takes" to say, relative to a letter. Punctuation carries pauses. */
function charWeight(ch: string): number {
  if (/[a-z0-9]/i.test(ch)) return 1;
  if (ch === " ") return 0.55;
  if (ch === "," || ch === ";" || ch === ":") return 3;
  if (ch === "." || ch === "!" || ch === "?") return 5.5;
  if (ch === "—" || ch === "–" || ch === "-") return 2;
  return 0.8;
}

export function speechWeight(s: string): number {
  let w = 0;
  for (const ch of s) w += charWeight(ch);
  return w;
}

export function estimateDuration(narration: string): number {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, words / WORDS_PER_SECOND + 0.3);
}

const normalizeWithMap = (s: string) => {
  let out = "";
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i].toLowerCase();
    if (/[a-z0-9À-ɏ]/.test(ch)) {
      out += ch;
      map.push(i);
      prevSpace = false;
    } else if (!prevSpace) {
      out += " ";
      map.push(i);
      prevSpace = true;
    }
  }
  return { out, map };
};

/** Character index in `narration` where `cue` begins, tolerant of case and punctuation. */
export function findCue(narration: string, cue: string | null | undefined): number | null {
  if (!cue || !cue.trim()) return null;
  const direct = narration.toLowerCase().indexOf(cue.toLowerCase().trim());
  if (direct >= 0) return direct;
  const n = normalizeWithMap(narration);
  const c = normalizeWithMap(cue).out.trim();
  if (!c) return null;
  let idx = n.out.indexOf(c);
  if (idx < 0) {
    // Fall back to the cue's first two words, then its first word if distinctive.
    const words = c.split(" ");
    const head2 = words.slice(0, 2).join(" ");
    idx = words.length >= 2 ? n.out.indexOf(head2) : -1;
    if (idx < 0 && words[0].length >= 5) idx = n.out.indexOf(words[0]);
  }
  return idx >= 0 ? (n.map[idx] ?? null) : null;
}

/** Fraction (0..1) of the segment's audio at which a character index is spoken. */
export function fractionAt(narration: string, charIndex: number): number {
  const total = speechWeight(narration);
  if (total <= 0) return 0;
  return Math.min(1, speechWeight(narration.slice(0, charIndex)) / total);
}

function wordsFor(narration: string, start: number, dur: number): Word[] {
  const out: Word[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(narration))) out.push({ text: m[0], start: start + fractionAt(narration, m.index) * dur });
  return out;
}

/* ------------------------------------------------------------------ */
/* Compile                                                             */
/* ------------------------------------------------------------------ */

const layoutCache = new WeakMap<Scene, Map<string, SceneLayout>>();

function layoutFor(input: SceneInput): SceneLayout {
  const key = `${input.showTitle !== false ? "t" : "n"}:${input.base?.length ?? 0}`;
  let byKey = layoutCache.get(input.scene);
  if (!byKey) {
    byKey = new Map();
    layoutCache.set(input.scene, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const actions = input.scene.segments.flatMap((s) => s.actions);
  const layout = layoutScene(actions, {
    title: input.showTitle !== false ? input.scene.title : null,
    base: input.base,
  });
  byKey.set(key, layout);
  return layout;
}

export function compileTimeline(
  inputs: SceneInput[],
  audio: ReadonlyMap<string, AudioInfo>,
  opts: { complete?: boolean; leadIn?: number } = {},
): Timeline {
  const segments: TimedSegment[] = [];
  const scenes: TimedScene[] = [];
  let cursor = opts.leadIn ?? 0.25;

  for (const input of inputs) {
    const { scene } = input;
    const sceneStart = cursor;

    if (input.pending || scene.segments.length === 0) {
      const est = input.estimatedDuration ?? 30;
      cursor += est;
      scenes.push({
        id: scene.id,
        kind: scene.kind,
        title: scene.title,
        start: sceneStart,
        contentEnd: cursor,
        end: cursor + SCENE_GAP,
        pending: true,
        elements: [],
        warnings: [],
        camera: [{ t: sceneStart, from: FULL_VIEW, to: FULL_VIEW }],
      });
      cursor += SCENE_GAP;
      continue;
    }

    const layout = layoutFor(input);
    const byAction = new Map<string, BoardElement[]>();
    for (const e of layout.elements) {
      const list = byAction.get(e.actionId) ?? [];
      list.push(e);
      byAction.set(e.actionId, list);
    }
    const timed: TimedElement[] = [];
    const titleEl = byAction.get("__title")?.[0];
    if (titleEl) timed.push({ ...titleEl, start: sceneStart + 0.05, dur: titleEl.natural, sceneId: scene.id });

    // Layout de-duplicates ids in action order; mirror that mapping here.
    const actionIds = dedupeIds(
      scene.segments.flatMap((s) => s.actions.map((a) => a.id)),
      (input.base ?? []).map((b) => b.id),
    );
    let ai = 0;

    scene.segments.forEach((seg, si) => {
      const info = audio.get(seg.id);
      const dur = info ? Math.max(0.4, info.duration) : estimateDuration(seg.narration);
      const status: SegmentStatus = info ? (info.ok ? "ready" : "silent") : "pending";
      const start = cursor;
      const end = start + dur;
      segments.push({ id: seg.id, sceneId: scene.id, narration: seg.narration, sig: seg.sig, start, end, status, words: wordsFor(seg.narration, start, dur) });

      const used = new Map<number, number>();
      seg.actions.forEach((action, k) => {
        const actionId = actionIds[ai++];
        const els = byAction.get(actionId);
        if (!els?.length) return;
        const idx = findCue(seg.narration, action.cue);
        const frac = idx !== null ? fractionAt(seg.narration, idx) : (k / Math.max(1, seg.actions.length)) * 0.85;
        let t0 = Math.max(start, start + frac * dur - CUE_LEAD);
        const bucket = Math.round(t0 * 10);
        const n = used.get(bucket) ?? 0;
        used.set(bucket, n + 1);
        t0 += n * 0.25;

        const ordered = [...els].sort((p, q) => p.seq - q.seq);
        const count = ordered[0].seqCount;
        if (count > 1) {
          const available = Math.max(end - t0, 1);
          const spacing = Math.min(1.4, Math.max(0.3, available / count));
          ordered.forEach((e) => timed.push({ ...e, start: t0 + e.seq * spacing, dur: Math.max(0.3, e.natural), sceneId: scene.id }));
        } else {
          ordered.forEach((e) => timed.push({ ...e, start: t0, dur: Math.max(0.3, e.natural), sceneId: scene.id }));
        }
      });

      cursor = end + (si < scene.segments.length - 1 ? SEGMENT_GAP : 0);
    });

    const contentEnd = cursor;
    cursor += SCENE_GAP;

    // Nothing starts before what it refers to is on the board: an arrow waits
    // for both its ends, a note for its target, a token for its path.
    const byId = new Map(timed.map((e) => [e.id, e]));
    for (let pass = 0; pass < 2; pass++) {
      for (const e of [...timed].sort((p, q) => p.start - q.start)) {
        for (const id of e.deps ?? []) {
          const d = byId.get(id);
          // ...but never so late that it would only appear while the board is being erased.
          if (d && d !== e) e.start = Math.max(e.start, Math.min(d.start + d.dur * 0.6, contentEnd - 0.25));
        }
      }
    }
    timed.sort((p, q) => p.start - q.start);

    // Annotations that point at something make it bump as they start.
    for (const e of timed) {
      for (const id of e.targets ?? []) {
        const target = byId.get(id);
        if (target) target.emphasis = [...(target.emphasis ?? []), e.start];
      }
    }

    // The camera frames a whole diagram as it builds (not node by node), and
    // an arrow or annotation together with what it connects or points at.
    const groups = new Map<string, Rect>();
    for (const e of timed) groups.set(e.actionId, groups.has(e.actionId) ? unite(groups.get(e.actionId)!, e.bbox) : e.bbox);
    const focus = timed.map((e) => {
      let bbox = e.seqCount > 1 ? (groups.get(e.actionId) ?? e.bbox) : e.bbox;
      for (const id of e.deps ?? []) {
        const d = byId.get(id);
        if (d) bbox = unite(bbox, d.bbox);
      }
      return { start: e.start, dur: e.dur, kind: e.kind, bbox };
    });
    // A board still being written isn't over yet: no "show the whole board before erasing" move.
    const camera = planCamera(focus, sceneStart, contentEnd, { final: !input.partial });
    scenes.push({ id: scene.id, kind: scene.kind, title: scene.title, start: sceneStart, contentEnd, end: cursor, pending: false, elements: timed, warnings: layout.warnings, camera });
  }

  if (scenes.length) scenes[scenes.length - 1].end = scenes[scenes.length - 1].contentEnd + 0.6;
  const duration = scenes.length ? scenes[scenes.length - 1].end : 0;

  const partialScenes = new Set(inputs.filter((i) => i.partial && !i.pending).map((i) => i.scene.id));
  let readyUntil = 0;
  let blocked = false;
  for (const sc of scenes) {
    if (blocked) break;
    if (sc.pending) {
      blocked = true;
      break;
    }
    for (const seg of segments.filter((s) => s.sceneId === sc.id)) {
      if (seg.status === "pending") {
        blocked = true;
        break;
      }
      readyUntil = seg.end;
    }
    if (partialScenes.has(sc.id)) blocked = true;
  }
  const complete = !!opts.complete && !blocked;
  if (complete) readyUntil = duration;

  return { duration, scenes, segments, readyUntil, complete };
}

function dedupeIds(ids: string[], taken: string[]): string[] {
  const seen = new Set<string>(taken);
  return ids.map((id) => {
    let out = id || "el";
    let n = 2;
    while (seen.has(out)) out = `${id}_${n++}`;
    seen.add(out);
    return out;
  });
}
