/**
 * Audio helpers for narration: making a conversational audio model behave like
 * a strict text-to-speech engine (compare its transcript with the script, trim
 * ad-libbed endings at a natural pause), tidying up silence, and reading raw
 * PCM out of speech responses.
 */

const SAMPLE_RATE = 24000;

export const normWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9À-ɏ]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

function editDistance(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export type TranscriptVerdict =
  | { kind: "exact" }
  | { kind: "close"; similarity: number }
  | { kind: "extra-tail"; fraction: number }
  | { kind: "mismatch"; similarity: number };

/** How faithfully the spoken transcript matches the script. */
export function compareTranscript(script: string, transcript: string): TranscriptVerdict {
  const want = normWords(script);
  const got = normWords(transcript);
  if (!got.length) return { kind: "close", similarity: 0.9 }; // no transcript: trust the audio
  if (want.join(" ") === got.join(" ")) return { kind: "exact" };

  // Did it say the script and then keep talking?
  if (got.length > want.length + 2) {
    const head = got.slice(0, want.length);
    const headSim = 1 - editDistance(want, head) / Math.max(1, want.length);
    if (headSim >= 0.85) {
      const wantChars = want.join(" ").length;
      const gotChars = got.join(" ").length;
      return { kind: "extra-tail", fraction: wantChars / gotChars };
    }
  }
  const similarity = 1 - editDistance(want, got) / Math.max(want.length, got.length);
  return similarity >= 0.8 ? { kind: "close", similarity } : { kind: "mismatch", similarity };
}

function samples(pcm: Buffer): Int16Array {
  return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
}

/** Cuts the audio at the quietest pause near `fraction` of its length, with a short fade. */
export function cutAtPause(pcm: Buffer, fraction: number): Buffer {
  const s = samples(pcm);
  const target = Math.floor(s.length * Math.min(1, Math.max(0, fraction)));
  const win = Math.floor(SAMPLE_RATE * 0.9);
  const frame = Math.floor(SAMPLE_RATE * 0.02);
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  const lo = Math.max(0, target - win);
  const hi = Math.min(s.length - frame, target + win);
  for (let i = lo; i < hi; i += frame) {
    let peak = 0;
    for (let k = i; k < i + frame; k++) peak = Math.max(peak, Math.abs(s[k]));
    if (peak < 700) {
      if (runStart < 0) runStart = i;
      const len = i + frame - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
    } else runStart = -1;
  }
  let cut = bestLen >= SAMPLE_RATE * 0.1 ? bestStart + Math.floor(bestLen / 2) : target + Math.floor(SAMPLE_RATE * 0.12);
  cut = Math.min(s.length, Math.max(1, cut));
  const out = Int16Array.from(s.subarray(0, cut));
  const fade = Math.min(out.length, Math.floor(SAMPLE_RATE * 0.04));
  for (let k = 0; k < fade; k++) out[out.length - 1 - k] = Math.round(out[out.length - 1 - k] * (k / fade));
  return Buffer.from(out.buffer);
}

/** Trims leading/trailing silence, leaving a little natural padding. */
export function trimSilence(pcm: Buffer, threshold = 400, rate = SAMPLE_RATE): Buffer {
  const s = samples(pcm);
  let a = 0;
  while (a < s.length && Math.abs(s[a]) < threshold) a++;
  let b = s.length - 1;
  while (b > a && Math.abs(s[b]) < threshold) b--;
  if (a >= b) return pcm;
  const start = Math.max(0, a - Math.floor(rate * 0.06));
  const end = Math.min(s.length, b + Math.floor(rate * 0.12));
  return Buffer.from(Int16Array.from(s.subarray(start, end)).buffer);
}

export const pcmSeconds = (pcm: Buffer, rate = SAMPLE_RATE) => pcm.byteLength / 2 / rate;

export interface PcmAudio {
  pcm: Buffer;
  sampleRate: number;
}

/**
 * Raw 16-bit mono PCM from a speech response: a RIFF/WAV header is stripped
 * (taking its sample rate); otherwise the rate comes from the content type,
 * e.g. `audio/pcm;rate=24000;channels=1`.
 */
export function toPcm(bytes: Buffer, mime: string | null, fallbackRate = SAMPLE_RATE): PcmAudio {
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
  // An odd byte count would misalign the 16-bit samples.
  const even = bytes.length % 2 ? bytes.subarray(0, bytes.length - 1) : bytes;
  return { pcm: even, sampleRate: rateFromMime ? Number(rateFromMime) : fallbackRate };
}
