import { errorResponse, handle, rateLimit, tooMany } from "@/lib/server/http";
import { verifyNarration } from "@/lib/server/sign";
import { synthesize } from "@/lib/server/tts";

export const maxDuration = 60;

/**
 * Voices one signed narration segment as raw PCM (16-bit, 24 kHz, mono).
 * GET + immutable caching: the same signed text always maps to the same audio,
 * so replays and retries are served from the CDN.
 */
export const GET = handle(async (req) => {
  const url = new URL(req.url);
  const text = url.searchParams.get("t") ?? "";
  const sig = url.searchParams.get("s") ?? "";
  if (!text || text.length > 700) return errorResponse("Invalid narration.", 400);
  if (!verifyNarration(text, sig)) return errorResponse("This narration was not signed by this server.", 403);
  const wait = rateLimit(req, "tts", 900, 60 * 60 * 1000);
  if (wait) return tooMany(wait);

  const { pcm, match, attempts } = await synthesize(text);
  return new Response(new Uint8Array(pcm), {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Audio-Format": "pcm16le; rate=24000; channels=1",
      "X-Speech-Match": match,
      "X-Speech-Attempts": String(attempts),
      "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
    },
  });
});
