import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { spawn } from "node:child_process";
import { WorkerClient } from "../src/shared/worker-client.js";
import type { WorkerRequest, WorkerResponse } from "../src/shared/types.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: string[] = [];
  stdin = new Writable({ write: (chunk, _encoding, callback) => { this.writes.push(chunk.toString()); callback(); } });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill() { this.killed = true; return true; }
}

function fixture() {
  const child = new FakeChild();
  const terminal: [string, string, WorkerResponse][] = [];
  const failures: string[] = [];
  let args: unknown[] = [];
  const client = new WorkerClient({ python: "absolute-python", projectRoot: "absolute-root",
    spawn: ((...values: unknown[]) => { args = values; return child; }) as unknown as typeof spawn,
    onTerminal: (session, id, response) => terminal.push([session, id, response]),
    onFailure: (message) => failures.push(message),
  });
  const speak = (id: string, sessionId = "session"): WorkerRequest => ({ type: "speak", id, sessionId,
    units: [{ text: "Hello", emotions: {}, boundary: "sentence" }], config: { voice: "af_heart", speed: 1 } });
  return { child, client, terminal, failures, speak, args };
}

test("buffers until readiness, parses split lines and routes terminal responses once", () => {
  const { child, client, terminal, failures, speak, args } = fixture();
  assert.deepEqual(args, ["absolute-python", ["-m", "worker.main"], { cwd: "absolute-root", stdio: "pipe" }]);
  assert.equal(client.send(speak("a", "one")), true);
  assert.equal(client.send(speak("b", "two")), true);
  assert.equal(child.writes.length, 0);
  child.stdout.write('{"type":"rea'); child.stdout.write('dy"}\n');
  assert.equal(child.writes.length, 2);
  child.stdout.write('{"type":"done","id":"a"}\n{"type":"error",');
  child.stdout.write('"id":"b","message":"device"}\n{"type":"done","id":"a"}\n{"type":"done","id":"unknown"}\n');
  assert.deepEqual(terminal, [["one", "a", { type: "done", id: "a" }],
    ["two", "b", { type: "error", id: "b", message: "device" }]]);
  assert.deepEqual(failures, []);
  client.dispose(); assert.equal(child.killed, true);
});

test("malformed output and exits fail all requests with one process notification", () => {
  for (const action of [(child: FakeChild) => child.stdout.write('not json\n'),
    (child: FakeChild) => child.emit("exit", 0, null),
    (child: FakeChild) => child.emit("exit", 1, null),
    (child: FakeChild) => child.emit("error", new Error("spawn"))]) {
    const { child, client, terminal, failures, speak } = fixture();
    client.send(speak("a")); client.send(speak("b", "other")); action(child);
    child.emit("exit", 1, null);
    assert.equal(failures.length, 1);
    assert.deepEqual(terminal, [["session", "a", { type: "cancelled", id: "a" }],
      ["other", "b", { type: "cancelled", id: "b" }]]);
    assert.equal(client.send(speak("c")), false);
    client.dispose();
  }
});

test("synchronous write failure returns false and dispose ignores later exits", () => {
  const { child, client, failures, speak } = fixture();
  child.stdout.write('{"type":"ready"}\n');
  child.stdin.write = (() => { throw new Error("broken pipe"); }) as typeof child.stdin.write;
  assert.equal(client.send(speak("a")), false);
  assert.equal(failures.length, 1);
  client.dispose();
  child.emit("exit", 0, null);
  assert.equal(failures.length, 1);
});

test("asynchronous stdin errors fail queued requests", async () => {
  const { child, client, failures, terminal, speak } = fixture();
  client.send(speak("a"));
  child.stdin.emit("error", new Error("pipe"));
  assert.equal(failures.length, 1);
  assert.equal(terminal.length, 1);
  client.dispose();
});
