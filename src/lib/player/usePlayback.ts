"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { LessonPlayer, PlayerSnapshot } from "./player";

const IDLE: PlayerSnapshot = { state: "idle", time: 0, duration: 0, readyUntil: 0 };
const noopSubscribe = () => () => {};
const idle = () => IDLE;

/** Re-renders on every animation frame while the lesson plays. */
export function usePlayback(player: LessonPlayer | null): PlayerSnapshot {
  const snap = useSyncExternalStore(player?.subscribe ?? noopSubscribe, player?.getSnapshot ?? idle, idle);
  useEffect(() => {
    if (!player) return;
    let raf = 0;
    const loop = () => {
      player.tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player]);
  return snap;
}
