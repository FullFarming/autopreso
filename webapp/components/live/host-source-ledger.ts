import { sourceSnapshotSchema, type SourceEvent } from "../../lib/live/source-contract";
import { mergeViewerSourceLedger } from "./viewer-source-ledger";
import { readApi } from "./viewer-controller-contract";

export function createHostSourceLedger(sessionId: string) {
  return { sessionId, sources: [] as SourceEvent[], isUnavailable: false };
}

export function mergeHostSourceLedger(state: ReturnType<typeof createHostSourceLedger>, sessionId: string, sources: readonly SourceEvent[]) {
  if (state.sessionId !== sessionId) return state;
  if (sources.some((source) => source.sessionId !== sessionId)) throw new Error("다른 회의의 원문은 합칠 수 없습니다.");
  return { ...state, sources: mergeViewerSourceLedger(state.sources, sources) };
}

export function markHostSourceUnavailable(state: ReturnType<typeof createHostSourceLedger>, sessionId: string) {
  return state.sessionId === sessionId ? { ...state, isUnavailable: true } : state;
}

export async function loadHostSourceSnapshot(sessionId: string, afterSourceSeq: number, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  let sources: SourceEvent[] = [];
  let cursor = afterSourceSeq;
  let hasRecordingGaps = false;
  for (let pageCount = 0; pageCount < 128; pageCount += 1) {
    signal.throwIfAborted();
    const response = await fetcher(`/api/live-sessions/${encodeURIComponent(sessionId)}/source-snapshot?audience=host&afterSourceSeq=${cursor}&pageSize=500`, {
      signal, cache: "no-store",
    });
    const page = sourceSnapshotSchema.parse(await readApi<unknown>(response));
    if (page.sessionId !== sessionId || page.sources.some((source) => source.sourceSeq <= cursor)) {
      throw new Error("원문 기록의 회의 또는 순서가 일치하지 않습니다.");
    }
    sources = mergeViewerSourceLedger(sources, page.sources);
    hasRecordingGaps ||= Boolean(page.recordingGaps?.length);
    if (!page.hasNextPage) return { sources, hasRecordingGaps };
    if (page.nextAfterSourceSeq === null || page.nextAfterSourceSeq <= cursor) throw new Error("원문 페이지 순서를 확인할 수 없습니다.");
    cursor = page.nextAfterSourceSeq;
  }
  throw new Error("원문 기록이 너무 큽니다. 다시 연결해 주세요.");
}
