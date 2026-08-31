import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeViewerSourceLedger, loadViewerSourceSnapshot, createViewerSourceDraftState, reduceViewerSourceDraft } from "./viewer-source-ledger";
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
  assert.deepEqual(mergeViewerSourceLedger([source(3)], snapshot).map((event) => event.sourceSeq), [1, 2, 3]);
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
