"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LessonSession } from "@/lib/client/session";
import type { Level } from "@/lib/lesson/schema";
import type { SampleInfo, SavedLesson } from "@/lib/lesson/saved";
import { createAudioContext, unlockAudio } from "@/lib/player/audio";
import { Landing } from "./Landing";
import { LessonView } from "./LessonView";

const noopSubscribe = () => () => {};

/** Top-level client app: the landing chat, or a lesson. */
export function ChalkTalkApp({ samples }: { samples: SampleInfo[] }) {
  const [session, setSession] = useState<LessonSession | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  const audio = () => {
    if (!ctx.current) ctx.current = createAudioContext();
    return ctx.current;
  };

  const replace = (next: LessonSession | null) => {
    setSession((prev) => {
      prev?.dispose();
      return next;
    });
  };

  /** Must be called from a click: unlocks audio, then generates a live lesson. */
  const startLive = (topic: string, level: Level) => {
    const c = audio();
    void unlockAudio(c);
    const s = new LessonSession({ topic, level, ctx: c, autoplay: true });
    replace(s);
    window.history.pushState(null, "", `/?topic=${encodeURIComponent(topic)}&level=${level}`);
    void s.startLive();
  };

  const openSample = async (slug: string, autoplay: boolean) => {
    const c = audio();
    if (autoplay) void unlockAudio(c);
    const info = samples.find((x) => x.slug === slug);
    const s = new LessonSession({ topic: info?.topic ?? slug, level: info?.level ?? "beginner", ctx: c, source: "sample", autoplay });
    replace(s);
    window.history.pushState(null, "", `/?sample=${encodeURIComponent(slug)}`);
    try {
      const res = await fetch(`/samples/${encodeURIComponent(slug)}.json`);
      if (!res.ok) throw new Error();
      await s.loadSaved((await res.json()) as SavedLesson);
    } catch {
      s.fail("This sample lesson could not be loaded.");
    }
  };

  const home = () => {
    replace(null);
    window.history.pushState(null, "", "/");
  };

  // Deep links: /?sample=slug opens a sample (it starts on the first tap, since
  // browsers block sound until a gesture); /?topic=... pre-fills the topic.
  const [initialTopic] = useState(() => (typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("topic") ?? ""));
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const slug = new URLSearchParams(window.location.search).get("sample");
    if (slug && samples.some((s) => s.slug === slug)) void openSample(slug, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (!new URLSearchParams(window.location.search).get("sample") && !new URLSearchParams(window.location.search).get("topic")) replace(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (!mounted) return <div className="min-h-dvh" />;
  if (session) return <LessonView key={session.state.topic + session.state.source} session={session} onHome={home} onNewLesson={(t) => startLive(t, session.state.level)} />;
  return <Landing initialTopic={initialTopic} samples={samples} onStart={startLive} onSample={(slug) => openSample(slug, true)} />;
}
