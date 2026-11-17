import { z } from "zod";
import { LEVELS, OutlineSchema } from "@/lib/lesson/schema";

/** Request bodies accepted by the API, with size limits. */

const topic = z.string().trim().min(2, "Please enter a topic.").max(160, "Please keep the topic under 160 characters.");
const level = z.enum(LEVELS);

/** `waitForHook`: pre-made lessons can afford to wait for the opening line instead of dropping a slow one. */
export const OutlineRequest = z.object({ topic, level, waitForHook: z.boolean().optional() });

export const ChapterRequest = z.object({ topic, level, outline: OutlineSchema, index: z.number().int().min(0).max(2) });

export const RecapRequest = z.object({ topic, level, outline: OutlineSchema, taught: z.array(z.string().max(2000)).max(3) });

export const AskRequest = z.object({
  topic,
  level,
  title: z.string().max(120),
  chapterTitle: z.string().max(120),
  time: z.string().max(12),
  recentNarration: z.string().max(1500),
  board: z.array(z.object({ id: z.string().max(60), kind: z.string().max(30), label: z.string().max(120).nullable() })).max(60),
  pointedAt: z.object({ id: z.string().max(60), label: z.string().max(120).nullable() }).nullable(),
  history: z.array(z.object({ q: z.string().max(400), a: z.string().max(800) })).max(6),
  question: z.string().trim().min(1, "Please type a question.").max(400, "Please keep questions under 400 characters."),
  answerId: z.string().regex(/^[a-z0-9-]{1,40}$/),
});
