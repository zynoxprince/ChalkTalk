import { generateOutline } from "@/lib/lesson/generate";
import { handle, rateLimit, readJson, tooMany } from "@/lib/server/http";
import { OutlineRequest } from "@/lib/server/requests";

export const maxDuration = 60;

/** Step 1: plan the lesson and write the intro (fast, so playback can start early). */
export const POST = handle(async (req) => {
  const wait = rateLimit(req, "lesson", 12, 60 * 60 * 1000);
  if (wait) return tooMany(wait);
  const { topic, level } = await readJson(req, OutlineRequest);
  const result = await generateOutline(topic, level);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
});
