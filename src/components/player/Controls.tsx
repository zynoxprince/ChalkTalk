"use client";

import { useCallback, useRef, useState } from "react";
import type { PlayerState } from "@/lib/player/player";
import { Icon } from "@/components/ui/Icon";

export interface Chapter {
  title: string;
  start: number;
  pending?: boolean;
}

export const fmt = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};

interface ControlsProps {
  state: PlayerState;
  time: number;
  duration: number;
  readyUntil: number;
  complete: boolean;
  chapters: Chapter[];
  captions: boolean;
  onToggle: () => void;
  onRestart: () => void;
  onSeek: (t: number) => void;
  onCaptions: () => void;
  onAsk?: () => void;
  askLabel?: string;
  disabled?: boolean;
}

export function Controls({ state, time, duration, readyUntil, complete, chapters, captions, onToggle, onRestart, onSeek, onCaptions, onAsk, askLabel = "Ask", disabled }: ControlsProps) {
  const playing = state === "playing" || state === "buffering";
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-label={playing ? "Pause (Space)" : state === "ended" ? "Replay (Space)" : "Play (Space)"}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-white shadow-sm transition hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
      >
        {state === "buffering" ? <Icon name="loader" className="size-5 animate-spin" /> : playing ? <Icon name="pause" className="size-5" /> : state === "ended" ? <Icon name="restart" className="size-5" /> : <Icon name="play" className="size-5 translate-x-px" />}
      </button>
      <button
        type="button"
        onClick={onRestart}
        disabled={disabled}
        aria-label="Restart from the beginning"
        title="Restart"
        className="grid size-9 shrink-0 place-items-center rounded-full text-ink/70 transition hover:bg-black/5 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
      >
        <Icon name="restart" className="size-[18px]" />
      </button>

      <span className="w-[4.6rem] shrink-0 text-right font-mono text-xs tabular-nums text-ink/60 sm:w-24 sm:text-sm">
        {fmt(time)} / {complete ? fmt(duration) : `~${fmt(duration)}`}
      </span>

      <SeekBar time={time} duration={duration} readyUntil={readyUntil} complete={complete} chapters={chapters} onSeek={onSeek} disabled={disabled} />

      <button
        type="button"
        onClick={onCaptions}
        aria-pressed={captions}
        aria-label={captions ? "Hide captions (C)" : "Show captions (C)"}
        title="Captions"
        className={`grid size-9 shrink-0 place-items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-accent ${captions ? "bg-accent-soft text-accent" : "text-ink/60 hover:bg-black/5 hover:text-ink"}`}
      >
        <Icon name={captions ? "captions" : "captionsOff"} className="size-[18px]" />
      </button>
      {onAsk && (
        <button
          type="button"
          onClick={onAsk}
          className="hidden shrink-0 items-center gap-1.5 rounded-full bg-marker/90 px-3.5 py-2 text-sm font-semibold text-ink shadow-sm transition hover:bg-marker focus-visible:outline-2 focus-visible:outline-accent sm:flex"
          title="Pause and ask a question (/)"
        >
          <Icon name="hand" className="size-4" />
          {askLabel}
        </button>
      )}
    </div>
  );
}

function SeekBar({ time, duration, readyUntil, complete, chapters, onSeek, disabled }: { time: number; duration: number; readyUntil: number; complete: boolean; chapters: Chapter[]; onSeek: (t: number) => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const pct = (v: number) => (duration > 0 ? Math.min(100, Math.max(0, (v / duration) * 100)) : 0);

  const timeAt = useCallback(
    (clientX: number) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r || duration <= 0) return 0;
      return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
    },
    [duration],
  );

  const chapterAt = (t: number) => {
    let c: Chapter | undefined;
    for (const ch of chapters) if (ch.start <= t + 0.01) c = ch;
    return c;
  };
  const current = chapterAt(time);
  const hoverChapter = hover !== null ? chapterAt(hover) : undefined;

  return (
    <div className="relative flex h-9 min-w-0 flex-1 items-center">
      <div
        ref={ref}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${fmt(time)} of ${fmt(duration)}${current ? `, ${current.title}` : ""}`}
        aria-disabled={disabled}
        className="group relative h-9 w-full cursor-pointer touch-none select-none outline-none"
        onPointerDown={(e) => {
          if (disabled) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setDragging(true);
          onSeek(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          setHover(timeAt(e.clientX));
          if (dragging) onSeek(timeAt(e.clientX));
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = e.shiftKey ? 15 : 5;
          if (e.key === "ArrowRight") onSeek(time + step);
          else if (e.key === "ArrowLeft") onSeek(time - step);
          else if (e.key === "Home") onSeek(0);
          else if (e.key === "End") onSeek(duration);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-black/10 transition-all group-hover:h-2 group-focus-visible:h-2">
          <div className="absolute inset-y-0 left-0 bg-black/15" style={{ width: `${pct(complete ? duration : readyUntil)}%` }} />
          <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${pct(time)}%` }} />
          {chapters.slice(1).map((c, i) => (
            <div key={i} className={`absolute inset-y-0 w-[3px] -translate-x-1/2 ${c.pending ? "bg-white/60" : "bg-paper"}`} style={{ left: `${pct(c.start)}%` }} />
          ))}
        </div>
        <div
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow ring-2 ring-white transition-transform group-hover:scale-125 group-focus-visible:scale-125"
          style={{ left: `${pct(time)}%` }}
        />
      </div>
      {hover !== null && duration > 0 && (
        <div className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs text-white shadow" style={{ left: `${pct(hover)}%` }}>
          {fmt(hover)}
          {hoverChapter ? ` · ${hoverChapter.title}` : ""}
          {!complete && hover > readyUntil ? " · preparing…" : ""}
        </div>
      )}
    </div>
  );
}
