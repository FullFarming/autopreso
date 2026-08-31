import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("system language repaint preserves unsaved translation targets and glossary without new requests", () => {
  const source = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function refreshSystemLanguagePresentation()");
  assert.ok(start >= 0);
  const end = source.indexOf("subscribeToLanguage(refreshSystemLanguagePresentation);", start);
  assert.ok(end > start);
  const inputs = [
    { name: "translationLanguages", value: "ko", checked: true },
    { name: "translationLanguages", value: "en", checked: false },
    { name: "translationLanguages", value: "ja", checked: true },
    { name: "liveCallTranslationLanguages", value: "ja", checked: true },
  ];
  /** @type {[string, string, { persistConfirmedMissing: boolean }]} */
  let restoredPreset = ["", "", { persistConfirmedMissing: true }];
  let filters = 0;
  let visiblePlacementLanguages;
  const noCall = () => { throw new Error("system language must not call the engine, overwrite settings, or fetch records"); };
  const context = vm.createContext({
    form: { querySelectorAll: () => inputs },
    selectedGlossaryPresetId: () => "unsaved-preset",
    selectedGlossaryPresetName: () => "User draft glossary",
    renderLanguagePills: () => { inputs[1].checked = true; },
    renderLiveCallLanguagePills: () => { inputs[3].checked = false; },
    renderPlacementRows() {}, renderGlossaryPresetOptions() {},
    readTranslationLanguagesFromForm: () => inputs.filter((input) => input.name === "translationLanguages" && input.checked).map((input) => input.value),
    syncPlacementRows: (languages) => { visiblePlacementLanguages = languages; },
    restoreGlossaryPresetSelection: (id, name, options) => { restoredPreset = [id, name, options]; },
    updateLanguageDropdownSummaries() {}, renderLanguageChips() {}, updatePtOutputControls() {},
    updateAudioInspectorLabels() {}, updateSessionSummary() {}, updateServiceStrip() {}, renderHistory() {},
    applySessionRecordFilters: () => { filters += 1; }, state: { history: {}, settings: { translationLanguages: ["ko", "en"] } },
    writeSettingsToForm: noCall, loadSessionRecords: noCall, fetch: noCall,
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext("refreshSystemLanguagePresentation()", context);
  assert.deepEqual(inputs.map((input) => input.checked), [true, false, true, true]);
  assert.ok(restoredPreset);
  assert.equal(restoredPreset[0], "unsaved-preset");
  assert.equal(restoredPreset[1], "User draft glossary");
  assert.equal(restoredPreset[2].persistConfirmedMissing, false);
  assert.equal(filters, 1);
  assert.deepEqual(visiblePlacementLanguages, ["ko", "ja"]);
});
