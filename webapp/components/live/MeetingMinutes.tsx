"use client";

// Post-meeting minutes (회의록): AI summary on top, then the full
// speaker-attributed utterance record grouped into turns, in the viewer's
// chosen language. Shown when the host ends the session.

import { useMemo, useState, type KeyboardEvent } from "react";

import type { MeetingSummary } from "@/lib/live/summary";
import MeetingSummaryCard from "./MeetingSummaryCard";

export interface TranscriptEntry {
  seq: number;
  participantId?: string | null;
  speaker: string;
  text: string;
  emittedAt: string;
}

interface TranscriptTurn {
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
  const [activeTab, setActiveTab] = useState<"summary" | "transcript">("summary");
  const selectAdjacentTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab = event.key === "ArrowRight" || event.key === "End" ? "transcript" : "summary";
    setActiveTab(nextTab);
    document.getElementById(`live-minutes-tab-${nextTab}`)?.focus();
  };
  return (
    <div className="live-minutes" aria-label="Meeting notes">
      <div className="live-minutes-tabs" role="tablist" aria-label="Meeting record">
        <button id="live-minutes-tab-summary" type="button" role="tab" aria-selected={activeTab === "summary"}
          aria-controls="live-minutes-panel-summary" tabIndex={activeTab === "summary" ? 0 : -1}
          className={activeTab === "summary" ? "is-selected" : ""}
          onClick={() => setActiveTab("summary")} onKeyDown={selectAdjacentTab}>Summary</button>
        <button id="live-minutes-tab-transcript" type="button" role="tab" aria-selected={activeTab === "transcript"}
          aria-controls="live-minutes-panel-transcript" tabIndex={activeTab === "transcript" ? 0 : -1}
          className={activeTab === "transcript" ? "is-selected" : ""}
          onClick={() => setActiveTab("transcript")} onKeyDown={selectAdjacentTab}>Transcript</button>
      </div>
      <section id="live-minutes-panel-summary" className="live-minutes-panel" role="tabpanel"
        aria-labelledby="live-minutes-tab-summary" hidden={activeTab !== "summary"}>
        {summary
          ? <MeetingSummaryCard summary={summary} createdAt={summaryCreatedAt} />
          : (
            <div className="live-minutes-pending">
              <p>{isLoading ? "Loading meeting notes…" : "The AI summary is not ready yet. It will appear after the host creates it."}</p>
              <button type="button" disabled={isLoading} onClick={onRetry}>{isLoading ? "Loading…" : "Check again"}</button>
            </div>
          )}
      </section>
      <section id="live-minutes-panel-transcript" className="live-minutes-panel" role="tabpanel"
        aria-labelledby="live-minutes-tab-transcript" hidden={activeTab !== "transcript"}>
        {turns.length > 0 ? (
          <div className="live-minutes-record">
            {turns.map((turn) => (
              <article key={turn.key}>
                <header>
                  <strong>{turn.speaker}</strong>
                  <time dateTime={turn.startedAt}>{formatMinuteTime(turn.startedAt)}</time>
                </header>
                <p>{turn.texts.join(" ")}</p>
              </article>
            ))}
          </div>
        ) : <p className="live-minutes-empty">No transcript is available.</p>}
      </section>
    </div>
  );
}
