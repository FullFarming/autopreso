"use client";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages, formatSystemRecordDate, formatSystemRecordTime } from "@/lib/system-language/records-messages";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthoritativeTranscriptItem, LiveRecordSelectedSummary, SafeSummaryStatus } from "@/lib/live-records/service";
import type { RecordingGap } from "@/lib/live-recap/contract";
import { groupTranscriptReading } from "../transcript-reading-model";
import { fetchLiveRecordOriginals } from "./records-client";
import styles from "./live-records.module.css";
import SummarySkeleton from "../SummarySkeleton";
import { getRecordSpeakerPresentation } from "./record-speaker-presentation";
import { RecordSpeakerIdentity } from "./RecordSpeakerIdentity";

export function RecordOriginalPanel({ sessionId, loadOriginals = fetchLiveRecordOriginals }: {
  sessionId: string;
  loadOriginals?: typeof fetchLiveRecordOriginals;
}) {
  const t = useSystemText(recordsMessages);
  const { language } = useSystemLanguage();
  const [items, setItems] = useState<AuthoritativeTranscriptItem[]>([]);
  const [recordingGaps, setRecordingGaps] = useState<RecordingGap[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const readingTurns = useMemo(() => groupTranscriptReading(items.map((item) => ({
    id: item.sourceUtteranceId, seq: item.sourceSeq,
    speakerKey: getRecordSpeakerPresentation(sessionId, item).key,
    speaker: getRecordSpeakerPresentation(sessionId, item).displayName,
    startedAt: item.sourceStartedAt || item.sourceEndedAt, endedAt: item.sourceEndedAt,
    text: item.effectiveText, language: item.sourceLanguage, rawText: item.rawText, isCorrected: item.correctionRevision > 0,
  })), recordingGaps), [items, recordingGaps, sessionId]);
  const recordedSpeakers = useMemo(() => new Map(items.map((item) => [item.sourceUtteranceId, {
    ...getRecordSpeakerPresentation(sessionId, item), role: item.speakerRole,
  }])), [items, sessionId]);
  const inFlightRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(async (cursor: number) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    setError("");
    try {
      const page = await loadOriginals(sessionId, cursor, controller.signal);
      if (controller.signal.aborted) return;
      if (page.hasNextPage && (page.nextAfterSourceSeq === null || page.nextAfterSourceSeq <= cursor)) {
        throw new Error("다음 원문을 확인할 수 없습니다. 다시 시도해 주세요.");
      }
      setItems((previous) => cursor === 0 ? page.items : [...previous,
        ...page.items.filter((item) => !previous.some((entry) => entry.sourceUtteranceId === item.sourceUtteranceId))]);
      if (cursor === 0) setRecordingGaps(page.recordingGaps);
      setNextCursor(page.hasNextPage ? page.nextAfterSourceSeq : null);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "원문을 불러오지 못했습니다.");
    } finally {
      if (controllerRef.current === controller) {
        inFlightRef.current = false;
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
  }, [loadOriginals, sessionId]);

  useEffect(() => {
    void loadPage(0);
    return () => {
      controllerRef.current?.abort();
      inFlightRef.current = false;
    };
  }, [loadPage]);

  return <section className={styles.originalPanel} aria-label={t("저장된 원문")}>
    <header className={styles.panelHeading}><h2>{t("원문")}</h2><span>{t("저장된 발언 {count}개", { count: items.length })}</span></header>
    {recordingGaps.length > 0 && <section className={styles.recordingGaps} aria-label={t("기록되지 않은 구간")}>
      <h3>{t("기록되지 않은 구간이 있어요")}</h3><p>{t("이 구간의 발언은 원문과 요약에 포함되지 않아요.")}</p>
      <ul>{recordingGaps.map((gap) => <li key={gap.id}>
        <span>{t(gap.reason === "no_viewers" ? "참여자 없음" : gap.reason === "host_unavailable" ? "진행자 연결 없음" : gap.reason === "source_recording_failed" ? "원문 기록 중단" : "오디오 처리 중단")}</span>
        <span><time dateTime={gap.startedAt}>{formatSystemRecordDate(gap.startedAt, language)}</time> – {gap.endedAt
          ? <time dateTime={gap.endedAt}>{formatSystemRecordDate(gap.endedAt, language)}</time> : t("종료 시각 확인 중")}</span>
      </li>)}</ul>
    </section>}
    {items.length === 0 && !isLoading && !error && <p className={styles.empty}>{t("저장된 원문이 없습니다.")}</p>}
    <ol className={styles.transcriptList}>{readingTurns.map((turn) => <li key={turn.key} data-reading-turn={turn.key}>
      <div className={styles.transcriptMeta}>{recordedSpeakers.get(turn.key) && <RecordSpeakerIdentity speaker={recordedSpeakers.get(turn.key)}
        fallbackName={t(recordedSpeakers.get(turn.key)?.isUnresolved ? "화자 미상" : recordedSpeakers.get(turn.key)?.role === "host" ? "진행자" : recordedSpeakers.get(turn.key)?.role === "participant" ? "참여자" : "화자 미상")} />}
        <time dateTime={turn.startedAt}>{formatSystemRecordDate(turn.startedAt, language)}</time>
      </div>
      <div className={styles.transcriptParagraphs}>{turn.paragraphs.map((paragraph) => <div key={paragraph.key}>
        <p>{paragraph.fragments.map((fragment, index) => <span key={fragment.id} lang={fragment.language} data-source-utterance-id={fragment.id}>
          {index > 0 ? " " : ""}<time dateTime={fragment.startedAt} className={styles.fragmentTime}>{formatSystemRecordTime(fragment.startedAt, language, { seconds: true })}</time>
          {fragment.text}{fragment.isCorrected && <span className={styles.correctionMarker}>{t("교정본")}</span>}
        </span>)}</p>
        {paragraph.fragments.filter((fragment) => fragment.isCorrected && fragment.rawText !== fragment.text).map((fragment) => <details key={fragment.id} className={styles.rawOriginal} data-original-for={fragment.id}>
          <summary>{t("최초 전사 보기 · 발언 {seq}", { seq: fragment.seq })}</summary><p>{fragment.rawText}</p>
        </details>)}
      </div>)}</div>
    </li>)}</ol>
    {error && <p role="alert" className={styles.inlineError}>{t(error)}</p>}
    {isLoading && <p role="status" className={styles.empty}>{t("원문을 불러오는 중입니다.")}</p>}
    {nextCursor !== null && <button type="button" className={styles.secondaryButton} disabled={isLoading}
      onClick={() => { void loadPage(nextCursor); }}>{t(error ? "원문 다시 불러오기" : "원문 더 보기")}</button>}
  </section>;
}

export function RecordSummaryPanel({ summary, status, onRefresh }: {
  summary: LiveRecordSelectedSummary | null;
  status: SafeSummaryStatus;
  onRefresh: () => void;
}) {
  const t = useSystemText(recordsMessages);
  const { language } = useSystemLanguage();
  if (!summary) return <div className={styles.statePanel} role="status">
    {status === "running" ? <SummarySkeleton label={t("AI 요약을 정리하고 있습니다.")} /> : <p>{t(status === "missing" ? "아직 저장된 AI 요약이 없습니다." : "AI 요약을 확인하지 못했습니다.")}</p>}
    <button type="button" onClick={onRefresh}>{t("요약 상태 새로고침")}</button>
  </div>;
  const content = summary.summary;
  return <section className={styles.summaryPanel} aria-label={t("저장된 AI 요약")}>
    <header className={styles.panelHeading}><h2>{content.title || t("AI 요약")}</h2><time dateTime={summary.createdAt}>{formatSystemRecordDate(summary.createdAt, language)}</time></header>
    <p className={styles.summaryOverview}>{content.overview}</p>
    {content.chapters.map((chapter, index) => <section key={index}><h3>{chapter.title}</h3><p>{chapter.summary}</p></section>)}
    {content.decisions.length > 0 && <section><h3>{t("주요 결정")}</h3><ul>{content.decisions.map((decision, index) => <li key={index}>{decision}</li>)}</ul></section>}
    {content.actionItems.length > 0 && <section><h3>{t("다음 할 일")}</h3><ul>{content.actionItems.map((item, index) => <li key={index}>
      <p>{item.description}</p><span>{t("담당 {owner} · 기한 {due}", { owner: item.owner || t("미정"), due: item.due || t("미정") })}</span>
    </li>)}</ul></section>}
    {content.speakerHighlights.length > 0 && <section><h3>{t("발언자별 핵심")}</h3><ul>{content.speakerHighlights.map((item, index) => <li key={index}>
      <p>{item.speaker}</p><p>{item.highlight}</p>
    </li>)}</ul></section>}
    {content.participationStats.length > 0 && <section><h3>{t("발언 통계")}</h3><ul>{content.participationStats.map((item, index) => <li key={index}>
      {item.speaker} · {[item.department, item.jobTitle].filter(Boolean).join(" · ")} · {t("{count}회 · {seconds}초", { count: item.utteranceCount, seconds: Math.round(item.speakingSeconds) })}
    </li>)}</ul></section>}
  </section>;
}
