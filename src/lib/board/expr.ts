/**
 * A tiny, safe math-expression parser for plots (no eval). Supports numbers,
 * the variable x, + - * / ^, unary minus, parentheses, implicit multiplication
 * ("2x", "3(x+1)"), constants pi and e, and common functions.
 */

type Fn = (x: number) => number;

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  log: Math.log10,
  ln: Math.log,
  floor: Math.floor,
  round: Math.round,
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const s = src.replace(/\s+/g, "").replace(/\*\*/g, "^").replace(/π/g, "pi").replace(/·|×/g, "*").replace(/−/g, "-");
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out.push({ t: "num", v: parseFloat(s.slice(i, j)) });
      i = j;
    } else if (/[a-z]/i.test(c)) {
      let j = i;
      while (j < s.length && /[a-z]/i.test(s[j])) j++;
      const word = s.slice(i, j).toLowerCase();
      // Split runs like "xsin" or "2pix" into known pieces.
      let k = 0;
      while (k < word.length) {
        const match = [...Object.keys(FUNCS), ...Object.keys(CONSTS), "x"]
          .sort((a, b) => b.length - a.length)
          .find((name) => word.startsWith(name, k));
        if (!match) throw new Error(`Unknown name in "${word}"`);
        out.push({ t: "id", v: match });
        k += match.length;
      }
      i = j;
    } else if ("+-*/^()".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else {
      throw new Error(`Unexpected character "${c}"`);
    }
  }
  // Insert implicit multiplication: 2x, 2(…), x(…), )(, )x, x x
  const withMul: Token[] = [];
  for (let n = 0; n < out.length; n++) {
    const a = withMul[withMul.length - 1];
    const b = out[n];
    const aEnds = a && (a.t === "num" || (a.t === "id" && !FUNCS[a.v]) || (a.t === "op" && a.v === ")"));
    const bStarts = b.t === "num" || b.t === "id" || (b.t === "op" && b.v === "(");
    if (aEnds && bStarts) withMul.push({ t: "op", v: "*" });
    withMul.push(b);
  }
  return withMul;
}

export function compileExpr(src: string): Fn {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (v?: string) => {
    const tok = tokens[pos];
    if (!tok || (v !== undefined && !(tok.t === "op" && tok.v === v))) {
      throw new Error(`Expected ${v ?? "token"}`);
    }
    pos++;
    return tok;
  };

  // Grammar: expr = term (("+"|"-") term)*; term = unary (("*"|"/") unary)*;
  // unary = "-" unary | power; power = atom ("^" unary)?; atom = num | x | const | fn "(" expr ")" | "(" expr ")"
  function expr(): Fn {
    let left = term();
    for (;;) {
      const tok = peek();
      if (tok?.t === "op" && (tok.v === "+" || tok.v === "-")) {
        pos++;
        const right = term();
        const l = left;
        left = tok.v === "+" ? (x) => l(x) + right(x) : (x) => l(x) - right(x);
      } else return left;
    }
  }
  function term(): Fn {
    let left = unary();
    for (;;) {
      const tok = peek();
      if (tok?.t === "op" && (tok.v === "*" || tok.v === "/")) {
        pos++;
        const right = unary();
        const l = left;
        left = tok.v === "*" ? (x) => l(x) * right(x) : (x) => l(x) / right(x);
      } else return left;
    }
  }
  function unary(): Fn {
    const tok = peek();
    if (tok?.t === "op" && tok.v === "-") {
      pos++;
      const inner = unary();
      return (x) => -inner(x);
    }
    if (tok?.t === "op" && tok.v === "+") {
      pos++;
      return unary();
    }
    return power();
  }
  function power(): Fn {
    const base = atom();
    const tok = peek();
    if (tok?.t === "op" && tok.v === "^") {
      pos++;
      const exp = unary();
      return (x) => Math.pow(base(x), exp(x));
    }
    return base;
  }
  function atom(): Fn {
    const tok = eat();
    if (tok.t === "num") {
      const v = tok.v;
      return () => v;
    }
    if (tok.t === "id") {
      if (tok.v === "x") return (x) => x;
      if (tok.v in CONSTS) {
        const v = CONSTS[tok.v];
        return () => v;
      }
      const fn = FUNCS[tok.v];
      eat("(");
      const arg = expr();
      eat(")");
      return (x) => fn(arg(x));
    }
    if (tok.v === "(") {
      const inner = expr();
      eat(")");
      return inner;
    }
    throw new Error(`Unexpected "${tok.v}"`);
  }

  const fn = expr();
  if (pos !== tokens.length) throw new Error("Unexpected trailing input");
  return fn;
}

/** Parses "x^2", "y = sin(x)", or "x^2; -3..3" into a function and x-range. */
export function parsePlot(src: string): { fn: Fn; xMin: number; xMax: number } | null {
  try {
    const [exprPart, rangePart] = src.split(";");
    const cleaned = exprPart.replace(/^\s*(y|f\(x\))\s*=\s*/i, "");
    const fn = compileExpr(cleaned);
    let xMin = -5;
    let xMax = 5;
    if (rangePart) {
      const m = rangePart.match(/(-?[\d.]+)\s*(?:\.\.|to|,)\s*(-?[\d.]+)/);
      if (m) {
        const a = parseFloat(m[1]);
        const b = parseFloat(m[2]);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
          xMin = a;
          xMax = b;
        }
      }
    }
    // Reject expressions that never produce a finite value.
    const probe = [xMin, (xMin + xMax) / 2, xMax, xMin + (xMax - xMin) * 0.37];
    if (!probe.some((x) => Number.isFinite(fn(x)))) return null;
    return { fn, xMin, xMax };
  } catch {
    return null;
  }
}
