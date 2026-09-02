import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
import { GeminiModelSelectionError, migrateLegacyGeminiModelSelection, readGeminiSelectedModel } from "../packages/caption-core/gemini-model-catalog.js";
import { resolveLiveCallLanguages } from "../src/subtitle-languages.js";

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
function section(start, end) {
  const from = main.indexOf(start);
  const to = main.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} must exist`);
  return main.slice(from, to);
}
const helpers = section("function readLiveCallModelPreferences", "function sanitizeLiveCallDraft");
function context(overrides = {}) {
  return {
    createGeminiCaptionConfig, geminiCaptionConfigFingerprint, migrateLegacyGeminiModelSelection, readGeminiSelectedModel, GeminiModelSelectionError,
    resolveLiveCallLanguages, LIVE_DRAFT_LANGUAGES: new Set(["ko", "en", "ja"]),
    sanitizeLiveCallGlossaries: (value) => value ?? [], sanitizeLiveCaptionDisplayLanguage: () => "all",
    dashboardWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false } },
    validateSubtitleSettings: () => {}, console: { warn: () => {} }, ...overrides,
  };
}
function draftInput(draft, subtitleSettings) {
  const build = vm.runInNewContext(`${helpers}\n${section("function sanitizeLiveCallDraft", "async function openLiveStageOverlay")}\n(draft, saved) => toLiveCallApiInput(sanitizeLiveCallDraft(draft, saved))`, context());
  return build(draft, subtitleSettings);
}
// Historical DB metadata: values the current role contract no longer offers,
// which must migrate to the fixed runtime roles rather than being replayed.
const dbPreferences = { source: "gemini-3.6-flash", summary: "gemini-3.5-flash" };
const geminiEngine = (sttModel, summaryModel) => ({
  stt: { provider: "gemini", model: sttModel, languageMode: "auto" },
  translation: { provider: "gemini", model: "gemini-3.6-flash" },
  summary: { provider: "gemini", model: summaryModel },
});
const localSettings = { engine: geminiEngine("gemini-3.5-transcribe-live", "gemini-3.7-flash"), translationLanguages: ["ko", "en"] };
const runtimePreferences = { source: "gemini-3.5-transcribe-live", summary: "gemini-3.6-flash" };
function assertModels(config, expected = runtimePreferences) {
  assert.equal(config.models.transcription, expected.source);
  assert.equal(config.models.summary, expected.summary);
  assert.equal(config.engine.stt.provider, "gemini", "the pinned Live Call runs the only engine the gateway has");
  assert.equal(config.engine.stt.model, expected.source);
  assert.equal(config.engine.summary.model, expected.summary);
}

test("new desktop Live Call ignores renderer model preferences and submits the fixed saved roles", () => {
  const input = draftInput({ title: "Synthetic meeting", modelPreferences: { source: "untrusted", summary: "untrusted" } }, {
    ...localSettings, engine: geminiEngine(runtimePreferences.source, runtimePreferences.summary),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(input.modelPreferences)), runtimePreferences);
  assert.equal(input.outputMode, undefined);
});

test("new desktop Live Call defaults absent selections and rejects a persisted unknown engine", () => {
  const input = draftInput({}, {});
  assert.deepEqual(JSON.parse(JSON.stringify(input.modelPreferences)), runtimePreferences);
  assert.throws(() => draftInput({}, { engine: geminiEngine("gemini-3.5-transcribe-live", "gemini-unknown") }),
    { code: "INVALID_GEMINI_MODEL_SELECTION" });
});

test("a Soniox desktop engine pins the Live Call to the Gemini default the gateway can run", () => {
  const soniox = {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  };
  const input = draftInput({}, { ...localSettings, engine: soniox });
  assert.deepEqual(JSON.parse(JSON.stringify(input.modelPreferences)),
    { source: runtimePreferences.source, summary: "gemini-3.7-flash" });
});

test("GoLive preflight migrates known session preferences without rewriting metadata or local aliases", async () => {
  const preflight = vm.runInNewContext(`${helpers}\n${section("async function preflightLiveCallCaptionSession", "function requestRendererLiveCaptionPreflight")}\npreflightLiveCallCaptionSession`, context());
  const session = { modelPreferences: dbPreferences, gatewaySettings: { captionConfig: createGeminiCaptionConfig(localSettings) } };
  const subtitle = { ...localSettings, models: { transcription: "gemini-3.7-flash", summary: "gemini-3.7-flash" }, glossary: "용어 = Term" };
  assert.equal((await preflight({ load: async () => ({ subtitle }) }, session)).ok, true);
  assertModels(session.gatewaySettings.captionConfig);
  assert.equal(session.gatewaySettings.captionConfig.glossary, subtitle.glossary);
  assert.equal(subtitle.models.transcription, "gemini-3.7-flash", "saved settings must remain unchanged");
  assert.equal(subtitle.engine.summary.model, "gemini-3.7-flash", "saved settings must remain unchanged");
  assert.deepEqual(session.modelPreferences, dbPreferences, "historical model metadata is not rewritten");
});

test("pinning a Live Call over a Soniox translation selection still builds a valid Gemini engine", () => {
  const pin = vm.runInNewContext(`${helpers}\n(settings, preferences) => pinLiveCallModelSettings(settings, preferences)`, context());
  const pinned = pin({
    ...localSettings,
    engine: { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" }, translation: { provider: "soniox", model: "stt-rt-v5" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } },
  }, dbPreferences);
  assert.deepEqual(JSON.parse(JSON.stringify(pinned.engine.translation)), { provider: "gemini", model: "gemini-3.6-flash" });
  assertModels(createGeminiCaptionConfig(pinned));
});

function armHarness() {
  const calls = [];
  const scope = vm.createContext(context({
    liveCallSession: null, liveWorkspaceUrl: "https://example.test", URL,
    settingsStore: { load: async () => ({ subtitle: localSettings }) },
    liveCallApi: async () => { calls.push("invite"); return { ok: true, data: { inviteToken: "synthetic-invite", admissionCode: "123456", version: 2 } }; },
    failPreparedLiveSession: async (_url, _id, _step, code) => ({ ok: false, code }),
    openLiveStageOverlay: async () => { calls.push("stage"); }, clearLiveBridgeAlert: () => {}, showControllerWindow: () => {},
  }));
  const arm = vm.runInContext(`${helpers}\n${section("  async function armPreparedLiveSession", "  // Pre-registration:")}\narmPreparedLiveSession`, scope);
  return { arm, scope, calls };
}

test("registered-call arming uses DB preferences before local settings and keeps a copied snapshot", async () => {
  const h = armHarness();
  const prefs = { ...dbPreferences };
  assert.equal((await h.arm({ id: "call", status: "preparing", modelPreferences: prefs }, { title: "Synthetic", languages: ["ko", "en"], outputMode: "captions" })).ok, true);
  assertModels(h.scope.liveCallSession.gatewaySettings.captionConfig);
  prefs.source = "gemini-3.6-flash";
  assert.equal(h.scope.liveCallSession.modelPreferences.source, runtimePreferences.source);
});

test("invalid DB preferences cannot create an invite or open a stage; legacy sessions use fixed runtime roles", async () => {
  const invalid = armHarness();
  // A non-string role is a broken record, not an old model: it must stop.
  const result = await invalid.arm({ id: "call", modelPreferences: { source: 42, summary: dbPreferences.summary } }, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_GEMINI_MODEL_SELECTION");
  assert.deepEqual(invalid.calls, []);
  // A retired-but-well-formed model id migrates to the fixed runtime role and
  // is never replayed against the provider.
  const retired = armHarness();
  assert.equal((await retired.arm({ id: "call", status: "preparing", modelPreferences: { source: "gemini-9.9-retired", summary: "gemini-9.9-retired" } }, { languages: ["ko", "en"] })).ok, true);
  assertModels(retired.scope.liveCallSession.gatewaySettings.captionConfig);
  const legacy = armHarness();
  await legacy.arm({ id: "call", status: "preparing" }, { languages: ["ko", "en"] });
  assertModels(legacy.scope.liveCallSession.gatewaySettings.captionConfig);
});

function startHarness(preferences, isStartAccepted = true) {
  const session = { sessionId: "call", baseUrl: "https://example.test", modelPreferences: { source: "gemini-3.6-flash", summary: "gemini-3.7-flash" }, gatewaySettings: { captionConfig: createGeminiCaptionConfig(localSettings) } };
  const calls = [];
  const start = vm.runInNewContext(`${helpers}\n${section("async function requestDesktopLiveStartIntent", "async function startDesktopLiveDemand")}\nrequestDesktopLiveStartIntent`, context({
    liveCallSession: session,
    liveCallApi: async (_base, _path, input) => {
      calls.push(input);
      if (input.method === "GET") return { ok: true, data: { id: "call", version: 7, modelPreferences: preferences } };
      return isStartAccepted ? { ok: true, data: { sessionId: "call", version: 8, activationKey: "11111111-1111-4111-8111-111111111111", runtime: { enabled: true } } } : { ok: false, code: "VERSION_CONFLICT" };
    },
  }));
  return { session, calls, start };
}

test("start and recovery pin models from the same DB version used for activation", async () => {
  const h = startHarness(dbPreferences);
  assert.equal((await h.start(h.session)).ok, true);
  assertModels(h.session.gatewaySettings.captionConfig);
  assert.equal(h.session.gatewaySettings.captionConfigFingerprint, geminiCaptionConfigFingerprint(h.session.gatewaySettings.captionConfig));
  assert.equal(h.calls[1].body.version, 7);
  assert.equal(h.calls[1].body.modelPreferences, undefined, "activation never sends current local preferences");
});

test("invalid DB model blocks activation and a failed CAS leaves the previous snapshot intact", async () => {
  const invalid = startHarness({ source: 42, summary: dbPreferences.summary });
  assert.equal((await invalid.start(invalid.session)).code, "INVALID_GEMINI_MODEL_SELECTION");
  assert.equal(invalid.calls.length, 1);
  const stale = startHarness(dbPreferences, false);
  const previousConfig = stale.session.gatewaySettings.captionConfig;
  assert.equal((await stale.start(stale.session)).code, "VERSION_CONFLICT");
  assert.equal(stale.session.modelPreferences.source, "gemini-3.6-flash");
  assert.equal(stale.session.gatewaySettings.captionConfig, previousConfig, "failed CAS cannot replace the previous config snapshot");
  assertModels(stale.session.gatewaySettings.captionConfig, { source: "gemini-3.5-transcribe-live", summary: "gemini-3.7-flash" });
});


test("optional local settings failure never removes the session model pin during arming", async () => {
  const h = armHarness();
  h.scope.settingsStore = { load: async () => { throw new Error("synthetic settings unavailable"); } };
  const result = await h.arm({ id: "call", status: "preparing", modelPreferences: dbPreferences }, { languages: ["ko", "en"] });
  assert.equal(result.ok, true);
  assertModels(h.scope.liveCallSession.gatewaySettings.captionConfig);
});

test("malformed stored model-preference shapes stop activation without defaulting to another model", async () => {
  for (const malformed of [null, [], {}, { source: dbPreferences.source }, { source: dbPreferences.source, summary: null }]) {
    const h = startHarness(malformed);
    assert.equal((await h.start(h.session)).code, "INVALID_GEMINI_MODEL_SELECTION");
    assert.equal(h.calls.length, 1);
    assert.equal(h.session.modelPreferences.source, "gemini-3.6-flash");
  }
});
