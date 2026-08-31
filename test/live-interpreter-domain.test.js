import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIVE_INTERPRETER_LANGUAGES,
  LIVE_INTERPRETER_LANGUAGE_OPTIONS,
  LIVE_INTERPRETER_LANGUAGE_RULES,
  buildLiveInterpreterLanes,
  createLiveInterpreterController,
  sanitizeInterpreterText,
} from "../src/live-interpreter/index.js";

const NOW = "2026-08-01T00:00:00.000Z";

function createProviderHarness() {
  const providers = [];
  const createProvider = (options) => {
    const provider = {
      options,
      starts: 0,
      stops: 0,
      audio: [],
      async start() {
        this.starts += 1;
        options.onEvent({ type: "state", state: "ACTIVE" });
      },
      appendAudio(audioBase64) {
        this.audio.push(audioBase64);
      },
      async stop() {
        this.stops += 1;
        options.onEvent({ type: "state", state: "CLOSED" });
      },
    };
    providers.push(provider);
    return provider;
  };
  return { providers, createProvider };
}

test("Live Interpreter supports only the approved 13 target languages and sanitizes text", () => {
  assert.deepEqual([...LIVE_INTERPRETER_LANGUAGES], [
    "es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it", "en",
  ]);
  assert.equal(sanitizeInterpreterText("  Cafe\u0301\u0000\n  hello  ", 100), "Café\n hello");
  assert.equal(sanitizeInterpreterText("abcdef", 4), "abcd");
  assert.deepEqual(LIVE_INTERPRETER_LANGUAGE_OPTIONS.map(({ code }) => code), [...LIVE_INTERPRETER_LANGUAGES]);
  assert.equal(LIVE_INTERPRETER_LANGUAGE_RULES.some(({ code }) => code === "zh-Hant"), false);
});

test("ONLINE and IN_PERSON map two independent directional lanes", () => {
  assert.deepEqual(buildLiveInterpreterLanes({ mode: "ONLINE", userLanguage: "ko", otherLanguage: "en" }), {
    INBOUND: { sourceLanguage: "en", targetLanguage: "ko" },
    OUTBOUND: { sourceLanguage: "ko", targetLanguage: "en" },
  });
  assert.deepEqual(buildLiveInterpreterLanes({ mode: "IN_PERSON", userLanguage: "ko", otherLanguage: "ja" }), {
    USER: { sourceLanguage: "ko", targetLanguage: "ja" },
    OTHER: { sourceLanguage: "ja", targetLanguage: "ko" },
  });
  assert.throws(
    () => buildLiveInterpreterLanes({ mode: "ONLINE", userLanguage: "xx", otherLanguage: "en" }),
    (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_LANGUAGE",
  );
  assert.throws(
    () => buildLiveInterpreterLanes({ mode: "REMOTE", userLanguage: "ko", otherLanguage: "en" }),
    (error) => error instanceof Error && "code" in error && error.code === "INVALID_MODE",
  );
});

test("controller starts, streams, and stops isolated ONLINE lanes idempotently", async () => {
  const harness = createProviderHarness();
  let keyReads = 0;
  const controller = createLiveInterpreterController({
    createProvider: harness.createProvider,
    getApiKey: () => { keyReads += 1; return "sk-main-only"; },
    now: () => NOW,
  });

  const first = await controller.start({ mode: "ONLINE", userLanguage: "ko", otherLanguage: "en" });
  const second = await controller.start({ mode: "ONLINE", userLanguage: "ko", otherLanguage: "en" });
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(harness.providers.length, 2);
  assert.equal(keyReads, 1);
  assert.deepEqual(harness.providers.map((provider) => provider.options.lane), ["INBOUND", "OUTBOUND"]);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes("sk-main-only"), false);

  controller.pushPcm({ lane: "INBOUND", audioBase64: "AQI=" });
  assert.deepEqual(harness.providers[0].audio, ["AQI="]);
  assert.deepEqual(harness.providers[1].audio, []);
  assert.throws(() => controller.pushPcm({ lane: "USER", audioBase64: "AQI=" }), /not active/u);
  harness.providers[0].options.onEvent({ type: "output_audio_delta", audioBase64: "AQI=" });
  assert.deepEqual(controller.getSnapshot().audioDelta, {
    lane: "INBOUND",
    sampleRate: 24_000,
    audioBase64: "AQI=",
    eventId: controller.getSnapshot().audioDelta.eventId,
  });
  assert.equal(controller.getSnapshot().records.length, 0);

  await controller.stop();
  await controller.stop();
  assert.deepEqual(harness.providers.map((provider) => provider.stops), [1, 1]);
  assert.equal(controller.getSnapshot().state, "IDLE");
});

test("controller rejects late provider events and persists only sanitized committed transcript records", async () => {
  const harness = createProviderHarness();
  const persisted = [];
  let id = 0;
  const controller = createLiveInterpreterController({
    createProvider: harness.createProvider,
    getApiKey: () => "sk-main-only",
    store: { appendRecord: async (record) => persisted.push(record) },
    now: () => NOW,
    createId: (prefix) => `${prefix}-${++id}`,
  });
  await controller.start({ mode: "IN_PERSON", userLanguage: "ko", otherLanguage: "en" });
  const staleProvider = harness.providers[0];
  staleProvider.options.onEvent({ type: "input_transcript_delta", delta: " I\u0000 am " });
  staleProvider.options.onEvent({ type: "output_transcript_delta", delta: " Cafe\u0301 " });
  staleProvider.options.onEvent({ type: "transcript_committed" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], {
    id: "record-2",
    sessionId: "session-1",
    lane: "USER",
    sourceLanguage: "ko",
    targetLanguage: "en",
    sourceText: "I am",
    translatedText: "Café",
    createdAt: NOW,
  });
  assert.equal(JSON.stringify(persisted).includes("audio"), false);

  await controller.stop();
  await controller.start({ mode: "IN_PERSON", userLanguage: "ko", otherLanguage: "ja" });
  staleProvider.options.onEvent({ type: "output_transcript_delta", delta: "stale" });
  assert.equal(controller.getSnapshot().lanes.USER.outputTranscript, "");
});

test("reconnect is explicit, lane-scoped, and bounded", async () => {
  const harness = createProviderHarness();
  const controller = createLiveInterpreterController({
    createProvider: harness.createProvider,
    getApiKey: () => "sk-main-only",
    now: () => NOW,
    maxReconnectsPerLane: 2,
  });
  await controller.start({ mode: "ONLINE", userLanguage: "ko", otherLanguage: "en" });
  await controller.reconnect("INBOUND");
  await controller.reconnect("INBOUND");
  await assert.rejects(
    controller.reconnect("INBOUND"),
    (error) => error instanceof Error && "code" in error && error.code === "RECONNECT_LIMIT_REACHED",
  );
  assert.equal(harness.providers.length, 4);
  assert.equal(harness.providers[1].stops, 0);
  assert.deepEqual(harness.providers.filter((provider) => provider.options.lane === "INBOUND").map((provider) => provider.stops), [1, 1, 0]);
  assert.equal(controller.getSnapshot().lanes.OUTBOUND.state, "ACTIVE");
});

test("API key load failure cleans the provisional session and fails closed", async () => {
  const controller = createLiveInterpreterController({
    getApiKey: async () => { throw new Error("settings body must stay private"); },
    now: () => NOW,
  });
  await assert.rejects(
    controller.start({ mode: "ONLINE", userLanguage: "ko", otherLanguage: "en" }),
    (error) => error instanceof Error
      && "code" in error
      && error.code === "OPENAI_API_KEY_LOAD_FAILED"
      && !error.message.includes("settings body"),
  );
  assert.deepEqual(controller.getSnapshot(), {
    state: "ERROR",
    sessionId: null,
    mode: null,
    userLanguage: null,
    otherLanguage: null,
    lanes: {},
    records: [],
    audioDelta: null,
  });
});
