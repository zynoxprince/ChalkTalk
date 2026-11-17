import { cleanNarration, repairSegments } from "./repair";
import { OutlineSchema, SegmentSchema, type Outline, type Segment } from "./schema";
import { ArrayItemExtractor } from "./stream-json";

/**
 * Incremental parsers for streamed lesson JSON. They're pure (signing is passed
 * in), so they're unit-tested without any network.
 */

export interface EarlyVoice {
  id: string;
  narration: string;
  sig: string;
}

export interface SegmentHandlers {
  onSegment: (segment: Segment) => void;
  /** A segment's narration is complete (its drawings are still being written): voice it now. */
  onNarration?: (voice: EarlyVoice) => void;
}

/**
 * Pulls `{"segments": [...]}` items out of a JSON stream as each one closes,
 * repairs and signs them, and announces each narration as soon as its text is
 * complete (narration comes before the actions in every segment).
 */
export class SegmentStream {
  private extractor = new ArrayItemExtractor("segments");
  private seen = new Set<string>();
  private announced = -1;
  count = 0;

  constructor(
    private readonly sceneId: string,
    private readonly sign: (narration: string) => string,
    private readonly handlers: SegmentHandlers,
    private readonly max = 5,
  ) {}

  push(chunk: string) {
    for (const raw of this.extractor.push(chunk)) {
      if (this.count >= this.max) return;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = SegmentSchema.safeParse(json);
      if (!parsed.success) continue;
      for (const seg of repairSegments([parsed.data], { sceneId: this.sceneId, sign: this.sign, startIndex: this.count, seen: this.seen })) {
        this.handlers.onSegment(seg);
        this.count++;
      }
    }
    if (this.count < this.max) this.announce();
  }

  private announce() {
    if (!this.handlers.onNarration || this.announced === this.count) return;
    const m = /"narration"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(this.extractor.partial() ?? "");
    if (!m) return;
    let raw: string;
    try {
      raw = JSON.parse(m[1]);
    } catch {
      return;
    }
    const narration = cleanNarration(raw);
    if (narration.length < 3) return;
    this.announced = this.count;
    this.handlers.onNarration({ id: `${this.sceneId}-${this.count}`, narration, sig: this.sign(narration) });
  }
}

/** Tidies a plan: refusals carry no chapters; at most three chapters; a short title. */
export function normalizeOutline(o: Outline): Outline {
  if (o.refusal) return { ...o, chapters: [] };
  return { ...o, title: o.title.trim().slice(0, 70), chapters: o.chapters.slice(0, 3) };
}

/**
 * Parses the combined "plan + chapter 1" stream: the plan is emitted the moment
 * its `chapters` array closes, then chapter 1's segments as they're written.
 */
export class PlanStream {
  private text = "";
  private chapters = new ArrayItemExtractor("chapters");
  outline: Outline | null = null;
  readonly chapterOne: SegmentStream;

  constructor(
    sign: (narration: string) => string,
    private readonly handlers: SegmentHandlers & { onOutline: (outline: Outline) => void },
  ) {
    this.chapterOne = new SegmentStream("c1", sign, handlers);
  }

  push(chunk: string) {
    this.text += chunk;
    if (!this.outline) {
      this.chapters.push(chunk);
      const end = this.chapters.end();
      // Everything before the end of `chapters` is the plan: close the object and parse it.
      if (end > 0) this.emit(this.parse(`${this.text.slice(0, end)}}`));
    }
    this.chapterOne.push(chunk);
  }

  /** At the end of the stream: the plan, if it never closed early (e.g. fields in an unusual order). */
  finish(): Outline | null {
    if (!this.outline) this.emit(this.parse(this.text));
    return this.outline;
  }

  private parse(json: string): Outline | null {
    try {
      const parsed = OutlineSchema.safeParse(JSON.parse(json));
      return parsed.success ? normalizeOutline(parsed.data) : null;
    } catch {
      return null;
    }
  }

  private emit(outline: Outline | null) {
    if (!outline || this.outline) return;
    this.outline = outline;
    this.handlers.onOutline(outline);
  }
}
