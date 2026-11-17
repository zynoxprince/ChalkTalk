/** Browser audio helpers: decoding narration PCM and unlocking playback. */

export const TTS_SAMPLE_RATE = 24000;

type AudioCtor = typeof AudioContext;

export function createAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ latencyHint: "playback" });
  } catch {
    return null;
  }
}

/** 16-bit little-endian mono PCM → AudioBuffer (no decodeAudioData round trip). */
export function pcm16ToBuffer(ctx: BaseAudioContext, bytes: ArrayBuffer, sampleRate = TTS_SAMPLE_RATE): AudioBuffer {
  const samples = new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2));
  const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
  const out = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
  return buffer;
}

// 0.2 s of silence as a WAV data URI (mono, 8 kHz, 8-bit).
const SILENT_WAV = (() => {
  const n = 1600;
  const header = [
    0x52, 0x49, 0x46, 0x46, ...le32(36 + n), 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, ...le32(16), 1, 0, 1, 0,
    ...le32(8000), ...le32(8000), 1, 0, 8, 0, 0x64, 0x61, 0x74, 0x61, ...le32(n),
  ];
  const bytes = new Uint8Array(header.length + n);
  bytes.set(header);
  bytes.fill(128, header.length);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${typeof btoa === "function" ? btoa(bin) : ""}`;
})();

function le32(v: number) {
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
}

let keepAlive: HTMLAudioElement | null = null;

/**
 * Must run inside a user gesture. Resumes the AudioContext and starts a silent
 * looping <audio> element, which keeps iOS in "playback" mode so lessons are
 * audible even when the ringer switch is on silent.
 */
export async function unlockAudio(ctx: AudioContext | null): Promise<boolean> {
  try {
    if (typeof document !== "undefined") {
      if (!keepAlive) {
        keepAlive = document.createElement("audio");
        keepAlive.src = SILENT_WAV;
        keepAlive.loop = true;
        keepAlive.setAttribute("playsinline", "");
        keepAlive.volume = 0.01;
      }
      keepAlive.play().catch(() => {});
    }
    if (!ctx) return false;
    if (ctx.state !== "running") await ctx.resume();
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
    return (ctx.state as string) === "running";
  } catch {
    return false;
  }
}
