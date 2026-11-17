import { config } from "@/lib/server/env";
import { AIError, generateStructured, streamStructured } from "@/lib/server/openrouter";
import { signNarration } from "@/lib/server/sign";
import { askPrompt, chapterPrompt, hookPrompt, outlinePrompt, planPrompt, recapPrompt, SYSTEM_PROMPT, type AskContext } from "./prompts";
import { repairSegments } from "./repair";
import { PlanStream, SegmentStream, type EarlyVoice } from "./segment-stream";
import {
  AnswerSchema,
  ChapterSchema,
  HookSchema,
  OutlineSchema,
  PlanSchema,
  RecapSchema,
  type AnswerMode,
  type Segment,
  type Level,
  type Outline,
  type QuizItem,
  type Scene,
} from "./schema";

/** Server-side lesson generation. Used by the API routes and the sample script. */

const QUESTION_START = /^(how|why|what|when|where|who|which|can|could|does|do|did|is|are|was|were|should|would|will|if)\b/i;

/**
 * The tutor's first words, built from the topic in code so they can be voiced
 * the instant the learner clicks, before any model has answered. Topics that
 * wouldn't read well aloud get a generic line.
 */
export function openerLine(topic: string): string {
  const t = topic.replace(/\s+/g, " ").trim().replace(/[?.!\s]+$/, "");
  let h = 0;
  for (const ch of t) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  const pick = <T,>(xs: T[]) => xs[Math.abs(h) % xs.length];
  const speakable = t.length >= 2 && t.length <= 80 && t.split(" ").length <= 14 && /^[\p{L}\p{N} ,'’()&/-]+$/u.test(t);
  if (!speakable) return pick(["Great topic. Let's work through it together, one step at a time.", "Let's dig into this together, one step at a time."]);
  const T = t.charAt(0).toUpperCase() + t.slice(1);
  if (QUESTION_START.test(t)) return pick([`Great question! ${T}? Let's work it out together.`, `${T}? Let's find out, one step at a time.`, `Good question. ${T}? Let's figure it out together.`]);
  return pick([`${T}! Let's explore it together, one step at a time.`, `${T}. Let's break it down, step by step.`, `${T}: a great one to draw out. Let's dive in.`]);
}

/** The opening segment: voiced immediately while the hook and the plan are being written. */
export function openerSegment(topic: string): Segment {
  const narration = openerLine(topic);
  return { id: "intro-0", narration, sig: signNarration(narration), actions: [] };
}

/** A tiny, fast call: the opening line and a hero drawing, voiced while the plan is written. */
export async function generateHook(topic: string, level: Level): Promise<{ refusal: string | null; segment: Segment | null }> {
  const hook = await generateStructured({
    model: config.lessonModel,
    system: SYSTEM_PROMPT,
    user: hookPrompt(topic, level),
    schema: HookSchema,
    name: "lesson_hook",
    maxTokens: 3000,
    reasoning: config.lessonReasoning,
    label: "hook",
  });
  if (hook.refusal) return { refusal: hook.refusal, segment: null };
  const narration = hook.narration.trim();
  const [segment] = repairSegments(
    [
      {
        narration,
        actions: [
          { id: "hero", kind: "icon", cue: narration.split(/\s+/).slice(0, 3).join(" "), text: hook.caption, items: null, icon: hook.icon, at: { col: 0, row: 1, w: 4, h: 4 }, from: null, to: null, target: null, color: "blue", expr: null },
        ],
      },
    ],
    // intro-0 is the instant opener; the hook is the second line.
    { sceneId: "intro", sign: signNarration, maxSegments: 1, startIndex: 1 },
  );
  return { refusal: null, segment: segment ?? null };
}

/** The lesson plan: title, summary and three chapters. */
export async function generateOutline(topic: string, level: Level): Promise<Outline> {
  const outline = await generateStructured({
    model: config.lessonModel,
    system: SYSTEM_PROMPT,
    user: outlinePrompt(topic, level),
    schema: OutlineSchema,
    name: "lesson_outline",
    maxTokens: 5000,
    reasoning: config.lessonReasoning,
    label: "outline",
  });
  if (outline.refusal) return { ...outline, chapters: [] };
  if (outline.chapters.length < 2) throw new AIError("The lesson plan came back incomplete. Please try again.");
  return { ...outline, title: outline.title.trim().slice(0, 70), chapters: outline.chapters.slice(0, 3) };
}

/** The agenda line is built from the plan in code: no extra model call, always in sync. */
export function agendaSegment(outline: Outline, index = 1): Segment {
  const titles = outline.chapters.map((c) => c.title.trim().replace(/[.!?]+$/, ""));
  const spoken =
    titles.length === 3
      ? `Here's our plan. First, ${titles[0]}. Then, ${titles[1]}. And finally, ${titles[2]}.`
      : `Here's our plan: ${titles.join(", then ")}.`;
  const [segment] = repairSegments(
    [
      {
        narration: spoken,
        actions: [
          // A roadmap: three numbered stops along a line.
          { id: "agenda", kind: "timeline", cue: "Here's our plan", text: null, items: titles.map((t, i) => `${i + 1}: ${t}`), icon: null, at: { col: 5, row: 1, w: 7, h: 4 }, from: null, to: null, target: null, color: "blue", expr: null },
        ],
      },
    ],
    { sceneId: "intro", sign: signNarration, maxSegments: 1, startIndex: index, seen: new Set(["hero"]) },
  );
  return segment;
}

/**
 * Streams a chapter: each narration segment is validated, repaired, signed and
 * handed to `onSegment` as soon as the model finishes writing it, so the first
 * lines can be voiced while the rest of the chapter is still being generated.
 */
export async function streamChapter(
  topic: string,
  level: Level,
  outline: Outline,
  index: number,
  onSegment: (segment: Segment) => void,
  /** Called as soon as a segment's narration is complete, before its drawings are: voicing can start early. */
  onNarration?: (voice: EarlyVoice) => void,
): Promise<{ id: string; title: string; count: number }> {
  const plan = outline.chapters[index];
  if (!plan) throw new AIError("Unknown chapter.", 400, false);
  const id = `c${index + 1}`;
  let count = 0;
  for (let attempt = 1; attempt <= 2 && count === 0; attempt++) {
    const stream = new SegmentStream(id, signNarration, { onSegment, onNarration });
    try {
      await streamStructured(
        {
          model: config.lessonModel,
          system: SYSTEM_PROMPT,
          user: chapterPrompt(topic, level, outline, index),
          schema: ChapterSchema,
          name: "lesson_chapter",
          maxTokens: 9000,
          reasoning: config.lessonReasoning,
          label: `chapter ${index + 1}`,
        },
        (chunk) => stream.push(chunk),
      );
    } catch (e) {
      // Keep what already streamed; only retry if nothing usable arrived.
      if (stream.count > 0) {
        count = stream.count;
        break;
      }
      if (attempt === 2 || (e instanceof AIError && !e.retryable)) throw e;
    }
    count = stream.count;
  }
  if (count === 0) throw new AIError("A chapter came back empty. Please try again.");
  return { id, title: plan.title.trim().slice(0, 60), count };
}

/**
 * The plan and chapter 1 in one streamed call. `onOutline` fires the moment the
 * plan is complete (so chapters 2 and 3 can start), then chapter 1's segments
 * stream in as they're written. Returns how many chapter-1 segments arrived:
 * if none did, the caller asks for chapter 1 separately.
 */
export async function streamPlan(
  topic: string,
  level: Level,
  handlers: { onOutline: (outline: Outline) => void; onSegment: (segment: Segment) => void; onNarration?: (voice: EarlyVoice) => void },
): Promise<{ outline: Outline; chapterOne: number }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const parser = new PlanStream(signNarration, handlers);
    try {
      await streamStructured(
        {
          model: config.lessonModel,
          system: SYSTEM_PROMPT,
          user: planPrompt(topic, level),
          schema: PlanSchema,
          name: "lesson_plan",
          maxTokens: 12000,
          reasoning: config.lessonReasoning,
          label: "plan",
        },
        (chunk) => parser.push(chunk),
      );
    } catch (e) {
      lastError = e;
      // Once the plan is out, keep going with whatever chapter 1 managed.
      if (parser.outline) return { outline: parser.outline, chapterOne: parser.chapterOne.count };
      if (e instanceof AIError && !e.retryable) throw e;
      continue;
    }
    const outline = parser.finish();
    if (outline && (outline.refusal || outline.chapters.length >= 2)) return { outline, chapterOne: parser.chapterOne.count };
    lastError = new AIError("The lesson plan came back incomplete. Please try again.");
  }
  throw lastError instanceof Error ? lastError : new AIError("The lesson plan could not be written. Please try again.");
}

export async function generateRecap(
  topic: string,
  level: Level,
  outline: Outline,
  taught: string[],
): Promise<{ scene: Scene; quiz: QuizItem[]; suggestions: string[] }> {
  const recap = await generateStructured({
    model: config.lessonModel,
    system: SYSTEM_PROMPT,
    user: recapPrompt(topic, level, outline, taught),
    schema: RecapSchema,
    name: "lesson_recap",
    maxTokens: 6000,
    reasoning: config.lessonReasoning,
    label: "recap",
  });
  const segments = repairSegments(recap.segments, { sceneId: "recap", sign: signNarration, maxSegments: 3 });
  const quiz = recap.quiz
    .filter((q) => q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length)
    .slice(0, 3)
    .map((q) => ({ ...q, options: q.options.slice(0, 4), chapter: Math.min(3, Math.max(1, Math.round(q.chapter))) }));
  return {
    scene: { id: "recap", kind: "recap", title: "Recap", segments },
    quiz,
    suggestions: recap.suggestions.map((s) => s.trim()).filter(Boolean).slice(0, 3),
  };
}

export interface Answer {
  reply: string;
  mode: AnswerMode;
  confidence: "high" | "medium" | "low";
  scene: Scene | null;
  newLessonTopic: string | null;
}

export async function generateAnswer(ctx: AskContext, answerId: string): Promise<Answer> {
  const ans = await generateStructured({
    model: config.tutorModel,
    system: SYSTEM_PROMPT,
    user: askPrompt(ctx),
    schema: AnswerSchema,
    name: "tutor_answer",
    maxTokens: 6000,
    reasoning: config.tutorReasoning,
    label: "answer",
  });
  const segments = ans.mode === "chat_only" ? [] : repairSegments(ans.segments, { sceneId: answerId, sign: signNarration, maxSegments: 3 });
  // A spoken answer even in chat-only mode: voice the reply itself.
  const spoken = segments.length ? segments : repairSegments([{ narration: ans.reply, actions: [] }], { sceneId: answerId, sign: signNarration, maxSegments: 1 });
  return {
    reply: ans.reply.trim(),
    mode: segments.length ? ans.mode : "chat_only",
    confidence: ans.confidence,
    scene: { id: answerId, kind: "answer", title: ans.mode === "new_board" ? ctx.question.slice(0, 60) : ctx.chapterTitle, segments: spoken },
    newLessonTopic: ans.new_lesson_topic?.trim() || null,
  };
}
