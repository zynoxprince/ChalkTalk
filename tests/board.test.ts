import { describe, expect, it } from "vitest";
import { FIXTURE_SCENES } from "@/lib/lesson/fixture";
import { layoutScene, Occupancy, parseBars, placeCell, cellRect } from "@/lib/board/layout";
import { cameraAt, frame, FULL_VIEW, MAX_ZOOM, planCamera } from "@/lib/board/camera";
import { countsUp, formatNumber, parseNumber } from "@/lib/board/anim";
import type { Action } from "@/lib/lesson/schema";
import { compileTimeline, findCue, fractionAt, type AudioInfo } from "@/lib/board/timeline";
import { frameAt, pointAlong } from "@/lib/board/state";
import { fitText, wrap } from "@/lib/board/text";
import { compileExpr, parsePlot } from "@/lib/board/expr";
import { resolveIcon } from "@/lib/board/icons";
import { BOARD_H, BOARD_W } from "@/lib/board/constants";
import { parseSketch } from "@/lib/board/sketch";
import { motionTransform } from "@/lib/board/motion";

const allReady = (secondsPerSegment = 6) => {
  const m = new Map<string, AudioInfo>();
  for (const s of FIXTURE_SCENES) for (const seg of s.segments) m.set(seg.id, { duration: secondsPerSegment, ok: true });
  return m;
};

describe("layout", () => {
  it("places every fixture element on the board without warnings", () => {
    for (const scene of FIXTURE_SCENES) {
      const { elements, warnings } = layoutScene(scene.segments.flatMap((s) => s.actions), { title: scene.title });
      expect(warnings).toEqual([]);
      expect(elements.length).toBeGreaterThan(1);
      for (const e of elements) {
        expect(e.bbox.x).toBeGreaterThanOrEqual(-1);
        expect(e.bbox.y).toBeGreaterThanOrEqual(-1);
        expect(e.bbox.x + e.bbox.w).toBeLessThanOrEqual(BOARD_W + 1);
        expect(e.bbox.y + e.bbox.h).toBeLessThanOrEqual(BOARD_H + 1);
      }
    }
  });

  it("moves an element that would overlap another to a free slot", () => {
    const occ = new Occupancy();
    const a = placeCell(occ, { col: 2, row: 1, w: 4, h: 2 }, "box");
    const b = placeCell(occ, { col: 3, row: 2, w: 4, h: 2 }, "box");
    expect(a).toEqual({ col: 2, row: 1, w: 4, h: 2 });
    const ra = cellRect(a);
    const rb = cellRect(b);
    const overlap = ra.x < rb.x + rb.w && rb.x < ra.x + ra.w && ra.y < rb.y + rb.h && rb.y < ra.y + ra.h;
    expect(overlap).toBe(false);
  });

  it("clamps out-of-range cells onto the grid", () => {
    const occ = new Occupancy();
    expect(placeCell(occ, { col: 20, row: -3, w: 40, h: 2 }, "text")).toEqual({ col: 0, row: 0, w: 12, h: 2 });
  });

  it("resolves composite parts and labels as annotation targets", () => {
    const { elements, warnings } = layoutScene([
      { id: "f", kind: "flow", cue: "x", text: null, items: ["Alpha", "Beta", "Gamma"], icon: null, at: { col: 0, row: 0, w: 12, h: 2 }, from: null, to: null, target: null, color: null, expr: null },
      { id: "h", kind: "circle_around", cue: "x", text: null, items: null, icon: null, at: null, from: null, to: null, target: "f[1]", color: null, expr: null },
      { id: "u", kind: "underline", cue: "x", text: null, items: null, icon: null, at: null, from: null, to: null, target: "gamma", color: null, expr: null },
    ]);
    expect(warnings).toEqual([]);
    expect(elements.map((e) => e.id)).toEqual(expect.arrayContaining(["f.0", "f.1", "f.2", "f.a0", "f.a1", "h", "u"]));
  });

  it("reports unknown references instead of drawing them", () => {
    const { elements, warnings } = layoutScene([
      { id: "a", kind: "arrow", cue: "x", text: null, items: null, icon: null, at: null, from: "nope", to: "nada", target: null, color: null, expr: null },
    ]);
    expect(elements).toEqual([]);
    expect(warnings[0]).toMatch(/unknown/);
  });
});

describe("cue timing", () => {
  const n = "Picture a leaf in sunlight. It takes in light from the sun, water from the roots.";

  it("finds cues regardless of case and punctuation", () => {
    expect(findCue(n, "picture a leaf")).toBe(0);
    expect(findCue(n, "Sun water")).toBeGreaterThan(40);
    expect(findCue(n, "light from the sun")).toBe(n.indexOf("light from"));
    expect(findCue(n, "completely absent phrase")).toBeNull();
  });

  it("maps later characters to later fractions, monotonically", () => {
    const f1 = fractionAt(n, n.indexOf("leaf"));
    const f2 = fractionAt(n, n.indexOf("light from"));
    const f3 = fractionAt(n, n.indexOf("roots"));
    expect(0 < f1 && f1 < f2 && f2 < f3 && f3 < 1).toBe(true);
  });
});

describe("timeline", () => {
  it("lays segments end to end with gaps and orders boards", () => {
    const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), allReady(6), { complete: true });
    for (let i = 1; i < tl.segments.length; i++) expect(tl.segments[i].start).toBeGreaterThan(tl.segments[i - 1].end);
    for (let i = 1; i < tl.scenes.length; i++) expect(tl.scenes[i].start).toBeGreaterThanOrEqual(tl.scenes[i - 1].contentEnd);
    expect(tl.complete).toBe(true);
    expect(tl.readyUntil).toBe(tl.duration);
  });

  it("starts each drawing near its cue word", () => {
    const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), allReady(8), { complete: true });
    const seg = tl.segments.find((s) => s.id === "c1-0")!;
    const water = tl.scenes.find((s) => s.id === "c1")!.elements.find((e) => e.id === "water")!;
    const expected = seg.start + fractionAt(seg.narration, seg.narration.indexOf("water from")) * 8;
    expect(Math.abs(water.start - expected)).toBeLessThan(0.3);
  });

  it("stops readiness at the first segment without audio", () => {
    const audio = allReady(5);
    audio.delete("c2-1");
    const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), audio, { complete: true });
    const blocked = tl.segments.find((s) => s.id === "c2-1")!;
    expect(tl.complete).toBe(false);
    expect(tl.readyUntil).toBeLessThanOrEqual(blocked.start);
    expect(blocked.status).toBe("pending");
  });

  it("reserves time for boards that are still being generated", () => {
    const inputs = FIXTURE_SCENES.map((scene, i) => ({ scene, pending: i === 2, estimatedDuration: 25 }));
    const tl = compileTimeline(inputs, allReady(5));
    const pending = tl.scenes[2];
    expect(pending.pending).toBe(true);
    expect(pending.contentEnd - pending.start).toBeCloseTo(25);
    expect(tl.readyUntil).toBeLessThanOrEqual(pending.start);
  });
});

describe("frameAt (seek determinism)", () => {
  const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), allReady(6), { complete: true });

  it("returns the same frame for the same time, however we got there", () => {
    const t = tl.duration * 0.42;
    const direct = frameAt(tl, t);
    frameAt(tl, tl.duration * 0.9);
    frameAt(tl, 0);
    const again = frameAt(tl, t);
    expect(again.scene?.id).toBe(direct.scene?.id);
    expect(again.items.map((i) => [i.el.id, i.p])).toEqual(direct.items.map((i) => [i.el.id, i.p]));
  });

  it("shows nothing drawn before an element's start and fully drawn after its end", () => {
    const scene = tl.scenes[1];
    const el = scene.elements.find((e) => e.id === "sugar")!;
    expect(frameAt(tl, el.start - 0.01).items.some((i) => i.el.id === "sugar")).toBe(false);
    const mid = frameAt(tl, el.start + el.dur / 2).items.find((i) => i.el.id === "sugar")!;
    expect(mid.p).toBeGreaterThan(0.3);
    expect(mid.p).toBeLessThan(0.7);
    expect(frameAt(tl, el.start + el.dur + 0.01).items.find((i) => i.el.id === "sugar")!.p).toBe(1);
  });

  it("switches boards at scene boundaries and erases before switching", () => {
    const next = tl.scenes[2];
    expect(frameAt(tl, next.start + 0.01).scene?.id).toBe(next.id);
    expect(frameAt(tl, next.start - 0.05).erase).toBeGreaterThan(0.5);
    expect(frameAt(tl, tl.scenes[1].start + 1).erase).toBe(0);
  });

  it("hides transient elements once they finish", () => {
    const sc = tl.scenes[2];
    const trace = sc.elements.find((e) => e.kind === "trace")!;
    expect(frameAt(tl, trace.start + trace.dur / 2).items.some((i) => i.el.id === trace.id)).toBe(true);
    expect(frameAt(tl, trace.start + trace.dur + 0.1).items.some((i) => i.el.id === trace.id)).toBe(false);
  });

  it("tracks the spoken word for captions", () => {
    const seg = tl.segments[1];
    const f = frameAt(tl, seg.start + 0.05);
    expect(f.segment?.id).toBe(seg.id);
    expect(f.wordIndex).toBe(0);
    expect(frameAt(tl, seg.end - 0.05).wordIndex).toBe(seg.words.length - 1);
  });
});

describe("text", () => {
  it("wraps and shrinks long text to fit", () => {
    const fit = fitText("The light-dependent reactions capture energy from sunlight", 300, 140, { max: 52, min: 18 });
    expect(fit.lines.length).toBeGreaterThan(1);
    expect(fit.width).toBeLessThanOrEqual(300);
    expect(fit.height).toBeLessThanOrEqual(140);
  });
  it("keeps short text on one line", () => {
    expect(wrap("Leaf", 300, 40)).toEqual(["Leaf"]);
  });
});

describe("expressions", () => {
  it("evaluates common forms safely", () => {
    expect(compileExpr("2x^2 + 1")(3)).toBe(19);
    expect(compileExpr("sin(pi/2)")(0)).toBeCloseTo(1);
    expect(compileExpr("-x^2")(2)).toBe(-4);
    expect(compileExpr("3(x+1)")(1)).toBe(6);
    expect(() => compileExpr("process.exit()")).toThrow();
    expect(parsePlot("y = x^2; -3..3")).toMatchObject({ xMin: -3, xMax: 3 });
    expect(parsePlot("alert(1)")).toBeNull();
  });
  it("walks along polylines", () => {
    expect(pointAlong([[0, 0], [10, 0], [10, 10]], 0.5)).toEqual([10, 0]);
    expect(pointAlong([[0, 0], [10, 0]], 0.25)).toEqual([2.5, 0]);
  });
});

describe("icons", () => {
  it("resolves names, aliases and plurals", () => {
    expect(resolveIcon("Sun")).toBe("sun");
    expect(resolveIcon("water")).toBe("droplet");
    expect(resolveIcon("trees")).toBe("tree-deciduous");
    expect(resolveIcon("flask_icon")).toBe("flask-conical");
    expect(resolveIcon("definitely-not-an-icon-xyz")).toBeNull();
  });
});

describe("camera", () => {
  const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), allReady(6), { complete: true });

  it("always shows a board-shaped part of the board, never beyond its edges", () => {
    for (let t = 0; t < tl.duration; t += 0.37) {
      const v = frameAt(tl, t).view;
      expect(v.x).toBeGreaterThanOrEqual(-0.01);
      expect(v.y).toBeGreaterThanOrEqual(-0.01);
      expect(v.x + v.w).toBeLessThanOrEqual(BOARD_W + 0.01);
      expect(v.y + v.h).toBeLessThanOrEqual(BOARD_H + 0.01);
      expect(v.w / v.h).toBeCloseTo(BOARD_W / BOARD_H, 3);
      expect(BOARD_W / v.w).toBeLessThanOrEqual(MAX_ZOOM + 1e-6);
    }
  });

  it("starts each board in full view, moves in while drawing, and shows the whole board before erasing", () => {
    for (const scene of tl.scenes) {
      expect(cameraAt(scene.camera, scene.start + 0.05)).toEqual(FULL_VIEW);
      expect(cameraAt(scene.camera, scene.end - 0.02)).toEqual(FULL_VIEW);
    }
    const zoomed = tl.scenes.some((s) => s.camera.some((k) => k.to.w < BOARD_W));
    expect(zoomed).toBe(true);
  });

  it("is a pure function of time (seeking lands on the same view)", () => {
    const t = tl.duration * 0.37;
    const a = frameAt(tl, t).view;
    frameAt(tl, tl.duration * 0.8);
    expect(frameAt(tl, t).view).toEqual(a);
  });

  it("frames focus areas with room around them", () => {
    const v = frame({ x: 700, y: 400, w: 100, h: 60 });
    expect(v.w).toBeCloseTo(BOARD_W / MAX_ZOOM);
    expect(v.x).toBeLessThan(700);
    expect(v.x + v.w).toBeGreaterThan(800);
  });

  it("holds still while new drawing already fits in view", () => {
    const els = [
      { start: 1, dur: 1, kind: "box", bbox: { x: 600, y: 400, w: 120, h: 80 } },
      { start: 4, dur: 1, kind: "box", bbox: { x: 700, y: 420, w: 120, h: 80 } },
    ];
    const keys = planCamera(els, 0, 8);
    // full → zoom in once → back to full before the end: no extra move for the second box.
    expect(keys.length).toBe(3);
  });
});

describe("animation details", () => {
  it("parses and formats numbers that count up", () => {
    const n = parseNumber("$1,234.50 saved")!;
    expect(n).toMatchObject({ prefix: "$", value: 1234.5, decimals: 2, grouped: true, suffix: " saved" });
    expect(formatNumber(n, 617.25)).toBe("$617.25 saved");
    expect(countsUp("70%", parseNumber("70%"))).toBe(true);
    expect(countsUp("1914", parseNumber("1914"))).toBe(false);
  });

  it("reads bar chart items", () => {
    expect(parseBars(["Year 1: $110", "Year 2 = $121", "Mars 38%"])).toEqual([
      { label: "Year 1", value: 110, display: "$110" },
      { label: "Year 2", value: 121, display: "$121" },
      { label: "Mars", value: 38, display: "38%" },
    ]);
    expect(parseBars(["Cats", "Dogs"])).toEqual([]);
  });

  it("builds a bar chart with an axis and one bar per item, addressable by index", () => {
    const { elements, warnings } = layoutScene([
      { id: "chart", kind: "bars", cue: "x", text: null, items: ["A: 1", "B: 4", "C: 2"], icon: null, at: { col: 2, row: 1, w: 6, h: 4 }, from: null, to: null, target: null, color: "blue", expr: null },
      { id: "p", kind: "pulse", cue: "x", text: null, items: null, icon: null, at: null, from: null, to: null, target: "chart[1]", color: null, expr: null },
    ]);
    expect(warnings).toEqual([]);
    expect(elements.map((e) => e.id)).toEqual(["chart.axis", "chart.0", "chart.1", "chart.2", "p"]);
    const [b0, b1] = [elements[1], elements[2]];
    expect(b1.bbox.h).toBeGreaterThan(b0.bbox.h);
    expect(elements[4].targets).toEqual(["chart.1"]);
  });

  it("sends a token between two elements and waits until both are drawn", () => {
    const actions = [
      { id: "a", kind: "box", cue: "first", text: "A", items: null, icon: null, at: { col: 0, row: 0, w: 3, h: 1 }, from: null, to: null, target: null, color: null, expr: null },
      { id: "t", kind: "trace", cue: "first", text: null, items: null, icon: "zap", at: null, from: "a", to: "b", target: null, color: null, expr: null },
      { id: "b", kind: "box", cue: "then", text: "B", items: null, icon: null, at: { col: 8, row: 4, w: 3, h: 1 }, from: null, to: null, target: null, color: null, expr: null },
    ] satisfies Action[];
    const scene = { id: "s", kind: "chapter" as const, title: "T", segments: [{ id: "s-0", sig: "", narration: "First comes A, and then comes B.", actions }] };
    const tl = compileTimeline([{ scene }], new Map([["s-0", { duration: 6, ok: true }]]), { complete: true });
    const els = tl.scenes[0].elements;
    const token = els.find((e) => e.id === "t")!;
    const b = els.find((e) => e.id === "b")!;
    expect(token.transient).toBe(true);
    expect(token.start).toBeGreaterThanOrEqual(b.start + b.dur * 0.6 - 1e-9);
    const part = token.parts[0];
    expect(part.type === "dot" && part.token?.icon).toBeTruthy();
  });

  it("bumps the element an annotation points at, briefly", () => {
    const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), allReady(6), { complete: true });
    const sugar = tl.scenes[1].elements.find((e) => e.id === "sugar")!;
    expect(sugar.emphasis?.length).toBe(1);
    const at = sugar.emphasis![0];
    expect(frameAt(tl, at + 0.2).items.find((i) => i.el.id === "sugar")!.bump).toBeGreaterThan(0);
    expect(frameAt(tl, at + 1).items.find((i) => i.el.id === "sugar")!.bump).toBe(0);
  });

  it("keeps arrows flowing after they're drawn", () => {
    const tl = compileTimeline(FIXTURE_SCENES.map((scene) => ({ scene })), allReady(6), { complete: true });
    const arrow = tl.scenes[1].elements.find((e) => e.id === "a1")!;
    expect(arrow.ambient).toBe(true);
    expect(arrow.parts.some((p) => p.type === "flow")).toBe(true);
    const later = frameAt(tl, arrow.start + arrow.dur + 2).items.find((i) => i.el.id === "a1")!;
    expect(later.age).toBeCloseTo(2);
  });
});

/* ------------------------------------------------------------------ */
/* Drawing tools: sketches, motions, charts, and how arrows are routed */
/* ------------------------------------------------------------------ */

type P2 = [number, number];
const act = (a: Partial<Action> & Pick<Action, "id" | "kind">): Action => ({ cue: "x", text: null, items: null, icon: null, at: null, from: null, to: null, target: null, color: null, expr: null, ...a });
const trailOf = (e: { parts: { type: string }[] }): P2[] => (e.parts.find((p) => p.type === "stroke" && (p as { trail?: P2[] }).trail) as unknown as { trail: P2[] }).trail;
const translateOf = (s?: string): P2 => {
  const m = s?.match(/^translate\((-?[\d.]+) (-?[\d.]+)\)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

describe("sketches", () => {
  it("maps shapes from the 0–100 square into the box and skips what it can't read", () => {
    const shapes = parseSketch(["circle 50 50 20", "fill blue rect 10 10 20 20", "arrow 10 90 90 90", "text 50 5 hello", "M 0 0 L 100 100", "nonsense 1 2", "circle 1"], { x: 100, y: 100, w: 200, h: 200 });
    expect(shapes).toHaveLength(5);
    const [circle, rect, arrow, label, raw] = shapes;
    for (const [x, y] of circle.trail) {
      expect(Math.hypot(x - 200, y - 200)).toBeCloseTo(40, 0);
    }
    expect(rect).toMatchObject({ fill: "hatch", color: "blue", closed: true });
    expect(arrow.head?.[1]).toEqual([280, 280]);
    expect(label.text).toMatchObject({ words: "hello", x: 200, y: 110 });
    expect(label.text!.size).toBeGreaterThanOrEqual(22);
    expect(raw.d).toBe("M100 100 L300 300");
  });

  it("bounds a sketch by what's drawn, not by its whole cell", () => {
    const { elements, warnings } = layoutScene([act({ id: "s", kind: "sketch", items: ["circle 50 50 15"], text: "Cell", at: { col: 2, row: 1, w: 4, h: 4 } })]);
    expect(warnings).toEqual([]);
    const [s] = elements;
    const cell = cellRect({ col: 2, row: 1, w: 4, h: 4 });
    expect(s.bbox.w).toBeLessThan(cell.w * 0.6);
    expect(s.art!.h).toBeLessThan(s.bbox.h);
  });
});

describe("motions", () => {
  const scene = (actions: Action[]) => layoutScene(actions).elements;

  it("keeps an orbit on the board, and the element glides onto its ring", () => {
    const els = scene([
      act({ id: "sun", kind: "icon", icon: "sun", text: "Sun", at: { col: 1, row: 2, w: 2, h: 2 } }),
      act({ id: "earth", kind: "icon", icon: "earth", text: "Earth", at: { col: 7, row: 2, w: 2, h: 2 } }),
      act({ id: "o", kind: "orbit", target: "earth", to: "sun" }),
    ]);
    const orbit = els.find((e) => e.id === "o")!;
    const earth = els.find((e) => e.id === "earth")!;
    for (const [x, y] of trailOf(orbit)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(BOARD_W);
      expect(y).toBeLessThanOrEqual(BOARD_H);
    }
    const m = orbit.motion!;
    expect(m.radius).toBeDefined();
    // Once it has settled, the element's centre rides exactly on the ring.
    const [dx, dy] = translateOf(motionTransform([{ ...m, start: 0 }], earth.bbox, 5)!.move);
    const [cx, cy] = [earth.bbox.x + earth.bbox.w / 2 + dx, earth.bbox.y + earth.bbox.h / 2 + dy];
    const [ox, oy] = m.center!;
    expect(((cx - ox) / m.radius!) ** 2 + ((cy - oy) / (m.radius! * m.ky!)) ** 2).toBeCloseTo(1, 2);
  });

  it("spins and swings a drawing about the drawing itself, not its caption", () => {
    const els = scene([act({ id: "g", kind: "icon", icon: "cog", text: "Gear", at: { col: 0, row: 3, w: 2, h: 2 } })]);
    const gear = els[0];
    const art = gear.art!;
    expect(art.y + art.h / 2).toBeLessThan(gear.bbox.y + gear.bbox.h / 2);
    const spin = motionTransform([{ type: "spin", targets: ["g"], start: 0 }], gear.bbox, 2, false, art)!;
    const [, px, py] = spin.turn!.match(/rotate\(-?[\d.]+ (-?[\d.]+) (-?[\d.]+)\)/)!.map(Number);
    expect(px).toBeCloseTo(art.x + art.w / 2, 0);
    expect(py).toBeCloseTo(art.y + art.h / 2, 0);
    const swing = motionTransform([{ type: "swing", targets: ["g"], start: 0 }], gear.bbox, 0.5, false, art)!;
    expect(swing.turn).toMatch(new RegExp(` ${Math.round(art.y * 10) / 10}\\)$`));
    // Captions never rotate, and with reduced motion nothing keeps moving.
    expect(spin.move).toBeUndefined();
    expect(motionTransform([{ type: "spin", targets: ["g"], start: 0 }], gear.bbox, 2, true, art)).toBeUndefined();
  });

  it("finishes one-off moves even with reduced motion", () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    const to = { x: 600, y: 0, w: 100, h: 100 };
    const live = motionTransform([{ type: "move", targets: ["a"], toBox: to, start: 0 }], box, 0.5)!;
    const still = motionTransform([{ type: "move", targets: ["a"], toBox: to, start: 0 }], box, 0.5, true)!;
    expect(translateOf(live.move)[0]).toBeGreaterThan(0);
    expect(translateOf(still.move)[0]).toBeGreaterThan(translateOf(live.move)[0]);
  });
});

describe("charts", () => {
  it("builds pies whose wedges make a whole circle, tables with a header, and timelines with events", () => {
    const { elements, warnings } = layoutScene([
      act({ id: "pie", kind: "pie", items: ["A: 50", "B: 30", "C: 20"], at: { col: 0, row: 0, w: 5, h: 3 } }),
      act({ id: "vs", kind: "compare", items: ["X | Y", "1 | 2", "3 | 4"], at: { col: 6, row: 0, w: 6, h: 3 } }),
      act({ id: "tl", kind: "timeline", items: ["1900: Start", "1950: Middle", "2000: End"], at: { col: 0, row: 4, w: 12, h: 2 } }),
      act({ id: "gas", kind: "particles", expr: "12 fast", at: { col: 6, row: 3, w: 3, h: 1 } }),
    ]);
    expect(warnings).toEqual([]);
    const wedges = elements.filter((e) => e.kind === "pie-wedge").flatMap((e) => e.parts.filter((p) => p.type === "wedge")) as unknown as { a0: number; a1: number }[];
    expect(wedges).toHaveLength(3);
    expect(wedges.reduce((s, w) => s + (w.a1 - w.a0), 0)).toBeCloseTo(Math.PI * 2);
    expect(elements.filter((e) => e.actionId === "vs").map((e) => e.kind)).toEqual(["compare-head", "compare-row", "compare-row"]);
    expect(elements.filter((e) => e.kind === "timeline-event")).toHaveLength(3);
    const gas = elements.find((e) => e.id === "gas")!;
    expect(gas.ambient).toBe(true);
    expect(gas.parts.find((p) => p.type === "particles")).toMatchObject({ n: 12 });
  });
});

describe("arrow routing", () => {
  const box = (id: string, col: number, row: number, w = 2, h = 1) => act({ id, kind: "box", text: id.toUpperCase(), at: { col, row, w, h } });

  it("runs a pair of arrows going there and back side by side, labels apart", () => {
    const { elements } = layoutScene([
      box("plants", 0, 2),
      box("animals", 9, 2),
      act({ id: "o2", kind: "arrow", from: "plants", to: "animals", text: "Oxygen" }),
      act({ id: "co2", kind: "arrow", from: "animals", to: "plants", text: "Carbon dioxide" }),
    ]);
    const there = trailOf(elements.find((e) => e.id === "o2")!);
    const back = trailOf(elements.find((e) => e.id === "co2")!);
    expect(there.at(-1)![0]).toBeGreaterThan(there[0][0]);
    expect(back.at(-1)![0]).toBeLessThan(back[0][0]);
    expect(Math.abs(there[0][1] - back[0][1])).toBeGreaterThan(24);
    const labelY = (id: string) => (elements.find((e) => e.id === id)!.parts.find((p) => p.type === "text") as unknown as { y: number }).y;
    expect(Math.abs(labelY("o2") - labelY("co2"))).toBeGreaterThan(40);
  });

  it("curves an arrow between elements too close for a straight one, still pointing the right way", () => {
    const { elements } = layoutScene([box("leaf", 5, 2, 2, 2), box("water", 5, 4, 2, 2), act({ id: "up", kind: "arrow", from: "water", to: "leaf" })]);
    const leaf = elements.find((e) => e.id === "leaf")!;
    const route = trailOf(elements.find((e) => e.id === "up")!);
    expect(route.length).toBeGreaterThan(2);
    const [start, end] = [route[0], route.at(-1)!];
    expect(end[1]).toBeLessThan(start[1]);
    expect(end[1]).toBeGreaterThanOrEqual(leaf.bbox.y);
    expect(end[1]).toBeLessThanOrEqual(leaf.bbox.y + leaf.bbox.h);
  });
});

describe("swinging sketches", () => {
  it("keeps a pendulum's beam still while the string and bob swing", () => {
    const { elements } = layoutScene([act({ id: "p", kind: "sketch", items: ["line 25 6 75 6", "line 50 6 50 68", "fill orange circle 50 78 11"], text: "Pendulum", at: { col: 4, row: 1, w: 3, h: 3 } })]);
    const strokes = elements[0].parts.filter((q) => q.type === "stroke") as { fixed?: boolean; trail?: P2[] }[];
    const outlines = strokes.filter((q) => q.trail);
    expect(outlines.filter((q) => q.fixed)).toHaveLength(1);
    const beam = outlines.find((q) => q.fixed)!;
    expect(Math.abs(beam.trail![0][1] - beam.trail!.at(-1)![1])).toBeLessThan(1);
    // Nothing else stays put, and without a beam nothing is fixed.
    expect(outlines.filter((q) => !q.fixed).length).toBeGreaterThanOrEqual(2);
    const noBeam = layoutScene([act({ id: "q", kind: "sketch", items: ["line 50 6 50 68", "circle 50 78 11"], at: { col: 4, row: 1, w: 3, h: 3 } })]);
    expect(noBeam.elements[0].parts.some((q) => q.type === "stroke" && q.fixed)).toBe(false);
  });
});
