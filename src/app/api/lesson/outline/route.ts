import { agendaSegment, generateHook, generateOutline } from "@/lib/lesson/generate";
import type { Segment } from "@/lib/lesson/schema";
import { AIError } from "@/lib/server/openrouter";
import { handle, rateLimit, readJson, tooMany } from "@/lib/server/http";
import { OutlineRequest } from "@/lib/server/requests";

export const maxDuration = 60;

/** Longest we'll hold the intro for a slow hook once the plan is ready. */
const HOOK_GRACE_MS = 2500;

/**
 * Step 1: two model calls in parallel, streamed as NDJSON as soon as each is useful:
 *   {"outline": …}      — the plan: the client starts writing chapters right away
 *   {"intro": segment}  — intro lines in order: the hook (if it's quick), then the agenda
 *   {"done": true}  or  {"refusal": "…"}  or  {"error": "…"}
 * Neither call can hold the other up: a slow hook is dropped rather than
 * delaying the plan.
 */
export const POST = handle(async (req) => {
  const wait = rateLimit(req, "lesson", 12, 60 * 60 * 1000);
  if (wait) return tooMany(wait);
  const { topic, level } = await readJson(req, OutlineRequest);

  type HookResult = Awaited<ReturnType<typeof generateHook>> | null;
  const hookP: Promise<HookResult> = generateHook(topic, level).catch((e) => {
    console.warn("[hook] failed:", e instanceof Error ? e.message : e);
    return null;
  });
  const outlineP = generateOutline(topic, level);
  outlineP.catch(() => {}); // handled below

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      let sentHook = false;
      const sendHook = (h: HookResult) => {
        if (h?.segment && !sentHook) {
          sentHook = true;
          send({ intro: h.segment });
        }
      };
      try {
        const first = await Promise.race([hookP.then((h) => ({ kind: "hook" as const, h })), outlineP.then((o) => ({ kind: "outline" as const, o }))]);
        if (first.kind === "hook") {
          if (first.h?.refusal) return send({ refusal: first.h.refusal });
          sendHook(first.h);
        }
        const outline = await outlineP;
        if (outline.refusal) return send({ refusal: outline.refusal });
        send({ outline });
        if (!sentHook) {
          const late = await Promise.race([hookP, new Promise<null>((r) => setTimeout(() => r(null), HOOK_GRACE_MS))]);
          if (late?.refusal) return send({ refusal: late.refusal });
          sendHook(late);
          if (!sentHook) console.info("[hook] too slow; starting with the agenda");
        }
        const agenda: Segment = agendaSegment(outline, sentHook ? 1 : 0);
        send({ intro: agenda });
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
