export type LiveSheetSyncErrorCode =
  | "LIVE_RECORD_NOT_FOUND"
  | "SHEET_SYNC_NOT_CONFIGURED"
  | "SHEET_SYNC_RATE_LIMITED"
  | "SHEET_SYNC_RETRY_CONFLICT"
  | "SHEET_SYNC_RETRY_NOT_AVAILABLE"
  | "SHEET_SYNC_STORE_UNAVAILABLE";

const MESSAGES: Record<LiveSheetSyncErrorCode, string> = {
  LIVE_RECORD_NOT_FOUND: "라이브콜 기록을 찾을 수 없습니다.",
  SHEET_SYNC_NOT_CONFIGURED: "Google Sheets 동기화가 설정되지 않았습니다.",
  SHEET_SYNC_RATE_LIMITED: "시트 동기화 재시도 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  SHEET_SYNC_RETRY_CONFLICT: "이미 시트 동기화 작업이 대기 중입니다.",
  SHEET_SYNC_RETRY_NOT_AVAILABLE: "다시 시도할 수 있는 시트 동기화 작업이 없습니다.",
  SHEET_SYNC_STORE_UNAVAILABLE: "시트 동기화 저장소를 일시적으로 사용할 수 없습니다.",
};

const STATUSES: Record<LiveSheetSyncErrorCode, number> = {
  LIVE_RECORD_NOT_FOUND: 404,
  SHEET_SYNC_NOT_CONFIGURED: 503,
  SHEET_SYNC_RATE_LIMITED: 429,
  SHEET_SYNC_RETRY_CONFLICT: 409,
  SHEET_SYNC_RETRY_NOT_AVAILABLE: 409,
  SHEET_SYNC_STORE_UNAVAILABLE: 503,
};

export class LiveSheetSyncError extends Error {
  readonly code: LiveSheetSyncErrorCode;
  readonly status: number;

  constructor(code: LiveSheetSyncErrorCode) {
    super(MESSAGES[code]);
    this.name = "LiveSheetSyncError";
    this.code = code;
    this.status = STATUSES[code];
  }
}
