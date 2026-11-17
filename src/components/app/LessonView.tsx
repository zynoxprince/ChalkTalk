"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BoardStage, type StageMode } from "./BoardStage";
import { SidePanel, type ChatMessage } from "./SidePanel";
import { Logo } from "./Logo";
import { Captions } from "@/components/player/Captions";
import { Controls, fmt } from "@/components/player/Controls";
import { Icon } from "@/components/ui/Icon";
import { frameAt } from "@/lib/board/state";
import type { TimedElement, Timeline } from "@/lib/board/timeline";
import { playAnswer, postJson, type AnswerPlayback, type LessonSession, type SessionState } from "@/lib/client/session";
import type { AnswerMode, Scene } from "@/lib/lesson/schema";
import { usePlayback } from "@/lib/player/usePlayback";

interface AnswerResponse {
  reply: string;
  mode: AnswerMode;
  confidence: "high" | "medium" | "low";
  scene: Scene | null;
  newLessonTopic: string | null;
}

interface ActiveAnswer {
  playback: AnswerPlayback;
  resumeAt: number;
  question: string;
  fresh: boolean;
}

function useSessionState(session: LessonSession): SessionState {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

export function LessonView({ session, onHome, onNewLesson }: { session: LessonSession; onHome: () => void; onNewLesson: (topic: string) => void }) {
  const s = useSessionState(session);
  const main = usePlayback(session.player);
  const [captions, setCaptions] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quizOpen, setQuizOpen] = useState(false);
  const [pointedAt, setPointedAt] = useState<{ id: string; label: string | null } | null>(null);
  const [answer, setAnswer] = useState<ActiveAnswer | null>(null);
  const [answerTl, setAnswerTl] = useState<Timeline | null>(null);
  const [busy, setBusy] = useState(false);
  const ans = usePlayback(answer?.playback.player ?? null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const history = useRef<{ q: string; a: string }[]>([]);
  const counter = useRef(0);

  const tl = s.timeline;
  const answering = !!answer && !!answerTl;
  const activeTl = answering ? answerTl : tl;
  const activeTime = answering ? ans.time : main.time;
  const frame = useMemo(() => (activeTl ? frameAt(activeTl, activeTime) : null), [activeTl, activeTime]);

  const mode: StageMode =
    s.phase === "planning"
      ? { kind: "planning", topic: s.topic }
      : answering
        ? { kind: "answer", question: answer!.question, done: ans.state === "ended", freshBoard: answer!.fresh }
        : { kind: "lesson" };

  const chapters = (tl?.scenes ?? []).map((sc) => ({ title: sc.kind === "intro" ? "Introduction" : sc.title, start: sc.start, pending: sc.pending }));

  /* ------------------------------ actions ------------------------------ */

  const endAnswer = (resume: boolean) => {
    if (!answer) return;
    answer.playback.player.dispose();
    setAnswer(null);
    setAnswerTl(null);
    if (resume) withAudio(() => session.player.play());
  };

  const ask = async (text: string) => {
    const t = session.player.time();
    session.player.pause();
    if (answer) endAnswer(false);
    const id = `answer-${++counter.current}`;
    const about = pointedAt?.label ?? null;
    setMessages((m) => [...m, { id: `${id}-q`, role: "user", text, about }, { id, role: "answer", status: "thinking", text: "" }]);
    setBusy(true);
    const frameNow = tl ? frameAt(tl, t) : null;
    const spoken = (tl?.segments ?? []).filter((g) => g.start <= t).map((g) => g.narration).join(" ");
    const board = session
      .boardAt(t)
      .filter((e) => e.kind !== "title")
      .slice(0, 50)
      .map((e) => ({ id: e.id, kind: e.kind, label: e.label ? e.label.slice(0, 110) : null }));
    try {
      const res = await postJson<AnswerResponse>("/api/ask", {
        topic: s.topic,
        level: s.level,
        title: s.title,
        chapterTitle: frameNow?.scene?.title ?? s.title,
        time: fmt(t),
        recentNarration: spoken.split(/\s+/).slice(-90).join(" "),
        board,
        pointedAt: pointedAt ? { id: pointedAt.id, label: pointedAt.label?.slice(0, 110) ?? null } : null,
        history: history.current.slice(-4),
        question: text,
        answerId: id,
      });
      history.current.push({ q: text, a: res.reply.slice(0, 700) });
      setMessages((m) => m.map((x) => (x.id === id ? { id, role: "answer", status: "done", text: res.reply, confidence: res.confidence, newLessonTopic: res.newLessonTopic } : x)));
      if (res.scene && res.scene.segments.length) {
        const fresh = res.mode === "new_board";
        const playback = playAnswer(res.scene, fresh ? [] : session.boardAt(t), session.audioContext, setAnswerTl, session.fallbackNarrator);
        setAnswer({ playback, resumeAt: t, question: text, fresh });
        setAnswerTl(playback.timeline);
        playback.player.play();
      }
    } catch (e) {
      setMessages((m) => m.map((x) => (x.id === id ? { id, role: "answer", status: "error", text: (e as Error).message } : x)));
    } finally {
      setBusy(false);
      setPointedAt(null);
    }
  };

  const [draft, setDraft] = useState("");
  const askAbout = (el: TimedElement) => {
    session.player.pause();
    setPointedAt({ id: el.id, label: el.label });
    setDraft(`Can you explain “${el.label}” in more detail?`);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openQuiz = () => {
    if (!quizOpen) setMessages((m) => [...m, { id: "quiz", role: "quiz" }]);
    setQuizOpen(true);
  };

  const rewatch = (chapter: number) => {
    const sc = tl?.scenes.find((x) => x.id === `c${chapter}`);
    if (!sc) return;
    endAnswer(false);
    session.player.seek(sc.start);
    session.player.play();
  };

  const controls = answering ? answer!.playback.player : session.player;
  const snap = answering ? ans : main;
  /** Browsers only allow sound after a gesture: unlock audio, then act. */
  const withAudio = (fn: () => void) => {
    session.unlock().finally(fn);
  };

  /* --------------------------- keyboard shortcuts ------------------------ */

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    const typing = el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
    if (e.key === "Escape") {
      if (answering) endAnswer(true);
      else if (typing) el?.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === " " || e.key === "k") {
      if (el && (el.tagName === "BUTTON" || el.getAttribute("role") === "slider")) return;
      e.preventDefault();
      withAudio(() => controls.toggle());
    } else if (e.key === "ArrowRight" || e.key === "l") {
      if (el?.getAttribute("role") === "slider") return;
      controls.seek(controls.time() + 5);
    } else if (e.key === "ArrowLeft" || e.key === "j") {
      if (el?.getAttribute("role") === "slider") return;
      controls.seek(controls.time() - 5);
    } else if (e.key === "c") {
      setCaptions((c) => !c);
    } else if (e.key === "/" || e.key === "?") {
      e.preventDefault();
      session.player.pause();
      inputRef.current?.focus();
    } else if (e.key === "r") {
      withAudio(() => controls.restart());
    }
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* -------------------------------- view -------------------------------- */

  const thread: ChatMessage[] = [
    { id: "topic", role: "user", text: s.topic },
    { id: "lesson", role: "lesson" },
    ...(s.clarify ? [{ id: "clarify", role: "note" as const, text: `${s.clarify.question} I went with the most likely meaning — or pick one:`, options: s.clarify.options }] : []),
    ...messages,
  ];

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[1500px] flex-col gap-3 p-3 sm:p-4 lg:gap-4">
      <header className="flex shrink-0 items-center gap-3">
        <button type="button" onClick={onHome} className="shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-accent" aria-label="ChalkTalk home">
          <Logo />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink/80 sm:text-base">{s.title || s.topic}</p>
        </div>
        <span className={`hidden shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium sm:flex ${s.source === "sample" ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
          <span className={`size-1.5 rounded-full ${s.source === "sample" ? "bg-amber-500" : "bg-green-500"}`} />
          {s.source === "sample" ? "Sample lesson" : "Live AI lesson"}
        </span>
        <button type="button" onClick={onHome} className="flex shrink-0 items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm font-medium hover:bg-black/5">
          <Icon name="plus" className="size-4" /> <span className="hidden sm:inline">New lesson</span>
        </button>
      </header>

      {s.phase === "error" ? (
        <ErrorCard state={s} onHome={onHome} onRetry={() => onNewLesson(s.topic)} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-4">
          <section className="flex min-h-0 flex-col gap-2 lg:overflow-y-auto" aria-label="Lesson">
            <BoardStage
              mode={mode}
              timeline={tl}
              time={answering ? answer!.resumeAt : main.time}
              state={main.state}
              overlay={answering && answerTl ? { timeline: answerTl, time: ans.time } : null}
              answerTimeline={answerTl}
              answerTime={ans.time}
              focusedId={pointedAt?.id ?? null}
              onAsk={askAbout}
              onPlay={() => withAudio(() => session.player.play())}
              onReplay={() => withAudio(() => session.player.restart())}
              onQuiz={s.quiz.length ? openQuiz : undefined}
              onBackToLesson={() => endAnswer(true)}
              hasQuiz={s.quiz.length > 0}
            />
            {captions && <Captions segment={frame?.segment ?? null} wordIndex={frame?.wordIndex ?? -1} className="px-2" />}
            <div className="rounded-2xl border border-black/10 bg-white/80 px-2 py-1.5 shadow-sm sm:px-3">
              <Controls
                state={snap.state}
                time={snap.time}
                duration={answering ? (answerTl?.duration ?? 0) : (tl?.duration ?? 0)}
                readyUntil={answering ? (answerTl?.readyUntil ?? 0) : (tl?.readyUntil ?? 0)}
                complete={answering ? !!answerTl?.complete : !!tl?.complete}
                chapters={answering ? [] : chapters}
                captions={captions}
                disabled={s.phase === "planning"}
                onToggle={() => withAudio(() => controls.toggle())}
                onRestart={() => withAudio(() => controls.restart())}
                onSeek={(t) => controls.seek(t)}
                onCaptions={() => setCaptions((c) => !c)}
                onAsk={() => {
                  session.player.pause();
                  inputRef.current?.focus();
                }}
                askLabel="Raise hand"
              />
            </div>
            <p className="hidden px-2 text-xs text-ink/45 lg:block">
              Shortcuts: <kbd className="font-mono">Space</kbd> play/pause · <kbd className="font-mono">←</kbd>/<kbd className="font-mono">→</kbd> 5 s · <kbd className="font-mono">/</kbd> ask ·{" "}
              <kbd className="font-mono">C</kbd> captions · <kbd className="font-mono">R</kbd> restart
            </p>
          </section>

          <SidePanel
            session={s}
            messages={thread}
            timeline={tl}
            time={main.time}
            pointedAt={pointedAt}
            busy={busy}
            inputRef={inputRef}
            draft={draft}
            onDraft={setDraft}
            onSeek={(t) => {
              if (answering) endAnswer(false);
              session.player.seek(t);
            }}
            onAsk={ask}
            onClearPointedAt={() => setPointedAt(null)}
            onNewLesson={onNewLesson}
            onRewatch={rewatch}
            onRetryChapter={(i) => session.retryChapter(i)}
            onInputFocus={() => session.player.pause()}
            onOpenQuiz={s.quiz.length ? openQuiz : undefined}
          />
        </div>
      )}
    </div>
  );
}

function ErrorCard({ state, onHome, onRetry }: { state: SessionState; onHome: () => void; onRetry: () => void }) {
  const refused = !!state.refusal;
  return (
    <div className="grid flex-1 place-items-center">
      <div className="max-w-md rounded-2xl border border-black/10 bg-white p-6 text-center shadow-sm">
        <p className="font-hand text-3xl font-bold">{refused ? "Let's pick another topic" : "That didn't work"}</p>
        <p className="mt-2 text-sm text-ink/70">{state.error}</p>
        <div className="mt-5 flex justify-center gap-2">
          {!refused && (
            <button type="button" onClick={onRetry} className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
              <Icon name="refresh" className="size-4" /> Try again
            </button>
          )}
          <button type="button" onClick={onHome} className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold hover:bg-black/5">
            Choose a topic
          </button>
        </div>
      </div>
    </div>
  );
}
