import { streamChapter } from "@/lib/lesson/generate";
import { AIError } from "@/lib/server/openrouter";
import { handle, rateLimit, readJson, tooMany } from "@/lib/server/http";
import { ChapterRequest } from "@/lib/server/requests";

export const maxDuration = 60;

/**
 * Step 2: write one chapter (the client requests all three in parallel).
 * Streams NDJSON — one `{"segment": …}` line per narration segment as soon as
 * it's written, then `{"done": true}` — so playback can start early.
 */
export const POST = handle(async (req) => {
  const wait = rateLimit(req, "chapter", 45, 60 * 60 * 1000);
  if (wait) return tooMany(wait);
  const { topic, level, outline, index } = await readJson(req, ChapterRequest);

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        const result = await streamChapter(topic, level, outline, index, (segment) => send({ segment }));
        send({ done: true, title: result.title, count: result.count });
      } catch (e) {
        console.warn(`[chapter ${index + 1}] failed:`, e instanceof Error ? e.message : e);
        send({ error: e instanceof AIError ? e.message : "This chapter could not be written." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
});
