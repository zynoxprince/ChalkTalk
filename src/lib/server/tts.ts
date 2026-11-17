import { config, type TtsProvider } from "./env";
import { geminiSpeech } from "./gemini-tts";
import { AIError, streamSpeech } from "./openrouter";
import { compareTranscript, cutAtPause, trimSilence } from "./speech";

export type SpeechMatch = "verbatim" | "exact" | "close" | "trimmed" | "approx";

export interface Speech {
  pcm: Buffer;
  sampleRate: number;
  match: SpeechMatch;
  attempts: number;
  provider: TtsProvider;
  /** The primary narrator failed and a backup voice was used. */
  fallback: boolean;
}

/**
 * Voices one narration segment. Gemini TTS (a true TTS) is used when configured;
 * if it fails, the OpenRouter audio model takes over so the lesson keeps talking.
 */
export async function synthesize(text: string): Promise<Speech> {
  if (config.ttsProvider === "gemini") {
    try {
      const { pcm, sampleRate } = await geminiSpeech(text);
      return { pcm: trimSilence(pcm), sampleRate, match: "verbatim", attempts: 1, provider: "gemini", fallback: false };
    } catch (e) {
      console.warn("[tts] Gemini TTS failed, using the backup voice:", e instanceof Error ? e.message : e);
      return { ...(await openRouterSpeech(text)), provider: "openrouter", fallback: true };
    }
  }
  return { ...(await openRouterSpeech(text)), provider: "openrouter", fallback: false };
}

/**
 * The OpenRouter audio model is conversational, so check it actually said the
 * script: ad-libbed endings are trimmed at a pause; real mismatches are retried.
 */
async function openRouterSpeech(text: string): Promise<{ pcm: Buffer; sampleRate: number; match: SpeechMatch; attempts: number }> {
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
    if (verdict.kind === "exact" || verdict.kind === "close") return { pcm: trimSilence(result.pcm), sampleRate: 24000, match: verdict.kind, attempts: attempt };
    if (verdict.kind === "extra-tail") {
      console.info(`[tts] trimmed an ad-libbed ending (kept ${(verdict.fraction * 100).toFixed(0)}%)`);
      return { pcm: trimSilence(cutAtPause(result.pcm, verdict.fraction)), sampleRate: 24000, match: "trimmed", attempts: attempt };
    }
    console.warn(`[tts] transcript mismatch (similarity ${verdict.similarity.toFixed(2)}), retrying`);
    if (!best || verdict.similarity > best.sim) best = { pcm: result.pcm, sim: verdict.similarity };
  }
  if (best) return { pcm: trimSilence(best.pcm), sampleRate: 24000, match: "approx", attempts: 3 };
  throw lastError instanceof Error ? lastError : new AIError("Speech generation failed.");
}
