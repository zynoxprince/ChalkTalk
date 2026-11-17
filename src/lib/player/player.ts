import type { Timeline } from "@/lib/board/timeline";

/**
 * Lesson playback state machine. The board never runs on timers: it reads
 * `time()` every frame, and time comes from the audio hardware clock, so
 * pause, seek, restart and background tabs can't drift out of sync.
 *
 *   idle ─play→ playing ⇄ paused
 *                 │  ↑
 *                 ↓  │ (audio for the next part arrives)
 *              buffering
 *                 │
 *               ended ─play→ playing (from 0)
 */

export type PlayerState = "idle" | "playing" | "paused" | "buffering" | "ended";

export interface PlayerSnapshot {
  state: PlayerState;
  time: number;
  duration: number;
  readyUntil: number;
}

/** The slice of the Web Audio API the player needs (also implemented by tests). */
export interface AudioOut {
  readonly currentTime: number;
  readonly state: string;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  createBufferSource(): AudioBufferSourceNode;
  readonly destination: AudioNode;
}

export interface PlayerOptions {
  ctx: AudioOut | null;
  /** Wall clock in seconds, used when no audio context is running. */
  now?: () => number;
}

interface Scheduled {
  node: AudioBufferSourceNode;
  start: number;
}

export class LessonPlayer {
  private tl: Timeline | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private scheduled = new Map<string, Scheduled>();
  private _state: PlayerState = "idle";
  private anchorT = 0;
  private anchorClock = 0;
  private listeners = new Set<() => void>();
  private snapshot: PlayerSnapshot = { state: "idle", time: 0, duration: 0, readyUntil: 0 };
  private ctx: AudioOut | null;
  private wall: () => number;
  private usingAudioClock = false;
  private volume = 1;

  constructor(opts: PlayerOptions) {
    this.ctx = opts.ctx;
    this.wall = opts.now ?? (() => performance.now() / 1000);
  }

  /* ------------------------------ clock ------------------------------ */

  private clock(): number {
    return this.usingAudioClock && this.ctx ? this.ctx.currentTime : this.wall();
  }

  private latency(): number {
    if (!this.usingAudioClock || !this.ctx) return 0;
    const l = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.min(0.35, Math.max(0, l));
  }

  get state(): PlayerState {
    return this._state;
  }

  get duration(): number {
    return this.tl?.duration ?? 0;
  }

  /** Lesson time the listener is hearing now (audio output lags the clock by its latency). */
  time(): number {
    if (this._state !== "playing") return this.anchorT;
    const t = this.emitTime() - this.latency();
    return Math.max(this.anchorT, Math.min(t, this.duration));
  }

  /** Lesson time being sent to the audio output right now (used for scheduling). */
  private emitTime(): number {
    return this.anchorT + (this.clock() - this.anchorClock);
  }

  /* ---------------------------- inputs ------------------------------- */

  setTimeline(tl: Timeline) {
    const prev = this.tl;
    this.tl = tl;
    if (this._state === "playing" && prev) {
      // Earlier segments may have changed length: move any future audio.
      const now = this.emitTime();
      for (const seg of tl.segments) {
        const s = this.scheduled.get(seg.id);
        if (s && s.start !== seg.start && seg.start > now + 0.05) {
          this.stopSource(seg.id);
          this.scheduleSegment(seg.id, now);
        } else if (!s && this.buffers.has(seg.id) && seg.end > now) {
          this.scheduleSegment(seg.id, now);
        }
      }
    }
    if (this._state === "buffering" && this.canPlayFrom(this.anchorT)) this.startClock();
    this.update();
  }

  setAudio(segmentId: string, buffer: AudioBuffer) {
    this.buffers.set(segmentId, buffer);
    if (this._state === "playing") {
      const seg = this.tl?.segments.find((s) => s.id === segmentId);
      const now = this.emitTime();
      if (seg && seg.end > now && !this.scheduled.has(segmentId)) this.scheduleSegment(segmentId, now);
    }
  }

  setVolume(v: number) {
    this.volume = v;
  }

  /* ---------------------------- controls ----------------------------- */

  play() {
    if (!this.tl) return;
    if (this._state === "playing") return;
    if (this._state === "ended" || this.anchorT >= this.duration - 0.05) this.anchorT = 0;
    if (!this.canPlayFrom(this.anchorT)) {
      this._state = "buffering";
      this.update();
      return;
    }
    this.startClock();
  }

  pause() {
    if (this._state === "playing" || this._state === "buffering") {
      this.anchorT = this.time();
      this.stopAll();
      this._state = "paused";
      this.update();
    }
  }

  toggle() {
    if (this._state === "playing" || this._state === "buffering") this.pause();
    else this.play();
  }

  /** Jumps to t. Positions beyond what's generated so far are clamped to the ready edge. */
  seek(t: number) {
    if (!this.tl) return;
    const limit = this.tl.complete ? this.duration : Math.max(0, this.tl.readyUntil - 0.05);
    const target = Math.max(0, Math.min(t, limit));
    const wasPlaying = this._state === "playing" || this._state === "buffering";
    this.stopAll();
    this.anchorT = target;
    if (wasPlaying) {
      this.startClock();
    } else {
      if (this._state === "ended") this._state = "paused";
      this.update();
    }
  }

  restart() {
    this.seek(0);
    if (this._state !== "playing") this.play();
  }

  /** Call every animation frame while mounted: detects buffering and the end. */
  tick() {
    if (!this.tl) return;
    if (this._state === "playing") {
      const t = this.time();
      if (t >= this.duration - 0.01 && this.tl.complete) {
        this.anchorT = this.duration;
        this.stopAll();
        this._state = "ended";
      } else if (!this.tl.complete && t >= this.tl.readyUntil - 0.02) {
        this.anchorT = Math.max(0, this.tl.readyUntil - 0.02);
        this.stopAll();
        this._state = "buffering";
      }
    }
    this.update();
  }

  dispose() {
    this.stopAll();
    this.listeners.clear();
  }

  /* --------------------------- subscription -------------------------- */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  private update() {
    const next: PlayerSnapshot = {
      state: this._state,
      time: this.time(),
      duration: this.duration,
      readyUntil: this.tl?.readyUntil ?? 0,
    };
    const s = this.snapshot;
    if (s.state !== next.state || s.time !== next.time || s.duration !== next.duration || s.readyUntil !== next.readyUntil) {
      this.snapshot = next;
      this.listeners.forEach((l) => l());
    }
  }

  /* ---------------------------- internals ---------------------------- */

  private canPlayFrom(t: number) {
    if (!this.tl) return false;
    return this.tl.complete || this.tl.readyUntil - t > 0.25;
  }

  private startClock() {
    this.usingAudioClock = !!this.ctx && this.ctx.state === "running";
    this.anchorClock = this.clock();
    this._state = "playing";
    this.stopAll();
    const t = this.anchorT;
    for (const seg of this.tl?.segments ?? []) if (seg.end > t) this.scheduleSegment(seg.id, t);
    this.update();
  }

  private scheduleSegment(id: string, now: number) {
    if (!this.ctx || !this.usingAudioClock || !this.tl || this.volume === 0) return;
    const seg = this.tl.segments.find((s) => s.id === id);
    const buffer = this.buffers.get(id);
    if (!seg || !buffer || seg.status !== "ready") return;
    const offset = Math.max(0, now - seg.start);
    if (offset >= buffer.duration) return;
    const when = this.ctx.currentTime + Math.max(0, seg.start - now);
    try {
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.ctx.destination);
      node.start(when, offset);
      this.scheduled.set(id, { node, start: seg.start });
    } catch {
      /* a failed source shouldn't stop the lesson */
    }
  }

  private stopSource(id: string) {
    const s = this.scheduled.get(id);
    if (!s) return;
    try {
      s.node.stop();
      s.node.disconnect();
    } catch {
      /* already stopped */
    }
    this.scheduled.delete(id);
  }

  private stopAll() {
    for (const id of [...this.scheduled.keys()]) this.stopSource(id);
  }
}
