"use client";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages, formatSystemRecordDate } from "@/lib/system-language/records-messages";

import { ArrowLeft, DownloadSimple } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { LiveRecordParticipant } from "@/lib/live-records/service";
import type { HostRecapRequest } from "@/lib/live-recap/contract";
import { TranslationLaneTabs, type TranslationLanePresentation } from "../translation";
import type { LiveRecordDetailPresentation, LiveRecordLanguagePanel } from "./live-record-types";
import { fetchLiveRecordExport, fetchLiveRecordOriginals, fetchLiveRecordRecipients } from "./records-client";
import { RecordOriginalPanel } from "./RecordContentPanels";
import { RecordPeopleTable } from "./RecordPeopleTable";
import styles from "./live-records.module.css";

interface LiveRecordDetailProps {
  record: LiveRecordDetailPresentation;
  participants: readonly LiveRecordParticipant[];
  panels: readonly LiveRecordLanguagePanel[];
  selectedLaneId: string;
  isRetryingSync?: boolean;
  isDeleting?: boolean;
  error?: string;
  onBack: () => void;
  onSelectLane: (lane: TranslationLanePresentation) => void;
  onRetrySync: () => void;
  onDelete: () => void;
  dataSource?: LiveRecordDetailDataSource;
}

export interface LiveRecordDetailDataSource {
  loadOriginals: typeof fetchLiveRecordOriginals;
  loadRecipients: typeof fetchLiveRecordRecipients;
  loadExport: typeof fetchLiveRecordExport;
}

const defaultDataSource: LiveRecordDetailDataSource = {
  loadOriginals: fetchLiveRecordOriginals,
  loadRecipients: fetchLiveRecordRecipients,
  loadExport: fetchLiveRecordExport,
};

const RECORD_TABS = ["참여자", "원문", "AI 요약", "수신 신청자"];

export function LiveRecordDetail({ record, participants, panels, selectedLaneId, isRetryingSync = false, isDeleting = false, error = "", onBack, onSelectLane, onRetrySync, onDelete, dataSource = defaultDataSource }: LiveRecordDetailProps) {
  const t = useSystemText(recordsMessages);
  const { language } = useSystemLanguage();
  const [selectedTab, setSelectedTab] = useState(0);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [recipients, setRecipients] = useState<HostRecapRequest[] | null>(null);
  const [recipientError, setRecipientError] = useState("");
  const [recipientVersion, setRecipientVersion] = useState(0);
  const [isRecipientsLoading, setIsRecipientsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const exportInFlightRef = useRef(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const renderPanel = (lane: TranslationLanePresentation) => panels.find((panel) => panel.laneId === lane.id)?.content
    ?? <p className={styles.empty} role="status">{t("이 언어의 요약이 없습니다.")}</p>;

  useEffect(() => {
    const controller = new AbortController();
    setIsRecipientsLoading(true);
    setRecipientError("");
    void dataSource.loadRecipients(record.id, controller.signal).then((requests) => {
      if (!controller.signal.aborted) setRecipients(requests);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setRecipientError(failure instanceof Error ? failure.message : "수신 신청자를 불러오지 못했습니다.");
    }).finally(() => { if (!controller.signal.aborted) setIsRecipientsLoading(false); });
    return () => controller.abort();
  }, [dataSource, record.id, recipientVersion]);

  function selectByKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % RECORD_TABS.length;
    else if (event.key === "ArrowLeft") next = (index + RECORD_TABS.length - 1) % RECORD_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = RECORD_TABS.length - 1;
    else return;
    event.preventDefault();
    setSelectedTab(next);
    tabRefs.current[next]?.focus();
  }

  async function exportWorkbook() {
    if (exportInFlightRef.current) return;
    exportInFlightRef.current = true;
    setIsExporting(true);
    setExportError("");
    setExportStatus("");
    try {
      const result = await dataSource.loadExport(record.id);
      const objectUrl = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = result.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // The browser must consume the object URL before its backing buffer is released.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      setExportStatus("Excel 다운로드를 시작했습니다.");
    } catch (failure) {
      setExportError(failure instanceof Error ? failure.message : "Excel 파일을 준비하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      exportInFlightRef.current = false;
      setIsExporting(false);
    }
  }

  return <article className={styles.detail} aria-labelledby="live-record-detail-heading">
    <div className={styles.hostBrand}>NOVA <span>HOST</span></div>
    <button className={styles.detailBack} type="button" onClick={onBack}><ArrowLeft size={20} aria-hidden="true" />{t("라이브콜 기록")}</button>
    <header className={styles.recordHeader}>
      <div className={styles.recordTitle}><h1 id="live-record-detail-heading">{record.title}</h1>
        <p>{formatSystemRecordDate(record.scheduledAt, language)}<span aria-hidden="true"> · </span>{t(record.status.label === "종료" ? "회의 종료" : record.status.label)}</p>
      </div>
      <div className={styles.exportArea}><button className={styles.exportButton} type="button" disabled={isExporting} onClick={() => { void exportWorkbook(); }}>
        <DownloadSimple size={22} aria-hidden="true" />{t(isExporting ? "Excel 준비 중" : "전체 Excel 내보내기")}</button><span>{t("이 회의의 전체 기록")}</span></div>
    </header>
    {(error || exportError) && <p className={styles.inlineError} role="alert">{t(exportError || error)}</p>}
    {exportStatus && <p className={styles.exportStatus} role="status">{t(exportStatus)}</p>}
    <div className={styles.recordTabs} role="tablist" aria-label={t("라이브콜 기록 항목")}>{RECORD_TABS.map((label, index) => <button key={label}
      ref={(node) => { tabRefs.current[index] = node; }} id={`record-tab-${index}`} type="button" role="tab"
      aria-selected={selectedTab === index} aria-controls={`record-panel-${index}`} tabIndex={selectedTab === index ? 0 : -1}
      onClick={() => setSelectedTab(index)} onKeyDown={(event) => selectByKeyboard(event, index)}>
      {t(label)}{index === 0 && <span>{participants.length}</span>}{index === 3 && recipients !== null && <span>{recipients.filter((request) => request.status === "requested").length}</span>}
    </button>)}</div>
    <div className={styles.recordPanel} id={`record-panel-${selectedTab}`} role="tabpanel" aria-labelledby={`record-tab-${selectedTab}`} tabIndex={0}>
      {selectedTab === 0 && <RecordPeopleTable key="participants" participants={participants} recipients={[]} mode="participants" />}
      {selectedTab === 1 && <RecordOriginalPanel key={record.id} sessionId={record.id} loadOriginals={dataSource.loadOriginals} />}
      {selectedTab === 2 && <section className={styles.preview} aria-label={t("AI 요약 언어별 보기")}>
        <TranslationLaneTabs lanes={record.lanes} selectedLaneId={selectedLaneId} onChange={onSelectLane} renderPanel={renderPanel}
          ariaLabel={t("요약 언어")} emptyLabel={t("저장된 언어 기록이 없습니다.")} />
      </section>}
      {selectedTab === 3 && <>
        {isRecipientsLoading && <p className={styles.empty} role="status">{t("수신 신청자를 불러오는 중입니다.")}</p>}
        {recipientError && <div className={styles.statePanel}><p role="alert">{t(recipientError)}</p><button type="button" onClick={() => setRecipientVersion((version) => version + 1)}>{t("명단 다시 불러오기")}</button></div>}
        {!isRecipientsLoading && !recipientError && recipients && <RecordPeopleTable key="recipients" participants={[]} recipients={recipients} mode="recipients" />}
      </>}
    </div>
    <footer className={styles.exportNote}><p>{t("Excel에는 회의 정보, 참여자, 원문, AI 요약, 수신 신청자가 각각의 시트로 담겨요.")}</p><p>{t("검색·페이지와 관계없이 이 회의 전체를 내보내요.")}</p></footer>
    <details className={styles.operationsDisclosure}><summary>{t("기록 관리")}</summary>
      <section className={styles.operations} aria-label={t("기록 관리")}>
        <div className={styles.sectionHeading}><h2>{t("운영 상태")}</h2><span>{t(record.syncMessage)}</span></div>
        {record.syncState === "failed" && <button className={styles.secondaryButton} type="button" disabled={isRetryingSync} onClick={onRetrySync}>{t("동기화 다시 시도")}</button>}
        <label htmlFor="record-delete-confirmation">{t("삭제하려면 기록 제목 “{title}”을 입력하세요.", { title: record.title })}</label>
        <input id="record-delete-confirmation" name="deleteConfirmation" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.currentTarget.value)} placeholder={record.title} />
        <button className={styles.dangerButton} type="button" disabled={isDeleting || deleteConfirmation !== record.title} onClick={onDelete}>{t("복구 가능 상태로 삭제")}</button>
      </section>
    </details>
  </article>;
}
