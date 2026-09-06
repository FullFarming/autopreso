import type { GoogleSheetBatchRequest } from "../google-sheets/index";
import {
  encodeSheetLiteralCell,
  normalizeSheetTabTitle,
} from "../security/sheet-projection-validation";
import { liveSheetProjectionSchema, type LiveSheetProjection } from "./types";

const SESSION_HEADERS = [
  "세션 ID", "날짜", "제목", "상태", "언어", "참여자 수", "요약 상태", "시트 동기화 상태", "세션 시트 링크",
] as const;
const PARTICIPANT_HEADERS = [
  "참여자 이메일", "회사", "부서", "직급", "참여 시각", "개인정보 동의", "개인정보 동의 시각",
  "요약 수신 동의", "요약 수신 동의 시각", "마케팅 동의", "마케팅 동의 시각", "전달 상태",
] as const;

const SESSION_STATUS = {
  scheduled: "예약", preparing: "준비", live: "진행 중", paused: "일시정지", stopped: "종료", failed: "실패",
} as const;
const SUMMARY_STATUS = {
  not_started: "미시작", pending: "대기", running: "생성 중", ready: "완료", failed: "실패",
} as const;
const SYNC_STATUS = { pending: "대기", running: "동기화 중", completed: "완료", failed: "실패" } as const;
const CONSENT_STATUS = { not_recorded: "미기록", accepted: "동의", declined: "미동의", withdrawn: "철회" } as const;
const DELIVERY_STATUS = { not_requested: "미신청", eligible: "전달 대상" } as const;

export function buildSheetBatchRequests(
  rawProjection: LiveSheetProjection,
  { sessionIndexSheetId }: { sessionIndexSheetId: number },
): GoogleSheetBatchRequest[] {
  const projection = liveSheetProjectionSchema.parse(rawProjection);
  if (!Number.isSafeInteger(sessionIndexSheetId) || sessionIndexSheetId < 0 || sessionIndexSheetId > 2_147_483_647) {
    throw new Error("INVALID_SESSION_INDEX_SHEET_ID");
  }
  const requests: GoogleSheetBatchRequest[] = [];
  if (projection.shouldCreate) {
    requests.push({ addSheet: { properties: { sheetId: projection.sheetId, title: normalizeSheetTabTitle(projection.tabTitle) } } });
  }
  requests.push(updateCellsRequest(sessionIndexSheetId, 0, 1, [row(SESSION_HEADERS)]));
  requests.push(updateCellsRequest(
    sessionIndexSheetId,
    projection.sessionIndexRow,
    projection.sessionIndexRow + 1,
    [row([
      projection.sessionId,
      projection.session.date,
      projection.session.title,
      SESSION_STATUS[projection.session.status],
      projection.session.languages.join(", "),
      projection.session.participantCount,
      SUMMARY_STATUS[projection.session.summaryState],
      SYNC_STATUS[projection.session.sheetSyncState],
      projection.session.sheetLink,
    ])],
  ));
  const participantRows = [
    row(PARTICIPANT_HEADERS),
    ...projection.participants.map((participant) => row([
      participant.email,
      participant.company,
      participant.department,
      participant.jobTitle,
      participant.joinedAt,
      CONSENT_STATUS[participant.privacy.state],
      participant.privacy.at,
      CONSENT_STATUS[participant.summaryDelivery.state],
      participant.summaryDelivery.at,
      CONSENT_STATUS[participant.marketing.state],
      participant.marketing.at,
      DELIVERY_STATUS[participant.deliveryStatus],
    ])),
  ];
  requests.push(updateCellsRequest(
    projection.sheetId,
    0,
    Math.max(projection.previousParticipantCount, projection.participants.length) + 1,
    participantRows,
  ));
  return requests;
}

function row(values: readonly (string | number | boolean | null)[]) {
  return {
    values: values.map((value) => ({
      userEnteredValue: { stringValue: encodeSheetLiteralCell(value) },
    })),
  };
}

function updateCellsRequest(sheetId: number, startRowIndex: number, endRowIndex: number, rows: unknown[]) {
  return {
    updateCells: {
      range: { sheetId, startRowIndex, endRowIndex, startColumnIndex: 0 },
      rows,
      fields: "userEnteredValue",
    },
  };
}
