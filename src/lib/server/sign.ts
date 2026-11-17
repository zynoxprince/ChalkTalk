import { createHmac, timingSafeEqual } from "node:crypto";
import { config, voiceTag } from "./env";

/**
 * Narration is signed by the server that generated it. The speech endpoint
 * only voices signed text, so it can't be used as a free text-to-speech API.
 */

export function signNarration(text: string): string {
  // The voice is part of the signed payload, so switching voices changes the URL
  // and audio cached for one voice is never served for another.
  return createHmac("sha256", config.signingSecret).update(`narration:v2\n${voiceTag()}\n${text}`).digest("base64url").slice(0, 32);
}

export function verifyNarration(text: string, sig: string): boolean {
  if (!sig || sig.length !== 32) return false;
  const expected = Buffer.from(signNarration(text));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
