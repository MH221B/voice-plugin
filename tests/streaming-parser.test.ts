import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamingParser } from "../src/shared/streaming-parser.js";
import { parseReply } from "../src/shared/parse-reply.js";

test("plain sentences survive every delta split", () => {
  const text = "Hello world. Next sentence! Tail";
  for (let i = 0; i <= text.length; i++) {
    const parser = new StreamingParser();
    assert.deepEqual([...parser.push(text.slice(0, i)), ...parser.push(text.slice(i)), ...parser.push("", true)],
      ["Hello world.", "Next sentence!", "Tail"]);
  }
});

test("supported markup is handled at every split and later prose continues", () => {
  const examples = [
    ["Read [the guide](https://example.com/a.b). Next sentence.", ["Read the guide.", "Next sentence."]],
    ["See ![diagram](https://example.com/a.b). Next sentence.", ["See diagram.", "Next sentence."]],
    ["Read [guide][ref]. Next sentence.", ["Read guide.", "Next sentence."]],
    ["Run `code here`. Next sentence.", ["Run code here.", "Next sentence."]],
    ["Before. ```\nsecret. code\n```\nAfter.", ["Before.", "After."]],
    ["Visit https://example.com/a.b now. Next sentence.", ["Visit now.", "Next sentence."]],
    ["Visit www.example.com/a.b now. Next sentence.", ["Visit now.", "Next sentence."]],
    ["Visit example.com now. Next sentence.", ["Visit now.", "Next sentence."]],
    ["See <https://example.com/a.b> now. Next sentence.", ["See now.", "Next sentence."]],
    ["Say **hello** now. Next sentence.", ["Say hello now.", "Next sentence."]],
  ] as const;
  for (const [text, expected] of examples) {
    for (let i = 0; i <= text.length; i++) {
      const parser = new StreamingParser();
      const chunks = [...parser.push(text.slice(0, i)), ...parser.push(text.slice(i)), ...parser.push("", true)];
      assert.deepEqual(chunks.flatMap((chunk) => parseReply(chunk).map((unit) => unit.text)), expected, `${text} split ${i}`);
    }
  }
});

test("voice span waits for its close and keeps emotion", () => {
  const text = '[voice emotions="sad:0.5"]Quiet words.[/voice] Next sentence.';
  for (let i = 0; i <= text.length; i++) {
    const parser = new StreamingParser();
    const chunks = [...parser.push(text.slice(0, i)), ...parser.push(text.slice(i)), ...parser.push("", true)];
    const units = chunks.flatMap(parseReply);
    assert.equal(units[0].text, "Quiet words.");
    assert.deepEqual(units[0].emotions, { sad: 0.5 });
    assert.equal(units[1].text, "Next sentence.");
  }
});

test("unclosed constructs and nested voice tags are not spoken", () => {
  for (const text of ["Before [secret.", "Before `secret.", "Before <secret.", 'Before [voice emotions="sad:1"]secret.',
    '[voice emotions="sad:1"]hidden [voice emotions="calm:1"]secret[/voice][/voice]']) {
    const parser = new StreamingParser();
    const units = [...parser.push(text), ...parser.push("", true)].flatMap(parseReply);
    assert.equal(units.some((unit) => /secret|hidden/.test(unit.text)), false, text);
  }
});
