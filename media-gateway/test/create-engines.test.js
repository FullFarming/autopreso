import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEngineForLanguages, assertEngineKeys, createSpeechToText, createTextTranslate, isCombinedEngine } from "../src/engines/create-engines.js";
import { DEFAULT_ENGINE_SELECTION } from "../../packages/caption-core/caption-engine-catalog.js";

const soniox = { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" }, translation: { provider: "soniox", model: "stt-rt-v5" }, summary: { provider: "gemini", model: "gemini-3.6-flash" } };
const fakeLiveClient = { live: { connect: async () => ({ sendRealtimeInput() {}, close() {} }) } };
const fakeRuntime = { createSessionClient: () => ({ models: { generateContent: async () => ({ text: "x" }) } }) };

test("gemini engine builds the Transcribe adapter and a text translator with the catalog fallback chain", () => {
  const stt = createSpeechToText({ engine: DEFAULT_ENGINE_SELECTION, liveClient: fakeLiveClient, sonioxApiKey: "", languageCodes: ["ko-KR", "en-US"], compiledGlossary: null });
  assert.equal(typeof stt.open, "function");
  assert.equal(stt.provider, "gemini");
  assert.equal(stt.model, "gemini-3.5-transcribe-live");
  const translate = createTextTranslate({ engine: DEFAULT_ENGINE_SELECTION, geminiRuntime: fakeRuntime, sessionId: "s1" });
  assert.equal(translate.model, "gemini-3.6-flash");
  assert.deepEqual(translate.fallbackModels, ["gemini-3.5-flash-lite"]);
  assert.equal(translate.fallbackClients.length, 1);
  assert.equal(isCombinedEngine(DEFAULT_ENGINE_SELECTION), false);
});

test("text translator binds the model at createSessionClient time, once per model in the chain", () => {
  const bound = [];
  const runtime = { createSessionClient(sessionId, workload, options) {
    bound.push({ sessionId, workload, model: options.model });
    return { models: { generateContent: async () => ({ text: "x" }) } };
  } };
  createTextTranslate({ engine: { ...DEFAULT_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.7-flash" } }, geminiRuntime: runtime, sessionId: "s2" });
  assert.deepEqual(bound, [
    { sessionId: "s2", workload: "translation", model: "gemini-3.7-flash" },
    { sessionId: "s2", workload: "translation", model: "gemini-3.6-flash" },
    { sessionId: "s2", workload: "translation", model: "gemini-3.5-flash-lite" },
  ]);
});

test("soniox combined engine builds the soniox adapter and no text translator", () => {
  const stt = createSpeechToText({ engine: soniox, liveClient: fakeLiveClient, sonioxApiKey: "fixture-key", languageCodes: ["ko-KR", "en-US"], compiledGlossary: null, translationLanguages: ["en", "ko"] });
  assert.equal(stt.provider, "soniox");
  assert.equal(isCombinedEngine(soniox), true);
  assert.equal(createTextTranslate({ engine: soniox, geminiRuntime: fakeRuntime, sessionId: "s1" }), null);
});

test("missing provider key is rejected before any adapter is built", () => {
  assert.throws(() => assertEngineKeys(soniox, { GEMINI_API_KEY: "fixture-key" }), /ENGINE_KEY_MISSING/u);
  assert.throws(() => assertEngineKeys(soniox, { GEMINI_API_KEY: "fixture-key", SONIOX_API_KEY: "   " }), /ENGINE_KEY_MISSING/u);
  assert.doesNotThrow(() => assertEngineKeys(soniox, { GEMINI_API_KEY: "fixture-key", SONIOX_API_KEY: "fixture-key" }));
  assert.throws(() => assertEngineKeys(DEFAULT_ENGINE_SELECTION, {}), /ENGINE_KEY_MISSING/u);
  assert.throws(() => createSpeechToText({ engine: soniox, liveClient: fakeLiveClient, sonioxApiKey: "", languageCodes: [], compiledGlossary: null, translationLanguages: ["en", "ko"] }), /ENGINE_KEY_MISSING/u);
});

test("an unknown engine selection fails closed before any adapter is built", () => {
  const forged = { ...DEFAULT_ENGINE_SELECTION, stt: { provider: "gemini", model: "attacker-model", languageMode: "auto" } };
  assert.throws(() => createSpeechToText({ engine: forged, liveClient: fakeLiveClient, languageCodes: [] }), /ENGINE_SELECTION_INVALID/u);
  assert.throws(() => createTextTranslate({ engine: forged, geminiRuntime: fakeRuntime, sessionId: "s1" }), /ENGINE_SELECTION_INVALID/u);
  assert.throws(() => assertEngineKeys(forged, { GEMINI_API_KEY: "fixture-key" }), /ENGINE_SELECTION_INVALID/u);
});

test("the soniox adapter never exposes the api key on a public property", () => {
  const stt = createSpeechToText({ engine: soniox, liveClient: fakeLiveClient, sonioxApiKey: "fixture-key", languageCodes: [], compiledGlossary: null, translationLanguages: ["en", "ko"] });
  assert.equal(JSON.stringify(stt).includes("fixture-key"), false);
  assert.equal(Object.values(stt).includes("fixture-key"), false);
});

test("factory errors carry a machine code the gateway can map", () => {
  const forged = { ...DEFAULT_ENGINE_SELECTION, stt: { provider: "gemini", model: "attacker-model", languageMode: "auto" } };
  for (const run of [
    () => createSpeechToText({ engine: forged, liveClient: fakeLiveClient, languageCodes: [] }),
    () => createTextTranslate({ engine: forged, geminiRuntime: fakeRuntime, sessionId: "s1" }),
    () => assertEngineKeys(forged, { GEMINI_API_KEY: "fixture-key" }),
  ]) {
    assert.throws(run, (error) => error instanceof Error && error.code === "ENGINE_SELECTION_INVALID" && error.message === "ENGINE_SELECTION_INVALID");
  }
  for (const run of [
    () => assertEngineKeys(soniox, { GEMINI_API_KEY: "fixture-key" }),
    () => createSpeechToText({ engine: soniox, liveClient: fakeLiveClient, sonioxApiKey: "", languageCodes: [], translationLanguages: ["en", "ko"] }),
  ]) {
    assert.throws(run, (error) => error instanceof Error && error.code === "ENGINE_KEY_MISSING" && error.message === "ENGINE_KEY_MISSING");
  }
});

test("an engine that needs an exact caption-language count is refused for other counts before any adapter is built", () => {
  assert.throws(() => assertEngineForLanguages(soniox, ["ko", "en", "ja"]),
    (error) => error instanceof Error && error.code === "ENGINE_SELECTION_INVALID" && error.message === "ENGINE_SELECTION_INVALID");
  assert.throws(() => assertEngineForLanguages(soniox, ["ko"]), /ENGINE_SELECTION_INVALID/u);
  assert.doesNotThrow(() => assertEngineForLanguages(soniox, ["ko", "en"]));
  assert.doesNotThrow(() => assertEngineForLanguages(DEFAULT_ENGINE_SELECTION, ["ko", "en", "ja"]));
  assert.doesNotThrow(() => assertEngineForLanguages(DEFAULT_ENGINE_SELECTION, ["ko"]));
  const forged = { ...DEFAULT_ENGINE_SELECTION, stt: { provider: "gemini", model: "attacker-model", languageMode: "auto" } };
  assert.throws(() => assertEngineForLanguages(forged, ["ko", "en"]), /ENGINE_SELECTION_INVALID/u);
});
