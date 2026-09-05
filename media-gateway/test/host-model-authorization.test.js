import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiCaptionConfig } from "../../packages/caption-core/gemini-caption-contract.js";
import { DEFAULT_ENGINE_SELECTION } from "../../packages/caption-core/caption-engine-catalog.js";
import { SupabaseHostAuthorizer } from "../src/supabase-adapters.js";

const claims = { role: "HOST", sub: "host-1", sessionId: "session-1" };
const settings = { sessionId: "session-1", version: 7, sessionType: "meeting", outputMode: "captions", maxViewers: 50, languages: ["ko", "en"] };
const baseRow = { id: "session-1", host_id: "host-1", status: "live", version: 7, session_type: "meeting", output_mode: "captions", max_viewers: 50, languages: ["ko", "en"], pinned_glossary_fingerprint: null };
// Ids the pre-Plan-2 webapp stored per role. Summary pins are the flash ids;
// source pins are the two Live models (readStoredGeminiModelSelection is per
// role: a flash id as a SOURCE was never written and fails closed — Task 4 fix M1).
const legacyModels = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"];
const legacySources = ["gemini-3.5-transcribe-live", "gemini-3.5-live-translate-preview"];
const soniox = {
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.7-flash" },
};
const gemini37 = { ...DEFAULT_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.7-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } };
const history = [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "2026-09-04T09:00:00.000Z", byHostId: "admin-1" }];

function captionConfig(engine = DEFAULT_ENGINE_SELECTION) {
  return createGeminiCaptionConfig({ languages: settings.languages, outputMode: settings.outputMode, engine });
}
function harness(row) {
  const queries = [];
  const authorizer = new SupabaseHostAuthorizer({
    baseUrl: "https://local-test.invalid", serviceRoleKey: "fake-credential",
    async fetchFn(url) { queries.push(new URL(url)); return Response.json([row]); },
  });
  return { authorizer, queries };
}
const authorize = (row, captionConfigValue, options = { requireLive: true }) =>
  harness(row).authorizer.authorize(claims, captionConfigValue === undefined ? settings : { ...settings, captionConfig: captionConfigValue }, options);

test("the stored engine is the only engine a host may run: same engine authorizes, any other engine is rejected", async () => {
  for (const stored of [DEFAULT_ENGINE_SELECTION, gemini37, soniox]) {
    const row = { ...baseRow, event_metadata: { modelPreferences: { engine: stored, engineHistory: history } } };
    for (const options of [{}, { requireLive: true }, { readinessStart: true }, { requireLive: true, compareVersion: false }]) {
      assert.notEqual(await authorize({ ...row, status: options.readinessStart ? "preparing" : "live" }, captionConfig(stored), options), false, JSON.stringify([stored.stt.provider, options]));
      for (const other of [DEFAULT_ENGINE_SELECTION, gemini37, soniox].filter((candidate) => candidate !== stored)) {
        assert.equal(await authorize(row, captionConfig(other), options), false, `${stored.stt.provider} row must reject a ${other.stt.provider}/${other.summary.model} caller`);
      }
    }
    // languageMode is part of the engine identity.
    if (stored === soniox) assert.equal(await authorize(row, captionConfig({ ...soniox, stt: { ...soniox.stt, languageMode: "auto" } })), false);
  }
});

test("known historical per-role pins migrate to the engine they meant and stay untouched; a caller sending that engine is authorized", async () => {
  for (const source of legacySources) {
    for (const summary of legacyModels) {
      const preferences = { source, summary };
      const { authorizer, queries } = harness({ ...baseRow, event_metadata: { modelPreferences: preferences } });
      // The desktop and the web host derive the same engine from the same legacy pin.
      const current = createGeminiCaptionConfig({ languages: settings.languages, outputMode: settings.outputMode, geminiTranscribeModel: source, geminiSummaryModel: summary });
      assert.equal(current.engine.stt.model, "gemini-3.5-transcribe-live");
      assert.equal(current.engine.summary.model, summary === "gemini-3.5-flash" ? "gemini-3.6-flash" : summary);
      assert.equal(await authorizer.authorize(claims, { ...settings, captionConfig: current }, { requireLive: true }), true, `${source}/${summary}`);
      assert.deepEqual(preferences, { source, summary }, "history is evidence, never rewritten");
      assert.ok(queries[0].searchParams.get("select").split(",").includes("event_metadata"));
      // A caller running a different summary than the migrated pin is rejected.
      const otherSummary = summary === "gemini-3.7-flash" ? "gemini-3.6-flash" : "gemini-3.7-flash";
      assert.equal(await authorize({ ...baseRow, event_metadata: { modelPreferences: preferences } },
        captionConfig({ ...DEFAULT_ENGINE_SELECTION, summary: { provider: "gemini", model: otherSummary } })), false);
    }
  }
});

test("forged model overrides beside the engine are denied for preparation, first start, readiness and lease reauthorization", async () => {
  for (const options of [{}, { requireLive: true }, { readinessStart: true }, { requireLive: true, compareVersion: false }]) {
    const current = captionConfig();
    for (const modelChange of [
      { transcription: "gemini-3.7-flash" }, { summary: "gemini-3.5-flash" }, { summary: "gemini-3.7-flash" },
      { transcription: "arbitrary-provider" }, { summary: "https://169.254.169.254/model" },
    ]) {
      const change = { ...current, models: { ...current.models, ...modelChange } };
      assert.equal(await authorize({ ...baseRow, event_metadata: { modelPreferences: { engine: DEFAULT_ENGINE_SELECTION } } }, change, options), false, JSON.stringify(modelChange));
    }
    for (const engineChange of [
      { stt: { provider: "attacker", model: "x", languageMode: "auto" } },
      { stt: { provider: "gemini", model: "gemini-3.5-live-translate-preview", languageMode: "auto" } },
      { translation: { provider: "soniox", model: "stt-rt-v5" } },
      { summary: { provider: "gemini", model: "gemini-3.5-flash-lite" } },
    ]) {
      const change = { ...current, engine: { ...current.engine, ...engineChange } };
      assert.equal(await authorize({ ...baseRow, event_metadata: { modelPreferences: { engine: DEFAULT_ENGINE_SELECTION } } }, change, options), false, JSON.stringify(engineChange));
    }
  }
  const { authorizer } = harness({ ...baseRow, status: "preparing", event_metadata: { modelPreferences: { source: legacySources[1], summary: legacyModels[2] } } });
  assert.deepEqual(await authorizer.authorize(claims, settings, { readinessStart: true }), {
    pinnedGlossaryFingerprint: null, readinessMode: "activate", sessionStatus: "preparing",
  }, "a prepared call whose legacy pin migrates to the catalog default can start without a captionConfig");
});

test("absent preferences mean the catalog default; malformed, unknown, or partially-legacy shapes fail closed", async () => {
  for (const metadata of [undefined, null, {}, { agenda: [] },
    { modelPreferences: { engine: DEFAULT_ENGINE_SELECTION } },
    { modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] } },
    { modelPreferences: { engine: { translation: { provider: "gemini", model: "gemini-3.6-flash" } } } },
    { modelPreferences: { source: "gemini-3.5-live-translate-preview", summary: "gemini-3.6-flash" } },
    { modelPreferences: { source: "gemini-3.5-transcribe-live", summary: "gemini-3.5-flash" } }]) {
    assert.equal(await authorize({ ...baseRow, event_metadata: metadata }), true, JSON.stringify(metadata));
  }
  for (const metadata of [[], "invalid", { modelPreferences: null }, { modelPreferences: {} }, { modelPreferences: [] },
    { modelPreferences: { source: legacyModels[0] } }, { modelPreferences: { source: legacyModels[0], summary: "https://169.254.169.254/model" } },
    { modelPreferences: { source: "unknown-model", summary: legacyModels[0] } },
    { modelPreferences: { source: legacyModels[0], summary: legacyModels[0] } }, { modelPreferences: { source: legacyModels[1], summary: legacyModels[2] } },
    { modelPreferences: { source: legacySources[0], summary: legacySources[0] } },
    { modelPreferences: { source: legacyModels[0], summary: legacyModels[0], model: legacyModels[1] } },
    { modelPreferences: { source: legacyModels[0], summary: legacyModels[0], engine: DEFAULT_ENGINE_SELECTION } },
    { modelPreferences: { engine: null } }, { modelPreferences: { engine: "gemini" } }, { modelPreferences: { engine: [] } },
    { modelPreferences: { engine: { stt: { provider: "attacker", model: "x", languageMode: "auto" } } } },
    { modelPreferences: { engine: { ...soniox, stt: DEFAULT_ENGINE_SELECTION.stt } } },
    { modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, apiKey: "private" } },
    { modelPreferences: { engineHistory: history } }]) {
    assert.equal(await authorize({ ...baseRow, event_metadata: metadata }), false, JSON.stringify(metadata));
  }
  // A stored non-default engine with a default caller (no captionConfig) is a mismatch, not a fallback.
  assert.equal(await authorize({ ...baseRow, event_metadata: { modelPreferences: { engine: gemini37 } } }), false);
  assert.equal(await authorize({ ...baseRow, event_metadata: { modelPreferences: { source: "gemini-3.5-transcribe-live", summary: "gemini-3.7-flash" } } }), false);
});

test("matching engines never bypass role, owner, session status or version checks", async () => {
  const pinned = { ...settings, captionConfig: captionConfig(soniox) };
  const row = { ...baseRow, event_metadata: { modelPreferences: { engine: soniox, engineHistory: history } } };
  assert.equal(await harness(row).authorizer.authorize(claims, pinned, { requireLive: true }), true);
  for (const patch of [{ host_id: "different-host" }, { status: "stopped" }, { status: "failed" }, { version: 8 }]) {
    assert.equal(await harness({ ...row, ...patch }).authorizer.authorize(claims, pinned, { requireLive: true }), false, JSON.stringify(patch));
  }
  assert.equal(await harness(row).authorizer.authorize({ ...claims, role: "VIEWER" }, pinned, { requireLive: true }), false);
});
