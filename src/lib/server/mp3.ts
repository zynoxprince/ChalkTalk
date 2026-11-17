import { createMp3Encoder } from "wasm-media-encoders";

/** Sample rates MP3 can carry (MPEG-1/2/2.5 Layer III). */
const MP3_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);

/**
 * Encodes 16-bit mono PCM as MP3 (LAME compiled to WebAssembly, ~80× real time).
 * Speech at 48 kbps is about 8× smaller than raw PCM, which matters a lot on
 * phones: a 12-second line drops from ~570 KB to ~70 KB. Returns null when the
 * sample rate can't be carried, so the caller can send PCM instead.
 */
export async function pcmToMp3(pcm: Buffer, sampleRate: number, kbps = 48): Promise<Buffer | null> {
  if (!MP3_RATES.has(sampleRate)) return null;
  const encoder = await createMp3Encoder();
  encoder.configure({ sampleRate, channels: 1, bitrate: kbps as 48 });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
  const parts: Buffer[] = [];
  // encode() returns a view into the encoder's memory, so copy each chunk out.
  for (let i = 0; i < floats.length; i += 8192) parts.push(Buffer.from(encoder.encode([floats.subarray(i, i + 8192)])));
  parts.push(Buffer.from(encoder.finalize()));
  return Buffer.concat(parts);
}
