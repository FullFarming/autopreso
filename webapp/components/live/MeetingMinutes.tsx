"use client";

// Post-meeting minutes (회의록): AI summary on top, then the full
// speaker-attributed utterance record grouped into turns, in the viewer's
// chosen language. Shown when the host ends the session.

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

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

export function formatElapsedTime(elapsedMilliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMilliseconds / 1_000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// ─── Summary Polling ───

export type SummaryPollingState = "idle" | "polling" | "exhausted" | "failed";

const SUMMARY_POLL_BASE_DELAYS_MILLISECONDS = [2_000, 4_000, 8_000, 12_000, 16_000, 20_000] as const;

interface SummaryPollTimerApi {
  setTimeout: (callback: () => void, delayMilliseconds: number) => number;
  clearTimeout: (timer: number) => void;
}

interface SummaryPollLoopOptions {
  poll: () => Promise<boolean>;
  onExhausted: () => void;
  onError: (error: unknown) => void;
  random?: () => number;
  timerApi?: SummaryPollTimerApi;
}

export function getSummaryPollDelayMilliseconds(attempt: number, randomValue: number): number {
  const index = Math.min(
    SUMMARY_POLL_BASE_DELAYS_MILLISECONDS.length - 1,
    Math.max(0, Math.trunc(attempt)),
  );
  const boundedRandomValue = Math.min(1, Math.max(0, randomValue));
  return Math.round(SUMMARY_POLL_BASE_DELAYS_MILLISECONDS[index] * (1 + boundedRandomValue * 0.25));
}

export function startSummaryPollLoop({
  poll,
  onExhausted,
  onError,
  random = Math.random,
  timerApi = {
    setTimeout: (callback, delayMilliseconds) => window.setTimeout(callback, delayMilliseconds),
    clearTimeout: (timer) => window.clearTimeout(timer),
  },
}: SummaryPollLoopOptions): () => void {
  let attempt = 0;
  let timer: number | null = null;
  let isDisposed = false;

  const scheduleNext = () => {
    if (isDisposed) return;
    if (attempt >= SUMMARY_POLL_BASE_DELAYS_MILLISECONDS.length) {
      onExhausted();
      return;
    }
    const delayMilliseconds = getSummaryPollDelayMilliseconds(attempt, random());
    timer = timerApi.setTimeout(() => {
      timer = null;
      attempt += 1;
      void poll()
        .then((shouldContinue) => {
          if (!isDisposed && shouldContinue) scheduleNext();
        })
        .catch((error: unknown) => {
          if (!isDisposed) onError(error);
        });
    }, delayMilliseconds);
  };

  scheduleNext();
  return () => {
    isDisposed = true;
    if (timer !== null) timerApi.clearTimeout(timer);
    timer = null;
  };
}

// ─── Meeting Minutes ───

export default function MeetingMinutes({
  summary,
  summaryCreatedAt,
  transcript,
  isTranscriptLoaded,
  summaryError,
  transcriptError,
  isLoading,
  minutesPollingState,
  minutesPollingStartedAt,
  onRetry,
}: {
  summary: MeetingSummary | null;
  summaryCreatedAt: string | null;
  transcript: TranscriptEntry[];
  isTranscriptLoaded: boolean;
  summaryError: string;
  transcriptError: string;
  isLoading: boolean;
  minutesPollingState: SummaryPollingState;
  minutesPollingStartedAt: number | null;
  onRetry: () => void;
}) {
  const turns = useMemo(() => groupTranscript(transcript), [transcript]);
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
            <div className="live-minutes-pending" aria-busy={isSummaryPolling}>
              {isSummaryPolling ? (
                <div className="live-minutes-loading" role="status" aria-live="polite">
                  <span className="live-minutes-loading-dots" aria-hidden="true"><i /><i /><i /></span>
                  <strong>Creating AI summary</strong>
                  <span className="live-minutes-elapsed">Elapsed {elapsedTime}</span>
                </div>
              ) : (
                <>
                  <p role={summaryError ? "alert" : undefined}>{summaryError || "Summary is taking longer than expected."}</p>
                  <button type="button" disabled={isLoading} onClick={onRetry}>{isLoading ? "Loading…" : "Retry"}</button>
                </>
              )}
            </div>
          )}
      </section>
      <section id="live-minutes-panel-transcript" className="live-minutes-panel" role="tabpanel"
        aria-labelledby="live-minutes-tab-transcript" hidden={activeTab !== "transcript"}>
        {transcriptError ? (
          <div className="live-minutes-pending">
            <p role="alert">{transcriptError || "Unable to load the transcript. Check again."}</p>
            <button type="button" disabled={isLoading} onClick={onRetry}>{isLoading ? "Loading…" : "Check again"}</button>
          </div>
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
          ? <p className="live-minutes-empty">No transcript is available.</p>
          : <p className="live-minutes-empty">{isLoading ? "Loading transcript…" : "The transcript is not ready yet."}</p>}
      </section>
    </div>
  );
}
