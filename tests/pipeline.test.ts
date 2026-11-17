import { describe, expect, it } from "vitest";
import { ArrayItemExtractor } from "@/lib/lesson/stream-json";
import { cleanNarration, repairSegments } from "@/lib/lesson/repair";
import { compareTranscript } from "@/lib/server/speech";
import { extractAudio, toPcm } from "@/lib/server/gemini-tts";
import { compileTimeline, type AudioInfo } from "@/lib/board/timeline";
import { FIXTURE_SCENES } from "@/lib/lesson/fixture";
import type { Action } from "@/lib/lesson/schema";

describe("ArrayItemExtractor", () => {
  it("emits each array item as soon as it closes, across arbitrary chunk boundaries", () => {
    const json = JSON.stringify({ segments: [{ narration: 'Braces { in } "text" and \\ escapes', actions: [{ id: "a", items: ["x", "y"] }] }, { narration: "Second", actions: [] }] });
    for (const size of [1, 3, 7, 50, json.length]) {
      const ex = new ArrayItemExtractor("segments");
      const items: string[] = [];
      for (let i = 0; i < json.length; i += size) items.push(...ex.push(json.slice(i, i + size)));
      expect(items.map((s) => JSON.parse(s).narration)).toEqual(['Braces { in } "text" and \\ escapes', "Second"]);
      expect(ex.done).toBe(true);
    }
  });

  it("returns nothing until the first item is complete", () => {
    const ex = new ArrayItemExtractor("segments");
    expect(ex.push('{"segments":[{"narration":"Hal')).toEqual([]);
    expect(ex.push('f"}')).toEqual(['{"narration":"Half"}']);
  });
});

const act = (a: Partial<Action> & Pick<Action, "id" | "kind">): Action => ({ cue: "", text: null, items: null, icon: null, at: null, from: null, to: null, target: null, color: null, expr: null, ...a });

describe("repair", () => {
  it("makes narration speakable", () => {
    expect(cleanNarration("**Light** is _fast_ 🚀 — see [here](http://x)")).toBe("Light is fast — see here");
  });

  it("drops incomplete actions, dedupes ids, resolves icons and re-anchors cues", () => {
    const [seg] = repairSegments(
      [
        {
          narration: "The sun heats the water.",
          actions: [
            act({ id: "s", kind: "icon", icon: "Sunshine", text: "sun", cue: "nowhere in narration" }),
            act({ id: "s", kind: "box", text: "Water", cue: "the water" }),
            act({ id: "bad", kind: "arrow", from: "s", cue: "heats" }),
            act({ id: "empty", kind: "text", cue: "x" }),
          ],
        },
      ],
      { sceneId: "c1", sign: () => "sig" },
    );
    expect(seg.id).toBe("c1-0");
    expect(seg.actions.map((a) => a.id)).toEqual(["s", "s_2"]);
    expect(seg.actions[0].cue).toBe("sun");
  });

  it("continues ids across streamed calls", () => {
    const seen = new Set<string>();
    const a = repairSegments([{ narration: "One two three.", actions: [act({ id: "x", kind: "text", text: "A", cue: "One" })] }], { sceneId: "c2", sign: () => "", seen });
    const b = repairSegments([{ narration: "Four five six.", actions: [act({ id: "x", kind: "text", text: "B", cue: "Four" })] }], { sceneId: "c2", sign: () => "", seen, startIndex: 1 });
    expect(a[0].id).toBe("c2-0");
    expect(b[0].id).toBe("c2-1");
    expect(b[0].actions[0].id).toBe("x_2");
  });
});

describe("speech verification", () => {
  it("classifies transcripts", () => {
    const script = "Picture a leaf in sunlight. It takes in light from the sun.";
    expect(compareTranscript(script, "picture a leaf in sunlight, it takes in light from the sun").kind).toBe("exact");
    expect(compareTranscript(script, script + " This process is called photosynthesis and it makes food.").kind).toBe("extra-tail");
    expect(compareTranscript(script, "Picture a leaf in the sunlight. It takes light from the sun.").kind).toBe("close");
    expect(compareTranscript(script, "Hello! How can I help you today?").kind).toBe("mismatch");
  });
});

describe("streaming chapters in the timeline", () => {
  it("lets playback run into a partially written chapter but not past it", () => {
    const audio = new Map<string, AudioInfo>();
    for (const s of FIXTURE_SCENES) for (const g of s.segments) audio.set(g.id, { duration: 5, ok: true });
    const partial = { ...FIXTURE_SCENES[2], segments: FIXTURE_SCENES[2].segments.slice(0, 1) };
    const inputs = [{ scene: FIXTURE_SCENES[0] }, { scene: FIXTURE_SCENES[1] }, { scene: partial, partial: true }, { scene: FIXTURE_SCENES[3], pending: true }];
    const tl = compileTimeline(inputs, audio);
    const seg = tl.segments.find((s) => s.id === partial.segments[0].id)!;
    expect(tl.readyUntil).toBeCloseTo(seg.end);
    expect(tl.complete).toBe(false);
  });
});

describe("Gemini TTS audio parsing", () => {
  const pcm = Buffer.from(Int16Array.from([0, 1000, -1000, 32767, -32768]).buffer);

  function wav(data: Buffer, rate: number) {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "ascii");
    h.writeUInt32LE(36 + data.length, 4);
    h.write("WAVE", 8, "ascii");
    h.write("fmt ", 12, "ascii");
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36, "ascii");
    h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  }

  it("strips a WAV header and reads its sample rate", () => {
    const out = toPcm(wav(pcm, 16000), "audio/wav");
    expect(out.sampleRate).toBe(16000);
    expect(Buffer.compare(out.pcm, pcm)).toBe(0);
  });

  it("passes raw L16 through, taking the rate from the mime type", () => {
    expect(toPcm(pcm, "audio/l16; rate=24000").sampleRate).toBe(24000);
    expect(Buffer.compare(toPcm(pcm, null).pcm, pcm)).toBe(0);
  });

  it("finds audio in Interactions and generateContent responses", () => {
    const interactions = { steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "audio", data: "QUJD", mime_type: "audio/l16" }] }] };
    expect(extractAudio(interactions)).toEqual({ data: "QUJD", mime: "audio/l16" });
    expect(extractAudio({ output_audio: { data: "WFla" } })).toEqual({ data: "WFla", mime: null });
    expect(extractAudio({ candidates: [{ content: { parts: [{ inlineData: { data: "Wlpa", mimeType: "audio/wav" } }] } }] })).toEqual({ data: "Wlpa", mime: "audio/wav" });
    expect(extractAudio({ steps: [] })).toBeNull();
  });

  it("falls back to searching unknown response shapes for the audio blob", () => {
    const blob = "A".repeat(200);
    expect(extractAudio({ outputs: [{ type: "text", text: "hi" }, { type: "audio", data: blob, mime_type: "audio/l16;rate=24000" }] })).toEqual({ data: blob, mime: "audio/l16;rate=24000" });
    expect(extractAudio({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "audio/L16;codec=pcm;rate=24000", data: blob } }] } }] })).toEqual({ data: blob, mime: "audio/L16;codec=pcm;rate=24000" });
    // Base64 that isn't marked as audio is never picked up.
    expect(extractAudio({ outputs: [{ type: "image", data: blob, mime_type: "image/png" }] })).toBeNull();
    expect(toPcm(Buffer.alloc(4), "audio/L16;codec=pcm;rate=24000").sampleRate).toBe(24000);
  });
});
