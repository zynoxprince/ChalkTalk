/**
 * Easing and small animation helpers shared by the timeline (pure frames) and
 * the renderer. Everything here is a pure function of progress or time, so
 * seeking always lands on exactly the same picture.
 */

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;

export const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

/** Overshoots a little past 1 before settling: things "pop" into place. */
export const easeOutBack = (x: number) => {
  const c1 = 1.5;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

/** Drawing progress: the hand speeds up and slows down, but never stalls. */
export const drawEase = (x: number) => 0.35 * x + 0.65 * easeInOutCubic(x);

/** Scale for an element popping in during the first `span` of its drawing (0.55 → ~1.05 → 1). */
export const popScale = (p: number, span = 0.3) => (p >= span ? 1 : 0.55 + 0.45 * easeOutBack(clamp01(p / span)));

/** Brief bump when the narration points at something: 1 → 1 + amount → 1. */
export const bumpScale = (phase: number, amount = 0.07) => (phase <= 0 || phase >= 1 ? 1 : 1 + amount * Math.sin(Math.PI * phase));

export interface NumberParts {
  prefix: string;
  value: number;
  decimals: number;
  grouped: boolean;
  suffix: string;
}

/** Splits "$133.10", "93 million km", "70%" or "1,000" into prefix, number and suffix. */
export function parseNumber(text: string): NumberParts | null {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
  if (!m) return null;
  const token = m[0];
  const value = Number(token.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const decimals = token.includes(".") ? token.split(".")[1].length : 0;
  return { prefix: text.slice(0, m.index), value, decimals, grouped: token.includes(","), suffix: text.slice(m.index + token.length) };
}

/** A year ("1914") or an ID shouldn't count up from zero; quantities should. */
export function countsUp(text: string, n: NumberParts | null): n is NumberParts {
  if (!n) return false;
  const bare = `${n.prefix}${n.suffix}`.trim();
  const looksLikeYear = n.decimals === 0 && !n.grouped && n.value >= 1000 && n.value <= 2100 && /^(in|year|AD|BC|BCE|CE)?$/i.test(bare);
  return !looksLikeYear;
}

export function formatNumber(n: NumberParts, value: number): string {
  const [whole, frac] = Math.abs(value).toFixed(n.decimals).split(".");
  const int = n.grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  return `${n.prefix}${value < 0 ? "-" : ""}${int}${frac ? `.${frac}` : ""}${n.suffix}`;
}
