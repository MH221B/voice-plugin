export type Emotion = "calm" | "excited" | "sad" | "reassuring" | "serious";
export type Emotions = Partial<Record<Emotion, number>>;
export type SpeechUnit = {
  text: string;
  emotions: Emotions;
  boundary: "sentence" | "span";
};
export type VoiceConfig = { voice: string; speed: number; backend?: "kokoro" | "chatterbox-nano" | "chatterbox-turbo"; referenceAudio?: string };
export type CompletedAnswer = { sessionId: string; answerId: string; text: string };

export type WorkerRequest =
  | { type: "speak"; id: string; sessionId: string; units: SpeechUnit[]; config: VoiceConfig }
  | { type: "cancel"; id: string };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "done"; id: string }
  | { type: "cancelled"; id: string }
  | { type: "diagnostic"; id: string; message: string }
  | { type: "error"; id?: string; message: string };
