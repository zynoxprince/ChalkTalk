import { describe, expect, it } from "vitest";
import { FIXTURE_SCENES } from "@/lib/lesson/fixture";
import { compileTimeline, type AudioInfo } from "@/lib/board/timeline";
import { LessonPlayer, type AudioOut } from "@/lib/player/player";

class FakeNode {
  buffer: AudioBuffer | null = null;
  started: { when: number; offset: number } | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start(when: number, offset: number) {
    this.started = { when, offset };
  }
  stop() {
    this.stopped = true;
  }
}

class FakeCtx implements AudioOut {
  currentTime = 100;
  state = "running";
  outputLatency = 0;
  baseLatency = 0;
  destination = {} as AudioNode;
  nodes: FakeNode[] = [];
  createBufferSource() {
    const n = new FakeNode();
    this.nodes.push(n);
    return n as unknown as AudioBufferSourceNode;
  }
}

const SEG = 5;
const fakeBuffer = (d = SEG) => ({ duration: d }) as AudioBuffer;

function setup(opts: { readyCount?: number; complete?: boolean } = {}) {
  const ctx = new FakeCtx();
  const segIds = FIXTURE_SCENES.flatMap((s) => s.segments.map((g) => g.id));
  const audio = new Map<string, AudioInfo>();
  segIds.slice(0, opts.readyCount ?? segIds.length).forEach((id) => audio.set(id, { duration: SEG, ok: true }));
  const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), audio, { complete: opts.complete ?? true });
  const player = new LessonPlayer({ ctx });
  player.setTimeline(tl);
  for (const id of audio.keys()) player.setAudio(id, fakeBuffer());
  return { ctx, tl, player, segIds, audio };
}

describe("LessonPlayer", () => {
  it("follows the audio clock, freezes on pause and resumes where it stopped", () => {
    const { ctx, player } = setup();
    player.play();
    expect(player.state).toBe("playing");
    ctx.currentTime += 3;
    expect(player.time()).toBeCloseTo(3);
    player.pause();
    ctx.currentTime += 10;
    expect(player.time()).toBeCloseTo(3);
    player.play();
    ctx.currentTime += 1.5;
    expect(player.time()).toBeCloseTo(4.5);
  });

  it("schedules each segment's audio at its offset", () => {
    const { ctx, tl, player } = setup();
    player.seek(tl.segments[1].start + 1);
    player.play();
    const live = ctx.nodes.filter((n) => n.started && !n.stopped);
    const current = live.find((n) => n.started!.when === ctx.currentTime && n.started!.offset > 0)!;
    expect(current.started!.offset).toBeCloseTo(1);
    const next = live.find((n) => n.started!.when > ctx.currentTime)!;
    expect(next.started!.when - ctx.currentTime).toBeCloseTo(tl.segments[2].start - (tl.segments[1].start + 1));
  });

  it("seeks while playing by restarting audio from the new position", () => {
    const { ctx, tl, player } = setup();
    player.play();
    ctx.currentTime += 2;
    const before = ctx.nodes.length;
    player.seek(tl.segments[3].start + 0.5);
    expect(player.state).toBe("playing");
    expect(ctx.nodes.slice(0, before).every((n) => n.stopped || !n.started)).toBe(true);
    expect(player.time()).toBeCloseTo(tl.segments[3].start + 0.5);
  });

  it("seeks while paused without starting playback", () => {
    const { tl, player } = setup();
    player.seek(12);
    expect(player.state).not.toBe("playing");
    expect(player.time()).toBeCloseTo(Math.min(12, tl.duration));
  });

  it("waits for missing audio, then resumes on its own", () => {
    const { ctx, tl, player, segIds, audio } = setup({ readyCount: 3, complete: false });
    player.play();
    ctx.currentTime += tl.readyUntil + 1;
    player.tick();
    expect(player.state).toBe("buffering");
    const held = player.time();
    expect(held).toBeLessThanOrEqual(tl.readyUntil);

    // The next segment's audio arrives.
    audio.set(segIds[3], { duration: SEG, ok: true });
    const tl2 = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), audio, { complete: false });
    player.setAudio(segIds[3], fakeBuffer());
    player.setTimeline(tl2);
    expect(player.state).toBe("playing");
    expect(player.time()).toBeCloseTo(held);
  });

  it("never seeks past what has been generated", () => {
    const { tl, player } = setup({ readyCount: 2, complete: false });
    player.seek(tl.duration);
    expect(player.time()).toBeLessThanOrEqual(tl.readyUntil);
  });

  it("ends at the end and restarts from zero on play", () => {
    const { ctx, tl, player } = setup();
    player.play();
    ctx.currentTime += tl.duration + 5;
    player.tick();
    expect(player.state).toBe("ended");
    expect(player.time()).toBeCloseTo(tl.duration);
    player.play();
    expect(player.state).toBe("playing");
    expect(player.time()).toBeCloseTo(0);
  });

  it("delays the visual clock by the audio output latency", () => {
    const { ctx, player } = setup();
    ctx.outputLatency = 0.2;
    player.play();
    ctx.currentTime += 2;
    expect(player.time()).toBeCloseTo(1.8);
  });

  it("falls back to the wall clock when audio can't run", () => {
    let wall = 50;
    const ctx = new FakeCtx();
    ctx.state = "suspended";
    const audio = new Map<string, AudioInfo>();
    FIXTURE_SCENES.forEach((s) => s.segments.forEach((g) => audio.set(g.id, { duration: SEG, ok: false })));
    const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), audio, { complete: true });
    const player = new LessonPlayer({ ctx, now: () => wall });
    player.setTimeline(tl);
    player.play();
    wall += 4;
    expect(player.time()).toBeCloseTo(4);
    expect(ctx.nodes.length).toBe(0);
  });
});

describe("fallback narrator", () => {
  class FakeNarrator {
    said: { id: string; text: string }[] = [];
    talking: string | null = null;
    speak(id: string, text: string) {
      this.said.push({ id, text });
      this.talking = id;
    }
    isSpeaking(id: string) {
      return this.talking === id;
    }
    cancel() {
      this.talking = null;
    }
  }

  function silentSetup() {
    let wall = 0;
    const audio = new Map<string, AudioInfo>();
    FIXTURE_SCENES.forEach((s) => s.segments.forEach((g) => audio.set(g.id, { duration: 4, ok: false })));
    const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), audio, { complete: true });
    const narrator = new FakeNarrator();
    const player = new LessonPlayer({ ctx: null, now: () => wall, narrator });
    player.setTimeline(tl);
    return { tl, player, narrator, advance: (s: number) => (wall += s) };
  }

  it("reads each voiceless line when its segment starts", () => {
    const { tl, player, narrator, advance } = silentSetup();
    player.play();
    advance(tl.segments[0].start + 0.1);
    player.tick();
    expect(narrator.said[0]).toEqual({ id: tl.segments[0].id, text: tl.segments[0].narration });
  });

  it("holds the board at the end of a line until the voice finishes", () => {
    const { tl, player, narrator, advance } = silentSetup();
    const seg = tl.segments[0];
    player.play();
    advance(seg.start + 0.1);
    player.tick();
    advance(seg.end - seg.start + 1.5); // the voice is slower than estimated
    player.tick();
    expect(player.time()).toBeLessThanOrEqual(seg.end);
    narrator.talking = null; // line finished
    player.tick();
    advance(0.5);
    player.tick();
    expect(player.time()).toBeGreaterThan(seg.end);
  });

  it("stops talking on pause and resumes mid-line from the current word", () => {
    const { tl, player, narrator, advance } = silentSetup();
    const seg = tl.segments[1];
    player.seek(seg.start + (seg.end - seg.start) * 0.6);
    player.play();
    player.tick();
    const resumed = narrator.said.at(-1)!;
    expect(resumed.id).toBe(seg.id);
    expect(resumed.text.length).toBeLessThan(seg.narration.length);
    expect(seg.narration.endsWith(resumed.text)).toBe(true);
    player.pause();
    expect(narrator.talking).toBeNull();
    advance(1);
  });
});
