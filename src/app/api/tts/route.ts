import { errorResponse, handle, rateLimit, tooMany } from "@/lib/server/http";
import { pcmToMp3 } from "@/lib/server/mp3";
import { verifyNarration } from "@/lib/server/sign";
import { synthesize } from "@/lib/server/tts";

export const maxDuration = 60;

/**
 * Voices one signed narration segment. With `f=mp3` (what the app asks for) the
 * audio comes back as a compact MP3, about 8× smaller than raw PCM, so lines
 * download quickly on phones; otherwise as raw 16-bit mono PCM (the sample rate
 * is in X-Audio-Format). GET + immutable caching: the same signed text always
 * maps to the same audio, so replays and retries are served from the CDN.
 */
export const GET = handle(async (req) => {
  const url = new URL(req.url);
  const text = url.searchParams.get("t") ?? "";
  const sig = url.searchParams.get("s") ?? "";
  const wantMp3 = url.searchParams.get("f") === "mp3";
  if (!text || text.length > 700) return errorResponse("Invalid narration.", 400);
  if (!verifyNarration(text, sig)) return errorResponse("This narration was not signed by this server.", 403);
  const wait = rateLimit(req, "tts", 900, 60 * 60 * 1000);
  if (wait) return tooMany(wait);

  const speech = await synthesize(text);
  const headers: Record<string, string> = {
    "X-Speech-Model": speech.model,
    "X-Speech-Fallback": speech.fallback ? "1" : "0",
    "X-Speech-Match": speech.match,
    "X-Speech-Attempts": String(speech.attempts),
    // Backup-voice audio is cached briefly, so the narrator takes over again once it recovers.
    "Cache-Control": speech.fallback ? "public, max-age=300, s-maxage=300" : "public, max-age=31536000, s-maxage=31536000, immutable",
  };
  if (wantMp3) {
    const mp3 = await pcmToMp3(speech.pcm, speech.sampleRate).catch((e) => {
      console.warn("[tts] mp3 encoding failed, sending pcm:", e instanceof Error ? e.message : e);
      return null;
    });
    if (mp3) return new Response(new Uint8Array(mp3), { headers: { ...headers, "Content-Type": "audio/mpeg" } });
  }
  return new Response(new Uint8Array(speech.pcm), {
    headers: { ...headers, "Content-Type": "application/octet-stream", "X-Audio-Format": `pcm16le; rate=${speech.sampleRate}; channels=1` },
  });
});
