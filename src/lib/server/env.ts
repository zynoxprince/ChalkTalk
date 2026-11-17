/** Server-side configuration. Never import from client components. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export class ConfigError extends Error {}

export type TtsProvider = "gemini" | "openrouter";

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

  /** Narrator: Gemini TTS when a Gemini key is configured, otherwise the OpenRouter audio model. */
  get ttsProvider(): TtsProvider {
    const forced = process.env.TTS_PROVIDER;
    if (forced === "gemini" || forced === "openrouter") return forced;
    return process.env.GEMINI_API_KEY ? "gemini" : "openrouter";
  },
  get geminiKey() {
    return required("GEMINI_API_KEY");
  },
  geminiTtsModel: process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts",
  geminiTtsVoice: process.env.GEMINI_TTS_VOICE || "Sulafat",
  geminiTtsStyle: process.env.GEMINI_TTS_STYLE || "warm, clear and encouraging, like a great teacher explaining at a whiteboard, at a relaxed pace",

  ttsModel: process.env.TTS_MODEL || "openai/gpt-audio-mini",
  ttsVoice: process.env.TTS_VOICE || "marin",
  siteUrl: process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
};

/** Identifies the narrator voice; part of each narration signature so cached audio never mixes voices. */
export function voiceTag(): string {
  return config.ttsProvider === "gemini" ? `gemini:${config.geminiTtsModel}:${config.geminiTtsVoice}` : `openrouter:${config.ttsModel}:${config.ttsVoice}`;
}
