import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

const LIMIT = 1024 * 1024;
const QUEUE_LIMIT = 64 * 1024;

export class WorkerLog {
  private path: string;
  private queue: Buffer[] = [];
  private queued = 0;
  private running = false;
  private failed = false;
  private size = 0;

  constructor(root: string) {
    this.path = join(root, ".voice-cache", `worker-${randomUUID()}.log`);
  }

  write(data: string | Buffer): void {
    if (this.failed) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const available = QUEUE_LIMIT - this.queued;
    if (available <= 0) return;
    const chunk = Buffer.from(bytes.subarray(0, available));
    this.queue.push(chunk);
    this.queued += chunk.length;
    if (!this.running) void this.flush();
  }

  private async flush(): Promise<void> {
    this.running = true;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      while (this.queue.length) {
        const chunk = this.queue.shift()!;
        this.queued -= chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
          if (this.size === LIMIT) {
            await rename(this.path, `${this.path}.1`);
            this.size = 0;
          }
          const part = chunk.subarray(offset, offset + LIMIT - this.size);
          const file = await open(this.path, "a", 0o600);
          try { await file.writeFile(part); } finally { await file.close(); }
          this.size += part.length;
          offset += part.length;
        }
      }
    } catch {
      this.failed = true;
      this.queue = [];
      this.queued = 0;
    } finally {
      this.running = false;
    }
  }
}
