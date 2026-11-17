"use client";

import type { TimedSegment } from "@/lib/board/timeline";

/** The sentence being spoken, with words lighting up as they're said. */
export function Captions({ segment, wordIndex, className = "" }: { segment: TimedSegment | null; wordIndex: number; className?: string }) {
  return (
    <div className={`min-h-[3.25rem] text-center text-[15px] leading-relaxed sm:text-base ${className}`} aria-live="off">
      {segment ? (
        <p className="mx-auto max-w-3xl text-balance">
          {segment.words.map((w, i) => (
            <span key={i} className={`transition-colors duration-150 ${i <= wordIndex ? "text-ink" : "text-ink/35"}`}>
              {w.text}{" "}
            </span>
          ))}
        </p>
      ) : (
        <p className="text-ink/30">&nbsp;</p>
      )}
    </div>
  );
}
