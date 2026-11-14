import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
import type { Plugin } from "@opencode/plugin/tui";
import { createPlugin } from "../src/opencode/index.js";
import type { WorkerRequest } from "../src/shared/types.js";

type Context = Plugin.Context;
type EventType = OpenCodeEvent["type"];
type EventOf<T extends EventType> = Extract<OpenCodeEvent, { type: T }>;
type Command = ReturnType<Parameters<Context["keymap"]["layer"]>[0]>["commands"] extends readonly (infer C)[] | undefined ? C : never;

function fixture(options: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: never) => void>();
  const sent: WorkerRequest[] = [];
  const toasts: string[] = [];
  let route: ReturnType<Context["ui"]["router"]["current"]> = { type: "session", sessionID: "s" };
  let messages: SessionMessageInfo[] = [];
  let sync = async () => {};
  let parentID: string | undefined;
  let sessionKnown = true;
  let syncSession = async () => {};
  let commands: readonly Command[] = [];
  let disposed = false;
  let statusRemoved = false;
  let statusSlot: Parameters<Context["ui"]["slot"]>[0] | undefined;
  let callbacks: Parameters<NonNullable<Parameters<typeof createPlugin>[0]>>[0] | undefined;
  const context = {
    options,
    ui: { router: { current: () => route }, toast: { show: ({ message }: { message: string }) => toasts.push(message) },
      slot: (claim: Parameters<Context["ui"]["slot"]>[0]) => { statusSlot = claim; return () => { statusRemoved = true; }; } },
    keymap: { layer: (factory: () => { commands: readonly Command[] }) => { commands = factory().commands; } },
    data: { on: (type: string, handler: (event: never) => void) => { handlers.set(type, handler); return () => handlers.delete(type); },
      session: { get: () => sessionKnown ? { id: "s", parentID } : undefined, sync: () => syncSession(), message: { sync: () => sync(), list: () => messages } } },
  } as unknown as Context;
  const plugin = createPlugin((value) => { callbacks = value; return {
    send: (request) => { sent.push(request); return true; }, dispose: () => { disposed = true; },
  }; });
  const cleanup = plugin.setup(context) as (() => void) | undefined;
  function emit<T extends EventType>(type: T, data: EventOf<T>["data"]) {
    handlers.get(type)?.({ type, data } as never);
  }
  const start = () => emit("session.execution.started", { sessionID: "s" });
  const step = (id = "answer", finish: "stop" | "tool-calls" = "stop") => emit("session.step.ended", {
    sessionID: "s", assistantMessageID: id, finish, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  const success = () => emit("session.execution.succeeded", { sessionID: "s" });
  return { emit, start, step, success, sent, toasts, handlers, commands, cleanup,
    setRoute: (value: typeof route) => { route = value; },
    setMessages: (value: SessionMessageInfo[]) => { messages = value; },
    setSync: (value: typeof sync) => { sync = value; },
    setParent: (value: string | undefined) => { parentID = value; },
    setSessionKnown: (value: boolean) => { sessionKnown = value; },
    setSessionSync: (value: typeof syncSession) => { syncSession = value; },
    disposed: () => disposed, callbacks: () => callbacks, statusSlot: () => statusSlot, statusRemoved: () => statusRemoved };
}

function message(overrides: Partial<Extract<SessionMessageInfo, { type: "assistant" }>> = {}): SessionMessageInfo {
  return { id: "answer", type: "assistant", agent: "agent", model: { providerID: "p", id: "m" },
    time: { created: 1, completed: 2 }, finish: "stop", content: [
      { type: "reasoning", text: "secret" },
      { type: "tool", id: "tool", name: "tool", state: { status: "streaming", input: "private" }, time: { created: 1 } },
      { type: "text", text: "Visible" },
    ], ...overrides };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("streaming speaks before success and reconciles the final tail", async () => {
  const f = fixture({ streamSpeech: true });
  f.commands[0].run();
  f.start();
  f.emit("session.step.started", { sessionID: "s", assistantMessageID: "answer", agent: "agent", model: { providerID: "p", id: "m" }, started: 1 });
  f.emit("session.text.started", { sessionID: "s", assistantMessageID: "answer", ordinal: 0 });
  f.emit("session.text.delta", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, delta: "Hello. Tail" });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "speak");
  if (f.sent[0].type === "speak") assert.equal(f.sent[0].units[0].text, "Hello.");
  f.emit("session.text.ended", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, text: "Hello. Tail" });
  f.setMessages([message({ content: [{ type: "reasoning", text: "secret" }, { type: "text", text: "Hello. Tail" }] })]);
  f.step(); f.success(); await tick();
  assert.equal(f.sent.length, 2);
  if (f.sent[1].type === "speak") assert.equal(f.sent[1].units[0].text, "Tail");
  f.cleanup?.();
});

test("streaming mismatch and stop cancel queued speech and suppress later deltas", () => {
  for (const stop of ["mismatch", "command"] as const) {
    const f = fixture({ streamSpeech: true }); f.commands[0].run(); f.start();
    f.emit("session.step.started", { sessionID: "s", assistantMessageID: "answer", agent: "agent", model: { providerID: "p", id: "m" }, started: 1 });
    f.emit("session.text.started", { sessionID: "s", assistantMessageID: "answer", ordinal: 0 });
    f.emit("session.text.delta", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, delta: "Hello. " });
    if (stop === "command") f.commands[2].run();
    else f.emit("session.text.ended", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, text: "different" });
    f.emit("session.text.delta", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, delta: "Later. " });
    assert.deepEqual(f.sent.map((request) => request.type), ["speak", "cancel"]);
    f.cleanup?.();
  }
});

test("streaming invalid finishes cancel without waiting for execution end", () => {
  for (const finish of ["tool-calls", "error", "content-filter", "length", "unknown"] as const) {
    const f = fixture({ streamSpeech: true }); f.commands[0].run(); f.start();
    f.emit("session.step.started", { sessionID: "s", assistantMessageID: "answer", agent: "agent", model: { providerID: "p", id: "m" }, started: 1 });
    f.emit("session.text.started", { sessionID: "s", assistantMessageID: "answer", ordinal: 0 });
    f.emit("session.text.delta", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, delta: "Hello. " });
    f.emit("session.text.ended", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, text: "Hello. " });
    f.emit("session.step.ended", { sessionID: "s", assistantMessageID: "answer", finish, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    assert.deepEqual(f.sent.map((request) => request.type), ["speak", "cancel"], finish);
    f.cleanup?.();
  }
});

test("final synchronization mismatch cancels streamed requests", async () => {
  const f = fixture({ streamSpeech: true }); f.commands[0].run(); f.start();
  f.emit("session.step.started", { sessionID: "s", assistantMessageID: "answer", agent: "agent", model: { providerID: "p", id: "m" }, started: 1 });
  f.emit("session.text.started", { sessionID: "s", assistantMessageID: "answer", ordinal: 0 });
  f.emit("session.text.delta", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, delta: "Hello. Tail" });
  f.emit("session.text.ended", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, text: "Hello. Tail" });
  f.setMessages([message()]); f.step(); f.success(); await tick();
  assert.deepEqual(f.sent.map((request) => request.type), ["speak", "cancel"]);
  f.cleanup?.();
});

test("missing middle delta can be spoken before end-event mismatch cancels it", () => {
  const f = fixture({ streamSpeech: true }); f.commands[0].run(); f.start();
  f.emit("session.step.started", { sessionID: "s", assistantMessageID: "answer", agent: "agent", model: { providerID: "p", id: "m" }, started: 1 });
  f.emit("session.text.started", { sessionID: "s", assistantMessageID: "answer", ordinal: 0 });
  f.emit("session.text.delta", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, delta: "This works. " });
  f.emit("session.text.ended", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, text: "This never works. " });
  assert.deepEqual(f.sent.map((request) => request.type), ["speak", "cancel"]);
  f.cleanup?.();
});

test("streaming requires root identity at execution start and survives navigation", () => {
  const unknown = fixture({ streamSpeech: true }); unknown.commands[0].run(); unknown.setSessionKnown(false); unknown.start();
  unknown.setSessionKnown(true);
  unknown.emit("session.step.started", { sessionID: "s", assistantMessageID: "answer", agent: "agent", model: { providerID: "p", id: "m" }, started: 1 });
  unknown.emit("session.text.started", { sessionID: "s", assistantMessageID: "answer", ordinal: 0 });
  unknown.emit("session.text.delta", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, delta: "No suffix. " });
  assert.equal(unknown.sent.length, 0); unknown.cleanup?.();

  const background = fixture({ streamSpeech: true }); background.commands[0].run(); background.start();
  background.setRoute({ type: "session", sessionID: "other" });
  background.emit("session.step.started", { sessionID: "s", assistantMessageID: "answer", agent: "agent", model: { providerID: "p", id: "m" }, started: 1 });
  background.emit("session.text.started", { sessionID: "s", assistantMessageID: "answer", ordinal: 0 });
  background.emit("session.text.delta", { sessionID: "s", assistantMessageID: "answer", ordinal: 0, delta: "Background works. " });
  assert.equal(background.sent[0].type, "speak"); background.cleanup?.();
});

test("enabled session speaks completed replies while viewing another session", async () => {
  const f = fixture();
  f.commands[0].run();
  f.setMessages([message()]);
  f.setRoute({ type: "session", sessionID: "other" });
  f.start(); f.step(); f.success(); await tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "speak");
  assert.equal(f.sent[0].sessionId, "s");
  f.cleanup?.();
});

test("does not speak a completed child session", async () => {
  const f = fixture();
  f.setParent("parent");
  f.setMessages([message()]);
  f.start(); f.step(); f.success(); await tick();
  assert.equal(f.sent.length, 0);
  f.cleanup?.();
});

test("resolves missing session metadata and fails closed", async () => {
  for (const outcome of ["root", "child", "missing", "error"] as const) {
    const f = fixture();
    f.commands[0].run();
    f.setSessionKnown(false);
    f.setSessionSync(async () => {
      if (outcome === "error") throw new Error("unavailable");
      if (outcome !== "missing") f.setSessionKnown(true);
      if (outcome === "child") f.setParent("parent");
    });
    f.setMessages([message()]); f.start(); f.step(); f.success(); await tick();
    assert.equal(f.sent.length, outcome === "root" ? 1 : 0, outcome);
    f.cleanup?.();
  }
});

test("rechecks parent metadata after message sync", async () => {
  const f = fixture();
  f.commands[0].run();
  f.setMessages([message()]);
  f.setSync(async () => { f.setParent("parent"); });
  f.start(); f.step(); f.success(); await tick();
  assert.equal(f.sent.length, 0);
  f.cleanup?.();
});

test("backend configuration selects Python and is sent with speech", async () => {
  const python = resolve("chatterbox-python");
  const referenceAudio = resolve("reference.wav");
  const f = fixture({ backend: "chatterbox-nano", chatterboxPython: python, referenceAudio });
  f.commands[0].run();
  assert.equal(f.callbacks()?.python, python);
  f.setMessages([message()]); f.start(); f.step(); f.success(); await tick();
  const request = f.sent[0];
  assert.equal(request.type, "speak");
  if (request.type === "speak") assert.deepEqual(request.config, { voice: "af_heart", speed: 1, backend: "chatterbox-nano", referenceAudio });
  f.callbacks()?.onDiagnostic?.("GPU failed; retrying on CPU");
  assert.equal(f.toasts.at(-1), "GPU failed; retrying on CPU");
  f.cleanup?.();
});

test("invalid backend paths and names report actionable errors", () => {
  for (const [options, expected] of [
    [{ backend: "other" }, "Invalid backend: choose kokoro, chatterbox-nano, chatterbox-turbo, or cosyvoice3"],
    [{ referenceAudio: "relative.wav" }, "referenceAudio must be an absolute path"],
    [{ chatterboxPython: "python" }, "chatterboxPython must be an absolute path"],
  ] as const) {
    const f = fixture(options);
    assert.deepEqual(f.toasts, [expected]);
    assert.equal(f.callbacks(), undefined);
  }
});

test("CosyVoice requires local paths and selects its own interpreter", async () => {
  const options = { backend: "cosyvoice3", cosyvoicePython: resolve("cosy-python"),
    cosyvoiceSource: resolve("cosy-source"), cosyvoiceModel: resolve("cosy-model"),
    referenceAudio: resolve("reference.wav") };
  for (const key of ["cosyvoicePython", "cosyvoiceSource", "cosyvoiceModel", "referenceAudio"] as const) {
    const bad = fixture({ ...options, [key]: "relative" });
    assert.match(bad.toasts[0], new RegExp(key));
    assert.equal(bad.callbacks(), undefined);
  }
  const f = fixture(options);
  f.commands[0].run();
  assert.equal(f.callbacks()?.python, options.cosyvoicePython);
  f.setMessages([message()]); f.start(); f.step(); f.success(); await tick();
  const request = f.sent[0];
  assert.equal(request.type, "speak");
  if (request.type === "speak") {
    assert.equal(request.config.cosyvoiceSource, options.cosyvoiceSource);
    assert.equal(request.config.cosyvoiceModel, options.cosyvoiceModel);
    assert.equal(request.config.referenceAudio, options.referenceAudio);
  }
  f.cleanup?.();
});

test("selects only the exact final completed answer and deduplicates success", async () => {
  const f = fixture(); f.setMessages([message(), message({ id: "older", content: [{ type: "text", text: "old" }] })]);
  f.commands[0].run();
  f.success(); await tick(); assert.equal(f.sent.length, 0);
  f.start(); f.step(); f.success(); f.success(); await tick();
  assert.equal(f.sent.length, 1);
  const request = f.sent[0]; assert.equal(request.type, "speak");
  assert.equal(request.units[0].text, "Visible");
  f.cleanup?.(); assert.equal(f.disposed(), true); assert.equal(f.handlers.size, 0);
});

test("skips missing, failed, interrupted, retry, ambiguous and non-final answers", async () => {
  const f = fixture();
  f.commands[0].run();
  for (const messages of [[], [message({ id: "other" })], [message(), message()],
    [message({ finish: "length" })], [message({ time: { created: 1 } })],
    [message({ retry: { attempt: 1, at: 1, error: { type: "unknown", message: "retry" } } })],
    [message({ content: [{ type: "reasoning", text: "secret" }] })]]) {
    f.setMessages(messages); f.start(); f.step(); f.success(); await tick();
  }
  f.setMessages([message()]); f.start(); f.step(); f.step("other", "tool-calls"); f.success();
  f.start(); f.step(); f.emit("session.execution.interrupted", { sessionID: "s", reason: "user" }); f.success();
  f.start(); f.step(); f.emit("session.execution.failed", { sessionID: "s", error: { type: "unknown", message: "failure" } }); f.success();
  f.start(); f.step(); f.emit("session.retry.scheduled", { sessionID: "s", assistantMessageID: "answer", attempt: 1, at: 1, error: { type: "retry", message: "retry" } }); f.success();
  await tick(); assert.equal(f.sent.length, 0); f.cleanup?.();
});

test("rechecks generation and ownership after sync, including later step", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => f.start(), (f: ReturnType<typeof fixture>) => f.step("later"),
    (f: ReturnType<typeof fixture>) => { f.setRoute({ type: "session", sessionID: "other" }); f.commands[0].run(); },
    (f: ReturnType<typeof fixture>) => f.commands[1].run(),
    (f: ReturnType<typeof fixture>) => f.cleanup?.()]) {
    const f = fixture(); f.setMessages([message()]); let resume!: () => void;
    f.commands[0].run();
    f.setSync(() => new Promise<void>((resolve) => { resume = resolve; }));
    f.start(); f.step(); f.success(); change(f); resume(); await tick();
    assert.equal(f.sent.length, 0); f.cleanup?.();
  }
  const f = fixture(); f.setRoute({ type: "home" }); f.start(); f.step(); f.success(); await tick();
  assert.equal(f.sent.length, 0); f.cleanup?.();
});

test("navigation during message sync does not suppress enabled session speech", async () => {
  const f = fixture(); f.commands[0].run(); f.setMessages([message()]);
  let resume!: () => void;
  f.setSync(() => new Promise<void>((resolve) => { resume = resolve; }));
  f.start(); f.step(); f.success();
  f.setRoute({ type: "home" }); resume(); await tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "speak");
  f.cleanup?.();
});

test("commands, configuration and worker notifications", async () => {
  const bad = fixture({ speed: 2 }); assert.deepEqual(bad.toasts, ["Invalid voice plugin configuration"]);
  const f = fixture(); f.setMessages([message()]); f.start(); f.step(); f.success(); await tick();
  assert.equal(f.sent.length, 0);
  f.commands[0].run(); f.success(); await tick();
  assert.equal(f.statusSlot()?.append, "prompt.footer.status");
  assert.deepEqual(f.commands.map((c) => [c.id, c.slash?.name]), [["voice.on", "voice-on"], ["voice.off", "voice-off"], ["voice.stop", "voice-stop"]]);
  const first = f.sent[0]; assert.equal(first.type, "speak");
  f.callbacks()?.onTerminal("s", first.id, { type: "error", id: first.id, message: "device failed" });
  assert.equal(f.toasts.at(-1), "device failed");
  f.start(); f.step("next"); f.setMessages([message({ id: "next" })]); f.success(); await tick();
  f.commands[1].run(); assert.equal(f.sent[2].type, "cancel");
  f.start(); f.step("third"); f.setMessages([message({ id: "third" })]); f.success(); await tick();
  assert.equal(f.sent.length, 3);
  f.commands[0].run(); f.success(); await tick(); assert.equal(f.sent.length, 4);
  f.commands[2].run(); assert.equal(f.sent[4].type, "cancel");
  f.setRoute({ type: "home" }); f.commands[2].run(); assert.equal(f.toasts.at(-1), "Open a session to control voice");
  f.callbacks()?.onFailure("worker failed"); assert.equal(f.toasts.at(-1), "worker failed");
  f.cleanup?.(); assert.equal(f.statusRemoved(), true);
});

test("enabling a child or unknown session leaves the enabled root playing", async () => {
  const f = fixture();
  f.commands[0].run();
  f.setMessages([message()]); f.start(); f.step(); f.success(); await tick();
  assert.equal(f.sent.length, 1);
  f.setRoute({ type: "session", sessionID: "other" });
  f.setParent("s"); f.commands[0].run();
  f.setParent(undefined); f.setSessionKnown(false); f.commands[0].run();
  assert.equal(f.sent.length, 1);
  assert.equal(f.toasts.length, 2);
  f.setSessionKnown(true); f.setRoute({ type: "session", sessionID: "s" });
  f.commands[2].run();
  assert.equal(f.sent[1].type, "cancel");
  f.cleanup?.();
});

test("navigation preserves playback until voice is enabled in another root session", async () => {
  const f = fixture();
  f.commands[0].run();
  f.setMessages([message()]); f.start(); f.step(); f.success(); await tick();
  const first = f.sent[0];
  assert.equal(first.type, "speak");
  f.setRoute({ type: "session", sessionID: "other" });
  assert.equal(f.sent.length, 1);
  f.commands[0].run();
  assert.deepEqual(f.sent[1], { type: "cancel", id: first.id });
  f.setRoute({ type: "session", sessionID: "s" });
  f.start(); f.step("later"); f.setMessages([message({ id: "later" })]); f.success(); await tick();
  assert.equal(f.sent.length, 2);
  f.cleanup?.();
});
