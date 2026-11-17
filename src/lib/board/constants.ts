import type { Color } from "@/lib/lesson/schema";

/** Logical board size. The SVG scales this to any screen via its viewBox. */
export const BOARD_W = 1600;
export const BOARD_H = 900;

/** Title band at the top of every board. */
export const TITLE = { x: 64, baseline: 98, size: 68, maxWidth: 1470 };

/** Content grid below the title: 12 columns x 6 rows. */
export const GRID = { cols: 12, rows: 6, x: 40, y: 140, w: 1520, h: 730 };
export const CELL_W = GRID.w / GRID.cols;
export const CELL_H = GRID.h / GRID.rows;

export const INK: Record<Color, string> = {
  ink: "#1f2937",
  blue: "#2563eb",
  green: "#15803d",
  red: "#dc2626",
  orange: "#ea580c",
  purple: "#7c3aed",
};
export const MARKER_YELLOW = "#facc15";
export const NOTE_FILL = "#fef3c7";
export const NOTE_STROKE = "#d97706";

/** Seconds of silence between narration segments, and between boards. */
export const SEGMENT_GAP = 0.35;
export const SCENE_GAP = 1.1;
/** Erase animation at the end of a board (inside SCENE_GAP). */
export const ERASE_TIME = 0.7;
/** Drawing starts slightly before the cue word is spoken, like a real teacher. */
export const CUE_LEAD = 0.15;
/** Speaking-rate estimate used before real audio durations are known. */
export const WORDS_PER_SECOND = 2.55;
