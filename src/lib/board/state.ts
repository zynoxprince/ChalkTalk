import { ERASE_TIME, SCENE_GAP } from "./constants";
import type { Pt } from "./layout";
import type { TimedElement, TimedScene, TimedSegment, Timeline } from "./timeline";

/**
 * What the board looks like at time t. Pure and allocation-light: the renderer
 * calls this every animation frame, and seeking is just calling it with a new t.
 */

export interface FrameItem {
  el: TimedElement;
  /** Drawing progress, 0 (just started) .. 1 (done). */
  p: number;
}

export interface Frame {
  t: number;
  scene: TimedScene | null;
  items: FrameItem[];
  /** 0..1 progress of the eraser sweeping the board before the next scene. */
  erase: number;
  segment: TimedSegment | null;
  /** Index of the word being spoken in `segment` (-1 before the first word). */
  wordIndex: number;
  /** The element currently being drawn (for the pen cursor). */
  active: FrameItem | null;
}

export function sceneIndexAt(tl: Timeline, t: number): number {
  let idx = 0;
  for (let i = 0; i < tl.scenes.length; i++) if (tl.scenes[i].start <= t) idx = i;
  return idx;
}

export function segmentAt(tl: Timeline, t: number): TimedSegment | null {
  let found: TimedSegment | null = null;
  for (const s of tl.segments) {
    if (s.start <= t) found = s;
    else break;
  }
  return found;
}

export function frameAt(tl: Timeline, t: number): Frame {
  const empty: Frame = { t, scene: null, items: [], erase: 0, segment: null, wordIndex: -1, active: null };
  if (!tl.scenes.length) return empty;
  const si = sceneIndexAt(tl, t);
  const scene = tl.scenes[si];
  const items: FrameItem[] = [];
  let active: FrameItem | null = null;
  for (const el of scene.elements) {
    if (el.start > t) continue;
    const p = el.dur > 0 ? Math.min(1, (t - el.start) / el.dur) : 1;
    if (el.transient && p >= 1) continue;
    const item = { el, p };
    items.push(item);
    if (p < 1 && (!active || el.start >= active.el.start)) active = item;
  }

  let erase = 0;
  const next = tl.scenes[si + 1];
  if (next) {
    const eraseStart = next.start - SCENE_GAP + (SCENE_GAP - ERASE_TIME) / 2;
    if (t >= eraseStart) erase = Math.min(1, (t - eraseStart) / ERASE_TIME);
  }

  const segment = segmentAt(tl, t);
  let wordIndex = -1;
  if (segment && t <= segment.end + 0.6) {
    for (let i = 0; i < segment.words.length; i++) {
      if (segment.words[i].start <= t) wordIndex = i;
      else break;
    }
  }
  return { t, scene, items, erase, segment: segment && t <= segment.end + 0.6 ? segment : null, wordIndex, active };
}

/** Position along a polyline at fraction f (0..1) of its length. */
export function pointAlong(trail: Pt[], f: number): Pt {
  if (trail.length === 0) return [0, 0];
  if (trail.length === 1 || f <= 0) return trail[0];
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < trail.length; i++) {
    const l = Math.hypot(trail[i][0] - trail[i - 1][0], trail[i][1] - trail[i - 1][1]);
    lens.push(l);
    total += l;
  }
  if (f >= 1 || total === 0) return trail[trail.length - 1];
  let d = f * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]) {
      const r = lens[i] === 0 ? 0 : d / lens[i];
      return [trail[i][0] + (trail[i + 1][0] - trail[i][0]) * r, trail[i][1] + (trail[i + 1][1] - trail[i][1]) * r];
    }
    d -= lens[i];
  }
  return trail[trail.length - 1];
}

/** Where the pen tip is for the element being drawn, if anywhere sensible. */
export function penPosition(item: FrameItem | null): Pt | null {
  if (!item) return null;
  const { el, p } = item;
  for (const part of el.parts) {
    if (p < part.a || p > part.b) continue;
    const local = part.b > part.a ? (p - part.a) / (part.b - part.a) : 1;
    if (part.type === "text") {
      const n = part.lines.length;
      const li = Math.min(n - 1, Math.floor(local * n));
      const lineLocal = local * n - li;
      const w = part.widths[li] ?? 0;
      const x0 = part.anchor === "middle" ? part.x - w / 2 : part.x;
      return [x0 + w * lineLocal, part.y + li * part.size * part.lineHeight - part.size * 0.15];
    }
    if (part.type === "stroke" && part.trail) return pointAlong(part.trail, local);
    if (part.type === "icon") return [part.x + part.size * local, part.y + part.size * (0.3 + 0.4 * Math.sin(local * Math.PI))];
  }
  return null;
}
