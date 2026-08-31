import {
  GoogleSheetsRequestError,
  toGoogleSheetsSafeCode,
  type GoogleSheetsClient,
} from "../google-sheets/index";
import {
  assertNoSensitiveSheetJobFields,
  sheetProjectionJobReferenceSchema,
} from "../security/sheet-projection-validation";
import { buildSheetBatchRequests } from "./projection";
import {
  liveSheetProjectionSchema,
  type SheetSyncClaim,
  type SheetSyncStore,
} from "./types";

export type SheetSyncRunResult =
  | { status: "idle" }
  | { status: "completed"; jobId: string }
  | { status: "failed"; jobId: string; code: ReturnType<typeof toGoogleSheetsSafeCode> };

interface LiveSheetSyncWorkerOptions {
  store: SheetSyncStore;
  sheetsClient: GoogleSheetsClient;
  sessionIndexSheetId: number;
  timeoutMilliseconds?: number;
}

export function createLiveSheetSyncWorker({
  store,
  sheetsClient,
  sessionIndexSheetId,
  timeoutMilliseconds = 20_000,
}: LiveSheetSyncWorkerOptions): { runNext(): Promise<SheetSyncRunResult> } {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 120_000) {
    throw new Error("INVALID_SHEET_SYNC_TIMEOUT");
  }
  let inFlight: Promise<SheetSyncRunResult> | null = null;

  const execute = async (): Promise<SheetSyncRunResult> => {
    const claim = await store.claimNext();
    if (claim === null) return { status: "idle" };
    let projection;
    try {
      assertClaim(claim);
      projection = liveSheetProjectionSchema.parse(await store.readCanonicalProjection(claim));
    } catch {
      const code = "SHEETS_INVALID_REQUEST" as const;
      await store.fail(claim, code);
      return { status: "failed", jobId: claim.jobId, code };
    }
    if (projection.sessionId !== claim.sessionId || projection.projectionVersion !== claim.projectionVersion) {
      const code = "SHEETS_INVALID_REQUEST" as const;
      await store.fail(claim, code);
      return { status: "failed", jobId: claim.jobId, code };
    }
    const requests = buildSheetBatchRequests(projection, { sessionIndexSheetId });
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMilliseconds);
    try {
      await sheetsClient.batchUpdate(requests, { signal: abortController.signal });
      if (abortController.signal.aborted) throw new GoogleSheetsRequestError("SHEETS_ABORTED");
    } catch (error: unknown) {
      const code = abortController.signal.aborted ? "SHEETS_ABORTED" : toGoogleSheetsSafeCode(error);
      await store.fail(claim, code);
      return { status: "failed", jobId: claim.jobId, code };
    } finally {
      clearTimeout(timeout);
    }
    await store.complete(claim, { participantCount: projection.participants.length });
    return { status: "completed", jobId: claim.jobId };
  };

  return {
    runNext() {
      if (inFlight) return inFlight;
      const flight = execute().finally(() => {
        if (inFlight === flight) inFlight = null;
      });
      inFlight = flight;
      return flight;
    },
  };
}

function assertClaim(claim: SheetSyncClaim): void {
  const reference = {
    jobId: claim.jobId,
    sessionId: claim.sessionId,
    projectionVersion: claim.projectionVersion,
    reason: claim.reason,
  };
  sheetProjectionJobReferenceSchema.parse(reference);
  assertNoSensitiveSheetJobFields(reference);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(claim.claimToken)
    || !Number.isSafeInteger(claim.sessionIndexRow) || claim.sessionIndexRow < 1
    || !Number.isSafeInteger(claim.sheetId) || claim.sheetId < 1 || claim.sheetId > 2_147_483_647
    || typeof claim.tabTitle !== "string" || claim.tabTitle.length < 1
    || typeof claim.shouldCreate !== "boolean"
    || !Number.isSafeInteger(claim.previousParticipantCount) || claim.previousParticipantCount < 0
    || claim.workbookRefVersion !== 1) {
    throw new Error("INVALID_SHEET_SYNC_CLAIM");
  }
}
