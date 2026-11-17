/** Server-side configuration. Never import from client components. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export class ConfigError extends Error {}

const off = (v: string | undefined) => v === "none" || v === "off";

export const config = {
  get openRouterKey() {
    return required("OPENROUTER_API_KEY");
  },
  get signingSecret() {
    return required("SIGNING_SECRET");
  },
  lessonModel: process.env.LESSON_MODEL || "google/gemini-4-hydrogen",
  tutorModel: process.env.TUTOR_MODEL || process.env.LESSON_MODEL || "google/gemini-4-hydrogen",
  /** Reasoning effort for lesson generation: lower is faster. */
  lessonReasoning: (process.env.LESSON_REASONING || "minimal") as "minimal" | "low" | "medium" | "high",
  tutorReasoning: (process.env.TUTOR_REASONING || "minimal") as "minimal" | "low" | "medium" | "high",

  /**
   * Narrator, called through OpenRouter: a text-to-speech model (Gemini TTS by
   * default) or an audio-output chat model such as `openai/gpt-audio-mini`.
   */
  ttsModel: process.env.TTS_MODEL || "google/gemini-3.8-flash-tts",
  ttsVoice: process.env.TTS_VOICE || "Sulafat",
  /** Delivery direction for TTS models that take one (Gemini, gpt-4o-mini-tts). */
  ttsStyle:
    process.env.TTS_STYLE ||
    "A warm, upbeat teacher explaining at a whiteboard: clear, expressive and engaging, with a natural conversational pace and a smile in the voice.",
  /** Reads a line if the narrator fails. "none" turns it off. */
  backupTtsModel: off(process.env.BACKUP_TTS_MODEL) ? "" : process.env.BACKUP_TTS_MODEL || "openai/gpt-audio-mini",
  backupTtsVoice: process.env.BACKUP_TTS_VOICE || "marin",
  siteUrl: process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
};

/**
 * Identifies the narrator voice (model, voice and style); part of each narration
 * signature, so changing any of them changes the audio URLs and cached audio
 * never mixes voices.
 */
export function voiceTag(): string {
  let h = 0;
  for (const ch of config.ttsStyle) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `${config.ttsModel}:${config.ttsVoice}:${(h >>> 0).toString(36)}`;
}
