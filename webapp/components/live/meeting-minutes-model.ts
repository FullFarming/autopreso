import type { CaptionTranslationStatus } from "@/lib/live-contract";

export interface TranscriptEntry {
  seq: number;
  participantId?: string | null;
  speaker: string;
  text: string;
  emittedAt: string;
  sourceText?: string;
  sourceLanguage?: string;
  origin?: "source";
  utteranceKey?: string;
  translationStatus?: CaptionTranslationStatus;
  topicId?: string;
  topicPosition?: number;
}

export interface TranscriptTurn {
  key: string;
  speakerIdentity: string;
  speaker: string;
  startedAt: string;
  texts: string[];
}

export function groupTranscript(entries: TranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const entry of entries) {
    const speakerIdentity = entry.participantId ?? entry.speaker;
    const previous = turns.at(-1);
    if (previous && previous.speakerIdentity === speakerIdentity) {
      previous.texts.push(entry.text);
      continue;
    }
    turns.push({ key: `minute-${entry.seq}`, speakerIdentity, speaker: entry.speaker, startedAt: entry.emittedAt, texts: [entry.text] });
  }
  return turns;
}

export function formatMinuteTime(iso: string): string {
  const normalizedIso = /(?:Z|[+-]\d{2}:\d{2})$/u.test(iso) ? iso : `${iso}Z`;
  const timestamp = Date.parse(normalizedIso);
  if (!Number.isFinite(timestamp)) return "";
  const kstTime = new Date(timestamp + (9 * 60 * 60 * 1_000));
  return `${String(kstTime.getUTCHours()).padStart(2, "0")}:${String(kstTime.getUTCMinutes()).padStart(2, "0")}`;
}

export function formatElapsedTime(elapsedMilliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMilliseconds / 1_000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
