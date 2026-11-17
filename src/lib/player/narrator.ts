"use client";

/**
 * Fallback narrator: the browser's built-in speech synthesis. Used only for
 * lines the server couldn't voice (e.g. the speech provider is unavailable),
 * so a lesson keeps talking instead of going silent.
 */

export interface Narrator {
  speak(id: string, text: string): void;
  isSpeaking(id: string): boolean;
  cancel(): void;
}

const PREFERRED = [/natural/i, /neural/i, /google us english/i, /samantha/i, /aria/i, /jenny/i, /daniel/i, /google uk english female/i];

export class BrowserNarrator implements Narrator {
  private current: string | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private synth: SpeechSynthesis;

  static create(): BrowserNarrator | null {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return null;
    return new BrowserNarrator(window.speechSynthesis);
  }

  private constructor(synth: SpeechSynthesis) {
    this.synth = synth;
    this.pickVoice();
    synth.addEventListener?.("voiceschanged", () => this.pickVoice());
  }

  private pickVoice() {
    const voices = this.synth.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("en"));
    for (const re of PREFERRED) {
      const v = voices.find((x) => re.test(x.name));
      if (v) {
        this.voice = v;
        return;
      }
    }
    this.voice = voices.find((v) => v.lang === "en-US") ?? voices[0] ?? null;
  }

  speak(id: string, text: string) {
    this.cancel();
    if (!text.trim()) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1;
    u.pitch = 1;
    const done = () => {
      if (this.current === id) this.current = null;
    };
    u.onend = done;
    u.onerror = done;
    this.current = id;
    // Some engines drop an utterance queued in the same tick as cancel().
    setTimeout(() => {
      if (this.current === id) this.synth.speak(u);
    }, 30);
  }

  isSpeaking(id: string) {
    return this.current === id;
  }

  cancel() {
    this.current = null;
    try {
      this.synth.cancel();
    } catch {
      /* ignore */
    }
  }

  /** Call inside a user gesture (iOS only allows speech after one). */
  prime() {
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      this.synth.speak(u);
    } catch {
      /* ignore */
    }
  }
}
