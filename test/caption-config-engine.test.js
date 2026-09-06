import assert from "node:assert/strict";
import { test } from "node:test";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
import { DEFAULT_GEMINI_MODEL_SELECTION, migrateLegacyGeminiModelSelection, readGeminiSelectedModel, readStoredGeminiModelSelection } from "../packages/caption-core/gemini-model-catalog.js";

test("caption config carries a canonical engine and derives legacy models from it", () => {
  const config = createGeminiCaptionConfig({ translationLanguages: ["en", "ko"], engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  } });
  assert.equal(config.engine.stt.provider, "soniox");
  assert.equal(config.engine.stt.languageMode, "ko");
  assert.deepEqual(config.models, { transcription: "stt-rt-v5", summary: "gemini-3.7-flash", polish: "gemini-3.7-flash" });
  assert.equal(Object.hasOwn(config.models, "live"), false);
});

test("legacy live-translate settings migrate to Transcribe Live", () => {
  const config = createGeminiCaptionConfig({ translationLanguages: ["en", "ko"], geminiTranscribeModel: "gemini-3.5-live-translate-preview", geminiSummaryModel: "gemini-3.6-flash" });
  assert.deepEqual(config.engine.stt, { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" });
  assert.equal(config.models.transcription, "gemini-3.5-transcribe-live");
});

test("fingerprint changes when the engine changes", () => {
  const base = { translationLanguages: ["en", "ko"] };
  const a = geminiCaptionConfigFingerprint(createGeminiCaptionConfig(base));
  const b = geminiCaptionConfigFingerprint(createGeminiCaptionConfig({ ...base, engine: { ...createGeminiCaptionConfig(base).engine, stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" }, translation: { provider: "gemini", model: "gemini-3.6-flash" } } }));
  assert.notEqual(a, b);
});

test("legacy gemini model shim now defaults to Transcribe Live", () => {
  assert.equal(DEFAULT_GEMINI_MODEL_SELECTION.source, "gemini-3.5-transcribe-live");
  assert.equal(readGeminiSelectedModel("source", undefined), "gemini-3.5-transcribe-live");
  assert.equal(migrateLegacyGeminiModelSelection("source", "gemini-3.5-live-translate-preview"), "gemini-3.5-transcribe-live");
  assert.equal(readGeminiSelectedModel("summary", "gemini-3.7-flash"), "gemini-3.7-flash");
  assert.throws(() => readGeminiSelectedModel("source", "gemini-3.5-live-translate-preview"));
});

test("stored legacy source pins accept only the historical Live models; flash ids are summary evidence only (Task 4 fix M1)", () => {
  for (const model of ["gemini-3.5-transcribe-live", "gemini-3.5-live-translate-preview"]) {
    assert.equal(readStoredGeminiModelSelection("source", model), model);
    assert.throws(() => readStoredGeminiModelSelection("summary", model), /INVALID_GEMINI_MODEL_SELECTION|모델/u);
  }
  for (const model of ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"]) {
    assert.equal(readStoredGeminiModelSelection("summary", model), model);
    assert.throws(() => readStoredGeminiModelSelection("source", model), /INVALID_GEMINI_MODEL_SELECTION|모델/u, model);
  }
  for (const model of ["gemini-3.5-flash-lite", "", null, undefined, 3]) {
    assert.throws(() => readStoredGeminiModelSelection("source", model));
    assert.throws(() => readStoredGeminiModelSelection("summary", model));
  }
  assert.throws(() => readStoredGeminiModelSelection("translation", "gemini-3.6-flash"));
});

test("Gemini compatibility migration preserves summary pins and never returns a Soniox model", () => {
  assert.equal(migrateLegacyGeminiModelSelection("summary", "gemini-3.7-flash"), "gemini-3.7-flash");
  assert.equal(migrateLegacyGeminiModelSelection("source", "unknown-old-model"), "gemini-3.5-transcribe-live");
});
