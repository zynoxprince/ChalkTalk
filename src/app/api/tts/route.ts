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

  const speech = await synthesize(text);
  return new Response(new Uint8Array(speech.pcm), {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Audio-Format": `pcm16le; rate=${speech.sampleRate}; channels=1`,
      "X-Speech-Provider": speech.provider,
      "X-Speech-Match": speech.match,
      "X-Speech-Attempts": String(speech.attempts),
      // Backup-voice audio is cached briefly, so the primary voice takes over again once it recovers.
      "Cache-Control": speech.fallback ? "public, max-age=300, s-maxage=300" : "public, max-age=31536000, s-maxage=31536000, immutable",
    },
  });
});
