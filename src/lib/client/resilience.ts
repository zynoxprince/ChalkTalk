import type { Segment } from "@/lib/lesson/schema";

/**
 * Keeping a lesson alive through dropped connections. On phones a request can
 * fail without the server failing at all: iOS cuts the connections of a tab in
 * the background, and mobile networks blip. Those are worth retrying, once the
 * page is visible again; answers from the server, such as "too many
 * requests", are not.
 */

/** A connection that dropped or never opened, as opposed to an error answer from the server. */
export function isNetworkError(e: unknown): boolean {
  // fetch() and stream reads reject with a TypeError: "Load failed" (Safari), "Failed to fetch", "network error".
  if (e instanceof TypeError) return true;
  return typeof e === "object" && e !== null && "status" in e && (e as { status: unknown }).status === 0;
}

/** Resolves once the page is visible: retrying while the tab is in the background would only fail again. */
export function whenVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The opening question with its hero drawing (the agenda line carries a roadmap instead). */
const isHook = (s: Segment) => s.actions.some((a) => a.kind === "icon") && !s.actions.some((a) => a.kind === "timeline");

/**
 * Adds an intro line from a plan stream that may be a retry: a line that's
 * already there is skipped, so is a second opening question (a retry writes a
 * new one), and a line whose id is taken gets the next free one.
 */
export function mergeIntro(existing: readonly Segment[], incoming: Segment): Segment | null {
  if (existing.some((s) => s.narration === incoming.narration)) return null;
  if (isHook(incoming) && existing.some(isHook)) return null;
  if (!existing.some((s) => s.id === incoming.id)) return incoming;
  let n = existing.length;
  while (existing.some((s) => s.id === `intro-${n}`)) n++;
  return { ...incoming, id: `intro-${n}` };
}
