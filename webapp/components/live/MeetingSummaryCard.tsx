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
    <section className="live-summary-card" aria-label="Meeting summary">
      <header>
        <span className="live-eyebrow">AI meeting summary</span>
        <h2>{summary.title}</h2>
        {createdAt ? <time dateTime={createdAt}>{new Date(createdAt).toLocaleString("en")}</time> : null}
      </header>
      <p className="live-summary-overview">{summary.overview}</p>
      {summary.chapters.length > 0 && (
        <div className="live-summary-section">
          <h3>Chapters</h3>
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
          <h3>Decisions</h3>
          <ul>{summary.decisions.map((decision, index) => <li key={`decision-${index}`}>{decision}</li>)}</ul>
        </div>
      )}
      {summary.actionItems.length > 0 && (
        <div className="live-summary-section">
          <h3>Action items</h3>
          <ul className="live-summary-actions-list">
            {summary.actionItems.map((item, index) => (
              <li key={`action-${index}`}>
                <span>{item.description}</span>
                <small>담당 {item.owner ? item.owner : <>미정</>} · 기한 {item.due ? item.due : <>미정</>}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.speakerHighlights.length > 0 && (
        <div className="live-summary-section">
          <h3>Speaker highlights</h3>
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
