import { randomUUID } from "node:crypto";
import { parseReply } from "./parse-reply.js";
import type { CompletedAnswer, VoiceConfig, WorkerRequest, WorkerResponse } from "./types.js";

type Session = { enabled: boolean; answers: Set<string>; active?: string };

export class SessionPlayback {
  private sessions = new Map<string, Session>();

  constructor(
    private client: { send(request: WorkerRequest): boolean },
    private config: VoiceConfig,
    private onError: (sessionId: string, message: string) => void,
    private onChange: () => void = () => {},
  ) {}

  status(sessionId: string): "ON" | "OFF" | "WORKING" {
    const session = this.sessions.get(sessionId);
    return !session?.enabled ? "OFF" : session.active ? "WORKING" : "ON";
  }

  private session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = { enabled: false, answers: new Set() };
      this.sessions.set(id, session);
    }
    return session;
  }

  answer(answer: CompletedAnswer): void {
    const session = this.session(answer.sessionId);
    if (!session.enabled || session.answers.has(answer.answerId)) return;
    this.stop(answer.sessionId);
    const units = parseReply(answer.text);
    session.answers.add(answer.answerId);
    if (!units.length) return;
    const id = randomUUID();
    if (this.client.send({ type: "speak", id, sessionId: answer.sessionId, units, config: this.config })) {
      session.active = id;
      this.onChange();
    } else {
      session.answers.delete(answer.answerId);
    }
  }

  stop(sessionId: string): void {
    const session = this.session(sessionId);
    const id = session.active;
    if (id !== undefined) {
      session.active = undefined;
      this.onChange();
      this.client.send({ type: "cancel", id });
    }
  }

  setEnabled(sessionId: string, enabled: boolean): void {
    if (enabled) {
      for (const [id, other] of this.sessions) {
        if (id !== sessionId && other.enabled) this.setEnabled(id, false);
      }
    }
    const session = this.session(sessionId);
    if (session.enabled !== enabled) {
      session.enabled = enabled;
      this.onChange();
    }
    if (!enabled) this.stop(sessionId);
  }

  finished(sessionId: string, id: string, response: WorkerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.active !== id) return;
    session.active = undefined;
    this.onChange();
    if (response.type === "error") this.onError(sessionId, response.message);
  }
}
