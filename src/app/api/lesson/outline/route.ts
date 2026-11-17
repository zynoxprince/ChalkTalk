import { agendaSegment, generateHook, openerSegment, streamPlan } from "@/lib/lesson/generate";
import type { Outline, Segment } from "@/lib/lesson/schema";
import { AIError } from "@/lib/server/openrouter";
import { handle, rateLimit, readJson, tooMany } from "@/lib/server/http";
import { OutlineRequest } from "@/lib/server/requests";

export const maxDuration = 60;

/** Longest we'll hold the intro for a slow hook once the plan is ready. */
const HOOK_GRACE_MS = 2500;

/**
 * Step 1, streamed as NDJSON as soon as each piece is useful:
 *   {"intro": segment}    — intro lines in order: an instant opener built from the
 *                           topic (sent before any model answers), the hook (a
 *                           tiny parallel call, if it's quick), then the agenda
 *   {"outline": …}        — the plan: the client starts chapters 2 and 3 at once
 *   {"voice": …}          — a chapter-1 line's text, as soon as it's written
 *   {"introDone": true}   — no more intro lines
 *   {"segment": …}        — a chapter-1 segment (the plan call writes chapter 1 too)
 *   {"done": true, "chapterOne": n}  or  {"refusal": "…"}  or  {"error": "…"}
 * Writing chapter 1 in the same call as the plan takes a whole model round trip
 * off the path to the first chapter. No call can hold another up: a slow hook
 * is dropped rather than delaying the lesson.
 */
export const POST = handle(async (req) => {
  const wait = rateLimit(req, "lesson", 12, 60 * 60 * 1000);
  if (wait) return tooMany(wait);
  const { topic, level, waitForHook } = await readJson(req, OutlineRequest);

  type HookResult = Awaited<ReturnType<typeof generateHook>> | null;
  const hookP: Promise<HookResult> = generateHook(topic, level).catch((e) => {
    console.warn("[hook] failed:", e instanceof Error ? e.message : e);
    return null;
  });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      // Chapter-1 lines wait until the plan (and the intro lines) are out, so messages stay in order.
      let planSent = false;
      const held: unknown[] = [];
      const sendChapter = (msg: unknown) => (planSent ? send(msg) : held.push(msg));

      let resolveOutline!: (o: Outline) => void;
      const outlineReady = new Promise<Outline>((r) => (resolveOutline = r));
      const planP = streamPlan(topic, level, {
        onOutline: (o) => resolveOutline(o),
        onSegment: (segment) => sendChapter({ segment }),
        onNarration: (voice) => sendChapter({ voice }),
      });
      planP.catch(() => {}); // handled below

      let sentHook = false;
      const sendHook = (h: HookResult) => {
        if (h?.segment && !sentHook) {
          sentHook = true;
          send({ intro: h.segment });
        }
      };
      try {
        // The tutor starts talking straight away, whatever the models' speed.
        send({ intro: openerSegment(topic) });
        const first = await Promise.race([
          hookP.then((h) => ({ kind: "hook" as const, h })),
          outlineReady.then((o) => ({ kind: "outline" as const, o })),
          planP.then(({ outline }) => ({ kind: "outline" as const, o: outline })),
        ]);
        if (first.kind === "hook") {
          if (first.h?.refusal) return send({ refusal: first.h.refusal });
          sendHook(first.h);
        }
        const outline = await Promise.race([outlineReady, planP.then((r) => r.outline)]);
        if (outline.refusal) return send({ refusal: outline.refusal });
        send({ outline });
        if (!sentHook) {
          const late = waitForHook ? await hookP : await Promise.race([hookP, new Promise<null>((r) => setTimeout(() => r(null), HOOK_GRACE_MS))]);
          if (late?.refusal) return send({ refusal: late.refusal });
          sendHook(late);
          if (!sentHook) console.info("[hook] too slow; starting with the agenda");
        }
        const agenda: Segment = agendaSegment(outline, sentHook ? 2 : 1);
        send({ intro: agenda });
        send({ introDone: true });
        planSent = true;
        for (const msg of held.splice(0)) send(msg);
        // Chapter 1 keeps streaming in on this response; if it fails, the client asks for it separately.
        const { chapterOne } = await planP.catch(() => ({ chapterOne: 0 }));
        send({ done: true, chapterOne });
      } catch (e) {
        console.warn("[outline] failed:", e instanceof Error ? e.message : e);
        send({ error: e instanceof AIError ? e.message : "The lesson plan could not be written. Please try again." });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
});
