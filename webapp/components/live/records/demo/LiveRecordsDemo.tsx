"use client";

import { useMemo, useState } from "react";
import { LiveRecordDetail, type LiveRecordDetailDataSource } from "../LiveRecordDetail";
import { RecordSummaryPanel } from "../RecordContentPanels";
import { demoOriginals, demoParticipants, demoRecord, demoRequests, demoSummary, demoRecordingGaps } from "./records-demo-fixture";
import styles from "../live-records.module.css";

export function LiveRecordsDemo({ workbookBase64 }: { workbookBase64: string }) {
  const [summaryState, setSummaryState] = useState<"ready" | "running" | "failed">("ready");
  const [failureState, setFailureState] = useState<"none" | "originals" | "recipients" | "export">("none");
  const [operationMessage, setOperationMessage] = useState("");
  const dataSource = useMemo<LiveRecordDetailDataSource>(() => ({
    async loadOriginals(sessionId, cursor = 0) {
      if (failureState === "originals") throw new Error("원문을 불러오지 못했습니다. 로컬 실패 시연입니다.");
      const items = demoOriginals.filter((item) => item.sourceSeq > cursor).slice(0, 50);
      const last = items.at(-1)?.sourceSeq ?? cursor;
      const hasNextPage = demoOriginals.some((item) => item.sourceSeq > last);
      return { sessionId, afterSourceSeq: cursor, pageSize: 50, items, hasNextPage, nextAfterSourceSeq: hasNextPage ? last : null, recordingGaps: demoRecordingGaps };
    },
    async loadRecipients() {
      if (failureState === "recipients") throw new Error("수신 신청자를 불러오지 못했습니다. 로컬 실패 시연입니다.");
      return demoRequests;
    },
    async loadExport() {
      if (failureState === "export") throw new Error("Excel 파일을 준비하지 못했습니다. 로컬 실패 시연입니다.");
      const bytes = Uint8Array.from(atob(workbookBase64), (character) => character.charCodeAt(0));
      return { blob: new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileName: "NOVA-라이브콜-로컬예시.xlsx" };
    },
  }), [failureState, workbookBase64]);

  return <main className={`live-records-route ${styles.route}`}>
    <aside className={styles.demoControls} aria-label="로컬 시연 제어">
      <strong>예시 데이터 · 로컬 시연</strong>
      <span>참여자 45명 · 수신 신청 45명 · 원문 75건 · 외부 발송 없음</span>
      <label>요약 상태<select aria-label="시연 요약 상태" value={summaryState} onChange={(event) => {
        const next = event.currentTarget.value;
        if (next === "ready" || next === "running" || next === "failed") setSummaryState(next);
      }}><option value="ready">요약 완료</option><option value="running">요약 준비 중</option><option value="failed">요약 실패</option></select></label>
      <label>실패 시나리오<select aria-label="시연 실패 시나리오" value={failureState} onChange={(event) => {
        const next = event.currentTarget.value;
        if (next === "none" || next === "originals" || next === "recipients" || next === "export") setFailureState(next);
      }}><option value="none">정상</option><option value="originals">원문 읽기 실패</option><option value="recipients">신청자 읽기 실패</option><option value="export">Excel 준비 실패</option></select></label>
      {operationMessage && <p role="status">{operationMessage}</p>}
    </aside>
    <LiveRecordDetail record={demoRecord} participants={demoParticipants} selectedLaneId="translation:ko"
      panels={[{ laneId: "translation:ko", content: <RecordSummaryPanel summary={summaryState === "ready" ? demoSummary : null}
        status={summaryState === "failed" ? "permanent_failed" : summaryState} onRefresh={() => setSummaryState("ready")} /> }]}
      onBack={() => setOperationMessage("로컬 시연 화면입니다. 실제 회의 목록으로 이동하지 않았습니다.")}
      onSelectLane={() => undefined} onRetrySync={() => setOperationMessage("외부 동기화는 실행하지 않습니다.")}
      onDelete={() => setOperationMessage("예시 데이터는 삭제하지 않습니다. 실제 데이터 변경은 없습니다.")}
      dataSource={dataSource} />
  </main>;
}
