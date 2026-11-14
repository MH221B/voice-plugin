import { randomUUID } from "node:crypto";
import { parseReply } from "./parse-reply.js";
import type { CompletedAnswer, VoiceConfig, WorkerRequest, WorkerResponse } from "./types.js";

type Session = { enabled: boolean; answers: Set<string>; active: Set<string>; generation: number };

export class SessionPlayback {
  private sessions = new Map<string, Session>();
  private owner?: string;

  constructor(
    private client: { send(request: WorkerRequest): boolean },
    private config: VoiceConfig,
    private onError: (sessionId: string, message: string) => void,
    private onChange: () => void = () => {},
  ) {}

  status(sessionId: string): "ON" | "OFF" | "WORKING" {
    const session = this.sessions.get(sessionId);
    return !session?.enabled ? "OFF" : session.active.size ? "WORKING" : "ON";
  }

  private session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = { enabled: false, answers: new Set(), active: new Set(), generation: 0 };
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
      session.active.add(id);
      this.onChange();
    } else {
      session.answers.delete(answer.answerId);
    }
  }

  stop(sessionId: string): void {
    const session = this.session(sessionId);
    session.generation++;
    const ids = [...session.active];
    session.active.clear();
    if (ids.length) {
      this.onChange();
      for (const id of ids) this.client.send({ type: "cancel", id });
    }
  }

  token(sessionId: string): number | undefined {
    const session = this.session(sessionId);
    return session.enabled ? session.generation : undefined;
  }

  // `text` is markup-safe output from StreamingParser. parseReply stays the only
  // authority for sentence splitting, voice tags, and emotions.
  stream(sessionId: string, token: number, text: string): boolean {
    const session = this.session(sessionId);
    if (!session.enabled || session.generation !== token) return false;
    const units = parseReply(text);
    if (!units.length) return true;
    if (session.active.size >= 32) {
      this.stop(sessionId);
      this.onError(sessionId, "Voice streaming queue overflow");
      return false;
    }
    const id = randomUUID();
    session.active.add(id);
    let accepted = false;
    try { accepted = this.client.send({ type: "speak", id, sessionId, units, config: this.config }); } catch { /* fail below */ }
    if (!accepted) {
      session.active.delete(id);
      if (session.generation === token) {
        this.stop(sessionId);
        this.onError(sessionId, "Voice worker failed to accept speech");
      }
      return false;
    }
    this.onChange();
    return true;
  }

  setEnabled(sessionId: string, enabled: boolean): void {
    if (enabled && this.owner !== undefined && this.owner !== sessionId) {
      this.setEnabled(this.owner, false);
    }
    const session = this.session(sessionId);
    if (session.enabled !== enabled) {
      session.enabled = enabled;
      this.onChange();
    }
    if (enabled) this.owner = sessionId;
    else if (this.owner === sessionId) this.owner = undefined;
    if (!enabled) this.stop(sessionId);
  }

  finished(sessionId: string, id: string, response: WorkerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active.delete(id)) return;
    this.onChange();
    if (response.type === "error") {
      this.stop(sessionId);
      this.onError(sessionId, response.message);
    }
  }
}
