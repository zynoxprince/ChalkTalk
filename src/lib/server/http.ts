import { unstable_rethrow } from "next/navigation";
import { ZodError, type z } from "zod";
import { AIError } from "./openrouter";
import { ConfigError } from "./env";

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

const hits = new Map<string, number[]>();

/**
 * Sliding-window limiter per client IP. In-memory, so it applies per server
 * instance: enough to stop casual abuse of a public demo without extra infra.
 */
export function rateLimit(req: Request, bucket: string, limit: number, windowMs: number): number | null {
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || "local").trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return Math.ceil((windowMs - (now - list[0])) / 1000);
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

export function errorResponse(message: string, status: number, extra: Record<string, unknown> = {}) {
  return Response.json({ error: message, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequest("Request body must be JSON.");
  }
  return schema.parse(body);
}

export class BadRequest extends Error {}

/** Wraps a route handler with consistent error responses. */
export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    try {
      return await fn(req);
    } catch (e) {
      // Let Next.js handle its own control-flow errors (e.g. dynamic-rendering bailouts).
      unstable_rethrow(e);
      if (e instanceof ZodError) return errorResponse("Invalid request.", 400, { issues: e.issues.slice(0, 3).map((i) => i.message) });
      if (e instanceof BadRequest) return errorResponse(e.message, 400);
      if (e instanceof ConfigError) {
        console.error("[config]", e.message);
        return errorResponse("The server is not configured yet (missing API key).", 503);
      }
      if (e instanceof AIError) return errorResponse(e.message, e.status, { retryable: e.retryable });
      console.error("[route] unexpected error", e);
      return errorResponse("Something went wrong on our side. Please try again.", 500);
    }
  };
}

export function tooMany(retryAfter: number) {
  return Response.json(
    { error: `You're going a bit fast — please wait ${retryAfter < 90 ? `${retryAfter} seconds` : `${Math.ceil(retryAfter / 60)} minutes`} and try again.` },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
  );
}
