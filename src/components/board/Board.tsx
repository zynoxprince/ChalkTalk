"use client";

import { useId, useMemo, useSyncExternalStore } from "react";
import { BOARD_H, BOARD_W } from "@/lib/board/constants";
import { frameAt, penPosition, type Frame } from "@/lib/board/state";
import type { TimedElement, Timeline } from "@/lib/board/timeline";
import { ElementView, Eraser, Pen } from "./BoardParts";

const BOARD_BG = "#fdfcf8";

export interface BoardOverlay {
  timeline: Timeline;
  time: number;
}

interface BoardProps {
  timeline: Timeline | null;
  time: number;
  /** A second timeline drawn on top (answers to questions). */
  overlay?: BoardOverlay | null;
  /** Freeze the base board fully drawn up to this time while an overlay plays. */
  interactive?: boolean;
  focusedId?: string | null;
  onAsk?: (el: TimedElement) => void;
  showPen?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const subscribeReducedMotion = (cb: () => void) => {
  const mq = window.matchMedia(reducedMotionQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** With reduced motion, elements appear fully drawn at their cue instead of animating. */
function settle(frame: Frame | null, reduced: boolean): Frame | null {
  if (!frame || !reduced) return frame;
  return { ...frame, items: frame.items.filter((i) => !i.el.transient).map((i) => ({ ...i, p: 1 })), active: null, erase: 0 };
}

export function Board({ timeline, time, overlay, interactive = false, focusedId = null, onAsk, showPen = true, className, children }: BoardProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const reduced = useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(reducedMotionQuery).matches, () => false);
  const frame: Frame | null = useMemo(() => settle(timeline ? frameAt(timeline, time) : null, reduced), [timeline, time, reduced]);
  const over: Frame | null = useMemo(() => settle(overlay ? frameAt(overlay.timeline, overlay.time) : null, reduced), [overlay, reduced]);
  // While an answer is drawn over a paused board, only the answer's pen moves.
  const pen = showPen ? penPosition(over ? over.active : (frame?.active ?? null)) : null;
  const label = frame?.scene ? `Whiteboard: ${frame.scene.title}` : "Whiteboard";

  return (
    <svg
      viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
      className={className}
      role="group"
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <pattern id={`${uid}-dots`} width="40" height="40" patternUnits="userSpaceOnUse">
          <circle cx="20" cy="20" r="1.6" fill="#e7e2d8" />
        </pattern>
        <filter id="ct-wobble" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale="3.5" />
        </filter>
      </defs>
      <rect width={BOARD_W} height={BOARD_H} fill={BOARD_BG} />
      <rect width={BOARD_W} height={BOARD_H} fill={`url(#${uid}-dots)`} />

      <g>
        {frame?.items.map(({ el, p }) => (
          <ElementView key={`${el.sceneId}:${el.id}`} el={el} p={p} uid={uid} interactive={interactive && !overlay} focused={focusedId === el.id} onAsk={onAsk} />
        ))}
      </g>

      {over && (
        <g>
          {over.items.map(({ el, p }) => (
            <ElementView key={`ov:${el.sceneId}:${el.id}`} el={el} p={p} uid={`${uid}ov`} interactive={false} focused={false} />
          ))}
        </g>
      )}

      {frame && frame.erase > 0 && !overlay && <Eraser progress={frame.erase} width={BOARD_W} height={BOARD_H} color={BOARD_BG} />}
      {pen && <Pen x={pen[0]} y={pen[1]} />}
      {children}
    </svg>
  );
}
