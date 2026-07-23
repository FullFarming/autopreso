"use client";

// Structured meeting recap card (earnings-call style): title, overview,
// chronological chapters, decisions, action items, and per-speaker
// highlights. Shared by the host dashboard and the participant viewer.

import type { MeetingSummary } from "@/lib/live/summary";

export default function MeetingSummaryCard({ summary, createdAt }: {
  summary: MeetingSummary;
  createdAt?: string | null;
}) {
  return (
    <section className="live-summary-card" aria-label="미팅 요약">
      <header>
        <span className="live-eyebrow">AI 미팅 요약</span>
        <h2>{summary.title}</h2>
        {createdAt ? <time dateTime={createdAt}>{new Date(createdAt).toLocaleString("ko-KR")}</time> : null}
      </header>
      <p className="live-summary-overview">{summary.overview}</p>
      {summary.chapters.length > 0 && (
        <div className="live-summary-section">
          <h3>진행 순서</h3>
          <ol>
            {summary.chapters.map((chapter, index) => (
              <li key={`chapter-${index}`}>
                <strong>{chapter.title}</strong>
                <p>{chapter.summary}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
      {summary.decisions.length > 0 && (
        <div className="live-summary-section">
          <h3>결정 사항</h3>
          <ul>{summary.decisions.map((decision, index) => <li key={`decision-${index}`}>{decision}</li>)}</ul>
        </div>
      )}
      {summary.actionItems.length > 0 && (
        <div className="live-summary-section">
          <h3>후속 작업</h3>
          <ul>{summary.actionItems.map((item, index) => <li key={`action-${index}`}>{item}</li>)}</ul>
        </div>
      )}
      {summary.speakerHighlights.length > 0 && (
        <div className="live-summary-section">
          <h3>참가자별 핵심 발언</h3>
          <ul className="live-summary-speakers">
            {summary.speakerHighlights.map((entry, index) => (
              <li key={`speaker-${index}`}><strong>{entry.speaker}</strong><span>{entry.highlight}</span></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
