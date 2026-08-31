import { z } from "zod";

import {
  getSupabaseServerAccess,
  supabaseAdminHeaders,
  type SupabaseAdminCredential,
} from "../security/supabase-server-access";
import { LiveSheetSyncError } from "./errors";
import type {
  LiveSheetProjection,
  SheetSyncClaim,
  SheetSyncReason,
  SheetSyncStore,
} from "./types";

interface StoreDependencies {
  baseUrl?: string;
  credential?: SupabaseAdminCredential;
  workbookId: string;
  fetchFn?: typeof fetch;
  randomUuid?: () => string;
}

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();
const plainText = (maximum: number) => z.string().refine((value) => value === value.normalize("NFC")
  && Array.from(value).length <= maximum && !/[<>\p{Cc}\p{Cf}]/u.test(value));
const reason = z.enum([
  "session_created", "session_changed", "session_ended", "participant_changed", "consent_changed",
  "archive_deleted", "archive_restored", "manual_retry", "migration_backfill",
]);
const claimRow = z.object({
  job_id: uuid,
  session_id: uuid,
  session_index_row: z.number().int().safe().min(1).max(10_000_000),
  sheet_id: z.number().int().safe().min(1).max(2_147_483_647),
  tab_title: plainText(100).min(1),
  should_create: z.boolean(),
  projection_version: z.number().int().safe().min(1),
  previous_participant_count: z.number().int().safe().min(0).max(10_000),
  workbook_ref_version: z.literal(1),
  reason,
}).strict();
const consent = z.object({
  noticeVersion: plainText(120).min(1),
  isAccepted: z.boolean(),
  acceptedAt: nullableTimestamp,
  withdrawnAt: nullableTimestamp,
  recordedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.isAccepted !== (value.acceptedAt !== null) || (value.isAccepted && value.withdrawnAt !== null)) {
    context.addIssue({ code: "custom", message: "invalid consent state" });
  }
});
const participant = z.object({
  participantId: uuid,
  email: z.email().max(254).nullable(),
  company: plainText(200).nullable(),
  department: plainText(200).nullable(),
  jobTitle: plainText(200).nullable(),
  joinedAt: timestamp,
  leftAt: nullableTimestamp,
  deliveryStatus: z.enum(["not_requested", "eligible"]),
  consents: z.object({
    privacy: consent.optional(),
    summary_delivery: consent.optional(),
    marketing: consent.optional(),
  }).strict(),
}).strict();
const projectionRow = z.object({
  session_index_row: z.number().int().safe().min(1).max(10_000_000),
  sheet_id: z.number().int().safe().min(1).max(2_147_483_647),
  tab_title: plainText(100).min(1),
  should_create: z.boolean(),
  projection_version: z.number().int().safe().min(1),
  previous_participant_count: z.number().int().safe().min(0).max(10_000),
  session_id: uuid,
  session_date: z.iso.date(),
  session_title: plainText(500).min(1),
  session_status: z.enum(["scheduled", "preparing", "live", "paused", "stopped", "failed"]),
  summary_state: z.enum(["not_started", "pending", "running", "ready", "failed"]),
  languages: z.array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{4})?$/u)).min(1).max(20),
  archived_at: nullableTimestamp,
  archive_deleted_at: nullableTimestamp,
  participant_count: z.number().int().safe().min(0).max(10_000),
  participants: z.array(participant).max(10_000),
}).strict();
const retryRow = z.object({
  projection_version: z.number().int().safe().min(1),
  state: z.literal("pending"),
}).strict();

export interface LiveSheetRetryResult {
  projectionVersion: number;
  state: "pending";
}

export class SupabaseLiveSheetSyncStore implements SheetSyncStore {
  private readonly baseUrl: string;
  private readonly credential: SupabaseAdminCredential;
  private readonly workbookId: string;
  private readonly fetchFn: typeof fetch;
  private readonly randomUuid: () => string;

  constructor(dependencies: StoreDependencies) {
    const access = dependencies.baseUrl && dependencies.credential
      ? { url: dependencies.baseUrl, credential: dependencies.credential }
      : getSupabaseServerAccess();
    assertTrustedSupabaseOrigin(access.url);
    if (!/^[A-Za-z0-9_-]{20,200}$/u.test(dependencies.workbookId)) throw unavailable();
    this.baseUrl = access.url;
    this.credential = access.credential;
    this.workbookId = dependencies.workbookId;
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.randomUuid = dependencies.randomUuid ?? crypto.randomUUID;
  }

  async claimNext(): Promise<SheetSyncClaim | null> {
    const claimToken = uuid.parse(this.randomUuid());
    const body = await this.request("claim_live_sheet_sync_job_v1", { p_claim_token: claimToken });
    if (!Array.isArray(body) || body.length > 1) throw unavailable();
    if (body.length === 0) return null;
    const row = parseOrUnavailable(claimRow, body[0]);
    return {
      jobId: row.job_id,
      claimToken,
      sessionId: row.session_id,
      sessionIndexRow: row.session_index_row,
      sheetId: row.sheet_id,
      tabTitle: row.tab_title,
      shouldCreate: row.should_create,
      projectionVersion: row.projection_version,
      previousParticipantCount: row.previous_participant_count,
      workbookRefVersion: row.workbook_ref_version,
      reason: row.reason as SheetSyncReason,
    };
  }

  async readCanonicalProjection(claim: SheetSyncClaim): Promise<LiveSheetProjection> {
    const body = await this.request("read_live_sheet_projection_v1", {
      p_job_id: claim.jobId,
      p_claim_token: claim.claimToken,
    });
    const row = parseSingle(body, projectionRow);
    if (row.session_id !== claim.sessionId || row.session_index_row !== claim.sessionIndexRow
      || row.sheet_id !== claim.sheetId || row.tab_title !== claim.tabTitle
      || row.should_create !== claim.shouldCreate || row.projection_version !== claim.projectionVersion
      || row.previous_participant_count !== claim.previousParticipantCount
      || row.participant_count !== row.participants.length) throw unavailable();
    return {
      sessionId: row.session_id,
      projectionVersion: row.projection_version,
      sessionIndexRow: row.session_index_row,
      sheetId: row.sheet_id,
      tabTitle: row.tab_title,
      shouldCreate: row.should_create,
      previousParticipantCount: row.previous_participant_count,
      session: {
        date: row.session_date,
        title: row.session_title,
        status: row.session_status,
        languages: row.languages,
        participantCount: row.participant_count,
        summaryState: row.summary_state,
        sheetSyncState: "running",
        sheetLink: `https://docs.google.com/spreadsheets/d/${this.workbookId}/edit#gid=${row.sheet_id}`,
      },
      participants: row.participants.map((value) => ({
        email: value.email,
        company: value.company,
        department: value.department,
        jobTitle: value.jobTitle,
        joinedAt: value.joinedAt,
        privacy: projectConsent(value.consents.privacy),
        summaryDelivery: projectConsent(value.consents.summary_delivery),
        marketing: projectConsent(value.consents.marketing),
        deliveryStatus: value.deliveryStatus,
      })),
    };
  }

  async complete(claim: SheetSyncClaim, result: { participantCount: number }): Promise<void> {
    const body = await this.request("complete_live_sheet_sync_job_v1", {
      p_job_id: claim.jobId,
      p_claim_token: claim.claimToken,
      p_projection_version: claim.projectionVersion,
      p_participant_count: result.participantCount,
    });
    if (body !== true) throw unavailable();
  }

  async fail(claim: SheetSyncClaim, code: Parameters<SheetSyncStore["fail"]>[1]): Promise<void> {
    const body = await this.request("fail_live_sheet_sync_job_v1", {
      p_job_id: claim.jobId,
      p_claim_token: claim.claimToken,
      p_safe_error_code: code,
    });
    if (body !== true) throw unavailable();
  }

  async retryOwned(hostId: string, sessionId: string): Promise<LiveSheetRetryResult> {
    const body = await this.request("retry_live_sheet_sync_job_v1", {
      p_session_id: uuid.parse(sessionId),
      p_host_id: hostId,
    });
    const row = parseSingle(body, retryRow);
    return { projectionVersion: row.projection_version, state: row.state };
  }

  private async request(rpcName: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/rest/v1/rpc/${rpcName}`, {
        method: "POST",
        headers: { ...supabaseAdminHeaders(this.credential), "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) throw await mapRpcFailure(response);
    try {
      return await response.json() as unknown;
    } catch {
      throw unavailable();
    }
  }
}

function projectConsent(value: z.infer<typeof consent> | undefined) {
  if (!value) return { state: "not_recorded" as const, at: null };
  if (value.isAccepted) return { state: "accepted" as const, at: value.acceptedAt ?? value.recordedAt };
  if (value.withdrawnAt) return { state: "withdrawn" as const, at: value.withdrawnAt };
  return { state: "declined" as const, at: value.recordedAt };
}

function parseSingle<T>(body: unknown, schema: z.ZodType<T>): T {
  if (!Array.isArray(body) || body.length !== 1) throw unavailable();
  return parseOrUnavailable(schema, body[0]);
}

function parseOrUnavailable<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

async function mapRpcFailure(response: Response): Promise<LiveSheetSyncError> {
  let message = "";
  try {
    const value: unknown = await response.json();
    if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
      message = value.message.slice(0, 500);
    }
  } catch {
    return unavailable();
  }
  if (message.includes("LIVE_SHEET_RETRY_CONFLICT")) return new LiveSheetSyncError("SHEET_SYNC_RETRY_CONFLICT");
  if (message.includes("LIVE_SHEET_RETRY_NOT_AVAILABLE")) return new LiveSheetSyncError("SHEET_SYNC_RETRY_NOT_AVAILABLE");
  if (message.includes("HOST_ACCESS_REQUIRED")) return new LiveSheetSyncError("LIVE_RECORD_NOT_FOUND");
  return unavailable();
}

function assertTrustedSupabaseOrigin(value: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/u.test(parsed.hostname)
      || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash
      || parsed.username || parsed.password) throw new Error("invalid origin");
  } catch {
    throw unavailable();
  }
}

function unavailable(): LiveSheetSyncError {
  return new LiveSheetSyncError("SHEET_SYNC_STORE_UNAVAILABLE");
}
