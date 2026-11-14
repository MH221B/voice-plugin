import type { Emotion, Emotions } from "./types.js";

const EMOTIONS = new Set<string>(["calm", "excited", "sad", "reassuring", "serious"]);

// Literal sound tokens documented for Chatterbox Nano/Turbo in README.md.
// Both parsers must treat these as speech; they are not plugin tags.
const SOUND_TAGS = new Set([
  "clear throat", "sigh", "shush", "cough", "groan",
  "sniff", "gasp", "chuckle", "laugh",
]);

export function emotionWeights(value: string): Emotions {
  const result: Emotions = {};
  for (const entry of value.split(",")) {
    const match = /^\s*([a-z]+)\s*:\s*((?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(entry);
    if (match && EMOTIONS.has(match[1]) && Number(match[2]) <= 1) {
      result[match[1] as Emotion] = Number(match[2]);
    }
  }
  return result;
}

export function isSoundTag(label: string): boolean {
  return SOUND_TAGS.has(label.trim().toLowerCase());
}

export function isVoiceLabel(label: string): boolean {
  return /^\/?voice\b/i.test(label);
}

export function voiceWeights(label: string): string | undefined {
  return /^voice\s+emotions="([^"\n]*)"\s*$/.exec(label)?.[1];
}

export function isVoiceClosing(label: string): boolean {
  return /^\/voice\s*$/i.test(label);
}

/**
 * True when every bracketed construct in the text is a documented sound tag.
 * A tag followed by `(`, `[` or `:` is withheld because it may be a link
 * or reference definition.
 */
export function onlySoundTags(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "]") return false;
    if (text[i] !== "[") continue;
    const close = text.indexOf("]", i + 1);
    if (close < 0 || !isSoundTag(text.slice(i + 1, close))) return false;
    const next = text[close + 1];
    // A colon may introduce a reference definition, including at a line start.
    // Reject it conservatively anywhere inside a voice span.
    if (next === "(" || next === "[" || next === ":") return false;
    i = close;
  }
  return true;
}
