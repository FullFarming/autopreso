import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEngineKeys, createSpeechToText, createTextTranslate, isCombinedEngine } from "../src/engines/create-engines.js";
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
