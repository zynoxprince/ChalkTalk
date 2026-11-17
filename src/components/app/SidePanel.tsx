"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "@/components/ui/Icon";
import { fmt } from "@/components/player/Controls";
import type { SessionState } from "@/lib/client/session";
import type { Timeline } from "@/lib/board/timeline";
import { segmentAt } from "@/lib/board/state";
import { QuizCard } from "./QuizCard";

export type ChatMessage =
  | { id: string; role: "user"; text: string; about?: string | null }
  | { id: string; role: "lesson" }
  | { id: string; role: "answer"; status: "thinking" | "done" | "error"; text: string; confidence?: "high" | "medium" | "low"; newLessonTopic?: string | null }
  | { id: string; role: "quiz" }
  | { id: string; role: "note"; text: string; options?: string[] };

interface SidePanelProps {
  session: SessionState;
  messages: ChatMessage[];
  timeline: Timeline | null;
  time: number;
  pointedAt: { id: string; label: string | null } | null;
  busy: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSeek: (t: number) => void;
  onAsk: (text: string) => void;
  onClearPointedAt: () => void;
  onNewLesson: (topic: string) => void;
  onRewatch: (chapter: number) => void;
  onRetryChapter: (index: number) => void;
  onInputFocus: () => void;
  draft: string;
  onDraft: (v: string) => void;
  onOpenQuiz?: () => void;
}

export function SidePanel(p: SidePanelProps) {
  const [tab, setTab] = useState<"tutor" | "transcript">("tutor");
  return (
    <aside className="flex h-[34rem] flex-col overflow-hidden rounded-2xl border border-black/10 bg-white/80 shadow-sm lg:h-full lg:min-h-0">
      <div className="flex shrink-0 gap-1 border-b border-black/5 p-1.5" role="tablist" aria-label="Side panel">
        {(["tutor", "transcript"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === t ? "bg-ink text-white" : "text-ink/60 hover:bg-black/5 hover:text-ink"}`}
          >
            <Icon name={t === "tutor" ? "chat" : "book"} className="size-4" />
            {t === "tutor" ? "Tutor" : "Transcript"}
          </button>
        ))}
      </div>
      {tab === "tutor" ? <TutorTab {...p} /> : <TranscriptTab timeline={p.timeline} time={p.time} onSeek={p.onSeek} />}
    </aside>
  );
}

type PanelData = Omit<SidePanelProps, "inputRef">;

function TutorTab({ inputRef, ...p }: SidePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const draft = p.draft;
  const setDraft = p.onDraft;
  const count = p.messages.length;
  const last = p.messages[count - 1];
  const lastKey = last ? `${last.id}:${last.role === "answer" ? last.status : ""}` : "";

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lastKey]);

  const submit = () => {
    const text = draft.trim();
    if (!text || p.busy) return;
    p.onAsk(text);
    setDraft("");
  };

  return (
    <>
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4">
        {p.messages.map((m) => (
          <Message key={m.id} m={m} {...p} />
        ))}
      </div>
      <form
        className="shrink-0 border-t border-black/5 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {p.pointedAt && (
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 font-medium text-accent">
              <Icon name="pointer" className="size-3.5 shrink-0" />
              <span className="truncate">About: {p.pointedAt.label}</span>
            </span>
            <button type="button" onClick={p.onClearPointedAt} className="text-ink/50 hover:text-ink" aria-label="Stop pointing at this element">
              <Icon name="x" className="size-3.5" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-black/15 bg-white p-1.5 pl-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            maxLength={400}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={p.onInputFocus}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={p.busy ? "The tutor is answering…" : "Ask the tutor anything…"}
            aria-label="Ask the tutor a question"
            className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-ink/40"
          />
          <button
            type="submit"
            disabled={!draft.trim() || p.busy}
            aria-label="Send question"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-white transition hover:bg-indigo-700 disabled:bg-black/10 disabled:text-ink/40"
          >
            <Icon name="arrowUp" className="size-4" />
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-ink/45">The lesson pauses while you ask. Tip: click anything on the board to ask about it.</p>
      </form>
    </>
  );
}

function Message({ m, ...p }: { m: ChatMessage } & PanelData) {
  switch (m.role) {
    case "user":
      return (
        <div className="ml-8 self-end rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[15px] text-white">
          {m.about && <p className="mb-0.5 text-xs text-white/60">About “{m.about}”</p>}
          {m.text}
        </div>
      );
    case "lesson":
      return <LessonCard {...p} />;
    case "answer":
      return (
        <div className="mr-6 flex gap-2">
          <TutorAvatar />
          <div className="min-w-0 rounded-2xl rounded-tl-md bg-paper px-3.5 py-2 text-[15px]">
            {m.status === "thinking" ? (
              <span className="flex items-center gap-1 py-1" aria-label="The tutor is thinking">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1.5 animate-bounce rounded-full bg-ink/50" style={{ animationDelay: `${i * 120}ms` }} />
                ))}
              </span>
            ) : (
              <>
                <p className={m.status === "error" ? "text-red-700" : ""}>{m.text}</p>
                {m.confidence === "low" && (
                  <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-700">
                    <Icon name="alert" className="size-3.5" /> I&apos;m not fully sure about this one — worth double-checking.
                  </p>
                )}
                {m.newLessonTopic && (
                  <button type="button" onClick={() => p.onNewLesson(m.newLessonTopic!)} className="mt-2 flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
                    <Icon name="sparkles" className="size-4" /> Start a lesson on “{m.newLessonTopic}”
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      );
    case "quiz":
      return p.session.quiz.length ? (
        <div className="flex gap-2">
          <TutorAvatar />
          <div className="min-w-0 flex-1">
            <QuizCard quiz={p.session.quiz} chapterTitles={p.session.chapters.map((c) => c.title)} onRewatch={p.onRewatch} />
          </div>
        </div>
      ) : null;
    case "note":
      return (
        <div className="mr-6 flex gap-2">
          <TutorAvatar />
          <div className="rounded-2xl rounded-tl-md bg-paper px-3.5 py-2 text-[15px]">
            <p>{m.text}</p>
            {m.options && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.options.map((o) => (
                  <button key={o} type="button" onClick={() => p.onNewLesson(o)} className="rounded-full border border-black/15 bg-white px-2.5 py-1 text-xs font-medium hover:border-accent hover:text-accent">
                    {o}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      );
  }
}

function TutorAvatar() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-marker text-ink" aria-hidden>
      <Icon name="pen" className="size-3.5" />
    </span>
  );
}

function LessonCard(p: PanelData) {
  const s = p.session;
  const tl = p.timeline;
  const generating = s.source === "live" && (s.scenes.some((x) => x.status === "pending" || x.status === "streaming") || s.voice.ready < s.voice.total);
  return (
    <div className="flex gap-2">
      <TutorAvatar />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-paper p-3.5">
        <p className="font-hand text-2xl font-bold leading-tight">{s.title || "Your lesson"}</p>
        {s.summary && <p className="mt-1 text-sm text-ink/70">{s.summary}</p>}
        {s.scopeNote && (
          <p className="mt-2 flex gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs text-ink/70">
            <Icon name="info" className="mt-px size-3.5 shrink-0" /> {s.scopeNote}
          </p>
        )}
        <ol className="mt-3 flex flex-col gap-0.5">
          {s.scenes.map((sc, i) => {
            const ts = tl?.scenes.find((x) => x.id === sc.scene.id);
            const active = ts && p.time >= ts.start && p.time < ts.end;
            const label = sc.scene.kind === "intro" ? "Introduction" : sc.scene.kind === "recap" ? "Recap" : sc.scene.title;
            return (
              <li key={sc.scene.id}>
                <button
                  type="button"
                  disabled={(sc.status !== "ready" && sc.status !== "streaming") || !ts || (!tl?.complete && ts.start > (tl?.readyUntil ?? 0))}
                  onClick={() => ts && p.onSeek(ts.start)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition enabled:hover:bg-white ${active ? "bg-white font-semibold shadow-sm" : ""}`}
                >
                  <span className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${active ? "bg-accent text-white" : "bg-black/5 text-ink/60"}`}>
                    {sc.scene.kind === "intro" ? "★" : sc.scene.kind === "recap" ? "✓" : i}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {sc.status === "pending" || sc.status === "streaming" ? (
                    <span className="flex items-center gap-1 text-xs text-ink/50">
                      <Icon name="loader" className="size-3.5 animate-spin" /> writing
                    </span>
                  ) : sc.status === "failed" ? (
                    sc.scene.kind === "chapter" ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onRetryChapter(i - 1);
                        }}
                        className="text-xs font-medium text-red-700 hover:underline"
                      >
                        retry
                      </span>
                    ) : (
                      <span className="text-xs text-ink/40">skipped</span>
                    )
                  ) : (
                    ts && <span className="font-mono text-xs tabular-nums text-ink/50">{fmt(ts.start)}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink/50">
          {s.source === "sample" ? (
            <>
              <Icon name="bulb" className="size-3.5" /> Sample lesson, pre-generated by the same AI pipeline (no waiting).
            </>
          ) : generating ? (
            <>
              <Icon name="loader" className="size-3.5 animate-spin" /> Live AI lesson · voicing {Math.min(s.voice.ready, s.voice.total)}/{s.voice.total} lines
            </>
          ) : (
            <>
              <Icon name="sparkles" className="size-3.5" /> Live AI lesson, generated just now
            </>
          )}
        </p>
        {p.onOpenQuiz && (
          <button type="button" onClick={p.onOpenQuiz} className="mt-3 flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-accent shadow-sm ring-1 ring-black/5 hover:bg-accent-soft">
            <Icon name="quiz" className="size-3.5" /> Check your understanding (3 questions)
          </button>
        )}
        {s.degraded && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-700">
            <Icon name="captions" className="size-3.5" /> The AI voice is unavailable right now, so your browser&apos;s voice reads some lines (captions are on).
          </p>
        )}
      </div>
    </div>
  );
}

function TranscriptTab({ timeline, time, onSeek }: { timeline: Timeline | null; time: number; onSeek: (t: number) => void }) {
  const current = timeline ? segmentAt(timeline, time) : null;
  const activeRef = useRef<HTMLButtonElement>(null);
  const currentId = current?.id;
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentId]);
  if (!timeline) return <p className="p-4 text-sm text-ink/50">The transcript appears as the lesson is written.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
      {timeline.scenes.map((sc) => {
        const segs = timeline.segments.filter((s) => s.sceneId === sc.id);
        return (
          <section key={sc.id} className="mb-4">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink/45">{sc.kind === "intro" ? "Introduction" : sc.title}</h3>
            {sc.pending ? (
              <p className="flex items-center gap-1.5 text-sm text-ink/45">
                <Icon name="loader" className="size-3.5 animate-spin" /> Being written…
              </p>
            ) : (
              segs.map((s) => {
                const active = s.id === currentId;
                const reachable = timeline.complete || s.start < timeline.readyUntil;
                return (
                  <button
                    key={s.id}
                    ref={active ? activeRef : undefined}
                    type="button"
                    disabled={!reachable}
                    onClick={() => onSeek(s.start)}
                    className={`mb-1 block w-full rounded-lg px-2 py-1.5 text-left text-[15px] leading-relaxed transition enabled:hover:bg-black/5 ${active ? "bg-accent-soft text-ink" : "text-ink/75"} disabled:opacity-50`}
                  >
                    <span className="mr-2 font-mono text-[11px] text-ink/40">{fmt(s.start)}</span>
                    {s.narration}
                  </button>
                );
              })
            )}
          </section>
        );
      })}
    </div>
  );
}
