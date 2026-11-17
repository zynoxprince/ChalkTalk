import { generateAnswer } from "@/lib/lesson/generate";
import { handle, rateLimit, readJson, tooMany } from "@/lib/server/http";
import { AskRequest } from "@/lib/server/requests";

export const maxDuration = 60;

/** A learner's question, answered with the lesson and the current board as context. */
export const POST = handle(async (req) => {
  const wait = rateLimit(req, "ask", 40, 60 * 60 * 1000);
  if (wait) return tooMany(wait);
  const { answerId, ...ctx } = await readJson(req, AskRequest);
  const answer = await generateAnswer(ctx, answerId);
  return Response.json(answer, { headers: { "Cache-Control": "no-store" } });
});
