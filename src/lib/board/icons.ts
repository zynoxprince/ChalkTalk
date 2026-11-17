import { ICONS, ICON_ALIASES, type IconNode } from "./icons.generated";

export type { IconNode };

export const ICON_NAMES = Object.keys(ICONS);

/** Maps whatever the model wrote ("Water", "flask_icon", "trees") to a known icon. */
export function resolveIcon(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/-?icon$/, "")
    .replace(/[^a-z0-9-]/g, "");
  if (!n) return null;
  const candidates = [n, n.replace(/ies$/, "y"), n.replace(/s$/, ""), n.replace(/es$/, "")];
  for (const c of candidates) {
    if (ICONS[c]) return c;
    if (ICON_ALIASES[c]) return ICON_ALIASES[c];
  }
  // Last resort: an icon whose name contains the word.
  const partial = ICON_NAMES.find((k) => candidates.some((c) => c.length >= 3 && k.split("-").includes(c)));
  return partial ?? null;
}

export function iconNodes(name: string): IconNode | null {
  return ICONS[name] ?? null;
}
