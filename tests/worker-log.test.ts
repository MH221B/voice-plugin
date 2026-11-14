import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { spawn } from "node:child_process";
import { WorkerClient } from "../src/shared/worker-client.js";
import { WorkerLog } from "../src/shared/worker-log.js";

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for log");
}

test("opt-in logs stderr, diagnostics and errors separately without changing protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-log-"));
  class Child extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    exitCode = null; signalCode = null;
    kill() { return true; }
  }
  const create = (log: boolean) => {
    const child = new Child();
    const diagnostics: string[] = [];
    const client = new WorkerClient({ python: "python", projectRoot: root, log,
      spawn: (() => child) as unknown as typeof spawn,
      onTerminal: () => {}, onFailure: () => {}, onDiagnostic: (s) => diagnostics.push(s) });
    return { child, client, diagnostics };
  };
  try {
    const disabled = create(false);
    disabled.child.stderr.write("not saved");
    disabled.client.dispose();
    await assert.rejects(readdir(join(root, ".voice-cache")));
    const a = create(true);
    const b = create(true);
    a.client.send({ type: "speak", id: "1", sessionId: "s", units: [], config: { voice: "af_heart", speed: 1 } });
    a.child.stdout.write('{"type":"ready"}\n{"type":"diagnostic","id":"1","message":"fallback"}\n{"type":"error","id":"1","message":"failure"}\n{"type":"diagnostic","id":"1","message":"stale"}\n');
    a.child.emit("exit", 1, null);
    a.child.stderr.end("after exit");
    b.child.stderr.end("second worker");
    await until(async () => {
      const names = await readdir(join(root, ".voice-cache")).catch(() => []);
      if (names.length !== 2) return false;
      const contents = await Promise.all(names.map((n) => readFile(join(root, ".voice-cache", n), "utf8")));
      return contents.some((s) => s.includes("after exit")) && contents.some((s) => s.includes("second worker"));
    });
    const names = await readdir(join(root, ".voice-cache"));
    const contents = (await Promise.all(names.map((n) => readFile(join(root, ".voice-cache", n), "utf8")))).join("\n");
    assert.match(contents, /fallback/);
    assert.match(contents, /failure/);
    assert.deepEqual(a.diagnostics, ["fallback"]);
    a.client.dispose(); b.client.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded rotation, oversized writes, and sink failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-log-"));
  try {
    const log = new WorkerLog(root);
    log.write(Buffer.alloc(2 * 1024 * 1024, 65));
    const dir = join(root, ".voice-cache");
    await until(async () => (await readdir(dir).catch(() => [])).length === 1);
    const filename = (await readdir(dir))[0];
    await until(async () => (await stat(join(dir, filename))).size === 65536);
    for (let i = 0; i < 40; i++) {
      log.write(Buffer.alloc(65536, 66));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await until(async () => (await readdir(dir)).length === 2);
    for (const name of await readdir(dir)) assert.ok((await stat(join(dir, name))).size <= 1024 * 1024);
    const broken = join(root, "broken");
    await writeFile(broken, "file");
    const bad = new WorkerLog(broken);
    assert.doesNotThrow(() => bad.write("ignored"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotThrow(() => bad.write("still ignored"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
