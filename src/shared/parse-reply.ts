import type { Emotion, Emotions, SpeechUnit } from "./types.js";

const names = new Set<string>(["calm", "excited", "sad", "reassuring", "serious"]);

function weights(value: string): Emotions {
  const result: Emotions = {};
  for (const entry of value.split(",")) {
    const match = /^\s*([a-z]+)\s*:\s*((?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(entry);
    if (match && names.has(match[1]) && Number(match[2]) <= 1) {
      result[match[1] as Emotion] = Number(match[2]);
    }
  }
  return result;
}

function withoutFences(input: string): string {
  let output = "";
  let fence: string | undefined;
  for (const line of input.split(/(?<=\n)/)) {
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}(?=\\s|$)`).exec(line);
      if (closing) {
        fence = undefined;
        output += line.slice(closing[0].length);
      }
    } else {
      const opening = /(`{3,}|~{3,})/.exec(line);
      if (opening) {
        output += line.slice(0, opening.index) + "\n";
        fence = opening[0];
      } else {
        output += line;
      }
    }
  }
  return output;
}

function clean(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/`+([^`]*?)`+/g, "$1")
    .replace(/https?:\/\/[^\s<>]+/gi, "")
    .replace(/(\*\*|__|\*|_|~~|~)(?=\S)(.*?)\1/g, "$2")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?)/g, "$1")
    .replace(/\s+/g, " ");
}

export function parseReply(input: string): SpeechUnit[] {
  const text = withoutFences(input);
  const tags = [...text.matchAll(/\[\/?voice\b[^\[\]\n]*\]/gi)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
    pair: -1,
    nested: false,
  }));
  const stack: number[] = [];
  for (let i = 0; i < tags.length; i++) {
    if (/^\[\/voice\s*\]$/i.test(tags[i].text)) {
      const open = stack.pop();
      if (open !== undefined) {
        tags[open].pair = i;
        tags[i].pair = open;
        tags[i].nested = tags[open].nested;
      }
    } else {
      if (stack.length) {
        for (const open of stack) tags[open].nested = true;
        tags[i].nested = true;
      }
      stack.push(i);
    }
  }

  const parts: { text: string; emotions: Emotions }[] = [];
  let position = 0;
  let emotions: Emotions = {};
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    parts.push({ text: text.slice(position, tag.start), emotions });
    const opening = /^\[voice\s+emotions="([^"\n]*)"\s*\]$/.exec(tag.text);
    if (!opening && !/^\[\/voice\s*\]$/i.test(tag.text)) {
      parts.push({ text: tag.text, emotions: {} });
    }
    if (opening && tag.pair > i && !tag.nested) emotions = weights(opening[1]);
    if (tag.pair < i && tag.pair >= 0 && !tag.nested) emotions = {};
    position = tag.end;
  }
  parts.push({ text: text.slice(position), emotions });

  const cleaned = parts.map((part) => ({ ...part, text: clean(part.text) }));
  const units: SpeechUnit[] = [];
  let boundary: SpeechUnit["boundary"] = "sentence";
  for (let i = 0; i < cleaned.length; i++) {
    const part = cleaned[i];
    const following = cleaned.slice(i + 1).map((next) => next.text).join("");
    const pieces = part.text.split(/(?<=[.!?])(?=\s)/);
    for (let j = 0; j < pieces.length; j++) {
      const piece = pieces[j].trim();
      if (!piece) continue;
      units.push({ text: piece, emotions: part.emotions, boundary });
      const after = j < pieces.length - 1 ? pieces[j + 1] : following;
      boundary = /[.!?]$/.test(piece) && (!after || /^\s/.test(after)) ? "sentence" : "span";
    }
  }
  return units;
}
