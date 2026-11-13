import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WorkerRequest, WorkerResponse } from "./types.js";

type Terminal = Exclude<WorkerResponse, { type: "ready" }>;
type Options = {
  python: string;
  projectRoot: string;
  onTerminal: (sessionId: string, id: string, response: Terminal) => void;
  onFailure: (message: string) => void;
  spawn?: typeof spawn;
};

export class WorkerClient {
  private child: ChildProcessWithoutNullStreams;
  private ready = false;
  private dead = false;
  private buffer = "";
  private queue: WorkerRequest[] = [];
  private pending = new Map<string, string>();

  constructor(private options: Options) {
    this.child = (options.spawn ?? spawn)(options.python, ["-m", "worker.main"], {
      cwd: options.projectRoot,
      stdio: "pipe",
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", this.onData);
    this.child.stdout.on("error", this.onError);
    this.child.stdin.on("error", this.onError);
    this.child.on("error", this.onError);
    this.child.on("exit", this.onExit);
    // Drain diagnostics without mixing them into protocol output.
    this.child.stderr.resume();
  }

  send(request: WorkerRequest): boolean {
    if (this.dead) return false;
    if (request.type === "speak") {
      if (this.pending.has(request.id)) return false;
      this.pending.set(request.id, request.sessionId);
    }
    if (!this.ready) {
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
      } else if ((value.type === "done" || value.type === "cancelled") && typeof value.id === "string") {
        this.terminal(value.id, value as Terminal);
      } else if (value.type === "error" && typeof value.message === "string" && (value.id === undefined || typeof value.id === "string")) {
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
