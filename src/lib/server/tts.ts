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

/** Everything must finish inside the speech route's 60 s limit, with room to send the audio. */
const REQUEST_BUDGET_MS = 55_000;
/** Gemini's share of that, so the backup voice always gets a fair chance. */
const GEMINI_BUDGET_MS = 30_000;

/**
 * Voices one narration segment. Gemini TTS (a true TTS) is used when configured;
 * if it fails, the OpenRouter audio model takes over so the lesson keeps talking.
 */
export async function synthesize(text: string): Promise<Speech> {
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  if (config.ttsProvider === "gemini") {
    try {
      const { pcm, sampleRate } = await geminiSpeech(text, { deadline: Date.now() + GEMINI_BUDGET_MS });
      return { pcm: trimSilence(pcm), sampleRate, match: "verbatim", attempts: 1, provider: "gemini", fallback: false };
    } catch (e) {
      console.warn("[tts] Gemini TTS failed, using the backup voice:", e instanceof Error ? e.message : e);
      return { ...(await openRouterSpeech(text, deadline)), provider: "openrouter", fallback: true };
    }
  }
  return { ...(await openRouterSpeech(text, deadline)), provider: "openrouter", fallback: false };
}

/**
 * The OpenRouter audio model is conversational, so check it actually said the
 * script: ad-libbed endings are trimmed at a pause; real mismatches are retried
 * while there's time left before `deadline`.
 */
async function openRouterSpeech(text: string, deadline: number): Promise<{ pcm: Buffer; sampleRate: number; match: SpeechMatch; attempts: number }> {
  let best: { pcm: Buffer; sim: number } | null = null;
  let lastError: unknown = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 4_000) break;
    attempts = attempt;
    let result;
    try {
      result = await streamSpeech(text, { timeoutMs: Math.min(30_000, remaining) });
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
  if (best) return { pcm: trimSilence(best.pcm), sampleRate: 24000, match: "approx", attempts };
  throw lastError instanceof Error ? lastError : new AIError("Speech generation timed out.");
}
