import { createGoogleSheetsAccessTokenProvider, createGoogleSheetsClient } from "../google-sheets/index";
import { getGoogleSheetsConfig } from "../live/config";
import { SupabaseLiveAdmissionStore } from "../security/live-admission-store";
import { LiveSheetSyncError } from "./errors";
import { createLiveSheetSyncScheduler, type LiveSheetSyncObservation } from "./scheduler";
import { LiveSheetSyncService } from "./service";
import { SupabaseLiveSheetSyncStore } from "./store";
import { createLiveSheetSyncWorker } from "./worker";

type ScheduleAfterCommit = (callback: () => Promise<void>) => void;

interface Runtime {
  store: SupabaseLiveSheetSyncStore;
  worker: ReturnType<typeof createLiveSheetSyncWorker>;
}

let singleton: Runtime | null = null;
let runtimeForTests: Runtime | null = null;
let schedulersByWorker = new WeakMap<Runtime["worker"], WeakMap<ScheduleAfterCommit, ReturnType<typeof createLiveSheetSyncScheduler>>>();

export function getLiveSheetSyncRuntime(): Runtime {
  if (runtimeForTests) return runtimeForTests;
  if (singleton) return singleton;
  const config = getGoogleSheetsConfig();
  if (!config.enabled) throw new LiveSheetSyncError("SHEET_SYNC_NOT_CONFIGURED");
  const store = new SupabaseLiveSheetSyncStore({ workbookId: config.workbookId });
  const sheetsClient = createGoogleSheetsClient({
    workbookId: config.workbookId,
    getAccessToken: createGoogleSheetsAccessTokenProvider(config),
  });
  singleton = {
    store,
    worker: createLiveSheetSyncWorker({ store, sheetsClient, sessionIndexSheetId: config.sessionIndexSheetId }),
  };
  return singleton;
}

export function createLiveSheetRetryService(scheduleAfterCommit: ScheduleAfterCommit): LiveSheetSyncService {
  const runtime = getLiveSheetSyncRuntime();
  return new LiveSheetSyncService({
    store: runtime.store,
    rateLimitStore: new SupabaseLiveAdmissionStore(),
    scheduleAfterCommit,
    runWorker: () => runtime.worker.runNext(),
  });
}

export function scheduleLiveSheetSyncAfterCommit(
  scheduleAfterCommit: ScheduleAfterCommit,
  observe?: (observation: LiveSheetSyncObservation) => void,
): void {
  try {
    const runtime = getLiveSheetSyncRuntime();
    let schedulersByCallback = schedulersByWorker.get(runtime.worker);
    if (!schedulersByCallback) {
      schedulersByCallback = new WeakMap();
      schedulersByWorker.set(runtime.worker, schedulersByCallback);
    }
    let scheduler = schedulersByCallback.get(scheduleAfterCommit);
    if (!scheduler) {
      scheduler = createLiveSheetSyncScheduler({ worker: runtime.worker, scheduleAfterCommit, observe });
      schedulersByCallback.set(scheduleAfterCommit, scheduler);
    }
    scheduler.trigger();
  } catch {
    observe?.({ workload: "sheet_sync", resultCode: "SHEETS_SCHEDULE_FAILED" });
  }
}

export function setLiveSheetSyncRuntimeForTests(runtime: Runtime | null): void {
  runtimeForTests = runtime;
  schedulersByWorker = new WeakMap();
}
