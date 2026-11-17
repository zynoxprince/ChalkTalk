import { config } from "./env";
import { AIError, streamSpeech, synthesizeSpeech } from "./openrouter";
import { compareTranscript, cutAtPause, trimSilence } from "./speech";

export type SpeechMatch = "verbatim" | "exact" | "close" | "trimmed" | "approx";

export interface Speech {
  pcm: Buffer;
  sampleRate: number;
  match: SpeechMatch;
  attempts: number;
  /** The model that actually spoke. */
  model: string;
  /** The narrator failed and the backup voice was used. */
  fallback: boolean;
}

type Spoken = Omit<Speech, "model" | "fallback">;

/** Everything must finish inside the speech route's 60 s limit, with room to send the audio. */
const REQUEST_BUDGET_MS = 55_000;
/** The narrator's share of that, so the backup voice always gets a fair chance. */
const NARRATOR_BUDGET_MS = 30_000;

/**
 * Voices one narration segment with the narrator (Gemini TTS through
 * OpenRouter by default). If it fails, the backup voice reads the line so the
 * lesson keeps talking.
 */
export async function synthesize(text: string): Promise<Speech> {
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  try {
    const spoken = await speak(config.ttsModel, config.ttsVoice, text, Math.min(deadline, Date.now() + NARRATOR_BUDGET_MS));
    return { ...spoken, model: config.ttsModel, fallback: false };
  } catch (e) {
    if (!config.backupTtsModel || config.backupTtsModel === config.ttsModel) throw e;
    console.warn(`[tts] ${config.ttsModel} failed, using the backup voice:`, e instanceof Error ? e.message : e);
    const spoken = await speak(config.backupTtsModel, config.backupTtsVoice, text, deadline);
    return { ...spoken, model: config.backupTtsModel, fallback: true };
  }
}

/** Audio-output chat models (talk back, so need checking) vs. real text-to-speech models. */
export const isChatAudioModel = (model: string) => /(^|\/)gpt-(4o-)?audio/.test(model);

function speak(model: string, voice: string, text: string, deadline: number): Promise<Spoken> {
  return isChatAudioModel(model) ? chatAudioSpeech(model, voice, text, deadline) : ttsSpeech(model, voice, text, deadline);
}

/** A text-to-speech model reads the script verbatim; retry once after a server error or timeout. */
async function ttsSpeech(model: string, voice: string, text: string, deadline: number): Promise<Spoken> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 3_000) break;
    try {
      const { pcm, sampleRate } = await synthesizeSpeech(text, { model, voice, instructions: config.ttsStyle, timeoutMs: Math.min(20_000, remaining) });
      return { pcm: trimSilence(pcm, 400, sampleRate), sampleRate, match: "verbatim", attempts: attempt };
    } catch (e) {
      lastError = e;
      if (e instanceof AIError && !e.retryable) break;
      console.warn(`[tts] ${model} attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new AIError("Speech generation timed out.");
}

/**
 * An audio-output chat model is conversational, so check it actually said the
 * script: ad-libbed endings are trimmed at a pause; real mismatches are retried
 * while there's time left before `deadline`.
 */
async function chatAudioSpeech(model: string, voice: string, text: string, deadline: number): Promise<Spoken> {
  let best: { pcm: Buffer; sim: number } | null = null;
  let lastError: unknown = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 4_000) break;
    attempts = attempt;
    let result;
    try {
      result = await streamSpeech(text, { model, voice, timeoutMs: Math.min(30_000, remaining) });
    } catch (e) {
      lastError = e;
      if (e instanceof AIError && !e.retryable) throw e;
      console.warn(`[tts] ${model} attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
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
