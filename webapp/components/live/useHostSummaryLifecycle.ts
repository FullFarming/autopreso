"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiResponse, LiveTopicPublicMetadata } from "@/lib/live-contract";
import type { MeetingSummary } from "@/lib/live/summary";
import type { TranscriptEntry } from "./MeetingMinutes";
import { startSummaryPollLoop, type SummaryPollingState } from "./meeting-summary-polling";

interface EndedSessionReference {
  id: string;
  languages: string[];
}

export function getSafeSummaryErrorMessage(code: string | undefined): string {
  if (code === "SUMMARY_FORBIDDEN") return "회의 요약을 볼 권한이 없습니다.";
  if (code === "SUMMARY_GENERATION_RETRYABLE_FAILED"
    || code === "SUMMARY_PROVIDER_RATE_LIMITED"
    || code === "SUMMARY_PROVIDER_UNAVAILABLE"
    || code === "SUMMARY_TIMEOUT") {
    return "회의 요약 생성이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (code === "SUMMARY_GENERATION_EXHAUSTED"
    || code === "SUMMARY_GENERATION_PERMANENT_FAILED"
    || code === "SUMMARY_REFUSED") {
    return "회의 요약을 생성하지 못했습니다. 관리자에게 문의해 주세요.";
  }
  return "회의 요약을 불러오지 못했습니다. 다시 시도해 주세요.";
}

export function getSafeTranscriptErrorMessage(code: string | undefined): string {
  if (code === "TRANSCRIPT_FORBIDDEN") return "전체 자막을 볼 권한이 없습니다.";
  if (code === "TRANSCRIPT_TOO_LARGE") return "전체 자막의 양이 많아 표시할 수 없습니다.";
  return "전체 자막을 불러오지 못했습니다. 다시 확인해 주세요.";
}

export function useHostSummaryLifecycle(endedSession: EndedSessionReference | null) {
  const [summary, setSummary] = useState<{ summary: MeetingSummary; createdAt: string } | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [summaryFailureCode, setSummaryFailureCode] = useState("");
  const [pollingState, setPollingState] = useState<SummaryPollingState>("idle");
  const [pollingStartedAt, setPollingStartedAt] = useState<number | null>(null);
  const [pollingRound, setPollingRound] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [topics, setTopics] = useState<LiveTopicPublicMetadata[]>([]);
  const [isTranscriptLoaded, setIsTranscriptLoaded] = useState(false);
  const [transcriptError, setTranscriptError] = useState("");
  const [isRetrying, setIsRetrying] = useState(false);
  const retryRef = useRef(false);

  const loadSummary = useCallback(async (): Promise<boolean> => {
    const language = endedSession?.languages[0];
    if (!endedSession || !language) return false;
    try {
      const response = await fetch(`/api/live-sessions/${endedSession.id}/summary?language=${encodeURIComponent(language)}`, {
        method: "GET", cache: "no-store",
      });
      const payload = await response.json() as ApiResponse<{ summary: MeetingSummary; createdAt: string }>;
      if (payload.ok) {
        setSummary(payload.data);
        setSummaryError("");
        setSummaryFailureCode("");
        setPollingState("idle");
        return false;
      }
      if (payload.code === "SUMMARY_NOT_READY" || payload.code === "SUMMARY_GENERATION_RUNNING") {
        setSummaryFailureCode("");
        setPollingState("polling");
        return true;
      }
      setSummaryError(getSafeSummaryErrorMessage(payload.code));
      setSummaryFailureCode(payload.code ?? "");
      setPollingState(payload.code === "SUMMARY_GENERATION_EXHAUSTED" ? "exhausted" : "failed");
      return false;
    } catch {
      setSummaryError(getSafeSummaryErrorMessage(undefined));
      setSummaryFailureCode("");
      setPollingState("failed");
      return false;
    }
  }, [endedSession]);

  const loadTranscript = useCallback(async () => {
    const language = endedSession?.languages[0];
    if (!endedSession || !language) return;
    try {
      const response = await fetch(`/api/live-sessions/${endedSession.id}/transcript?language=${encodeURIComponent(language)}`, {
        method: "GET", cache: "no-store",
      });
      const payload = await response.json() as ApiResponse<{ topics: LiveTopicPublicMetadata[]; utterances: TranscriptEntry[] }>;
      if (!payload.ok) {
        setTranscript([]);
        setTopics([]);
        setIsTranscriptLoaded(false);
        setTranscriptError(getSafeTranscriptErrorMessage(payload.code));
        return;
      }
      setTranscript(payload.data.utterances);
      setTopics(payload.data.topics);
      setIsTranscriptLoaded(true);
      setTranscriptError("");
    } catch {
      setTranscript([]);
      setTopics([]);
      setIsTranscriptLoaded(false);
      setTranscriptError(getSafeTranscriptErrorMessage(undefined));
    }
  }, [endedSession]);

  const retrySummary = useCallback(async () => {
    const language = endedSession?.languages[0];
    if (retryRef.current || !endedSession || !language || summaryFailureCode !== "SUMMARY_GENERATION_RETRYABLE_FAILED") return;
    retryRef.current = true;
    setIsRetrying(true);
    setSummaryError("");
    try {
      const response = await fetch(`/api/live-sessions/${endedSession.id}/summary`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ language }),
      });
      const payload = await response.json() as ApiResponse<unknown>;
      if (!payload.ok) {
        setSummaryFailureCode(payload.code ?? "");
        setPollingState(payload.code === "SUMMARY_GENERATION_EXHAUSTED" ? "exhausted" : "failed");
        setSummaryError(getSafeSummaryErrorMessage(payload.code));
        return;
      }
      setSummaryFailureCode("");
      setPollingState("polling");
      setPollingStartedAt(Date.now());
      setPollingRound((round) => round + 1);
    } catch {
      setSummaryFailureCode("");
      setPollingState("failed");
      setSummaryError(getSafeSummaryErrorMessage(undefined));
    } finally {
      retryRef.current = false;
      setIsRetrying(false);
    }
  }, [endedSession, summaryFailureCode]);

  useEffect(() => {
    if (!endedSession || summary) return;
    let isDisposed = false;
    let stopPolling = () => {};
    setPollingState("polling");
    setPollingStartedAt((startedAt) => startedAt ?? Date.now());
    void loadSummary().then((shouldContinue) => {
      if (isDisposed || !shouldContinue) return;
      stopPolling = startSummaryPollLoop({
        poll: loadSummary,
        onExhausted: () => { setPollingState("exhausted"); setSummaryFailureCode("SUMMARY_GENERATION_EXHAUSTED"); setSummaryError(""); },
        onError: () => { setPollingState("failed"); setSummaryFailureCode(""); setSummaryError(getSafeSummaryErrorMessage(undefined)); },
      });
    });
    return () => { isDisposed = true; stopPolling(); };
  }, [endedSession, summary, pollingRound, loadSummary]);

  useEffect(() => { if (endedSession) void loadTranscript(); }, [endedSession, loadTranscript]);

  const retry = useCallback(() => {
    if (summaryFailureCode === "SUMMARY_GENERATION_RETRYABLE_FAILED") void retrySummary();
    else setPollingRound((round) => round + 1);
    void loadTranscript();
  }, [loadTranscript, retrySummary, summaryFailureCode]);

  const reset = useCallback(() => {
    setSummary(null); setSummaryError(""); setSummaryFailureCode(""); setPollingState("idle"); setPollingStartedAt(null);
    setTranscript([]); setTopics([]); setIsTranscriptLoaded(false); setTranscriptError("");
  }, []);

  return { summary, summaryError, summaryFailureCode, pollingState, pollingStartedAt, transcript, topics,
    isTranscriptLoaded, transcriptError, isRetrying, retry, reset };
}
