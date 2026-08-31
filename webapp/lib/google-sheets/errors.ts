export type GoogleSheetsSafeErrorCode =
  | "SHEETS_ABORTED"
  | "SHEETS_AUTH_FAILED"
  | "SHEETS_CLAIM_LEASE_EXPIRED"
  | "SHEETS_CONFLICT"
  | "SHEETS_FORBIDDEN"
  | "SHEETS_INVALID_REQUEST"
  | "SHEETS_NOT_FOUND"
  | "SHEETS_PAYLOAD_TOO_LARGE"
  | "SHEETS_PROVIDER_FAILED"
  | "SHEETS_RATE_LIMITED"
  | "SHEETS_UNAVAILABLE";

const SAFE_MESSAGES: Record<GoogleSheetsSafeErrorCode, string> = {
  SHEETS_ABORTED: "Google Sheets 동기화 요청이 취소되었습니다.",
  SHEETS_AUTH_FAILED: "Google Sheets 서버 인증에 실패했습니다.",
  SHEETS_CLAIM_LEASE_EXPIRED: "Google Sheets 동기화 작업 시간이 만료되었습니다.",
  SHEETS_CONFLICT: "Google Sheets 탭 상태가 예상과 다릅니다.",
  SHEETS_FORBIDDEN: "Google Sheets 워크북 쓰기 권한이 없습니다.",
  SHEETS_INVALID_REQUEST: "Google Sheets 동기화 요청이 올바르지 않습니다.",
  SHEETS_NOT_FOUND: "Google Sheets 워크북을 찾을 수 없습니다.",
  SHEETS_PAYLOAD_TOO_LARGE: "Google Sheets 동기화 데이터가 너무 큽니다.",
  SHEETS_PROVIDER_FAILED: "Google Sheets 동기화에 실패했습니다.",
  SHEETS_RATE_LIMITED: "Google Sheets 요청 한도를 초과했습니다.",
  SHEETS_UNAVAILABLE: "Google Sheets 서비스를 일시적으로 사용할 수 없습니다.",
};

export class GoogleSheetsRequestError extends Error {
  readonly code: GoogleSheetsSafeErrorCode;

  constructor(code: GoogleSheetsSafeErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "GoogleSheetsRequestError";
    this.code = code;
  }
}

export function toGoogleSheetsSafeCode(error: unknown): GoogleSheetsSafeErrorCode {
  if (error instanceof GoogleSheetsRequestError) return error.code;
  return "SHEETS_PROVIDER_FAILED";
}
