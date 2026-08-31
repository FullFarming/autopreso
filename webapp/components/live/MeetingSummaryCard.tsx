"use client";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages, formatSystemRecordDate } from "@/lib/system-language/records-messages";

// Structured meeting recap card (earnings-call style): title, overview,
// chronological chapters, decisions, action items, and per-speaker
// highlights. Shared by the host dashboard and the participant viewer.

import type { MeetingSummary } from "@/lib/live/summary";

export default function MeetingSummaryCard({ summary, createdAt }: {
  summary: MeetingSummary;
  createdAt?: string | null;
}) {
  const t = useSystemText(recordsMessages);
  const { language } = useSystemLanguage();
  return (
    <section className="live-summary-card" aria-label={t("회의 요약")}>
      <header>
        <span className="live-eyebrow">{t("AI 회의 요약")}</span>
        <h2>{summary.title}</h2>
        {createdAt ? <time dateTime={createdAt}>{formatSystemRecordDate(createdAt, language)}</time> : null}
      </header>
      <p className="live-summary-overview">{summary.overview}</p>
      {summary.chapters.length > 0 && (
        <div className="live-summary-section">
          <h3>{t("주제")}</h3>
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
          <h3>{t("주요 결정")}</h3>
          <ul>{summary.decisions.map((decision, index) => <li key={`decision-${index}`}>{decision}</li>)}</ul>
        </div>
      )}
      {summary.actionItems.length > 0 && (
        <div className="live-summary-section">
          <h3>{t("다음 할 일")}</h3>
          <ul className="live-summary-actions-list">
            {summary.actionItems.map((item, index) => (
              <li key={`action-${index}`}>
                <span>{item.description}</span>
                <small>{t("담당 {owner} · 기한 {due}", { owner: item.owner || t("미정"), due: item.due || t("미정") })}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.speakerHighlights.length > 0 && (
        <div className="live-summary-section">
          <h3>{t("발언자별 핵심")}</h3>
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
