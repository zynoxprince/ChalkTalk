import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./env";

/**
 * Narration is signed by the server that generated it. The speech endpoint
 * only voices signed text, so it can't be used as a free text-to-speech API.
 */

export function signNarration(text: string): string {
  return createHmac("sha256", config.signingSecret).update(`narration:v1\n${text}`).digest("base64url").slice(0, 32);
}

export function verifyNarration(text: string, sig: string): boolean {
  if (!sig || sig.length !== 32) return false;
  const expected = Buffer.from(signNarration(text));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
