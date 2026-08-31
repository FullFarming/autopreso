import type { LiveRecordsStore } from "./service";
import { SupabaseLiveRecordsStore } from "./supabase-store";

let liveRecordsStoreForTests: LiveRecordsStore | null = null;

export function getLiveRecordsStore(): LiveRecordsStore {
  return liveRecordsStoreForTests ?? new SupabaseLiveRecordsStore();
}

export function setLiveRecordsStoreForTests(store: LiveRecordsStore | null): void {
  liveRecordsStoreForTests = store;
}
