/** Server-side configuration. Never import from client components. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export class ConfigError extends Error {}

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
  ttsModel: process.env.TTS_MODEL || "openai/gpt-audio-mini",
  ttsVoice: process.env.TTS_VOICE || "marin",
  siteUrl: process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
};
