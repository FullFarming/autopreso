import { z } from "zod";

export const SHEET_TAB_TITLE_MAX_CODEPOINTS = 100;
export const SHEET_CELL_MAX_CODEPOINTS = 50_000;

const FORBIDDEN_SHEET_TEXT_PATTERN = /[<>\p{Cc}\p{Cf}]/u;
const FORBIDDEN_TAB_TITLE_CHARACTERS = /[:\\/?*\[\]]/gu;
const FORMULA_PREFIX_PATTERN = /^\s*[=+@-]/u;
const SENSITIVE_JOB_KEY_PATTERN = /(?:email|participant|company|department|job.?title|transcript|summary|caption|utterance|token|secret|password|credential|url|uri|workbook|sheet.?id|provider.?message|error|user.?id|grant.?id|device.?id|host.?id)/iu;
const EMAIL_LIKE_PATTERN = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/u;
const URL_LIKE_PATTERN = /(?:https?:\/\/|wss?:\/\/|file:\/\/)/iu;
const SAFE_SHEET_ERROR_CODES = [
  "SHEETS_ABORTED",
  "SHEETS_AUTH_FAILED",
  "SHEETS_CLAIM_LEASE_EXPIRED",
  "SHEETS_CONFLICT",
  "SHEETS_FORBIDDEN",
  "SHEETS_INVALID_REQUEST",
  "SHEETS_NOT_FOUND",
  "SHEETS_PAYLOAD_TOO_LARGE",
  "SHEETS_PROVIDER_FAILED",
  "SHEETS_RATE_LIMITED",
  "SHEETS_UNAVAILABLE",
] as const;
const SAFE_SHEET_ERROR_CODE_SET = new Set<string>(SAFE_SHEET_ERROR_CODES);

export class SheetProjectionValidationError extends Error {
  readonly code = "INVALID_SHEET_PROJECTION";
  readonly status = 400;

  constructor(message = "시트 전송 정보가 올바르지 않습니다.") {
    super(message);
    this.name = "SheetProjectionValidationError";
  }
}

function boundedSheetText(value: string, maximumCodepoints: number): string {
  const normalized = value.normalize("NFC");
  if (Array.from(normalized).length > maximumCodepoints || FORBIDDEN_SHEET_TEXT_PATTERN.test(normalized)) {
    throw new SheetProjectionValidationError();
  }
  return normalized;
}

export function normalizeSheetTabTitle(value: string, collisionIndex = 1): string {
  if (typeof value !== "string"
    || !Number.isSafeInteger(collisionIndex)
    || collisionIndex < 1
    || collisionIndex > 9_999) {
    throw new SheetProjectionValidationError("시트 탭 이름이 올바르지 않습니다.");
  }
  const normalized = boundedSheetText(value, 10_000)
    .trim()
    .replace(FORBIDDEN_TAB_TITLE_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .replace(/^'+|'+$/gu, "");
  if (!normalized) throw new SheetProjectionValidationError("시트 탭 이름이 필요합니다.");
  const formulaSafe = FORMULA_PREFIX_PATTERN.test(normalized) ? `_${normalized.slice(1)}` : normalized;
  const suffix = collisionIndex === 1 ? "" : ` (${collisionIndex})`;
  const availableCodepoints = SHEET_TAB_TITLE_MAX_CODEPOINTS - Array.from(suffix).length;
  const base = Array.from(formulaSafe).slice(0, availableCodepoints).join("").trimEnd();
  if (!base) throw new SheetProjectionValidationError("시트 탭 이름이 필요합니다.");
  return `${base}${suffix}`;
}

export function encodeSheetLiteralCell(value: string | number | boolean | null): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new SheetProjectionValidationError();
  const stringValue = value === null ? "" : String(value);
  const normalized = boundedSheetText(stringValue, SHEET_CELL_MAX_CODEPOINTS);
  if (normalized.startsWith("'")) return normalized;
  return FORMULA_PREFIX_PATTERN.test(normalized) ? `'${normalized}` : normalized;
}

export function assertNoSensitiveSheetJobFields(value: unknown): void {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  let inspectedFieldCount = 0;
  while (pending.length > 0) {
    const record = pending.pop();
    if (!record || typeof record !== "object" || Array.isArray(record) || visited.has(record)) {
      throw new SheetProjectionValidationError();
    }
    visited.add(record);
    for (const [key, field] of Object.entries(record)) {
      inspectedFieldCount += 1;
      if (inspectedFieldCount > 100) throw new SheetProjectionValidationError();
      if (key === "safeErrorCode") {
        if (field !== null && (typeof field !== "string" || !SAFE_SHEET_ERROR_CODE_SET.has(field))) {
          throw new SheetProjectionValidationError("시트 작업 오류 코드가 올바르지 않습니다.");
        }
        continue;
      }
      if (SENSITIVE_JOB_KEY_PATTERN.test(key)) throw new SheetProjectionValidationError("시트 작업에는 개인정보를 넣을 수 없습니다.");
      if (typeof field === "string" && (EMAIL_LIKE_PATTERN.test(field) || URL_LIKE_PATTERN.test(field))) {
        throw new SheetProjectionValidationError("시트 작업에는 개인정보를 넣을 수 없습니다.");
      }
      if (field && typeof field === "object") pending.push(field);
    }
  }
}

export const sheetProjectionJobReferenceSchema = z.object({
  jobId: z.uuid(),
  sessionId: z.uuid(),
  projectionVersion: z.number().int().safe().min(1),
  reason: z.enum([
    "session_created",
    "session_changed",
    "session_ended",
    "participant_changed",
    "consent_changed",
    "archive_deleted",
    "archive_restored",
    "manual_retry",
    "migration_backfill",
  ]),
}).strict().superRefine((value, context) => {
  try {
    assertNoSensitiveSheetJobFields(value);
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message: error instanceof SheetProjectionValidationError ? error.message : "시트 전송 정보가 올바르지 않습니다.",
    });
  }
});
