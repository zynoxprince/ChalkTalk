import { AIError, streamSpeech } from "./openrouter";
import { compareTranscript, cutAtPause, trimSilence } from "./speech";

export type SpeechMatch = "exact" | "close" | "trimmed" | "approx";

/**
 * Voices one narration segment and checks the model actually said the script.
 * Ad-libbed endings are trimmed at a pause; real mismatches are retried.
 */
export async function synthesize(text: string): Promise<{ pcm: Buffer; match: SpeechMatch; attempts: number }> {
  let best: { pcm: Buffer; sim: number } | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let result;
    try {
      result = await streamSpeech(text);
    } catch (e) {
      lastError = e;
      if (e instanceof AIError && !e.retryable) throw e;
      console.warn(`[tts] attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
      continue;
    }
    const verdict = compareTranscript(text, result.transcript);
    if (verdict.kind === "exact" || verdict.kind === "close") return { pcm: trimSilence(result.pcm), match: verdict.kind, attempts: attempt };
    if (verdict.kind === "extra-tail") {
      console.info(`[tts] trimmed an ad-libbed ending (kept ${(verdict.fraction * 100).toFixed(0)}%)`);
      return { pcm: trimSilence(cutAtPause(result.pcm, verdict.fraction)), match: "trimmed", attempts: attempt };
    }
    console.warn(`[tts] transcript mismatch (similarity ${verdict.similarity.toFixed(2)}), retrying`);
    if (!best || verdict.similarity > best.sim) best = { pcm: result.pcm, sim: verdict.similarity };
  }
  if (best) return { pcm: trimSilence(best.pcm), match: "approx", attempts: 3 };
  throw lastError instanceof Error ? lastError : new AIError("Speech generation failed.");
}
