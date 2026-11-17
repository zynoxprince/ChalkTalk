import { config } from "@/lib/server/env";
import { AIError, generateStructured, streamStructured } from "@/lib/server/openrouter";
import { signNarration } from "@/lib/server/sign";
import { askPrompt, chapterPrompt, hookPrompt, outlinePrompt, recapPrompt, SYSTEM_PROMPT, type AskContext } from "./prompts";
import { repairSegments } from "./repair";
import { ArrayItemExtractor } from "./stream-json";
import {
  AnswerSchema,
  ChapterSchema,
  HookSchema,
  OutlineSchema,
  RecapSchema,
  SegmentSchema,
  type AnswerMode,
  type Segment,
  type Level,
  type Outline,
  type QuizItem,
  type Scene,
} from "./schema";

/** Server-side lesson generation. Used by the API routes and the sample script. */

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
    { sceneId: "intro", sign: signNarration, maxSegments: 1 },
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
          { id: "agenda", kind: "list", cue: "Here's our plan", text: null, items: titles, icon: null, at: { col: 5, row: 1, w: 7, h: 4 }, from: null, to: null, target: null, color: "blue", expr: null },
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
): Promise<{ id: string; title: string; count: number }> {
  const plan = outline.chapters[index];
  if (!plan) throw new AIError("Unknown chapter.", 400, false);
  const id = `c${index + 1}`;
  const seen = new Set<string>();
  let count = 0;
  for (let attempt = 1; attempt <= 2 && count === 0; attempt++) {
    const extractor = new ArrayItemExtractor("segments");
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
        (chunk) => {
          for (const raw of extractor.push(chunk)) {
            if (count >= 5) return;
            let json: unknown;
            try {
              json = JSON.parse(raw);
            } catch {
              continue;
            }
            const parsed = SegmentSchema.safeParse(json);
            if (!parsed.success) continue;
            for (const seg of repairSegments([parsed.data], { sceneId: id, sign: signNarration, startIndex: count, seen })) {
              onSegment(seg);
              count++;
            }
          }
        },
      );
    } catch (e) {
      // Keep what already streamed; only retry if nothing usable arrived.
      if (count > 0) break;
      if (attempt === 2 || (e instanceof AIError && !e.retryable)) throw e;
    }
  }
  if (count === 0) throw new AIError("A chapter came back empty. Please try again.");
  return { id, title: plan.title.trim().slice(0, 60), count };
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
