import type { Action, Scene } from "./schema";

/**
 * A hand-written lesson used by tests and the engine playground. It exercises
 * every element kind without calling any AI service.
 */

const A = (a: Partial<Action> & Pick<Action, "id" | "kind" | "cue">): Action => ({
  text: null,
  items: null,
  icon: null,
  at: null,
  from: null,
  to: null,
  target: null,
  color: null,
  expr: null,
  ...a,
});

export const FIXTURE_SCENES: Scene[] = [
  {
    id: "intro",
    kind: "intro",
    title: "How Photosynthesis Works",
    segments: [
      {
        id: "intro-0",
        sig: "",
        narration: "Every leaf is a tiny food factory. Today we'll see what goes in, what happens inside, and what comes out.",
        actions: [
          A({ id: "factory", kind: "icon", icon: "factory", text: "Leaf = food factory", at: { col: 0, row: 1, w: 3, h: 3 }, cue: "tiny food factory" }),
          A({ id: "agenda", kind: "list", items: ["What goes in", "What happens inside", "What comes out"], at: { col: 5, row: 1, w: 6, h: 3 }, cue: "what goes in" }),
        ],
      },
    ],
  },
  {
    id: "c1",
    kind: "chapter",
    title: "Inputs and outputs",
    segments: [
      {
        id: "c1-0",
        sig: "",
        narration: "Picture a leaf in sunlight. It takes in light from the sun, water from the roots, and carbon dioxide from the air.",
        actions: [
          A({ id: "leaf", kind: "icon", icon: "leaf", text: "Leaf", color: "green", at: { col: 5, row: 2, w: 2, h: 2 }, cue: "Picture a leaf" }),
          A({ id: "sun", kind: "icon", icon: "sun", text: "Light", color: "orange", at: { col: 1, row: 0, w: 2, h: 2 }, cue: "light from the sun" }),
          A({ id: "a1", kind: "arrow", from: "sun", to: "leaf", cue: "light from the sun" }),
          A({ id: "water", kind: "icon", icon: "droplet", text: "Water", color: "blue", at: { col: 1, row: 4, w: 2, h: 2 }, cue: "water from the roots" }),
          A({ id: "a2", kind: "arrow", from: "water", to: "leaf", cue: "water from the roots" }),
          A({ id: "drop", kind: "trace", target: "a2", icon: "droplet", color: "blue", cue: "from the roots" }),
          A({ id: "co2", kind: "box", text: "CO₂", at: { col: 9, row: 0, w: 2, h: 1 }, cue: "carbon dioxide" }),
          A({ id: "a3", kind: "arrow", from: "co2", to: "leaf", cue: "carbon dioxide" }),
        ],
      },
      {
        id: "c1-1",
        sig: "",
        narration: "Out come two things: sugar, the plant's food, and oxygen, which it releases for us to breathe.",
        actions: [
          A({ id: "sugar", kind: "box", text: "Sugar (glucose)", color: "green", at: { col: 9, row: 3, w: 3, h: 1 }, cue: "sugar" }),
          A({ id: "a4", kind: "arrow", from: "leaf", to: "sugar", cue: "sugar" }),
          A({ id: "o2", kind: "box", text: "O₂", color: "green", at: { col: 9, row: 5, w: 2, h: 1 }, cue: "oxygen" }),
          A({ id: "a5", kind: "arrow", from: "leaf", to: "o2", cue: "oxygen" }),
          A({ id: "h1", kind: "highlight", target: "o2", cue: "for us to breathe" }),
          A({ id: "p1", kind: "pulse", target: "sugar", cue: "the plant's food" }),
        ],
      },
    ],
  },
  {
    id: "c2",
    kind: "chapter",
    title: "Inside the chloroplast",
    segments: [
      {
        id: "c2-0",
        sig: "",
        narration: "Inside each leaf cell, chloroplasts run a two-step process. First, light reactions capture energy. Then, the Calvin cycle builds sugar.",
        actions: [
          A({ id: "steps", kind: "flow", items: ["Sunlight", "Light reactions", "Calvin cycle", "Sugar"], at: { col: 0, row: 0, w: 12, h: 2 }, cue: "two-step process", color: "blue" }),
          A({ id: "t1", kind: "trace", target: "steps", cue: "builds sugar" }),
        ],
      },
      {
        id: "c2-1",
        sig: "",
        narration: "A common mistake: plants do not get their food from the soil. The mass comes from carbon dioxide in the air.",
        actions: [
          A({ id: "wrong", kind: "note", text: "Food comes from soil", at: { col: 1, row: 3, w: 4, h: 2 }, cue: "common mistake" }),
          A({ id: "x1", kind: "cross_out", target: "wrong", cue: "do not get their food" }),
          A({ id: "right", kind: "text", text: "Mass comes from CO₂ in the air", color: "green", at: { col: 6, row: 3, w: 6, h: 1 }, cue: "The mass comes from" }),
          A({ id: "ok1", kind: "check", target: "right", cue: "carbon dioxide in the air" }),
          A({ id: "u1", kind: "underline", target: "right", cue: "in the air" }),
        ],
      },
      {
        id: "c2-2",
        sig: "",
        narration: "Light intensity raises the rate quickly at first, then it levels off, as this curve shows.",
        actions: [
          A({ id: "curve", kind: "plot", expr: "1 - exp(-x); 0..5", text: "rate vs light", color: "purple", at: { col: 7, row: 4, w: 5, h: 2 }, cue: "Light intensity" }),
          A({ id: "c1n", kind: "callout", text: "levels off", target: "curve", cue: "levels off" }),
        ],
      },
    ],
  },
  {
    id: "c3",
    kind: "chapter",
    title: "Light makes the difference",
    segments: [
      {
        id: "c3-0",
        sig: "",
        narration: "A leaf captures only about one percent of the sunlight that reaches it, yet that is enough to power almost all life on Earth.",
        actions: [
          A({ id: "share", kind: "number", text: "1%", items: ["of sunlight captured"], color: "orange", at: { col: 0, row: 0, w: 4, h: 2 }, cue: "about one percent" }),
          A({ id: "earth", kind: "icon", icon: "earth", text: "All life", color: "green", at: { col: 0, row: 3, w: 4, h: 3 }, cue: "enough to power" }),
          A({ id: "power", kind: "trace", from: "share", to: "earth", icon: "zap", color: "orange", cue: "all life on Earth" }),
        ],
      },
      {
        id: "c3-1",
        sig: "",
        narration: "Grow three seedlings in shade, by a window and in full sun, and the one in full sun grows fastest.",
        actions: [
          A({ id: "growth", kind: "bars", items: ["Shade: 2 cm", "Window: 5 cm", "Full sun: 9 cm"], color: "green", at: { col: 5, row: 0, w: 7, h: 5 }, cue: "three seedlings" }),
          A({ id: "best", kind: "pulse", target: "growth[2]", cue: "grows fastest" }),
        ],
      },
    ],
  },
  {
    id: "c4",
    kind: "chapter",
    title: "Things in motion",
    segments: [
      {
        id: "c4-0",
        sig: "",
        narration: "Watch the Earth travel around the sun, while a pendulum swings back and forth.",
        actions: [
          A({ id: "earth2", kind: "icon", icon: "earth", text: "Earth", color: "blue", at: { col: 7, row: 2, w: 2, h: 2 }, cue: "Watch the Earth" }),
          A({ id: "sun2", kind: "icon", icon: "sun", text: "Sun", color: "orange", at: { col: 3, row: 1, w: 3, h: 3 }, cue: "around the sun" }),
          A({ id: "year", kind: "orbit", target: "earth2", to: "sun2", cue: "travel around" }),
          A({
            id: "pendulum",
            kind: "sketch",
            items: ["line 25 6 75 6", "line 50 6 50 68", "fill orange circle 50 78 11"],
            text: "Pendulum",
            at: { col: 9, row: 0, w: 3, h: 3 },
            cue: "a pendulum",
          }),
          A({ id: "tick", kind: "swing", target: "pendulum", cue: "swings back and forth" }),
        ],
      },
      {
        id: "c4-1",
        sig: "",
        narration: "Heat makes molecules jiggle faster, and gears keep on turning.",
        actions: [
          A({ id: "gas", kind: "particles", text: "Warm gas", expr: "16 fast", color: "red", at: { col: 9, row: 3, w: 3, h: 3 }, cue: "Heat makes molecules" }),
          A({ id: "gear", kind: "icon", icon: "cog", text: "Gear", color: "purple", at: { col: 0, row: 4, w: 2, h: 2 }, cue: "gears keep" }),
          A({ id: "turn", kind: "spin", target: "gear", cue: "keep on turning" }),
        ],
      },
    ],
  },
  {
    id: "c5",
    kind: "chapter",
    title: "Charts at a glance",
    segments: [
      {
        id: "c5-0",
        sig: "",
        narration: "A fresh leaf is mostly water, with some sugars and a little of everything else.",
        actions: [A({ id: "leafpie", kind: "pie", text: "A fresh leaf", items: ["Water: 80", "Sugars: 15", "Other: 5"], color: "green", at: { col: 0, row: 0, w: 5, h: 3 }, cue: "mostly water" })],
      },
      {
        id: "c5-1",
        sig: "",
        narration: "Plants make their own food, while animals have to eat theirs.",
        actions: [
          A({ id: "vs", kind: "compare", items: ["Plants | Animals", "Make food | Eat food", "Give oxygen | Use oxygen"], color: "blue", at: { col: 6, row: 0, w: 6, h: 3 }, cue: "Plants make their own" }),
        ],
      },
      {
        id: "c5-2",
        sig: "",
        narration: "And through the year, a plant sprouts, grows, drops its leaves and rests.",
        actions: [
          A({ id: "year2", kind: "timeline", items: ["Spring: Sprouts", "Summer: Grows fast", "Autumn: Drops leaves", "Winter: Rests"], color: "green", at: { col: 0, row: 4, w: 12, h: 2 }, cue: "through the year" }),
        ],
      },
    ],
  },
  {
    id: "recap",
    kind: "recap",
    title: "Recap",
    segments: [
      {
        id: "recap-0",
        sig: "",
        narration: "So: light, water and carbon dioxide go in, the chloroplast does the work, and sugar and oxygen come out. That's the cycle of life on Earth.",
        actions: [
          A({ id: "loop", kind: "cycle", items: ["Light + water + CO₂", "Chloroplast", "Sugar + O₂", "Life on Earth"], at: { col: 2, row: 0, w: 8, h: 6 }, cue: "light, water", color: "green" }),
          A({ id: "ring", kind: "circle_around", target: "Chloroplast", cue: "the chloroplast does the work" }),
        ],
      },
    ],
  },
];
