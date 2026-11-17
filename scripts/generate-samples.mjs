// Generates the ready-made sample lessons with the real pipeline (same API the
// app uses), then stores them as static files so they play instantly and work
// even without API access.
//
//   pnpm dev                                   # in another terminal
//   node scripts/generate-samples.mjs          # all samples
//   node scripts/generate-samples.mjs seasons  # one sample
//
// Needs ffmpeg on PATH (narration is stored as small MP3 files).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const SAMPLES = [
  { slug: "photosynthesis", topic: "How does photosynthesis work?", level: "beginner", emoji: "🌿" },
  { slug: "seasons", topic: "Why do we have seasons?", level: "beginner", emoji: "🌍" },
  { slug: "compound-interest", topic: "What is compound interest?", level: "beginner", emoji: "💰" },
  { slug: "neural-networks", topic: "How does a neural network learn?", level: "intermediate", emoji: "🧠" },
];

async function* ndjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

const post = (path, body) => fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function toMp3(pcm, out, rate = 24000) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", "pipe:0", "-codec:a", "libmp3lame", "-b:a", "48k", out]);
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    ff.stdin.end(pcm);
  });
}

async function generate({ slug, topic, level, emoji }) {
  const t0 = Date.now();
  console.log(`\n▶ ${slug}: "${topic}" (${level})`);

  // 1. Hook + plan
  let hook = null, outline = null, agenda = null;
  for await (const msg of ndjson(await post("/api/lesson/outline", { topic, level }))) {
    if (msg.error || msg.refusal) throw new Error(msg.error ?? msg.refusal);
    if (msg.hook) hook = msg.hook;
    if (msg.outline) ({ outline, agenda } = msg);
  }
  if (!outline) throw new Error("no outline");
  const title = topic.charAt(0).toUpperCase() + topic.slice(1);
  const intro = { id: "intro", kind: "intro", title, segments: hook ? [hook, agenda] : [agenda] };
  console.log(`  plan: ${outline.title} — ${outline.chapters.map((c) => c.title).join(" | ")}`);

  // 2. Chapters (in parallel)
  const chapters = await Promise.all(
    outline.chapters.map(async (c, index) => {
      const segments = [];
      for await (const msg of ndjson(await post("/api/lesson/chapter", { topic, level, outline, index }))) {
        if (msg.segment) segments.push(msg.segment);
        if (msg.error && !segments.length) throw new Error(msg.error);
      }
      return { id: `c${index + 1}`, kind: "chapter", title: c.title, segments };
    }),
  );

  // 3. Recap + quiz
  const taught = chapters.map((c) => c.segments.map((s) => s.narration).join(" "));
  const recapRes = await post("/api/lesson/recap", { topic, level, outline, taught });
  const recap = await recapRes.json();
  if (!recapRes.ok) throw new Error(recap.error);
  const scenes = [intro, ...chapters, recap.scene];

  // 4. Voice every segment
  const dir = join(ROOT, "public", "samples", slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const segs = scenes.flatMap((s) => s.segments);
  let seconds = 0;
  let next = 0;
  const voices = new Set();
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < segs.length) {
        const seg = segs[next++];
        for (let attempt = 1; ; attempt++) {
          const res = await fetch(`${BASE}/api/tts?t=${encodeURIComponent(seg.narration)}&s=${encodeURIComponent(seg.sig)}`);
          if (res.ok) {
            const pcm = Buffer.from(await res.arrayBuffer());
            const rate = Number(res.headers.get("x-audio-format")?.match(/rate=(\d+)/)?.[1]) || 24000;
            voices.add(res.headers.get("x-speech-provider") ?? "?");
            seconds += pcm.length / 2 / rate;
            await toMp3(pcm, join(dir, `${seg.id}.mp3`), rate);
            break;
          }
          if (attempt >= 3) throw new Error(`voice failed for ${seg.id}: ${res.status}`);
        }
      }
    }),
  );
  const duration = Math.round(seconds + 0.35 * (segs.length - scenes.length) + 1.1 * (scenes.length - 1) + 0.6);

  const lesson = {
    version: 1,
    slug,
    topic,
    level,
    title: outline.title,
    summary: outline.summary,
    scopeNote: outline.scope_note,
    scenes,
    quiz: recap.quiz,
    suggestions: recap.suggestions,
    models: { lesson: process.env.LESSON_MODEL ?? "google/gemini-4-hydrogen", voice: [...voices].join("+") },
    createdAt: new Date().toISOString(),
    audioBase: `/samples/${slug}`,
  };
  writeFileSync(join(ROOT, "public", "samples", `${slug}.json`), JSON.stringify(lesson));
  console.log(`  ✓ ${segs.length} segments, ~${duration}s of lesson, voice: ${[...voices].join("+")}, generated in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { slug, title: outline.title, topic, level, summary: outline.summary, duration, emoji };
}

const only = process.argv[2];
const indexPath = join(ROOT, "src", "lib", "lesson", "samples.generated.ts");
const existing = (() => {
  try {
    const src = readFileSync(indexPath, "utf8");
    return JSON.parse(src.slice(src.indexOf("= ") + 2, src.lastIndexOf(";")));
  } catch {
    return [];
  }
})();
const results = new Map(existing.map((s) => [s.slug, s]));
for (const sample of SAMPLES.filter((s) => !only || s.slug === only)) {
  try {
    results.set(sample.slug, await generate(sample));
  } catch (e) {
    console.error(`  ✗ ${sample.slug}: ${e.message}`);
  }
}
const ordered = SAMPLES.map((s) => results.get(s.slug)).filter(Boolean);
writeFileSync(
  indexPath,
  `// Generated by scripts/generate-samples.mjs — lists the pre-generated sample lessons.\nimport type { SampleInfo } from "./saved";\n\nexport const SAMPLES: SampleInfo[] = ${JSON.stringify(ordered, null, 2)};\n`,
);
console.log(`\nwrote ${ordered.length} samples to src/lib/lesson/samples.generated.ts`);
