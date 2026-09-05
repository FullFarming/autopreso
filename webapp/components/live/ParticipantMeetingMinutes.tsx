"use client";

import { useSystemText, useSystemLanguage } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";
import { SYSTEM_LOCALES } from "@/lib/system-language";


import { useId, useMemo, useState, type KeyboardEvent } from "react";
import type { RecordingGap } from "@/lib/live-recap/contract";
import type { MeetingSummary } from "@/lib/live/summary";
import type { LiveTopicPublicMetadata } from "@/lib/live-contract";
import type { TranscriptEntry } from "./meeting-minutes-model";
import { formatMinuteTime } from "./meeting-minutes-model";
import SummarySkeleton from "./SummarySkeleton";
import { ViewerRecapRequest, type ViewerRecapClient } from "./ViewerRecapRequest";

interface Props {
  sessionId: string; email: string; summary: MeetingSummary | null; transcript: TranscriptEntry[];
  recordingGaps: RecordingGap[]; topics: LiveTopicPublicMetadata[]; isTranscriptLoaded: boolean; summaryError: string; transcriptError: string;
  /** No speech was recorded: an empty record, not a failure to re-check. */
  isSummaryEmpty?: boolean;
  isLoading: boolean; isExpired: boolean; onRetry: () => void; recapClient?: ViewerRecapClient;
}

export function ParticipantMeetingMinutes({ sessionId, email, summary, transcript, topics, isTranscriptLoaded,
  summaryError, transcriptError, isSummaryEmpty = false, isLoading, isExpired, onRetry, recapClient, recordingGaps }: Props) {
  const t = useSystemText(viewerMessages);
  const { language: systemLanguage } = useSystemLanguage();
  const [tab, setTab] = useState<"source" | "summary">("source");
  const id = useId();
  const sourceByTopic = useMemo(() => new Map(topics.map((topic) => [topic.id, transcript.filter((entry) => entry.topicId === topic.id)])), [topics, transcript]);
  function selectKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "source" : event.key === "End" ? "summary" : tab === "summary" ? "source" : "summary";
    setTab(next); document.getElementById(`${id}-${next}`)?.focus();
  }
  const renderSource = (entries: TranscriptEntry[]) => entries.map((entry) => <article key={entry.utteranceKey ?? entry.seq} data-utterance-key={entry.utteranceKey ?? String(entry.seq)}>
    <header>{entry.speaker}<time dateTime={entry.emittedAt}>{formatMinuteTime(entry.emittedAt)}</time></header>
    <p lang={entry.sourceLanguage}>{entry.text}</p>
  </article>);
  if (isExpired) return <section className="viewer-record-expired" role="status"><h2>{t("열람 기간이 끝났어요")}</h2><p>{t("이 회의의 원문과 요약은 종료 후 6시간 동안 확인할 수 있어요.")}</p></section>;
  return <section className="viewer-minutes" aria-label={t("회의 기록")}>
    <div role="tablist" aria-label={t("회의 기록")} className="viewer-record-tabs">
      {(["source", "summary"] as const).map((value) => <button key={value} id={`${id}-${value}`} type="button" role="tab"
        aria-selected={tab === value} aria-controls={`${id}-${value}-panel`} tabIndex={tab === value ? 0 : -1}
        onClick={() => setTab(value)} onKeyDown={selectKey}>{value === "source" ? t("원문") : t("AI 요약")}</button>)}
    </div>
    {recordingGaps.length > 0 && <aside className="viewer-recording-gaps" aria-label={t("기록되지 않은 구간")}>
      <h3>{t("기록되지 않은 구간")}</h3><p>{t("아래 구간의 발언 원문은 기록되지 않았어요.")}</p>
      <ul>{recordingGaps.map((gap) => <li key={gap.id}>
        <time dateTime={gap.startedAt}>{new Date(gap.startedAt).toLocaleString(SYSTEM_LOCALES[systemLanguage], { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time>
        {" – "}{gap.endedAt ? <time dateTime={gap.endedAt}>{new Date(gap.endedAt).toLocaleString(SYSTEM_LOCALES[systemLanguage], { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time> : t("종료 시각 미확인")}
        <span>{gap.reason === "no_viewers" ? t("참여자 대기") : gap.reason === "host_unavailable" ? t("호스트 연결 대기") : gap.reason === "source_recording_failed" ? t("원문 기록 중단") : t("미디어 연결 중단")}</span>
      </li>)}</ul>
    </aside>}
    <div role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}`}>
      {tab === "source" ? transcriptError ? <p role="alert">{t(transcriptError)}</p> : transcript.length > 0
        ? <div className="viewer-source-record">{renderSource(transcript)}</div>
        : <p role="status">{isTranscriptLoaded ? t("저장된 발언 원문이 없습니다.") : t("발언 원문을 불러오는 중입니다.")}</p>
        : summary ? <div className="viewer-summary-record">
          <span className="viewer-muted">{t("AI 요약")}</span><h2>{t("핵심 내용")}</h2><p>{summary.overview}</p>
          {summary.decisions.length > 0 && <ul>{summary.decisions.map((value, index) => <li key={index}>{value}</li>)}</ul>}
          {summary.actionItems.length > 0 && <section><h3>{t("후속 과제")}</h3>{summary.actionItems.map((item, index) => <p key={index}>{item.description}{item.owner ? ` · ${item.owner}` : ""}</p>)}</section>}
          <h3>{t("주제별 정리")}</h3>
          {topics.length > 0 ? topics.map((topic) => <section className="viewer-topic-summary" key={topic.id}>
            <h4>{topic.title}</h4><p>{topic.summary || t("주제 요약이 아직 준비되지 않았어요.")}</p>
            <details><summary>{t("발언 원문 펼치기")}</summary><div className="viewer-source-record">{sourceByTopic.get(topic.id)?.length
              ? renderSource(sourceByTopic.get(topic.id) ?? []) : <p>{t("이 주제의 발언 원문을 확인할 수 없어요. 원문 탭에서 전체 기록을 확인해 주세요.")}</p>}</div></details>
          </section>) : summary.chapters.map((chapter, index) => <details className="viewer-topic-summary" key={index}>
            <summary><h4>{chapter.title}</h4><span>{t("요약 펼치기")}</span></summary><p>{chapter.summary}</p>
            <button type="button" className="viewer-text-button" onClick={() => { setTab("source"); document.getElementById(`${id}-source`)?.focus(); }}>{t("전체 발언 원문 보기")}</button>
          </details>)}
        </div> : isSummaryEmpty ? <p role="status">{t("기록된 발언이 없어 요약을 만들 수 없습니다.")}</p>
        : summaryError ? <p role="alert">{t(summaryError)}</p>
        : isLoading ? <SummarySkeleton label={t("회의 요약을 준비하고 있어요. 원문은 먼저 확인할 수 있어요.")} />
        : <p role="status">{t("요약 상태 확인이 지연되고 있습니다. 다시 확인해 주세요.")}</p>}
      {(transcriptError || (!isSummaryEmpty && (summaryError || (!summary && !isLoading)))) && <button className="viewer-text-button" type="button" disabled={isLoading} onClick={onRetry}>{isLoading ? t("확인 중…") : t("다시 확인")}</button>}
    </div>
    <ViewerRecapRequest key={sessionId} sessionId={sessionId} email={email} isExpired={isExpired} client={recapClient} />
  </section>;
}
