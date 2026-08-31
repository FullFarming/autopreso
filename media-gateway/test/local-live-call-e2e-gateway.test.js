import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeterministicLocalPipeline,
  readLocalLiveCallE2eEnvironment,
} from "../scripts/local-live-call-e2e-gateway.mjs";

const LOCAL_ENVIRONMENT = Object.freeze({
  NODE_ENV: "development",
  LIVE_ALLOW_LOCAL_SUPABASE: "true",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "local-service-role-key",
  LIVE_GATEWAY_TOKEN_SECRET: "g".repeat(32),
  LIVE_VIEWER_TOKEN_SECRET: "v".repeat(32),
});

test("local E2E gateway accepts only an explicit loopback Supabase opt-in", () => {
  const config = readLocalLiveCallE2eEnvironment(LOCAL_ENVIRONMENT);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.baseUrl, "http://127.0.0.1:54321");
  assert.equal(config.port, 18_080);
  assert.equal(config.supabaseKeyType, "legacy-service-role");

  for (const environment of [
    { ...LOCAL_ENVIRONMENT, NODE_ENV: "production" },
    { ...LOCAL_ENVIRONMENT, NODE_ENV: "staging" },
    { ...LOCAL_ENVIRONMENT, LIVE_ALLOW_LOCAL_SUPABASE: "false" },
    { ...LOCAL_ENVIRONMENT, SUPABASE_URL: "https://project-ref.supabase.co" },
    { ...LOCAL_ENVIRONMENT, SUPABASE_URL: "http://127.0.0.1:54322" },
    { ...LOCAL_ENVIRONMENT, SUPABASE_URL: "http://192.168.1.10:54321" },
    { ...LOCAL_ENVIRONMENT, SUPABASE_URL: "http://localhost:54321" },
    { ...LOCAL_ENVIRONMENT, SUPABASE_URL: "http://127.0.0.1:54321/rest/v1" },
  ]) {
    assert.throws(() => readLocalLiveCallE2eEnvironment(environment));
  }
});

test("deterministic pipeline publishes canonical KO/EN identity for HOST PCM only", async () => {
  const published = [];
  const publisher = {
    async publish(sessionId, language, event, options) {
      published.push({ sessionId, language, event, options });
    },
  };
  const onHostEvent = async () => {};
  let now = Date.parse("2026-07-26T00:00:00.000Z");
  const pipeline = createDeterministicLocalPipeline({
    settings: {
      sessionId: "00000000-0000-4000-8000-000000000001",
      sessionType: "meeting",
      outputMode: "captions",
      languages: ["ko", "en"],
    },
    initialSequences: { ko: 7, en: 11 },
    publisher,
    onHostEvent,
    now: () => now,
  });

  await pipeline.acceptAudio(Uint8Array.of(1, 0));
  now += 1_000;
  await pipeline.acceptAudio(Uint8Array.of(2, 0));

  assert.deepEqual(published.map(({ language, event }) => [
    language, event.seq, event.text, event.utteranceKey, event.speaker?.speakerId ?? null,
  ]), [
    ["ko", 8, "호스트 테스트 문장 1", "00000000-0000-4000-8000-000000000001:local-e2e:host:1", null],
    ["en", 12, "Host test sentence 1", "00000000-0000-4000-8000-000000000001:local-e2e:host:1", null],
    ["ko", 9, "호스트 테스트 문장 2", "00000000-0000-4000-8000-000000000001:local-e2e:host:2", null],
    ["en", 13, "Host test sentence 2", "00000000-0000-4000-8000-000000000001:local-e2e:host:2", null],
  ]);
  assert.equal(published[0].event.origin, "source");
  assert.equal(published[1].event.sourceText, "호스트 테스트 문장 1");
  assert.equal(published[2].event.origin, undefined);
  assert.equal(published[2].event.sourceText, "Host test sentence 2");
  assert.equal(published[2].event.sourceLanguage, "en");
  assert.equal(published[2].event.translationStatus, "translated");
  assert.equal(published[3].event.origin, "source");
  assert.equal(published[3].event.sourceText, null);
  assert.equal(published[3].event.translationStatus, "verbatim");
  const translatedHistoryByLanguage = Object.groupBy(
    published.filter(({ event }) => event.translationStatus === "translated" && event.origin !== "source"),
    ({ language }) => language,
  );
  assert.deepEqual(Object.keys(translatedHistoryByLanguage).sort(), ["en", "ko"]);
  assert.equal(translatedHistoryByLanguage.en.length, 1);
  assert.equal(translatedHistoryByLanguage.ko.length, 1);
  assert.ok(published.every(({ event }) => event.isFinal === true));
  assert.ok(published.every(({ options }) => options.onLiveEvent === onHostEvent));
  assert.deepEqual(pipeline.lastSequences, { ko: 9, en: 13 });
});

test("deterministic pipeline requires the exact bidirectional caption contract", () => {
  assert.throws(() => createDeterministicLocalPipeline({
    settings: { sessionId: "session-1", sessionType: "meeting", outputMode: "captions", languages: ["ko"] },
    initialSequences: { ko: 0 },
    publisher: { async publish() {} },
    onHostEvent: async () => {},
  }), /LOCAL_E2E_REQUIRES_MEETING_CAPTIONS_KO_EN/u);
});
