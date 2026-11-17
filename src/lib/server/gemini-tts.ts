import { AIError } from "./openrouter";
import { config } from "./env";

/**
 * Gemini text-to-speech (gemini-3.8-flash-tts family) via the Interactions API.
 * A true TTS model: it reads the transcript verbatim, so no transcript check is
 * needed. We ask for raw 16-bit PCM at 24 kHz, the same format the player uses.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_SAMPLE_RATE = 24000;

export interface PcmAudio {
  pcm: Buffer;
  sampleRate: number;
}

type FoundAudio = { data: string; mime: string | null };

/** Finds the base64 audio in an Interactions (or generateContent) response. */
export function extractAudio(json: unknown): FoundAudio | null {
  const j = json as {
    steps?: { type?: string; content?: { type?: string; data?: string; mime_type?: string }[] }[];
    output_audio?: { data?: string; mime_type?: string };
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  };
  for (const step of [...(j.steps ?? [])].reverse()) {
    if (step.type && step.type !== "model_output") continue;
    const audio = [...(step.content ?? [])].reverse().find((c) => c.type === "audio" && c.data);
    if (audio?.data) return { data: audio.data, mime: audio.mime_type ?? null };
  }
  if (j.output_audio?.data) return { data: j.output_audio.data, mime: j.output_audio.mime_type ?? null };
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (part?.inlineData?.data) return { data: part.inlineData.data, mime: part.inlineData.mimeType ?? null };
  return findAudioDeep(json);
}

/** Last resort for response shapes we don't know: the last audio-typed base64 blob anywhere. */
function findAudioDeep(node: unknown, depth = 0): FoundAudio | null {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const hit = findAudioDeep(node[i], depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  const mime = typeof o.mime_type === "string" ? o.mime_type : typeof o.mimeType === "string" ? o.mimeType : null;
  if (typeof o.data === "string" && o.data.length > 100 && (o.type === "audio" || mime?.toLowerCase().startsWith("audio/"))) return { data: o.data, mime };
  for (const value of Object.values(o).reverse()) {
    const hit = findAudioDeep(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Strips a RIFF/WAV header if present; returns raw 16-bit PCM and its sample rate. */
export function toPcm(bytes: Buffer, mime: string | null, fallbackRate = GEMINI_SAMPLE_RATE): PcmAudio {
  const rateFromMime = mime?.match(/rate=(\d+)/)?.[1];
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12;
    let sampleRate = fallbackRate;
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      if (id === "fmt ") sampleRate = bytes.readUInt32LE(offset + 12);
      if (id === "data") return { pcm: bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + size)), sampleRate };
      offset += 8 + size + (size % 2);
    }
    return { pcm: bytes.subarray(44), sampleRate };
  }
  return { pcm: bytes, sampleRate: rateFromMime ? Number(rateFromMime) : fallbackRate };
}

/** Longest one Gemini request may take. */
const ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * Voices `text`, retrying once on a server error or timeout. Gives up by
 * `deadline` (epoch ms) so the caller still has time for the backup voice.
 */
export async function geminiSpeech(text: string, opts: { deadline?: number } = {}): Promise<PcmAudio> {
  const deadline = opts.deadline ?? Date.now() + 30_000;
  let lastError: AIError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 3_000) break;
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "x-goog-api-key": config.geminiKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
        body: JSON.stringify({
          model: config.geminiTtsModel,
          input: [
            {
              type: "user_input",
              content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: config.geminiTtsStyle }] }],
            },
          ],
          response_format: { type: "audio", mime_type: "audio/l16", sample_rate: GEMINI_SAMPLE_RATE },
          generation_config: { speech_config: [{ voice: config.geminiTtsVoice }] },
        }),
      });
    } catch (e) {
      lastError = new AIError(e instanceof Error && e.name === "TimeoutError" ? "Gemini TTS timed out." : "Could not reach Gemini TTS.");
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[tts:gemini] HTTP ${res.status}: ${body.slice(0, 300)}`);
      // A 429 means a quota is used up; retrying right away won't help, so hand over to the backup voice.
      const retryable = res.status >= 500;
      lastError = new AIError(`Gemini TTS returned ${res.status}.`, res.status === 429 ? 429 : 502, retryable);
      if (!retryable) break;
      await new Promise((r) => setTimeout(r, 700 * attempt));
      continue;
    }
    const json = await res.json();
    const audio = extractAudio(json);
    if (!audio) {
      console.warn(`[tts:gemini] no audio in response: ${JSON.stringify(json).slice(0, 300)}`);
      lastError = new AIError("Gemini TTS returned no audio.");
      continue;
    }
    const out = toPcm(Buffer.from(audio.data, "base64"), audio.mime);
    if (out.pcm.length < 2400) {
      lastError = new AIError("Gemini TTS returned almost no audio.");
      continue;
    }
    return out;
  }
  throw lastError ?? new AIError("Gemini TTS failed.");
}
