"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import type { QuizItem } from "@/lib/lesson/schema";

/** Three quick questions; wrong answers link back to the part of the lesson that covers them. */
export function QuizCard({ quiz, chapterTitles, onRewatch }: { quiz: QuizItem[]; chapterTitles: string[]; onRewatch: (chapter: number) => void }) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const done = index >= quiz.length;

  if (done) {
    return (
      <div className="rounded-xl border border-black/10 bg-white p-4">
        <p className="flex items-center gap-2 font-semibold">
          <Icon name="trophy" className="size-5 text-amber-500" /> You got {score} of {quiz.length}
        </p>
        <p className="mt-1 text-sm text-ink/70">
          {score === quiz.length ? "Perfect — that idea is yours now." : "Nice work. Rewatch a part or ask the tutor about anything that's still fuzzy."}
        </p>
        <button type="button" className="mt-3 text-sm font-medium text-accent hover:underline" onClick={() => { setIndex(0); setPicked(null); setScore(0); }}>
          Try again
        </button>
      </div>
    );
  }

  const q = quiz[index];
  const answered = picked !== null;
  const correct = picked === q.answer;
  return (
    <div className="rounded-xl border border-black/10 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        Question {index + 1} of {quiz.length}
      </p>
      <p className="mt-1 font-medium leading-snug">{q.question}</p>
      <div className="mt-3 flex flex-col gap-2" role="radiogroup" aria-label={q.question}>
        {q.options.map((opt, i) => {
          const isAnswer = i === q.answer;
          const isPicked = i === picked;
          const tone = !answered
            ? "border-black/10 hover:border-accent hover:bg-accent-soft"
            : isAnswer
              ? "border-green-600 bg-green-50 text-green-900"
              : isPicked
                ? "border-red-500 bg-red-50 text-red-900"
                : "border-black/10 opacity-60";
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={isPicked}
              disabled={answered}
              onClick={() => {
                setPicked(i);
                if (i === q.answer) setScore((s) => s + 1);
              }}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${tone}`}
            >
              <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full border border-current text-[11px] font-semibold">
                {answered && isAnswer ? <Icon name="check" className="size-3" /> : answered && isPicked ? <Icon name="x" className="size-3" /> : String.fromCharCode(65 + i)}
              </span>
              {opt}
            </button>
          );
        })}
      </div>
      {answered && (
        <div className="mt-3 rounded-lg bg-paper p-3 text-sm">
          <p className={`font-semibold ${correct ? "text-green-700" : "text-red-700"}`}>{correct ? "Correct!" : "Not quite."}</p>
          <p className="mt-0.5 text-ink/80">{q.explanation}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {!correct && chapterTitles[q.chapter - 1] && (
              <button type="button" onClick={() => onRewatch(q.chapter)} className="flex items-center gap-1.5 font-medium text-accent hover:underline">
                <Icon name="restart" className="size-4" /> Rewatch “{chapterTitles[q.chapter - 1]}”
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setIndex((n) => n + 1);
                setPicked(null);
              }}
              className="ml-auto flex items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-black"
            >
              {index + 1 < quiz.length ? "Next question" : "See score"} <Icon name="arrowRight" className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
