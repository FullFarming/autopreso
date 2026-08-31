import ExcelJS from "exceljs";
import { LiveRecordsError } from "../live-records/errors";
import { EXPORT_LIMITS, type RecordExportSnapshot, type RecordingGap } from "./contract";

const MAX_CELL_UNITS = 30_000;
const MAX_EXPORTED_ROWS = 100_000;
const MAX_WORKBOOK_BYTES = 4 * 1024 * 1024;
type Cell = string | number | null;

export function splitExcelText(text: string): string[] {
  for (const character of text) {
    const codepoint = character.codePointAt(0) ?? 0;
    if (codepoint < 32 && codepoint !== 9 && codepoint !== 10 && codepoint !== 13
      || codepoint >= 0xD800 && codepoint <= 0xDFFF || codepoint === 0xFFFE || codepoint === 0xFFFF) throw invalidData();
  }
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_CELL_UNITS, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [""];
}

export async function buildLiveRecordWorkbook(snapshot: RecordExportSnapshot): Promise<Uint8Array> {
  if (snapshot.participants.length > EXPORT_LIMITS.participants || snapshot.utterances.length > EXPORT_LIMITS.utterances
    || snapshot.requests.length > EXPORT_LIMITS.requests || snapshot.summaries.length > EXPORT_LIMITS.summaries
    || snapshot.recordingGaps.length > EXPORT_LIMITS.recordingGaps) throw tooLarge();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NOVA";
  workbook.created = new Date(snapshot.generatedAt);
  const metadata = workbook.addWorksheet("회의 정보");
  const participants = workbook.addWorksheet("참여자");
  const original = workbook.addWorksheet("원문");
  const summaries = workbook.addWorksheet("AI 요약");
  const requests = workbook.addWorksheet("수신 신청자");
  const requestingParticipantIds = new Set(snapshot.requests.filter((request) => request.status === "requested").map((request) => request.participantId));

  addRows(participants, ["참가자 ID", "이름", "이메일", "회사", "부서", "직급", "첫 입장 시각", "수신 신청"], snapshot.participants.map((participant) => [
    participant.id, participant.displayName, participant.email, participant.company, participant.department, participant.jobTitle,
    participant.joinedAt, requestingParticipantIds.has(participant.id) ? "신청" : "미신청",
  ]), snapshot.snapshotId);
  const originalRows: Array<{ at: string; values: Cell[] }> = snapshot.utterances.map((utterance) => ({
    at: utterance.startedAt ?? utterance.endedAt,
    values: [utterance.id, utterance.seq, utterance.speaker, utterance.language, utterance.startedAt, utterance.endedAt, utterance.topicTitle, utterance.text],
  }));
  const gapRows: Array<{ at: string; values: Cell[] }> = [...snapshot.recordingGaps]
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    .map((gap) => ({ at: gap.startedAt, values: [
    gap.id, null, "미수집 구간", null, gap.startedAt, gap.endedAt ?? "종료 시각 미확인", gapReason(gap), "이 구간의 발언은 수집되지 않았습니다.",
  ] }));
  const mergedOriginalRows: Cell[][] = [];
  let gapIndex = 0;
  for (const utterance of originalRows) {
    // Source sequence remains authoritative even if capture clocks overlap.
    while (gapIndex < gapRows.length && Date.parse(gapRows[gapIndex].at) <= Date.parse(utterance.at)) {
      mergedOriginalRows.push(gapRows[gapIndex++].values);
    }
    mergedOriginalRows.push(utterance.values);
  }
  for (; gapIndex < gapRows.length; gapIndex += 1) mergedOriginalRows.push(gapRows[gapIndex].values);
  addRows(original, ["발언·구간 ID", "순번", "화자·구간 구분", "언어", "시작 시각", "종료 시각", "주제·미수집 사유", "발언 원문·구간 안내"], mergedOriginalRows, snapshot.snapshotId);
  const summaryRows = snapshot.summaries.flatMap((summary) => {
    const fields = summary.summary ? flattenSummary(summary.summary) : [];
    const content = fields.length ? fields : [["자료 상태", "저장된 요약 없음"]];
    return content.map(([path, value]) => [summary.language, summary.status, summary.createdAt, path, value]);
  });
  addRows(summaries, ["언어", "생성 상태", "생성 시각", "항목", "내용"], summaryRows, snapshot.snapshotId);
  addRows(requests, ["신청 ID", "참가자 ID", "이름", "이메일", "회사", "부서", "직급", "신청 시각", "고지 버전", "동의 시각", "신청 상태", "취소 시각", "수정 차수"], snapshot.requests.map((request) => [
    request.id, request.participantId, request.displayName, request.email, request.company, request.department, request.jobTitle,
    request.requestedAt, request.noticeVersion, request.consentAcceptedAt, request.status === "requested" ? "수신 신청" : "신청 취소", request.cancelledAt, request.revision,
  ]), snapshot.snapshotId);
  addRows(metadata, ["항목", "값"], [
    ["스냅샷 ID", snapshot.snapshotId], ["회의 ID", snapshot.session.id], ["회의명", snapshot.session.title],
    ["회의 상태", snapshot.session.status], ["예정 시각", snapshot.session.scheduledAt], ["실제 종료 시각", snapshot.session.endedAt],
    ["내보내기 기준 시각", snapshot.generatedAt], ["시간대", "각 ISO 시각에 포함된 UTC offset 기준"],
    ["참여자 수", snapshot.participants.length], ["원문 발언 수", snapshot.utterances.length], ["요약 언어 수", snapshot.summaries.length],
    ["미수집 구간 수", snapshot.recordingGaps.length],
    ["수신 신청 기록 수", snapshot.requests.length], ["포함 범위", "이 회의에서 저장된 전체 기록. 화면 필터와 페이지는 적용하지 않음."],
    ["원문 범위 주의", "실제로 수집·저장된 발언만 포함. 미수집 구간의 발언은 복원하거나 추정하지 않음."],
    ["신청 상태 안내", "이메일 수신 신청 기록이며 실제 발송을 의미하지 않음."],
    ["분할 안내", "긴 내용은 같은 식별자를 가진 연속 행으로 보존. 분할 열의 순서대로 이어 읽기."],
    ...snapshot.recordingGaps.flatMap((gap, index) => [
      [`미수집 구간 ${index + 1} / ID`, gap.id], [`미수집 구간 ${index + 1} / 시작`, gap.startedAt],
      [`미수집 구간 ${index + 1} / 종료`, gap.endedAt ?? "종료 시각 미확인"], [`미수집 구간 ${index + 1} / 사유`, gapReason(gap)],
    ]),
  ], snapshot.snapshotId);
  if (workbook.worksheets.reduce((total, sheet) => total + sheet.rowCount, 0) > MAX_EXPORTED_ROWS) throw tooLarge();
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column) => { column.width = 24; });
    sheet.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
  }
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) throw tooLarge();
  return bytes;
}

function gapReason(gap: RecordingGap): string {
  const labels: Record<RecordingGap["reason"], string> = {
    no_viewers: "참여자 없음", host_unavailable: "진행자 음성 연결 없음", media_failed: "음성 처리 연결 중단",
  };
  return `${labels[gap.reason]} (${gap.reason})`;
}

function addRows(sheet: ExcelJS.Worksheet, headers: string[], rows: Cell[][], snapshotId: string): void {
  sheet.addRow([...headers, "분할", "스냅샷 ID"]);
  for (const row of rows) {
    const chunks = row.map((value) => typeof value === "string" ? splitExcelText(value) : [value ?? ""]);
    const count = Math.max(1, ...chunks.map((chunk) => chunk.length));
    if (sheet.rowCount + count > MAX_EXPORTED_ROWS) throw tooLarge();
    for (let index = 0; index < count; index += 1) {
      // String cell values never become Excel formulas, hyperlinks, or external relationships.
      sheet.addRow([...chunks.map((chunk) => {
        const value = chunk.length === 1 ? chunk[0] : chunk[index] ?? "";
        return typeof value === "string" ? encodeSpreadsheetText(value) : value;
      }), `${index + 1}/${count}`, snapshotId]);
    }
  }
}

function encodeSpreadsheetText(value: string): string {
  // 2026-08-31 fix: JSZip splits UTF-16 strings at unsafe surrogate boundaries.
  // SpreadsheetML escapes keep astral characters intact; escape literal tokens
  // first so user text resembling an escape is also preserved on import.
  return value.replace(/_x[0-9a-fA-F]{4}_/gu, (token) => `_x005F_${token.slice(1)}`)
    .replace(/[\uD800-\uDFFF]/g, (unit) => `_x${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`);
}

function flattenSummary(value: unknown, path = "", depth = 0): string[][] {
  if (depth > 20) throw invalidData();
  if (value === null) return [[path, ""]];
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return [[path, String(value)]];
  if (typeof value !== "object") throw invalidData();
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value);
  if (entries.length > MAX_EXPORTED_ROWS) throw tooLarge();
  return entries.flatMap(([key, item]) => flattenSummary(item, path ? `${path} / ${key}` : key, depth + 1));
}

function tooLarge(): LiveRecordsError {
  return new LiveRecordsError("회의 기록이 내보내기 용량 제한을 초과했습니다. 일부만 저장하지 않았습니다.", "EXPORT_TOO_LARGE", 413);
}

function invalidData(): LiveRecordsError {
  return new LiveRecordsError("내보낼 회의 기록 형식을 확인할 수 없습니다.", "EXPORT_INVALID_DATA", 502);
}
