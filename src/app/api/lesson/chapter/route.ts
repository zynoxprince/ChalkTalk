import { generateChapter } from "@/lib/lesson/generate";
import { handle, rateLimit, readJson, tooMany } from "@/lib/server/http";
import { ChapterRequest } from "@/lib/server/requests";

export const maxDuration = 60;

/** Step 2: write one chapter (the client requests all three in parallel). */
export const POST = handle(async (req) => {
  const wait = rateLimit(req, "chapter", 45, 60 * 60 * 1000);
  if (wait) return tooMany(wait);
  const { topic, level, outline, index } = await readJson(req, ChapterRequest);
  const scene = await generateChapter(topic, level, outline, index);
  return Response.json({ scene }, { headers: { "Cache-Control": "no-store" } });
});
