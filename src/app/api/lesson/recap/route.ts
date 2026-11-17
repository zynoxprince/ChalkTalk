import { generateRecap } from "@/lib/lesson/generate";
import { handle, rateLimit, readJson, tooMany } from "@/lib/server/http";
import { RecapRequest } from "@/lib/server/requests";

export const maxDuration = 60;

/** Step 3: recap + quiz, written from what the chapters actually said. */
export const POST = handle(async (req) => {
  const wait = rateLimit(req, "recap", 20, 60 * 60 * 1000);
  if (wait) return tooMany(wait);
  const { topic, level, outline, taught } = await readJson(req, RecapRequest);
  const result = await generateRecap(topic, level, outline, taught);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
});
