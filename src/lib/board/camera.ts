import { easeInOutCubic, clamp01 } from "./anim";
import { BOARD_H, BOARD_W } from "./constants";
import type { Rect } from "./layout";

/**
 * A gentle virtual camera, like an editor following the teacher's pen: it eases
 * in towards whatever is being drawn, holds still while new drawing already
 * fits in view, drifts back out to show the whole board when the narration
 * pauses its drawing, and always shows the whole board before it's erased.
 *
 * Planned once per board from the timeline (pure), so seeking lands on exactly
 * the same view, and the board itself never re-lays out.
 */

export const FULL_VIEW: Rect = { x: 0, y: 0, w: BOARD_W, h: BOARD_H };

/** Never zoom in further than this: the learner keeps the context around the action. */
export const MAX_ZOOM = 1.32;
/** Zooms smaller than this aren't worth a camera move. */
const MIN_ZOOM = 1.1;
/** Space kept around the focus. */
const PAD = 90;
/** How long a camera move takes. */
export const MOVE_TIME = 0.9;
/** Start moving a little before the drawing starts, so the camera arrives as the pen lands. */
const LEAD = 0.45;
/** Drawings that start this close together are framed together. */
const BEAT = 1.5;
/** After this long without new drawing, pull back to show the whole board. */
const DRIFT = 3.2;

export interface CameraKey {
  /** When this move starts. */
  t: number;
  /** Where the camera is when it starts (mid-move if the previous move hadn't finished). */
  from: Rect;
  /** Where it's going. */
  to: Rect;
}

export interface Focusable {
  start: number;
  dur: number;
  bbox: Rect;
  kind: string;
}

const ASPECT = BOARD_W / BOARD_H;

const same = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;

export const unite = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** The board-shaped view that frames `focus` with some room around it, kept on the board. */
export function frame(focus: Rect): Rect {
  let w = Math.max(focus.w + PAD * 2, (focus.h + PAD * 2) * ASPECT, BOARD_W / MAX_ZOOM);
  w = Math.min(w, BOARD_W);
  const h = w / ASPECT;
  const cx = focus.x + focus.w / 2;
  const cy = focus.y + focus.h / 2;
  const x = Math.min(Math.max(0, cx - w / 2), BOARD_W - w);
  const y = Math.min(Math.max(0, cy - h / 2), BOARD_H - h);
  return { x, y, w, h };
}

const lerpRect = (a: Rect, b: Rect, k: number): Rect => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

function viewDuring(key: CameraKey, t: number): Rect {
  return lerpRect(key.from, key.to, easeInOutCubic(clamp01((t - key.t) / MOVE_TIME)));
}

/**
 * Plans the camera for one board. `contentEnd` is when its last line ends;
 * `final: false` means more of the board is still being written.
 */
export function planCamera(elements: Focusable[], start: number, contentEnd: number, opts: { final?: boolean } = {}): CameraKey[] {
  const final = opts.final ?? true;
  const els = elements.filter((e) => e.kind !== "title" && e.bbox.w > 0 && e.bbox.h > 0).sort((p, q) => p.start - q.start);

  // Group drawings that start close together into beats.
  const beats: { t0: number; t1: number; rect: Rect }[] = [];
  for (const e of els) {
    const last = beats[beats.length - 1];
    if (last && e.start - last.t0 <= BEAT) {
      last.rect = unite(last.rect, e.bbox);
      last.t1 = Math.max(last.t1, e.start + e.dur);
    } else {
      beats.push({ t0: e.start, t1: e.start + e.dur, rect: e.bbox });
    }
  }

  // Let the board's title be written in full view before the camera moves in.
  const title = elements.find((e) => e.kind === "title");
  const earliest = title ? title.start + title.dur * 0.85 : start;
  const targets: { t: number; to: Rect }[] = [];
  let view = FULL_VIEW;
  const moveTo = (t: number, to: Rect) => {
    if (same(to, view)) return;
    const prev = targets[targets.length - 1];
    targets.push({ t: Math.max(t, prev ? prev.t : start, earliest), to });
    view = to;
  };

  beats.forEach((beat, i) => {
    const target = frame(beat.rect);
    const zoom = BOARD_W / target.w;
    const zoomedIn = !same(view, FULL_VIEW);
    if (zoom < MIN_ZOOM) moveTo(beat.t0 - LEAD, FULL_VIEW);
    // Already in view with a little margin: hold still rather than nudging the camera.
    else if (!(zoomedIn && contains(view, { x: beat.rect.x - 24, y: beat.rect.y - 24, w: beat.rect.w + 48, h: beat.rect.h + 48 }))) moveTo(beat.t0 - LEAD, target);
    const next = beats[i + 1]?.t0 ?? (final ? contentEnd : null);
    if (next !== null && next - beat.t1 > DRIFT + LEAD + MOVE_TIME) moveTo(beat.t1 + DRIFT, FULL_VIEW);
  });
  // Show the whole board before it's erased.
  if (final) {
    const lastEnd = beats.length ? Math.max(...beats.map((b) => b.t1)) : start;
    moveTo(Math.max(lastEnd + 0.4, contentEnd - 0.7), FULL_VIEW);
  }

  const keys: CameraKey[] = [{ t: start, from: FULL_VIEW, to: FULL_VIEW }];
  for (const target of targets) {
    const prev = keys[keys.length - 1];
    keys.push({ t: target.t, from: viewDuring(prev, target.t), to: target.to });
  }
  return keys;
}

/** Where the camera looks at time t. */
export function cameraAt(keys: readonly CameraKey[], t: number): Rect {
  if (!keys.length || t <= keys[0].t) return keys[0]?.from ?? FULL_VIEW;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return viewDuring(keys[lo], t);
}
