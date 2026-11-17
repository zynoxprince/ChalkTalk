import {
  isAnnotationKind,
  isConnectorKind,
  isElementKind,
  type Action,
  type Cell,
  type Color,
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
import { hatchFill, roughCurve, roughEllipse, roughLine, roughLinear, roughRect, seedFrom, type RoughPath } from "./rough";
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
      return [el({ id: a.id, actionId: a.id, kind: a.kind, label: text || name, bbox: r, parts, natural: 1.15 + (text ? textDur(text) * 0.5 : 0) })];
    }
    case "list": {
      const items = (a.items ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      if (!items.length && text) items.push(text);
      if (!items.length) return [];
      const r = inset(rect, 10);
      const indent = 34;
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
          parts: [...strokeParts(bullet, color, 3, 0, 0.12, undefined, { color, a: 0, b: 0.15, origin: [r.x + 10, by] }), part],
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
          out.push(arrowElement(`${a.id}.a${k}`, a.id, p1, p2, color, null, seed + k * 13, k * 2 + 1, n * 2 - 1, true, true));
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
      const valueSize = clamp(r.h * 0.11, 22, 40);
      const labelH = clamp(r.h * 0.17, 34, 64);
      const top = r.y + valueSize * 1.5;
      const base = r.y + r.h - labelH;
      const slot = r.w / n;
      const barW = clamp(slot * 0.62, 26, 170);
      const max = Math.max(...entries.map((e) => e.value));
      const tint = tintOf(a.color, "blue");
      const axis = el({
        id: `${a.id}.axis`,
        actionId: a.id,
        kind: "bars-axis",
        label: null,
        bbox: { x: r.x, y: base - 2, w: r.w, h: 4 },
        parts: strokeParts(roughLine(r.x - 6, base, r.x + r.w + 6, base + 2, seed, { strokeWidth: 3 }), INK.ink, 3, 0, 1, [[r.x - 6, base], [r.x + r.w + 6, base]]),
        natural: 0.4,
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

function arrowElement(id: string, actionId: string, p1: Pt, p2: Pt, color: string, label: string | null, seed: number, seq = 0, seqCount = 1, head = true, flow = false): BoardElement {
  const parts: Part[] = strokeParts(roughLine(p1[0], p1[1], p2[0], p2[1], seed, { stroke: color, strokeWidth: 3 }), color, 3, 0, head ? 0.75 : 1, [p1, p2]);
  if (head) {
    const [h1, h2] = arrowHead(p2, p1, 20);
    parts.push(...strokeParts(roughLinear([h1, p2, h2], seed + 1, { stroke: color, strokeWidth: 3 }), color, 3, 0.75, 1));
  }
  const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  // Beads flow along the shaft once it's drawn (stopping short of the head).
  if (flow && head && len > 60) {
    const k = (len - 18) / len;
    parts.push({ type: "flow", d: polyD([p1, [p1[0] + (p2[0] - p1[0]) * k, p1[1] + (p2[1] - p1[1]) * k]]), color, a: 1, b: 1 });
  }
  let bbox = union([{ x: p1[0], y: p1[1], w: 1, h: 1 }, { x: p2[0], y: p2[1], w: 1, h: 1 }]);
  if (label) {
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    const vertical = Math.abs(p2[0] - p1[0]) < Math.abs(p2[1] - p1[1]);
    const w = Math.max(160, Math.min(320, textWidth(label, 30) + 20));
    const box: Rect = vertical ? { x: mx + 12, y: my - 24, w, h: 48 } : { x: mx - w / 2, y: my - 58, w, h: 46 };
    const t = textPart(label, box, color, { max: 34, min: 18, maxLines: 2, anchor: vertical ? "start" : "middle" });
    parts.push({ ...t.part, a: 0.55, b: 1 });
    bbox = union([bbox, t.bbox]);
  }
  return el({ id, actionId, kind: "arrow", label, bbox, parts, natural: label ? 0.9 : 0.5, seq, seqCount, clickable: !!label, ambient: flow && head && len > 60 });
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
      const p1 = edgePoint(from.bbox, c2, 12);
      const p2 = edgePoint(to.bbox, c1, 14);
      const isArrow = a.kind === "arrow";
      const e = arrowElement(a.id, a.id, p1, p2, colorOf(a.color), a.text?.trim() || null, seedFrom(a.id), 0, 1, isArrow, isArrow);
      e.deps = [...from.ids, ...to.ids];
      elements.push(e);
      register(e, [p1, p2]);
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
      const arrow = arrowElement(`${a.id}.arrow`, a.id, from, to, color, null, seed);
      return el({ ...base, label: text, clickable: true, bbox: union([tb, arrow.bbox]), parts: [{ ...t.part, a: 0, b: 0.6 }, ...arrow.parts.map((p) => ({ ...p, a: 0.55 + p.a * 0.45, b: 0.55 + p.b * 0.45 }))], natural: textDur(text) + 0.5 });
    }
    default:
      return null;
  }
}
