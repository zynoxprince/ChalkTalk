"use client";

import { useState } from "react";
import { GitHubMark, Icon } from "@/components/ui/Icon";
import { fmt } from "@/components/player/Controls";
import { LEVELS, type Level } from "@/lib/lesson/schema";
import type { SampleInfo } from "@/lib/lesson/saved";
import { Logo } from "./Logo";

const IDEAS = ["How do vaccines work?", "Why is the sky blue?", "What is compound interest?", "How does a neural network learn?", "How do black holes form?", "What causes inflation?"];

const LEVEL_LABEL: Record<Level, { label: string; hint: string }> = {
  beginner: { label: "Beginner", hint: "Plain words and everyday analogies" },
  intermediate: { label: "Intermediate", hint: "High-school level, with real terms" },
  advanced: { label: "Advanced", hint: "Precise, with the underlying mechanism" },
};

export const REPO_URL = "https://github.com/zynoxprince/ChalkTalk";

interface LandingProps {
  initialTopic?: string;
  samples: SampleInfo[];
  onStart: (topic: string, level: Level) => void;
  onSample: (slug: string) => void;
}

export function Landing({ initialTopic = "", samples, onStart, onSample }: LandingProps) {
  const [topic, setTopic] = useState(initialTopic);
  const [level, setLevel] = useState<Level>("beginner");
  const trimmed = topic.trim();
  const submit = () => trimmed.length >= 2 && onStart(trimmed, level);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo />
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-ink/70 hover:bg-black/5 hover:text-ink">
          <GitHubMark className="size-4" /> <span className="hidden sm:inline">Source on GitHub</span>
        </a>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center px-4 pb-16 pt-6 sm:px-6 sm:pt-12">
        <h1 className="text-balance text-center text-4xl font-semibold tracking-tight sm:text-6xl">
          Learn anything on a <span className="marker-underline whitespace-nowrap font-hand text-5xl font-bold sm:text-7xl">whiteboard</span>.
        </h1>
        <p className="mt-4 max-w-xl text-balance text-center text-base text-ink/65 sm:text-lg">
          Type a topic. Watch a two-minute lesson drawn and narrated just for you. Raise your hand anytime to ask the tutor a question.
        </p>

        <form
          className="mt-8 w-full"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex items-center gap-2 rounded-2xl border border-black/15 bg-white p-2 pl-4 shadow-[0_8px_30px_-12px_rgb(0_0_0/0.25)] focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15">
            <Icon name="sparkles" className="size-5 shrink-0 text-accent" />
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={160}
              autoFocus
              placeholder="What do you want to understand?"
              aria-label="Topic to learn"
              className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none placeholder:text-ink/40 sm:text-lg"
            />
            <button
              type="submit"
              disabled={trimmed.length < 2}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:bg-black/10 disabled:text-ink/40 sm:px-5 sm:text-base"
            >
              Teach me <Icon name="arrowRight" className="size-4" />
            </button>
          </div>

          <fieldset className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            <legend className="sr-only">Level</legend>
            {LEVELS.map((l) => (
              <label key={l} title={LEVEL_LABEL[l].hint} className={`cursor-pointer rounded-full px-3.5 py-1.5 text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${level === l ? "bg-ink text-white" : "text-ink/60 hover:bg-black/5"}`}>
                <input type="radio" name="level" value={l} checked={level === l} onChange={() => setLevel(l)} className="sr-only" />
                {LEVEL_LABEL[l].label}
              </label>
            ))}
            <span className="ml-1 hidden text-xs text-ink/45 sm:inline">{LEVEL_LABEL[level].hint}</span>
          </fieldset>
        </form>

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {IDEAS.map((idea) => (
            <button key={idea} type="button" onClick={() => onStart(idea, level)} className="rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-sm text-ink/75 transition hover:border-accent hover:text-accent">
              {idea}
            </button>
          ))}
        </div>

        {samples.length > 0 && (
          <section className="mt-14 w-full" aria-labelledby="samples-heading">
            <h2 id="samples-heading" className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink/60">
              <Icon name="play" className="size-4" /> Or watch a ready-made lesson — starts instantly
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {samples.map((s) => (
                <button
                  key={s.slug}
                  type="button"
                  onClick={() => onSample(s.slug)}
                  className="group flex items-start gap-3 rounded-2xl border border-black/10 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md"
                >
                  <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-paper text-2xl" aria-hidden>
                    {s.emoji}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-hand text-2xl font-bold leading-tight group-hover:text-accent">{s.title}</span>
                    <span className="mt-0.5 line-clamp-2 block text-sm text-ink/60">{s.summary}</span>
                    <span className="mt-1.5 flex items-center gap-2 text-xs text-ink/45">
                      <Icon name="clock" className="size-3.5" /> {fmt(s.duration)} · {LEVEL_LABEL[s.level].label}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="mt-14 grid w-full gap-3 sm:grid-cols-3" aria-label="How it works">
          {[
            { icon: "sparkles" as const, title: "Ask for any topic", body: "The AI plans a two-minute lesson at your level, in three short chapters." },
            { icon: "pen" as const, title: "Watch it drawn", body: "Every sketch, arrow and highlight appears exactly as the tutor talks about it." },
            { icon: "hand" as const, title: "Raise your hand", body: "Pause anytime, point at the board, and the tutor answers on the board." },
          ].map((step, i) => (
            <div key={step.title} className="rounded-2xl border border-black/5 bg-white/60 p-4">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className="grid size-7 place-items-center rounded-full bg-marker text-ink">
                  <Icon name={step.icon} className="size-4" />
                </span>
                {i + 1}. {step.title}
              </span>
              <p className="mt-2 text-sm text-ink/60">{step.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-black/5 px-4 py-5 text-center text-xs text-ink/45">
        Open source (MIT) · Lessons and answers are generated live by AI and can contain mistakes ·{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="underline hover:text-ink">
          How it works
        </a>
      </footer>
    </div>
  );
}
