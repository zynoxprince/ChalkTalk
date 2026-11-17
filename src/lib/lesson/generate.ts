import { config } from "@/lib/server/env";
import { AIError, generateStructured } from "@/lib/server/openrouter";
import { signNarration } from "@/lib/server/sign";
import { askPrompt, chapterPrompt, outlinePrompt, recapPrompt, SYSTEM_PROMPT, type AskContext } from "./prompts";
import { repairSegments } from "./repair";
import {
  AnswerSchema,
  ChapterSchema,
  OutlineSchema,
  RecapSchema,
  type AnswerMode,
  type Level,
  type Outline,
  type QuizItem,
  type Scene,
} from "./schema";

/** Server-side lesson generation. Used by the API routes and the sample script. */

export async function generateOutline(topic: string, level: Level): Promise<{ outline: Outline; intro: Scene }> {
  const outline = await generateStructured({
    model: config.lessonModel,
    system: SYSTEM_PROMPT,
    user: outlinePrompt(topic, level),
    schema: OutlineSchema,
    name: "lesson_outline",
    maxTokens: 6000,
    reasoning: config.lessonReasoning,
    label: "outline",
  });
  if (outline.refusal) return { outline: { ...outline, chapters: [] }, intro: { id: "intro", kind: "intro", title: outline.title, segments: [] } };
  if (outline.chapters.length < 2) throw new AIError("The lesson plan came back incomplete. Please try again.");
  outline.chapters = outline.chapters.slice(0, 3);
  outline.title = outline.title.trim().slice(0, 70);
  const segments = repairSegments(outline.intro, { sceneId: "intro", sign: signNarration, maxSegments: 3 });
  if (!segments.length) throw new AIError("The lesson intro came back empty. Please try again.");
  return { outline, intro: { id: "intro", kind: "intro", title: outline.title, segments } };
}

export async function generateChapter(topic: string, level: Level, outline: Outline, index: number): Promise<Scene> {
  const plan = outline.chapters[index];
  if (!plan) throw new AIError("Unknown chapter.", 400, false);
  const chapter = await generateStructured({
    model: config.lessonModel,
    system: SYSTEM_PROMPT,
    user: chapterPrompt(topic, level, outline, index),
    schema: ChapterSchema,
    name: "lesson_chapter",
    maxTokens: 9000,
    reasoning: config.lessonReasoning,
    label: `chapter ${index + 1}`,
  });
  const id = `c${index + 1}`;
  const segments = repairSegments(chapter.segments, { sceneId: id, sign: signNarration, maxSegments: 5 });
  if (!segments.length) throw new AIError("A chapter came back empty. Please try again.");
  return { id, kind: "chapter", title: plan.title.trim().slice(0, 60), segments };
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
