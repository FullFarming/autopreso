import assert from "node:assert/strict";
import test from "node:test";

import { AUDIO_CONFIG, readGatewayEnvironment, validateLiveSettings } from "../src/config.js";
import * as gatewayConfig from "../src/config.js";
import { geminiCaptionConfigFingerprint } from "../../packages/caption-core/index.js";
import { DEFAULT_ENGINE_SELECTION } from "../../packages/caption-core/caption-engine-catalog.js";

function gatewayEnvironment() {
  return {
    GEMINI_API_KEY: "test-key",
    GOOGLE_CLOUD_PROJECT: "dev-project",
    SUPABASE_URL: "https://dev-ref.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_primary",
    LIVE_GATEWAY_TOKEN_SECRET: "g".repeat(32),
    LIVE_VIEWER_TOKEN_SECRET: "v".repeat(32),
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_GCP_PROJECT: "dev-project",
    LIVE_ALLOWED_SUPABASE_REF: "dev-ref",
  };
}

test("live input audio uses the documented PCM envelope", () => {
  assert.deepEqual(AUDIO_CONFIG, {
    inputSampleRate: 16_000,
    channels: 1,
    chunkMilliseconds: 40,
    prerollMilliseconds: 300,
    vadSilenceMilliseconds: 600,
    staleFrameMilliseconds: 750,
    streamEndAfterMilliseconds: 1_000,
  });
});

test("gateway config exposes no retired OpenAI translation language registry", () => {
  assert.equal("OPENAI_REALTIME_TRANSLATION_LANGUAGES" in gatewayConfig, false);
});

test("gateway environment carries no Gemini model selection: the engine catalog governs per session", () => {
  const config = readGatewayEnvironment(gatewayEnvironment());
  assert.equal("geminiTranscribeModel" in config, false);
  assert.equal("geminiTextModel" in config, false);
  // Retired env model pins are ignored rather than validated: no env value can
  // select, forbid, or forge a provider model.
  for (const override of [
    { GEMINI_TRANSCRIBE_MODEL: "gemini-3.5-live-translate-preview" },
    { GEMINI_TRANSCRIBE_MODEL: "attacker-model" },
    { GEMINI_TEXT_MODEL: "attacker-model" },
    { GEMINI_LIVE_MODEL: "attacker-model" },
  ]) {
    const ignored = readGatewayEnvironment({ ...gatewayEnvironment(), ...override });
    assert.equal(JSON.stringify(ignored).includes("attacker-model"), false);
    assert.equal(JSON.stringify(ignored).includes("live-translate"), false);
  }
});

test("gateway reads an optional trimmed Soniox key and never requires it at startup", () => {
  assert.equal(readGatewayEnvironment(gatewayEnvironment()).sonioxApiKey, "");
  assert.equal(readGatewayEnvironment({ ...gatewayEnvironment(), SONIOX_API_KEY: "   " }).sonioxApiKey, "");
  assert.equal(readGatewayEnvironment({ ...gatewayEnvironment(), SONIOX_API_KEY: "  fixture-soniox-key  " }).sonioxApiKey, "fixture-soniox-key");
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), GEMINI_API_KEY: "" }), /GEMINI_API_KEY/u);
});

test("live settings normalize every legacy audio output mode to captions-only", () => {
  for (const outputMode of ["captions", "captions_audio", "audio"]) {
    const settings = validateLiveSettings({ sessionType: "meeting", outputMode, languages: ["ko"] });
    assert.equal(settings.outputMode, "captions");
    assert.equal(settings.captionConfig.outputMode, "captions");
  }
});

test("gateway accepts one to three valid BCP-47 STT language candidates", () => {
  assert.deepEqual(readGatewayEnvironment({ ...gatewayEnvironment(), STT_LANGUAGE_CODES: "ko-KR" }).sttLanguageCodes, ["ko-KR"]);
  assert.deepEqual(readGatewayEnvironment({ ...gatewayEnvironment(), STT_LANGUAGE_CODES: "ko-KR,en-US,ja-JP" }).sttLanguageCodes, ["ko-KR", "en-US", "ja-JP"]);
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), STT_LANGUAGE_CODES: "ko-KR,ko-KR" }), /STT_LANGUAGE_CODES/u);
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), STT_LANGUAGE_CODES: "ko-KR,../../secret" }), /STT_LANGUAGE_CODES/u);
});

test("live settings accept one to three unique languages", () => {
  const validated = validateLiveSettings({ sessionType: "meeting", languages: ["ko-KR", "en-US"] });
  const { captionConfig, captionConfigFingerprint, ...settings } = validated;
  assert.deepEqual(settings, {
    sessionType: "meeting",
    languages: ["ko", "en"],
    outputMode: "captions",
    voiceProvider: null,
    maxViewers: 200,
    glossaryPack: "general_cre",
    glossaryText: "",
    translationTone: "natural",
    domainText: "",
  });
  assert.equal(captionConfig.provider, "gemini");
  assert.equal(captionConfig.voiceProvider, null);
  assert.match(captionConfigFingerprint, /^gemini-caption-v5-[a-f0-9]{16}$/u);
  assert.deepEqual(captionConfig.engine, DEFAULT_ENGINE_SELECTION);
  assert.deepEqual(captionConfig.models, { transcription: "gemini-3.5-transcribe-live", polish: "gemini-3.7-flash", summary: "gemini-3.6-flash" });
  assert.equal("live" in captionConfig.models, false, "the direct Live Translate role is retired");
  assert.equal(captionConfig.polishPolicy.mode, "selective");
  const legacyTownhall = validateLiveSettings({ mode: "townhall", languages: ["ko"], voiceOutputMode: "auto_voice" });
  assert.equal(legacyTownhall.sessionType, "meeting");
  assert.equal(legacyTownhall.outputMode, "captions");
  assert.equal(validateLiveSettings({ sessionType: "presentation", outputMode: "captions_audio", languages: ["ko"] }).outputMode, "captions");
  assert.equal(validateLiveSettings({ sessionType: "presentation", outputMode: "captions_audio", voiceProvider: "openai", languages: ["ko"] }).voiceProvider, null);
  assert.equal(validateLiveSettings({ sessionType: "presentation", outputMode: "audio", voiceProvider: "openai", languages: ["it"] }).voiceProvider, null);
  assert.throws(() => validateLiveSettings({ sessionType: "presentation", outputMode: "audio", voiceProvider: "unknown", languages: ["ko"] }), /음성 공급자/u);
  assert.equal(validateLiveSettings({ sessionType: "presentation", outputMode: "captions", voiceProvider: "openai", languages: ["ko"] }).voiceProvider, null);
  assert.equal(validateLiveSettings({ sessionType: "meeting", outputMode: "audio", voiceProvider: "openai", languages: ["ko"] }).voiceProvider, null);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", outputMode: "clone_voice", languages: ["ko"] }), /음성 출력/u);
  assert.equal(validateLiveSettings({ sessionType: "meeting", maxViewers: 200, languages: ["ko"] }).maxViewers, 200);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", maxViewers: 201, languages: ["ko"] }), /200명/u);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", glossaryPack: "unknown", languages: ["ko"] }), /용어집/u);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: [] }), /1개 이상/);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: ["ko", "en", "ja", "fr"] }), /3개 이하/);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: ["ko", "ko"] }), /중복/);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: ["en", "en-US"] }), /중복/);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: ["xx"] }), /언어 코드/u);
});

test("non-default Live Call settings round-trip through one canonical Gemini config", () => {
  const settings = validateLiveSettings({
    sessionType: "presentation",
    languages: ["ko", "en"],
    outputMode: "audio",
    audioLanguage: "en",
    voiceProvider: "gemini",
    maxViewers: 24,
    glossaryPack: "hotel",
    glossaryText: "순영업소득 = NOI",
    translationTone: "business",
    domainText: "Hospitality investment",
  });
  assert.equal(settings.captionConfig.outputMode, "captions");
  assert.equal(settings.captionConfig.preset.id, "hotel");
  assert.equal(settings.captionConfig.glossary, "순영업소득 = NOI");
  assert.equal(settings.captionConfig.tone, "business");
  assert.equal(settings.captionConfig.domain, "Hospitality investment");
  assert.equal(settings.captionConfigFingerprint, geminiCaptionConfigFingerprint(settings.captionConfig));
});

test("gateway refuses short signing secrets at startup", () => {
  assert.equal(readGatewayEnvironment(gatewayEnvironment()).gatewaySecret.length, 32);
  assert.throws(
    () => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_GATEWAY_TOKEN_SECRET: "too-short" }),
    /32자 이상/,
  );
  assert.throws(
    () => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_VIEWER_TOKEN_SECRET: "too-short" }),
    /32자 이상/,
  );
});

test("gateway parses three-way caption polish weights and rejects invalid totals", () => {
  const config = readGatewayEnvironment({
    ...gatewayEnvironment(),
    LIVE_CAPTION_POLISH_OFF_BPS: "1000",
    LIVE_CAPTION_POLISH_SELECTIVE_BPS: "8000",
    LIVE_CAPTION_POLISH_FULL_BPS: "1000",
  });
  assert.deepEqual(config.captionPolishPolicyWeights, { off: 1_000, selective: 8_000, full: 1_000 });
  assert.deepEqual(readGatewayEnvironment(gatewayEnvironment()).captionPolishPolicyWeights, { off: 0, selective: 10_000, full: 0 });
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_CAPTION_POLISH_OFF_BPS: "1.5" }), /POLISH/u);
  assert.throws(() => readGatewayEnvironment({
    ...gatewayEnvironment(), LIVE_CAPTION_POLISH_OFF_BPS: "5001", LIVE_CAPTION_POLISH_SELECTIVE_BPS: "5000",
  }), /POLISH/u);
});

test("gateway external providers are restricted to one exact development project and Supabase ref", () => {
  const hosted = readGatewayEnvironment(gatewayEnvironment());
  assert.equal(hosted.externalEnvironment, "development");
  assert.equal(hosted.host, "0.0.0.0");
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_EXTERNAL_ENV: "production" }), /개발 환경/u);
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), GOOGLE_CLOUD_PROJECT: "prod-project" }), /개발 Google Cloud/u);
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), SUPABASE_URL: "https://dev-ref.supabase.co.evil.example" }), /Supabase/u);
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_ALLOWED_SUPABASE_REF: "another-ref" }), /Supabase/u);
});

test("gateway local Supabase exception is exact, explicit, and never available in production", () => {
  const local = {
    ...gatewayEnvironment(),
    NODE_ENV: "development",
    LIVE_ALLOW_LOCAL_SUPABASE: "true",
    LIVE_ALLOWED_SUPABASE_REF: undefined,
    SUPABASE_URL: "http://127.0.0.1:54321",
  };
  const loopbackIp = readGatewayEnvironment(local);
  assert.equal(loopbackIp.baseUrl, "http://127.0.0.1:54321");
  assert.equal(loopbackIp.host, "127.0.0.1");
  const loopbackName = readGatewayEnvironment({ ...local, SUPABASE_URL: "http://localhost:54321/" });
  assert.equal(loopbackName.baseUrl, "http://localhost:54321");
  assert.equal(loopbackName.host, "127.0.0.1");
  for (const rejected of [
    { LIVE_ALLOW_LOCAL_SUPABASE: undefined },
    { LIVE_ALLOW_LOCAL_SUPABASE: "TRUE" },
    { NODE_ENV: "production" },
    { SUPABASE_URL: "http://127.0.0.1:54322" },
    { SUPABASE_URL: "http://127.0.0.1:54321/rest" },
    { SUPABASE_URL: "http://127.0.0.1:54321?x=1" },
    { SUPABASE_URL: "http://127.0.0.2:54321" },
  ]) {
    assert.throws(() => readGatewayEnvironment({ ...local, ...rejected }), /Supabase/u);
  }
});

test("gateway prefers the new Supabase secret and temporarily accepts the legacy fallback", () => {
  const current = readGatewayEnvironment({
    ...gatewayEnvironment(),
    SUPABASE_SERVICE_ROLE_KEY: "legacy-key",
  });
  assert.equal(current.supabaseApiKey, "sb_secret_primary");
  assert.equal(current.supabaseKeyType, "secret");

  const legacyEnvironment = gatewayEnvironment();
  delete legacyEnvironment.SUPABASE_SECRET_KEY;
  legacyEnvironment.SUPABASE_SERVICE_ROLE_KEY = "legacy-only";
  const legacy = readGatewayEnvironment(legacyEnvironment);
  assert.equal(legacy.supabaseApiKey, "legacy-only");
  assert.equal(legacy.supabaseKeyType, "legacy-service-role");

  const missing = gatewayEnvironment();
  delete missing.SUPABASE_SECRET_KEY;
  assert.throws(() => readGatewayEnvironment(missing), /SUPABASE_SECRET_KEY/u);
});

test("host reconnect grace window covers the desktop's maximum retry and honors the env override", () => {
  assert.equal(readGatewayEnvironment(gatewayEnvironment()).hostReconnectGraceMilliseconds, 90_000);
  assert.equal(
    readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_HOST_RECONNECT_GRACE_MS: "10000" }).hostReconnectGraceMilliseconds,
    10_000,
  );
  assert.throws(
    () => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_HOST_RECONNECT_GRACE_MS: "not-a-number" }),
    /LIVE_HOST_RECONNECT_GRACE_MS/u,
  );
});

test("gateway ignores a stale OpenAI translation key in Gemini-only config", () => {
  const config = readGatewayEnvironment({ ...gatewayEnvironment(), OPENAI_API_KEY: "sk-server-only" });
  assert.equal(config.openaiApiKey, undefined);
});

test("gateway does not require an OpenAI key", () => {
  const config = readGatewayEnvironment(gatewayEnvironment());
  assert.equal(config.geminiApiKey, "test-key");
  assert.equal(config.openaiApiKey, undefined);
});

test("live settings accept an optional desktop glossary text and cap its size", () => {
  const base = { sessionType: "meeting", languages: ["ko", "en"], outputMode: "captions" };
  assert.equal(validateLiveSettings(base).glossaryText, "");
  assert.equal(validateLiveSettings({ ...base, glossaryText: "  힐튼 = Hilton  " }).glossaryText, "힐튼 = Hilton");
  // 40k, not 16k: the desktop's shipped presets run to 27.5k, and a cap below
  // that silently dropped whichever glossary sections sat at the end of the file.
  assert.equal(validateLiveSettings({ ...base, glossaryText: "가".repeat(20_000) }).glossaryText.length, 20_000);
  assert.equal(validateLiveSettings({ ...base, glossaryText: "가".repeat(50_000) }).glossaryText.length, 40_000);
  assert.throws(() => validateLiveSettings({ ...base, glossaryText: 123 }), /용어집 텍스트/);
});
