import { findCue } from "@/lib/board/timeline";
import { resolveIcon } from "@/lib/board/icons";
import { parseBars } from "@/lib/board/layout";
import type { Action, GeneratedSegment, Segment } from "./schema";

/**
 * Structured outputs guarantee the JSON *shape*; this guarantees it makes
 * sense: speakable narration, valid ids, required fields per kind, sane
 * lengths, known icons, and cues that actually occur in the narration.
 */

const LIMITS: Record<string, number> = { text: 60, note: 90, box: 40, circle: 36, icon: 30, callout: 40, arrow: 28, line: 28, plot: 30, number: 24, trace: 16 };

export function cleanNarration(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[*_#`>~|]/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const cap = (s: string | null, n: number) => {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const safeId = (s: string, fallback: string) => {
  const t = (s ?? "").trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_\-[\].]/g, "");
  return t || fallback;
};

const safeRef = (s: string | null) => (s ? s.trim().replace(/\s+/g, " ") : null);

function repairAction(a: Action, narration: string, index: number): Action | null {
  const kind = a.kind;
  const out: Action = {
    ...a,
    id: safeId(a.id, `${kind}${index}`),
    text: cap(a.text, LIMITS[kind] ?? 60),
    // Sketch shapes and table rows are longer than list items.
    items: a.items
      ? a.items
          .map((i) => cap(i, kind === "sketch" ? 200 : kind === "compare" ? 90 : 60))
          .filter((i): i is string => !!i)
          .slice(0, kind === "sketch" ? 12 : kind === "timeline" ? 7 : 6)
      : null,
    icon: a.icon ? (resolveIcon(a.icon) ?? a.icon) : null,
    from: safeRef(a.from),
    to: safeRef(a.to),
    target: safeRef(a.target),
    expr: a.expr ? a.expr.slice(0, 80) : null,
    at: a.at ? { col: Math.round(a.at.col), row: Math.round(a.at.row), w: Math.round(a.at.w), h: Math.round(a.at.h) } : null,
  };

  switch (kind) {
    case "text":
    case "note":
    case "box":
    case "circle":
      if (!out.text) return null;
      break;
    case "icon":
      if (!out.icon && !out.text) return null;
      break;
    case "list":
      if (!out.items?.length) out.items = out.text ? [out.text] : null;
      if (!out.items?.length) return null;
      break;
    case "flow":
    case "cycle":
      if (!out.items || out.items.length < 2) return null;
      break;
    case "bars":
      // Bars need numbers; without them it's still a fine list.
      if (!out.items?.length) return null;
      if (parseBars(out.items).length < 2) out.kind = "list";
      break;
    case "number":
      if (!out.text) return null;
      if (!/\d/.test(out.text)) out.kind = "text";
      break;
    case "sketch":
      if (!out.items?.length) {
        if (!out.text) return null;
        out.kind = "box";
      }
      break;
    case "particles":
      break;
    case "timeline":
    case "pie":
      if (!out.items?.length) return null;
      if (out.items.length < 2) out.kind = "list";
      break;
    case "compare":
      if (!out.items?.length) return null;
      if (out.items.filter((i) => i.includes("|")).length < 2) {
        out.kind = "list";
        out.items = out.items.map((i) => i.replace(/\s*\|\s*/g, " — "));
      }
      break;
    case "orbit":
    case "move":
      // Something moves around or over to another element: both are needed.
      if (!out.target) out.target = out.from;
      if (!out.target || !out.to) return null;
      break;
    case "spin":
    case "swing":
    case "vibrate":
    case "grow":
      if (!out.target) out.target = out.from ?? out.to;
      if (!out.target) return null;
      break;
    case "plot":
      if (!out.expr) return null;
      break;
    case "trace":
      // Along something (target), or from one element to another.
      if (!out.target && !(out.from && out.to)) out.target = out.to ?? out.from;
      if (!out.target && !(out.from && out.to)) return null;
      break;
    case "arrow":
    case "line":
      if (!out.from || !out.to) return null;
      break;
    case "callout":
      if (!out.text) return null;
      if (!out.target) return null;
      break;
    default:
      // annotations
      if (!out.target) out.target = out.to ?? out.from;
      if (!out.target) return null;
  }

  // Re-anchor cues that don't appear in the narration.
  if (findCue(narration, out.cue) === null) {
    const candidates = [a.text, ...(a.items ?? []), a.icon].filter(Boolean) as string[];
    const hit = candidates.find((c) => findCue(narration, c) !== null);
    out.cue = hit ?? out.cue ?? "";
  }
  return out;
}

export interface RepairOptions {
  sceneId: string;
  sign: (narration: string) => string;
  maxSegments?: number;
  maxActionsPerSegment?: number;
  /** For streamed chapters: number of segments already emitted for this scene. */
  startIndex?: number;
  /** For streamed chapters: action ids already used in this scene. */
  seen?: Set<string>;
}

export function repairSegments(segs: GeneratedSegment[], opts: RepairOptions): Segment[] {
  const out: Segment[] = [];
  const seen = opts.seen ?? new Set<string>();
  const start = opts.startIndex ?? 0;
  let actionIndex = seen.size;
  for (const seg of segs.slice(0, opts.maxSegments ?? 6)) {
    const narration = cleanNarration(seg.narration ?? "");
    if (narration.length < 3) continue;
    const actions: Action[] = [];
    for (const a of (seg.actions ?? []).slice(0, opts.maxActionsPerSegment ?? 6)) {
      const fixed = repairAction(a, narration, actionIndex++);
      if (!fixed) continue;
      let id = fixed.id;
      let n = 2;
      while (seen.has(id)) id = `${fixed.id}_${n++}`;
      seen.add(id);
      actions.push({ ...fixed, id });
    }
    out.push({ id: `${opts.sceneId}-${start + out.length}`, narration, sig: opts.sign(narration), actions });
  }
  return out;
}
