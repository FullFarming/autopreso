import { LiveSecurityConfigurationError } from "../security/config";

export class LiveSessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    code: string,
    status: number,
  ) {
    super(message);
    this.name = "LiveSessionError";
    this.code = code;
    this.status = status;
  }
}

export function toLiveFailure(error: unknown): { status: number; body: { ok: false; error: string; code: string } } {
  if (error instanceof LiveSecurityConfigurationError) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "라이브 서버 연결이 아직 설정되지 않았습니다.",
        code: "SECURITY_NOT_CONFIGURED",
      },
    };
  }
  if (error instanceof LiveSessionError) {
    return { status: error.status, body: { ok: false, error: error.message, code: error.code } };
  }
  return {
    status: 500,
    body: { ok: false, error: "라이브 세션 처리 중 오류가 발생했습니다.", code: "LIVE_SESSION_ERROR" },
  };
}
