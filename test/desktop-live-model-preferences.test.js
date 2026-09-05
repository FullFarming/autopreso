import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
import { GEMINI_ENGINE_SELECTION, DEFAULT_ENGINE_SELECTION, EngineSelectionError, engineSelectionKey, normalizeEngineSelection } from "../packages/caption-core/caption-engine-catalog.js";
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
    createGeminiCaptionConfig, geminiCaptionConfigFingerprint, DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection,
    resolveLiveCallLanguages, LIVE_DRAFT_LANGUAGES: new Set(["ko", "en", "ja"]),
    sanitizeLiveCallGlossaries: (value) => value ?? [], sanitizeLiveCaptionDisplayLanguage: () => "all",
    dashboardWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false } },
    validateSubtitleSettings: () => {}, console: { warn: () => {} }, ...overrides,
  };
}
function draftInput(draft, subtitleSettings, seededPreferences) {
  const build = vm.runInNewContext(`${helpers}\n${section("function sanitizeLiveCallDraft", "async function openLiveStageOverlay")}\n(draft, saved, seeded) => toLiveCallApiInput(sanitizeLiveCallDraft(draft, saved, seeded))`, context());
  return build(draft, subtitleSettings, seededPreferences);
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const sameEngine = (actual, expected, message) => assert.equal(engineSelectionKey(actual), engineSelectionKey(expected), message);

// Plan 2 Task 4: `modelPreferences` is `{ engine, engineHistory }`. The engine the
// server stored (spec §9: the admin's global engine) is the only Live Call engine.
const gemini37 = normalizeEngineSelection({ ...GEMINI_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.7-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } });
const soniox = normalizeEngineSelection({
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.7-flash" },
});
const history = [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "2026-09-04T09:00:00.000Z", byHostId: "admin-1" }];
const dbPreferences = { engine: gemini37, engineHistory: history };
// The local caption engine: never a Live Call input.
const localSettings = { engine: soniox, translationLanguages: ["ko", "en"], models: { transcription: "gemini-3.7-flash", summary: "gemini-3.7-flash" } };
function assertEngine(config, expected) {
  sameEngine(config.engine, expected);
  assert.equal(config.models.transcription, expected.stt.model);
  assert.equal(config.models.summary, expected.summary.model);
}

test("a new desktop Live Call submits `modelPreferences: { engine }` from the seeded admin engine and ignores renderer/local engines", () => {
  const input = draftInput({ title: "Synthetic meeting", modelPreferences: { engine: soniox } }, localSettings, { engine: gemini37 });
  assert.deepEqual(plain(input.modelPreferences), { engine: plain(gemini37) }, "history is never sent; the body is exactly { engine }");
  assert.equal(input.outputMode, undefined);
  assert.deepEqual(plain(draftInput({}, localSettings, { engine: soniox }).modelPreferences), { engine: plain(soniox) }, "a Soniox admin engine travels as-is");
});

test("an absent seed is the catalog default; a malformed or legacy seed is refused with ENGINE_SELECTION_INVALID", () => {
  assert.deepEqual(plain(draftInput({}, {}).modelPreferences), { engine: plain(DEFAULT_ENGINE_SELECTION) });
  for (const seed of [null, {}, [], { engine: null }, { engine: "gemini" }, { engine: { stt: { provider: "nope", model: "x" } } },
    { engine: DEFAULT_ENGINE_SELECTION, apiKey: "private" }, { source: "gemini-3.5-transcribe-live", summary: "gemini-3.6-flash" }]) {
    assert.throws(() => draftInput({}, localSettings, seed), { code: "ENGINE_SELECTION_INVALID" }, JSON.stringify(seed));
  }
});

test("pinning a Live Call replaces the local engine and legacy model pins with the DB engine, keeping every other setting", () => {
  const pin = vm.runInNewContext(`${helpers}\n(settings, preferences) => pinLiveCallModelSettings(settings, preferences)`, context());
  const pinned = pin({ ...localSettings, glossary: "용어 = Term", tone: "business" }, dbPreferences);
  assert.deepEqual(plain(pinned.engine), plain(gemini37));
  assert.equal(pinned.models, undefined, "legacy per-role model pins never reach the gateway config");
  assert.equal(pinned.glossary, "용어 = Term");
  assert.equal(pinned.tone, "business");
  assertEngine(createGeminiCaptionConfig(pinned), gemini37);
  assertEngine(createGeminiCaptionConfig(pin(localSettings, { engine: soniox })), soniox);
  assert.equal(localSettings.engine, soniox, "the saved settings object is never mutated");
});

test("GoLive preflight builds the gateway config from the session engine without rewriting metadata or local settings", async () => {
  const preflight = vm.runInNewContext(`${helpers}\n${section("async function preflightLiveCallCaptionSession", "function requestRendererLiveCaptionPreflight")}\npreflightLiveCallCaptionSession`, context());
  const session = { modelPreferences: dbPreferences, gatewaySettings: { captionConfig: createGeminiCaptionConfig({ languages: ["ko", "en"], engine: DEFAULT_ENGINE_SELECTION }) } };
  const subtitle = { ...localSettings, glossary: "용어 = Term" };
  assert.equal((await preflight({ load: async () => ({ subtitle }) }, session)).ok, true);
  assertEngine(session.gatewaySettings.captionConfig, gemini37);
  assert.equal(session.gatewaySettings.captionConfig.glossary, subtitle.glossary);
  assert.equal(subtitle.engine, soniox, "saved settings must remain unchanged");
  assert.deepEqual(session.modelPreferences, dbPreferences, "session metadata is not rewritten");
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

test("registered-call arming uses the DB engine before local settings and keeps a copied snapshot", async () => {
  const h = armHarness();
  const prefs = { engine: { ...gemini37 }, engineHistory: [...history] };
  assert.equal((await h.arm({ id: "call", status: "preparing", modelPreferences: prefs }, { title: "Synthetic", languages: ["ko", "en"], outputMode: "captions" })).ok, true);
  assertEngine(h.scope.liveCallSession.gatewaySettings.captionConfig, gemini37);
  prefs.engine = soniox;
  sameEngine(h.scope.liveCallSession.modelPreferences.engine, gemini37, "the armed snapshot does not alias the response object");
  assert.equal(h.scope.liveCallSession.modelPreferences.engineHistory, undefined, "the desktop keeps only the engine");
});

test("invalid DB preferences cannot create an invite or open a stage; a session without preferences runs the catalog default", async () => {
  for (const malformed of [{ engine: null }, { engine: { stt: { provider: "gemini", model: "gemini-9.9-retired", languageMode: "auto" } } },
    { source: "gemini-3.5-transcribe-live", summary: "gemini-3.6-flash" }, { engine: DEFAULT_ENGINE_SELECTION, model: "x" }]) {
    const invalid = armHarness();
    const result = await invalid.arm({ id: "call", modelPreferences: malformed }, {});
    assert.equal(result.ok, false, JSON.stringify(malformed));
    assert.equal(result.code, "ENGINE_SELECTION_INVALID");
    assert.deepEqual(invalid.calls, []);
  }
  const legacy = armHarness();
  await legacy.arm({ id: "call", status: "preparing" }, { languages: ["ko", "en"] });
  assertEngine(legacy.scope.liveCallSession.gatewaySettings.captionConfig, DEFAULT_ENGINE_SELECTION);
});

function startHarness(preferences, isStartAccepted = true) {
  const session = { sessionId: "call", baseUrl: "https://example.test", modelPreferences: { engine: soniox }, gatewaySettings: { captionConfig: createGeminiCaptionConfig({ languages: ["ko", "en"], engine: soniox }) } };
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

test("start and recovery pin the engine from the same DB version used for activation", async () => {
  const h = startHarness(dbPreferences);
  assert.equal((await h.start(h.session)).ok, true);
  assertEngine(h.session.gatewaySettings.captionConfig, gemini37);
  assert.equal(h.session.gatewaySettings.captionConfigFingerprint, geminiCaptionConfigFingerprint(h.session.gatewaySettings.captionConfig));
  assert.equal(h.calls[1].body.version, 7);
  assert.equal(h.calls[1].body.modelPreferences, undefined, "activation never sends preferences back");
});

test("an invalid DB engine blocks activation and a failed CAS leaves the previous snapshot intact", async () => {
  const invalid = startHarness({ engine: { stt: { provider: "nope", model: "x" } } });
  assert.equal((await invalid.start(invalid.session)).code, "ENGINE_SELECTION_INVALID");
  assert.equal(invalid.calls.length, 1);
  const stale = startHarness(dbPreferences, false);
  const previousConfig = stale.session.gatewaySettings.captionConfig;
  assert.equal((await stale.start(stale.session)).code, "VERSION_CONFLICT");
  sameEngine(stale.session.modelPreferences.engine, soniox);
  assert.equal(stale.session.gatewaySettings.captionConfig, previousConfig, "failed CAS cannot replace the previous config snapshot");
});

test("optional local settings failure never removes the session engine pin during arming", async () => {
  const h = armHarness();
  h.scope.settingsStore = { load: async () => { throw new Error("synthetic settings unavailable"); } };
  const result = await h.arm({ id: "call", status: "preparing", modelPreferences: dbPreferences }, { languages: ["ko", "en"] });
  assert.equal(result.ok, true);
  assertEngine(h.scope.liveCallSession.gatewaySettings.captionConfig, gemini37);
});

test("malformed stored model-preference shapes stop activation without defaulting to another engine", async () => {
  for (const malformed of [null, [], {}, { engine: undefined }, { engineHistory: [] }, { engine: DEFAULT_ENGINE_SELECTION, summary: "gemini-3.6-flash" }]) {
    const h = startHarness(malformed);
    assert.equal((await h.start(h.session)).code, "ENGINE_SELECTION_INVALID", JSON.stringify(malformed));
    assert.equal(h.calls.length, 1);
    sameEngine(h.session.modelPreferences.engine, soniox);
  }
});

test("the desktop no longer imports the Gemini model shim for Live Call preferences", () => {
  assert.doesNotMatch(main, /gemini-model-catalog\.js|GeminiModelSelectionError|migrateLegacyGeminiModelSelection|INVALID_GEMINI_MODEL_SELECTION/u);
  assert.match(main, /"ENGINE_SELECTION_INVALID"/u);
});


test("desktop session assignment lookup fails closed and never buys the default engine on failure", async () => {
  const seedSource = section("async function seedLiveCallEngineDefaults", "async function openLiveStageOverlay");
  for (const result of [{ok:false,code:'AUTH_REQUIRED'}, {ok:true,data:{}}, {ok:true,data:{engineDefaults:null}}]) {
    const seed=vm.runInNewContext(`${helpers}\n${seedSource}\nseedLiveCallEngineDefaults`, context({liveCallApi:async()=>result}));
    await assert.rejects(seed('https://example.test'), /배정된 자막 엔진/u);
  }
  const seed=vm.runInNewContext(`${helpers}\n${seedSource}\nseedLiveCallEngineDefaults`, context({liveCallApi:async()=>({ok:true,data:{engineDefaults:gemini37}})}));
  sameEngine((await seed('https://example.test')).engine,gemini37);
});
