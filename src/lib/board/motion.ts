import type { MotionKind } from "@/lib/lesson/schema";
import { easeInOutCubic, easeOutBack } from "./anim";

/**
 * Demonstrations: an element orbits another, spins, swings like a pendulum,
 * glides somewhere, vibrates or grows. Like everything on the board, the
 * motion is a pure function of time, so seeking and replay are exact.
 */

type Pt = [number, number];
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MotionSpec {
  type: MotionKind;
  /** Element ids that move. */
  targets: string[];
  /** Orbit centre (board coordinates). */
  center?: Pt;
  /** Vertical squash of the orbit (an ellipse reads as a tilted circle). */
  ky?: number;
  /** The orbit's radius, when it differs from the element's starting distance (pulled in to fit the board). */
  radius?: number;
  /** Where a `move` goes (the element is placed at its near edge). */
  toBox?: Box;
  /** Size factor for `grow`. */
  factor?: number;
}

export interface TimedMotion extends MotionSpec {
  /** When the motion begins. */
  start: number;
}

/** Seconds for one orbit, one spin turn and one swing. */
const ORBIT_PERIOD = 7;
const SPIN_PERIOD = 4;
const SWING_PERIOD = 2.1;

/** Time that eases in from rest: speeds up over the first second, then constant speed. */
const easedTime = (s: number) => (s < 1 ? (s * s) / 2 : s - 0.5);

const centerOf = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2];

/** Where a ray from `b`'s centre towards `toward` leaves `b`, pushed out by `pad`. */
function edgeToward(b: Box, toward: Pt, pad: number): Pt {
  const [cx, cy] = centerOf(b);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const tx = dx !== 0 ? (b.w / 2 + pad) / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? (b.h / 2 + pad) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return [cx + dx * t, cy + dy * t];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** How an element is moved at a moment: `move` applies to all of it, `turn` only to its drawing (captions stay upright). */
export interface MotionFrame {
  move?: string;
  turn?: string;
}

/**
 * The SVG transforms for an element with motions at time t (undefined if it
 * isn't moving). With `still`, continuous motions are left out and one-off ones
 * (move, grow) are shown at their end state, for reduced motion. `art` is the
 * drawing without its caption: spins and swings pivot on it.
 */
export function motionTransform(motions: readonly TimedMotion[] | undefined, bbox: Box, t: number, still = false, art?: Box): MotionFrame | undefined {
  if (!motions?.length) return undefined;
  const c = centerOf(bbox);
  const drawing = art ?? bbox;
  let dx = 0;
  let dy = 0;
  let rot = 0;
  let pivot: Pt | null = null;
  let scale = 1;
  for (const m of motions) {
    const s = t - m.start;
    if (s <= 0) continue;
    switch (m.type) {
      case "orbit": {
        if (still || !m.center) break;
        const ky = m.ky ?? 0.55;
        const ox = c[0] - m.center[0];
        const oy = (c[1] - m.center[1]) / ky;
        const R0 = Math.hypot(ox, oy) || 1;
        // Glides onto a ring that was pulled in to fit the board while it starts to travel.
        const R = m.radius ? R0 + (m.radius - R0) * easeInOutCubic(Math.min(1, s / 1.3)) : R0;
        const phase = Math.atan2(oy, ox) - ((2 * Math.PI) / ORBIT_PERIOD) * easedTime(s);
        dx += m.center[0] + R * Math.cos(phase) - c[0];
        dy += m.center[1] + R * ky * Math.sin(phase) - c[1];
        break;
      }
      case "spin":
        if (still) break;
        rot += (360 * easedTime(s)) / SPIN_PERIOD;
        pivot ??= centerOf(drawing);
        break;
      case "swing":
        if (still) break;
        rot += 22 * Math.sin((2 * Math.PI * s) / SWING_PERIOD) * Math.min(1, s / 0.8);
        pivot ??= [drawing.x + drawing.w / 2, drawing.y];
        break;
      case "vibrate":
        if (still) break;
        dx += 3.5 * Math.sin(2 * Math.PI * 7.3 * s);
        dy += 3.5 * Math.sin(2 * Math.PI * 6.1 * s + 1.3);
        break;
      case "move": {
        if (!m.toBox) break;
        const dest = edgeToward(m.toBox, c, Math.max(bbox.w, bbox.h) / 2 + 8);
        const k = still ? 1 : easeInOutCubic(Math.min(1, s / 1.4));
        dx += (dest[0] - c[0]) * k;
        dy += (dest[1] - c[1]) * k;
        break;
      }
      case "grow": {
        const k = still ? 1 : easeOutBack(Math.min(1, s / 1.2));
        scale *= 1 + ((m.factor ?? 1.6) - 1) * k;
        break;
      }
    }
  }
  const move: string[] = [];
  if (dx || dy) move.push(`translate(${r1(dx)} ${r1(dy)})`);
  if (scale !== 1) move.push(`translate(${r1(c[0])} ${r1(c[1])}) scale(${Math.round(scale * 1000) / 1000}) translate(${r1(-c[0])} ${r1(-c[1])})`);
  const turn = rot && pivot ? `rotate(${r1(rot)} ${r1(pivot[0])} ${r1(pivot[1])})` : undefined;
  return move.length || turn ? { move: move.length ? move.join(" ") : undefined, turn } : undefined;
}

/** Continuous motions keep an element moving for the rest of its board. */
export const isContinuous = (type: MotionKind) => type === "orbit" || type === "spin" || type === "swing" || type === "vibrate";
