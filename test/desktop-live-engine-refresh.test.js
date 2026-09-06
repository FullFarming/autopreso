import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
import { DEFAULT_ENGINE_SELECTION, EngineSelectionError, engineSelectionKey, normalizeEngineSelection } from "../packages/caption-core/caption-engine-catalog.js";

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
function section(start, end) {
  const from = main.indexOf(start);
  const to = main.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} must exist`);
  return main.slice(from, to);
}
const helpers = section("function readLiveCallModelPreferences", "function sanitizeLiveCallDraft");
const refresh = vm.runInNewContext(`${helpers}\nrefreshLiveCallEngineFromSession`, {
  createGeminiCaptionConfig, geminiCaptionConfigFingerprint, DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection,
});
const soniox = normalizeEngineSelection({
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.7-flash" },
});
function armed(engine = DEFAULT_ENGINE_SELECTION) {
  const captionConfig = createGeminiCaptionConfig({ engine, languages: ["ko", "en"], glossaryText: "Hilton=힐튼", translationTone: "business", domainText: "hotel" });
  return {
    modelPreferences: { engine },
    gatewaySettings: { outputMode: "captions", languages: ["ko", "en"], glossaryText: "Hilton=힐튼", captionConfig, captionConfigFingerprint: geminiCaptionConfigFingerprint(captionConfig) },
  };
}

// Plan 2 Task 5 follow-up: an admin can switch a RUNNING Live Call's engine
// (POST /internal/sessions/:id/engine). The gateway then serves the new engine,
// but this process still carried the arm-time captionConfig; re-sending it on a
// reconnect made isSameHostSettings fail, the gateway rebuilt with the OLD
// engine, and the authorizer's engine parity check ended the session with
// SESSION_REVOKED. Every bridge (re)start now re-pins the engine from the
// session record it already reads.
test("a changed session engine re-pins the caption config and its fingerprint, keeping glossary/tone/domain", () => {
  const session = armed();
  const before = session.gatewaySettings.captionConfigFingerprint;
  assert.equal(refresh(session, { modelPreferences: { engine: soniox, engineHistory: [{ engine: soniox, changedAt: "2026-09-05T00:00:00.000Z", byHostId: "admin" }] } }), true);
  assert.equal(engineSelectionKey(session.modelPreferences.engine), engineSelectionKey(soniox));
  assert.equal(Object.hasOwn(session.modelPreferences, "engineHistory"), false, "history is server-owned and never sent back");
  const { captionConfig, captionConfigFingerprint } = session.gatewaySettings;
  assert.equal(engineSelectionKey(captionConfig.engine), engineSelectionKey(soniox));
  assert.equal(captionConfig.models.transcription, "stt-rt-v5");
  assert.equal(captionConfigFingerprint, geminiCaptionConfigFingerprint(captionConfig));
  assert.notEqual(captionConfigFingerprint, before);
  assert.equal(captionConfig.glossary, "Hilton=힐튼");
  assert.equal(captionConfig.tone, "business");
  assert.equal(captionConfig.domain, "hotel");
  assert.deepEqual(captionConfig.languages, ["ko", "en"]);
  assert.equal(session.gatewaySettings.outputMode, "captions", "unrelated gateway settings survive the re-pin");
});

test("an unchanged engine leaves the gateway settings object and fingerprint untouched", () => {
  const session = armed();
  const settings = session.gatewaySettings;
  assert.equal(refresh(session, { modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] } }), false);
  assert.equal(session.gatewaySettings, settings);
  assert.equal(engineSelectionKey(session.modelPreferences.engine), engineSelectionKey(DEFAULT_ENGINE_SELECTION));
  // An absent field is the catalog default, exactly like the start intent reads it.
  const seeded = armed(soniox);
  assert.equal(refresh(seeded, {}), true);
  assert.equal(engineSelectionKey(seeded.gatewaySettings.captionConfig.engine), engineSelectionKey(DEFAULT_ENGINE_SELECTION));
});

test("before the caption preflight there is no config to re-pin; malformed preferences fail closed", () => {
  const session = { modelPreferences: { engine: DEFAULT_ENGINE_SELECTION }, gatewaySettings: { outputMode: "captions", languages: ["ko", "en"] } };
  assert.equal(refresh(session, { modelPreferences: { engine: soniox } }), false);
  assert.equal(engineSelectionKey(session.modelPreferences.engine), engineSelectionKey(soniox));
  assert.equal(Object.hasOwn(session.gatewaySettings, "captionConfig"), false);
  for (const bad of [{ engine: "stt-rt-v5" }, { engine: { stt: { provider: "nope", model: "x" } } }, { source: "gemini-3.5-transcribe-live", summary: "gemini-3.7-flash" }, null]) {
    const untouched = armed();
    const settings = untouched.gatewaySettings;
    assert.throws(() => refresh(untouched, { modelPreferences: bad }), EngineSelectionError);
    assert.equal(untouched.gatewaySettings, settings, "a rejected record must not half-apply");
  }
});

test("the desktop bridge re-pins the engine from the session read it performs before every gateway (re)start", () => {
  const ensure = section("async function ensureLiveGatewayBridgeOnce", "async function ensureLiveGatewayBridgeForStatus");
  const refreshAt = ensure.indexOf("refreshLiveCallEngineFromSession(armedSession, currentSession.data)");
  assert.ok(refreshAt >= 0, "the bridge start must refresh the engine from GET /api/live-sessions/:id");
  assert.ok(refreshAt > ensure.indexOf("code: \"SESSION_ENDED\""), "only a live/preparing session is refreshed");
  assert.ok(refreshAt < ensure.indexOf("new WebSocket(connection.gatewayUrl"), "the refresh must precede the socket that sends `start`");
  assert.match(ensure.slice(refreshAt, refreshAt + 400), /return \{ ok: false, code: "ENGINE_SELECTION_INVALID" \};/u);
  // The `start`/`restart` message spreads the (re-pinned) gateway settings verbatim.
  assert.match(ensure, /type: isManualRestart \? "restart" : "start",\s*sessionId: armedSession\.sessionId,\s*\.\.\.\(armedSession\.gatewaySettings \?\? \{\}\),/u);
  // The start intent keeps its own read of the same record (not replaced by this helper).
  assert.match(section("async function requestDesktopLiveStartIntent", "async function startDesktopLiveDemand"), /readLiveCallModelPreferences\(current\.data\.modelPreferences\)/u);
});
