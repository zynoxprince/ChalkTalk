import type { Level, QuizItem, Scene } from "./schema";

/**
 * A complete lesson as stored on disk (sample lessons) or in the browser
 * (recent lessons). Audio for samples lives next to the JSON as one MP3 per
 * narration segment.
 */
export interface SavedLesson {
  version: 1;
  slug: string;
  topic: string;
  level: Level;
  title: string;
  summary: string;
  scopeNote: string | null;
  scenes: Scene[];
  quiz: QuizItem[];
  suggestions: string[];
  models: { lesson: string; voice: string };
  createdAt: string;
  /** For pre-generated lessons: folder holding `<segmentId>.mp3` files. */
  audioBase?: string;
}

export interface SampleInfo {
  slug: string;
  title: string;
  topic: string;
  level: Level;
  summary: string;
  duration: number;
  emoji: string;
}
