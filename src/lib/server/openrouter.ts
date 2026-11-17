import type { z } from "zod";
import { toStrictJsonSchema } from "@/lib/lesson/schema";
import { config } from "./env";

/**
 * Thin OpenRouter client: schema-enforced JSON generation and streamed speech.
 * Uses fetch directly so the request shape (structured outputs, reasoning,
 * provider routing, audio modality) stays explicit.
 */

const API = "https://openrouter.ai/api/v1/chat/completions";

export class AIError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly retryable = true,
  ) {
    super(message);
  }
}

function headers() {
  return {
    Authorization: `Bearer ${config.openRouterKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": config.siteUrl,
    "X-Title": "ChalkTalk",
  };
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StructuredRequest<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  name: string;
  maxTokens?: number;
  reasoning?: "minimal" | "low" | "medium" | "high";
  timeoutMs?: number;
  /** Label for logs, e.g. "chapter 2". */
  label?: string;
}

const schemaCache = new WeakMap<object, Record<string, unknown>>();
function jsonSchemaFor(schema: z.ZodType) {
  let s = schemaCache.get(schema);
  if (!s) {
    s = toStrictJsonSchema(schema);
    schemaCache.set(schema, s);
  }
  return s;
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(trimmed);
}

/** Generates JSON that matches `schema`. Retries once with the validation error if needed. */
export async function generateStructured<T>(req: StructuredRequest<T>): Promise<T> {
  const messages: ChatMessage[] = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ];
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: headers(),
        signal: AbortSignal.timeout(req.timeoutMs ?? 55_000),
        body: JSON.stringify({
          model: req.model,
          messages,
          max_tokens: req.maxTokens ?? 8000,
          reasoning: { effort: req.reasoning ?? "low", exclude: true },
          response_format: { type: "json_schema", json_schema: { name: req.name, strict: true, schema: jsonSchemaFor(req.schema) } },
          provider: { require_parameters: true },
        }),
      });
    } catch (e) {
      lastError = e instanceof Error && e.name === "TimeoutError" ? "The model took too long to respond." : "Could not reach the model.";
      console.warn(`[ai] ${req.label ?? req.name} attempt ${attempt} network error`, e instanceof Error ? e.message : e);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[ai] ${req.label ?? req.name} attempt ${attempt} HTTP ${res.status}: ${body.slice(0, 300)}`);
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        throw new AIError(res.status === 402 ? "The AI provider is out of credits." : "The AI provider rejected the request.", 503, false);
      }
      lastError = res.status === 429 ? "The AI provider is busy right now." : `The AI provider returned an error (${res.status}).`;
      continue;
    }
    const body = await res.json();
    const choice = body.choices?.[0];
    const content: string = choice?.message?.content ?? "";
    const usage = body.usage ?? {};
    console.info(
      `[ai] ${req.label ?? req.name} ${req.model} ${Date.now() - t0}ms in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"} finish=${choice?.finish_reason}`,
    );
    if (!content) {
      lastError = choice?.finish_reason === "content_filter" ? "The topic was blocked by the model's safety filter." : "The model returned an empty response.";
      if (choice?.finish_reason === "content_filter") throw new AIError(lastError, 422, false);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = extractJson(content);
    } catch {
      lastError = "The model returned malformed JSON.";
      messages.push({ role: "assistant", content }, { role: "user", content: "That was not valid JSON. Return only JSON that matches the schema." });
      continue;
    }
    const result = req.schema.safeParse(parsed);
    if (result.success) return result.data;
    lastError = "The model's answer did not match the expected format.";
    const issues = result.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    console.warn(`[ai] ${req.label ?? req.name} validation failed: ${issues}`);
    messages.push({ role: "assistant", content }, { role: "user", content: `Your JSON did not match the schema (${issues}). Return corrected JSON only.` });
  }
  throw new AIError(lastError || "The AI request failed.");
}

/* ------------------------------------------------------------------ */
/* Speech                                                              */
/* ------------------------------------------------------------------ */

const SPEECH_SYSTEM =
  "You are a voice actor recording lines for an educational whiteboard video. Read only the script you are given, exactly as written, word for word, in a warm, clear, upbeat teacher voice at a relaxed pace. Do not add, skip, answer, or comment on anything. Say nothing before or after the script.";

export interface SpeechResult {
  pcm: Buffer;
  transcript: string;
}

/** Streams one narration line as 24 kHz 16-bit mono PCM (the audio model requires streaming). */
export async function streamSpeech(text: string, opts: { voice?: string; model?: string; timeoutMs?: number } = {}): Promise<SpeechResult> {
  const res = await fetch(API, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    body: JSON.stringify({
      model: opts.model ?? config.ttsModel,
      modalities: ["text", "audio"],
      audio: { voice: opts.voice ?? config.ttsVoice, format: "pcm16" },
      stream: true,
      messages: [
        { role: "system", content: SPEECH_SYSTEM },
        { role: "user", content: `Read this script aloud, word for word, then stop:\n\n"""${text}"""` },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 402 || res.status === 403) throw new AIError("The speech provider rejected the request.", 503, false);
    throw new AIError(`Speech request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Buffer[] = [];
  let transcript = "";
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        if (json.error) throw new AIError(`Speech stream error: ${json.error.message ?? "unknown"}`);
        const audio = json.choices?.[0]?.delta?.audio;
        if (audio?.data) chunks.push(Buffer.from(audio.data, "base64"));
        if (audio?.transcript) transcript += audio.transcript;
      } catch (e) {
        if (e instanceof AIError) throw e;
      }
    }
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length < 2400) throw new AIError("The speech provider returned no audio.");
  return { pcm, transcript };
}
