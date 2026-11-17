/**
 * Text measurement for the handwriting font without a DOM, so layout is
 * deterministic and unit-testable. Widths are Caveat (600) advance widths in
 * em, measured in a browser, plus a small safety margin.
 */

const W: Record<string, number> = {
  a: 0.443, b: 0.441, c: 0.361, d: 0.399, e: 0.331, f: 0.297, g: 0.361, h: 0.47, i: 0.193, j: 0.21, k: 0.371,
  l: 0.175, m: 0.566, n: 0.456, o: 0.359, p: 0.378, q: 0.377, r: 0.36, s: 0.347, t: 0.331, u: 0.37, v: 0.331,
  w: 0.517, x: 0.343, y: 0.341, z: 0.315,
  A: 0.508, B: 0.522, C: 0.475, D: 0.584, E: 0.532, F: 0.462, G: 0.492, H: 0.57, I: 0.406, J: 0.312, K: 0.505,
  L: 0.426, M: 0.726, N: 0.612, O: 0.502, P: 0.467, Q: 0.495, R: 0.542, S: 0.492, T: 0.458, U: 0.482, V: 0.49,
  W: 0.72, X: 0.524, Y: 0.504, Z: 0.522,
  " ": 0.242, ".": 0.198, ",": 0.198, ";": 0.198, ":": 0.198, "'": 0.117, "!": 0.21, "?": 0.374, "(": 0.33,
  ")": 0.33, "-": 0.326, "+": 0.446, "=": 0.446, "/": 0.33, "×": 0.446, "²": 0.32, "³": 0.32, "₂": 0.3,
  "→": 1, "%": 0.6, "&": 0.564,
};
const SAFETY = 1.06;

export function charWidthEm(ch: string): number {
  const known = W[ch];
  if (known !== undefined) return known * SAFETY;
  if (ch >= "0" && ch <= "9") return 0.45 * SAFETY;
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x2e80) return 1.0; // CJK and other wide scripts (fallback font)
  if (code >= 0x0900 && code < 0x0e00) return 0.62; // Indic scripts (fallback font)
  if (code > 0x2000) return 0.6; // arrows, symbols, sub/superscripts
  return 0.45 * SAFETY; // accented Latin etc.
}

export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += charWidthEm(ch);
  return w * size;
}

/** Greedy word wrap. Very long words are kept whole (they shrink the font instead). */
export function wrap(text: string, maxWidth: number, size: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || textWidth(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export interface FittedText {
  size: number;
  lines: string[];
  lineHeight: number;
  /** Widest line in px. */
  width: number;
  /** Total block height in px. */
  height: number;
}

/** Largest font size (within bounds) at which `text` fits the box. */
export function fitText(
  text: string,
  maxWidth: number,
  maxHeight: number,
  opts: { max?: number; min?: number; maxLines?: number; lineHeight?: number } = {},
): FittedText {
  const max = opts.max ?? 56;
  const min = opts.min ?? 20;
  const maxLines = opts.maxLines ?? 3;
  const lh = opts.lineHeight ?? 1.1;
  for (let size = max; size >= min; size -= 2) {
    const lines = wrap(text, maxWidth, size);
    const width = Math.max(...lines.map((l) => textWidth(l, size)));
    const height = lines.length * size * lh;
    if (lines.length <= maxLines && width <= maxWidth && height <= maxHeight) {
      return { size, lines, lineHeight: lh, width, height };
    }
  }
  // Fallback: smallest size, clipped to maxLines with an ellipsis.
  let lines = wrap(text, maxWidth, min);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  }
  const width = Math.min(maxWidth, Math.max(...lines.map((l) => textWidth(l, min))));
  return { size: min, lines, lineHeight: lh, width, height: lines.length * min * lh };
}
