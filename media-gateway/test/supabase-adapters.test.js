import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compileGlossaryDocumentV1,
  getBuiltInGlossary,
  mergeCompiledGlossariesV1,
} from "../../packages/caption-core/index.js";

import {
  SupabaseFloorController,
  SupabaseHostAuthorizer,
  SupabaseLivePublisher,
  SupabasePinnedGlossaryLoader,
  SupabaseViewerAuthorizer,
} from "../src/supabase-adapters.js";

const claims = { role: "HOST", sub: "host-1", sessionId: "session-1" };
const settings = {
  sessionId: "session-1",
  version: 7,
  sessionType: "meeting",
  outputMode: "captions_audio",
  voiceProvider: "gemini",
  maxViewers: 24,
  glossaryPack: "hotel",
  languages: ["ko", "en"],
};

function pinnedGlossaryDocument() {
  return {
    schemaVersion: 1,
    name: "Session terms",
    domain: "Commercial real estate",
    sourceLanguage: "en",
    targetLanguages: ["ko"],
    terms: [{
      id: "noi",
      source: "Net Operating Income",
      translations: { ko: "순영업소득" },
      aliases: ["NOI"],
      pronunciation: null,
      doNotTranslate: false,
      forbiddenTranslations: [],
      context: "earnings",
      examples: [],
      tags: ["finance"],
      priority: 90,
      provenance: { kind: "manual", label: null },
    }],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    version: 4,
  };
}

function compatibleHostGlossaryDocument() {
  return {
    ...pinnedGlossaryDocument(),
    name: "Host terminology",
    sourceLanguage: "ko",
    targetLanguages: ["en"],
    terms: [{
      ...pinnedGlossaryDocument().terms[0],
      id: "host-session-term",
      source: "세션 전용 용어",
      translations: { en: "session-only term" },
      aliases: [],
    }],
  };
}

test("pinned glossary loader preserves a single v2 host document version and fingerprint", async () => {
  const document = pinnedGlossaryDocument();
  const verified = compileGlossaryDocumentV1(document);
  const requests = [];
  const abortController = new AbortController();
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn(url, init) {
      requests.push({ url, init });
      return Response.json([{
        session_id: "session-1",
        ordinal: 1,
        source_kind: "host",
        source_id: "11111111-1111-4111-8111-111111111111",
        document_version: 4,
        fingerprint: verified.fingerprint,
        glossary_document: document,
      }]);
    },
  });

  const compiled = await loader.load("session-1", { signal: abortController.signal });

  assert.deepEqual(compiled, verified);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://dev-ref.supabase.co/rest/v1/rpc/read_live_session_pinned_glossaries_v2");
  assert.equal(requests[0].init.cache, "no-store");
  assert.equal(requests[0].init.signal, abortController.signal);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { p_live_session_id: "session-1" });
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer service-secret");
});

test("pinned glossary loader resolves built-ins locally and merges them with host pins in ordinal order", async () => {
  const builtIn = getBuiltInGlossary("common_business");
  const hostDocument = compatibleHostGlossaryDocument();
  const verifiedHost = compileGlossaryDocumentV1(hostDocument);
  const expected = mergeCompiledGlossariesV1([builtIn.document, {
    ...hostDocument,
    terms: hostDocument.terms.map((term) => ({ ...term, priority: 100 })),
  }]);
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn() {
      return Response.json([{
        session_id: "session-1",
        ordinal: 1,
        source_kind: "builtin",
        source_id: "common_business",
        document_version: 1,
        fingerprint: null,
        glossary_document: null,
      }, {
        session_id: "session-1",
        ordinal: 2,
        source_kind: "host",
        source_id: "11111111-1111-4111-8111-111111111111",
        document_version: 4,
        fingerprint: verifiedHost.fingerprint,
        glossary_document: hostDocument,
      }]);
    },
  });

  assert.deepEqual(await loader.load("session-1"), expected);
});

test("host glossary terms override higher-priority built-ins during a multi-pin merge", async () => {
  const builtIn = getBuiltInGlossary("hospitality");
  const builtInTerm = builtIn.document.terms.find(
    (term) => term.priority > 50 && typeof term.translations.en === "string",
  );
  assert.ok(builtInTerm);
  const hostDocument = {
    ...compatibleHostGlossaryDocument(),
    terms: [{
      ...compatibleHostGlossaryDocument().terms[0],
      source: builtInTerm.source,
      translations: { en: "host-approved translation" },
      priority: 50,
    }],
  };
  const verifiedHost = compileGlossaryDocumentV1(hostDocument);
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn() {
      return Response.json([{
        session_id: "session-1", ordinal: 1, source_kind: "host",
        source_id: "11111111-1111-4111-8111-111111111111", document_version: 4,
        fingerprint: verifiedHost.fingerprint, glossary_document: hostDocument,
      }, {
        session_id: "session-1", ordinal: 2, source_kind: "builtin", source_id: "hospitality",
        document_version: 1, fingerprint: null, glossary_document: null,
      }]);
    },
  });

  const merged = await loader.load("session-1");
  const resolvedTerm = merged.terms.find((term) => term.source === builtInTerm.source);
  assert.equal(resolvedTerm.translations.en, "host-approved translation");
  assert.equal(resolvedTerm.priority, 100);
  assert.equal(hostDocument.terms[0].priority, 50);
  assert.equal(compileGlossaryDocumentV1(hostDocument).fingerprint, verifiedHost.fingerprint);
});

test("pinned glossary loader fails closed without RPC fallback when v2 is unavailable", async () => {
  const requests = [];
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn(url, init) {
      requests.push({ url, init });
      return Response.json({ message: "Could not find the function public.read_live_session_pinned_glossaries_v2" }, { status: 404 });
    },
  });

  await assert.rejects(loader.load("session-1"), /PINNED_GLOSSARY_READ_FAILED/u);
  assert.equal(requests.length, 1);
});

test("pinned glossary loader never falls back on an unrelated v2 read failure", async () => {
  const requests = [];
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn(url) {
      requests.push(String(url));
      return Response.json({ message: "route not found" }, { status: 404 });
    },
  });

  await assert.rejects(loader.load("session-1"), /PINNED_GLOSSARY_READ_FAILED/u);
  assert.equal(requests.length, 1);
});

test("pinned glossary loader rejects a missing-function message at a non-missing HTTP status", async () => {
  const requests = [];
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn(url) {
      requests.push(String(url));
      return Response.json({
        message: "Could not find the function public.read_live_session_pinned_glossaries_v2",
      }, { status: 503 });
    },
  });

  await assert.rejects(loader.load("session-1"), /PINNED_GLOSSARY_READ_FAILED/u);
  assert.equal(requests.length, 1);
});

test("unpinned legacy sessions resolve to an explicit empty compiled glossary", async () => {
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn() { return Response.json([]); },
  });

  assert.equal(await loader.load("session-1"), null);
});

test("pinned glossary loader fails closed on invalid v2 ordering, host identity, version, fingerprint, and extra fields", async () => {
  const document = pinnedGlossaryDocument();
  const expected = compileGlossaryDocumentV1(document);
  const validRow = {
    session_id: "session-1",
    ordinal: 1,
    source_kind: "host",
    source_id: "11111111-1111-4111-8111-111111111111",
    document_version: 4,
    fingerprint: expected.fingerprint,
    glossary_document: document,
  };
  const responses = [
    [validRow, validRow],
    [{ ...validRow, session_id: "session-2" }],
    [{ ...validRow, ordinal: 2 }],
    [{ ...validRow, source_id: "preset-1" }],
    [{ ...validRow, fingerprint: `sha256:${"f".repeat(64)}` }],
    [{ ...validRow, extra: "not-allowed" }],
    [{ ...validRow, document_version: 5 }],
    [{ ...validRow, glossary_document: { ...document, terms: [] } }],
  ];
  for (const body of responses) {
    const loader = new SupabasePinnedGlossaryLoader({
      baseUrl: "https://dev-ref.supabase.co",
      serviceRoleKey: "service-secret",
      async fetchFn() { return Response.json(body); },
    });
    await assert.rejects(loader.load("session-1"), /INVALID_PINNED_GLOSSARY_RESPONSE/u);
  }
});

test("pinned glossary loader rejects unknown, duplicated, or materialized built-in pins", async () => {
  const validBuiltIn = {
    session_id: "session-1",
    ordinal: 1,
    source_kind: "builtin",
    source_id: "common_business",
    document_version: 1,
    fingerprint: null,
    glossary_document: null,
  };
  for (const body of [
    [{ ...validBuiltIn, source_id: "unknown" }],
    [validBuiltIn, { ...validBuiltIn, ordinal: 2 }],
    [{ ...validBuiltIn, document_version: 2 }],
    [{ ...validBuiltIn, fingerprint: `sha256:${"a".repeat(64)}` }],
    [{ ...validBuiltIn, glossary_document: pinnedGlossaryDocument() }],
  ]) {
    const loader = new SupabasePinnedGlossaryLoader({
      baseUrl: "https://dev-ref.supabase.co",
      serviceRoleKey: "service-secret",
      async fetchFn() { return Response.json(body); },
    });
    await assert.rejects(loader.load("session-1"), /INVALID_PINNED_GLOSSARY_RESPONSE/u);
  }
});

test("pinned glossary loader refuses session start when selected documents have translation conflicts", async () => {
  const firstHostDocument = compatibleHostGlossaryDocument();
  const secondHostDocument = {
    ...compatibleHostGlossaryDocument(),
    name: "Conflicting host terminology",
    version: 5,
    terms: [{
      ...compatibleHostGlossaryDocument().terms[0],
      id: "conflicting-host-session-term",
      translations: { en: "conflicting session-only term" },
    }],
  };
  const verifiedFirstHost = compileGlossaryDocumentV1(firstHostDocument);
  const verifiedSecondHost = compileGlossaryDocumentV1(secondHostDocument);
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn() {
      return Response.json([{
        session_id: "session-1", ordinal: 1, source_kind: "host",
        source_id: "11111111-1111-4111-8111-111111111111", document_version: 4,
        fingerprint: verifiedFirstHost.fingerprint, glossary_document: firstHostDocument,
      }, {
        session_id: "session-1", ordinal: 2, source_kind: "host",
        source_id: "22222222-2222-4222-8222-222222222222", document_version: 5,
        fingerprint: verifiedSecondHost.fingerprint, glossary_document: secondHostDocument,
      }]);
    },
  });

  await assert.rejects(loader.load("session-1"), /INVALID_PINNED_GLOSSARY_RESPONSE/u);
});

test("pinned glossary loader caps ordered selections at five", async () => {
  const builtInIds = [
    "common_business", "ai_ax", "commercial_real_estate", "hospitality", "proper_nouns", "ko_ja_idioms",
  ];
  const loader = new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "service-secret",
    async fetchFn() {
      return Response.json(builtInIds.map((sourceId, index) => ({
        session_id: "session-1", ordinal: index + 1, source_kind: "builtin", source_id: sourceId,
        document_version: 1, fingerprint: null, glossary_document: null,
      })));
    },
  });

  await assert.rejects(loader.load("session-1"), /INVALID_PINNED_GLOSSARY_RESPONSE/u);
});

test("production replay wiring forwards the abort options to Supabase", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /replayUtterances:\s*\(sessionId, language, afterSeq, limit, options\)[\s\S]*?fetchUtterancesAfter\(sessionId, language, afterSeq, limit, options\)/u);
});

test("utterance replay forwards and observes its abort signal", async () => {
  const abortController = new AbortController();
  let observedSignal;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(_url, init) {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const replay = publisher.fetchUtterancesAfter("session-1", "ko", 0, 200, { signal: abortController.signal });
  const reason = new Error("REPLAY_ABORTED");
  abortController.abort(reason);
  await assert.rejects(replay, /REPLAY_ABORTED/u);
  assert.equal(observedSignal, abortController.signal);
});

test("atomic final timeout fails closed and latches the lane without retry", async () => {
  const delivered = [];
  const mirrored = [];
  const observedSignals = [];
  let snapshotAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    snapshotGuardTimeoutMilliseconds: 5,
    async eventFanout(_sessionId, _language, event) { delivered.push(event); },
    async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        snapshotAttempts += 1;
        observedSignals.push(init.signal);
        if (snapshotAttempts === 1) return new Promise(() => {});
      }
      return Response.json([{
        session_id: "session-1", grant_id: "grant-1", user_id: "user-1", language: "ko", authorized: true,
      }]);
    },
  });

  await assert.rejects(
    publisher.publish(
      "session-1",
      "ko",
      { type: "caption", seq: 1, isFinal: true, text: "시간 초과" },
      { onLiveEvent: async (event) => mirrored.push(event) },
    ),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  assert.equal(observedSignals[0]?.aborted, true);
  assert.deepEqual(delivered.map(({ seq, isFinal }) => ({ seq, isFinal })), [{ seq: 1, isFinal: false }]);
  assert.deepEqual(mirrored.map(({ seq, isFinal }) => ({ seq, isFinal })), [{ seq: 1, isFinal: false }]);

  await assert.rejects(
    publisher.publish(
      "session-1",
      "ko",
      { type: "caption", seq: 2, isFinal: true, text: "다음 문장" },
      { onLiveEvent: async (event) => mirrored.push(event) },
    ),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(snapshotAttempts, 1, "an ambiguous commit must never be retried automatically");
  assert.deepEqual(delivered.map(({ seq, isFinal }) => ({ seq, isFinal })), [{ seq: 1, isFinal: false }]);
  assert.deepEqual(mirrored.map(({ seq, isFinal }) => ({ seq, isFinal })), [{ seq: 1, isFinal: false }]);
});

test("locked lane reconciliation distinguishes committed and rolled-back ambiguous finals", async () => {
  for (const scenario of [
    { label: "committed", reconciledSeq: 1, nextSeq: 2 },
    { label: "rolled back", reconciledSeq: 0, nextSeq: 1 },
  ]) {
    const durableSequences = [];
    const reconciliationBodies = [];
    let shouldFailFirstFinal = true;
    const publisher = new SupabaseLivePublisher({
      baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
      async eventFanout() {}, async audioFanout() {},
      async fetchFn(url, init) {
        if (String(url).includes("persist_live_final_caption_if_active")) {
          const body = JSON.parse(String(init.body));
          durableSequences.push(body.p_seq);
          if (shouldFailFirstFinal) {
            shouldFailFirstFinal = false;
            return new Response("", { status: 503 });
          }
          return Response.json(true);
        }
        if (String(url).includes("reconcile_live_caption_lane")) {
          reconciliationBodies.push(JSON.parse(String(init.body)));
          return Response.json({ max_seq: scenario.reconciledSeq });
        }
        throw new Error("UNEXPECTED_REQUEST");
      },
    });

    await assert.rejects(
      publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
      /DURABLE_CAPTION_PERSIST_FAILED/u,
      scenario.label,
    );
    assert.equal(await publisher.reconcileCaptionLane("session-1", "ko"), scenario.reconciledSeq);
    assert.deepEqual(reconciliationBodies, [{ p_session_id: "session-1", p_language: "ko" }]);

    await publisher.publish(
      "session-1",
      "ko",
      { type: "caption", seq: scenario.nextSeq, isFinal: true, text: "after recovery" },
    );
    assert.deepEqual(durableSequences, [1, scenario.nextSeq]);
  }
});

test("failed or malformed lane reconciliation keeps the durable lane latched", async () => {
  for (const reconciliationResponse of [
    new Response("", { status: 503 }),
    Response.json({ max_seq: -1 }),
    Response.json({ max_seq: Number.MAX_SAFE_INTEGER + 1 }),
    Response.json({ max_seq: "1" }),
    Response.json([{ max_seq: 1 }]),
    Response.json({}),
  ]) {
    let durableAttempts = 0;
    const publisher = new SupabaseLivePublisher({
      baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
      async eventFanout() {}, async audioFanout() {},
      async fetchFn(url) {
        if (String(url).includes("persist_live_final_caption_if_active")) {
          durableAttempts += 1;
          return new Response("", { status: 503 });
        }
        if (String(url).includes("reconcile_live_caption_lane")) return reconciliationResponse;
        throw new Error("UNEXPECTED_REQUEST");
      },
    });

    await assert.rejects(
      publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
      /DURABLE_CAPTION_PERSIST_FAILED/u,
    );
    await assert.rejects(
      publisher.reconcileCaptionLane("session-1", "ko"),
      /DURABLE_CAPTION_RECONCILIATION_FAILED/u,
    );
    await assert.rejects(
      publisher.publish("session-1", "ko", { type: "caption", seq: 2, isFinal: true, text: "still blocked" }),
      /DURABLE_CAPTION_LANE_FAILED/u,
    );
    assert.equal(durableAttempts, 1, "reconciliation failure must not reopen the lane");
  }
});

test("an ordinary max-sequence read cannot clear an ambiguous durable lane", async () => {
  let durableAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        durableAttempts += 1;
        return new Response("", { status: 503 });
      }
      if (String(url).includes("/rest/v1/live_utterances?")) return Response.json([]);
      throw new Error("UNEXPECTED_REQUEST");
    },
  });

  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  assert.deepEqual(await publisher.fetchLastUtteranceSeqs("session-1", ["ko"]), { ko: 0 });
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 2, isFinal: true, text: "still blocked" }),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(durableAttempts, 1);
});

test("a hung locked reconciliation times out without reopening the durable lane", async () => {
  let reconciliationSignal;
  let durableAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    reconciliationTimeoutMilliseconds: 5,
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        durableAttempts += 1;
        return new Response("", { status: 503 });
      }
      if (String(url).includes("reconcile_live_caption_lane")) {
        reconciliationSignal = init.signal;
        return new Promise(() => {});
      }
      throw new Error("UNEXPECTED_REQUEST");
    },
  });

  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  await assert.rejects(
    publisher.reconcileCaptionLane("session-1", "ko"),
    /DURABLE_CAPTION_RECONCILIATION_FAILED/u,
  );
  assert.equal(reconciliationSignal?.aborted, true);
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 2, isFinal: true, text: "still blocked" }),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(durableAttempts, 1);
});

test("caller abort stops locked reconciliation promptly and leaves the lane latched", async () => {
  const caller = new AbortController();
  let reconciliationSignal;
  let durableAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        durableAttempts += 1;
        return new Response("", { status: 503 });
      }
      if (String(url).includes("reconcile_live_caption_lane")) {
        reconciliationSignal = init.signal;
        return new Promise(() => {});
      }
      throw new Error("UNEXPECTED_REQUEST");
    },
  });

  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  const reconciliation = publisher.reconcileCaptionLane("session-1", "ko", { signal: caller.signal });
  caller.abort(new Error("CALLER_ABORTED"));
  await assert.rejects(
    Promise.race([
      reconciliation,
      new Promise((_, reject) => setTimeout(() => reject(new Error("ABORT_WAS_NOT_PROMPT")), 100)),
    ]),
    /DURABLE_CAPTION_RECONCILIATION_FAILED/u,
  );
  assert.equal(reconciliationSignal?.aborted, true);
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 2, isFinal: true, text: "still blocked" }),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(durableAttempts, 1);
});

test("snapshot guard timeout configuration is bounded and fail-closed", () => {
  const makePublisher = (snapshotGuardTimeoutMilliseconds) => new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    snapshotGuardTimeoutMilliseconds,
    async eventFanout() {}, async audioFanout() {}, async fetchFn() { return Response.json(true); },
  });
  for (const invalid of [0, -1, 1.5, Number.NaN, 60_001]) {
    assert.throws(() => makePublisher(invalid), /INVALID_SNAPSHOT_GUARD_TIMEOUT/u);
  }
  assert.doesNotThrow(() => makePublisher(undefined));
  assert.doesNotThrow(() => makePublisher(60_000));
});

test("lane reconciliation timeout is capped at five seconds", () => {
  const makePublisher = (reconciliationTimeoutMilliseconds) => new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    reconciliationTimeoutMilliseconds,
    async eventFanout() {}, async audioFanout() {}, async fetchFn() { return Response.json(true); },
  });
  for (const invalid of [0, -1, 1.5, Number.NaN, 5_001]) {
    assert.throws(() => makePublisher(invalid), /INVALID_RECONCILIATION_TIMEOUT/u);
  }
  assert.doesNotThrow(() => makePublisher(undefined));
  assert.doesNotThrow(() => makePublisher(5_000));
});

test("new Supabase secret keys use apikey only and take precedence over legacy credentials", async () => {
  const headers = [];
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://dev-ref.supabase.co",
    supabaseApiKey: "sb_secret_primary-never-print",
    supabaseKeyType: "secret",
    serviceRoleKey: "legacy-fallback-never-print",
    async fetchFn(_url, init) {
      headers.push(new Headers(init.headers));
      return Response.json([{
        session_id: "session-1", grant_id: "grant-1", user_id: "user-1", language: "ko", authorized: true,
      }]);
    },
  });
  assert.equal(await authorizer.authorize(
    { sessionId: "session-1", grantId: "grant-1", userId: "user-1" }, "session-1", "ko",
  ), true);
  assert.equal(headers.length, 1);
  assert.equal(headers.every((value) => value.get("apikey") === "sb_secret_primary-never-print"), true);
  assert.equal(headers.every((value) => value.has("authorization") === false), true);
});

test("a JWT-shaped SUPABASE_SECRET_KEY is treated as legacy and keeps Bearer authorization", async () => {
  // Production regression 2026-07-24: the secret slot held a legacy
  // service_role JWT; sending it as apikey-only downgraded every query to
  // anon and RLS silently emptied all reads (SESSION_REVOKED for hosts,
  // GRANT_REVOKED for viewers, lost utterances).
  const jwtKey = "eyJhbGciOiJIUzI1NiJ9.legacy-jwt-body.signature";
  let headers;
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://dev-ref.supabase.co",
    supabaseApiKey: jwtKey,
    supabaseKeyType: "secret",
    async fetchFn(_url, init) {
      headers = new Headers(init.headers);
      return Response.json([{
        session_id: "session-1", grant_id: "grant-1", user_id: "user-1", language: "ko", authorized: true,
      }]);
    },
  });
  assert.equal(await authorizer.authorize(
    { sessionId: "session-1", grantId: "grant-1", userId: "user-1" }, "session-1", "ko",
  ), true);
  assert.equal(headers.get("apikey"), jwtKey);
  assert.equal(headers.get("authorization"), `Bearer ${jwtKey}`);
});

test("legacy service-role credentials temporarily retain Bearer authorization fallback", async () => {
  let headers;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "legacy-service-role",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(_url, init) {
      headers = new Headers(init.headers);
      return Response.json(true);
    },
  });
  await publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "x" });
  assert.equal(headers.get("apikey"), "legacy-service-role");
  assert.equal(headers.get("authorization"), "Bearer legacy-service-role");
});

test("Supabase adapters fail fast when neither server credential is configured", () => {
  assert.throws(
    () => new SupabaseHostAuthorizer({ baseUrl: "https://dev-ref.supabase.co" }),
    /SUPABASE_SERVER_CREDENTIAL_REQUIRED/u,
  );
});

test("host authorization strictly matches the live session configuration and expiry", async () => {
  const seen = [];
  const authorizer = new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "secret",
    async fetchFn(url, init) {
      seen.push({ url, init });
      return new Response(JSON.stringify([{
        id: "session-1", host_id: "host-1", status: "live", version: 7,
        session_type: "meeting", output_mode: "captions_audio", max_viewers: 24, glossary_pack: "hotel",
        mode: "townhall", languages: ["ko", "en"], voice_output_mode: "auto_voice",
      }]), { status: 200 });
    },
  });
  const controller = new AbortController();
  assert.equal(await authorizer.authorize(claims, settings, { signal: controller.signal, requireLive: true }), true);
  assert.match(seen[0].url, /expires_at=gt\./u);
  assert.equal(seen[0].init.signal, controller.signal);
});

test("host readiness start distinguishes preparing activation, lost-ACK replay, and exact live resume", async () => {
  let row = {
    id: "session-1", host_id: "host-1", status: "preparing", version: 7,
    session_type: "meeting", output_mode: "captions_audio", voice_provider: "gemini",
    max_viewers: 24, glossary_pack: "hotel", languages: ["ko", "en"], pinned_glossary_fingerprint: null,
  };
  const authorizer = new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() { return Response.json([row]); },
  });
  assert.deepEqual(await authorizer.authorize(claims, settings, { readinessStart: true }), {
    pinnedGlossaryFingerprint: null,
    readinessMode: "activate",
    sessionStatus: "preparing",
  });
  row = { ...row, status: "live", version: 8 };
  assert.deepEqual(await authorizer.authorize(claims, settings, { readinessStart: true }), {
    pinnedGlossaryFingerprint: null,
    readinessMode: "activate",
    sessionStatus: "live",
  });
  row = { ...row, version: 7 };
  assert.deepEqual(await authorizer.authorize(claims, settings, { readinessStart: true }), {
    pinnedGlossaryFingerprint: null,
    readinessMode: "resume-live",
    sessionStatus: "live",
  });
  row = { ...row, version: 9 };
  assert.equal(await authorizer.authorize(claims, settings, { readinessStart: true }), false);
  for (const status of ["paused", "stopped", "failed", "unknown"]) {
    row = { ...row, status, version: 7 };
    assert.equal(await authorizer.authorize(claims, settings, { readinessStart: true }), false);
  }
  row = {
    id: "session-1", host_id: "host-1", status: "preparing", version: 7,
    session_type: "meeting", output_mode: "captions_audio", voice_provider: "gemini",
    max_viewers: 24, glossary_pack: "hotel", languages: ["ko", "en"],
  };
  assert.equal(await authorizer.authorize(claims, settings, { readinessStart: true }), false);
});

test("host readiness activation calls the exact CAS once and strictly parses its result", async () => {
  const calls = [];
  const controller = new AbortController();
  const authorizer = new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn(url, init) {
      calls.push({
        url: String(url),
        // 2026-08-31 outage: this exact request went out WITHOUT a JSON
        // content type, so Node fetch defaulted to text/plain and PostgREST
        // searched for a "single unnamed text parameter" — a PGRST202 404
        // that failed every production go-live. The header is load-bearing.
        contentType: new Headers(init.headers).get("content-type"),
        body: JSON.parse(String(init.body)),
        signal: init.signal,
      });
      return Response.json([{ session_id: "session-1", status: "live", version: 8 }]);
    },
  });
  const result = await authorizer.activate(claims, {
    ...settings,
    activationKey: "11111111-1111-4111-8111-111111111111",
    gatewaySettingsFingerprint: `sha256:${"a".repeat(64)}`,
    pinnedGlossaryFingerprint: `sha256:${"b".repeat(64)}`,
  }, { signal: controller.signal });
  assert.deepEqual(result, { sessionId: "session-1", status: "live", version: 8 });
  assert.deepEqual(calls, [{
    url: "https://dev-ref.supabase.co/rest/v1/rpc/activate_live_session_after_gateway_ready_v1",
    contentType: "application/json",
    body: {
      p_session_id: "session-1", p_host_id: "host-1", p_expected_version: 7,
      p_activation_key: "11111111-1111-4111-8111-111111111111",
      p_gateway_settings_fingerprint: `sha256:${"a".repeat(64)}`,
      p_session_type: "meeting", p_output_mode: "captions_audio", p_voice_provider: "gemini",
      p_languages: ["ko", "en"], p_max_viewers: 24, p_glossary_pack: "hotel",
      p_pinned_glossary_fingerprint: `sha256:${"b".repeat(64)}`,
    },
    signal: controller.signal,
  }]);
});

test("host readiness activation fails closed on malformed, cross-session, or failed CAS responses", async () => {
  const validSettings = {
    ...settings,
    activationKey: "11111111-1111-4111-8111-111111111111",
    gatewaySettingsFingerprint: `sha256:${"a".repeat(64)}`,
    pinnedGlossaryFingerprint: `sha256:${"b".repeat(64)}`,
  };
  for (const response of [
    Response.json([]),
    Response.json([{ session_id: "session-2", status: "live", version: 8 }]),
    Response.json([{ session_id: "session-1", status: "preparing", version: 8 }]),
    Response.json([{ session_id: "session-1", status: "live", version: 8, leaked: true }]),
    Response.json({ code: "P0001", message: "GATEWAY_READINESS_CONFLICT" }, { status: 400 }),
    Response.json({ code: "HOST_ACCESS_REQUIRED", message: "redacted provider detail" }, { status: 403 }),
  ]) {
    const authorizer = new SupabaseHostAuthorizer({
      baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
      async fetchFn() { return response.clone(); },
    });
    await assert.rejects(authorizer.activate(claims, validSettings), /GATEWAY_READINESS|HOST_ACCESS_REQUIRED/u);
  }
});

test("a failed readiness activation names the HTTP status and PostgREST code in the gateway log", async (t) => {
  // 2026-08-31 incident: a stale PostgREST schema cache 404ed the activation
  // RPC and the gateway failed go-live in total silence — no Cloud Run line
  // pointed at the cause. Session config and status codes only; never the
  // response body or tokens.
  const warnings = [];
  t.mock.method(console, "warn", (line) => { warnings.push(String(line)); });
  const authorizer = new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() {
      return Response.json({ code: "PGRST202", message: "Could not find the function" }, { status: 404 });
    },
  });
  await assert.rejects(authorizer.activate(claims, {
    ...settings,
    activationKey: "11111111-1111-4111-8111-111111111111",
    gatewaySettingsFingerprint: `sha256:${"a".repeat(64)}`,
    pinnedGlossaryFingerprint: `sha256:${"b".repeat(64)}`,
  }), /GATEWAY_READINESS_FAILED/u);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[host-activate\] rejected session=session-1 http=404 code=PGRST202 mapped=GATEWAY_READINESS_FAILED/u);
});

test("host lease ignores admission-only version changes but rejects configuration mismatch", async () => {
  let row = {
    id: "session-1", host_id: "host-1", status: "live", version: 8,
    session_type: "meeting", output_mode: "captions_audio", max_viewers: 24, glossary_pack: "hotel",
    mode: "townhall", languages: ["ko", "en"], voice_output_mode: "auto_voice",
  };
  const authorizer = new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() { return new Response(JSON.stringify([row]), { status: 200 }); },
  });
  assert.equal(await authorizer.authorize(claims, settings, { requireLive: true, compareVersion: false }), true);
  row = { ...row, languages: ["ko"] };
  assert.equal(await authorizer.authorize(claims, settings, { requireLive: true, compareVersion: false }), false);
  assert.equal(await authorizer.authorize({ ...claims, sub: "other" }, settings, { requireLive: true, compareVersion: false }), false);
});

test("viewer authorization batches exact grant fences through one fail-closed RPC", async () => {
  const calls = [];
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn(url, init) {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), signal: init.signal });
      return Response.json([
        { session_id: "session-1", grant_id: "grant-1", user_id: "user-1", language: "ko", authorized: true },
        { session_id: "session-1", grant_id: "grant-2", user_id: "user-2", language: "en", authorized: false },
      ]);
    },
  });
  const controller = new AbortController();
  const requests = [
    { key: "key-1", sessionId: "session-1", grantId: "grant-1", userId: "user-1", language: "ko" },
    { key: "key-2", sessionId: "session-1", grantId: "grant-2", userId: "user-2", language: "en" },
  ];
  assert.deepEqual(await authorizer.authorizeBatch(requests, { signal: controller.signal }), new Map([
    ["key-1", true], ["key-2", false],
  ]));
  assert.deepEqual(calls, [{
    url: "https://dev-ref.supabase.co/rest/v1/rpc/authorize_live_viewer_grants_v1",
    body: { p_requests: [
      { session_id: "session-1", grant_id: "grant-1", user_id: "user-1", language: "ko" },
      { session_id: "session-1", grant_id: "grant-2", user_id: "user-2", language: "en" },
    ] },
    signal: controller.signal,
  }]);
});

test("viewer batch authorization rejects missing, cross-fenced, malformed, and extra rows", async () => {
  const request = { key: "key-1", sessionId: "session-1", grantId: "grant-1", userId: "user-1", language: "ko" };
  const valid = { session_id: "session-1", grant_id: "grant-1", user_id: "user-1", language: "ko", authorized: true };
  for (const body of [
    [],
    [{ ...valid, session_id: "session-2" }],
    [{ ...valid, authorized: "true" }],
    [{ ...valid, extra: "forbidden" }],
    [valid, valid],
  ]) {
    const denied = new SupabaseViewerAuthorizer({
      baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
      async fetchFn() { return Response.json(body); },
    });
    await assert.rejects(denied.authorizeBatch([request]), /INVALID_VIEWER_AUTHORIZATION_BATCH_RESPONSE/u);
  }
  const secondRequest = { key: "key-2", sessionId: "session-1", grantId: "grant-2", userId: "user-2", language: "en" };
  const secondRow = { session_id: "session-1", grant_id: "grant-2", user_id: "user-2", language: "en", authorized: true };
  const reordered = new SupabaseViewerAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() { return Response.json([secondRow, valid]); },
  });
  await assert.rejects(
    reordered.authorizeBatch([request, secondRequest]),
    /INVALID_VIEWER_AUTHORIZATION_BATCH_RESPONSE/u,
  );
});

test("publisher fans out captions locally and persists only through active-session RPCs", async () => {
  const calls = [];
  const events = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { events.push(args); },
    async fetchFn(url, init) {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const caption = {
    type: "caption",
    seq: 1,
    isFinal: true,
    text: "비공개",
    speaker: { speakerId: "participant:grant-1", label: "Noel Kim" },
    sourceStartedAt: "2026-07-23T00:00:00.000Z",
    sourceEndedAt: "2026-07-23T00:00:04.000Z",
    emittedAt: "2026-07-23T00:00:04.100Z",
    sourceText: "private",
    sourceLanguage: "en",
    translationStatus: "translated",
  };
  await publisher.publish("session-1", "ko", caption);
  await publisher.publish("session-1", "ko", { type: "speaker-legend", speakers: [] });

  assert.deepEqual(events.map((entry) => [entry[2].type, entry[2].isFinal]), [
    ["caption", false], ["caption", true], ["speaker-legend", undefined],
  ]);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/rest/v1/rpc/persist_live_final_caption_if_active",
    "/rest/v1/rpc/persist_session_speakers_if_active",
  ]);
  assert.equal(calls.some((call) => call.url.includes("/realtime/")), false);
  assert.equal(calls[0].body.p_participant_id, "grant-1");
  assert.equal(calls[0].body.p_source_started_at, "2026-07-23T00:00:00.000Z");
  // The original must be persisted alongside the translation, otherwise the
  // viewer's 원문보기 disclosure has nothing to reveal after a reconnect.
  assert.equal(calls[0].body.p_source_text, "private");
  assert.equal(calls[0].body.p_source_language, "en");
  assert.equal(calls[0].body.p_translation_status, "translated");
});

test("publisher removes live-only speaker headings from the exact snapshot contract", async () => {
  const calls = [];
  const liveEvents = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(_sessionId, _language, event) { liveEvents.push(event); },
    async audioFanout() {},
    async fetchFn(url, init) {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const caption = {
    type: "caption", seq: 1, sessionId: "session-1", language: "ko",
    speaker: null,
    speakerRole: "host", speakerName: "Host", speakerDepartment: "", speakerJobTitle: "",
    text: "화면용 발표자 제목은 저장 계약과 분리합니다.", isFinal: true,
    sourceText: "Keep display metadata out of persistence.", sourceLanguage: "en",
    translationStatus: "translated",
    sourceEndedAt: "2026-07-26T00:00:04.000Z", emittedAt: "2026-07-26T00:00:04.100Z",
  };

  await publisher.publish("session-1", "ko", caption);
  const durableEvent = calls[0].body.p_event;
  assert.deepEqual(
    Object.keys(durableEvent).filter((key) => key.startsWith("speaker") && key !== "speaker"),
    [],
    "the deployed snapshot RPC rejects these unknown top-level keys",
  );
  assert.equal(liveEvents[0].speakerRole, "host", "live delivery keeps the screen heading metadata");
});

test("a source-lane caption persists with no duplicated original", async () => {
  const calls = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await publisher.publish("session-1", "ko", {
    type: "caption", seq: 1, isFinal: true, text: "안녕하세요",
    origin: "source", utteranceKey: "session-1:input:1",
    speaker: null, sourceText: null, sourceLanguage: "ko",
    sourceEndedAt: "2026-07-23T00:00:04.000Z", emittedAt: "2026-07-23T00:00:04.100Z",
  });
  const combined = calls.find((call) => call.url.includes("persist_live_final_caption_if_active"));
  assert.equal(combined.body.p_source_text, null);
  assert.equal(combined.body.p_source_language, "ko");
  assert.equal(combined.body.p_origin, "source");
  assert.equal(combined.body.p_utterance_key, "session-1:input:1");
  assert.equal(combined.body.p_translation_status, "verbatim");
  assert.equal(combined.body.p_event.origin, "source");
  assert.equal(combined.body.p_event.utteranceKey, "session-1:input:1");
});

test("publisher treats a guarded RPC false result as a stopped session", async () => {
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn() { return new Response("false", { status: 200, headers: { "Content-Type": "application/json" } }); },
  });
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "x" }),
    /SESSION_STOPPED/u,
  );
});

test("host lease stays valid while the database session is paused", async () => {
  const makeAuthorizer = (status) => new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() {
      return new Response(JSON.stringify([{
        id: "session-1", host_id: "host-1", status, version: 7,
        session_type: "meeting", output_mode: "captions_audio", max_viewers: 24, glossary_pack: "hotel",
        languages: ["ko", "en"],
      }]), { status: 200 });
    },
  });
  assert.equal(await makeAuthorizer("paused").authorize(claims, settings, { requireLive: true }), true);
  assert.equal(await makeAuthorizer("stopped").authorize(claims, settings, { requireLive: true }), false);
});

test("a transient snapshot guard failure leaves only the same-seq provisional caption visible", async () => {
  const fanned = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { fanned.push(args); },
    async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) return new Response("", { status: 503 });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "차단" }),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  assert.equal(fanned.length, 1);
  assert.deepEqual(fanned[0].slice(0, 2), ["session-1", "ko"]);
  assert.equal(fanned[0][2].seq, 1);
  assert.equal(fanned[0][2].isFinal, false, "an unverified caption must never be labelled final");
});

test("final caption paints provisionally before DB and upgrades the same seq after commit", async () => {
  const delivered = [];
  let releasePersistence;
  const persistenceGate = new Promise((resolve) => { releasePersistence = resolve; });
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(_sessionId, _language, event) { delivered.push(event); },
    async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) await persistenceGate;
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const publishing = publisher.publish("session-1", "ko", {
    type: "caption", seq: 1, isFinal: true, text: "즉시 표시",
    sourceEndedAt: "2026-07-23T00:00:04.000Z", emittedAt: "2026-07-23T00:00:04.100Z",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.map(({ seq, isFinal, text }) => ({ seq, isFinal, text })), [
    { seq: 1, isFinal: false, text: "즉시 표시" },
  ]);
  releasePersistence();
  await publishing;
  assert.deepEqual(delivered.map(({ seq, isFinal, text }) => ({ seq, isFinal, text })), [
    { seq: 1, isFinal: false, text: "즉시 표시" },
    { seq: 1, isFinal: true, text: "즉시 표시" },
  ]);
});

test("a stopped snapshot guard blocks viewer and host live delivery", async () => {
  const delivered = [];
  const mirrored = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(_sessionId, _language, event) { delivered.push(event); },
    async audioFanout() {},
    async fetchFn(url) {
      const value = String(url).includes("persist_live_final_caption_if_active") ? false : true;
      return Response.json(value);
    },
  });
  await assert.rejects(
    publisher.publish(
      "session-1",
      "ko",
      { type: "caption", seq: 1, isFinal: true, text: "중단" },
      { onLiveEvent: async (event) => mirrored.push(event) },
    ),
    /SESSION_STOPPED/u,
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].isFinal, false);
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].isFinal, false);
});

test("an atomic utterance failure blocks delivery and every later final on that lane", async () => {
  const fanned = [];
  let durableAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { fanned.push(args); },
    async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        durableAttempts += 1;
        return new Response("", { status: 503 });
      }
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const caption = {
    type: "caption",
    seq: 12,
    isFinal: true,
    text: "화면에는 계속 표시",
    sourceEndedAt: "2026-07-24T00:00:04.000Z",
    emittedAt: "2026-07-24T00:00:04.100Z",
  };

  await assert.rejects(publisher.publish("session-1", "ko", caption), /DURABLE_CAPTION_PERSIST_FAILED/u);
  await assert.rejects(
    publisher.publish("session-1", "ko", { ...caption, seq: 13, text: "다음 문장" }),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(durableAttempts, 1, "recording errors must not be hidden by an automatic retry");
  assert.equal(fanned.length, 1);
  assert.equal(fanned[0][2].isFinal, false);
});

test("a combined RPC false result is treated only as a stopped session", async () => {
  const delivered = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(_sessionId, _language, event) { delivered.push(event); },
    async audioFanout() {},
    async fetchFn() { return Response.json(false); },
  });
  await assert.rejects(
    publisher.publish("session-1", "en", { type: "caption", seq: 13, isFinal: true, text: "stopped" }),
    /SESSION_STOPPED/u,
  );
  assert.deepEqual(delivered.map(({ seq, isFinal }) => ({ seq, isFinal })), [{ seq: 13, isFinal: false }]);
});

test("a genuine snapshot RPC decline still stops emission as SESSION_STOPPED", async () => {
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        return new Response("false", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "중단" }),
    /SESSION_STOPPED/u,
  );
});

test("publisher seeds per-language caption sequences from the persisted max seq", async () => {
  const requested = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      requested.push(new URL(url));
      const language = new URL(url).searchParams.get("language");
      const body = language === "eq.ko" ? JSON.stringify([{ seq: 41 }]) : JSON.stringify([]);
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.deepEqual(await publisher.fetchLastUtteranceSeqs("session-1", ["ko", "en"]), { ko: 41, en: 0 });
  assert.equal(requested.every((url) => url.pathname === "/rest/v1/live_utterances"), true);
  assert.deepEqual(requested.map((url) => [url.searchParams.get("order"), url.searchParams.get("limit")]), [
    ["seq.desc", "1"],
    ["seq.desc", "1"],
  ]);
});

test("publisher rejects malformed durable seed responses instead of treating them as an empty room", async () => {
  for (const rows of [null, {}, [{ seq: null }], [{ seq: -1 }], [{ seq: "41" }], [{ seq: 1 }, { seq: 2 }]]) {
    const publisher = new SupabaseLivePublisher({
      baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
      async eventFanout() {}, async fetchFn() { return Response.json(rows); },
    });
    await assert.rejects(publisher.fetchLastUtteranceSeqs("session-1", ["en"]), /DURABLE_CAPTION_SEED_INVALID/);
  }
});

test("publisher maps persisted utterances to replayable caption events in ascending seq order", async () => {
  let seen;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      seen = new URL(url);
      return new Response(JSON.stringify([
        { seq: 3, participant_id: "participant-1", speaker_label: "participant:participant-1", speaker_name: "김노엘", text: "셋", source_text: "three", source_language: "en", translation_status: "failed", source_ended_at: "2026-07-23T00:00:03Z", emitted_at: "2026-07-23T00:00:03.100Z" },
        { seq: 4, speaker_label: null, speaker_name: null, text: "원문", source_text: null, source_language: "ko", origin: "source", utterance_key: "session-1:input:4", source_ended_at: "2026-07-23T00:00:04Z", emitted_at: "2026-07-23T00:00:04.100Z" },
        // A row predating the provenance columns: replay must still work and
        // simply offer no original to disclose.
        { seq: 5, speaker_label: null, speaker_name: null, text: "다섯", source_ended_at: "2026-07-23T00:00:05Z", emitted_at: "2026-07-23T00:00:05.100Z" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const events = await publisher.fetchUtterancesAfter("session-1", "ko", 2);
  assert.equal(seen.searchParams.get("seq"), "gt.2");
  assert.equal(seen.searchParams.get("order"), "seq.asc");
  assert.equal(seen.searchParams.get("limit"), "200");
  assert.deepEqual(events.map((event) => [event.type, event.seq, event.text, event.isFinal]), [
    ["caption", 3, "셋", true],
    ["caption", 4, "원문", true],
    ["caption", 5, "다섯", true],
  ]);
  // The full SpeakerAssignment shape: the webapp viewer validates every field
  // and silently drops replayed captions whose speaker is partial.
  assert.deepEqual(events[0].speaker, {
    speakerId: "participant:participant-1",
    label: "김노엘",
    name: "김노엘",
    colorToken: "speaker-teal",
    voiceName: null,
    voiceStatus: "disabled",
    lastSeenAt: "2026-07-23T00:00:03.100Z",
  });
  assert.equal(events[1].speaker, null);
  assert.equal(seen.searchParams.get("select")?.includes("source_text,source_language"), true);
  assert.deepEqual(
    events.map((event) => [event.sourceText, event.sourceLanguage, event.translationStatus, event.origin, event.utteranceKey]),
    [["three", "en", "failed", undefined, undefined], [null, "ko", "verbatim", "source", "session-1:input:4"], [null, null, "verbatim", undefined, undefined]],
  );
  assert.match(seen.searchParams.get("select"), /participant_id/u);
  assert.match(seen.searchParams.get("select"), /translation_status/u);
});

test("floor controller resolves participant identity for floor broadcasts and degrades to null", async () => {
  const controller = new SupabaseFloorController({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn(url) {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/rest/v1/live_participants");
      assert.equal(parsed.searchParams.get("id"), "eq.participant-1");
      return Response.json([{ display_name: "김노엘", department: "전략기획실", job_title: "PM" }]);
    },
  });
  assert.deepEqual(await controller.getParticipant("session-1", "participant-1"), {
    name: "김노엘",
    department: "전략기획실",
    jobTitle: "PM",
  });

  const failing = new SupabaseFloorController({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() { throw new Error("network"); },
  });
  assert.equal(await failing.getParticipant("session-1", "participant-1"), null);
});

test("floor controller returns the stable participant id used by meeting records", async () => {
  const controller = new SupabaseFloorController({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "secret",
    async fetchFn() {
      return Response.json({
        ok: true,
        displayName: "Noel Kim",
        participantId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      });
    },
  });
  assert.deepEqual(await controller.take("session-1", "grant-1"), {
    ok: true,
    displayName: "Noel Kim",
    participantId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
  });
});

test("null-speaker meeting finals persist and their replay passes the viewer contract", async () => {
  const rpcBodies = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("/rpc/")) {
        rpcBodies.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([
        { seq: 7, speaker_label: "participant:p1", speaker_name: "김참가", text: "발언 기록", source_ended_at: "2026-07-24T00:00:07Z", emitted_at: "2026-07-24T00:00:07.100Z" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  // Live-translate meeting finals carry speaker:null unless the floor is held.
  await publisher.publish("session-1", "en", {
    type: "caption", seq: 6, sessionId: "session-1", language: "en",
    speaker: null, text: "Hello everyone.", isFinal: true,
    sourceEndedAt: "2026-07-24T00:00:06Z", emittedAt: "2026-07-24T00:00:06.100Z",
  });
  const utteranceCall = rpcBodies.find((call) => call.url.includes("persist_live_final_caption_if_active"));
  assert.equal(utteranceCall.body.p_text, "Hello everyone.");
  assert.equal(utteranceCall.body.p_speaker_label, null);
  assert.equal(utteranceCall.body.p_speaker_name, null);

  // Replayed rows must survive the webapp's isSpeaker/isCaptionEvent gate.
  const [replayed] = await publisher.fetchUtterancesAfter("session-1", "en", 6);
  const viewerAccepts = (value) => value.type === "caption"
    && Number.isSafeInteger(value.seq)
    && typeof value.sessionId === "string"
    && typeof value.language === "string"
    && (value.speaker === null || (
      typeof value.speaker.speakerId === "string"
      && typeof value.speaker.label === "string"
      && typeof value.speaker.colorToken === "string"
      && (typeof value.speaker.voiceName === "string" || value.speaker.voiceName === null)
      && typeof value.speaker.lastSeenAt === "string"))
    && typeof value.text === "string"
    && typeof value.isFinal === "boolean"
    && typeof value.sourceEndedAt === "string"
    && typeof value.emittedAt === "string";
  assert.equal(viewerAccepts(replayed), true, `viewer would drop replayed caption: ${JSON.stringify(replayed)}`);
});

test("participant floor captions persist with participant_id and display name", async () => {
  const rpcBodies = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("/rpc/")) rpcBodies.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await publisher.publish("session-1", "en", {
    type: "caption", seq: 9, sessionId: "session-1", language: "en",
    speaker: { speakerId: "participant:p-77", label: "김참가", name: "김참가", colorToken: "speaker-teal", voiceName: null, voiceStatus: "disabled", lastSeenAt: "2026-07-24T00:00:09Z" },
    text: "Participant speech.", isFinal: true,
    sourceEndedAt: "2026-07-24T00:00:09Z", emittedAt: "2026-07-24T00:00:09.100Z",
  });
  const call = rpcBodies.find((entry) => entry.url.includes("persist_live_final_caption_if_active"));
  assert.equal(call.body.p_participant_id, "p-77");
  assert.equal(call.body.p_speaker_name, "김참가");
  assert.equal(call.body.p_speaker_label, "participant:p-77");
});
