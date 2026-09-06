import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { mergeViewerSourceLedger, loadViewerSourceSnapshot, createViewerSourceDraftState, reduceViewerSourceDraft } from "./viewer-source-ledger";
import { ApiRequestError, settleRequest } from "./viewer-controller-contract";
import { isSummaryEmptyCode, isSummaryReadRetryable } from "./useHostSummaryLifecycle";
import type { SourceEvent, SourceDraftEvent } from "../../lib/live/source-contract";

const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const source = (sequence: number, language = "ko"): SourceEvent => ({
  type: "source", sessionId, sourceUtteranceId: `0192d0f4-9f72-7a36-91f5-${String(sequence).padStart(12, "0")}`,
  sourceSeq: sequence, utteranceKey: `source:${sequence}`, text: sequence === 2 ? "Second English" : "같은 말",
  sourceLanguage: language, languageObservation: null, speaker: { role: "host", label: "발표자" },
  isFinal: true, sourceStartedAt: null, sourceEndedAt: "2026-08-31T01:00:00Z", emittedAt: "2026-08-31T01:00:00Z",
});

test("ephemeral source drafts reject older revisions and retired pipelines without inventing canonical IDs", () => {
  const generation = "0192d0f4-9f72-7a36-91f5-6a76ef736f43";
  const draft: SourceDraftEvent = { type: "source-draft", sessionId, generation, revision: 1, text: "작성 중",
    sourceLanguage: "ko", languageObservation: { state: "single", languageCode: "ko", providerLanguageCode: "ko", evidence: "provider", languages: ["ko"] },
    speaker: { role: "host", label: "발표자" }, emittedAt: "2026-08-31T01:00:00Z" };
  let state = reduceViewerSourceDraft(createViewerSourceDraftState(), draft);
  state = reduceViewerSourceDraft(state, { ...draft, revision: 2, text: "더 새로운 작성 중" });
  assert.equal(reduceViewerSourceDraft(state, { type: "source-draft-clear", sessionId, generation, revision: 1 }), state);
  state = reduceViewerSourceDraft(state, { type: "source-draft-clear", sessionId, generation, revision: 2 });
  assert.equal(state.draft, null);
  assert.equal(reduceViewerSourceDraft(state, { ...draft, revision: 2 }), state, "cleared draft cannot return late");
  const next = reduceViewerSourceDraft(state, { ...draft, generation: "0192d0f4-9f72-7a36-91f5-6a76ef736f44" });
  assert.equal(reduceViewerSourceDraft(next, { ...draft, revision: 99 }), next, "retired pipeline cannot overwrite a new pipeline");
  assert.equal("sourceSeq" in (next.draft ?? {}), false);
  assert.equal("utteranceKey" in (next.draft ?? {}), false);
});

test("canonical source orders interleaved languages by source sequence and preserves actual repetitions", () => {
  const current = [source(1), source(3)];
  const result = mergeViewerSourceLedger(current, [source(2, "en"), source(1)]);
  assert.deepEqual(result.map((event) => event.sourceSeq), [1, 2, 3]);
  assert.deepEqual(result.map((event) => event.text), ["같은 말", "Second English", "같은 말"]);
  assert.deepEqual(current.map((event) => event.sourceSeq), [1, 3]);
  assert.throws(() => mergeViewerSourceLedger(current, [{ ...source(1), sourceUtteranceId: source(2).sourceUtteranceId }]));
  assert.throws(() => mergeViewerSourceLedger(current, [{ ...source(4), sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f42" }]));
});

test("source snapshot pagination merges with concurrent websocket finals without losing older lines", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    requests.push(String(input));
    assert.equal(options?.cache, "no-store");
    const first = requests.length === 1;
    return Response.json({ ok: true, data: { sessionId, sources: first ? [source(1)] : [source(2, "en")],
      lastSourceSeq: 2, hasNextPage: first, nextAfterSourceSeq: first ? 1 : null, recordsExpiresAt: null } });
  };
  const snapshot = await loadViewerSourceSnapshot(sessionId, 0, new AbortController().signal, fetcher);
  assert.equal(requests.length, 2);
  assert.match(requests[1], /afterSourceSeq=1&pageSize=500/u);
  assert.deepEqual(mergeViewerSourceLedger([source(3)], snapshot.sources).map((event) => event.sourceSeq), [1, 2, 3]);
});

const gap = { id: "0192d0f4-9f72-7a36-91f5-6a76ef736f45", startedAt: "2026-09-01T00:00:00.000Z",
  endedAt: "2026-09-01T00:00:02.000Z", reason: "source_recording_failed" as const };

test("source snapshot retains durable recording failures with zero originals and across pages", async () => {
  const empty: typeof fetch = async () => Response.json({ ok: true, data: {
    sessionId, sources: [], lastSourceSeq: 0, hasNextPage: false, nextAfterSourceSeq: null,
    recordsExpiresAt: null, recordingGaps: [gap],
  } });
  const restored = await loadViewerSourceSnapshot(sessionId, 0, new AbortController().signal, empty);
  assert.deepEqual(restored, { sources: [], recordingGaps: [gap] });
  let calls = 0;
  const pages: typeof fetch = async () => {
    const first = ++calls === 1;
    return Response.json({ ok: true, data: { sessionId, sources: [source(calls)], lastSourceSeq: 2,
      hasNextPage: first, nextAfterSourceSeq: first ? 1 : null, recordsExpiresAt: null,
      recordingGaps: first ? [{ ...gap, endedAt: null }] : [gap] } });
  };
  const paged = await loadViewerSourceSnapshot(sessionId, 0, new AbortController().signal, pages);
  assert.deepEqual(paged.recordingGaps, [gap], "a later closed interval replaces the open copy without duplication");
  assert.deepEqual(paged.sources.map((event) => event.sourceSeq), [1, 2]);
});

test("actual viewer refresh restores a sticky source failure without discarding valid source captions", async () => {
  const viewer = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const declaration = viewer.slice(viewer.indexOf("const synchronizeSourceLedger ="), viewer.indexOf("const loadMinutes ="));
  const code = ts.transpileModule(`${declaration}\nreturn synchronizeSourceLedger;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  let hasFailure = false;
  let gaps: unknown[] = [];
  let currentSession = sessionId;
  let sources: SourceEvent[] = [];
  const snapshots: Awaited<ReturnType<typeof loadViewerSourceSnapshot>>[] = [
    { sources: [], recordingGaps: [gap] }, { sources: [source(1)], recordingGaps: [] },
  ];
  const dependencies = {
    useCallback: (callback: unknown) => callback, sourceSnapshotAbortRef: { current: null },
    setIsSourceLoading() {}, withAbortTimeout: (callback: (signal: AbortSignal) => unknown) => callback(new AbortController().signal),
    loadViewerSourceSnapshot: async () => snapshots.shift(),
    viewerSessionIdRef: { get current() { return currentSession; } },
    mergeSourceEvents: (events: SourceEvent[]) => { sources = mergeViewerSourceLedger(sources, events); },
    isSourceHydratedRef: { current: false }, setSourceError() {},
    setRecordingGaps: (value: unknown[] | ((previous: unknown[]) => unknown[])) => { gaps = typeof value === "function" ? value(gaps) : value; },
    setHasSourceRecordingFailure: (value: boolean) => { hasFailure = value; },
  };
  const synchronize = new Function(...Object.keys(dependencies), code)(...Object.values(dependencies)) as (id: string, after: number) => Promise<void>;
  await synchronize(sessionId, 0);
  assert.equal(hasFailure, true, "refresh must restore failure even when no source row was saved");
  assert.deepEqual(gaps, [gap]);
  await synchronize(sessionId, 0);
  assert.equal(hasFailure, true, "later successful source snapshots cannot erase an earlier missing interval");
  assert.deepEqual(sources, [source(1)]);
  currentSession = "0192d0f4-9f72-7a36-91f5-6a76ef736f46";
  snapshots.push({ sources: [source(2)], recordingGaps: [gap] });
  await synchronize(sessionId, 0);
  assert.deepEqual(sources, [source(1)], "old-session reads must not update the new session");
});

test("invalid session, repeated page cursor, auth failure and abort stop source snapshot reads", async () => {
  const controller = new AbortController();
  const invalid: typeof fetch = async () => Response.json({ ok: true, data: {
    sessionId, sources: [source(1)], lastSourceSeq: 1, hasNextPage: true, nextAfterSourceSeq: 1, recordsExpiresAt: null,
  } });
  await assert.rejects(loadViewerSourceSnapshot(sessionId, 1, controller.signal, invalid));
  await assert.rejects(loadViewerSourceSnapshot("0192d0f4-9f72-7a36-91f5-6a76ef736f42", 0, controller.signal, invalid));
  let calls = 0;
  const forbidden: typeof fetch = async () => { calls += 1; return Response.json({ ok: false, error: "권한 없음", code: "FORBIDDEN" }, { status: 403 }); };
  await assert.rejects(loadViewerSourceSnapshot(sessionId, 0, controller.signal, forbidden));
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(loadViewerSourceSnapshot(sessionId, 0, controller.signal, forbidden));
  assert.equal(calls, 1);
});

test("ended viewer applies source immediately while summary waits and drops obsolete language responses", async () => {
  const viewer = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const declaration = viewer.slice(viewer.indexOf("const loadMinutes ="), viewer.indexOf("// Contract C7:"));
  const code = ts.transpileModule(`${declaration}\nreturn loadMinutes;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let completeSummary: ((response: Response) => void) | undefined;
  let transcript: unknown = null; let summary: unknown = null;
  const languageRef = { current: "ko" };
  const dependencies = {
    useCallback: (callback: unknown) => callback, viewer: { session: { id: sessionId } }, isRecordsExpired: false, languageRef,
    minutesLoadGenerationRef: { current: 0 }, minutesReadAbortRef: { current: null },
    setIsMinutesLoading() {}, setSummaryRecord: (value: unknown) => { summary = value; }, setSummaryError() {}, setIsSummaryEmpty() {}, setMinutesPollingState() {},
    setTranscript: (value: unknown) => { transcript = value; }, setRecordingGaps() {}, setTranscriptTopics() {}, setMinutesEvent() {}, setIsTranscriptLoaded() {}, setTranscriptError() {},
    fetch: () => new Promise<Response>((resolve) => { completeSummary = resolve; }),
    readApi: async (response: Response) => {
      if (response.status === 404) throw new ApiRequestError("pending", "SUMMARY_NOT_READY", 404);
      if (response.status === 503) throw new ApiRequestError("failed", "SUMMARY_GENERATION_PERMANENT_FAILED", 503);
      return { summary: { title: "원래 언어 요약" }, createdAt: "2026-09-05" };
    },
    loadViewerSourceRecord: async () => ({ utterances: [{ text: "먼저 도착한 원문" }], recordingGaps: [] }),
    settleRequest, ApiRequestError, isSummaryEmptyCode, isSummaryReadRetryable,
    getSafeSummaryErrorMessage: () => "요약 확인 오류", getSafeTranscriptErrorMessage: () => "원문 확인 오류",
  };
  const load = new Function(...Object.keys(dependencies), code)(...Object.values(dependencies)) as () => Promise<boolean | "pending">;
  const pendingRead = load();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(transcript, [{ text: "먼저 도착한 원문" }]);
  assert.equal(summary, null);
  languageRef.current = "en";
  assert.ok(completeSummary); completeSummary(new Response());
  assert.equal(await pendingRead, false);
  assert.equal(summary, null, "late original-language summary must not replace the newly selected language");
  const waiting = load(); assert.ok(completeSummary); completeSummary(new Response(null, { status: 404 }));
  assert.equal(await waiting, "pending", "known generation pending must remain automatically pollable");
  const failed = load(); assert.ok(completeSummary); completeSummary(new Response(null, { status: 503 }));
  assert.equal(await failed, false, "authoritative generation failure must stop even when HTTP is 503");
});
