import { LIVE_ADMISSION_PEPPER } from "../security/config";
import { opaqueIdentifier } from "../security/hmac";
import { LiveSheetSyncError } from "./errors";
import { createLiveSheetSyncScheduler } from "./scheduler";
import type { LiveSheetRetryResult } from "./store";
import type { SheetSyncRunResult } from "./worker";

interface RetryStore {
  retryOwned(hostId: string, sessionId: string): Promise<LiveSheetRetryResult>;
}

interface RateLimitStore {
  consumeRateLimit(input: {
    scope: string;
    keyHash: string;
    limit: number;
    windowSeconds: number;
  }): Promise<boolean>;
}

interface LiveSheetSyncServiceOptions {
  store: RetryStore;
  rateLimitStore: RateLimitStore;
  scheduleAfterCommit: (callback: () => Promise<void>) => void;
  runWorker: () => Promise<SheetSyncRunResult | void>;
}

export class LiveSheetSyncService {
  private readonly store: RetryStore;
  private readonly rateLimitStore: RateLimitStore;
  private readonly scheduler: ReturnType<typeof createLiveSheetSyncScheduler>;

  constructor({ store, rateLimitStore, scheduleAfterCommit, runWorker }: LiveSheetSyncServiceOptions) {
    this.store = store;
    this.rateLimitStore = rateLimitStore;
    this.scheduler = createLiveSheetSyncScheduler({
      worker: {
        async runNext() {
          const result = await runWorker();
          return result ?? { status: "idle" };
        },
      },
      scheduleAfterCommit,
    });
  }

  async retryOwned(hostId: string, sessionId: string): Promise<LiveSheetRetryResult> {
    const keyHash = await opaqueIdentifier(
      LIVE_ADMISSION_PEPPER,
      "sheet-sync-retry-host-session",
      `${hostId}\u0000${sessionId}`,
    );
    const isAllowed = await this.rateLimitStore.consumeRateLimit({
      scope: "sheet-sync-retry-host-session",
      keyHash,
      limit: 5,
      windowSeconds: 60 * 60,
    });
    if (!isAllowed) throw new LiveSheetSyncError("SHEET_SYNC_RATE_LIMITED");
    const result = await this.store.retryOwned(hostId, sessionId);
    this.scheduler.trigger();
    return result;
  }
}
