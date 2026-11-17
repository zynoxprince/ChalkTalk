import { agendaSegment, generateHook, generateOutline } from "@/lib/lesson/generate";
import { AIError } from "@/lib/server/openrouter";
import { handle, rateLimit, readJson, tooMany } from "@/lib/server/http";
import { OutlineRequest } from "@/lib/server/requests";

export const maxDuration = 60;

/**
 * Step 1, two model calls in parallel, streamed as NDJSON:
 *   {"hook": segment}            — the opening line, voiced right away
 *   {"outline": …, "agenda": …}  — the plan, and an agenda line built from it
 *   {"done": true}  or  {"refusal": "…"}  or  {"error": "…"}
 */
export const POST = handle(async (req) => {
  const wait = rateLimit(req, "lesson", 12, 60 * 60 * 1000);
  if (wait) return tooMany(wait);
  const { topic, level } = await readJson(req, OutlineRequest);

  const hookP = generateHook(topic, level).catch((e) => {
    console.warn("[hook] failed:", e instanceof Error ? e.message : e);
    return null;
  });
  const outlineP = generateOutline(topic, level);
  outlineP.catch(() => {}); // handled below; avoid an unhandled rejection while the hook streams

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        const hook = await hookP;
        if (hook?.refusal) {
          send({ refusal: hook.refusal });
          return;
        }
        if (hook?.segment) send({ hook: hook.segment });
        const outline = await outlineP;
        if (outline.refusal) {
          send({ refusal: outline.refusal });
          return;
        }
        send({ outline, agenda: agendaSegment(outline, hook?.segment ? 1 : 0) });
        send({ done: true });
      } catch (e) {
        console.warn("[outline] failed:", e instanceof Error ? e.message : e);
        send({ error: e instanceof AIError ? e.message : "The lesson plan could not be written. Please try again." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
});
