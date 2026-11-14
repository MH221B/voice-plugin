import * as Plugin from "@opencode/plugin/tui/plugin";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerClient } from "../shared/worker-client.js";
import { SessionPlayback } from "../shared/session-playback.js";

type Context = Plugin.Context;
type Execution = { step?: { id: string; finish: string }; revision: number };
type ClientOptions = ConstructorParameters<typeof WorkerClient>[0];
type Client = Pick<WorkerClient, "send" | "dispose">;

export function createPlugin(makeClient: (options: ClientOptions) => Client = (options) => new WorkerClient(options)) {
return Plugin.define({
  id: "voice-plugin",
  setup(context) {
    const toast = (message: string) => context.ui.toast.show({ message, variant: "error" });
    const options = context.options;
    if (options.log !== undefined && typeof options.log !== "boolean") {
      toast("Invalid voice plugin configuration");
      return;
    }
    const root = options.projectRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const python = options.python ?? (typeof root === "string" ? join(root, ".venv", "Scripts", "python.exe") : "");
    const voice = options.voice ?? "af_heart";
    const speed = options.speed ?? 1;
    const backend = options.backend ?? "kokoro";
    const referenceAudio = options.referenceAudio;
    const chatterboxPython = options.chatterboxPython;
    const cosyvoicePython = options.cosyvoicePython;
    const cosyvoiceSource = options.cosyvoiceSource;
    const cosyvoiceModel = options.cosyvoiceModel;
    if (backend !== "kokoro" && backend !== "chatterbox-nano" && backend !== "chatterbox-turbo" && backend !== "cosyvoice3") {
      toast("Invalid backend: choose kokoro, chatterbox-nano, chatterbox-turbo, or cosyvoice3");
      return;
    }
    if (backend === "cosyvoice3") {
      for (const [name, value] of Object.entries({ referenceAudio, cosyvoicePython, cosyvoiceSource, cosyvoiceModel })) {
        if (typeof value !== "string" || !isAbsolute(value)) {
          toast(`${name} must be an absolute path for CosyVoice 3`);
          return;
        }
      }
    }
    if (referenceAudio !== undefined && (typeof referenceAudio !== "string" || !isAbsolute(referenceAudio))) {
      toast("referenceAudio must be an absolute path");
      return;
    }
    if (chatterboxPython !== undefined && (typeof chatterboxPython !== "string" || !isAbsolute(chatterboxPython))) {
      toast("chatterboxPython must be an absolute path");
      return;
    }
    if (typeof root !== "string" || !isAbsolute(root) || typeof python !== "string" || !isAbsolute(python) ||
        typeof voice !== "string" || !/^(af_|am_|bf_|bm_)\S+$/.test(voice) ||
        typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.7 || speed > 1.3) {
      toast("Invalid voice plugin configuration");
      return;
    }
    const [revision, setRevision] = createSignal(0);
    let playback: SessionPlayback;
    let client: Client;
    try {
      client = makeClient({ python: backend === "kokoro" ? python : backend === "cosyvoice3" ? cosyvoicePython as string : (chatterboxPython ?? python), projectRoot: root,
        log: options.log === true,
        onTerminal: (session, id, response) => playback.finished(session, id, response),
        onFailure: (message) => toast(message),
        onDiagnostic: (message) => toast(message),
      });
      playback = new SessionPlayback(client, { voice, speed, backend, ...(referenceAudio === undefined ? {} : { referenceAudio }),
        ...(backend === "cosyvoice3" ? { cosyvoiceSource: cosyvoiceSource as string, cosyvoiceModel: cosyvoiceModel as string } : {}) }, (_session, message) => toast(message), () => setRevision((value) => value + 1));
    } catch (error) {
      toast(`Voice worker failed: ${String(error)}`);
      return;
    }

    const current = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const isRoot = (id: string) => {
      const session = context.data.session.get(id);
      return session !== undefined && !session.parentID;
    };
    const removeStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => jsx("text", { get children() {
        revision();
        return input.sessionID && isRoot(input.sessionID) ? `Voice: ${playback.status(input.sessionID)}` : "";
      } }),
    });
    const command = (action: (session: string) => void) => () => {
      const session = current();
      if (!session) return toast("Open a session to control voice");
      action(session);
    };
    context.keymap.layer(() => ({ mode: "global", commands: [
      { id: "voice.on", title: "Enable voice", palette: true, slash: { name: "voice-on" }, run: command((id) => playback.setEnabled(id, true)) },
      { id: "voice.off", title: "Disable voice", palette: true, slash: { name: "voice-off" }, run: command((id) => playback.setEnabled(id, false)) },
      { id: "voice.stop", title: "Stop voice", palette: true, slash: { name: "voice-stop" }, run: command((id) => playback.stop(id)) },
    ] }));

    const executions = new Map<string, Execution>();
    let disposed = false;
    const invalidate = (id: string) => { executions.delete(id); };
    const stops = [
      context.data.on("session.execution.started", ({ data }) => executions.set(data.sessionID, { revision: 0 })),
      context.data.on("session.step.started", ({ data }) => {
        const execution = executions.get(data.sessionID);
        if (execution) { execution.step = undefined; execution.revision++; }
      }),
      context.data.on("session.step.ended", ({ data }) => {
        const execution = executions.get(data.sessionID);
        if (execution) { execution.step = { id: data.assistantMessageID, finish: data.finish }; execution.revision++; }
      }),
      context.data.on("session.step.failed", ({ data }) => invalidate(data.sessionID)),
      context.data.on("session.retry.scheduled", ({ data }) => invalidate(data.sessionID)),
      context.data.on("session.execution.failed", ({ data }) => invalidate(data.sessionID)),
      context.data.on("session.execution.interrupted", ({ data }) => invalidate(data.sessionID)),
      context.data.on("session.execution.succeeded", ({ data }) => {
        const id = data.sessionID;
        const execution = executions.get(id);
        const step = execution?.step;
        if (!execution || !step || step.finish !== "stop" || current() !== id) return;
        const revision = execution.revision;
        void (async () => {
          try {
            if (!context.data.session.get(id)) await context.data.session.sync(id);
            if (!isRoot(id)) return;
            await context.data.session.message.sync(id);
          } catch { return; }
          if (disposed || current() !== id || !isRoot(id) || executions.get(id) !== execution || execution.revision !== revision) return;
          const matches = context.data.session.message.list(id).filter((message) => message.id === step.id);
          if (matches.length !== 1) return;
          const message = matches[0];
          if (message.type !== "assistant" || message.time.completed === undefined || message.finish !== "stop" || message.error || message.retry) return;
          const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
          if (text) playback.answer({ sessionId: id, answerId: message.id, text });
        })();
      }),
    ];
    return () => {
      disposed = true;
      for (const stop of stops) stop();
      removeStatus();
      client.dispose();
    };
  },
});
}

export default createPlugin();
