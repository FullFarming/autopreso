import type { SheetSyncRunResult } from "./worker";

interface SheetSyncWorkerLike {
  runNext(): Promise<SheetSyncRunResult>;
}

export interface LiveSheetSyncObservation {
  workload: "sheet_sync";
  resultCode: "IDLE" | "COMPLETED" | "FAILED" | "SHEETS_WORKER_FAILED" | "SHEETS_SCHEDULE_FAILED";
  safeErrorCode?: string;
}

const MAXIMUM_JOBS_PER_TRIGGER = 10;

interface SchedulerOptions {
  worker: SheetSyncWorkerLike;
  scheduleAfterCommit: (callback: () => Promise<void>) => void;
  observe?: (observation: LiveSheetSyncObservation) => void;
}

export function createLiveSheetSyncScheduler({
  worker,
  scheduleAfterCommit,
  observe = () => undefined,
}: SchedulerOptions): { trigger(): void } {
  let isScheduledOrRunning = false;
  let rerunRequested = false;

  const scheduleSlice = (): void => {
    try {
      scheduleAfterCommit(runSlice);
    } catch {
      isScheduledOrRunning = false;
      rerunRequested = false;
      observe({ workload: "sheet_sync", resultCode: "SHEETS_SCHEDULE_FAILED" });
    }
  };

  const finishOrContinue = (): void => {
    if (rerunRequested) {
      rerunRequested = false;
      scheduleSlice();
      return;
    }
    isScheduledOrRunning = false;
  };

  async function runSlice(): Promise<void> {
    for (let count = 0; count < MAXIMUM_JOBS_PER_TRIGGER; count += 1) {
      let result: SheetSyncRunResult;
      try {
        result = await worker.runNext();
      } catch {
        observe({ workload: "sheet_sync", resultCode: "SHEETS_WORKER_FAILED" });
        finishOrContinue();
        return;
      }
      if (result.status === "failed") {
        observe({ workload: "sheet_sync", resultCode: "FAILED", safeErrorCode: result.code });
        continue;
      }
      observe({ workload: "sheet_sync", resultCode: result.status === "idle" ? "IDLE" : "COMPLETED" });
      if (result.status === "idle") {
        finishOrContinue();
        return;
      }
    }
    rerunRequested = false;
    scheduleSlice();
  }

  return {
    trigger() {
      if (isScheduledOrRunning) {
        rerunRequested = true;
        return;
      }
      isScheduledOrRunning = true;
      scheduleSlice();
    },
  };
}
