import { sourceSnapshotSchema, type SourceEvent, type SourceDraftEvent, type SourceDraftClearEvent } from "../../lib/live/source-contract";
import { readApi } from "./viewer-controller-contract";
import { formatMinuteTime } from "./meeting-minutes-model";
import type { TopicCaptionPresentation } from "./translation/topic-presentation";
import type { RecordingGap } from "../../lib/live-recap/contract";

export const VIEWER_SOURCE_HISTORY_LIMIT = 12_000;

export function presentViewerSourceEvent(source: SourceEvent): TopicCaptionPresentation {
  return {
    id: source.utteranceKey, utteranceKey: source.utteranceKey, text: source.text,
    language: source.sourceLanguage, speakerLabel: source.speaker.label,
    timestamp: formatMinuteTime(source.emittedAt), isFinal: true,
  };
}

export interface ViewerSourceDraftState {
  generation: string | null;
  revision: number;
  draft: SourceDraftEvent | null;
  retiredGenerations: readonly string[];
}

export function createViewerSourceDraftState(): ViewerSourceDraftState {
  return { generation: null, revision: 0, draft: null, retiredGenerations: [] };
}

export function reduceViewerSourceDraft(state: ViewerSourceDraftState, event: SourceDraftEvent | SourceDraftClearEvent): ViewerSourceDraftState {
  if (state.retiredGenerations.includes(event.generation)) return state;
  const isNewGeneration = state.generation !== event.generation;
  if (!isNewGeneration && event.revision < state.revision) return state;
  if (!isNewGeneration && event.type === "source-draft" && event.revision === state.revision) return state;
  return {
    generation: event.generation,
    revision: event.revision,
    draft: event.type === "source-draft" ? event : null,
    retiredGenerations: isNewGeneration && state.generation
      ? [...state.retiredGenerations, state.generation] : state.retiredGenerations,
  };
}

export function mergeViewerSourceLedger(current: readonly SourceEvent[], incoming: readonly SourceEvent[]): SourceEvent[] {
  const sessionId = current[0]?.sessionId ?? incoming[0]?.sessionId;
  const bySequence = new Map(current.map((source) => [source.sourceSeq, source]));
  for (const source of incoming) {
    if (source.sessionId !== sessionId) throw new Error("다른 회의의 원문은 합칠 수 없습니다.");
    const previous = bySequence.get(source.sourceSeq);
    if (previous && (previous.sourceUtteranceId !== source.sourceUtteranceId || previous.sessionId !== source.sessionId)) {
      throw new Error("원문 기록의 순서가 일치하지 않습니다.");
    }
    bySequence.set(source.sourceSeq, source);
  }
  return [...bySequence.values()].sort((left, right) => left.sourceSeq - right.sourceSeq).slice(-VIEWER_SOURCE_HISTORY_LIMIT);
}

export async function loadViewerSourceSnapshot(
  sessionId: string,
  afterSourceSeq: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ sources: SourceEvent[]; recordingGaps: RecordingGap[] }> {
  let cursor = afterSourceSeq;
  let sources: SourceEvent[] = [];
  const gapsById = new Map<string, RecordingGap>();
  // 2026-08-31 fix: malformed pagination must not create an unbounded database request loop.
  for (let pageCount = 0; pageCount < 128; pageCount += 1) {
    signal.throwIfAborted();
    const response = await fetcher(`/api/live-sessions/${encodeURIComponent(sessionId)}/source-snapshot?afterSourceSeq=${cursor}&pageSize=500`, {
      signal, cache: "no-store",
    });
    const page = sourceSnapshotSchema.parse(await readApi<unknown>(response));
    if (page.sessionId !== sessionId || page.sources.some((source) => source.sourceSeq <= cursor)) {
      throw new Error("원문 기록의 회의 또는 순서가 일치하지 않습니다.");
    }
    sources = mergeViewerSourceLedger(sources, page.sources);
    for (const gap of page.recordingGaps ?? []) gapsById.set(gap.id, gap);
    if (!page.hasNextPage) return { sources, recordingGaps: [...gapsById.values()] };
    if (page.nextAfterSourceSeq === null || page.nextAfterSourceSeq <= cursor) throw new Error("원문 페이지 순서를 확인할 수 없습니다.");
    cursor = page.nextAfterSourceSeq;
  }
  throw new Error("원문 기록이 너무 큽니다. 다시 연결해 주세요.");
}
