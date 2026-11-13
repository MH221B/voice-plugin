import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionPlayback } from "../src/shared/session-playback.js";
import type { WorkerRequest } from "../src/shared/types.js";

test("deduplication, replacement and cancellation are session scoped", () => {
  const sent: WorkerRequest[] = [];
  const errors: string[] = [];
  const playback = new SessionPlayback({ send: (request) => { sent.push(request); return true; } },
    { voice: "af_heart", speed: 1 }, (session, message) => errors.push(`${session}: ${message}`));
  const answer = (sessionId: string, answerId: string) => playback.answer({ sessionId, answerId, text: "Hello." });
  answer("a", "1"); answer("a", "1"); answer("b", "1");
  assert.equal(sent.length, 2);
  const first = sent[0]; const other = sent[1];
  assert.equal(first.type, "speak"); assert.equal(other.type, "speak");
  answer("a", "2");
  assert.deepEqual(sent[2], { type: "cancel", id: first.id });
  const replacement = sent[3]; assert.equal(replacement.type, "speak");
  playback.finished("a", first.id, { type: "error", id: first.id, message: "stale" });
  playback.stop("a");
  assert.deepEqual(sent[4], { type: "cancel", id: replacement.id });
  playback.setEnabled("b", false);
  assert.deepEqual(sent[5], { type: "cancel", id: other.id });
  answer("b", "2"); assert.equal(sent.length, 6);
  playback.setEnabled("b", true); answer("b", "2");
  assert.equal(sent.length, 7);
  const current = sent[6]; assert.equal(current.type, "speak");
  playback.finished("b", current.id, { type: "error", id: current.id, message: "device" });
  playback.finished("b", current.id, { type: "error", id: current.id, message: "device" });
  assert.deepEqual(errors, ["b: device"]);
  playback.stop("b"); assert.equal(sent.length, 7);
});

test("failed acceptance permits retry and empty answers do not speak", () => {
  let accepts = false;
  const sent: WorkerRequest[] = [];
  const playback = new SessionPlayback({ send: (request) => { sent.push(request); return accepts; } },
    { voice: "af_heart", speed: 1 }, () => assert.fail());
  const answer = { sessionId: "a", answerId: "1", text: "Hello" };
  playback.answer(answer); accepts = true; playback.answer(answer); playback.answer(answer);
  assert.equal(sent.length, 2);
  playback.answer({ sessionId: "b", answerId: "2", text: "```\ncode\n```" });
  assert.equal(sent.length, 2);
});
