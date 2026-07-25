import assert from "node:assert/strict";
import test from "node:test";

import { AUDIO_CONFIG, readGatewayEnvironment, validateLiveSettings } from "../src/config.js";

function gatewayEnvironment() {
  return {
    GEMINI_API_KEY: "test-key",
    OPENAI_API_KEY: "sk-test-key",
    GEMINI_LIVE_MODEL: "live-model",
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

test("live audio settings use the documented audio-only envelope", () => {
  assert.deepEqual(AUDIO_CONFIG, {
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
    channels: 1,
    chunkMilliseconds: 40,
    prerollMilliseconds: 300,
    vadSilenceMilliseconds: 600,
    staleFrameMilliseconds: 750,
    streamEndAfterMilliseconds: 1_000,
  });
});

test("live settings accept one to three unique languages", () => {
  assert.deepEqual(validateLiveSettings({ sessionType: "meeting", languages: ["ko-KR", "en-US"] }), {
    sessionType: "meeting",
    languages: ["ko", "en"],
    outputMode: "captions",
    voiceProvider: "gemini",
    maxViewers: 50,
    glossaryPack: "general_cre",
    glossaryText: "",
    translationTone: "natural",
    domainText: "",
  });
  const legacyTownhall = validateLiveSettings({ mode: "townhall", languages: ["ko"], voiceOutputMode: "auto_voice" });
  assert.equal(legacyTownhall.sessionType, "meeting");
  assert.equal(legacyTownhall.outputMode, "audio");
  assert.equal(validateLiveSettings({ sessionType: "presentation", outputMode: "captions_audio", languages: ["ko"] }).outputMode, "captions_audio");
  assert.equal(validateLiveSettings({ sessionType: "presentation", outputMode: "captions_audio", voiceProvider: "openai", languages: ["ko"] }).voiceProvider, "openai");
  assert.throws(() => validateLiveSettings({ sessionType: "presentation", outputMode: "audio", voiceProvider: "openai", languages: ["th"] }), /언어 코드/u);
  assert.throws(() => validateLiveSettings({ sessionType: "presentation", outputMode: "audio", voiceProvider: "unknown", languages: ["ko"] }), /음성 공급자/u);
  assert.throws(() => validateLiveSettings({ sessionType: "presentation", outputMode: "captions", voiceProvider: "openai", languages: ["ko"] }), /프레젠테이션 음성 출력/u);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", outputMode: "audio", voiceProvider: "openai", languages: ["ko"] }), /프레젠테이션 음성 출력/u);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", outputMode: "clone_voice", languages: ["ko"] }), /음성 출력/u);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", maxViewers: 51, languages: ["ko"] }), /50명/u);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", glossaryPack: "unknown", languages: ["ko"] }), /용어집/u);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: [] }), /1개 이상/);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: ["ko", "en", "ja", "fr"] }), /3개 이하/);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: ["ko", "ko"] }), /중복/);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: ["en", "en-US"] }), /중복/);
  assert.throws(() => validateLiveSettings({ sessionType: "meeting", languages: ["xx"] }), /언어 코드/u);
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

test("gateway external providers are restricted to one exact development project and Supabase ref", () => {
  assert.equal(readGatewayEnvironment(gatewayEnvironment()).externalEnvironment, "development");
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_EXTERNAL_ENV: "production" }), /개발 환경/u);
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), GOOGLE_CLOUD_PROJECT: "prod-project" }), /개발 Google Cloud/u);
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), SUPABASE_URL: "https://dev-ref.supabase.co.evil.example" }), /Supabase/u);
  assert.throws(() => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_ALLOWED_SUPABASE_REF: "another-ref" }), /Supabase/u);
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

test("host reconnect grace window defaults to 45 seconds and honors the env override", () => {
  assert.equal(readGatewayEnvironment(gatewayEnvironment()).hostReconnectGraceMilliseconds, 45_000);
  assert.equal(
    readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_HOST_RECONNECT_GRACE_MS: "10000" }).hostReconnectGraceMilliseconds,
    10_000,
  );
  assert.throws(
    () => readGatewayEnvironment({ ...gatewayEnvironment(), LIVE_HOST_RECONNECT_GRACE_MS: "not-a-number" }),
    /LIVE_HOST_RECONNECT_GRACE_MS/u,
  );
});

test("gateway keeps the OpenAI key in internal server config", () => {
  const config = readGatewayEnvironment({ ...gatewayEnvironment(), OPENAI_API_KEY: "sk-server-only" });
  assert.equal(config.openaiApiKey, "sk-server-only");
});

test("gateway fails fast when the server-only OpenAI key is missing", () => {
  const environment = gatewayEnvironment();
  delete environment.OPENAI_API_KEY;
  assert.throws(() => readGatewayEnvironment(environment), /OPENAI_API_KEY/u);
});

test("live settings accept an optional desktop glossary text and cap its size", () => {
  const base = { sessionType: "meeting", languages: ["ko", "en"], outputMode: "captions" };
  assert.equal(validateLiveSettings(base).glossaryText, "");
  assert.equal(validateLiveSettings({ ...base, glossaryText: "  힐튼 = Hilton  " }).glossaryText, "힐튼 = Hilton");
  assert.equal(validateLiveSettings({ ...base, glossaryText: "가".repeat(20_000) }).glossaryText.length, 16_000);
  assert.throws(() => validateLiveSettings({ ...base, glossaryText: 123 }), /용어집 텍스트/);
});
