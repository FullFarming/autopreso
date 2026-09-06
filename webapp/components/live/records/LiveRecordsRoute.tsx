"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LiveRecordDetail as LiveRecordApiDetail } from "@/lib/live-records/service";
import { LANGUAGE_LABELS } from "@/lib/languageDetect";
import { RecordSummaryPanel } from "./RecordContentPanels";
import { type TranslationLanePresentation } from "../translation";
import { LiveRecordDetail } from "./LiveRecordDetail";
import { LiveRecordsList } from "./LiveRecordsList";
import type { LiveRecordDetailPresentation, LiveRecordListItem } from "./live-record-types";
import { deleteLiveRecord, fetchLiveRecordDetail, fetchLiveRecordPage, restoreLiveRecord, retryLiveRecordSync } from "./records-client";
import {
  getRecordStatusPresentation,
  getSummaryStatusPresentation,
  normalizeRecordSearch,
} from "./live-records-presentation";
import styles from "./live-records.module.css";

function listItem(record: Awaited<ReturnType<typeof fetchLiveRecordPage>>["items"][number]): LiveRecordListItem {
  return { id: record.sessionId, title: record.title, scheduledAt: record.scheduledAt,
    status: getRecordStatusPresentation(record.status),
    languages: record.languages, participantCount: record.participantCount,
    summaryState: getSummaryStatusPresentation(Object.values(record.summaryStates)[0]?.status ?? "missing"),
    syncState: record.sheetStatus.state === "succeeded" ? "synced" : record.sheetStatus.state === "failed" ? "failed"
      : record.sheetStatus.state === "not_configured" ? "disabled" : "pending" };
}

function detailPresentation(detail: LiveRecordApiDetail): LiveRecordDetailPresentation {
  const base = listItem(detail.record);
  return { ...base, lanes: detail.record.languages.map((language) => ({
      id: `translation:${language}`, kind: "translation", language, label: LANGUAGE_LABELS[language] || language })),
    topics: detail.topics.map((topic) => ({ id: topic.id, title: topic.title, startedAt: topic.startedAt,
      captionCount: detail.transcript.utterances.filter((utterance) => utterance.topicId === topic.id).length })),
    participants: detail.participants.map((participant) => ({ id: participant.participantId,
      email: participant.email ?? participant.displayName, company: participant.company,
      department: participant.department || null, jobTitle: participant.jobTitle || null,
      privacyConsent: participant.consents.privacy,
      summaryConsent: participant.consents.summaryDelivery,
      marketingConsent: participant.consents.marketing })), syncMessage: detail.record.sheetStatus.state === "failed"
      ? "운영 시트 동기화를 완료하지 못했습니다." : detail.record.sheetStatus.state === "succeeded"
        ? "운영 시트 동기화 완료" : "운영 시트 동기화 대기 중", deletedAt: detail.record.deletedAt };
}

function recordDetailCacheKey(sessionId: string, language?: string): string {
  return `${sessionId}:${language || "source"}`;
}

export function LiveRecordsRoute() {
  const t = useSystemText(recordsMessages);
  const [records, setRecords] = useState<LiveRecordListItem[]>([]);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalRecords, setTotalRecords] = useState(0);
  const [detail, setDetail] = useState<LiveRecordApiDetail | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState("source");
  const [selectedDetailKey, setSelectedDetailKey] = useState("");
  const [displayedDetailKey, setDisplayedDetailKey] = useState("");
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const detailCacheRef = useRef(new Map<string, LiveRecordApiDetail>());
  const detailRequestGenerationRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailRequestPendingRef = useRef(false);
  useEffect(() => () => { detailAbortRef.current?.abort(); }, []);
  const selectedDetailKeyRef = useRef("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRetryingSync, setIsRetryingSync] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");
  const [deletedRecord, setDeletedRecord] = useState<{ id: string; title: string } | null>(null);

  const loadList = useCallback(async () => {
    setIsLoading(true); setError("");
    try { const result = await fetchLiveRecordPage(page, activeQuery); setRecords(result.items.map(listItem)); setTotalRecords(result.total); setTotalPages(Math.max(1, Math.ceil(result.total / result.pageSize))); }
    catch { setError("라이브콜 기록을 불러오지 못했습니다. 다시 시도해 주세요."); }
    finally { setIsLoading(false); }
  }, [activeQuery, page]);
  useEffect(() => { void loadList(); }, [loadList]);

  const openDetail = useCallback(async (id: string, language?: string) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    detailRequestPendingRef.current = true;
    const cacheKey = recordDetailCacheKey(id, language);
    const requestGeneration = detailRequestGenerationRef.current + 1;
    detailRequestGenerationRef.current = requestGeneration;
    selectedDetailKeyRef.current = cacheKey;
    setSelectedDetailKey(cacheKey);
    setSelectedLaneId(language ? `translation:${language}` : "source");
    const cached = detailCacheRef.current.get(cacheKey);
    if (cached) {
      setDetail(cached);
      setSelectedLaneId(`translation:${cached.selectedLanguage}`);
      setDisplayedDetailKey(cacheKey);
    }
    setIsDetailLoading(!cached);
    if (!detail && !cached) setIsLoading(true);
    setError("");
    try {
      const result = await fetchLiveRecordDetail(id, language, controller.signal);
      if (controller.signal.aborted) return;
      detailCacheRef.current.set(cacheKey, result);
      if (requestGeneration !== detailRequestGenerationRef.current
        || selectedDetailKeyRef.current !== cacheKey) return;
      setDetail(result);
      setSelectedLaneId(`translation:${result.selectedLanguage}`);
      setDisplayedDetailKey(cacheKey);
    } catch {
      if (controller.signal.aborted) return;
      if (requestGeneration === detailRequestGenerationRef.current
        && selectedDetailKeyRef.current === cacheKey) {
        setError("라이브콜 기록을 불러오지 못했습니다. 다시 시도해 주세요.");
      }
    } finally {
      if (requestGeneration === detailRequestGenerationRef.current) {
        detailRequestPendingRef.current = false;
        setIsDetailLoading(false);
        setIsLoading(false);
      }
    }
  }, [detail]);

  useEffect(() => {
    if (!detail || error || selectedDetailKey !== displayedDetailKey || detail.summaryStates[detail.selectedLanguage]?.status !== "running") return;
    const pollingDetailKey = displayedDetailKey;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const check = () => {
      if (disposed || selectedDetailKeyRef.current !== pollingDetailKey) return;
      if (document.hidden || detailRequestPendingRef.current) { timer = setTimeout(check, 25_000); return; }
      void openDetail(detail.record.sessionId, detail.selectedLanguage);
    };
    timer = setTimeout(check, 25_000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [detail, error, openDetail, selectedDetailKey, displayedDetailKey]);

  const presentation = useMemo(() => detail ? detailPresentation(detail) : null, [detail]);
  const panel = detail && displayedDetailKey === selectedDetailKey ? <RecordSummaryPanel summary={detail.summary}
    status={detail.summaryStates[detail.selectedLanguage]?.status ?? "missing"}
    onRefresh={() => { void openDetail(detail.record.sessionId, selectedLaneId === "source" ? undefined : selectedLaneId.replace("translation:", "")); }} />
    : <section role="status" aria-live="polite">{t(isDetailLoading ? "상세 기록을 불러오는 중입니다." : "선택한 언어 기록을 불러오지 못했습니다.")}</section>;

  const restoreDeletedRecord = useCallback(async () => {
    if (!deletedRecord) return;
    setError("");
    try {
      await restoreLiveRecord(deletedRecord.id);
      setDeletedRecord(null);
      await loadList();
    } catch {
      setError("삭제한 기록을 복원하지 못했습니다. 다시 시도해 주세요.");
    }
  }, [deletedRecord, loadList]);

  const closeDetail = useCallback(() => {
    detailRequestGenerationRef.current += 1;
    detailRequestPendingRef.current = false;
    detailAbortRef.current?.abort();
    selectedDetailKeyRef.current = "";
    setSelectedDetailKey("");
    setDisplayedDetailKey("");
    setDetail(null);
    setIsDetailLoading(false);
  }, []);

  const retrySync = useCallback(async () => {
    if (!detail || isRetryingSync) return;
    setIsRetryingSync(true);
    setError("");
    try {
      await retryLiveRecordSync(detail.record.sessionId);
      await openDetail(detail.record.sessionId, selectedLaneId === "source"
        ? undefined
        : selectedLaneId.replace("translation:", ""));
    } catch {
      setError("동기화를 다시 요청하지 못했습니다.");
    } finally {
      setIsRetryingSync(false);
    }
  }, [detail, isRetryingSync, openDetail, selectedLaneId]);

  const deleteRecord = useCallback(async () => {
    if (!detail || isDeleting) return;
    const deleted = { id: detail.record.sessionId, title: detail.record.title };
    setIsDeleting(true);
    setError("");
    try {
      await deleteLiveRecord(deleted.id);
      setDeletedRecord(deleted);
      closeDetail();
      await loadList();
    } catch {
      setError("기록을 삭제 처리하지 못했습니다.");
    } finally {
      setIsDeleting(false);
    }
  }, [closeDetail, detail, isDeleting, loadList]);

  return <main className={`live-records-route ${styles.route}`}>
    {deletedRecord && <div className={styles.undo} role="status" aria-live="polite">
      <span>{t("{title} 기록을 복구 가능 상태로 삭제했습니다.", { title: deletedRecord.title })}</span>
      <button type="button" onClick={() => { void restoreDeletedRecord(); }}>{t("삭제 취소")}</button>
    </div>}
    {presentation && detail ? <LiveRecordDetail key={detail.record.sessionId} record={presentation} participants={detail.participants}
    panels={[{ laneId: selectedLaneId, content: panel }]} selectedLaneId={selectedLaneId}
    isRetryingSync={isRetryingSync} isDeleting={isDeleting} error={error} onBack={closeDetail}
    onSelectLane={(lane: TranslationLanePresentation) => { void openDetail(detail.record.sessionId, lane.kind === "translation" ? lane.language : undefined); }}
    onRetrySync={() => { void retrySync(); }} onDelete={() => { void deleteRecord(); }} />
    : <LiveRecordsList records={records} query={query} activeQuery={activeQuery} totalRecords={totalRecords} page={page} totalPages={totalPages} isLoading={isLoading} error={error}
      onQueryChange={setQuery} onSearch={() => { setPage(1); setActiveQuery(normalizeRecordSearch(query)); }}
      onClearSearch={() => { setQuery(""); setPage(1); setActiveQuery(""); }} onRetry={() => { void loadList(); }}
      onPageChange={setPage} onOpen={(id) => { void openDetail(id); }} />}
  </main>;
}
