import { getSupabaseServerAccess, type SupabaseAdminCredential } from "../security/supabase-server-access";
import { LiveSecurityConfigurationError } from "../security/config";

export interface LiveStoreConfig {
  baseUrl: string;
  credential: SupabaseAdminCredential;
}

export interface MeetingSummaryConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMilliseconds: number;
}

export type GoogleSheetsConfig =
  | { enabled: false }
  | {
    enabled: true;
    workbookId: string;
    sessionIndexSheetId: number;
    clientEmail: string;
    privateKey: string;
  };

export const GEMINI_RECAP_MODEL = "gemini-3.6-flash";
const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 4_000;
const DEFAULT_SUMMARY_TIMEOUT_MILLISECONDS = 45_000;

export function getLiveStoreConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LiveStoreConfig {
  const { url, credential } = getSupabaseServerAccess(environment);
  return {
    baseUrl: url,
    credential,
  };
}

export function getMeetingSummaryConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MeetingSummaryConfig {
  const apiKey = environment.GEMINI_API_KEY?.trim() ?? "";
  if (!apiKey) throw new LiveSecurityConfigurationError("GEMINI_API_KEY가 설정되지 않았습니다.");
  return {
    apiKey,
    model: GEMINI_RECAP_MODEL,
    maxOutputTokens: readBoundedPositiveInteger(
      "GEMINI_SUMMARY_MAX_OUTPUT_TOKENS",
      environment.GEMINI_SUMMARY_MAX_OUTPUT_TOKENS,
      DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
      512,
      8_000,
    ),
    timeoutMilliseconds: readBoundedPositiveInteger(
      "GEMINI_SUMMARY_TIMEOUT_MILLISECONDS",
      environment.GEMINI_SUMMARY_TIMEOUT_MILLISECONDS,
      DEFAULT_SUMMARY_TIMEOUT_MILLISECONDS,
      5_000,
      120_000,
    ),
  };
}

export function getGoogleSheetsConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GoogleSheetsConfig {
  const enabledValue = environment.GOOGLE_SHEETS_SYNC_ENABLED?.trim() ?? "false";
  if (enabledValue !== "true" && enabledValue !== "false") {
    throw new LiveSecurityConfigurationError("GOOGLE_SHEETS_SYNC_ENABLED 값은 true 또는 false여야 합니다.");
  }
  if (enabledValue === "false") return { enabled: false };

  const workbookId = environment.GOOGLE_SHEETS_WORKBOOK_ID?.trim() ?? "";
  const clientEmail = environment.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  const privateKey = (environment.GOOGLE_SHEETS_PRIVATE_KEY ?? "").replaceAll("\\n", "\n").trim();
  const rawIndexSheetId = environment.GOOGLE_SHEETS_SESSION_INDEX_SHEET_ID?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{20,200}$/u.test(workbookId)) {
    throw new LiveSecurityConfigurationError("Google Sheets 워크북 ID가 설정되지 않았거나 올바르지 않습니다.");
  }
  if (!/^[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/u.test(clientEmail)) {
    throw new LiveSecurityConfigurationError("Google Sheets 서비스 계정 이메일이 올바르지 않습니다.");
  }
  if (privateKey.length > 16_384
    || !privateKey.startsWith("-----BEGIN PRIVATE KEY-----\n")
    || !privateKey.endsWith("\n-----END PRIVATE KEY-----")) {
    throw new LiveSecurityConfigurationError("Google Sheets 서비스 계정 비공개 키가 올바르지 않습니다.");
  }
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(rawIndexSheetId)) {
    throw new LiveSecurityConfigurationError("Google Sheets 세션 인덱스 시트 ID가 올바르지 않습니다.");
  }
  const sessionIndexSheetId = Number(rawIndexSheetId);
  if (!Number.isSafeInteger(sessionIndexSheetId) || sessionIndexSheetId > 2_147_483_647) {
    throw new LiveSecurityConfigurationError("Google Sheets 세션 인덱스 시트 ID가 올바르지 않습니다.");
  }
  return { enabled: true, workbookId, sessionIndexSheetId, clientEmail, privateKey };
}

function readBoundedPositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new LiveSecurityConfigurationError(`${name} 값은 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return parsed;
}
