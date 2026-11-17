"use client";

import { createElement, memo } from "react";
import { bumpScale, clamp01, easeInOutCubic, easeOutBack, easeOutCubic, formatNumber, popScale } from "@/lib/board/anim";
import type { IconNode } from "@/lib/board/icons";
import type { Part } from "@/lib/board/layout";
import type { MotionFrame } from "@/lib/board/motion";
import type { TimedElement } from "@/lib/board/timeline";
import { pointAlong } from "@/lib/board/state";
import { textWidth } from "@/lib/board/text";

function local(part: Part, p: number) {
  if (part.b <= part.a) return p >= part.a ? 1 : 0;
  return clamp01((p - part.a) / (part.b - part.a));
}

/** A glowing packet runs along each finished arrow every PACKET_EVERY seconds, taking PACKET_TRAVEL. */
const PACKET_EVERY = 3;
const PACKET_TRAVEL = 1.1;
/** Packet length as a fraction of the arrow. */
const PACKET = 0.05;

/** Deterministic pseudo-random numbers (particles start in the same places every time). */
function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bounces a coordinate back and forth inside [0, length]. */
const reflect = (v: number, length: number) => {
  const m = ((v % (2 * length)) + 2 * length) % (2 * length);
  return m <= length ? m : 2 * length - m;
};

type ParticlesPart = Extract<Part, { type: "particles" }>;
const particleCache = new WeakMap<ParticlesPart, { x0: number; y0: number; vx: number; vy: number }[]>();
function particlesOf(part: ParticlesPart) {
  let ps = particleCache.get(part);
  if (!ps) {
    ps = Array.from({ length: part.n }, (_, i) => {
      const rnd = mulberry32(part.seed + i * 7919);
      const angle = rnd() * Math.PI * 2;
      const speed = part.speed * (0.6 + rnd() * 0.8);
      return { x0: rnd() * part.w, y0: rnd() * part.h, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
    });
    particleCache.set(part, ps);
  }
  return ps;
}

function PartView({ part, lp, clipId, age, since }: { part: Part; lp: number; clipId: string; age: number; since: number }) {
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
    case "fill": {
      if (!part.origin) return <path d={part.d} fill={part.color} stroke="none" opacity={(part.opacity ?? 1) * lp} />;
      const [ox, oy] = part.origin;
      const s = done ? 1 : 0.55 + 0.45 * easeOutBack(lp);
      return <path d={part.d} fill={part.color} stroke="none" opacity={part.opacity} transform={s === 1 ? undefined : `translate(${ox} ${oy}) scale(${s}) translate(${-ox} ${-oy})`} />;
    }
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
            stroke={part.halo}
            strokeWidth={part.halo ? Math.max(4, part.size * 0.14) : undefined}
            strokeLinejoin={part.halo ? "round" : undefined}
            paintOrder={part.halo ? "stroke" : undefined}
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
      );
    }
    case "dot": {
      const [x, y] = pointAlong(part.trail, lp);
      const fade = Math.min(1, lp * 10, (1 - lp) * 7);
      return (
        <g opacity={fade}>
          {[1, 2, 3, 4, 5, 6].map((i) => {
            const [tx, ty] = pointAlong(part.trail, Math.max(0, lp - i * 0.022));
            return <circle key={i} cx={tx} cy={ty} r={part.r * (1 - i / 8)} fill={part.color} opacity={0.3 * (1 - i / 7)} />;
          })}
          {part.token ? (
            <Token x={x} y={y} color={part.color} wash={part.token.wash} icon={part.token.icon} label={part.token.label} />
          ) : (
            <>
              <circle cx={x} cy={y} r={part.r * 2.2} fill={part.color} opacity={0.18} />
              <circle cx={x} cy={y} r={part.r} fill={part.color} />
            </>
          )}
        </g>
      );
    }
    case "flow": {
      // Once the arrow is drawn, a glowing packet keeps running along it: the direction of flow.
      if (!done || age <= 0) return null;
      const phase = (age % PACKET_EVERY) / PACKET_TRAVEL;
      if (phase >= 1) return null;
      const offset = PACKET - easeInOutCubic(phase) * (1 + PACKET * 2);
      const fade = Math.min(1, age / 0.6, (1 - phase) * 6);
      return (
        <g fill="none" strokeLinecap="round" opacity={fade}>
          <path d={part.d} pathLength={1} stroke={part.color} strokeWidth={26} opacity={0.14} strokeDasharray={`${PACKET * 1.6} 3`} strokeDashoffset={offset + PACKET * 0.3} />
          <path d={part.d} pathLength={1} stroke={part.color} strokeWidth={11} strokeDasharray={`${PACKET} 3`} strokeDashoffset={offset} />
          <path d={part.d} pathLength={1} stroke="#ffffff" strokeWidth={3.5} opacity={0.8} strokeDasharray={`${PACKET * 0.5} 3`} strokeDashoffset={offset - PACKET * 0.2} />
        </g>
      );
    }
    case "ripple": {
      return (
        <g>
          <ellipse cx={part.cx} cy={part.cy} rx={part.rx} ry={part.ry} fill={part.color} opacity={0.1 * Math.sin(Math.PI * lp)} />
          {[0, 0.3].map((delay, i) => {
            const q = clamp01((lp - delay) / 0.7);
            if (q <= 0 || q >= 1) return null;
            const s = 1 + 0.45 * easeOutCubic(q);
            return <ellipse key={i} cx={part.cx} cy={part.cy} rx={part.rx * s} ry={part.ry * s} fill="none" stroke={part.color} strokeWidth={1.5 + 6 * (1 - q)} opacity={0.75 * (1 - q)} />;
          })}
        </g>
      );
    }
    case "bar": {
      // Grows up from the axis with a little overshoot; the value counts up on top.
      const g = done ? 1 : Math.max(0, easeOutBack(clamp01(lp / 0.8)));
      const hh = part.h * Math.min(1.06, g);
      const top = part.base - hh;
      const k = clamp01(lp / 0.85);
      const shown = done || !part.value.num ? part.value.text : formatNumber(part.value.num, part.value.num.value * easeOutCubic(k));
      return (
        <g>
          {!done && (
            <clipPath id={clipId}>
              <rect x={part.x - 10} y={top - 6} width={part.w + 20} height={hh + 12} />
            </clipPath>
          )}
          <g clipPath={done ? undefined : `url(#${clipId})`}>
            {part.hatch && <path d={part.hatch} fill="none" stroke={part.tint} strokeWidth={2.2} strokeLinecap="round" opacity={0.9} />}
            <path d={part.outline} fill="none" stroke={part.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text x={part.x + part.w / 2} y={top - part.value.size * 0.45} fontSize={part.value.size} fill={part.color} textAnchor="middle" fontWeight={700} className="board-text" opacity={clamp01(lp * 4)}>
            {shown}
          </text>
        </g>
      );
    }
    case "wedge": {
      // Sweeps open clockwise from 12 o'clock.
      const sweep = (part.a1 - part.a0) * (done ? 1 : easeOutCubic(lp));
      if (sweep < 0.002) return null;
      const at = (ang: number) => `${(part.cx + part.r * Math.sin(ang)).toFixed(1)} ${(part.cy - part.r * Math.cos(ang)).toFixed(1)}`;
      const d =
        sweep >= Math.PI * 2 - 1e-3
          ? `M${part.cx} ${part.cy - part.r} A${part.r} ${part.r} 0 1 1 ${part.cx} ${part.cy + part.r} A${part.r} ${part.r} 0 1 1 ${part.cx} ${part.cy - part.r} Z`
          : `M${part.cx} ${part.cy} L${at(part.a0)} A${part.r} ${part.r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${at(part.a0 + sweep)} Z`;
      return <path d={d} fill={part.tint} fillOpacity={0.9} stroke={part.color} strokeWidth={2.5} strokeLinejoin="round" />;
    }
    case "particles": {
      // Each particle bounces around the box at its own speed; they appear one by one.
      const ps = particlesOf(part);
      const shown = done ? ps.length : Math.ceil(lp * ps.length);
      return (
        <g>
          {ps.slice(0, shown).map((q, i) => (
            <circle key={i} cx={(part.x + reflect(q.x0 + q.vx * since, part.w)).toFixed(1)} cy={(part.y + reflect(q.y0 + q.vy * since, part.h)).toFixed(1)} r={part.r} fill={part.color} opacity={0.82} />
          ))}
        </g>
      );
    }
    case "count": {
      const shown = done || !part.num ? part.text : formatNumber(part.num, part.num.value * easeOutCubic(lp));
      return (
        <text x={part.x} y={part.y} fontSize={part.size} fill={part.color} textAnchor={part.anchor} fontWeight={part.weight} className="board-text" opacity={clamp01(lp * 5)}>
          {shown}
        </text>
      );
    }
  }
}

/** Something travelling along a path: a small icon in a bubble, or a word on a pill. */
function Token({ x, y, color, wash, icon, label }: { x: number; y: number; color: string; wash: string; icon: IconNode | null; label: string | null }) {
  if (icon) {
    const s = 46;
    return (
      <g transform={`translate(${x} ${y})`}>
        <circle r={s * 0.66} fill={wash} stroke={color} strokeWidth={3} />
        <g transform={`translate(${-s / 2} ${-s / 2}) scale(${s / 24})`} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round">
          {icon.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs, vectorEffect: "non-scaling-stroke", strokeWidth: 3 }))}
        </g>
      </g>
    );
  }
  const size = 30;
  const w = textWidth(label ?? "", size) + 30;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-w / 2} y={-size * 0.8} width={w} height={size * 1.6} rx={size * 0.8} fill={wash} stroke={color} strokeWidth={3} />
      <text y={size * 0.33} fontSize={size} fill={color} textAnchor="middle" fontWeight={700} className="board-text">
        {label}
      </text>
    </g>
  );
}

interface ElementViewProps {
  el: TimedElement;
  p: number;
  /** 0..1 through a bump when the narration points at this element. */
  bump: number;
  /** Seconds since it finished drawing (drives flowing arrows). */
  age: number;
  /** Seconds since it started (drives particles). */
  since: number;
  /** Transforms while a demonstration moves it. */
  motion?: MotionFrame;
  uid: string;
  interactive: boolean;
  focused: boolean;
  onAsk?: (el: TimedElement) => void;
}

function ElementViewImpl({ el, p, bump, age, since, motion, uid, interactive, focused, onAsk }: ElementViewProps) {
  const clickable = interactive && el.clickable && !!el.label && p >= 1 && !!onAsk;
  const view = (part: Part, i: number) => <PartView key={i} part={part} lp={local(part, p)} age={age} since={since} clipId={`${uid}-${el.id}-${i}`.replace(/[^a-zA-Z0-9_-]/g, "_")} />;
  // A spinning or swinging element turns its drawing, while its caption stays upright.
  const body = motion?.turn ? (
    <>
      <g transform={motion.turn}>{el.parts.map((part, i) => (part.type === "text" ? null : view(part, i)))}</g>
      {el.parts.map((part, i) => (part.type === "text" ? view(part, i) : null))}
    </>
  ) : (
    el.parts.map(view)
  );
  // Pop in as it appears; bump when something points at it.
  const s = (el.pop ? popScale(p) : 1) * bumpScale(bump);
  const cx = el.bbox.x + el.bbox.w / 2;
  const cy = el.bbox.y + el.bbox.h / 2;
  const transform = s === 1 ? undefined : `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`;
  if (!clickable) return <g transform={motion?.move}>{transform ? <g transform={transform}>{body}</g> : body}</g>;
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
      {/* The hit area moves with the element. */}
      <g transform={motion?.move}>
        <rect className="board-el-hit" x={el.bbox.x - pad} y={el.bbox.y - pad} width={el.bbox.w + pad * 2} height={el.bbox.h + pad * 2} rx={14} />
        <g transform={transform}>{body}</g>
      </g>
    </g>
  );
}

export const ElementView = memo(
  ElementViewImpl,
  (a, b) =>
    a.el === b.el &&
    a.p === b.p &&
    a.bump === b.bump &&
    a.motion?.move === b.motion?.move &&
    a.motion?.turn === b.motion?.turn &&
    // Only elements that keep moving after they're drawn need every tick of the clock.
    (!a.el.ambient || a.since === b.since) &&
    a.interactive === b.interactive &&
    a.focused === b.focused &&
    a.onAsk === b.onAsk,
);

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
