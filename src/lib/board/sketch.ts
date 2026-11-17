import { COLORS, type Color } from "@/lib/lesson/schema";

/**
 * The model's own drawings: a few simple shapes in a 0–100 square, one per
 * string, e.g. "circle 50 50 20", "fill blue rect 20 30 60 40",
 * "curve 10 50 30 20 50 50 70 80", "text 50 95 bob" or raw SVG path data.
 * Everything is parsed from numbers into fresh path strings, so nothing the
 * model writes reaches the page as markup.
 */

export type Pt = [number, number];

export interface SketchShape {
  /** Path in board coordinates. */
  d: string;
  /** Points along the shape (board coordinates), for the pen cursor. */
  trail: Pt[];
  fill: "none" | "hatch" | "solid";
  color: Color | null;
  /** Closed shapes can be filled. */
  closed: boolean;
  /** A small label instead of a shape. */
  text?: { x: number; y: number; words: string; size: number };
  /** An arrow head at the end of an open line. */
  head?: [Pt, Pt, Pt];
}

export interface SketchBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const num = (s: string | undefined) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
};

const f = (v: number) => (Math.round(v * 10) / 10).toString();

/** True if any number is missing or not finite (e.g. "circle 1" has no y or radius). */
const bad = (...vs: (number | undefined)[]) => vs.some((v) => v === undefined || !Number.isFinite(v));

/** Maps the model's 0–100 square onto the box (uniform scale, centred). */
function mapper(box: SketchBox) {
  const s = Math.min(box.w, box.h) / 100;
  const ox = box.x + (box.w - 100 * s) / 2;
  const oy = box.y + (box.h - 100 * s) / 2;
  const clampU = (v: number) => Math.max(-10, Math.min(110, v));
  return { s, P: (x: number, y: number): Pt => [ox + clampU(x) * s, oy + clampU(y) * s] };
}

function ellipsePath(c: Pt, rx: number, ry: number): { d: string; trail: Pt[] } {
  const trail: Pt[] = Array.from({ length: 25 }, (_, i) => {
    const t = -Math.PI / 2 + (i / 24) * Math.PI * 2;
    return [c[0] + rx * Math.cos(t), c[1] + ry * Math.sin(t)];
  });
  const d = `M${f(c[0])} ${f(c[1] - ry)} A${f(rx)} ${f(ry)} 0 1 1 ${f(c[0])} ${f(c[1] + ry)} A${f(rx)} ${f(ry)} 0 1 1 ${f(c[0])} ${f(c[1] - ry)} Z`;
  return { d, trail };
}

/** Smooth curve through points (Catmull-Rom as cubic Béziers). */
function smoothPath(pts: Pt[]): string {
  if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"}${f(p[0])} ${f(p[1])}`).join(" ");
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

function pairs(nums: number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

function arrowHead(tip: Pt, from: Pt, size: number): [Pt, Pt, Pt] {
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  return [
    [tip[0] - size * Math.cos(ang - 0.5), tip[1] - size * Math.sin(ang - 0.5)],
    tip,
    [tip[0] - size * Math.cos(ang + 0.5), tip[1] - size * Math.sin(ang + 0.5)],
  ];
}

/* ------------------------------------------------------------------ */
/* Raw SVG path data, converted to absolute commands and transformed   */
/* ------------------------------------------------------------------ */

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function transformPath(raw: string, P: (x: number, y: number) => Pt, s: number): { d: string; trail: Pt[]; closed: boolean } | null {
  const tokens = raw.match(/[MLHVCSQTAZmlhvcsqtaz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g);
  if (!tokens || !/^[Mm]$/.test(tokens[0])) return null;
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  let out = "";
  let closed = false;
  const trail: Pt[] = [];
  const add = (x: number, y: number) => {
    const p = P(x, y);
    trail.push(p);
    return `${f(p[0])} ${f(p[1])}`;
  };
  let guard = 0;
  while (i < tokens.length && guard++ < 400) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) return null;
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const n = ARGS[up];
    if (n === undefined) return null;
    if (up === "Z") {
      out += " Z";
      cx = sx;
      cy = sy;
      closed = true;
      continue;
    }
    const a = tokens.slice(i, i + n).map(Number);
    if (a.length < n || a.some((v) => !Number.isFinite(v))) break;
    i += n;
    const X = (v: number) => (rel ? cx + v : v);
    const Y = (v: number) => (rel ? cy + v : v);
    switch (up) {
      case "M":
        cx = X(a[0]);
        cy = Y(a[1]);
        sx = cx;
        sy = cy;
        out += ` M${add(cx, cy)}`;
        cmd = rel ? "l" : "L"; // further pairs are line-tos
        break;
      case "L":
        cx = X(a[0]);
        cy = Y(a[1]);
        out += ` L${add(cx, cy)}`;
        break;
      case "H":
        cx = rel ? cx + a[0] : a[0];
        out += ` L${add(cx, cy)}`;
        break;
      case "V":
        cy = rel ? cy + a[0] : a[0];
        out += ` L${add(cx, cy)}`;
        break;
      case "C": {
        const p1 = add(X(a[0]), Y(a[1]));
        const p2 = add(X(a[2]), Y(a[3]));
        cx = X(a[4]);
        cy = Y(a[5]);
        out += ` C${p1} ${p2} ${add(cx, cy)}`;
        break;
      }
      case "S":
      case "Q": {
        const p1 = add(X(a[0]), Y(a[1]));
        cx = X(a[2]);
        cy = Y(a[3]);
        out += ` ${up}${p1} ${add(cx, cy)}`;
        break;
      }
      case "T":
        cx = X(a[0]);
        cy = Y(a[1]);
        out += ` T${add(cx, cy)}`;
        break;
      case "A":
        cx = X(a[5]);
        cy = Y(a[6]);
        out += ` A${f(Math.abs(a[0]) * s)} ${f(Math.abs(a[1]) * s)} ${f(a[2])} ${a[3] ? 1 : 0} ${a[4] ? 1 : 0} ${add(cx, cy)}`;
        break;
    }
  }
  return trail.length >= 2 ? { d: out.trim(), trail, closed } : null;
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** Parses one shape; null if it isn't one we understand. */
export function parseShape(item: string, box: SketchBox): SketchShape | null {
  const words = item.trim().replace(/,/g, " ").split(/\s+/);
  let fill: SketchShape["fill"] = "none";
  let color: Color | null = null;
  // Leading modifiers, in any order.
  for (;;) {
    const w = words[0]?.toLowerCase();
    if (w === "fill" || w === "filled" || w === "hatch") fill = "hatch";
    else if (w === "solid") fill = "solid";
    else if (w && (COLORS as readonly string[]).includes(w)) color = w as Color;
    else if (w === "dash" || w === "dashed" || w === "thin") {
      /* accepted, drawn as a normal line */
    } else break;
    words.shift();
  }
  const kind = words.shift()?.toLowerCase();
  if (!kind) return null;
  const { s, P } = mapper(box);
  const n = words.map(num);
  const base = { fill, color };

  switch (kind) {
    case "circle":
    case "ellipse": {
      const [x, y, rx] = n;
      const ry = kind === "ellipse" ? n[3] : rx;
      if (bad(x, y, rx, ry) || rx <= 0 || ry <= 0) return null;
      const { d, trail } = ellipsePath(P(x, y), rx * s, ry * s);
      return { ...base, d, trail, closed: true };
    }
    case "rect":
    case "square": {
      const [x, y, w] = n;
      const h = kind === "square" ? w : n[3];
      if (bad(x, y, w, h) || w <= 0 || h <= 0) return null;
      const pts = [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
      return { ...base, d: `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(" L")} Z`, trail: [...pts, pts[0]], closed: true };
    }
    case "dot": {
      const [x, y] = n;
      if (bad(x, y)) return null;
      const { d, trail } = ellipsePath(P(x, y), 2.2 * s, 2.2 * s);
      return { ...base, fill: "solid", d, trail, closed: true };
    }
    case "line":
    case "arrow":
    case "poly":
    case "polyline":
    case "polygon":
    case "curve": {
      const pts = pairs(n.filter((v) => !Number.isNaN(v))).map(([x, y]) => P(x, y));
      if (pts.length < 2) return null;
      const closed = kind === "polygon";
      const d = kind === "curve" ? smoothPath(pts) : `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(" L")}${closed ? " Z" : ""}`;
      const shape: SketchShape = { ...base, d, trail: closed ? [...pts, pts[0]] : pts, closed };
      if (kind === "arrow") shape.head = arrowHead(pts[pts.length - 1], pts[pts.length - 2], Math.max(10, 7 * s));
      return shape;
    }
    case "arc": {
      const [x, y, r, a0, a1] = n;
      if (bad(x, y, r, a0, a1) || r <= 0) return null;
      const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 10));
      const pts: Pt[] = Array.from({ length: steps + 1 }, (_, i) => {
        const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
        return P(x + r * Math.cos(a), y + r * Math.sin(a));
      });
      return { ...base, d: smoothPath(pts), trail: pts, closed: false };
    }
    case "text":
    case "label": {
      const [x, y] = n;
      const label = words.slice(2).join(" ").slice(0, 24);
      if (bad(x, y) || !label) return null;
      const [px, py] = P(x, y);
      return { ...base, fill: "none", d: "", trail: [[px, py]], closed: false, text: { x: px, y: py, words: label, size: Math.max(22, Math.min(42, 10 * s)) } };
    }
    case "path": {
      const t = transformPath(words.join(" "), P, s);
      return t ? { ...base, ...t } : null;
    }
    default: {
      // Raw path data ("M 10 10 L ...").
      if (/^[Mm]/.test(kind)) {
        const t = transformPath([kind, ...words].join(" "), P, s);
        return t ? { ...base, ...t } : null;
      }
      return null;
    }
  }
}

export function parseSketch(items: string[] | null, box: SketchBox): SketchShape[] {
  return (items ?? [])
    .slice(0, 12)
    .map((it) => parseShape(it, box))
    .filter((s): s is SketchShape => !!s);
}
