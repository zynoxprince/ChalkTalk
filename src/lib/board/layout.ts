import {
  isAnnotationKind,
  isConnectorKind,
  isElementKind,
  isMotionKind,
  type Action,
  type Cell,
  type Color,
  type MotionKind,
} from "@/lib/lesson/schema";
import {
  BOARD_BG,
  CELL_H,
  CELL_W,
  GRID,
  HATCH,
  INK,
  MARKER_YELLOW,
  NOTE_FILL,
  NOTE_STROKE,
  TITLE,
  BOARD_H,
  BOARD_W,
  WASH,
} from "./constants";
import { countsUp, parseNumber, type NumberParts } from "./anim";
import { iconNodes, resolveIcon, type IconNode } from "./icons";
import { parsePlot } from "./expr";
import type { MotionSpec } from "./motion";
import { hatchFill, roughCurve, roughEllipse, roughLine, roughLinear, roughPath, roughRect, seedFrom, type RoughPath } from "./rough";
import { parseSketch } from "./sketch";
import { fitText, textWidth } from "./text";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Pt = [number, number];

/** One drawable piece of an element, revealed during [a, b] of the element's progress. */
export type Part =
  | {
      type: "stroke";
      d: string;
      color: string;
      width: number;
      a: number;
      b: number;
      opacity?: number;
      blend?: boolean;
      /** Approximate pen path, used to place the pen cursor while drawing. */
      trail?: Pt[];
    }
  | {
      type: "fill";
      d: string;
      color: string;
      a: number;
      b: number;
      opacity?: number;
      /** Pops in (scales up from this point) instead of fading in. */
      origin?: Pt;
    }
  | {
      type: "text";
      x: number;
      y: number;
      lines: string[];
      size: number;
      lineHeight: number;
      color: string;
      anchor: "start" | "middle";
      weight: number;
      /** Width of each line in px (for the left-to-right writing reveal). */
      widths: number[];
      a: number;
      b: number;
      /** Outline in this colour behind the letters, so text stays crisp over hatching. */
      halo?: string;
    }
  | { type: "icon"; nodes: IconNode; x: number; y: number; size: number; color: string; a: number; b: number }
  | {
      type: "dot";
      trail: Pt[];
      color: string;
      r: number;
      a: number;
      b: number;
      /** Something that travels instead of a plain dot: a small icon or a word. */
      token?: { icon: IconNode | null; label: string | null; wash: string };
    }
  /** Beads that keep flowing along a finished arrow, showing its direction. */
  | { type: "flow"; d: string; color: string; a: number; b: number }
  /** Rings that spread out and fade, to draw the eye. */
  | { type: "ripple"; cx: number; cy: number; rx: number; ry: number; color: string; a: number; b: number }
  /** A bar that grows up from `base` with its value counting up on top. */
  | {
      type: "bar";
      x: number;
      w: number;
      h: number;
      base: number;
      outline: string;
      hatch: string;
      color: string;
      tint: string;
      value: { text: string; num: NumberParts | null; size: number };
      a: number;
      b: number;
    }
  /** A pie wedge sweeping open from a0 to a1 (radians, clockwise from 12 o'clock). */
  | { type: "wedge"; cx: number; cy: number; r: number; a0: number; a1: number; color: string; tint: string; a: number; b: number }
  /** Particles bouncing around a box; positions are a function of time. */
  | { type: "particles"; x: number; y: number; w: number; h: number; n: number; speed: number; r: number; color: string; seed: number; a: number; b: number }
  /** A number that counts up from zero as it's written. */
  | {
      type: "count";
      x: number;
      y: number;
      size: number;
      color: string;
      anchor: "start" | "middle";
      weight: number;
      text: string;
      num: NumberParts | null;
      a: number;
      b: number;
    };

export interface BoardElement {
  id: string;
  actionId: string;
  kind: string;
  /** Human-readable text for "ask about this". */
  label: string | null;
  bbox: Rect;
  parts: Part[];
  /** Natural drawing duration in seconds. */
  natural: number;
  /** Order inside a composite (list items, flow nodes...). */
  seq: number;
  seqCount: number;
  clickable: boolean;
  /** Disappears once finished (e.g. a tracing dot). */
  transient: boolean;
  /** Scales in with a little bounce as it appears. */
  pop?: boolean;
  /** Keeps moving after it's drawn (flowing arrows), so it needs the clock. */
  ambient?: boolean;
  /** Elements this annotation points at: they get a small bump when it starts. */
  targets?: string[];
  /** Elements that must already be on the board before this one starts (what an arrow joins, what a note points at). */
  deps?: string[];
  /** For motion actions: which elements move and how (applied to them by the timeline). */
  motion?: MotionSpec;
  /** The drawing without its caption (spins and swings pivot on it). */
  art?: Rect;
}

export interface SceneLayout {
  elements: BoardElement[];
  warnings: string[];
}

interface Ref {
  bbox: Rect;
  el?: BoardElement;
  path?: Pt[];
  /** The element ids this reference stands for (several for a whole flow or list). */
  ids: string[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampInt = (v: number, lo: number, hi: number) => clamp(Math.round(Number.isFinite(v) ? v : lo), lo, hi);
const textDur = (s: string) => clamp(0.032 * s.length + 0.3, 0.45, 2.0);
const colorOf = (c: Color | null | undefined, fallback: Color = "ink") => INK[c ?? fallback] ?? INK.ink;
const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, w: Math.max(4, r.w - 2 * d), h: Math.max(4, r.h - 2 * d) });
const center = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h / 2];
/** Keeps a box on the board (effects like ripples may spill past the edge visually). */
const onBoard = (r: Rect): Rect => {
  const x = clamp(r.x, 0, BOARD_W);
  const y = clamp(r.y, 0, BOARD_H);
  return { x, y, w: clamp(r.x + r.w, 0, BOARD_W) - x, h: clamp(r.y + r.h, 0, BOARD_H) - y };
};
const union = (rs: Rect[]): Rect => {
  const x1 = Math.min(...rs.map((r) => r.x));
  const y1 = Math.min(...rs.map((r) => r.y));
  const x2 = Math.max(...rs.map((r) => r.x + r.w));
  const y2 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
};

export function cellRect(c: Cell): Rect {
  return { x: GRID.x + c.col * CELL_W, y: GRID.y + c.row * CELL_H, w: c.w * CELL_W, h: c.h * CELL_H };
}

function rectPerimeter(r: Rect): Pt[] {
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
    [r.x, r.y],
  ];
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number, n = 24): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as Pt;
  });
}

/** Point where a ray from the rect's centre towards `toward` leaves the rect. */
function edgePoint(r: Rect, toward: Pt, pad = 0): Pt {
  const [cx, cy] = center(r);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const tx = dx !== 0 ? (r.w / 2 + pad) / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? (r.h / 2 + pad) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return [cx + dx * t, cy + dy * t];
}

interface FillOpts {
  color: string;
  a: number;
  b: number;
  opacity?: number;
  origin?: Pt;
}

/**
 * Turns rough.js paths into timed parts: the outline is drawn during [a, b];
 * a solid fill and hand-hatching (if the shape has them) get their own windows.
 * Fills come first in the list so they sit underneath the outline.
 */
function strokeParts(paths: RoughPath[], color: string, width: number, a: number, b: number, trail?: Pt[], fill?: FillOpts, hatch?: FillOpts): Part[] {
  const parts: Part[] = [];
  for (const p of paths) {
    if (p.kind === "solid") {
      if (fill) parts.push({ type: "fill", d: p.d, color: fill.color, a: fill.a, b: fill.b, opacity: fill.opacity, origin: fill.origin });
    } else if (p.kind === "hatch") {
      if (hatch) parts.push({ type: "stroke", d: p.d, color: hatch.color, width: 2.2, a: hatch.a, b: hatch.b, opacity: hatch.opacity });
    } else {
      parts.push({ type: "stroke", d: p.d, color, width, a, b, trail });
    }
  }
  return parts;
}

const tintOf = (c: Color | null | undefined, fallback: Color = "ink") => HATCH[c ?? fallback] ?? HATCH.ink;
const washOf = (c: Color | null | undefined, fallback: Color = "ink") => WASH[c ?? fallback] ?? WASH.ink;

/** A soft colour spot behind an icon or number that pops in first. */
function blobPart(cx: number, cy: number, w: number, h: number, color: string, seed: number, a = 0, b = 0.2): Part {
  const d = roughEllipse(cx, cy, w, h, seed, { fill: color, fillStyle: "solid", stroke: "none", roughness: 1.4 })[0]?.d ?? "";
  return { type: "fill", d, color, a, b, origin: [cx, cy] };
}

function arrowHead(tip: Pt, from: Pt, size: number): [Pt, Pt] {
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const spread = 0.5;
  return [
    [tip[0] - size * Math.cos(ang - spread), tip[1] - size * Math.sin(ang - spread)],
    [tip[0] - size * Math.cos(ang + spread), tip[1] - size * Math.sin(ang + spread)],
  ];
}

/* ------------------------------------------------------------------ */
/* Grid occupancy                                                      */
/* ------------------------------------------------------------------ */

export class Occupancy {
  cells: boolean[][];
  constructor() {
    this.cells = Array.from({ length: GRID.rows }, () => Array(GRID.cols).fill(false));
  }
  fits(c: Cell): boolean {
    for (let r = c.row; r < c.row + c.h; r++)
      for (let k = c.col; k < c.col + c.w; k++) if (r >= GRID.rows || k >= GRID.cols || this.cells[r][k]) return false;
    return true;
  }
  mark(c: Cell) {
    for (let r = c.row; r < Math.min(GRID.rows, c.row + c.h); r++)
      for (let k = c.col; k < Math.min(GRID.cols, c.col + c.w); k++) this.cells[r][k] = true;
  }
  markRect(r: Rect) {
    const c0 = clampInt(Math.floor((r.x - GRID.x) / CELL_W), 0, GRID.cols - 1);
    const c1 = clampInt(Math.ceil((r.x + r.w - GRID.x) / CELL_W) - 1, 0, GRID.cols - 1);
    const r0 = clampInt(Math.floor((r.y - GRID.y) / CELL_H), 0, GRID.rows - 1);
    const r1 = clampInt(Math.ceil((r.y + r.h - GRID.y) / CELL_H) - 1, 0, GRID.rows - 1);
    if (r.y + r.h < GRID.y) return;
    this.mark({ col: c0, row: r0, w: c1 - c0 + 1, h: r1 - r0 + 1 });
  }
  /** Nearest free slot of the given size to (col,row), by distance between top-left corners. */
  nearest(w: number, h: number, col: number, row: number): Cell | null {
    let best: Cell | null = null;
    let bestD = Infinity;
    for (let r = 0; r + h <= GRID.rows; r++)
      for (let k = 0; k + w <= GRID.cols; k++) {
        const c = { col: k, row: r, w, h };
        if (!this.fits(c)) continue;
        const d = Math.abs(k - col) + Math.abs(r - row) * 1.3;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    return best;
  }
}

const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  text: { w: 4, h: 1 },
  note: { w: 3, h: 2 },
  box: { w: 3, h: 1 },
  circle: { w: 2, h: 2 },
  icon: { w: 2, h: 2 },
  list: { w: 5, h: 3 },
  flow: { w: 10, h: 2 },
  cycle: { w: 6, h: 4 },
  plot: { w: 5, h: 4 },
  bars: { w: 6, h: 4 },
  number: { w: 3, h: 2 },
  sketch: { w: 3, h: 3 },
  particles: { w: 3, h: 3 },
  timeline: { w: 10, h: 2 },
  pie: { w: 5, h: 3 },
  compare: { w: 8, h: 4 },
};

export function clampCell(c: Cell): Cell {
  const w = clampInt(c.w, 1, GRID.cols);
  const h = clampInt(c.h, 1, GRID.rows);
  return { col: clampInt(c.col, 0, GRID.cols - w), row: clampInt(c.row, 0, GRID.rows - h), w, h };
}

/** Puts an element where the model asked, or as close as possible without overlap. */
export function placeCell(occ: Occupancy, want: Cell | null, kind: string): Cell {
  const def = DEFAULT_SIZE[kind] ?? { w: 3, h: 1 };
  const desired = want ? clampCell(want) : null;
  if (desired && occ.fits(desired)) {
    occ.mark(desired);
    return desired;
  }
  const w0 = desired?.w ?? def.w;
  const h0 = desired?.h ?? def.h;
  const col0 = desired?.col ?? 0;
  const row0 = desired?.row ?? 0;
  const sizes: [number, number][] = [];
  for (let dw = 0; dw <= Math.ceil(w0 / 2); dw++)
    for (let dh = 0; dh <= Math.ceil(h0 / 2); dh++) sizes.push([Math.max(1, w0 - dw), Math.max(1, h0 - dh)]);
  sizes.sort((p, q) => q[0] * q[1] - p[0] * p[1]);
  for (const [w, h] of sizes) {
    const c = occ.nearest(w, h, col0, row0);
    if (c) {
      occ.mark(c);
      return c;
    }
  }
  const fallback = desired ?? clampCell({ col: 0, row: 0, ...def });
  occ.mark(fallback);
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Element builders                                                    */
/* ------------------------------------------------------------------ */

function textPart(
  text: string,
  box: Rect,
  color: string,
  opts: { max?: number; min?: number; maxLines?: number; anchor?: "start" | "middle"; weight?: number; a?: number; b?: number; halo?: string } = {},
): { part: Extract<Part, { type: "text" }>; bbox: Rect } {
  const fit = fitText(text, box.w, box.h, { max: opts.max, min: opts.min, maxLines: opts.maxLines });
  const anchor = opts.anchor ?? "start";
  const blockH = fit.lines.length * fit.size * fit.lineHeight;
  const top = box.y + (box.h - blockH) / 2;
  const x = anchor === "middle" ? box.x + box.w / 2 : box.x;
  const widths = fit.lines.map((l) => textWidth(l, fit.size));
  const bx = anchor === "middle" ? box.x + (box.w - fit.width) / 2 : box.x;
  return {
    part: {
      type: "text",
      x,
      y: top + fit.size * 0.8,
      lines: fit.lines,
      size: fit.size,
      lineHeight: fit.lineHeight,
      color,
      anchor,
      weight: opts.weight ?? 600,
      widths,
      a: opts.a ?? 0,
      b: opts.b ?? 1,
      halo: opts.halo,
    },
    bbox: { x: bx, y: top, w: fit.width, h: blockH },
  };
}

function el(base: Omit<BoardElement, "seq" | "seqCount" | "clickable" | "transient"> & Partial<BoardElement>): BoardElement {
  return { seq: 0, seqCount: 1, clickable: true, transient: false, ...base };
}

function buildTitle(title: string): BoardElement {
  const fit = fitText(title, TITLE.maxWidth, TITLE.size * 1.2, { max: TITLE.size, min: 34, maxLines: 1 });
  const width = textWidth(fit.lines[0], fit.size);
  const uy = TITLE.baseline + 16;
  const ux2 = TITLE.x + Math.min(width, 560);
  return el({
    id: "__title",
    actionId: "__title",
    kind: "title",
    label: title,
    bbox: { x: TITLE.x, y: TITLE.baseline - fit.size, w: width, h: fit.size * 1.2 },
    parts: [
      { type: "text", x: TITLE.x, y: TITLE.baseline, lines: fit.lines, size: fit.size, lineHeight: 1.1, color: INK.ink, anchor: "start", weight: 700, widths: [width], a: 0, b: 0.8 },
      ...strokeParts(roughLine(TITLE.x, uy, ux2, uy + 3, seedFrom(title), { strokeWidth: 3.5 }), INK.blue, 3.5, 0.75, 1, [[TITLE.x, uy], [ux2, uy]]),
    ],
    natural: clamp(0.03 * title.length + 0.6, 0.8, 1.6),
    clickable: false,
  });
}

function buildElement(a: Action, rect: Rect, warnings: string[]): BoardElement[] {
  const color = colorOf(a.color);
  const seed = seedFrom(a.id);
  const text = (a.text ?? "").trim();
  switch (a.kind) {
    case "text": {
      const { part, bbox } = textPart(text || "…", inset(rect, 10), color, { max: 66, min: 24, maxLines: 4 });
      return [el({ id: a.id, actionId: a.id, kind: a.kind, label: text, bbox, parts: [part], natural: textDur(text) })];
    }
    case "note": {
      // A sticky note slaps onto the board (with a soft shadow), then gets written on.
      const r = inset(rect, 10);
      const shadow = roughRect(r.x + 7, r.y + 9, r.w, r.h, seed + 9, { fill: "#000000", fillStyle: "solid", stroke: "none" });
      const paths = roughRect(r.x, r.y, r.w, r.h, seed, { fill: NOTE_FILL, fillStyle: "solid", stroke: NOTE_STROKE, strokeWidth: 2.5 });
      const { part } = textPart(text || "…", inset(r, 18), color, { max: 48, min: 20, maxLines: 5, anchor: "middle" });
      return [
        el({
          id: a.id,
          actionId: a.id,
          kind: a.kind,
          label: text,
          bbox: r,
          parts: [
            ...strokeParts(shadow, NOTE_STROKE, 0, 0, 0, undefined, { color: "#000000", a: 0, b: 0.02, opacity: 0.07 }),
            ...strokeParts(paths, NOTE_STROKE, 2.5, 0.02, 0.28, rectPerimeter(r), { color: NOTE_FILL, a: 0, b: 0.02 }),
            { ...part, a: 0.28, b: 1 },
          ],
          natural: 0.55 + textDur(text),
          pop: true,
        }),
      ];
    }
    case "box":
    case "circle": {
      // Outline first, then coloured in with hand hatching, then labelled.
      const r = inset(rect, 12);
      const isBox = a.kind === "box";
      const tint = tintOf(a.color);
      const paths = isBox
        ? roughRect(r.x, r.y, r.w, r.h, seed, { stroke: color, ...hatchFill(tint) })
        : roughEllipse(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, seed, { stroke: color, ...hatchFill(tint) });
      const trail = isBox ? rectPerimeter(r) : ellipsePoints(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2);
      const inner = isBox ? inset(r, 14) : { x: r.x + r.w * 0.15, y: r.y + r.h * 0.2, w: r.w * 0.7, h: r.h * 0.6 };
      const parts: Part[] = strokeParts(paths, color, 3, 0, 0.42, trail, undefined, { color: tint, a: 0.36, b: 0.62, opacity: 0.85 });
      if (text) parts.push({ ...textPart(text, inner, INK.ink, { max: 54, min: 18, maxLines: 3, anchor: "middle", halo: BOARD_BG }).part, a: 0.55, b: 1 });
      return [el({ id: a.id, actionId: a.id, kind: a.kind, label: text || null, bbox: r, parts, natural: 0.95 + (text ? textDur(text) * 0.7 : 0) })];
    }
    case "icon": {
      // A pale colour spot pops in, the line drawing is sketched over it, then the caption.
      const r = inset(rect, 8);
      const name = resolveIcon(a.icon) ?? resolveIcon(text);
      const nodes = name ? iconNodes(name) : null;
      const capH = text ? Math.min(64, r.h * 0.32) : 0;
      if (!nodes) {
        warnings.push(`unknown icon "${a.icon}" for ${a.id}; drew a box instead`);
        return buildElement({ ...a, kind: "box", text: text || a.icon || "?" }, rect, warnings);
      }
      const size = Math.max(32, Math.min(r.w, r.h - capH) * 0.86);
      const ix = r.x + (r.w - size) / 2;
      const iy = r.y + (r.h - capH - size) / 2;
      const parts: Part[] = [
        blobPart(ix + size * 0.53, iy + size * 0.54, size * 1.08, size * 1.0, washOf(a.color), seed + 3, 0, 0.2),
        { type: "icon", nodes, x: ix, y: iy, size, color, a: 0.08, b: text ? 0.72 : 1 },
      ];
      if (text) parts.push({ ...textPart(text, { x: r.x - 10, y: r.y + r.h - capH, w: r.w + 20, h: capH }, INK.ink, { max: 46, min: 18, maxLines: 2, anchor: "middle" }).part, a: 0.62, b: 1 });
      return [el({ id: a.id, actionId: a.id, kind: a.kind, label: text || name, bbox: r, art: { x: ix, y: iy, w: size, h: size }, parts, natural: 1.15 + (text ? textDur(text) * 0.5 : 0) })];
    }
    case "list": {
      const items = (a.items ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      if (!items.length && text) items.push(text);
      if (!items.length) return [];
      const r = inset(rect, 10);
      // Bullets can be small drawings ("check" for takeaways) instead of dots.
      const bulletIcon = a.icon ? iconNodes(resolveIcon(a.icon) ?? "") : null;
      const indent = bulletIcon ? 52 : 34;
      let size = 54;
      let wrapped: ReturnType<typeof fitText>[] = [];
      for (; size >= 20; size -= 2) {
        wrapped = items.map((it) => fitText(it, r.w - indent, 999, { max: size, min: size, maxLines: 3 }));
        const total = wrapped.reduce((s, f) => s + f.lines.length * size * 1.12, 0) + (items.length - 1) * size * 0.35;
        if (total <= r.h) break;
      }
      const totalH = wrapped.reduce((s, f) => s + f.lines.length * size * 1.12, 0) + (items.length - 1) * size * 0.35;
      let y = r.y + Math.max(0, (r.h - totalH) / 2);
      return items.map((it, k) => {
        const f = wrapped[k];
        const h = f.lines.length * size * 1.12;
        const by = y + size * 0.45;
        const bullet = roughEllipse(r.x + 10, by, 13, 13, seed + k, { stroke: color, strokeWidth: 3, fill: color, fillStyle: "solid" });
        const iconSize = Math.min(40, size * 0.85);
        const bulletParts: Part[] = bulletIcon
          ? [{ type: "icon", nodes: bulletIcon, x: r.x, y: by - iconSize / 2, size: iconSize, color, a: 0, b: 0.2 }]
          : strokeParts(bullet, color, 3, 0, 0.12, undefined, { color, a: 0, b: 0.15, origin: [r.x + 10, by] });
        const tx = r.x + indent;
        const part: Part = { type: "text", x: tx, y: y + size * 0.8, lines: f.lines, size, lineHeight: 1.12, color: INK.ink, anchor: "start", weight: 600, widths: f.lines.map((l) => textWidth(l, size)), a: 0.15, b: 1 };
        const bbox = { x: tx, y, w: f.width, h };
        y += h + size * 0.35;
        return el({
          id: `${a.id}.${k}`,
          actionId: a.id,
          kind: "list-item",
          label: it,
          bbox,
          parts: [...bulletParts, part],
          natural: textDur(it) + 0.15,
          seq: k,
          seqCount: items.length,
        });
      });
    }
    case "flow": {
      const items = (a.items ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      if (items.length < 2) return items.length ? buildElement({ ...a, kind: "box", text: items[0] }, rect, warnings) : [];
      const r = inset(rect, 10);
      const n = items.length;
      const horizontal = r.w >= r.h * 1.3;
      const gap = horizontal ? clamp(r.w * 0.08, 44, 96) : clamp(r.h * 0.12, 30, 70);
      const nodeW = horizontal ? (r.w - gap * (n - 1)) / n : Math.min(r.w, 420);
      const nodeH = horizontal ? Math.min(r.h, Math.max(84, nodeW * 0.62)) : (r.h - gap * (n - 1)) / n;
      const nodes: Rect[] = items.map((_, k) =>
        horizontal
          ? { x: r.x + k * (nodeW + gap), y: r.y + (r.h - nodeH) / 2, w: nodeW, h: nodeH }
          : { x: r.x + (r.w - nodeW) / 2, y: r.y + k * (nodeH + gap), w: nodeW, h: nodeH },
      );
      const out: BoardElement[] = [];
      const tint = tintOf(a.color);
      items.forEach((it, k) => {
        const nr = nodes[k];
        const paths = roughRect(nr.x, nr.y, nr.w, nr.h, seed + k * 7, { stroke: color, ...hatchFill(tint) });
        const { part } = textPart(it, inset(nr, 12), INK.ink, { max: 48, min: 16, maxLines: 3, anchor: "middle", halo: BOARD_BG });
        out.push(
          el({
            id: `${a.id}.${k}`,
            actionId: a.id,
            kind: "flow-node",
            label: it,
            bbox: nr,
            parts: [...strokeParts(paths, color, 3, 0, 0.42, rectPerimeter(nr), undefined, { color: tint, a: 0.36, b: 0.6, opacity: 0.85 }), { ...part, a: 0.5, b: 1 }],
            natural: 0.7 + textDur(it) * 0.6,
            seq: k * 2,
            seqCount: n * 2 - 1,
          }),
        );
        if (k < n - 1) {
          const nx = nodes[k + 1];
          const p1: Pt = horizontal ? [nr.x + nr.w + 8, nr.y + nr.h / 2] : [nr.x + nr.w / 2, nr.y + nr.h + 6];
          const p2: Pt = horizontal ? [nx.x - 10, nx.y + nx.h / 2] : [nx.x + nx.w / 2, nx.y - 8];
          out.push(arrowElement(`${a.id}.a${k}`, a.id, [p1, p2], color, null, seed + k * 13, { seq: k * 2 + 1, seqCount: n * 2 - 1, flow: true }));
        }
      });
      return out;
    }
    case "cycle": {
      const items = (a.items ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      if (items.length < 3) return buildElement({ ...a, kind: "flow" }, rect, warnings);
      const r = inset(rect, 8);
      const n = items.length;
      const nodeW = clamp(r.w * (n > 4 ? 0.3 : 0.36), 120, 280);
      const nodeH = clamp(r.h * (n > 4 ? 0.2 : 0.24), 64, 110);
      const [cx, cy] = center(r);
      const rx = Math.max(10, (r.w - nodeW) / 2);
      const ry = Math.max(10, (r.h - nodeH) / 2);
      const angle = (k: number) => -Math.PI / 2 + (k / n) * Math.PI * 2;
      const nodes: Rect[] = items.map((_, k) => ({ x: cx + rx * Math.cos(angle(k)) - nodeW / 2, y: cy + ry * Math.sin(angle(k)) - nodeH / 2, w: nodeW, h: nodeH }));
      const out: BoardElement[] = [];
      const tint = tintOf(a.color);
      items.forEach((it, k) => {
        const nr = nodes[k];
        const paths = roughEllipse(nr.x + nr.w / 2, nr.y + nr.h / 2, nr.w, nr.h, seed + k * 5, { stroke: color, ...hatchFill(tint, 11) });
        const { part } = textPart(it, { x: nr.x + nr.w * 0.12, y: nr.y + nr.h * 0.16, w: nr.w * 0.76, h: nr.h * 0.68 }, INK.ink, { max: 40, min: 15, maxLines: 2, anchor: "middle", halo: BOARD_BG });
        out.push(
          el({
            id: `${a.id}.${k}`,
            actionId: a.id,
            kind: "cycle-node",
            label: it,
            bbox: nr,
            parts: [
              ...strokeParts(paths, color, 3, 0, 0.42, ellipsePoints(nr.x + nr.w / 2, nr.y + nr.h / 2, nr.w / 2, nr.h / 2), undefined, { color: tint, a: 0.36, b: 0.6, opacity: 0.85 }),
              { ...part, a: 0.5, b: 1 },
            ],
            natural: 0.7 + textDur(it) * 0.5,
            seq: k * 2,
            seqCount: n * 2,
          }),
        );
        // Arc from node k to node k+1 along the ring, trimmed outside both nodes.
        const k2 = (k + 1) % n;
        const a0 = angle(k);
        const a1 = k2 === 0 ? angle(n) : angle(k2);
        const pts: Pt[] = [];
        for (let s = 0; s <= 40; s++) {
          const t = a0 + ((a1 - a0) * s) / 40;
          pts.push([cx + rx * 1.04 * Math.cos(t), cy + ry * 1.04 * Math.sin(t)]);
        }
        const inside = (p: Pt, q: Rect) => p[0] > q.x - 12 && p[0] < q.x + q.w + 12 && p[1] > q.y - 12 && p[1] < q.y + q.h + 12;
        const arc = pts.filter((p) => !inside(p, nodes[k]) && !inside(p, nodes[k2]));
        if (arc.length >= 3) {
          const sample = [arc[0], arc[Math.floor(arc.length / 2)], arc[arc.length - 1]];
          const tip = arc[arc.length - 1];
          const [h1, h2] = arrowHead(tip, arc[Math.max(0, arc.length - 4)], 20);
          const parts: Part[] = [
            ...strokeParts(roughCurve(sample, seed + k * 11, { stroke: color, strokeWidth: 3 }), color, 3, 0, 0.8, arc),
            ...strokeParts(roughLinear([h1, tip, h2], seed + k * 17, { stroke: color, strokeWidth: 3 }), color, 3, 0.8, 1),
            { type: "flow", d: polyD(arc.slice(0, Math.max(2, arc.length - 3))), color, a: 1, b: 1 },
          ];
          out.push(
            el({
              id: `${a.id}.a${k}`,
              actionId: a.id,
              kind: "cycle-arrow",
              label: null,
              bbox: union(arc.map(([x, y]) => ({ x, y, w: 1, h: 1 }))),
              parts,
              natural: 0.45,
              seq: k * 2 + 1,
              seqCount: n * 2,
              clickable: false,
              ambient: true,
            }),
          );
        }
      });
      return out;
    }
    case "plot": {
      const parsed = a.expr ? parsePlot(a.expr) : null;
      if (!parsed) {
        warnings.push(`could not plot "${a.expr}" for ${a.id}`);
        return buildElement({ ...a, kind: "box", text: text || a.expr || "graph" }, rect, warnings);
      }
      const r = inset(rect, 12);
      const labelH = text ? 46 : 0;
      const p: Rect = { x: r.x + 18, y: r.y + labelH + 8, w: r.w - 36, h: r.h - labelH - 20 };
      const { fn, xMin, xMax } = parsed;
      const N = 160;
      const xs = Array.from({ length: N + 1 }, (_, i) => xMin + ((xMax - xMin) * i) / N);
      const ys = xs.map((x) => fn(x));
      const finite = ys.filter((y) => Number.isFinite(y)).sort((m, q) => m - q);
      if (finite.length < 4) return buildElement({ ...a, kind: "box", text: text || "graph" }, rect, warnings);
      let yMin = finite[Math.floor(finite.length * 0.02)];
      let yMax = finite[Math.ceil(finite.length * 0.98) - 1];
      if (yMax - yMin < 1e-9) {
        yMin -= 1;
        yMax += 1;
      }
      const span = yMax - yMin;
      if (yMin > 0 && yMin < span * 0.6) yMin = 0;
      if (yMax < 0 && -yMax < span * 0.6) yMax = 0;
      const pad = (yMax - yMin) * 0.08;
      yMin -= pad;
      yMax += pad;
      const X = (x: number) => p.x + ((x - xMin) / (xMax - xMin)) * p.w;
      const Y = (y: number) => p.y + p.h - ((y - yMin) / (yMax - yMin)) * p.h;
      const axisY = yMin <= 0 && yMax >= 0 ? Y(0) : p.y + p.h;
      const axisX = xMin <= 0 && xMax >= 0 ? X(0) : p.x;
      let d = "";
      const trail: Pt[] = [];
      let pen = false;
      xs.forEach((x, i) => {
        const y = ys[i];
        if (!Number.isFinite(y) || y < yMin - pad * 3 || y > yMax + pad * 3) {
          pen = false;
          return;
        }
        const px = X(x);
        const py = clamp(Y(y), p.y - 6, p.y + p.h + 6);
        d += `${pen ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)} `;
        trail.push([px, py]);
        pen = true;
      });
      const xTip: Pt = [p.x + p.w, axisY];
      const yTip: Pt = [axisX, p.y];
      const [xh1, xh2] = arrowHead(xTip, [p.x, axisY], 16);
      const [yh1, yh2] = arrowHead(yTip, [axisX, p.y + p.h], 16);
      const curveEnd = text ? 0.82 : 0.92;
      const parts: Part[] = [];
      // When the curve is one unbroken stroke, shade the area under it once it's drawn.
      const continuous = trail.length === xs.length && trail.length > 1;
      if (continuous) {
        const area = `M${trail[0][0].toFixed(1)} ${axisY.toFixed(1)} ${trail.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} L${trail[trail.length - 1][0].toFixed(1)} ${axisY.toFixed(1)} Z`;
        parts.push({ type: "fill", d: area, color: washOf(a.color, "blue"), a: curveEnd - 0.06, b: curveEnd + 0.08, opacity: 0.9 });
      }
      parts.push(
        ...strokeParts(roughLine(p.x, axisY, xTip[0], axisY, seed, { strokeWidth: 2.5 }), INK.ink, 2.5, 0, 0.16, [[p.x, axisY], xTip]),
        ...strokeParts(roughLinear([xh1, xTip, xh2], seed + 2, { strokeWidth: 2.5 }), INK.ink, 2.5, 0.16, 0.2),
        ...strokeParts(roughLine(axisX, p.y + p.h, axisX, yTip[1], seed + 1, { strokeWidth: 2.5 }), INK.ink, 2.5, 0.12, 0.26, [[axisX, p.y + p.h], yTip]),
        ...strokeParts(roughLinear([yh1, yTip, yh2], seed + 3, { strokeWidth: 2.5 }), INK.ink, 2.5, 0.26, 0.3),
        { type: "stroke", d: d.trim(), color, width: 4.5, a: 0.3, b: curveEnd, trail },
      );
      if (text) parts.push({ ...textPart(text, { x: r.x, y: r.y, w: r.w, h: labelH }, color, { max: 42, min: 18, maxLines: 1, anchor: "middle" }).part, a: 0.84, b: 1 });
      return [el({ id: a.id, actionId: a.id, kind: a.kind, label: text || a.expr, bbox: r, parts, natural: 2.3 })];
    }
    case "bars": {
      const entries = parseBars(a.items);
      if (entries.length < 2) return buildElement({ ...a, kind: "list" }, rect, warnings);
      const r = inset(rect, 12);
      const n = entries.length;
      // An optional chart title (text) sits above the bars.
      const titleH = text ? clamp(r.h * 0.13, 30, 48) : 0;
      const valueSize = clamp(r.h * 0.11, 22, 40);
      const labelH = clamp(r.h * 0.17, 34, 64);
      const top = r.y + titleH + valueSize * 1.5;
      const base = r.y + r.h - labelH;
      const slot = r.w / n;
      const barW = clamp(slot * 0.62, 26, 170);
      const max = Math.max(...entries.map((e) => e.value));
      const tint = tintOf(a.color, "blue");
      const title = text ? textPart(text, { x: r.x, y: r.y, w: r.w, h: titleH }, color, { max: 40, min: 18, maxLines: 1, anchor: "middle" }) : null;
      const axisLine = strokeParts(roughLine(r.x - 6, base, r.x + r.w + 6, base + 2, seed, { strokeWidth: 3 }), INK.ink, 3, title ? 0.45 : 0, 1, [[r.x - 6, base], [r.x + r.w + 6, base]]);
      const axis = el({
        id: `${a.id}.axis`,
        actionId: a.id,
        kind: "bars-axis",
        label: text || null,
        bbox: title ? union([title.bbox, { x: r.x, y: base - 2, w: r.w, h: 4 }]) : { x: r.x, y: base - 2, w: r.w, h: 4 },
        parts: title ? [{ ...title.part, a: 0, b: 0.5 }, ...axisLine] : axisLine,
        natural: title ? 0.4 + textDur(text) : 0.4,
        clickable: false,
        seq: 0,
        seqCount: n + 1,
      });
      const bars = entries.map((e, k) => {
        const x = r.x + slot * k + (slot - barW) / 2;
        const h = max > 0 ? Math.max(8, (Math.max(0, e.value) / max) * (base - top)) : 8;
        const paths = roughRect(x, base - h, barW, h, seed + k * 7, { stroke: color, ...hatchFill(tint, 10) });
        const label = textPart(e.label, { x: x - (slot - barW) / 2 + 4, y: base + 6, w: slot - 8, h: labelH - 8 }, INK.ink, { max: 34, min: 14, maxLines: 2, anchor: "middle" });
        return el({
          id: `${a.id}.${k}`,
          actionId: a.id,
          kind: "bar",
          label: `${e.label}: ${e.display}`,
          bbox: { x, y: base - h - valueSize * 1.3, w: barW, h: h + valueSize * 1.3 },
          parts: [
            {
              type: "bar",
              x,
              w: barW,
              h,
              base,
              outline: paths.find((p) => p.kind === "outline")?.d ?? "",
              hatch: paths.find((p) => p.kind === "hatch")?.d ?? "",
              color,
              tint,
              value: { text: e.display, num: countsUp(e.display, parseNumber(e.display)) ? parseNumber(e.display) : null, size: valueSize },
              a: 0,
              b: 0.85,
            },
            { ...label.part, a: 0.1, b: 0.6 },
          ],
          natural: 1.1,
          seq: k + 1,
          seqCount: n + 1,
        });
      });
      return [axis, ...bars];
    }
    case "number": {
      // A key quantity that counts up as it appears, on a pale colour spot, with an optional caption.
      if (!/\d/.test(text)) return buildElement({ ...a, kind: "text" }, rect, warnings);
      const r = inset(rect, 10);
      const caption = (a.items?.[0] ?? "").trim();
      const capH = caption ? clamp(r.h * 0.3, 30, 60) : 0;
      const box: Rect = { x: r.x, y: r.y, w: r.w, h: r.h - capH };
      const fit = fitText(text, box.w * 0.92, box.h * 0.8, { max: 120, min: 26, maxLines: 1 });
      const width = textWidth(fit.lines[0] ?? text, fit.size);
      const cx = box.x + box.w / 2;
      const baseline = box.y + box.h / 2 + fit.size * 0.33;
      const num = parseNumber(text);
      const parts: Part[] = [
        blobPart(cx, box.y + box.h / 2 + 4, Math.min(box.w, width + fit.size * 0.9), Math.min(box.h, fit.size * 1.25), washOf(a.color, "orange"), seed + 5, 0, 0.18),
        { type: "count", x: cx, y: baseline, size: fit.size, color, anchor: "middle", weight: 700, text, num: countsUp(text, num) ? num : null, a: 0.05, b: 0.8 },
      ];
      if (caption) parts.push({ ...textPart(caption, { x: r.x - 10, y: r.y + r.h - capH, w: r.w + 20, h: capH }, INK.ink, { max: 40, min: 16, maxLines: 2, anchor: "middle" }).part, a: 0.7, b: 1 });
      return [el({ id: a.id, actionId: a.id, kind: a.kind, label: caption ? `${text} ${caption}` : text, bbox: r, parts, natural: 1.5 + (caption ? textDur(caption) * 0.4 : 0) })];
    }
    case "sketch": {
      // The model's own line drawing, drawn shape by shape in the board's hand-drawn style.
      const r = inset(rect, 10);
      const capH = text ? Math.min(52, r.h * 0.2) : 0;
      const box: Rect = { x: r.x, y: r.y, w: r.w, h: r.h - capH };
      const shapes = parseSketch(a.items, box);
      if (!shapes.length) {
        warnings.push(`sketch ${a.id}: no shapes it could draw`);
        return text ? buildElement({ ...a, kind: "box" }, rect, warnings) : [];
      }
      const n = shapes.length;
      const span = text ? 0.86 : 1;
      const parts: Part[] = [];
      // The drawing's own bounds: arrows, notes and the camera go to what's drawn, not to empty space around it.
      const bounds: Rect[] = [];
      shapes.forEach((sh, i) => {
        const a0 = (i / n) * span;
        const a1 = ((i + 1) / n) * span;
        const c = sh.color ? INK[sh.color] : color;
        if (sh.text) {
          const tb: Rect = { x: sh.text.x - 140, y: sh.text.y - sh.text.size * 0.75, w: 280, h: sh.text.size * 1.5 };
          const t = textPart(sh.text.words, tb, c, { max: sh.text.size, min: 14, maxLines: 1, anchor: "middle" });
          parts.push({ ...t.part, a: a0, b: a1 });
          bounds.push(t.bbox);
          return;
        }
        bounds.push(inset(union([...sh.trail, ...(sh.head ?? [])].map(([x, y]) => ({ x, y, w: 0, h: 0 }))), -4));
        const tint = tintOf(sh.color ?? a.color);
        const fillOpts = sh.closed && sh.fill === "hatch" ? hatchFill(tint, 10) : sh.fill === "solid" ? { fill: c, fillStyle: "solid" } : {};
        const paths = roughPath(sh.d, seed + i * 11, { stroke: c, strokeWidth: 3, ...fillOpts });
        parts.push(
          ...strokeParts(
            paths,
            c,
            3,
            a0,
            a0 + (a1 - a0) * (sh.fill === "hatch" ? 0.6 : 1),
            sh.trail,
            sh.fill === "solid" ? { color: c, a: a0 + (a1 - a0) * 0.5, b: a1, opacity: 0.9 } : undefined,
            sh.fill === "hatch" ? { color: tint, a: a0 + (a1 - a0) * 0.5, b: a1, opacity: 0.85 } : undefined,
          ),
        );
        if (sh.head) parts.push(...strokeParts(roughLinear(sh.head, seed + i * 13, { stroke: c, strokeWidth: 3 }), c, 3, a0 + (a1 - a0) * 0.8, a1));
      });
      const art = union(bounds);
      let bbox = art;
      if (text) {
        // The caption sits just under the drawing, centred on it.
        const capY = Math.min(r.y + r.h - capH, art.y + art.h + 4);
        const cx = clamp(art.x + art.w / 2, r.x + r.w / 2 - 20, r.x + r.w / 2 + 20);
        const cap = textPart(text, { x: cx - r.w / 2 - 10, y: capY, w: r.w + 20, h: capH }, INK.ink, { max: 44, min: 16, maxLines: 1, anchor: "middle" });
        parts.push({ ...cap.part, a: 0.86, b: 1 });
        bbox = union([art, cap.bbox]);
      }
      return [el({ id: a.id, actionId: a.id, kind: a.kind, label: text || "the drawing", bbox: inset(bbox, -6), art, parts, natural: Math.min(3.4, 0.5 + n * 0.4) + (text ? 0.4 : 0) })];
    }
    case "particles": {
      // Particles bouncing around a box: gas, heat, diffusion, crowds.
      const r = inset(rect, 10);
      const capH = text ? Math.min(46, r.h * 0.2) : 0;
      const box: Rect = { x: r.x, y: r.y, w: r.w, h: r.h - capH };
      const spec = (a.expr ?? "").toLowerCase();
      const count = clampInt(Number(spec.match(/\d+/)?.[0] ?? 14), 3, 30);
      const speed = /very fast|hot/.test(spec) ? 230 : /fast/.test(spec) ? 150 : /slow|cold/.test(spec) ? 40 : 85;
      const inner = inset(box, 14);
      const parts: Part[] = [
        ...strokeParts(roughRect(box.x, box.y, box.w, box.h, seed, { stroke: color, strokeWidth: 2.5, roughness: 0.9 }), color, 2.5, 0, 0.45, rectPerimeter(box)),
        { type: "particles", x: inner.x, y: inner.y, w: inner.w, h: inner.h, n: count, speed, r: clamp(Math.min(inner.w, inner.h) / 34, 5, 10), color, seed, a: 0.35, b: 0.7 },
      ];
      if (text) parts.push({ ...textPart(text, { x: r.x - 10, y: r.y + r.h - capH, w: r.w + 20, h: capH }, INK.ink, { max: 40, min: 16, maxLines: 1, anchor: "middle" }).part, a: 0.7, b: 1 });
      return [el({ id: a.id, actionId: a.id, kind: a.kind, label: text || "particles", bbox: r, parts, natural: 1.4, ambient: true })];
    }
    case "timeline": {
      // Events along a line, labels alternating above and below; short "dates" become numbered stops.
      const events = (a.items ?? [])
        .map((it) => {
          const i = it.indexOf(":");
          return i > 0 ? { date: it.slice(0, i).trim(), label: it.slice(i + 1).trim() } : { date: "", label: it.trim() };
        })
        .filter((e) => e.label)
        .slice(0, 7);
      if (events.length < 2) return buildElement({ ...a, kind: "list" }, rect, warnings);
      const r = inset(rect, 10);
      const n = events.length;
      const axisY = r.y + r.h / 2;
      const xs = events.map((_, k) => r.x + (r.w * (k + 0.5)) / n);
      const [h1, h2] = arrowHead([r.x + r.w, axisY], [r.x, axisY], 18);
      const axis = el({
        id: `${a.id}.axis`,
        actionId: a.id,
        kind: "timeline-axis",
        label: null,
        bbox: { x: r.x, y: axisY - 10, w: r.w, h: 20 },
        parts: [
          ...strokeParts(roughLine(r.x, axisY, r.x + r.w, axisY + 2, seed, { stroke: INK.ink, strokeWidth: 3 }), INK.ink, 3, 0, 0.85, [[r.x, axisY], [r.x + r.w, axisY]]),
          ...strokeParts(roughLinear([h1, [r.x + r.w, axisY], h2], seed + 1, { stroke: INK.ink, strokeWidth: 3 }), INK.ink, 3, 0.85, 1),
        ],
        natural: 0.7,
        clickable: false,
        seq: 0,
        seqCount: n + 1,
      });
      const slotW = Math.min(r.w / n, 320) * 1.55;
      const items = events.map((e, k) => {
        const x = xs[k];
        const up = k % 2 === 0;
        const numbered = e.date.length > 0 && e.date.length <= 3;
        const parts: Part[] = [];
        let markerBox: Rect;
        if (numbered) {
          const d = 50;
          parts.push(
            ...strokeParts(roughEllipse(x, axisY, d, d, seed + k * 7, { stroke: color, strokeWidth: 3, fill: washOf(a.color, "blue"), fillStyle: "solid" }), color, 3, 0, 0.3, ellipsePoints(x, axisY, d / 2, d / 2), {
              color: washOf(a.color, "blue"),
              a: 0,
              b: 0.08,
              origin: [x, axisY],
            }),
            { ...textPart(e.date, { x: x - d / 2, y: axisY - d / 2, w: d, h: d }, color, { max: 30, min: 16, maxLines: 1, anchor: "middle" }).part, weight: 700, a: 0.2, b: 0.35 },
          );
          markerBox = { x: x - d / 2, y: axisY - d / 2, w: d, h: d };
        } else {
          parts.push(...strokeParts(roughEllipse(x, axisY, 18, 18, seed + k * 7, { stroke: color, strokeWidth: 3, fill: color, fillStyle: "solid" }), color, 3, 0, 0.15, undefined, { color, a: 0, b: 0.15, origin: [x, axisY] }));
          const dateBox: Rect = { x: x - slotW / 2, y: up ? axisY - 52 : axisY + 14, w: slotW, h: 38 };
          if (e.date) parts.push({ ...textPart(e.date, dateBox, color, { max: 32, min: 16, maxLines: 1, anchor: "middle" }).part, weight: 700, a: 0.1, b: 0.4 });
          markerBox = { x: x - 9, y: axisY - 9, w: 18, h: 18 };
        }
        const gap = numbered ? 34 : e.date ? 58 : 18;
        const labelBox: Rect = up ? { x: x - slotW / 2, y: r.y, w: slotW, h: axisY - gap - r.y } : { x: x - slotW / 2, y: axisY + gap, w: slotW, h: r.y + r.h - axisY - gap };
        const label = textPart(e.label, labelBox, INK.ink, { max: 38, min: 15, maxLines: 3, anchor: "middle" });
        parts.push({ ...label.part, a: 0.35, b: 1 });
        return el({
          id: `${a.id}.${k}`,
          actionId: a.id,
          kind: "timeline-event",
          label: e.date ? `${e.date}: ${e.label}` : e.label,
          bbox: union([markerBox, label.bbox]),
          parts,
          natural: 0.5 + textDur(e.label) * 0.6,
          seq: k + 1,
          seqCount: n + 1,
        });
      });
      return [axis, ...items];
    }
    case "pie": {
      // Shares of a whole: wedges sweep open one by one, with a legend of percentages.
      const entries = parseBars(a.items).filter((e) => e.value > 0);
      const total = entries.reduce((sum, e) => sum + e.value, 0);
      if (entries.length < 2 || total <= 0) return buildElement({ ...a, kind: "list" }, rect, warnings);
      const r = inset(rect, 10);
      const titleH = text ? clamp(r.h * 0.14, 28, 46) : 0;
      const area: Rect = { x: r.x, y: r.y + titleH, w: r.w, h: r.h - titleH };
      const rad = Math.max(40, Math.min(area.h / 2 - 8, area.w * 0.26));
      const cx = area.x + rad + 10;
      const cy = area.y + area.h / 2;
      const legendX = cx + rad + 34;
      const rowH = Math.min(56, area.h / entries.length);
      const legendTop = cy - (rowH * entries.length) / 2;
      const palette: Color[] = ["blue", "orange", "green", "purple", "red", "ink"];
      const ring = el({
        id: `${a.id}.ring`,
        actionId: a.id,
        kind: "pie-ring",
        label: text || null,
        bbox: { x: cx - rad, y: cy - rad, w: rad * 2, h: rad * 2 },
        parts: [
          ...strokeParts(roughEllipse(cx, cy, rad * 2, rad * 2, seed, { stroke: INK.ink, strokeWidth: 2.5 }), INK.ink, 2.5, 0, 0.7, ellipsePoints(cx, cy, rad, rad)),
          ...(text ? [{ ...textPart(text, { x: r.x, y: r.y, w: r.w, h: titleH }, color, { max: 40, min: 18, maxLines: 1, anchor: "middle" }).part, a: 0.3, b: 1 } as Part] : []),
        ],
        natural: text ? 0.6 + textDur(text) * 0.5 : 0.6,
        clickable: false,
        seq: 0,
        seqCount: entries.length + 1,
      });
      let acc = 0;
      const wedges = entries.map((e, k) => {
        const tone = palette[k % palette.length];
        const a0 = (acc / total) * Math.PI * 2;
        acc += e.value;
        const a1 = (acc / total) * Math.PI * 2;
        const pct = `${Math.round((e.value / total) * 100)}%`;
        const ly = legendTop + k * rowH;
        const swatch = roughRect(legendX, ly + rowH * 0.22, rowH * 0.5, rowH * 0.5, seed + k * 5, { stroke: INK[tone], strokeWidth: 2, fill: HATCH[tone], fillStyle: "solid" });
        const legend = textPart(`${e.label} · ${pct}`, { x: legendX + rowH * 0.7, y: ly, w: Math.max(80, r.x + r.w - legendX - rowH * 0.7), h: rowH }, INK.ink, { max: 34, min: 14, maxLines: 1 });
        return el({
          id: `${a.id}.${k}`,
          actionId: a.id,
          kind: "pie-wedge",
          label: `${e.label}: ${pct}`,
          bbox: union([{ x: cx - rad, y: cy - rad, w: rad * 2, h: rad * 2 }, legend.bbox]),
          parts: [
            { type: "wedge", cx, cy, r: rad, a0, a1, color: INK[tone], tint: HATCH[tone], a: 0, b: 0.75 },
            ...strokeParts(swatch, INK[tone], 2, 0.3, 0.5, undefined, { color: HATCH[tone], a: 0.3, b: 0.4 }),
            { ...legend.part, a: 0.45, b: 1 },
          ],
          natural: 1.1,
          seq: k + 1,
          seqCount: entries.length + 1,
        });
      });
      return [ring, ...wedges];
    }
    case "compare": {
      // A small table: headers first, then one row at a time.
      const rows = (a.items ?? [])
        .map((it) => it.split("|").map((c) => c.trim()))
        .filter((cells) => cells.length >= 2)
        .slice(0, 6);
      if (rows.length < 2) return buildElement({ ...a, kind: "list", items: (a.items ?? []).map((it) => it.replace(/\s*\|\s*/g, " — ")) }, rect, warnings);
      const cols = Math.min(3, Math.max(...rows.map((cells) => cells.length)));
      const r = inset(rect, 10);
      const headH = r.h / (rows.length + 0.25) * 1.25;
      const rowH = (r.h - headH) / (rows.length - 1);
      const colW = r.w / cols;
      const tint = washOf(a.color, "blue");
      const size = Math.min(40, rowH * 0.42);
      const cellPart = (txt: string, i: number, y: number, h: number, c: string, weight: number, a0: number, b0: number): Part => ({
        ...textPart(txt, { x: r.x + i * colW + 10, y: y + 4, w: colW - 20, h: h - 8 }, c, { max: size, min: 14, maxLines: 2, anchor: "middle" }).part,
        weight,
        a: a0,
        b: b0,
      });
      const lines: Part[] = [
        ...strokeParts(roughRect(r.x, r.y, r.w, r.h, seed, { stroke: color, strokeWidth: 2.5, roughness: 0.8 }), color, 2.5, 0, 0.35, rectPerimeter(r)),
        ...Array.from({ length: cols - 1 }, (_, i) => strokeParts(roughLine(r.x + (i + 1) * colW, r.y, r.x + (i + 1) * colW, r.y + r.h, seed + 3 + i, { stroke: color, strokeWidth: 2 }), color, 2, 0.2, 0.45)).flat(),
        ...strokeParts(roughLine(r.x, r.y + headH, r.x + r.w, r.y + headH, seed + 9, { stroke: color, strokeWidth: 2.5 }), color, 2.5, 0.35, 0.5),
      ];
      const headFill = roughRect(r.x + 3, r.y + 3, r.w - 6, headH - 6, seed + 11, { fill: tint, fillStyle: "solid", stroke: "none" });
      const head = el({
        id: `${a.id}.head`,
        actionId: a.id,
        kind: "compare-head",
        label: rows[0].join(" vs "),
        bbox: r,
        parts: [...strokeParts(headFill, color, 0, 0, 0, undefined, { color: tint, a: 0, b: 0.15, opacity: 0.8 }), ...lines, ...rows[0].slice(0, cols).map((h, i) => cellPart(h, i, r.y, headH, color, 700, 0.5 + i * 0.1, 0.8 + i * 0.07))],
        natural: 1.2,
        clickable: false,
        seq: 0,
        seqCount: rows.length,
      });
      const body = rows.slice(1).map((cells, k) => {
        const y = r.y + headH + k * rowH;
        const parts: Part[] = cells.slice(0, cols).map((c, i) => cellPart(c, i, y, rowH, INK.ink, 600, (i / cols) * 0.9, ((i + 1) / cols) * 0.9 + 0.1));
        if (k < rows.length - 2) parts.push(...strokeParts(roughLine(r.x + 6, y + rowH, r.x + r.w - 6, y + rowH, seed + 20 + k, { stroke: HATCH[a.color ?? "ink"], strokeWidth: 2 }), HATCH[a.color ?? "ink"], 2, 0, 0.3));
        return el({ id: `${a.id}.${k}`, actionId: a.id, kind: "compare-row", label: cells.join(" | "), bbox: { x: r.x, y, w: r.w, h: rowH }, parts, natural: 0.4 + textDur(cells.join(" ")) * 0.6, seq: k + 1, seqCount: rows.length });
      });
      return [head, ...body];
    }
    default:
      return [];
  }
}

/** Bar chart items such as "Year 1: $110", "Mars = 0.38" or "Cats 40%": label, numeric value and how to show it. */
export function parseBars(items: string[] | null): { label: string; value: number; display: string }[] {
  const out: { label: string; value: number; display: string }[] = [];
  for (const raw of (items ?? []).slice(0, 8)) {
    const s = raw.trim();
    const sep = Math.max(s.lastIndexOf(":"), s.lastIndexOf("="));
    let label: string;
    let display: string;
    if (sep > 0) {
      label = s.slice(0, sep).trim();
      display = s.slice(sep + 1).trim();
    } else {
      const m = /(-?[$€£]?\d[\d,]*(?:\.\d+)?\s*%?\S*)\s*$/.exec(s);
      if (!m) return [];
      label = s.slice(0, m.index).trim();
      display = m[1].trim();
    }
    const num = parseNumber(display);
    if (!num || !label) return [];
    out.push({ label, value: num.value, display });
  }
  return out;
}

const polyD = (pts: Pt[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

/** The polyline with its last `cut` units removed. */
function trimEnd(pts: Pt[], cut: number): Pt[] {
  const out = [...pts];
  let left = cut;
  while (out.length > 2 && left > 0) {
    const [a, b] = [out[out.length - 2], out[out.length - 1]];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg > left) break;
    out.pop();
    left -= seg;
  }
  const [a, b] = [out[out.length - 2], out[out.length - 1]];
  const seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const k = Math.max(0, (seg - left) / seg);
  out[out.length - 1] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  return out;
}

/** The point halfway along a polyline. */
function midAlong(pts: Pt[]): Pt {
  const half = pathLength(pts) / 2;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + seg >= half) {
      const k = seg ? (half - acc) / seg : 0;
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}

interface ArrowOpts {
  seq?: number;
  seqCount?: number;
  head?: boolean;
  /** Beads keep flowing along it once it's drawn. */
  flow?: boolean;
  /** Where the label goes: 1 = above (right of a vertical arrow), -1 = below (left of it). */
  side?: 1 | -1;
}

/** An arrow along a route: two points for a straight one, more for a curve. */
function arrowElement(id: string, actionId: string, route: Pt[], color: string, label: string | null, seed: number, opts: ArrowOpts = {}): BoardElement {
  const { seq = 0, seqCount = 1, head = true, flow = false, side = 1 } = opts;
  const p1 = route[0];
  const p2 = route[route.length - 1];
  const curved = route.length > 2;
  const shaft = curved ? roughCurve(route, seed, { stroke: color, strokeWidth: 3 }) : roughLine(p1[0], p1[1], p2[0], p2[1], seed, { stroke: color, strokeWidth: 3 });
  const parts: Part[] = strokeParts(shaft, color, 3, 0, head ? 0.75 : 1, route);
  if (head) {
    // Aimed along the last stretch of the route.
    const back = curved ? trimEnd(route, 26) : [p1];
    const [h1, h2] = arrowHead(p2, back[back.length - 1], 20);
    parts.push(...strokeParts(roughLinear([h1, p2, h2], seed + 1, { stroke: color, strokeWidth: 3 }), color, 3, 0.75, 1));
  }
  const len = pathLength(route);
  // Beads flow along the shaft once it's drawn (stopping short of the head).
  if (flow && head && len > 60) parts.push({ type: "flow", d: polyD(trimEnd(route, 18)), color, a: 1, b: 1 });
  let bbox = union(route.map(([x, y]) => ({ x, y, w: 1, h: 1 })));
  if (label) {
    const [mx, my] = midAlong(route);
    const vertical = Math.abs(p2[0] - p1[0]) < Math.abs(p2[1] - p1[1]);
    const w = Math.max(160, Math.min(320, textWidth(label, 30) + 20));
    const box: Rect = vertical
      ? { x: side > 0 ? mx + 12 : mx - 12 - w, y: my - 24, w, h: 48 }
      : { x: mx - w / 2, y: side > 0 ? my - 58 : my + 12, w, h: 46 };
    const t = textPart(label, box, color, { max: 34, min: 18, maxLines: 2, anchor: vertical ? "start" : "middle" });
    // Left of a vertical arrow, the words end right next to it.
    const shift = vertical && side < 0 ? box.w - t.bbox.w : 0;
    parts.push({ ...t.part, x: t.part.x + shift, a: 0.55, b: 1 });
    bbox = union([bbox, { ...t.bbox, x: t.bbox.x + shift }]);
  }
  return el({ id, actionId, kind: "arrow", label, bbox, parts, natural: (label ? 0.9 : 0.5) + (curved ? 0.2 : 0), seq, seqCount, clickable: !!label, ambient: flow && head && len > 60 });
}

/** Points along a quadratic Bézier. */
function quadPoints(p1: Pt, c: Pt, p2: Pt, n = 16): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return [u * u * p1[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * c[1] + t * t * p2[1]] as Pt;
  });
}

/**
 * How a connector gets from one element to another: straight across the gap,
 * shifted sideways by `shift` (so a pair going there and back runs side by
 * side), or, when the two sit too close for a straight arrow to read, a curve
 * that loops around the side with more room.
 */
function connectorRoute(fromRef: Ref, toRef: Ref, shift: Pt = [0, 0]): { route: Pt[]; side: 1 | -1 } {
  const [from, to] = [fromRef.bbox, toRef.bbox];
  const c1 = center(from);
  const c2 = center(to);
  const p1 = edgePoint(from, c2, 12);
  const p2 = edgePoint(to, c1, 14);
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy) || 1;
  const gap = ((p2[0] - p1[0]) * dx + (p2[1] - p1[1]) * dy) / d;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  if (gap >= 44) {
    const route: Pt[] = [
      [p1[0] + shift[0], p1[1] + shift[1]],
      [p2[0] + shift[0], p2[1] + shift[1]],
    ];
    // Labels go on the outer side of a shifted pair.
    const side = vertical ? (shift[0] < 0 ? -1 : 1) : shift[1] > 0 ? -1 : 1;
    return { route, side };
  }
  // The loop leaves and enters at the drawings themselves (an icon, not the space around it).
  const fa = fromRef.el?.art ?? from;
  const ta = toRef.el?.art ?? to;
  if (vertical) {
    // One above the other: loop around the right or left side.
    const room = BOARD_W - Math.max(from.x + from.w, to.x + to.w) >= Math.min(from.x, to.x) ? 1 : -1;
    const s = shift[0] ? (Math.sign(shift[0]) as 1 | -1) : room;
    const ex = (r: Rect) => (s > 0 ? r.x + r.w + 8 : r.x - 8);
    const a: Pt = [ex(fa), fa.y + fa.h / 2];
    const b: Pt = [ex(ta), ta.y + ta.h / 2];
    const out = (s > 0 ? Math.max(a[0], b[0]) : Math.min(a[0], b[0])) + s * 110;
    return { route: quadPoints(a, [out, (a[1] + b[1]) / 2], b), side: s };
  }
  // Side by side: loop over the top (or underneath, when the title is in the way).
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y + from.h, to.y + to.h);
  const room: 1 | -1 = top - GRID.y >= 60 || top - GRID.y >= BOARD_H - bottom ? -1 : 1;
  const s = shift[1] ? (Math.sign(shift[1]) as 1 | -1) : room;
  // Under a captioned drawing the caption is in the way, so a loop below leaves from the bottom of the whole element.
  const ey = (art: Rect, r: Rect) => (s < 0 ? art.y - 8 : r.y + r.h + 8);
  const a: Pt = [fa.x + fa.w / 2, ey(fa, from)];
  const b: Pt = [ta.x + ta.w / 2, ey(ta, to)];
  const out = (s < 0 ? Math.min(a[1], b[1]) : Math.max(a[1], b[1])) + s * 96;
  return { route: quadPoints(a, [(a[0] + b[0]) / 2, out], b), side: s < 0 ? 1 : -1 };
}

/** A gentle arc between two elements (for things that travel without an arrow). */
function arcBetween(from: Rect, to: Rect): Pt[] {
  const c1 = center(from);
  const c2 = center(to);
  const p1 = edgePoint(from, c2, 6);
  const p2 = edgePoint(to, c1, 6);
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const dist = Math.hypot(dx, dy) || 1;
  // Bow the arc upwards (or to the left when travelling straight up/down).
  let nx = -dy / dist;
  let ny = dx / dist;
  if (ny > 0 || (Math.abs(ny) < 1e-6 && nx > 0)) {
    nx = -nx;
    ny = -ny;
  }
  const bow = Math.min(140, dist * 0.18);
  const cx = (p1[0] + p2[0]) / 2 + nx * bow;
  const cy = (p1[1] + p2[1]) / 2 + ny * bow;
  return Array.from({ length: 25 }, (_, i) => {
    const t = i / 24;
    const u = 1 - t;
    return [u * u * p1[0] + 2 * u * t * cx + t * t * p2[0], u * u * p1[1] + 2 * u * t * cy + t * t * p2[1]] as Pt;
  });
}

const pathLength = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/* ------------------------------------------------------------------ */
/* Scene layout                                                        */
/* ------------------------------------------------------------------ */

export interface LayoutOptions {
  /** Board title, written first. Omit for answer overlays drawn on an existing board. */
  title?: string | null;
  /** Elements already on the board (answer overlays annotate these). */
  base?: BoardElement[];
}

export function layoutScene(actions: Action[], opts: LayoutOptions = {}): SceneLayout {
  const warnings: string[] = [];
  const elements: BoardElement[] = [];
  const occ = new Occupancy();
  const refs = new Map<string, Ref>();
  const labels: [string, string][] = [];

  const register = (e: BoardElement, path?: Pt[]) => {
    refs.set(e.id, { bbox: e.bbox, el: e, path, ids: [e.id] });
    if (e.label) labels.push([e.label.toLowerCase().trim(), e.id]);
  };

  for (const b of opts.base ?? []) {
    register(b, pathOf(b));
    if (b.kind !== "title") occ.markRect(b.bbox);
  }

  if (opts.title) {
    const t = buildTitle(opts.title);
    elements.push(t);
  }

  const seen = new Set<string>(refs.keys());
  const uniq = (id: string) => {
    let out = id || "el";
    let n = 2;
    while (seen.has(out)) out = `${id}_${n++}`;
    seen.add(out);
    return out;
  };
  const acts = actions.map((a) => ({ ...a, id: uniq(a.id) }));

  // Pass 1: things that take space.
  for (const a of acts) {
    if (!isElementKind(a.kind)) continue;
    const cell = placeCell(occ, a.at, a.kind);
    const built = buildElement(a, cellRect(cell), warnings);
    if (!built.length) {
      warnings.push(`nothing to draw for ${a.id}`);
      continue;
    }
    for (const e of built) {
      elements.push(e);
      register(e, pathOf(e));
    }
    if (built.length > 1) {
      const group = union(built.map((e) => e.bbox));
      const chain = built.filter((e) => e.kind.endsWith("-node")).map((e) => center(e.bbox));
      refs.set(a.id, { bbox: group, path: chain.length > 1 ? chain : undefined, ids: built.map((e) => e.id) });
    }
  }

  const resolve = (ref: string | null): Ref | null => {
    if (!ref) return null;
    const raw = ref.trim();
    const norm = raw.replace(/\[(\d+)\]$/, ".$1").replace(/:(\d+)$/, ".$1");
    for (const key of [raw, norm]) {
      const hit = refs.get(key);
      if (hit) return hit;
    }
    const lower = norm.toLowerCase();
    for (const [k, v] of refs) if (k.toLowerCase() === lower) return v;
    const byLabel = labels.find(([l]) => l === lower) ?? (lower.length >= 3 ? labels.find(([l]) => l.includes(lower) || lower.includes(l)) : undefined);
    return byLabel ? refs.get(byLabel[1]) ?? null : null;
  };

  // Connectors joining the same two elements (there and back) run side by side, not on top of each other.
  const pairKey = (x: Ref, y: Ref) => [x.ids.join(","), y.ids.join(",")].sort().join("|");
  const pairCount = new Map<string, number>();
  for (const a of acts) {
    if (!isConnectorKind(a.kind)) continue;
    const [f, t] = [resolve(a.from), resolve(a.to)];
    if (f && t && f !== t) pairCount.set(pairKey(f, t), (pairCount.get(pairKey(f, t)) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();

  // Pass 2: connectors and annotations, which need geometry of their targets.
  for (const a of acts) {
    if (isConnectorKind(a.kind)) {
      const from = resolve(a.from);
      const to = resolve(a.to);
      if (!from || !to) {
        warnings.push(`${a.kind} ${a.id}: unknown ${!from ? `from "${a.from}"` : `to "${a.to}"`}`);
        continue;
      }
      const c1 = center(from.bbox);
      const c2 = center(to.bbox);
      if (Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) < 30) continue;
      const key = pairKey(from, to);
      const n = pairCount.get(key) ?? 1;
      const k = pairSeen.get(key) ?? 0;
      pairSeen.set(key, k + 1);
      let shift: Pt = [0, 0];
      if (n > 1) {
        // Offsets measured across the pair's line in a fixed order, so A→B and B→A land on opposite sides.
        const [u, v] = from.ids.join(",") <= to.ids.join(",") ? [c1, c2] : [c2, c1];
        const len = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1;
        const off = (k - (n - 1) / 2) * 36;
        shift = [(-(v[1] - u[1]) / len) * off, ((v[0] - u[0]) / len) * off];
      }
      const { route, side } = connectorRoute(from, to, shift);
      const isArrow = a.kind === "arrow";
      const e = arrowElement(a.id, a.id, route, colorOf(a.color), a.text?.trim() || null, seedFrom(a.id), { head: isArrow, flow: isArrow, side });
      e.deps = [...from.ids, ...to.ids];
      elements.push(e);
      register(e, route);
    } else if (a.kind === "trace") {
      // Along an arrow or a flow, or straight from one element to another.
      const along = resolve(a.target) ?? (a.from && a.to ? null : resolve(a.to ?? a.from));
      let trail = along?.path ?? (along?.el ? pathOf(along.el) : undefined);
      let deps = along?.ids ?? [];
      if (!trail || trail.length < 2) {
        const from = resolve(a.from);
        const to = resolve(a.to);
        if (from && to && from !== to) {
          trail = arcBetween(from.bbox, to.bbox);
          deps = [...from.ids, ...to.ids];
        }
      }
      if (!trail || trail.length < 2) {
        warnings.push(`trace ${a.id}: nothing to travel along ("${a.target ?? `${a.from} → ${a.to}`}")`);
        continue;
      }
      const e = buildTrace(a, trail);
      e.deps = deps;
      elements.push(e);
    } else if (isMotionKind(a.kind)) {
      // A demonstration: an existing element starts to move.
      const target = resolve(a.target ?? a.from);
      const to = resolve(a.to);
      const needsTo = a.kind === "orbit" || a.kind === "move";
      if (!target || (needsTo && (!to || to === target))) {
        warnings.push(`${a.kind} ${a.id}: unknown ${!target ? `target "${a.target}"` : `"to" element "${a.to}"`}`);
        continue;
      }
      const e = buildMotion(a, target, needsTo ? to : null);
      e.deps = [...target.ids, ...(needsTo && to ? to.ids : [])];
      elements.push(e);
    } else if (isAnnotationKind(a.kind)) {
      const target = resolve(a.target ?? a.to ?? a.from);
      if (!target) {
        warnings.push(`${a.kind} ${a.id}: unknown target "${a.target}"`);
        continue;
      }
      const e = buildAnnotation(a, target, occ, warnings);
      if (e) {
        e.deps = target.ids;
        elements.push(e);
        register(e);
      }
    }
  }

  return { elements, warnings };
}

function pathOf(e: BoardElement): Pt[] | undefined {
  if (e.kind !== "arrow") return undefined;
  const s = e.parts.find((p) => p.type === "stroke" && p.trail);
  return s && s.type === "stroke" ? s.trail : undefined;
}

function textInfo(e?: BoardElement) {
  const t = e?.parts.find((p) => p.type === "text");
  return t && t.type === "text" ? t : null;
}

/** A motion: the element itself draws only an orbit's path; the timeline applies the movement to the targets. */
function buildMotion(a: Action, target: Ref, to: Ref | null): BoardElement {
  const T = target.bbox;
  const type = a.kind as MotionKind;
  const motion: MotionSpec = { type, targets: target.ids };
  const base = { id: a.id, actionId: a.id, kind: a.kind, label: null, clickable: false };
  if (type === "orbit" && to) {
    // A dotted orbit path through the target's current position, then it starts to travel.
    const C = center(to.bbox);
    const P = center(T);
    const ky = Math.abs(P[1] - C[1]) > Math.abs(P[0] - C[0]) * 1.5 ? 0.85 : 0.55;
    const R0 = Math.max(40, Math.hypot(P[0] - C[0], (P[1] - C[1]) / ky));
    // The ring stays on the board, below the title (what rides on it may peek past the edge for a
    // moment); if it has to shrink, the element glides onto it as it starts to travel. It may pass in
    // front of the thing in the middle, but never sits on it.
    const fit = Math.min(C[0] - 10, BOARD_W - 10 - C[0], (C[1] - (GRID.y - 24)) / ky, (BOARD_H - 10 - C[1]) / ky);
    const near = (Math.max(to.bbox.w, to.bbox.h) + Math.max(T.w, T.h)) * 0.3;
    const R = R0 > fit ? Math.min(R0, Math.max(fit, near, 40)) : R0;
    const pts = ellipsePoints(C[0], C[1], R, R * ky, 72);
    let d = "";
    for (let i = 0; i + 1 < pts.length; i += 2) d += `M${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} L${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)} `;
    motion.center = C;
    motion.ky = ky;
    if (Math.abs(R - R0) > 2) motion.radius = Math.round(R);
    const ringColor = a.color ? colorOf(a.color) : INK.ink;
    return el({
      ...base,
      bbox: onBoard(union([{ x: C[0] - R, y: C[1] - R * ky, w: R * 2, h: R * 2 * ky }, T])),
      parts: [{ type: "stroke", d: d.trim(), color: ringColor, width: 2.5, opacity: 0.55, a: 0, b: 1, trail: pts }],
      natural: 1.1,
      motion,
    });
  }
  if (type === "move" && to) motion.toBox = to.bbox;
  if (type === "grow") {
    const f = Number(String(a.expr ?? "").match(/\d+(?:\.\d+)?/)?.[0]);
    motion.factor = Number.isFinite(f) && f > 0 ? clamp(f, 0.3, 2.5) : 1.6;
  }
  return el({ ...base, bbox: to && type === "move" ? union([T, to.bbox]) : T, parts: [], natural: 0.3, motion });
}

/** Annotations that make their target give a little bump as they start. */
const EMPHASIS = new Set(["pulse", "circle_around", "check", "callout"]);

/** A dot (or a small icon or word) that travels along a path, with a fading comet tail. */
function buildTrace(a: Action, trail: Pt[]): BoardElement {
  const color = colorOf(a.color, "orange");
  const iconName = resolveIcon(a.icon);
  const icon = iconName ? iconNodes(iconName) : null;
  const label = !icon && a.text?.trim() ? a.text.trim().slice(0, 16) : null;
  const token = icon || label ? { icon, label, wash: washOf(a.color, "orange") } : undefined;
  return el({
    id: a.id,
    actionId: a.id,
    kind: a.kind,
    label: null,
    clickable: false,
    bbox: onBoard(union(trail.map(([x, y]) => ({ x: x - 20, y: y - 20, w: 40, h: 40 })))),
    parts: [{ type: "dot", trail, color, r: 12, a: 0, b: 1, token }],
    natural: clamp(pathLength(trail) / 420, 1.3, 2.6),
    transient: true,
  });
}

function buildAnnotation(a: Action, target: Ref, occ: Occupancy, warnings: string[]): BoardElement | null {
  const seed = seedFrom(a.id);
  const T = target.bbox;
  const base = { id: a.id, actionId: a.id, kind: a.kind, label: null, clickable: false, targets: EMPHASIS.has(a.kind) ? target.ids : undefined };
  switch (a.kind) {
    case "pulse": {
      // Rings spread out from the target while it bumps: "look here".
      const [cx, cy] = center(T);
      const color = colorOf(a.color, "orange");
      const rx = T.w / 2 + 22;
      const ry = T.h / 2 + 22;
      return el({ ...base, bbox: onBoard({ x: cx - rx * 1.4, y: cy - ry * 1.4, w: rx * 2.8, h: ry * 2.8 }), parts: [{ type: "ripple", cx, cy, rx, ry, color, a: 0, b: 1 }], natural: 1.3, transient: true });
    }
    case "highlight": {
      const t = textInfo(target.el);
      const strokes: Part[] = [];
      if (t) {
        const n = t.lines.length;
        t.lines.forEach((_, i) => {
          const w = t.widths[i];
          const x0 = t.anchor === "middle" ? t.x - w / 2 : t.x;
          const y = t.y + i * t.size * t.lineHeight - t.size * 0.3;
          strokes.push({ type: "stroke", d: `M${x0 - 8} ${y} L${x0 + w + 8} ${y + 2}`, color: MARKER_YELLOW, width: t.size * 0.95, opacity: 0.55, blend: true, a: i / n, b: (i + 1) / n, trail: [[x0 - 8, y], [x0 + w + 8, y]] });
        });
      } else {
        const y = T.y + T.h / 2;
        strokes.push({ type: "stroke", d: `M${T.x - 8} ${y} L${T.x + T.w + 8} ${y + 2}`, color: MARKER_YELLOW, width: Math.min(70, T.h * 0.7), opacity: 0.5, blend: true, a: 0, b: 1, trail: [[T.x, y], [T.x + T.w, y]] });
      }
      return el({ ...base, bbox: T, parts: strokes, natural: 0.5 });
    }
    case "circle_around": {
      const pad = Math.max(14, Math.min(T.w, T.h) * 0.15);
      const w = T.w + pad * 2.2;
      const h = T.h + pad * 2;
      const [cx, cy] = center(T);
      const color = colorOf(a.color, "red");
      const paths = roughEllipse(cx, cy, w, h, seed, { stroke: color, strokeWidth: 3.5, roughness: 1.4 });
      return el({ ...base, bbox: { x: cx - w / 2, y: cy - h / 2, w, h }, parts: strokeParts(paths, color, 3.5, 0, 1, ellipsePoints(cx, cy, w / 2, h / 2)), natural: 0.65 });
    }
    case "underline": {
      const t = textInfo(target.el);
      let x1 = T.x;
      let x2 = T.x + T.w;
      let y = T.y + T.h + 8;
      if (t) {
        const last = t.lines.length - 1;
        const w = t.widths[last];
        x1 = t.anchor === "middle" ? t.x - w / 2 : t.x;
        x2 = x1 + w;
        y = t.y + last * t.size * t.lineHeight + t.size * 0.22;
      }
      const color = colorOf(a.color, "blue");
      const paths = roughLine(x1 - 4, y, x2 + 4, y + 3, seed, { stroke: color, strokeWidth: 4 });
      return el({ ...base, bbox: { x: x1, y: y - 4, w: x2 - x1, h: 8 }, parts: strokeParts(paths, color, 4, 0, 1, [[x1, y], [x2, y]]), natural: 0.45 });
    }
    case "cross_out": {
      const color = colorOf(a.color, "red");
      const r = inset(T, -6);
      return el({
        ...base,
        bbox: r,
        parts: [
          ...strokeParts(roughLine(r.x, r.y, r.x + r.w, r.y + r.h, seed, { stroke: color, strokeWidth: 4.5 }), color, 4.5, 0, 0.5, [[r.x, r.y], [r.x + r.w, r.y + r.h]]),
          ...strokeParts(roughLine(r.x + r.w, r.y, r.x, r.y + r.h, seed + 1, { stroke: color, strokeWidth: 4.5 }), color, 4.5, 0.5, 1, [[r.x + r.w, r.y], [r.x, r.y + r.h]]),
        ],
        natural: 0.6,
      });
    }
    case "check": {
      const color = colorOf(a.color, "green");
      const s = clamp(T.h * 0.9, 40, 80);
      let x0 = T.x + T.w + 16;
      let y0 = T.y + (T.h - s) / 2;
      if (x0 + s > BOARD_W - 20) {
        if (T.x - s - 16 >= 20) {
          x0 = T.x - s - 16; // left of the target, like a tick in the margin
        } else {
          x0 = T.x + T.w - s;
          y0 = T.y - s - 6;
        }
      }
      const pts: Pt[] = [
        [x0, y0 + s * 0.55],
        [x0 + s * 0.38, y0 + s],
        [x0 + s, y0],
      ];
      return el({ ...base, bbox: { x: x0, y: y0, w: s, h: s }, parts: strokeParts(roughLinear(pts, seed, { stroke: color, strokeWidth: 6 }), color, 6, 0, 1, pts), natural: 0.45, pop: true });
    }
    case "callout": {
      const text = (a.text ?? "").trim();
      if (!text) {
        warnings.push(`callout ${a.id} has no text`);
        return null;
      }
      const color = colorOf(a.color, "purple");
      const [tcx, tcy] = center(T);
      const tc = { col: clampInt((tcx - GRID.x) / CELL_W, 0, GRID.cols - 1), row: clampInt((tcy - GRID.y) / CELL_H, 0, GRID.rows - 1) };
      const slot = occ.nearest(3, 1, tc.col + 1, tc.row - 1) ?? occ.nearest(2, 1, tc.col, tc.row);
      let box: Rect;
      if (slot) {
        occ.mark(slot);
        box = inset(cellRect(slot), 8);
      } else {
        box = { x: clamp(T.x, GRID.x, GRID.x + GRID.w - 340), y: Math.max(GRID.y - 10, T.y - 70), w: 340, h: 56 };
      }
      const t = textPart(text, box, color, { max: 40, min: 18, maxLines: 2 });
      const tb = t.bbox;
      const from = edgePoint(tb, [tcx, tcy], 8);
      const to = edgePoint(T, center(tb), 10);
      const arrow = arrowElement(`${a.id}.arrow`, a.id, [from, to], color, null, seed);
      return el({ ...base, label: text, clickable: true, bbox: union([tb, arrow.bbox]), parts: [{ ...t.part, a: 0, b: 0.6 }, ...arrow.parts.map((p) => ({ ...p, a: 0.55 + p.a * 0.45, b: 0.55 + p.b * 0.45 }))], natural: textDur(text) + 0.5 });
    }
    default:
      return null;
  }
}
