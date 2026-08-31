import assert from "node:assert/strict";
import test from "node:test";

import { LiveMediaPipeline } from "../src/live-media-pipeline.js";
import { SupabaseLivePublisher } from "../src/supabase-adapters.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";

test("demand pipeline fences both source and caption writes with its immutable owner epoch", async () => {
  const requests = [];
  const ownerId = "00000000-0000-4000-8000-000000000003";
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://project.supabase.co", serviceRoleKey: "server-secret", async eventFanout() {},
    async fetchFn(url, init) {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json(url.includes("persist_authoritative")
        ? { ok: true, sourceUtteranceId: SOURCE_ID, sourceSeq: 9, idempotent: false } : true);
    },
  });
  const scoped = publisher.withMediaFence({ ownerId, epoch: 3 });
  assert.equal(scoped.markLive, undefined, "provider startup must not bypass readiness CAS");
  const pipeline = new LiveMediaPipeline({ sessionId: SESSION_ID, mode: "meeting", languages: ["en"],
    dependencies: { publisher: scoped, textTranslate: { async translate({ text }) { return text; } } } });
  await pipeline.acceptFinalUtterance({ speakerLabel: "host", text: "Complete source sentence", sourceLanguage: "en",
    sourceEndedAt: "2026-08-31T00:00:00.000Z" });
  const fenced = requests.filter((request) => request.url.includes("fenced_v1"));
  assert.equal(fenced.length, 2);
  for (const request of fenced) { assert.equal(request.body.p_owner_id, ownerId); assert.equal(request.body.p_epoch, 3); }
  assert.equal(fenced[1].body.p_authoritative_source_id, SOURCE_ID);
});

test("a provider final is durably recorded once before translation and every lane links the source identity", async () => {
  const operations = [];
  const persistedInputs = [];
  const events = [];
  const publisher = {
    async persistAuthoritativeSource(input) {
      operations.push("source-commit");
      persistedInputs.push(input);
      return { sourceUtteranceId: SOURCE_ID, sourceSeq: 17, idempotent: false };
    },
    async publish(_sessionId, _language, event) {
      operations.push(`publish:${event.type}:${event.language ?? "none"}`);
      events.push(event);
    },
  };
  const pipeline = new LiveMediaPipeline({
    sessionId: SESSION_ID,
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    glossaryText: "Kushiman = Cushman & Wakefield",
    dependencies: {
      publisher,
      textTranslate: {
        async translate({ text, language }) {
          operations.push(`translate:${language}`);
          return language === "en" ? "The sentence has been translated." : "번역된 문장입니다.";
        },
      },
    },
    now: () => Date.parse("2026-08-22T00:00:01.000Z"),
  });

  await pipeline.acceptFinalUtterance({
    speakerLabel: "host",
    text: "Kushiman presented.",
    sourceLanguage: "en-US",
    sourceStartOffsetMs: 0,
    sourceEndOffsetMs: 1_000,
    sourceEndedAt: "2026-08-22T00:00:01.000Z",
  });

  assert.equal(persistedInputs.length, 1);
  assert.equal(persistedInputs[0].rawText, "Kushiman presented.");
  assert.equal(persistedInputs[0].normalizedText, "Cushman & Wakefield presented.");
  assert.match(persistedInputs[0].utteranceKey, /^stt-v1:[0-9a-f]{64}$/u);
  assert.equal(/[\p{Cc}\p{Cf}<>]/u.test(persistedInputs[0].utteranceKey), false);
  assert.equal(operations[0], "source-commit");
  assert.ok(operations.indexOf("translate:ko") > operations.indexOf("source-commit"));
  assert.ok(operations.findIndex((operation) => operation.startsWith("publish:caption")) > operations.indexOf("source-commit"));

  const finals = events.filter((event) => event.type === "caption" && event.isFinal);
  assert.equal(finals.length, 2);
  assert.ok(finals.every((event) => event.authoritativeSourceId === SOURCE_ID));
  assert.ok(finals.every((event) => event.sourceSequence === 17));
  assert.ok(finals.every((event) => event.utteranceKey === persistedInputs[0].utteranceKey));
  assert.equal(finals.find((event) => event.language === "en")?.origin, "source");
});

test("an ambiguous source commit fails closed before translation, fan-out, or caption seq allocation", async () => {
  const fatalErrors = [];
  let sourceCommits = 0;
  let translations = 0;
  let publications = 0;
  const pipeline = new LiveMediaPipeline({
    sessionId: SESSION_ID,
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: {
      publisher: {
        async persistAuthoritativeSource() {
          sourceCommits += 1;
          throw new Error("AUTHORITATIVE_SOURCE_PERSIST_FAILED");
        },
        async publish() { publications += 1; },
      },
      textTranslate: { async translate() { translations += 1; return "번역됨"; } },
    },
    onFatalError: (error) => fatalErrors.push(error),
  });

  await assert.rejects(
    pipeline.acceptFinalUtterance({
      speakerLabel: "host",
      text: "First committed provider final.",
      sourceLanguage: "en-US",
      sourceEndedAt: "2026-08-22T00:00:01.000Z",
    }),
    /AUTHORITATIVE_SOURCE_PERSIST_FAILED/u,
  );
  await assert.rejects(
    pipeline.acceptFinalUtterance({
      speakerLabel: "host",
      text: "A later final must not pass the ambiguous write.",
      sourceLanguage: "en-US",
      sourceEndedAt: "2026-08-22T00:00:02.000Z",
    }),
    /AUTHORITATIVE_SOURCE_LANE_FAILED/u,
  );

  assert.equal(sourceCommits, 1);
  assert.equal(translations, 0);
  assert.equal(publications, 0);
  assert.deepEqual(pipeline.lastSequences, { ko: 0, en: 0 });
  assert.equal(fatalErrors.length, 1);
});

test("concurrent provider callbacks serialize source allocation without serializing later lane work", async () => {
  const commitKeys = [];
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const pipeline = new LiveMediaPipeline({
    sessionId: SESSION_ID,
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["en"],
    dependencies: {
      publisher: {
        async persistAuthoritativeSource(input) {
          commitKeys.push(input.utteranceKey);
          if (commitKeys.length === 1) await firstGate;
          return {
            sourceUtteranceId: commitKeys.length === 1
              ? "00000000-0000-4000-8000-000000000011"
              : "00000000-0000-4000-8000-000000000012",
            sourceSeq: commitKeys.length,
            idempotent: false,
          };
        },
        async publish(_sessionId, _language, event) { events.push(event); },
      },
      textTranslate: { async translate({ text }) { return text; } },
    },
  });
  const first = pipeline.acceptFinalUtterance({
    speakerLabel: "host",
    text: "First.",
    sourceLanguage: "en-US",
    sourceEndedAt: "2026-08-22T00:00:01.000Z",
  });
  const second = pipeline.acceptFinalUtterance({
    speakerLabel: "host",
    text: "Second.",
    sourceLanguage: "en-US",
    sourceEndedAt: "2026-08-22T00:00:02.000Z",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commitKeys.length, 1, "the second DB allocation waits behind the first provider final");
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(commitKeys.length, 2);
  assert.deepEqual(
    events.filter((event) => event.type === "caption" && event.isFinal).map((event) => event.sourceSequence),
    [1, 2],
  );
});

test("Supabase source persistence uses the service-role RPC and strictly parses its idempotent identity", async () => {
  const requests = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    async eventFanout() {},
    async audioFanout() {},
    async fetchFn(url, init) {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return Response.json({
        ok: true,
        sourceUtteranceId: SOURCE_ID,
        sourceSeq: 9,
        idempotent: true,
      });
    },
  });

  const result = await publisher.persistAuthoritativeSource({
    sessionId: SESSION_ID,
    utteranceKey: "provider:stream-1:final-9",
    rawText: "Kushiman presented.",
    normalizedText: "Cushman & Wakefield presented.",
    sourceLanguage: "en",
    speakerRole: "host",
    speakerLabel: "speaker-1",
    speakerName: "Host",
    speakerDepartment: null,
    speakerJobTitle: null,
    participantId: null,
    sourceStartedAt: "2026-08-22T00:00:00.000Z",
    sourceEndedAt: "2026-08-22T00:00:01.000Z",
    providerCommittedAt: "2026-08-22T00:00:01.100Z",
    sttProvider: "google-cloud-speech-v2",
    sttModel: null,
    translationModel: "gemini-3.7-flash",
    pipelineConfigFingerprint: null,
  });

  assert.deepEqual(result, { sourceUtteranceId: SOURCE_ID, sourceSeq: 9, idempotent: true });
  assert.equal(new URL(requests[0].url).pathname, "/rest/v1/rpc/persist_authoritative_live_source_utterance_v1");
  assert.equal(requests[0].body.p_session_id, SESSION_ID);
  assert.equal(requests[0].body.p_raw_text, "Kushiman presented.");
  assert.equal(requests[0].body.p_normalized_text, "Cushman & Wakefield presented.");
  assert.equal(requests[0].init.headers.get("apikey"), "server-secret");
  assert.equal(requests[0].init.headers.get("authorization"), "Bearer server-secret");
});

test("Supabase source persistence latches an ambiguous session write and never retries it in-process", async () => {
  let requests = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    async eventFanout() {},
    async audioFanout() {},
    async fetchFn() {
      requests += 1;
      return new Response("", { status: 503 });
    },
  });
  const input = {
    sessionId: SESSION_ID,
    utteranceKey: "provider:stream-1:final-9",
    rawText: "Raw final.",
    normalizedText: "Raw final.",
    sourceLanguage: "en",
    speakerRole: "host",
    speakerLabel: "speaker-1",
    speakerName: "Host",
    speakerDepartment: null,
    speakerJobTitle: null,
    participantId: null,
    sourceStartedAt: null,
    sourceEndedAt: "2026-08-22T00:00:01.000Z",
    providerCommittedAt: "2026-08-22T00:00:01.100Z",
    sttProvider: "google-cloud-speech-v2",
    sttModel: null,
    translationModel: "gemini-3.7-flash",
    pipelineConfigFingerprint: null,
  };

  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_PERSIST_FAILED/u);
  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_LANE_FAILED/u);
  assert.equal(requests, 1);
});

test("Supabase source persistence treats a malformed success body as an ambiguous committed write", async () => {
  let requests = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    async eventFanout() {},
    async audioFanout() {},
    async fetchFn() {
      requests += 1;
      return Response.json({ ok: true, sourceSeq: 1 });
    },
  });
  const input = {
    sessionId: SESSION_ID,
    utteranceKey: "stt-v1:8de094e17002d141a0b48ae7c1891502be547137a00779559899662480933dc4",
    rawText: "Raw final.",
    normalizedText: "Raw final.",
    sourceLanguage: "en",
    speakerRole: "host",
    speakerLabel: "speaker-1",
    speakerName: "Host",
    speakerDepartment: null,
    speakerJobTitle: null,
    participantId: null,
    sourceStartedAt: null,
    sourceEndedAt: "2026-08-22T00:00:01.000Z",
    providerCommittedAt: "2026-08-22T00:00:01.100Z",
    sttProvider: "google-cloud-speech-v2",
    sttModel: null,
    translationModel: null,
    pipelineConfigFingerprint: null,
  };

  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_PERSIST_FAILED/u);
  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_LANE_FAILED/u);
  assert.equal(requests, 1);
});

test("a replacement pipeline seed clears the source latch so the next pipeline can persist again", async () => {
  let attempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    async eventFanout() {},
    async audioFanout() {},
    async fetchFn() {
      attempts += 1;
      if (attempts === 1) return new Response("", { status: 503 });
      return Response.json({
        ok: true,
        sourceUtteranceId: SOURCE_ID,
        sourceSeq: 3,
        idempotent: false,
      });
    },
  });
  const input = {
    sessionId: SESSION_ID,
    utteranceKey: "provider:stream-1:final-9",
    rawText: "Raw final.",
    normalizedText: "Raw final.",
    sourceLanguage: "en",
    speakerRole: "host",
    speakerLabel: "speaker-1",
    speakerName: "Host",
    speakerDepartment: null,
    speakerJobTitle: null,
    participantId: null,
    sourceStartedAt: null,
    sourceEndedAt: "2026-08-22T00:00:01.000Z",
    providerCommittedAt: "2026-08-22T00:00:01.100Z",
    sttProvider: "google-cloud-speech-v2",
    sttModel: null,
    translationModel: "gemini-3.7-flash",
    pipelineConfigFingerprint: null,
  };

  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_PERSIST_FAILED/u);
  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_LANE_FAILED/u);
  assert.equal(attempts, 1);

  publisher.resetAuthoritativeSourceLane(SESSION_ID);

  const result = await publisher.persistAuthoritativeSource({
    ...input,
    utteranceKey: "provider:stream-2:final-1",
  });
  assert.deepEqual(result, { sourceUtteranceId: SOURCE_ID, sourceSeq: 3, idempotent: false });
  assert.equal(attempts, 2);
});

test("resetting one session's source latch leaves other sessions latched", async () => {
  const otherSessionId = "00000000-0000-4000-8000-00000000000f";
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    async eventFanout() {},
    async audioFanout() {},
    async fetchFn() { return new Response("", { status: 503 }); },
  });
  const input = {
    sessionId: otherSessionId,
    utteranceKey: "provider:stream-1:final-9",
    rawText: "Raw final.",
    normalizedText: "Raw final.",
    sourceLanguage: "en",
    speakerRole: "host",
    speakerLabel: "speaker-1",
    speakerName: "Host",
    speakerDepartment: null,
    speakerJobTitle: null,
    participantId: null,
    sourceStartedAt: null,
    sourceEndedAt: "2026-08-22T00:00:01.000Z",
    providerCommittedAt: "2026-08-22T00:00:01.100Z",
    sttProvider: "google-cloud-speech-v2",
    sttModel: null,
    translationModel: null,
    pipelineConfigFingerprint: null,
  };

  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_PERSIST_FAILED/u);
  publisher.resetAuthoritativeSourceLane(SESSION_ID);
  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_LANE_FAILED/u);
});
