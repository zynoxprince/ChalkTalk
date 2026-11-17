"use client";

import { createElement, memo } from "react";
import type { Part } from "@/lib/board/layout";
import type { TimedElement } from "@/lib/board/timeline";
import { pointAlong } from "@/lib/board/state";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function local(part: Part, p: number) {
  if (part.b <= part.a) return p >= part.a ? 1 : 0;
  return clamp01((p - part.a) / (part.b - part.a));
}

function PartView({ part, lp, clipId }: { part: Part; lp: number; clipId: string }) {
  if (lp <= 0) return null;
  const done = lp >= 1;
  switch (part.type) {
    case "stroke":
      return (
        <path
          d={part.d}
          fill="none"
          stroke={part.color}
          strokeWidth={part.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={part.opacity}
          pathLength={done ? undefined : 1}
          strokeDasharray={done ? undefined : "1 1"}
          strokeDashoffset={done ? undefined : 1 - lp}
          style={part.blend ? { mixBlendMode: "multiply" } : undefined}
        />
      );
    case "fill":
      return <path d={part.d} fill={part.color} stroke="none" opacity={(part.opacity ?? 1) * lp} />;
    case "text": {
      const n = part.lines.length;
      const lh = part.size * part.lineHeight;
      return (
        <g>
          {!done && (
            <clipPath id={clipId}>
              {part.lines.map((_, i) => {
                const w = part.widths[i] ?? 0;
                const x0 = part.anchor === "middle" ? part.x - w / 2 : part.x;
                const f = clamp01(lp * n - i);
                return <rect key={i} x={x0 - 8} y={part.y + i * lh - part.size * 1.05} width={(w + 20) * f} height={lh + part.size * 0.35} />;
              })}
            </clipPath>
          )}
          <text
            x={part.x}
            y={part.y}
            fontSize={part.size}
            fill={part.color}
            textAnchor={part.anchor}
            fontWeight={part.weight}
            className="board-text"
            clipPath={done ? undefined : `url(#${clipId})`}
          >
            {part.lines.map((l, i) => (
              <tspan key={i} x={part.x} dy={i === 0 ? 0 : lh}>
                {l}
              </tspan>
            ))}
          </text>
        </g>
      );
    }
    case "icon": {
      const n = part.nodes.length;
      const s = part.size / 24;
      return (
        <g filter="url(#ct-wobble)">
          <g transform={`translate(${part.x} ${part.y}) scale(${s})`} fill="none" stroke={part.color} strokeLinecap="round" strokeLinejoin="round">
            {part.nodes.map(([tag, attrs], i) => {
              const f = clamp01(lp * n - i);
              if (f <= 0) return null;
              const finished = f >= 1;
              return createElement(tag, {
                key: i,
                ...attrs,
                vectorEffect: "non-scaling-stroke",
                strokeWidth: 4,
                pathLength: finished ? undefined : 1,
                strokeDasharray: finished ? undefined : "1 1",
                strokeDashoffset: finished ? undefined : 1 - f,
              });
            })}
          </g>
        </g>
      );
    }
    case "dot": {
      const [x, y] = pointAlong(part.trail, lp);
      return (
        <g>
          <circle cx={x} cy={y} r={part.r * 2.2} fill={part.color} opacity={0.18} />
          <circle cx={x} cy={y} r={part.r} fill={part.color} />
        </g>
      );
    }
  }
}

interface ElementViewProps {
  el: TimedElement;
  p: number;
  uid: string;
  interactive: boolean;
  focused: boolean;
  onAsk?: (el: TimedElement) => void;
}

function ElementViewImpl({ el, p, uid, interactive, focused, onAsk }: ElementViewProps) {
  const clickable = interactive && el.clickable && !!el.label && p >= 1 && !!onAsk;
  const body = el.parts.map((part, i) => <PartView key={i} part={part} lp={local(part, p)} clipId={`${uid}-${el.id}-${i}`.replace(/[^a-zA-Z0-9_-]/g, "_")} />);
  if (!clickable) return <g>{body}</g>;
  const pad = 10;
  return (
    <g
      className={`board-el${focused ? " is-focused" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Ask about “${el.label}”`}
      onClick={() => onAsk?.(el)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onAsk?.(el);
        }
      }}
    >
      <rect className="board-el-hit" x={el.bbox.x - pad} y={el.bbox.y - pad} width={el.bbox.w + pad * 2} height={el.bbox.h + pad * 2} rx={14} />
      {body}
    </g>
  );
}

export const ElementView = memo(ElementViewImpl, (a, b) => a.el === b.el && a.p === b.p && a.interactive === b.interactive && a.focused === b.focused && a.onAsk === b.onAsk);

export function Pen({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(32)`} style={{ pointerEvents: "none" }} aria-hidden>
      <g opacity={0.16} transform="translate(10 8)">
        <rect x={-9} y={-98} width={18} height={84} rx={6} fill="#000" />
      </g>
      <polygon points="0,0 -8,-17 8,-17" fill="#334155" />
      <rect x={-9} y={-86} width={18} height={70} rx={5} fill="#475569" />
      <rect x={-9} y={-100} width={18} height={18} rx={6} fill="#6366f1" />
      <rect x={-3} y={-80} width={4} height={52} rx={2} fill="#ffffff" opacity={0.25} />
    </g>
  );
}

export function Eraser({ progress, width, height, color }: { progress: number; width: number; height: number; color: string }) {
  const x = progress * (width + 160) - 80;
  const y = height * (0.18 + 0.64 * Math.abs(Math.sin(progress * Math.PI * 2.5)));
  return (
    <g style={{ pointerEvents: "none" }} aria-hidden>
      <rect x={0} y={0} width={Math.max(0, x)} height={height} fill={color} />
      <g transform={`translate(${x} ${y}) rotate(-8)`}>
        <rect x={-70} y={-38} width={140} height={76} rx={12} fill="#475569" />
        <rect x={-70} y={10} width={140} height={28} rx={8} fill="#cbd5e1" />
        <rect x={-58} y={-28} width={116} height={10} rx={5} fill="#64748b" />
      </g>
    </g>
  );
}
