"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Board } from "@/components/board/Board";
import { Captions } from "@/components/player/Captions";
import { Controls } from "@/components/player/Controls";
import { FIXTURE_SCENES } from "@/lib/lesson/fixture";
import { compileTimeline, estimateDuration, type AudioInfo } from "@/lib/board/timeline";
import { frameAt } from "@/lib/board/state";
import { LessonPlayer } from "@/lib/player/player";
import { usePlayback } from "@/lib/player/usePlayback";

const noopSubscribe = () => () => {};

/**
 * Engine playground: plays a hand-written lesson with no AI and no audio
 * (wall clock). Append ?t=12.5 to freeze a moment, handy for visual checks.
 */
export default function Playground() {
  const timeline = useMemo(() => {
    const audio = new Map<string, AudioInfo>();
    for (const s of FIXTURE_SCENES) for (const g of s.segments) audio.set(g.id, { duration: estimateDuration(g.narration), ok: false });
    return compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), audio, { complete: true });
  }, []);
  const [player] = useState(() => new LessonPlayer({ ctx: null }));
  const [captions, setCaptions] = useState(true);
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [frozen, setFrozen] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const t = parseFloat(new URLSearchParams(window.location.search).get("t") ?? "");
    return Number.isNaN(t) ? null : t;
  });

  useEffect(() => {
    player.setTimeline(timeline);
    if (frozen !== null) player.seek(frozen);
    // Only on mount: later seeks come from the controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, timeline]);

  const snap = usePlayback(player);
  if (!mounted) return null;
  const time = frozen ?? snap.time;
  const frame = frameAt(timeline, time);
  const chapters = timeline.scenes.map((s) => ({ title: s.title, start: s.start }));
  const warnings = timeline.scenes.flatMap((s) => s.warnings);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Engine playground</h1>
        <p className="text-sm text-ink/60">Hand-written lesson · no AI · silent clock</p>
      </header>
      <div className="overflow-hidden rounded-2xl border border-black/10 bg-board shadow-sm">
        <Board timeline={timeline} time={time} interactive onAsk={(el) => alert(`Ask about: ${el.label}`)} className="block aspect-video w-full" />
      </div>
      {captions && <Captions segment={frame.segment} wordIndex={frame.wordIndex} />}
      <Controls
        state={snap.state}
        time={time}
        duration={timeline.duration}
        readyUntil={timeline.readyUntil}
        complete={timeline.complete}
        chapters={chapters}
        captions={captions}
        onToggle={() => {
          setFrozen(null);
          player.toggle();
        }}
        onRestart={() => {
          setFrozen(null);
          player.restart();
        }}
        onSeek={(t) => {
          setFrozen(null);
          player.seek(t);
        }}
        onCaptions={() => setCaptions((c) => !c)}
      />
      {warnings.length > 0 && <pre className="text-xs text-red-700">{warnings.join("\n")}</pre>}
    </main>
  );
}
