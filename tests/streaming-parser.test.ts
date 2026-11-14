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

test("native sound tags are spoken at every split", () => {
  const text = "**Hi** [laugh] next. [chuckle] Tail";
  for (let i = 0; i <= text.length; i++) {
    const parser = new StreamingParser();
    const chunks = [...parser.push(text.slice(0, i)), ...parser.push(text.slice(i)), ...parser.push("", true)];
    assert.deepEqual(chunks.flatMap((chunk) => parseReply(chunk).map((unit) => unit.text)),
      ["Hi [laugh] next.", "[chuckle] Tail"], `split ${i}`);
  }
});

test("native sound tags stream before a later shortcut reference definition", () => {
  const parser = new StreamingParser();
  assert.deepEqual(parser.push("[laugh] now.\n"), ["[laugh] now."]);
  assert.deepEqual(parser.push("\n[laugh]: https://example.com secret metadata\nAfter."), []);
  assert.deepEqual(parser.push("", true), ["After."]);
});

test("voice spans may contain sound tags but not nested markup", () => {
  const text = '[voice emotions="sad:1"]Oh [cough].[/voice] Later.';
  for (let i = 0; i <= text.length; i++) {
    const parser = new StreamingParser();
    const chunks = [...parser.push(text.slice(0, i)), ...parser.push(text.slice(i)), ...parser.push("", true)];
    const units = chunks.flatMap(parseReply);
    assert.deepEqual(units.map((unit) => unit.text), ["Oh [cough].", "Later."], `split ${i}`);
    assert.deepEqual(units[0].emotions, { sad: 1 }, `split ${i}`);
  }
  const nested = new StreamingParser();
  const units = [...nested.push('[voice emotions="sad:1"]a [voice emotions="calm:1"]b[/voice][/voice]'),
    ...nested.push("", true)].flatMap(parseReply);
  assert.equal(units.some((unit) => /a|b/.test(unit.text)), false);
});

test("sound tags that become links are spoken as labels", () => {
  for (const [text, expected] of [
    ["See [laugh](https://example.com) now.", "See laugh now."],
    ["See [laugh][ref] now.", "See laugh now."],
  ] as const) {
    const parser = new StreamingParser();
    const units = [...parser.push(text), ...parser.push("", true)].flatMap(parseReply);
    assert.deepEqual(units.map((unit) => unit.text), [expected]);
  }
});

test("incomplete native tags remain withheld", () => {
  const parser = new StreamingParser();
  assert.deepEqual([...parser.push("Before [laugh"), ...parser.push("", true)], []);
});

test("reference definitions inside voice spans are never spoken at any split", () => {
  for (const body of ["[laugh]: secret metadata", "\n[laugh]: secret metadata\n"]) {
    const text = `[voice emotions="sad:1"]${body}[/voice]`;
    for (let i = 0; i <= text.length; i++) {
      const parser = new StreamingParser();
      const units = [...parser.push(text.slice(0, i)), ...parser.push(text.slice(i)),
        ...parser.push("", true)].flatMap(parseReply);
      assert.equal(units.some((unit) => /secret|metadata|\[laugh\]/.test(unit.text)),
        false, `${JSON.stringify(body)} split ${i}`);
    }
  }
});

test("indented reference definitions are withheld at every split", () => {
  for (let spaces = 0; spaces <= 3; spaces++) {
    for (const prefix of ["", "Before.\n"]) {
      for (const label of ["laugh", "reference"]) {
        const text = `${prefix}${" ".repeat(spaces)}[${label}]: https://example.com secret metadata\nAfter.`;
        for (let i = 0; i <= text.length; i++) {
          const parser = new StreamingParser();
          const units = [...parser.push(text.slice(0, i)), ...parser.push(text.slice(i)),
            ...parser.push("", true)].flatMap(parseReply);
          assert.deepEqual(units.map((unit) => unit.text),
            prefix ? ["Before.", "After."] : ["After."], `${JSON.stringify(text)} split ${i}`);
        }
      }
    }
  }
});

test("streaming buffer is bounded", () => {
  assert.throws(() => new StreamingParser().push("x".repeat(65537)), /buffer overflow/);
});
