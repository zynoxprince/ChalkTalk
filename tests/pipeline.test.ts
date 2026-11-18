import { describe, expect, it } from "vitest";
import { ArrayItemExtractor } from "@/lib/lesson/stream-json";
import { PlanStream, SegmentStream } from "@/lib/lesson/segment-stream";
import { openerLine } from "@/lib/lesson/generate";
import { cleanNarration, repairSegments } from "@/lib/lesson/repair";
import { compareTranscript } from "@/lib/server/speech";
import { toPcm } from "@/lib/server/speech";
import { isChatAudioModel } from "@/lib/server/tts";
import { compileTimeline, type AudioInfo } from "@/lib/board/timeline";
import { FIXTURE_SCENES } from "@/lib/lesson/fixture";
import type { Action, Segment } from "@/lib/lesson/schema";
import { isNetworkError, mergeIntro } from "@/lib/client/resilience";
import { routing } from "@/lib/server/openrouter";

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

describe("speech audio parsing", () => {
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

  it("passes raw PCM through, taking the rate from the content type", () => {
    // What OpenRouter's speech endpoint sends for Gemini TTS.
    expect(toPcm(pcm, "audio/pcm;rate=24000;channels=1").sampleRate).toBe(24000);
    expect(toPcm(pcm, "audio/L16;codec=pcm;rate=16000").sampleRate).toBe(16000);
    expect(Buffer.compare(toPcm(pcm, null).pcm, pcm)).toBe(0);
    // An odd trailing byte is dropped so samples stay aligned.
    expect(toPcm(Buffer.concat([pcm, Buffer.from([7])]), "audio/pcm").pcm.length).toBe(pcm.length);
  });

  it("routes chat audio models and real TTS models differently", () => {
    expect(isChatAudioModel("openai/gpt-audio-mini")).toBe(true);
    expect(isChatAudioModel("openai/gpt-4o-audio-preview")).toBe(true);
    expect(isChatAudioModel("google/gemini-3.8-flash-tts")).toBe(false);
    expect(isChatAudioModel("openai/gpt-4o-mini-tts-2025-12-15")).toBe(false);
  });
});

describe("repair of the newer board tools", () => {
  it("turns bars without numbers into a list, and numbers without digits into text", () => {
    const [seg] = repairSegments(
      [
        {
          narration: "Compare the three options. The answer is many.",
          actions: [
            act({ id: "b", kind: "bars", items: ["Fast", "Cheap", "Good"], cue: "Compare" }),
            act({ id: "n", kind: "number", text: "many", cue: "The answer" }),
            act({ id: "ok", kind: "bars", items: ["A: 1", "B: 2"], cue: "three options" }),
          ],
        },
      ],
      { sceneId: "c1", sign: () => "" },
    );
    expect(seg.actions.map((a) => [a.id, a.kind])).toEqual([
      ["b", "list"],
      ["n", "text"],
      ["ok", "bars"],
    ]);
  });

  it("keeps a trace that flies between two elements", () => {
    const [seg] = repairSegments(
      [{ narration: "Energy moves from the sun to the leaf.", actions: [act({ id: "t", kind: "trace", from: "sun", to: "leaf", icon: "zap", cue: "Energy moves" })] }],
      { sceneId: "c1", sign: () => "" },
    );
    expect(seg.actions[0]).toMatchObject({ kind: "trace", from: "sun", to: "leaf", target: null });
  });
});

describe("streamed plan with chapter 1", () => {
  const chapter = (t: string) => ({ title: t, goal: "g", visual_idea: "v", misconception: null });
  const plan = {
    refusal: null,
    title: "How Wings Work",
    summary: "s",
    scope_note: null,
    clarify: null,
    chapters: [chapter("Lift"), chapter("Drag"), chapter("Thrust")],
    first_chapter: {
      segments: [
        { narration: "Air pushes the wing up.", actions: [act({ id: "w", kind: "box", text: "Wing", cue: "the wing", at: { col: 1, row: 1, w: 3, h: 1 } })] },
        { narration: "That push is called lift.", actions: [] },
      ],
    },
  };

  it("emits the plan the moment its chapters close, then chapter 1 lines, each voiced early", () => {
    const json = JSON.stringify(plan);
    const events: string[] = [];
    const p = new PlanStream((n) => `sig:${n.length}`, {
      onOutline: (o) => events.push(`plan:${o.chapters.length}`),
      onSegment: (s) => events.push(`segment:${s.id}`),
      onNarration: (v) => events.push(`voice:${v.id}:${v.narration}`),
    });
    for (let i = 0; i < json.length; i += 7) p.push(json.slice(i, i + 7));
    expect(p.finish()?.title).toBe("How Wings Work");
    expect(events).toEqual(["plan:3", "voice:c1-0:Air pushes the wing up.", "segment:c1-0", "voice:c1-1:That push is called lift.", "segment:c1-1"]);
  });

  it("still finds the plan at the end if it never closed early", () => {
    const p = new PlanStream(() => "", { onOutline: () => {}, onSegment: () => {} });
    p.push(JSON.stringify({ ...plan, first_chapter: { segments: [] } }));
    expect(p.finish()?.chapters.length).toBe(3);
  });

  it("voices early lines with the same signature the finished segment gets", () => {
    const voiced: string[] = [];
    const segs: string[] = [];
    const s = new SegmentStream("c2", (n) => `sig:${n}`, { onSegment: (seg) => segs.push(seg.sig), onNarration: (v) => voiced.push(v.sig) });
    const json = JSON.stringify({ segments: [{ narration: "**Light** is fast.", actions: [] }] });
    for (const ch of json) s.push(ch);
    expect(voiced).toEqual(["sig:Light is fast."]);
    expect(segs).toEqual(voiced);
  });
});

describe("opening line", () => {
  it("echoes question topics and stays generic for unspeakable ones", () => {
    expect(openerLine("how do airplanes fly")).toMatch(/How do airplanes fly\?/);
    expect(openerLine("photosynthesis")).toMatch(/^Photosynthesis/);
    expect(openerLine("E=mc^2 derivation")).not.toMatch(/mc/);
    expect(openerLine("how do airplanes fly")).toBe(openerLine("how do airplanes fly"));
  });
});

describe("resilience", () => {
  const line = (id: string, narration: string, kinds: string[] = []): Segment => ({
    id,
    narration,
    sig: "",
    actions: kinds.map((kind, i) => ({ id: `${kind}${i}`, kind, cue: "x", text: "x", items: kind === "timeline" ? ["1: a", "2: b"] : null, icon: kind === "icon" ? "sun" : null, at: null, from: null, to: null, target: null, color: null, expr: null }) as Action),
  });

  it("merges intro lines from a retried plan stream without repeats", () => {
    const opener = line("intro-0", "Good question. Why is the sky blue?");
    const hook = line("intro-1", "Look up on a clear day.", ["icon"]);
    const have = [opener, hook];
    // The same opener again, and a second opening question from the retry, are skipped.
    expect(mergeIntro(have, opener)).toBeNull();
    expect(mergeIntro(have, line("intro-1", "Ever wondered about the sky?", ["icon"]))).toBeNull();
    // The agenda of the retry is kept; its id moves on if the old one is taken.
    expect(mergeIntro(have, line("intro-2", "Here's our plan.", ["timeline"]))?.id).toBe("intro-2");
    expect(mergeIntro([opener], line("intro-0", "Here's our plan.", ["timeline"]))?.id).toBe("intro-1");
    expect(mergeIntro([], opener)).toBe(opener);
  });

  it("tells dropped connections from answers of the server", () => {
    expect(isNetworkError(new TypeError("Load failed"))).toBe(true);
    expect(isNetworkError({ status: 0 })).toBe(true);
    expect(isNetworkError(Object.assign(new Error("Too many requests"), { status: 429 }))).toBe(false);
    expect(isNetworkError(new SyntaxError("bad json"))).toBe(false);
  });

  it("sends Google models to AI Studio first, keeping fallbacks", () => {
    const saved = process.env.MODEL_PROVIDERS;
    try {
      delete process.env.MODEL_PROVIDERS;
      expect(routing("google/gemini-4-hydrogen")).toEqual({ order: ["google-ai-studio"], allow_fallbacks: true, require_parameters: true });
      expect(routing("openai/gpt-5")).toEqual({ require_parameters: true });
      process.env.MODEL_PROVIDERS = "google-vertex, google-ai-studio";
      expect(routing("google/gemini-4-hydrogen").order).toEqual(["google-vertex", "google-ai-studio"]);
      process.env.MODEL_PROVIDERS = "auto";
      expect(routing("google/gemini-4-hydrogen")).toEqual({ require_parameters: true });
    } finally {
      if (saved === undefined) delete process.env.MODEL_PROVIDERS;
      else process.env.MODEL_PROVIDERS = saved;
    }
  });
});
