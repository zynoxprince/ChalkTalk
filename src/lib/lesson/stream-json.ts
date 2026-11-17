/**
 * Pulls complete items out of a JSON array while the JSON is still streaming.
 * Feed it text chunks of e.g. `{"segments":[{...},{...` and it returns each
 * `{...}` item as soon as its closing brace arrives. Strings and escapes are
 * tracked so braces inside text don't confuse it.
 */
export class ArrayItemExtractor {
  private buf = "";
  private pos = 0;
  private started = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private itemStart = -1;
  done = false;

  constructor(private readonly key: string) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const items: string[] = [];
    if (!this.started) {
      const k = this.buf.indexOf(`"${this.key}"`);
      if (k < 0) return items;
      const open = this.buf.indexOf("[", k);
      if (open < 0) return items;
      this.started = true;
      this.pos = open + 1;
    }
    for (; this.pos < this.buf.length && !this.done; this.pos++) {
      const c = this.buf[this.pos];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') {
        this.inString = true;
      } else if (c === "{" || c === "[") {
        if (this.depth === 0 && c === "{") this.itemStart = this.pos;
        this.depth++;
      } else if (c === "}" || c === "]") {
        if (this.depth === 0) {
          if (c === "]") this.done = true;
          continue;
        }
        this.depth--;
        if (this.depth === 0 && c === "}" && this.itemStart >= 0) {
          items.push(this.buf.slice(this.itemStart, this.pos + 1));
          this.itemStart = -1;
        }
      }
    }
    return items;
  }
}
