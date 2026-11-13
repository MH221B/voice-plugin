import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReply } from "../src/shared/parse-reply.js";

test("neutral prose and sentences", () => {
  assert.deepEqual(parseReply("Hello world. Next! Really? Yes"), [
    { text: "Hello world.", emotions: {}, boundary: "sentence" },
    { text: "Next!", emotions: {}, boundary: "sentence" },
    { text: "Really?", emotions: {}, boundary: "sentence" },
    { text: "Yes", emotions: {}, boundary: "sentence" },
  ]);
});

test("mixed weights, invalid entries and last valid duplicate", () => {
  assert.deepEqual(parseReply('[voice emotions="calm:0.3,reassuring:.7,calm:0.9,calm:2,sad:-1,excited:NaN,unknown:0.5"]Hello.[/voice]'), [
    { text: "Hello.", emotions: { calm: 0.9, reassuring: 0.7 }, boundary: "sentence" },
  ]);
  assert.deepEqual(parseReply('[voice emotions="unknown:0.4,sad:1.1"]Neutral[/voice]'), [
    { text: "Neutral", emotions: {}, boundary: "sentence" },
  ]);
});

test("adjacent spans and sentence boundaries across closing tags", () => {
  assert.deepEqual(parseReply('Start [voice emotions="sad:0.7"]one,[/voice] [voice emotions="excited:0.8"]two![/voice] Next. [voice emotions="calm:1"]Done.[/voice]'), [
    { text: "Start", emotions: {}, boundary: "sentence" },
    { text: "one,", emotions: { sad: 0.7 }, boundary: "span" },
    { text: "two!", emotions: { excited: 0.8 }, boundary: "span" },
    { text: "Next.", emotions: {}, boundary: "sentence" },
    { text: "Done.", emotions: { calm: 1 }, boundary: "sentence" },
  ]);
  assert.equal(parseReply('[voice emotions="sad:1"]Hi.[/voice]there')[1].boundary, "span");
});

test("nested, unmatched, malformed and split markup retain neutral words", () => {
  const samples = [
    '[voice emotions="sad:1"]outer [voice emotions="calm:1"]inner[/voice] tail[/voice]',
    '[voice emotions="sad:1"]unmatched words',
    '[voice emotion="sad:1"]malformed words[/voice]',
    '[voice emotions="sad:1"\n]split words[/voice]',
  ];
  for (const sample of samples) {
    const units = parseReply(sample);
    assert.ok(units.every((unit) => Object.keys(unit.emotions).length === 0));
    for (const word of sample.match(/outer|inner|tail|unmatched|malformed|split|words/g) ?? []) {
      assert.ok(units.map((unit) => unit.text).join(" ").includes(word));
    }
  }
  assert.ok(parseReply('[voice is good] prose').map((unit) => unit.text).join(" ").includes("voice is good"));
});

test("Markdown labels, inline code, URLs and decoration", () => {
  assert.deepEqual(parseReply('**Read** [this](https://example.com) ![diagram](img.png) and `code_name` at https://example.org/path'), [
    { text: "Read this diagram and code_name at", emotions: {}, boundary: "sentence" },
  ]);
});

test("closed and unclosed fences preserve surrounding prose", () => {
  assert.deepEqual(parseReply('Before\n```ts\nsecret()\n```\nBetween\n~~~\nhidden\n~~~\nAfter'), [
    { text: "Before Between After", emotions: {}, boundary: "sentence" },
  ]);
  assert.deepEqual(parseReply('Before ```js\nsecret\n```\nAfter\n~~~\nunclosed'), [
    { text: "Before After", emotions: {}, boundary: "sentence" },
  ]);
});

test("native tags survive Markdown and voice span parsing", () => {
  const units = parseReply('**Hello** [laugh] [voice emotions="sad:1"]Oh [cough].[/voice] [chuckle] [link](https://example.com)');
  assert.deepEqual(units.map((unit) => unit.text), ["Hello [laugh]", "Oh [cough].", "[chuckle] link"]);
  assert.deepEqual(units[1].emotions, { sad: 1 });
});
