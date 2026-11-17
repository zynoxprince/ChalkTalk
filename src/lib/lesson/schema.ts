import { z } from "zod";

/**
 * The lesson format ("board script") shared by the AI and the renderer.
 *
 * The model decides WHAT to draw and WHEN (a cue phrase from the narration).
 * Code decides WHERE and HOW (layout engine + renderer). Every object is flat
 * and every field is present (nullable instead of optional) so the same schema
 * works with strict structured outputs across providers.
 */

export const COLORS = ["ink", "blue", "green", "red", "orange", "purple"] as const;
export type Color = (typeof COLORS)[number];

/** Things that occupy space on the board. */
export const ELEMENT_KINDS = [
  "text",
  "note",
  "box",
  "circle",
  "icon",
  "list",
  "flow",
  "cycle",
  "plot",
  "bars",
  "number",
] as const;

/** Things that connect two elements. */
export const CONNECTOR_KINDS = ["arrow", "line"] as const;

/** Things drawn on top of an existing element. */
export const ANNOTATION_KINDS = [
  "highlight",
  "circle_around",
  "underline",
  "cross_out",
  "check",
  "callout",
  "trace",
  "pulse",
] as const;

export const ACTION_KINDS = [
  ...ELEMENT_KINDS,
  ...CONNECTOR_KINDS,
  ...ANNOTATION_KINDS,
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type ElementKind = (typeof ELEMENT_KINDS)[number];
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export const isElementKind = (k: string): k is ElementKind =>
  (ELEMENT_KINDS as readonly string[]).includes(k);
export const isConnectorKind = (k: string): k is ConnectorKind =>
  (CONNECTOR_KINDS as readonly string[]).includes(k);
export const isAnnotationKind = (k: string): k is AnnotationKind =>
  (ANNOTATION_KINDS as readonly string[]).includes(k);

export const LEVELS = ["beginner", "intermediate", "advanced"] as const;
export type Level = (typeof LEVELS)[number];

export const CellSchema = z.object({
  col: z.number(),
  row: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Cell = z.infer<typeof CellSchema>;

export const ActionSchema = z.object({
  id: z.string(),
  kind: z.enum(ACTION_KINDS),
  cue: z.string(),
  text: z.string().nullable(),
  items: z.array(z.string()).nullable(),
  icon: z.string().nullable(),
  at: CellSchema.nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  target: z.string().nullable(),
  color: z.enum(COLORS).nullable(),
  expr: z.string().nullable(),
});
export type Action = z.infer<typeof ActionSchema>;

export const SegmentSchema = z.object({
  narration: z.string(),
  actions: z.array(ActionSchema),
});
export type GeneratedSegment = z.infer<typeof SegmentSchema>;

export const ChapterPlanSchema = z.object({
  title: z.string(),
  goal: z.string(),
  visual_idea: z.string(),
  misconception: z.string().nullable(),
});
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>;

/** The opening line, written by a tiny fast call so the lesson can start talking early. */
export const HookSchema = z.object({
  refusal: z.string().nullable(),
  narration: z.string(),
  icon: z.string(),
  caption: z.string(),
});
export type Hook = z.infer<typeof HookSchema>;

/** The lesson plan (written in parallel with the hook). */
export const OutlineSchema = z.object({
  refusal: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  scope_note: z.string().nullable(),
  clarify: z
    .object({ question: z.string(), options: z.array(z.string()) })
    .nullable(),
  chapters: z.array(ChapterPlanSchema),
});
export type Outline = z.infer<typeof OutlineSchema>;

export const ChapterSchema = z.object({
  segments: z.array(SegmentSchema),
});
export type GeneratedChapter = z.infer<typeof ChapterSchema>;

export const QuizItemSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  answer: z.number(),
  explanation: z.string(),
  chapter: z.number(),
});
export type QuizItem = z.infer<typeof QuizItemSchema>;

export const RecapSchema = z.object({
  segments: z.array(SegmentSchema),
  quiz: z.array(QuizItemSchema),
  suggestions: z.array(z.string()),
});
export type GeneratedRecap = z.infer<typeof RecapSchema>;

export const ANSWER_MODES = ["annotate", "new_board", "chat_only"] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];

export const AnswerSchema = z.object({
  reply: z.string(),
  mode: z.enum(ANSWER_MODES),
  confidence: z.enum(["high", "medium", "low"]),
  segments: z.array(SegmentSchema),
  new_lesson_topic: z.string().nullable(),
});
export type GeneratedAnswer = z.infer<typeof AnswerSchema>;

/* ------------------------------------------------------------------ */
/* App-side types (after repair + signing)                             */
/* ------------------------------------------------------------------ */

/** A narration segment ready for playback: has an id and a signature that
 *  authorises the speech endpoint to voice exactly this text. */
export interface Segment {
  id: string;
  narration: string;
  sig: string;
  actions: Action[];
}

export type SceneKind = "intro" | "chapter" | "recap" | "answer";

export interface Scene {
  id: string;
  kind: SceneKind;
  title: string;
  segments: Segment[];
}

/* ------------------------------------------------------------------ */
/* JSON Schema for structured outputs                                  */
/* ------------------------------------------------------------------ */

type JsonSchema = Record<string, unknown>;

/**
 * Converts a zod schema into a strict JSON Schema: every property required,
 * no additional properties, and nullable values expressed as type unions
 * (`["string", "null"]`), which providers translate most reliably.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as JsonSchema;
  delete raw.$schema;
  return strictify(raw);
}

function strictify(node: unknown): JsonSchema {
  if (Array.isArray(node)) return node.map(strictify) as unknown as JsonSchema;
  if (!node || typeof node !== "object") return node as JsonSchema;
  const n = { ...(node as JsonSchema) };

  const anyOf = n.anyOf as JsonSchema[] | undefined;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nonNull = anyOf.find((s) => s.type !== "null");
    const hasNull = anyOf.some((s) => s.type === "null");
    if (nonNull && hasNull && typeof nonNull.type === "string") {
      const merged: JsonSchema = { ...strictify(nonNull), type: [nonNull.type, "null"] };
      if (Array.isArray(nonNull.enum)) merged.enum = [...(nonNull.enum as unknown[]), null];
      delete n.anyOf;
      return { ...n, ...merged };
    }
  }

  for (const key of Object.keys(n)) {
    const v = n[key];
    if (key === "properties" && v && typeof v === "object") {
      const props: JsonSchema = {};
      for (const [k, s] of Object.entries(v as JsonSchema)) props[k] = strictify(s);
      n.properties = props;
    } else if (v && typeof v === "object") {
      n[key] = strictify(v);
    }
  }
  const isObject = n.type === "object" || (Array.isArray(n.type) && n.type.includes("object"));
  if (isObject && n.properties) {
    n.required = Object.keys(n.properties as JsonSchema);
    n.additionalProperties = false;
  }
  // Keyword support varies by provider; length limits live in prompts + repair.
  delete n.minItems;
  delete n.maxItems;
  delete n.minLength;
  delete n.maxLength;
  delete n.pattern;
  delete n.format;
  delete n.default;
  return n;
}
