"use client";

import { Board, type BoardOverlay } from "@/components/board/Board";
import { Icon } from "@/components/ui/Icon";
import type { TimedElement, Timeline } from "@/lib/board/timeline";
import type { PlayerState } from "@/lib/player/player";

export type StageMode =
  | { kind: "planning"; topic: string }
  | { kind: "lesson" }
  | { kind: "answer"; question: string; done: boolean; freshBoard: boolean };

interface BoardStageProps {
  mode: StageMode;
  timeline: Timeline | null;
  time: number;
  state: PlayerState;
  overlay?: BoardOverlay | null;
  answerTimeline?: Timeline | null;
  answerTime?: number;
  focusedId?: string | null;
  onAsk?: (el: TimedElement) => void;
  onPlay: () => void;
  onReplay: () => void;
  onQuiz?: () => void;
  onBackToLesson?: () => void;
  hasQuiz: boolean;
}

export function BoardStage(p: BoardStageProps) {
  const { mode } = p;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-black/10 bg-board shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.18)]">
      {mode.kind === "answer" && mode.freshBoard ? (
        <Board timeline={p.answerTimeline ?? null} time={p.answerTime ?? 0} className="block aspect-video w-full" />
      ) : (
        <Board
          timeline={p.timeline}
          time={p.time}
          overlay={mode.kind === "answer" ? p.overlay : null}
          interactive={mode.kind === "lesson"}
          focusedId={p.focusedId}
          onAsk={p.onAsk}
          className="block aspect-video w-full"
        />
      )}

      {mode.kind === "planning" && <PlanningOverlay topic={mode.topic} />}

      {mode.kind === "lesson" && p.state === "buffering" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <span className="flex items-center gap-2 rounded-full bg-ink/85 px-3.5 py-1.5 text-sm text-white shadow-lg backdrop-blur">
            <Icon name="loader" className="size-4 animate-spin" />
            The tutor is preparing the next part…
          </span>
        </div>
      )}

      {mode.kind === "lesson" && (p.state === "idle" || p.state === "paused") && p.time < 0.3 && p.timeline && (
        <button
          type="button"
          onClick={p.onPlay}
          className="absolute inset-0 grid place-items-center bg-board/40 backdrop-blur-[1px] transition hover:bg-board/20"
          aria-label="Start the lesson"
        >
          <span className="flex items-center gap-3 rounded-full bg-ink px-6 py-3.5 text-base font-semibold text-white shadow-xl transition group-hover:scale-105">
            <Icon name="play" className="size-5" /> Start the lesson
          </span>
        </button>
      )}

      {mode.kind === "lesson" && p.state === "ended" && (
        <div className="absolute inset-0 grid place-items-center bg-board/75 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-4 px-6 text-center">
            <p className="font-hand text-4xl font-bold text-ink sm:text-5xl">Lesson complete!</p>
            <p className="max-w-sm text-sm text-ink/70">Check what stuck with a quick quiz, ask the tutor anything, or watch it again.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {p.hasQuiz && p.onQuiz && (
                <button type="button" onClick={p.onQuiz} className="flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-indigo-700">
                  <Icon name="quiz" className="size-4" /> Take the 3-question quiz
                </button>
              )}
              <button type="button" onClick={p.onReplay} className="flex items-center gap-2 rounded-full border border-black/15 bg-white px-5 py-2.5 text-sm font-semibold text-ink hover:bg-black/5">
                <Icon name="restart" className="size-4" /> Replay
              </button>
            </div>
          </div>
        </div>
      )}

      {mode.kind === "answer" && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-gradient-to-b from-board via-board/90 to-transparent px-3 pb-6 pt-3 sm:px-4">
          <span className="flex min-w-0 items-center gap-2 rounded-full bg-marker/90 px-3 py-1 text-xs font-semibold text-ink shadow-sm sm:text-sm">
            <Icon name="hand" className="size-4 shrink-0" />
            <span className="truncate">Answering: “{mode.question}”</span>
          </span>
          <button
            type="button"
            onClick={p.onBackToLesson}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold shadow-sm transition sm:text-sm ${mode.done ? "bg-accent text-white hover:bg-indigo-700" : "bg-white text-ink ring-1 ring-black/10 hover:bg-black/5"}`}
          >
            <Icon name="restart" className="size-4" /> Back to the lesson
          </button>
        </div>
      )}
    </div>
  );
}

function PlanningOverlay({ topic }: { topic: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-board">
      <div className="flex flex-col items-center gap-5 px-6 text-center">
        <svg viewBox="0 0 220 120" className="w-48 sm:w-56" aria-hidden>
          <path
            d="M20 90 C 50 30, 80 30, 100 70 S 150 110, 170 50 S 200 30, 205 40"
            fill="none"
            stroke="#4f46e5"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray="420"
            strokeDashoffset="420"
            style={{ animation: "ct-dash 2.2s ease-in-out infinite alternate" }}
          />
          <g className="animate-float">
            <polygon points="196,36 190,22 202,22" fill="#334155" />
            <rect x="189" y="-30" width="14" height="54" rx="4" fill="#475569" />
            <rect x="189" y="-40" width="14" height="14" rx="4" fill="#6366f1" />
          </g>
        </svg>
        <div>
          <p className="font-hand text-3xl font-bold text-ink sm:text-4xl">Planning your lesson…</p>
          <p className="mt-1 max-w-md text-sm text-ink/60">
            on <span className="font-medium text-ink/80">“{topic}”</span> · the first part starts in a few seconds
          </p>
        </div>
      </div>
    </div>
  );
}
