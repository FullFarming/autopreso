"use client";

// Post-meeting minutes (회의록): AI summary on top, then the full
// speaker-attributed utterance record grouped into turns, in the viewer's
// chosen language. Shown when the host ends the session.

import { useMemo } from "react";

import type { MeetingSummary } from "@/lib/live/summary";
import MeetingSummaryCard from "./MeetingSummaryCard";

export interface TranscriptEntry {
  seq: number;
  speaker: string;
  text: string;
  emittedAt: string;
}

interface TranscriptTurn {
  key: string;
  speaker: string;
  startedAt: string;
  texts: string[];
}

function groupTranscript(entries: TranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const entry of entries) {
    const previous = turns.at(-1);
    if (previous && previous.speaker === entry.speaker) {
      previous.texts.push(entry.text);
      continue;
    }
    turns.push({ key: `minute-${entry.seq}`, speaker: entry.speaker, startedAt: entry.emittedAt, texts: [entry.text] });
  }
  return turns;
}

export function formatMinuteTime(iso: string): string {
  // 2026-07-24 fix: Use the fixed KST session clock. Locale output and host
  // time zones previously produced different SSR/client text and hydration #418.
  const normalizedIso = /(?:Z|[+-]\d{2}:\d{2})$/u.test(iso) ? iso : `${iso}Z`;
  const timestamp = Date.parse(normalizedIso);
  if (!Number.isFinite(timestamp)) return "";
  const kstTime = new Date(timestamp + (9 * 60 * 60 * 1_000));
  const hours = String(kstTime.getUTCHours()).padStart(2, "0");
  const minutes = String(kstTime.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export default function MeetingMinutes({ summary, summaryCreatedAt, transcript, isLoading, onRetry }: {
  summary: MeetingSummary | null;
  summaryCreatedAt: string | null;
  transcript: TranscriptEntry[];
  isLoading: boolean;
  onRetry: () => void;
}) {
  const turns = useMemo(() => groupTranscript(transcript), [transcript]);
  return (
    <div className="live-minutes" aria-label="Meeting notes">
      <header className="live-minutes-header">
        <span className="live-minutes-ended-dot" aria-hidden="true" />
        <strong>The meeting has ended</strong>
        <p>The host ended the live session. Your meeting notes are available below.</p>
      </header>
      {summary
        ? <MeetingSummaryCard summary={summary} createdAt={summaryCreatedAt} />
        : (
          <div className="live-minutes-pending">
            <p>{isLoading ? "Loading meeting notes…" : "The AI summary is not ready yet. It will appear after the host creates it."}</p>
            <button type="button" disabled={isLoading} onClick={onRetry}>{isLoading ? "Loading…" : "Check again"}</button>
          </div>
        )}
      {turns.length > 0 && (
        <section className="live-minutes-record">
          <h3>Full transcript</h3>
          {turns.map((turn) => (
            <article key={turn.key}>
              <header>
                <strong>{turn.speaker}</strong>
                <time dateTime={turn.startedAt}>{formatMinuteTime(turn.startedAt)}</time>
              </header>
              <p>{turn.texts.join(" ")}</p>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
