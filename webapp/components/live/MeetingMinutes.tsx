"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

// Post-meeting minutes (회의록): AI summary on top, then the full
// speaker-attributed utterance record grouped into turns, in the viewer's
// chosen language. Shown when the host ends the session.

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import type { MeetingSummary } from "@/lib/live/summary";
import type { LiveTopicPublicMetadata } from "@/lib/live-contract";
import { ReadingSurface } from "@/components/ui/FormControls";
import MeetingSummaryCard from "./MeetingSummaryCard";
import { indexTopicCaptions, type TopicPresentation } from "./translation";
import { MeetingTopicChapters, RecapStatePanel } from "./quality/MeetingTopicPresentation";
import { EarningsCallHeader, GroundedPostCallIndex, hasEarningsContext, type EarningsEventPresentation } from "./earnings";
import { formatElapsedTime, formatMinuteTime, groupTranscript, type TranscriptEntry } from "./meeting-minutes-model";
import type { SummaryPollingState } from "./meeting-summary-polling";

export type { TranscriptEntry } from "./meeting-minutes-model";

export default function MeetingMinutes({
  summary,
  summaryCreatedAt,
  transcript,
  topics = [],
  isTranscriptLoaded,
  summaryError,
  transcriptError,
  isLoading,
  minutesPollingState,
  minutesPollingStartedAt,
  onRetry,
  expandedTopicIds,
  onExpandedTopicChange,
  event,
}: {
  summary: MeetingSummary | null;
  summaryCreatedAt: string | null;
  transcript: TranscriptEntry[];
  topics?: LiveTopicPublicMetadata[];
  isTranscriptLoaded: boolean;
  summaryError: string;
  transcriptError: string;
  isLoading: boolean;
  minutesPollingState: SummaryPollingState;
  minutesPollingStartedAt: number | null;
  onRetry: () => void;
  expandedTopicIds?: readonly string[];
  onExpandedTopicChange?: (topicId: string, isExpanded: boolean) => void;
  event?: EarningsEventPresentation | null;
}) {
  const t = useSystemText(recordsMessages);
  const turns = useMemo(() => groupTranscript(transcript), [transcript]);
  const topicRecords = useMemo<TopicPresentation[]>(() => {
    const indexed = indexTopicCaptions(transcript);
    return topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        timeLabel: formatMinuteTime(topic.startedAt),
        summary: topic.summary ?? undefined,
        captions: (indexed.byTopicId.get(topic.id) ?? []).map((entry) => ({
            id: entry.utteranceKey ?? `minute-${entry.seq}`,
            utteranceKey: entry.utteranceKey,
            text: entry.text,
            speakerLabel: entry.speaker,
            timestamp: formatMinuteTime(entry.emittedAt),
            isFinal: true,
            translationStatus: entry.translationStatus,
            sourceText: entry.sourceText,
          })),
      }));
  }, [topics, transcript]);
  const unassignedTurns = useMemo(() => groupTranscript(
    topicRecords.length ? transcript.filter((entry) => !entry.topicId) : [],
  ), [topicRecords.length, transcript]);
  const [activeTab, setActiveTab] = useState<"summary" | "transcript">("summary");
  const [clockMilliseconds, setClockMilliseconds] = useState(() => Date.now());
  const isSummaryPolling = !summary && minutesPollingState === "polling";
  useEffect(() => {
    if (!isSummaryPolling) return;
    const ticker = window.setInterval(() => setClockMilliseconds(Date.now()), 1_000);
    return () => window.clearInterval(ticker);
  }, [isSummaryPolling]);
  const elapsedTime = formatElapsedTime(minutesPollingStartedAt === null
    ? 0
    : clockMilliseconds - minutesPollingStartedAt);
  const selectAdjacentTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab = event.key === "ArrowRight" || event.key === "End" ? "transcript" : "summary";
    setActiveTab(nextTab);
    document.getElementById(`live-minutes-tab-${nextTab}`)?.focus();
  };
  return (
    <ReadingSurface ariaLabel={t("회의 기록")}>
    <div className="live-minutes live-minutes-reading">
      {event && hasEarningsContext(event) && <EarningsCallHeader event={event} statusLabel={t("종료된 실적 발표")} />}
      <div className="live-minutes-tabs" role="tablist" aria-label={t("회의 기록")}>
        <button id="live-minutes-tab-summary" type="button" role="tab" aria-selected={activeTab === "summary"}
          aria-controls="live-minutes-panel-summary" tabIndex={activeTab === "summary" ? 0 : -1}
          className={activeTab === "summary" ? "is-selected" : ""}
          onClick={() => setActiveTab("summary")} onKeyDown={selectAdjacentTab}>{t("요약")}</button>
        <button id="live-minutes-tab-transcript" type="button" role="tab" aria-selected={activeTab === "transcript"}
          aria-controls="live-minutes-panel-transcript" tabIndex={activeTab === "transcript" ? 0 : -1}
          className={activeTab === "transcript" ? "is-selected" : ""}
          onClick={() => setActiveTab("transcript")} onKeyDown={selectAdjacentTab}>{t("전체 자막")}</button>
      </div>
      {activeTab === "summary" ? (
      <section id="live-minutes-panel-summary" className="live-minutes-panel" role="tabpanel"
        aria-labelledby="live-minutes-tab-summary">
        {summary
          ? <MeetingSummaryCard summary={summary} createdAt={summaryCreatedAt} />
          : (
            <RecapStatePanel isBusy={isSummaryPolling}>
              {isSummaryPolling ? (
                <div className="live-minutes-loading" role="status" aria-live="polite">
                  <span className="live-minutes-loading-dots" aria-hidden="true"><i /><i /><i /></span>
                  <strong>{t("회의 요약을 만들고 있습니다")}</strong>
                  <span className="live-minutes-elapsed">{t("경과 시간 {elapsed}", { elapsed: elapsedTime })}</span>
                </div>
              ) : (
                <>
                  <p role={summaryError ? "alert" : undefined}>{t(summaryError || "회의 요약 생성이 예상보다 오래 걸리고 있습니다.")}</p>
                  <button type="button" disabled={isLoading} onClick={onRetry}>{t(isLoading ? "확인 중…" : "다시 시도")}</button>
                </>
              )}
            </RecapStatePanel>
          )}
      </section>
      ) : (
      <section id="live-minutes-panel-transcript" className="live-minutes-panel" role="tabpanel"
        aria-labelledby="live-minutes-tab-transcript">
        {transcriptError ? (
          <div className="live-minutes-pending">
            <p role="alert">{t(transcriptError || "전체 자막을 불러오지 못했습니다. 다시 확인해 주세요.")}</p>
            <button type="button" disabled={isLoading} onClick={onRetry}>{t(isLoading ? "확인 중…" : "다시 확인")}</button>
          </div>
        ) : topicRecords.length > 0 ? (
          <>
            <GroundedPostCallIndex agenda={event?.agenda ?? []} topics={topicRecords} />
            <MeetingTopicChapters topics={topicRecords}
              expandedTopicIds={expandedTopicIds} onExpandedChange={onExpandedTopicChange} />
            {unassignedTurns.length > 0 && (
              <section className="live-minutes-record" aria-label={t("분류되지 않은 자막")}>
                <h3>{t("분류되지 않은 자막")}</h3>
                {unassignedTurns.map((turn) => (
                  <article key={turn.key}>
                    <header><strong>{turn.speaker}</strong><time dateTime={turn.startedAt}>{formatMinuteTime(turn.startedAt)}</time></header>
                    <p>{turn.texts.join(" ")}</p>
                  </article>
                ))}
              </section>
            )}
          </>
        ) : turns.length > 0 ? (
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
        ) : isTranscriptLoaded
          ? <p className="live-minutes-empty">{t("표시할 자막이 없습니다.")}</p>
          : <p className="live-minutes-empty">{t(isLoading ? "전체 자막을 불러오는 중…" : "전체 자막이 아직 준비되지 않았습니다.")}</p>}
      </section>
      )}
    </div>
    </ReadingSurface>
  );
}
