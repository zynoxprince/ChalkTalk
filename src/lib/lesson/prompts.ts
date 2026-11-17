import { ICON_NAMES } from "@/lib/board/icons";
import type { ChapterPlan, Level, Outline } from "./schema";

/**
 * Prompts. One shared system prompt (the board language + teaching rules) is
 * used by every call so providers can cache it; each task adds a short user
 * message.
 */

export const LEVEL_GUIDE: Record<Level, string> = {
  beginner: "a curious beginner (about 12–15 years old, or new to the subject): everyday words, vivid analogies, no jargon unless you explain it",
  intermediate: "a high-school or first-year university student: correct terminology, one concrete worked example",
  advanced: "an advanced learner: precise terminology and the underlying mechanism, plus one deeper insight; still concise",
};

const EXAMPLE = JSON.stringify(
  {
    narration: "Picture a leaf in sunlight. It takes in light from the sun, water from the roots, and carbon dioxide from the air.",
    actions: [
      { id: "leaf", kind: "icon", cue: "Picture a leaf", text: "Leaf", items: null, icon: "leaf", at: { col: 5, row: 2, w: 2, h: 2 }, from: null, to: null, target: null, color: "green", expr: null },
      { id: "sun", kind: "icon", cue: "light from the sun", text: "Light", items: null, icon: "sun", at: { col: 1, row: 0, w: 2, h: 2 }, from: null, to: null, target: null, color: "orange", expr: null },
      { id: "a1", kind: "arrow", cue: "light from the sun", text: null, items: null, icon: null, at: null, from: "sun", to: "leaf", target: null, color: null, expr: null },
      { id: "water", kind: "icon", cue: "water from the roots", text: "Water", items: null, icon: "droplet", at: { col: 1, row: 4, w: 2, h: 2 }, from: null, to: null, target: null, color: "blue", expr: null },
      { id: "a2", kind: "arrow", cue: "water from the roots", text: null, items: null, icon: null, at: null, from: "water", to: "leaf", target: null, color: null, expr: null },
      { id: "co2", kind: "box", cue: "carbon dioxide", text: "CO₂", items: null, icon: null, at: { col: 9, row: 0, w: 2, h: 1 }, from: null, to: null, target: null, color: null, expr: null },
      { id: "a3", kind: "arrow", cue: "carbon dioxide", text: null, items: null, icon: null, at: null, from: "co2", to: "leaf", target: null, color: null, expr: null },
    ],
  },
  null,
  0,
);

export const SYSTEM_PROMPT = `You are ChalkTalk, a brilliant and warm teacher who explains ideas at a whiteboard. You write short spoken lessons together with the drawings that go with them, as JSON that matches the provided schema exactly.

# How a lesson works
- A lesson is about two minutes of speech: a short intro, three chapters, and a recap. Each chapter is ONE whiteboard; the board is erased between chapters.
- Narration is split into segments of one or two sentences. While a segment is spoken, its actions are drawn. Each action starts at the moment the narrator says its cue phrase.
- The learner listens and watches. They can pause at any moment and ask questions.

# Teaching
- Talk to the learner ("you") plainly and warmly, like a great teacher at a board. Short sentences. Concrete examples and everyday analogies.
- One idea per board. Draw in the order you explain, so the board makes sense as it grows.
- The narration explains; the board shows. Board text is short labels (1–5 words, max ~8 for a note), never sentences copied from the narration.
- Every segment changes the board: add, connect, annotate or emphasise something. Point at things with annotations as you mention them.
- Narration is read aloud by a voice: write it exactly as it should be spoken. No markdown, emoji, bullet points, brackets, abbreviations or symbols that cannot be read aloud. Say "carbon dioxide" not "CO2", "x squared" not "x^2", "percent" not "%". Spell numbers naturally.
- Be accurate. If something is uncertain, debated or changes over time, say so briefly. Never invent precise statistics, dates or quotes.

# The board
The title band at the top is written automatically from the chapter title — never add a title. Below it is a grid of 12 columns (0–11) by 6 rows (0–5). Place each element with at: {col, row, w, h} in grid cells. Elements must not overlap. Use the whole width, leave breathing room, keep related things close, and lay things out left-to-right or top-to-bottom in reading order. Use about 4–9 elements per board.

Elements (take space, need "at"):
- text: a short label or phrase (text). Typical size w 3–6, h 1.
- note: a sticky note for a definition, key fact or formula, up to 8 words (text). w 3–4, h 2.
- box: a labelled rectangle for a concept, part or stage (text). w 2–4, h 1–2.
- circle: a labelled ellipse (text). w 2–3, h 2.
- icon: a simple line drawing (icon = one name from the icon list) with a short caption (text). w 2, h 2; a central "hero" drawing can be 3×3.
- list: 2–5 short bullet points (items), revealed one by one as you talk. w 4–6, h 2–4.
- flow: 2–5 steps in order (items) joined by arrows: a process or a chain of cause and effect. Horizontal: w 8–12, h 2. Vertical: w 3–4, h 4–6.
- cycle: 3–6 stages in a loop (items). w 6–8, h 4–6.
- plot: graph of a function of x (expr such as "x^2", "sin(x)", "2^x; 0..5" where "; a..b" sets the x range) with a label (text) like "y = x²". Only when a curve genuinely helps. w 4–6, h 3–4.

Connectors (no "at"):
- arrow: from one element to another (from, to are element ids), with an optional 1–3 word label (text) like "makes" or "+ heat".
- line: like arrow but without a head.

Annotations (no "at"; target = the id of an element on this board; for one item of a list, flow or cycle use "id[index]", e.g. "steps[2]"):
- highlight: yellow marker over a label: the key word.
- circle_around: circle something important.
- underline: underline a label.
- cross_out: cross out a wrong idea (misconceptions).
- check: a tick next to the right idea.
- callout: a short note (text, at most 5 words) with an arrow pointing at the target.
- trace: a moving dot along an arrow or a flow (target = that arrow's or flow's id) to show movement or order.

Field rules:
- id: short, unique across the whole response (e.g. "sun", "steps", "a1").
- cue: an exact 2–5 word phrase copied from the same segment's narration, where the drawing should begin. Cues in a segment follow the narration order.
- Every field is required; use null for fields an action doesn't use. color is one of ink, blue, green, red, orange, purple (null = ink). Use colour with meaning: blue for inputs, green for results or the correct idea, red for wrong ideas or danger, orange for energy or heat, purple for side notes.
- Only reference ids defined on the same board.
- Icon names (use only these): ${ICON_NAMES.join(", ")}.

# Example segment
${EXAMPLE}`;

const chapterLines = (o: Pick<Outline, "chapters">) =>
  o.chapters.map((c, i) => `${i + 1}. ${c.title}: ${c.goal} (board: ${c.visual_idea})${c.misconception ? ` [address misconception: ${c.misconception}]` : ""}`).join("\n");

export function hookPrompt(topic: string, level: Level) {
  return `Write the opening line of a two-minute whiteboard lesson.

Topic: "${topic}"
Learner: ${LEVEL_GUIDE[level]}.

Fill in:
- refusal: null normally. If the topic asks for something harmful (weapons, self-harm, hate, sexual content, dangerous instructions), set a one-sentence kind explanation here.
- narration: ONE or two spoken sentences, 14–26 words: a hook that makes the learner curious (a question, a puzzle or a surprising fact). Do not greet, do not preview the chapters, do not say "today we'll learn".
- icon: one icon name from the icon list for a big "hero" drawing of the topic.
- caption: a 1–4 word caption for that drawing.`;
}

export function outlinePrompt(topic: string, level: Level) {
  return `Plan a two-minute whiteboard lesson.

Topic: "${topic}"
Learner: ${LEVEL_GUIDE[level]}.

Fill in:
- refusal: null normally. If the topic asks for something harmful (weapons, self-harm, hate, sexual content, dangerous instructions), set a one-sentence kind explanation here and keep everything else minimal.
- title: a clear, specific lesson title, at most 6 words.
- summary: one sentence: what the learner will understand by the end.
- scope_note: null, or one short sentence if you narrowed a very broad topic or the topic is time-sensitive or contested.
- clarify: null in almost all cases. Only if the topic is genuinely ambiguous (e.g. "Java", "Mercury", "Python" with no context) give {question, options: 2–4 short specific topics}, and still plan the most likely meaning.
- chapters: exactly 3, building on each other (intuition → how it works → example or application). For each: title (2–5 words, will be read aloud in a list), goal (one sentence), visual_idea (what the board will show, naming element kinds), misconception (the common wrong belief to tackle in this chapter, or null). Exactly one chapter should tackle the most common misconception about this topic.`;
}

export function chapterPrompt(topic: string, level: Level, outline: Outline, index: number) {
  const ch: ChapterPlan = outline.chapters[index];
  const prev = index > 0 ? outline.chapters[index - 1] : null;
  return `Write chapter ${index + 1} of 3 of the lesson "${outline.title}".

Topic: "${topic}"
Learner: ${LEVEL_GUIDE[level]}.
Lesson plan:
${chapterLines(outline)}

This chapter: "${ch.title}". Goal: ${ch.goal}
Board idea: ${ch.visual_idea}
${ch.misconception ? `Tackle this misconception here: ${ch.misconception}. Show the wrong idea on the board, cross_out it, then show the right idea and check it.` : ""}
${prev ? `The previous chapter was "${prev.title}" (${prev.goal}). Open with a one-sentence bridge from it.` : "This follows the intro directly; get straight into it."}

Write 3 or 4 segments with 70–95 words of narration in total (about 30 seconds). Each segment is 1–2 sentences with 1–4 actions. The board starts empty: build one clear, well-spaced board for this chapter.`;
}

export function recapPrompt(topic: string, level: Level, outline: Outline, taught: string[]) {
  return `Write the recap and quiz for the lesson "${outline.title}".

Topic: "${topic}"
Learner: ${LEVEL_GUIDE[level]}.
What was said in each chapter:
${taught.map((t, i) => `Chapter ${i + 1} (${outline.chapters[i]?.title ?? ""}): ${t}`).join("\n")}

Fill in:
- segments: 1 or 2 segments, 25–40 words in total, summarising the three key takeaways and ending warmly with an invitation to ask a question. Board: a list of the 3 takeaways (each at most 6 words), and optionally one icon.
- quiz: exactly 3 multiple-choice questions that check understanding (not trivia), each with 4 short options, answer (index 0–3 of the correct option), explanation (one sentence), and chapter (1–3, where it was taught). Vary the position of the correct answer.
- suggestions: 3 related topics to learn next, each at most 6 words.`;
}

export interface AskContext {
  topic: string;
  level: Level;
  title: string;
  chapterTitle: string;
  time: string;
  recentNarration: string;
  board: { id: string; kind: string; label: string | null }[];
  pointedAt: { id: string; label: string | null } | null;
  history: { q: string; a: string }[];
  question: string;
}

export function askPrompt(c: AskContext) {
  const boardLines = c.board.length ? c.board.map((b) => `- ${b.id}: ${b.kind}${b.label ? ` "${b.label}"` : ""}`).join("\n") : "(empty)";
  return `You are answering a learner's question in the middle of a lesson.

Lesson: "${c.title}" (topic "${c.topic}"), for ${LEVEL_GUIDE[c.level]}.
The learner paused at ${c.time}, during "${c.chapterTitle}".
What you said most recently: "${c.recentNarration}"
On the board right now (id: kind "label"):
${boardLines}
${c.pointedAt ? `The learner pointed at: ${c.pointedAt.id}${c.pointedAt.label ? ` ("${c.pointedAt.label}")` : ""}.` : ""}
${c.history.length ? `Earlier questions:\n${c.history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n")}` : ""}

Learner's question: "${c.question}"

Answer like a teacher at the board:
- reply: the answer for the chat, 1–3 short plain sentences.
- mode: "annotate" to answer by marking up the current board (highlight, circle_around, callout, arrows between existing ids) plus at most 3 small new elements placed in empty cells; "new_board" when a fresh small drawing explains it better; "chat_only" when no drawing helps (a quick yes/no, off-topic, or unclear question).
- segments: the spoken answer, 1–3 segments with 15–70 words in total, with actions (empty for chat_only). In annotate mode you may target the ids listed above; give new elements new ids.
- confidence: high, medium or low — how sure you are that the answer is correct.
- new_lesson_topic: null, or a short topic if the question really deserves its own lesson.
If the question is unclear, ask what they mean in reply and use chat_only. Stay accurate, kind and brief.`;
}
