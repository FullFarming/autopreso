import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { mountCaptionEngineSettings, normalizeCaptionEngineCatalog } from "../public/subtitle-model-settings.js";

// jsdom is not a devDependency of this repo, so the form is a hand-made fake
// with the same surface the module touches (elements, querySelector,
// ownerDocument.createElement, addEventListener/dispatchEvent).
class FakeSelect extends EventTarget {
  constructor(ownerDocument) {
    super();
    this.value = "";
    this.disabled = false;
    this.options = [];
    this.ownerDocument = ownerDocument;
  }
  replaceChildren(...children) {
    const previous = this.value;
    this.options = children;
    this.value = children.some((option) => option.value === previous) ? previous : children[0]?.value ?? "";
  }
}

const catalog = {
  stt: [
    { provider: "gemini", model: "gemini-3.5-transcribe-live", label: "Gemini 3.5 Transcribe Live", requiredApiKey: "gemini", available: true, languageModes: ["auto"] },
    { provider: "soniox", model: "stt-rt-v5", label: "Soniox stt-rt-v5", requiredApiKey: "soniox", available: false, languageModes: ["auto", "ko", "en"] },
  ],
  translation: [
    { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", requiredApiKey: "gemini", available: true, languageModes: [] },
    { provider: "soniox", model: "stt-rt-v5", label: "Soniox", requiredApiKey: "soniox", available: false, languageModes: [], requiresSttProvider: "soniox" },
  ],
  summary: [
    { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", requiredApiKey: "gemini", available: true, languageModes: [] },
    { provider: "gemini", model: "gemini-3.7-flash", label: "Gemini 3.7 Flash", requiredApiKey: "gemini", available: true, languageModes: [] },
  ],
  defaults: {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.6-flash" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  },
};
// The saved engine differs from the catalog defaults by exactly one role so a
// deliberate selection produces a real save instead of a no-op.
const nonDefaultEngine = { ...catalog.defaults, summary: { provider: "gemini", model: "gemini-3.7-flash" } };
const option = (select, value) => select.options.find((entry) => entry.value === value);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ engine = nonDefaultEngine, save = async () => {} } = {}) {
  const ownerDocument = { createElement: () => ({ value: "", textContent: "", disabled: false }) };
  const fields = Object.fromEntries(["engineStt", "engineLanguageMode", "engineTranslation", "engineSummary"]
    .map((name) => [name, new FakeSelect(ownerDocument)]));
  const status = { textContent: "" };
  const form = {
    elements: fields,
    ownerDocument,
    querySelector: (selector) => (selector === "[data-caption-engine-status]" ? status : null),
  };
  let settings = { engine };
  const saved = [];
  const errors = [];
  const controls = mountCaptionEngineSettings({
    form,
    getSettings: () => settings,
    save: async (patch) => { saved.push(patch); await save(); },
    onSaved: (patch) => { settings = { ...settings, ...patch }; },
    onError: (error) => errors.push(error),
    translate: (key) => key,
  });
  return { controls, form, fields, status, saved, errors, settings: () => settings };
}

test("catalog normalization rejects malformed entries and keeps availability", () => {
  assert.equal(normalizeCaptionEngineCatalog(null), null);
  const view = normalizeCaptionEngineCatalog(catalog);
  assert.equal(view.stt[1].available, false);
  assert.equal(view.translation[1].requiresSttProvider, "soniox");
  assert.equal(normalizeCaptionEngineCatalog({ ...catalog, stt: [{ provider: "x y", model: "z", label: "", available: true, languageModes: [] }] }), null);
  for (const bad of [
    {},
    { ...catalog, defaults: { ...catalog.defaults, stt: { provider: "gemini", model: "forged" } } },
    { ...catalog, stt: [{ ...catalog.stt[0], model: "javascript:alert(1)" }] },
    { ...catalog, stt: [{ ...catalog.stt[0], label: "<img onerror=bad>" }] },
    { ...catalog, stt: [catalog.stt[0], catalog.stt[0]] },
    { ...catalog, stt: [{ ...catalog.stt[0], available: "yes" }] },
    { ...catalog, summary: [] },
  ]) assert.equal(normalizeCaptionEngineCatalog(bad), null, JSON.stringify(bad).slice(0, 80));
});

test("selecting an engine saves subtitle.engine and disables options whose key is missing", async () => {
  const h = harness();
  h.controls.setCatalog(catalog);
  const stt = h.fields.engineStt;
  assert.equal(stt.options.length, 2);
  assert.equal(option(stt, "soniox:stt-rt-v5").disabled, true, "no soniox key -> disabled");
  assert.equal(h.fields.engineLanguageMode.disabled, true, "gemini has only auto");
  h.fields.engineTranslation.value = "gemini:gemini-3.6-flash";
  h.fields.engineSummary.value = "gemini:gemini-3.6-flash";
  h.fields.engineSummary.dispatchEvent(new Event("change"));
  await tick();
  assert.deepEqual(h.saved.at(-1), { engine: catalog.defaults });
  assert.equal(h.status.textContent, "engine.appliesNow");
});

test("an unchanged or forged selection never writes settings", async () => {
  const h = harness({ engine: catalog.defaults });
  h.controls.setCatalog(catalog);
  h.fields.engineSummary.dispatchEvent(new Event("change"));
  await tick();
  assert.deepEqual(h.saved, [], "re-selecting the saved engine is not a paid change");
  h.fields.engineStt.value = "openai:whisper-forged";
  h.fields.engineStt.dispatchEvent(new Event("change"));
  await tick();
  assert.deepEqual(h.saved, []);
  assert.equal(h.fields.engineStt.value, "gemini:gemini-3.5-transcribe-live", "the saved engine is restored");
});

test("the language mode list follows the selected STT engine and a combined translation is gated on it", async () => {
  const withKeys = {
    ...catalog,
    stt: catalog.stt.map((entry) => ({ ...entry, available: true })),
    translation: catalog.translation.map((entry) => ({ ...entry, available: true })),
  };
  const h = harness({ engine: catalog.defaults });
  h.controls.setCatalog(withKeys);
  assert.equal(option(h.fields.engineTranslation, "soniox:stt-rt-v5").disabled, true, "soniox translation needs the soniox STT");
  h.fields.engineStt.value = "soniox:stt-rt-v5";
  h.fields.engineStt.dispatchEvent(new Event("change"));
  await tick();
  assert.deepEqual(h.saved.at(-1).engine.stt, { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" });
  assert.deepEqual(h.fields.engineLanguageMode.options.map((entry) => entry.value), ["auto", "ko", "en"]);
  assert.equal(h.fields.engineLanguageMode.disabled, false);
  assert.equal(option(h.fields.engineTranslation, "soniox:stt-rt-v5").disabled, false);
  h.fields.engineLanguageMode.value = "ko";
  h.fields.engineLanguageMode.dispatchEvent(new Event("change"));
  await tick();
  assert.equal(h.saved.at(-1).engine.stt.languageMode, "ko");
  h.fields.engineTranslation.value = "soniox:stt-rt-v5";
  h.fields.engineTranslation.dispatchEvent(new Event("change"));
  await tick();
  assert.deepEqual(h.saved.at(-1).engine.translation, { provider: "soniox", model: "stt-rt-v5" });
  // Switching back to a Gemini STT must not submit the now-incompatible
  // Soniox translation: the server rejects that pair outright.
  h.fields.engineStt.value = "gemini:gemini-3.5-transcribe-live";
  h.fields.engineStt.dispatchEvent(new Event("change"));
  await tick();
  assert.deepEqual(h.saved.at(-1).engine.translation, catalog.defaults.translation);
  assert.equal(h.saved.at(-1).engine.stt.languageMode, "auto", "gemini does not support a restricted input language");
});

test("a rejected save reports the failure, restores the saved engine, and requires an explicit retry", async () => {
  const h = harness({ save: async () => { throw new Error("ENGINE_SELECTION_INVALID"); } });
  h.controls.setCatalog(catalog);
  h.fields.engineSummary.value = "gemini:gemini-3.6-flash";
  h.fields.engineSummary.dispatchEvent(new Event("change"));
  await tick();
  assert.equal(h.saved.length, 1);
  assert.equal(h.errors.length, 1);
  assert.equal(h.status.textContent, "engine.saveFailed");
  assert.equal(h.fields.engineSummary.value, "gemini:gemini-3.7-flash", "the stored engine still owns the form");
  await tick();
  assert.equal(h.saved.length, 1, "a failed save never retries itself");
});

test("a second change while a save is in flight is dropped and the selects stay locked", async () => {
  let release = () => {};
  /** @type {Promise<void>} */
  const pending = new Promise((resolve) => { release = () => resolve(undefined); });
  const h = harness({ save: () => pending });
  h.controls.setCatalog(catalog);
  h.fields.engineSummary.value = "gemini:gemini-3.6-flash";
  h.fields.engineSummary.dispatchEvent(new Event("change"));
  assert.equal(h.controls.isSaving(), true);
  assert.equal(h.status.textContent, "engine.saving");
  for (const name of ["engineStt", "engineLanguageMode", "engineTranslation", "engineSummary"]) {
    assert.equal(h.fields[name].disabled, true, `${name} is locked while saving`);
  }
  h.fields.engineStt.dispatchEvent(new Event("change"));
  assert.equal(h.saved.length, 1);
  release();
  await tick();
  assert.equal(h.saved.length, 1);
  assert.equal(h.controls.isSaving(), false);
  assert.equal(h.status.textContent, "engine.appliesNow");
});

test("a missing catalog fails closed without saving anything", () => {
  const h = harness();
  h.controls.setCatalog(null);
  assert.equal(h.status.textContent, "engine.unavailable");
  h.fields.engineSummary.dispatchEvent(new Event("change"));
  assert.deepEqual(h.saved, []);
  for (const field of Object.values(h.fields)) assert.equal(field.disabled, true);
});

test("the Settings picker accepts the shared server catalog and every option validates as an engine", async () => {
  const { captionEngineCatalogForClient } = await import("../packages/caption-core/caption-engine-catalog.js");
  const { validateSubtitleSettings } = await import("../src/settings-store.js");
  const shared = captionEngineCatalogForClient({ hasApiKeys: { gemini: true, soniox: true } });
  const h = harness({ engine: shared.defaults });
  h.controls.setCatalog(shared);
  for (const [role, name] of [["stt", "engineStt"], ["translation", "engineTranslation"], ["summary", "engineSummary"]]) {
    assert.deepEqual(h.fields[name].options.map((entry) => entry.value), shared[role].map((entry) => `${entry.provider}:${entry.model}`));
  }
  for (const entry of shared.stt) {
    for (const languageMode of entry.languageModes) {
      const translation = entry.provider === "soniox" ? { provider: "soniox", model: "stt-rt-v5" } : shared.defaults.translation;
      assert.doesNotThrow(() => validateSubtitleSettings({
        engine: { stt: { provider: entry.provider, model: entry.model, languageMode }, translation, summary: shared.defaults.summary },
      }), `${entry.provider}:${entry.model}/${languageMode}`);
    }
  }
  assert.deepEqual(h.saved, [], "opening Settings never writes");
});

test("Go Live rejects a pending engine save before touching configuration or capture and only retries explicitly", async () => {
  let release = () => {};
  /** @type {Promise<void>} */
  const pending = new Promise((resolve) => { release = () => resolve(undefined); });
  const h = harness({ save: () => pending });
  h.controls.setCatalog(catalog);
  h.fields.engineSummary.value = "gemini:gemini-3.6-flash";
  h.fields.engineSummary.dispatchEvent(new Event("change"));
  assert.equal(h.controls.isSaving(), true);
  const dashboard = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
  const code = dashboard.slice(dashboard.indexOf("async function handleLiveCallPreflight(request)"), dashboard.indexOf("async function cancelLiveCallPreflight(request)"));
  const operations = [];
  const replies = [];
  const context = {
    state: { settings: h.settings() }, captionEngineSettings: h.controls,
    liveBridgePreflightRequestId: null, liveCallProducerCapability: "", isLiveParticipantDemandEnabled: false,
    activeLiveFloorSessionId: "", t: (key) => key,
    readSettingsFromForm: () => { operations.push("read-form"); return h.settings(); },
    saveSettings: async (patch) => { operations.push(["settings-put", patch.subtitle]); },
    ensureWebSocketOpen: async () => { operations.push("websocket"); },
    ensureLiveCallProducerCapability: async () => { operations.push("capability"); },
    startLiveCallMicCapture: async () => { operations.push("capture"); return { ok: true }; },
    requestLocalSubtitlePreflight: async () => { operations.push("validate"); },
    startHybridCaptionSession: async () => { operations.push("relay-start"); },
    stopLiveCallAudioBridge: () => { operations.push("capture-stop"); },
    window: { realtimeNoelDesktop: { completeLiveCallPreflight: async (id, reply) => replies.push([id, reply]) } },
  };
  const preflight = vm.runInNewContext(`${code}\nhandleLiveCallPreflight`, context);
  await preflight({ requestId: "pending-engine", liveSessionId: "call-a" });
  assert.deepEqual(operations, [], "no form/configuration, socket, capture, or provider mutation while saving");
  assert.equal(context.liveBridgePreflightRequestId, null);
  assert.equal(replies[0][1].ok, false);
  assert.equal(replies[0][1].code, "SUBTITLE_SESSION_TRANSITION_PENDING");
  assert.equal(replies[0][1].message, "engine.saving");
  release();
  await tick();
  assert.deepEqual(operations, [], "completing an engine save cannot automatically retry a paid start");
  await preflight({ requestId: "explicit-retry", liveSessionId: "call-a" });
  assert.equal(replies[1][1].ok, true);
  assert.deepEqual(context.state.settings.engine, catalog.defaults);
  assert.equal(operations.filter((operation) => operation === "relay-start").length, 1);
});
