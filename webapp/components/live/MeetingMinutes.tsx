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

function formatMinuteTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
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
    <div className="live-minutes" aria-label="회의록">
      <header className="live-minutes-header">
        <span className="live-minutes-ended-dot" aria-hidden="true" />
        <strong>미팅이 종료되었습니다</strong>
        <p>호스트가 라이브를 종료했습니다. 아래에서 회의록을 확인하세요.</p>
      </header>
      {summary
        ? <MeetingSummaryCard summary={summary} createdAt={summaryCreatedAt} />
        : (
          <div className="live-minutes-pending">
            <p>{isLoading ? "회의록을 불러오는 중…" : "AI 요약이 아직 준비되지 않았습니다. 호스트가 생성하면 여기에 표시됩니다."}</p>
            <button type="button" disabled={isLoading} onClick={onRetry}>{isLoading ? "불러오는 중…" : "다시 확인"}</button>
          </div>
        )}
      {turns.length > 0 && (
        <section className="live-minutes-record">
          <h3>전체 발언 기록</h3>
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
