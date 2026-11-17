import rough from "roughjs";
import type { Options } from "roughjs/bin/core";

/**
 * Hand-drawn shapes via rough.js. The generator is DOM-free, so paths are
 * computed once during layout. A fixed seed per element keeps every frame
 * identical (otherwise sketchy lines would "boil" on each render).
 */

const gen = rough.generator();

export interface RoughPath {
  d: string;
  /** outline = the pen stroke; solid = a filled area; hatch = hand-hatched fill strokes. */
  kind: "outline" | "solid" | "hatch";
}

export function seedFrom(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) % 2_000_000_000) + 1;
}

function toPaths(drawable: ReturnType<typeof gen.line>): RoughPath[] {
  return drawable.sets.map((set) => ({
    // One decimal is plenty at board scale and keeps the DOM light.
    d: gen.opsToPath(set, 1),
    kind: set.type === "fillSketch" ? "hatch" : set.type === "fillPath" ? "solid" : "outline",
  }));
}

const base = (seed: number, extra: Options = {}): Options => ({
  seed,
  roughness: 1.15,
  bowing: 0.9,
  strokeWidth: 3,
  disableMultiStroke: false,
  preserveVertices: true,
  ...extra,
});

/** Options for a light hand-hatched fill in `color`. */
export const hatchFill = (color: string, gap = 12): Options => ({ fill: color, fillStyle: "hachure", hachureGap: gap, fillWeight: 2.2, hachureAngle: -41 });

export const roughRect = (x: number, y: number, w: number, h: number, seed: number, extra?: Options) =>
  toPaths(gen.rectangle(x, y, w, h, base(seed, extra)));

export const roughEllipse = (cx: number, cy: number, w: number, h: number, seed: number, extra?: Options) =>
  toPaths(gen.ellipse(cx, cy, w, h, base(seed, { curveStepCount: 12, ...extra })));

export const roughLine = (x1: number, y1: number, x2: number, y2: number, seed: number, extra?: Options) =>
  toPaths(gen.line(x1, y1, x2, y2, base(seed, { roughness: 0.9, ...extra })));

export const roughCurve = (points: [number, number][], seed: number, extra?: Options) =>
  toPaths(gen.curve(points, base(seed, { roughness: 0.8, ...extra })));

export const roughLinear = (points: [number, number][], seed: number, extra?: Options) =>
  toPaths(gen.linearPath(points, base(seed, { roughness: 0.8, ...extra })));
