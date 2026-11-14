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
  answer("a", "1"); answer("b", "1"); assert.equal(sent.length, 0);
  playback.setEnabled("a", true);
  answer("a", "1"); answer("a", "1"); answer("b", "1");
  assert.equal(sent.length, 1);
  const first = sent[0]; assert.equal(first.type, "speak");
  answer("a", "2");
  assert.deepEqual(sent[1], { type: "cancel", id: first.id });
  const replacement = sent[2]; assert.equal(replacement.type, "speak");
  playback.finished("a", first.id, { type: "error", id: first.id, message: "stale" });
  playback.setEnabled("b", true);
  assert.deepEqual(sent[3], { type: "cancel", id: replacement.id });
  assert.equal(playback.status("a"), "OFF");
  answer("a", "3"); answer("b", "1");
  const other = sent[4]; assert.equal(other.type, "speak");
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
  playback.setEnabled("a", true);
  playback.answer(answer); accepts = true; playback.answer(answer); playback.answer(answer);
  assert.equal(sent.length, 2);
  playback.answer({ sessionId: "b", answerId: "2", text: "```\ncode\n```" });
  assert.equal(sent.length, 2);
});

test("status follows accepted requests and remains session scoped", () => {
  const sent: WorkerRequest[] = [];
  let changes = 0;
  let accepts = false;
  const playback = new SessionPlayback({ send: (request) => { sent.push(request); return accepts; } },
    { voice: "af_heart", speed: 1 }, () => {}, () => changes++);
  const answer = (answerId: string) => playback.answer({ sessionId: "a", answerId, text: "Hello" });
  assert.equal(playback.status("a"), "OFF");
  playback.setEnabled("a", true);
  changes = 0;
  answer("1"); assert.equal(playback.status("a"), "ON"); assert.equal(changes, 0);
  accepts = true; answer("1");
  const first = sent.at(-1)!;
  assert.equal(playback.status("a"), "WORKING"); assert.equal(playback.status("b"), "OFF");
  playback.setEnabled("b", false); assert.equal(playback.status("b"), "OFF");
  playback.finished("a", "stale", { type: "done", id: "stale" });
  assert.equal(playback.status("a"), "WORKING");
  playback.finished("a", first.id, { type: "error", id: first.id, message: "failed" });
  assert.equal(playback.status("a"), "ON");
  answer("2"); playback.stop("a"); assert.equal(playback.status("a"), "ON");
  answer("3"); playback.setEnabled("a", false); assert.equal(playback.status("a"), "OFF");
  playback.setEnabled("a", true); assert.equal(playback.status("a"), "ON");
  assert.equal(playback.status("b"), "OFF"); assert.ok(changes > 0);
});

test("stream queue is ordered, bounded, and ignores stale callbacks", () => {
  const sent: WorkerRequest[] = [];
  const errors: string[] = [];
  const playback = new SessionPlayback({ send: (request) => { sent.push(request); return true; } },
    { voice: "af_heart", speed: 1 }, (_session, message) => errors.push(message));
  playback.setEnabled("a", true);
  const token = playback.token("a")!;
  for (let i = 0; i < 32; i++) assert.equal(playback.stream("a", token, `Sentence ${i}.`), true);
  assert.equal(playback.status("a"), "WORKING");
  assert.equal(playback.stream("a", token, "Overflow."), false);
  assert.equal(sent.filter((request) => request.type === "cancel").length, 32);
  assert.deepEqual(errors, ["Voice streaming queue overflow"]);
  const first = sent[0];
  playback.finished("a", first.id, { type: "error", id: first.id, message: "stale" });
  assert.deepEqual(errors, ["Voice streaming queue overflow"]);
  assert.equal(playback.status("a"), "ON");
});

test("stream failure cancels other requests and reports once", () => {
  const sent: WorkerRequest[] = [];
  const errors: string[] = [];
  const playback = new SessionPlayback({ send: (request) => { sent.push(request); return true; } },
    { voice: "af_heart", speed: 1 }, (_session, message) => errors.push(message));
  playback.setEnabled("a", true);
  const token = playback.token("a")!;
  playback.stream("a", token, "First."); playback.stream("a", token, "Second.");
  playback.finished("a", sent[0].id, { type: "error", id: sent[0].id, message: "failed" });
  playback.finished("a", sent[1].id, { type: "error", id: sent[1].id, message: "stale" });
  assert.deepEqual(errors, ["failed"]);
  assert.deepEqual(sent.slice(2), [{ type: "cancel", id: sent[1].id }]);
});
