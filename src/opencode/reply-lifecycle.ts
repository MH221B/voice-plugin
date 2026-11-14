import type { Plugin } from "@opencode/plugin/tui";
import type { SessionPlayback } from "../shared/session-playback.js";
import { StreamingParser } from "../shared/streaming-parser.js";

type Context = Plugin.Context;
type Execution = {
  revision: number;
  step?: { id: string; finish: string };
  stream?: Stream;
};
type Stream = {
  token: number;
  message?: string;
  parts: { text: string; ended: boolean }[];
  parser: StreamingParser;
  state: "active" | "failed" | "finalized";
};

export type ReplyLifecycleOptions = {
  streamSpeech: boolean;
  playback: SessionPlayback;
  isRoot(sessionId: string): boolean;
  notify(message: string): void;
};

export class ReplyLifecycle {
  private executions = new Map<string, Execution>();
  private stops: (() => void)[] = [];
  private disposed = false;

  constructor(private data: Context["data"], private options: ReplyLifecycleOptions) {
    const { playback, isRoot, streamSpeech } = options;

    const valid = (id: string, stream: Stream): boolean =>
      stream.state === "active" && isRoot(id) && playback.token(id) === stream.token;

    const fail = (id: string, stream: Stream, message?: string): void => {
      if (stream.state !== "active") return;
      stream.state = "failed";
      if (playback.token(id) === stream.token) playback.stop(id);
      if (message) this.options.notify(message);
    };

    const emit = (id: string, stream: Stream, text: string, final = false): void => {
      try {
        for (const sentence of stream.parser.push(text, final)) {
          if (!valid(id, stream) || !playback.stream(id, stream.token, sentence)) {
            fail(id, stream);
            break;
          }
        }
      } catch (error) {
        fail(id, stream, String(error));
      }
    };

    const invalidate = (id: string): void => {
      this.executions.delete(id);
      if (streamSpeech) playback.stop(id);
    };

    this.stops = [
      data.on("session.execution.started", ({ data: event }) => {
        if (streamSpeech) playback.stop(event.sessionID);
        const token = playback.token(event.sessionID);
        const execution: Execution = { revision: 0 };
        if (streamSpeech && token !== undefined && isRoot(event.sessionID)) {
          execution.stream = {
            token, parts: [], parser: new StreamingParser(), state: "active",
          };
        }
        this.executions.set(event.sessionID, execution);
      }),
      data.on("session.step.started", ({ data: event }) => {
        const execution = this.executions.get(event.sessionID);
        if (!execution) return;
        const stream = execution.stream;
        if (stream && stream.message !== undefined && !execution.step) {
          return fail(event.sessionID, stream);
        }
        execution.step = undefined;
        execution.revision++;
        if (!stream) return;
        if (!valid(event.sessionID, stream)) return fail(event.sessionID, stream);
        if (stream.message !== undefined) {
          playback.stop(event.sessionID);
          stream.token = playback.token(event.sessionID)!;
        }
        stream.message = event.assistantMessageID;
        stream.parts = [];
        stream.parser = new StreamingParser();
      }),
      data.on("session.text.started", ({ data: event }) => {
        const execution = this.executions.get(event.sessionID);
        const stream = execution?.stream;
        if (!stream || stream.state !== "active") return;
        if (execution?.step || !valid(event.sessionID, stream) ||
            stream.message !== event.assistantMessageID ||
            event.ordinal !== stream.parts.length ||
            stream.parts.some((part) => !part.ended)) {
          return fail(event.sessionID, stream);
        }
        stream.parts.push({ text: "", ended: false });
      }),
      data.on("session.text.delta", ({ data: event }) => {
        const stream = this.executions.get(event.sessionID)?.stream;
        if (!stream || stream.state !== "active") return;
        const part = stream.parts[event.ordinal];
        if (!valid(event.sessionID, stream) || stream.message !== event.assistantMessageID ||
            event.ordinal !== stream.parts.length - 1 || !part || part.ended) {
          return fail(event.sessionID, stream);
        }
        part.text += event.delta;
        if (Buffer.byteLength(part.text, "utf8") > 65536) {
          return fail(event.sessionID, stream, "Voice streaming buffer overflow");
        }
        emit(event.sessionID, stream, event.delta);
      }),
      data.on("session.text.ended", ({ data: event }) => {
        const stream = this.executions.get(event.sessionID)?.stream;
        if (!stream || stream.state !== "active") return;
        const part = stream.parts[event.ordinal];
        if (!valid(event.sessionID, stream) || stream.message !== event.assistantMessageID ||
            event.ordinal !== stream.parts.length - 1 || !part || part.ended ||
            part.text !== event.text) {
          return fail(event.sessionID, stream);
        }
        part.ended = true;
        emit(event.sessionID, stream, "\n");
      }),
      data.on("session.step.ended", ({ data: event }) => {
        const execution = this.executions.get(event.sessionID);
        if (!execution) return;
        execution.step = { id: event.assistantMessageID, finish: event.finish };
        execution.revision++;
        const stream = execution.stream;
        if (stream && (!valid(event.sessionID, stream) ||
            stream.message !== event.assistantMessageID ||
            stream.parts.some((part) => !part.ended) ||
            (event.finish !== "stop" && event.finish !== "tool-calls"))) {
          fail(event.sessionID, stream);
        }
        if (stream && event.finish === "tool-calls" && stream.state === "active") {
          playback.stop(event.sessionID);
          stream.token = playback.token(event.sessionID)!;
        }
      }),
      data.on("session.step.failed", ({ data: event }) => invalidate(event.sessionID)),
      data.on("session.retry.scheduled", ({ data: event }) => invalidate(event.sessionID)),
      data.on("session.execution.failed", ({ data: event }) => invalidate(event.sessionID)),
      data.on("session.execution.interrupted", ({ data: event }) => invalidate(event.sessionID)),
      data.on("session.execution.succeeded", ({ data: event }) => {
        const id = event.sessionID;
        const execution = this.executions.get(id);
        const step = execution?.step;
        if (!execution) return;
        if (!step || step.finish !== "stop") {
          if (execution.stream && step?.finish !== "tool-calls") fail(id, execution.stream);
          return;
        }
        const revision = execution.revision;
        void (async () => {
          const reject = (): void => {
            if (this.executions.get(id) === execution && execution.stream) {
              fail(id, execution.stream);
            }
          };
          try {
            if (!this.data.session.get(id)) await this.data.session.sync(id);
            if (!isRoot(id)) return reject();
            await this.data.session.message.sync(id);
          } catch {
            return reject();
          }
          if (this.disposed || this.executions.get(id) !== execution ||
              execution.revision !== revision) return;
          if (!isRoot(id)) return reject();
          const matches = this.data.session.message.list(id)
            .filter((message) => message.id === step.id);
          if (matches.length !== 1) return reject();
          const message = matches[0];
          if (message.type !== "assistant" || message.time.completed === undefined ||
              message.finish !== "stop" || message.error || message.retry) {
            return reject();
          }
          const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
          if (streamSpeech) {
            const stream = execution.stream;
            if (!stream || !valid(id, stream) || stream.message !== message.id) return;
            const parts = message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text);
            if (stream.parts.some((part) => !part.ended) ||
                parts.length !== stream.parts.length ||
                parts.some((part, index) => part !== stream.parts[index].text)) {
              return fail(id, stream);
            }
            emit(id, stream, "", true);
            if (stream.state === "active") stream.state = "finalized";
          } else if (text) {
            playback.answer({ sessionId: id, answerId: message.id, text });
          }
        })();
      }),
    ];
  }

  workerFailed(): void {
    for (const id of this.executions.keys()) this.options.playback.stop(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.stops) stop();
    if (this.options.streamSpeech) {
      for (const id of this.executions.keys()) this.options.playback.stop(id);
    }
    this.executions.clear();
  }
}
