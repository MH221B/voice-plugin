import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WorkerRequest, WorkerResponse } from "./types.js";
import { WorkerLog } from "./worker-log.js";

type Terminal = Exclude<WorkerResponse, { type: "ready" | "diagnostic" }>;
type Options = {
  python: string;
  projectRoot: string;
  backend?: NonNullable<import("./types.js").VoiceConfig["backend"]>;
  log?: boolean;
  onTerminal: (sessionId: string, id: string, response: Terminal) => void;
  onFailure: (message: string) => void;
  onDiagnostic?: (message: string) => void;
  spawn?: typeof spawn;
};

export class WorkerClient {
  private child: ChildProcessWithoutNullStreams;
  private ready = false;
  private dead = false;
  private buffer = "";
  private queue: WorkerRequest[] = [];
  private pending = new Map<string, string>();
  private log?: WorkerLog;

  constructor(private options: Options) {
    if (options.log) this.log = new WorkerLog(options.projectRoot);
    const token = process.env.HF_TOKEN?.trim();
    this.child = (options.spawn ?? spawn)(options.python, ["-m", "worker.main", options.backend ?? "kokoro"], {
      cwd: options.projectRoot,
      stdio: "pipe",
      env: { ...process.env, VOICE_WORKER_LOG: options.log ? "1" : undefined, HF_TOKEN: token || undefined, HF_OIDC_RESOURCE: undefined,
        HF_HUB_DISABLE_IMPLICIT_TOKEN: token ? "0" : "1" },
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", this.onData);
    this.child.stdout.on("error", this.onError);
    this.child.stdin.on("error", this.onError);
    this.child.on("error", this.onError);
    this.child.on("exit", this.onExit);
    // Drain diagnostics without mixing them into protocol output.
    this.child.stderr.on("data", (chunk: Buffer) => this.log?.write(chunk));
    this.child.stderr.on("error", () => {});
  }

  send(request: WorkerRequest): boolean {
    if (this.dead) return false;
    if (request.type === "cancel") this.pending.delete(request.id);
    if (request.type === "speak") {
      if (this.pending.has(request.id)) return false;
      this.pending.set(request.id, request.sessionId);
    }
    if (!this.ready) {
      if (request.type === "cancel") {
        const index = this.queue.findIndex((queued) => queued.type === "speak" && queued.id === request.id);
        if (index !== -1) {
          this.queue.splice(index, 1);
          this.pending.delete(request.id);
          return true;
        }
      }
      this.queue.push(request);
      return true;
    }
    return this.write(request);
  }

  private write(request: WorkerRequest): boolean {
    try {
      this.child.stdin.write(JSON.stringify(request) + "\n", (error) => {
        if (error) this.fail(`Worker input failed: ${error.message}`);
      });
      return !this.dead;
    } catch (error) {
      this.fail(`Worker input failed: ${String(error)}`);
      return false;
    }
  }

  private onData = (chunk: string): void => {
    this.buffer += chunk;
    let end: number;
    while (!this.dead && (end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let response: unknown;
      try { response = JSON.parse(line); } catch { this.fail("Invalid worker output"); return; }
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        this.fail("Invalid worker output"); return;
      }
      const value = response as Record<string, unknown>;
      if (value.type === "ready" && !this.ready) {
        this.ready = true;
        const queue = this.queue;
        this.queue = [];
        for (const request of queue) if (!this.write(request)) break;
      } else if (value.type === "diagnostic" && typeof value.id === "string" && typeof value.message === "string") {
        this.log?.write(`Diagnostic ${value.id}: ${value.message}\n`);
        if (this.pending.has(value.id)) this.options.onDiagnostic?.(value.message);
      } else if ((value.type === "done" || value.type === "cancelled") && typeof value.id === "string") {
        this.terminal(value.id, value as Terminal);
      } else if (value.type === "error" && typeof value.message === "string" && (value.id === undefined || typeof value.id === "string")) {
        this.log?.write(`Request error ${value.id ?? ""}: ${value.message}\n`);
        if (typeof value.id === "string") this.terminal(value.id, value as Terminal);
        else this.fail(`Worker error: ${value.message}`);
      } else {
        this.fail("Invalid worker output");
      }
    }
  };

  private terminal(id: string, response: Terminal): void {
    const session = this.pending.get(id);
    if (session === undefined) return;
    this.pending.delete(id);
    this.options.onTerminal(session, id, response);
  }

  private onError = (error: Error): void => this.fail(`Worker failed: ${error.message}`);
  private onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
    this.fail(`Worker exited (${signal ?? code ?? "unknown"})`);

  private fail(message: string): void {
    this.log?.write(`${message}\n`);
    if (this.dead) return;
    this.dead = true;
    this.queue = [];
    const pending = [...this.pending];
    this.pending.clear();
    for (const [id, session] of pending) this.options.onTerminal(session, id, { type: "cancelled", id });
    this.options.onFailure(message);
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  dispose(): void {
    this.dead = true;
    this.pending.clear();
    this.queue = [];
    this.child.stdout.off("data", this.onData);
    this.child.stdout.off("error", this.onError);
    this.child.stdin.off("error", this.onError);
    this.child.off("error", this.onError);
    this.child.off("exit", this.onExit);
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}
