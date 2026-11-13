import assert from "node:assert/strict";
import { test } from "node:test";
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
  let commands: readonly Command[] = [];
  let disposed = false;
  let callbacks: Parameters<NonNullable<Parameters<typeof createPlugin>[0]>>[0] | undefined;
  const context = {
    options,
    ui: { router: { current: () => route }, toast: { show: ({ message }: { message: string }) => toasts.push(message) } },
    keymap: { layer: (factory: () => { commands: readonly Command[] }) => { commands = factory().commands; } },
    data: { on: (type: string, handler: (event: never) => void) => { handlers.set(type, handler); return () => handlers.delete(type); },
      session: { message: { sync: () => sync(), list: () => messages } } },
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
    disposed: () => disposed, callbacks: () => callbacks };
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

test("selects only the exact final completed answer and deduplicates success", async () => {
  const f = fixture(); f.setMessages([message(), message({ id: "older", content: [{ type: "text", text: "old" }] })]);
  f.success(); await tick(); assert.equal(f.sent.length, 0);
  f.start(); f.step(); f.success(); f.success(); await tick();
  assert.equal(f.sent.length, 1);
  const request = f.sent[0]; assert.equal(request.type, "speak");
  assert.equal(request.units[0].text, "Visible");
  f.cleanup?.(); assert.equal(f.disposed(), true); assert.equal(f.handlers.size, 0);
});

test("skips missing, failed, interrupted, retry, ambiguous and non-final answers", async () => {
  const f = fixture();
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

test("rechecks route and generation after sync, including later step", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => f.setRoute({ type: "home" }),
    (f: ReturnType<typeof fixture>) => f.start(), (f: ReturnType<typeof fixture>) => f.step("later")]) {
    const f = fixture(); f.setMessages([message()]); let resume!: () => void;
    f.setSync(() => new Promise<void>((resolve) => { resume = resolve; }));
    f.start(); f.step(); f.success(); change(f); resume(); await tick();
    assert.equal(f.sent.length, 0); f.cleanup?.();
  }
  const f = fixture(); f.setRoute({ type: "home" }); f.start(); f.step(); f.success(); await tick();
  assert.equal(f.sent.length, 0); f.cleanup?.();
});

test("commands, configuration and worker notifications", async () => {
  const bad = fixture({ speed: 2 }); assert.deepEqual(bad.toasts, ["Invalid voice plugin configuration"]);
  const f = fixture(); f.setMessages([message()]); f.start(); f.step(); f.success(); await tick();
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
  f.cleanup?.();
});
