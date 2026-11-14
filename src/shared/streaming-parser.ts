// Return only constructs whose meaning is established by the received prefix.
// Unsupported or malformed constructs are withheld rather than spoken.
function scan(text: string, final: boolean): { end: number; speech: string } {
  let speech = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const c = text[i];
    if (c === "\\") {
      if (i + 1 === text.length) break;
      // Don't pass escaped Markdown delimiters back to the Markdown parser.
      speech += /[\\`*_[\]<>!]/.test(text[i + 1]) ? " " : text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`" || c === "~") {
      const run = new RegExp(`^${c}+`).exec(rest)![0];
      if (i + run.length === text.length && !final) break;
      if (run.length >= 3) {
        const start = i + run.length;
        const close = new RegExp(`(?:^|\\n) {0,3}${c}{${run.length},}(?=\\s|$)`, "g");
        close.lastIndex = start;
        const found = close.exec(text);
        if (!found) break;
        i = found.index + found[0].length;
        speech += " ";
        continue;
      }
      if (c === "~") { speech += c; i++; continue; }
      const close = text.indexOf(run, i + run.length);
      if (close < 0) break;
      const inner = text.slice(i + run.length, close);
      if (/[\n`]/.test(inner)) break;
      speech += inner.replace(/[[\]<>\\*_~]/g, " ");
      i = close + run.length;
      continue;
    }
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const start = c === "!" ? i + 1 : i;
      const close = text.indexOf("]", start + 1);
      if (close < 0) break;
      const label = text.slice(start + 1, close);
      if (/\[|\n/.test(label)) break;
      if (/^\/?voice\b/i.test(label)) {
        if (!/^voice\s+emotions="[^"\n]*"\s*$/.test(label)) break;
        const closing = text.indexOf("[/voice]", close + 1);
        if (closing < 0) break;
        const body = text.slice(close + 1, closing);
        if (/\[|\]|`|~|<|\\|https?:\/\//i.test(body)) {
          i = closing + 8;
          continue;
        }
        speech += text.slice(i, closing + 8);
        i = closing + 8;
        continue;
      }
      if (close + 1 === text.length && !final) break;
      const next = text[close + 1];
      if (next === "(" || next === "[") {
        const terminator = next === "(" ? ")" : "]";
        const end = text.indexOf(terminator, close + 2);
        if (end < 0 || /[\n()[\]]/.test(text.slice(close + 2, end))) break;
        speech += label.replace(/[`~*_<>\\]/g, " ");
        i = end + 1;
        continue;
      }
      // A reference definition is metadata, not speech.
      if (next === ":" && (i === 0 || text[i - 1] === "\n")) {
        const end = text.indexOf("\n", close + 2);
        if (end < 0 && !final) break;
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      // Unresolved shortcut references may later become links.
      i = close + 1;
      continue;
    }
    if (c === "<") {
      const end = text.indexOf(">", i + 1);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if ((i === 0 || /[\s([{]/.test(text[i - 1])) &&
        /^(?:https?:\/\/|www\.|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?=[:/?#]|\s|$))/i.test(rest)) {
      const end = rest.search(/\s/);
      if (end < 0 && !final) break;
      i += end < 0 ? rest.length : end;
      speech += " ";
      continue;
    }
    if (c === "*" || c === "_") {
      const run = rest.startsWith(c + c) ? c + c : c;
      if (i + run.length === text.length && !final) break;
      const close = text.indexOf(run, i + run.length);
      if (close < 0) break;
      const inner = text.slice(i + run.length, close);
      if (/[[\]`~<>\\\n]/.test(inner)) break;
      speech += inner;
      i = close + run.length;
      continue;
    }
    speech += c;
    i++;
    if (/[.!?]/.test(c) && i < text.length && /\s/.test(text[i])) return { end: i, speech };
  }
  return final && i === text.length ? { end: i, speech } : { end: 0, speech: "" };
}

export class StreamingParser {
  private buffer = "";

  push(delta: string, final = false): string[] {
    this.buffer += delta;
    if (Buffer.byteLength(this.buffer, "utf8") > 65536) throw new Error("Voice streaming buffer overflow");
    const result: string[] = [];
    while (this.buffer) {
      const { end, speech } = scan(this.buffer, final);
      if (!end) break;
      this.buffer = this.buffer.slice(end);
      if (speech.trim()) result.push(speech.trim());
    }
    return result;
  }
}
