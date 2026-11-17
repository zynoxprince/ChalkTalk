"use client";

import { useId, useMemo, useSyncExternalStore } from "react";
import { FULL_VIEW } from "@/lib/board/camera";
import { BOARD_BG, BOARD_H, BOARD_W } from "@/lib/board/constants";
import { frameAt, penPosition, type Frame } from "@/lib/board/state";
import type { TimedElement, Timeline } from "@/lib/board/timeline";
import { ElementView, Eraser, Pen } from "./BoardParts";

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
  /** Follow the action with the camera (zoom and pan). Defaults to true. */
  camera?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const subscribeReducedMotion = (cb: () => void) => {
  const mq = window.matchMedia(reducedMotionQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** With reduced motion, elements appear fully drawn at their cue, nothing moves and the camera stays put. */
function settle(frame: Frame | null, reduced: boolean): Frame | null {
  if (!frame || !reduced) return frame;
  return { ...frame, items: frame.items.filter((i) => !i.el.transient).map((i) => ({ ...i, p: 1, bump: 0, age: 0 })), active: null, erase: 0, view: FULL_VIEW };
}

export function Board({ timeline, time, overlay, interactive = false, focusedId = null, onAsk, showPen = true, camera = true, className, children }: BoardProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const reduced = useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(reducedMotionQuery).matches, () => false);
  const frame: Frame | null = useMemo(() => settle(timeline ? frameAt(timeline, time) : null, reduced), [timeline, time, reduced]);
  const over: Frame | null = useMemo(() => settle(overlay ? frameAt(overlay.timeline, overlay.time) : null, reduced), [overlay, reduced]);
  // While an answer is drawn over a paused board, only the answer's pen moves.
  const pen = showPen ? penPosition(over ? over.active : (frame?.active ?? null)) : null;
  const label = frame?.scene ? `Whiteboard: ${frame.scene.title}` : "Whiteboard";
  // Answers are drawn over the whole board, so the camera steps back for them.
  const view = camera && frame && !over ? frame.view : FULL_VIEW;

  return (
    <svg
      viewBox={`${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`}
      className={className}
      role="group"
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <pattern id={`${uid}-dots`} width="40" height="40" patternUnits="userSpaceOnUse">
          <circle cx="20" cy="20" r="1.6" fill="#e7e2d8" />
        </pattern>
      </defs>
      <rect width={BOARD_W} height={BOARD_H} fill={BOARD_BG} />
      <rect width={BOARD_W} height={BOARD_H} fill={`url(#${uid}-dots)`} />

      <g>
        {frame?.items.map(({ el, p, bump, age }) => (
          <ElementView key={`${el.sceneId}:${el.id}`} el={el} p={p} bump={bump} age={age} uid={uid} interactive={interactive && !overlay} focused={focusedId === el.id} onAsk={onAsk} />
        ))}
      </g>

      {over && (
        <g>
          {over.items.map(({ el, p, bump, age }) => (
            <ElementView key={`ov:${el.sceneId}:${el.id}`} el={el} p={p} bump={bump} age={age} uid={`${uid}ov`} interactive={false} focused={false} />
          ))}
        </g>
      )}

      {frame && frame.erase > 0 && !overlay && <Eraser progress={frame.erase} width={BOARD_W} height={BOARD_H} color={BOARD_BG} />}
      {pen && <Pen x={pen[0]} y={pen[1]} />}
      {children}
    </svg>
  );
}
