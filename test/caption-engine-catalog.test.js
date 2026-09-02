import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTION_ENGINE_CATALOG, DEFAULT_ENGINE_SELECTION, EngineSelectionError,
  captionEngineCatalogForClient, engineRequiredApiKeys, engineSelectionKey, findEngineEntry,
  isCombinedEngine, migrateLegacyEngineSelection, normalizeEngineSelection,
} from "../packages/caption-core/caption-engine-catalog.js";

test("default selection is Gemini Transcribe Live + Gemini 3.6 Flash + Gemini 3.6 Flash summary", () => {
  assert.deepEqual(DEFAULT_ENGINE_SELECTION, {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.6-flash" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  });
  assert.deepEqual(normalizeEngineSelection(undefined), DEFAULT_ENGINE_SELECTION);
  assert.ok(Object.isFrozen(normalizeEngineSelection(undefined)));
});

test("catalog entries carry capabilities and key requirements", () => {
  const soniox = findEngineEntry("stt", "soniox", "stt-rt-v5");
  assert.equal(soniox.requiredApiKey, "soniox");
  assert.equal(soniox.capability.canRestrictSource, true);
  assert.equal(soniox.capability.combinedSttTranslation, true);
  assert.deepEqual(soniox.capability.languageModes, ["auto", "ko", "en"]);
  const gemini = findEngineEntry("stt", "gemini", "gemini-3.5-transcribe-live");
  assert.equal(gemini.capability.canRestrictSource, false);
  assert.deepEqual(gemini.capability.languageModes, ["auto"]);
  assert.equal(findEngineEntry("stt", "gemini", "gemini-3.5-live-translate-preview"), null);
  assert.deepEqual(CAPTION_ENGINE_CATALOG.translation.map((entry) => `${entry.provider}:${entry.model}`),
    ["gemini:gemini-3.5-flash-lite", "gemini:gemini-3.6-flash", "gemini:gemini-3.7-flash", "soniox:stt-rt-v5"]);
});

test("normalize rejects unknown models, unknown modes, and soniox translation without soniox stt", () => {
  const base = DEFAULT_ENGINE_SELECTION;
  assert.throws(() => normalizeEngineSelection({ ...base, stt: { provider: "gemini", model: "gemini-9-flash", languageMode: "auto" } }),
    (error) => error instanceof EngineSelectionError && error.code === "ENGINE_SELECTION_INVALID");
  assert.throws(() => normalizeEngineSelection({ ...base, stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "ko" } }), EngineSelectionError);
  assert.throws(() => normalizeEngineSelection({ ...base, translation: { provider: "soniox", model: "stt-rt-v5" } }), EngineSelectionError);
  assert.throws(() => normalizeEngineSelection({ ...base, extra: 1 }), EngineSelectionError);
  const combined = normalizeEngineSelection({
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  });
  assert.equal(isCombinedEngine(combined), true);
  assert.equal(isCombinedEngine(DEFAULT_ENGINE_SELECTION), false);
  assert.deepEqual(engineRequiredApiKeys(combined), ["soniox", "gemini"]);
  assert.deepEqual(engineRequiredApiKeys(DEFAULT_ENGINE_SELECTION), ["gemini"]);
});

test("legacy Gemini fields migrate into engine and live-translate maps to transcribe", () => {
  const migrated = migrateLegacyEngineSelection({
    geminiTranscribeModel: "gemini-3.5-live-translate-preview",
    geminiSummaryModel: "gemini-3.7-flash",
    geminiPolishModel: "gemini-3.7-flash",
  });
  assert.deepEqual(migrated, {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.7-flash" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  });
  const kept = migrateLegacyEngineSelection({ engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.5-flash-lite" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  }, geminiTranscribeModel: "gemini-3.5-live-translate-preview" });
  assert.equal(kept.stt.provider, "soniox", "explicit engine wins over legacy fields");
  assert.deepEqual(migrateLegacyEngineSelection({}), DEFAULT_ENGINE_SELECTION);
  assert.deepEqual(migrateLegacyEngineSelection({ geminiSummaryModel: "gemini-3.5-flash" }).summary,
    { provider: "gemini", model: "gemini-3.6-flash" }, "unknown legacy summary falls back to default");
});

test("client view marks entries unavailable when the key is missing", () => {
  const view = captionEngineCatalogForClient({ hasApiKeys: { gemini: true, soniox: false } });
  assert.equal(view.stt.find((entry) => entry.provider === "soniox").available, false);
  assert.equal(view.stt.find((entry) => entry.provider === "gemini").available, true);
  assert.deepEqual(view.defaults, DEFAULT_ENGINE_SELECTION);
  assert.equal(Object.hasOwn(view.stt[0], "requiredApiKey"), true);
});

test("selection key is stable across property order", () => {
  const a = engineSelectionKey({ summary: { model: "gemini-3.6-flash", provider: "gemini" }, translation: { provider: "gemini", model: "gemini-3.6-flash" }, stt: { languageMode: "auto", model: "gemini-3.5-transcribe-live", provider: "gemini" } });
  assert.equal(a, engineSelectionKey(DEFAULT_ENGINE_SELECTION));
});
