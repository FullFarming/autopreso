import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import { MESSAGES } from "../public/subtitle-i18n.js";
import { DEFAULT_SUBTITLE_SETTINGS, validateSubtitleSettings } from "../src/settings-store.js";

// UI copy lives in the i18n dictionary now: surfaces carry the KEY and the copy
// must resolve in both languages (test/ui-i18n.test.js proves key parity).
/** @param {string} key @param {{ en?: RegExp, ko?: RegExp }} [patterns] */
function assertLocalized(key, patterns = {}) {
  assert.equal(typeof MESSAGES.en[key], "string", `missing en copy for ${key}`);
  assert.equal(typeof MESSAGES.ko[key], "string", `missing ko copy for ${key}`);
  if (patterns.en) assert.match(MESSAGES.en[key], patterns.en);
  if (patterns.ko) assert.match(MESSAGES.ko[key], patterns.ko);
}

const rootDir = path.join(import.meta.dirname, "..");

function extractFunctionBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.ok(signatureIndex >= 0, `${signature} must exist`);
  const openingBraceIndex = source.indexOf("{", signatureIndex + signature.length);
  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBraceIndex + 1, index);
  }
  assert.fail(`${signature} must have a closing brace`);
}

function extractBalancedStatement(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.ok(signatureIndex >= 0, `${signature} must exist`);
  const openingBraceIndex = source.indexOf("{", signatureIndex + signature.length);
  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(signatureIndex, index + 1);
  }
  assert.fail(`${signature} must have a closing brace`);
}

// There used to be a root-vs-public sync test here, plus three more like it in
// other files. The root-level subtitle-* duplicates they policed have been
// deleted: nothing referenced them, src/server.js serves public/ only, and npm
// `files` / electron-builder `build.files` ship public/ only -- so editing a root
// copy changed nothing in the running app while looking like real work. public/
// is now the single copy, and there is nothing left to keep in sync.

test("public is the only shipped subtitle frontend source", () => {
  for (const file of [
    "subtitle.html",
    "subtitle-dashboard.js",
    "subtitle-controller.html",
    "subtitle-controller.js",
  ]) {
    assert.equal(existsSync(path.join(rootDir, file)), false, `${file} must not regain a stale root duplicate`);
    assert.equal(existsSync(path.join(rootDir, "public", file)), true, `public/${file} is the runtime source`);
  }
});

test("glossary presets restore exactly and expose accessible synced-preset controls", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");

  assert.match(html, /<label[^>]*for="glossary-preset"/);
  assert.match(html, /<select id="glossary-preset" name="glossaryPreset"[^>]*aria-describedby="glossary-preset-help glossary-preset-status"/);
  assert.match(html, /id="glossary-preset-builtins"/);
  assert.match(html, /id="glossary-preset-users"/);
  assert.match(html, /id="create-glossary-preset"[^>]*data-i18n="glossary\.create"/);
  assert.match(html, /<label[^>]*for="glossary-preset-name"/);
  assert.match(html, /id="glossary-preset-name"[^>]*required/);
  assert.match(html, /id="save-glossary-preset"/);
  assert.match(html, /id="update-glossary-preset"/);
  assert.match(html, /id="delete-glossary-preset"/);
  assert.match(html, /id="confirm-delete-glossary-preset"/);
  assert.match(html, /id="cancel-delete-glossary-preset"/);
  assert.match(html, /id="glossary-preset-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="glossary-session-selection"/);
  assert.match(html, /id="glossary-selection-count"[^>]*aria-live="polite"/);
  assert.match(html, /id="glossary-selection-builtins"/);
  assert.match(html, /id="glossary-selection-users"/);
  assert.match(html, /<textarea name="glossary"[^>]*maxlength="40000"/,
    "the editor must accept every full built-in corpus allowed by local settings");

  assert.match(js, /DEFAULT_GLOSSARY_PRESET_ID = "default-cre-ai-en-ko"/);
  assert.match(js, /glossaryPresetId: selectedGlossaryPresetId\(\)/,
    "the selected preset id must travel with the persisted subtitle settings");
  assert.match(js, /glossaryPresetName: selectedGlossaryPresetName\(\)/,
    "a synced preset name must be cached with its id for offline restart labels");
  assert.match(js, /restoreGlossaryPresetSelection\(settings\.glossaryPresetId/,
    "form hydration must restore the persisted id after restart");
  assert.match(js, /appendCachedGlossaryPresetOption/);
  assert.match(js, /editingCustomPreset = selectedUserPreset/,
    "manual edits switch to Custom without losing the version needed by Save changes");
  assert.match(js, /window\.realtimeNoelDesktop\?\.listGlossaryPresets/);
  assert.match(js, /invokeGlossaryPresetBridge\(\s*"createGlossaryPreset"/);
  assert.match(js, /invokeGlossaryPresetBridge\("updateGlossaryPreset"/);
  assert.match(js, /invokeGlossaryPresetBridge\("deleteGlossaryPreset"/);
  assert.match(js, /GLOSSARY_PRESET_VERSION_CONFLICT/);
  assert.match(js, /glossaries: selectedGlossaries\(\)/u);
  assert.match(js, /MAX_GLOSSARY_SELECTIONS = 5/u);
  assert.match(js, /glossary\.selection\.targetIncompatible/u);
  assertLocalized("glossary.selection.targetIncompatible", { ko: /현재 번역 언어/u });
  assert.match(js, /GLOSSARY_SELECTION_CONFLICT|번역이 충돌/u);
  assert.match(js, /version < 1/);
  assert.match(js, /NETWORK_UNAVAILABLE/);
  assert.match(js, /HOST_LOGIN_REQUIRED/);
  assert.match(js, /markGlossaryPresetCustom/);
  assert.match(js, /event\.target === form\.elements\.glossary[\s\S]*?event\.target === form\.elements\.translationDomain/,
    "manual glossary or domain edits must leave the old preset id behind");
  assert.match(js, /function markGlossaryPresetCustom\(\)[\s\S]*?glossaryPresetId: "", glossaryPresetName: ""/);
  const manualCustomIndex = js.indexOf("markGlossaryPresetCustom();");
  const genericReadIndex = js.indexOf("state.settings = readSettingsFromForm();", manualCustomIndex);
  const genericSaveIndex = js.indexOf("saveSettings({ subtitle: state.settings })", genericReadIndex);
  assert.ok(manualCustomIndex >= 0 && genericReadIndex > manualCustomIndex && genericSaveIndex > genericReadIndex,
    "the generic form path must persist cleared preset id/name after a manual edit");

  assert.match(css, /\.glossary-preset-actions[\s\S]*?min-height: 44px/,
    "preset actions must keep a 44px touch target even when compact buttons are used");
  assert.match(css, /\.glossary-preset-editor[\s\S]*?display: grid/);
  assert.match(css, /\.glossary-selection-option[\s\S]*?min-height:\s*44px/u);
  assert.match(css, /\.glossary-selection-option input:focus-visible[\s\S]*?outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.glossary-preset-editor/);
  assert.match(js, /openGlossaryPresetDeleteConfirmation/);
  assert.match(js, /confirmDeleteGlossaryPresetButton\?\.focus\(\)/);
  assert.match(js, /event\.key !== "Escape"/);
  assert.match(js, /deleteGlossaryPresetButton\.focus\(\)/);
  assert.doesNotMatch(html + js, /<dialog|showModal\(|HTMLDialogElement|popover=|window\.confirm/,
    "the editor must not depend on Dialog or Popover APIs");

  assertLocalized("glossary.presetCustomHelp", { ko: /직접 수정했거나.*일치하지 않는/ });
  assertLocalized("glossary.groupBuiltIn", { ko: /내장/ });
  assertLocalized("glossary.groupSynced", { ko: /동기화/ });
  assertLocalized("glossary.error.GLOSSARY_PRESET_VERSION_CONFLICT", { ko: /다른 기기.*변경/ });
  assertLocalized("glossary.error.NETWORK_UNAVAILABLE", { ko: /네트워크/ });
  assertLocalized("glossary.error.HOST_LOGIN_REQUIRED", { ko: /로그인/ });
});

test("subtitle dashboard exposes main controls, Gemma recording, and settings drawer", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");

  for (const section of ["prepare", "meeting", "records", "settings"]) {
    assert.match(html, new RegExp(`class="rail-nav-section"[^>]*data-rail-section="${section}"[^>]*role="group"[^>]*aria-labelledby="rail-nav-${section}-label"`, "u"));
    assert.match(html, new RegExp(`id="rail-nav-${section}-label"[^>]*class="rail-nav-section-label"`, "u"));
  }
  const captureJs = readFileSync(path.join(rootDir, "public", "subtitle-audio-capture.js"), "utf8");
  const workspaceJs = readFileSync(path.join(rootDir, "public", "subtitle-workspace.js"), "utf8");
  const controllerHtml = readFileSync(path.join(rootDir, "public", "subtitle-controller.html"), "utf8");
  const controllerJs = readFileSync(path.join(rootDir, "public", "subtitle-controller.js"), "utf8");

  assert.match(html, /<title>NOVA<\/title>/);
  assert.match(html, /value="system_mic"/);
  assert.match(html, /name="openaiKey"/);
  assert.doesNotMatch(html, /name="openaiSecondaryKey"/);
  assert.match(html, /value="system"/);
  assert.match(html, /value="mic"/);
  // Language selection has a single source of truth: the translation-language
  // pills. The legacy Language A / Language B selects were removed.
  assert.doesNotMatch(html, /name="languageA"/);
  assert.doesNotMatch(html, /name="languageB"/);
  assert.match(html, /name="translationLanguages"/);
  assert.match(html, /class="lang-pill"/);
  assert.match(html, /id="language-targets-label"/);
  assert.doesNotMatch(js, /language-search-input|language-suggestions|language-chip-remove/);
  // Source ("원문") display was removed — no toggle, always translation-only.
  assert.doesNotMatch(html, /name="showSourceText"/);
  assert.doesNotMatch(html, /원문 같이 표시/);
  assert.match(html, /name="translateAllLanguages"/);
  assert.match(js, /showSourceText: false/);
  assert.match(js, /translateAllLanguages: false/);
  assert.match(js, /translationLanguages: \["en", "ko"\]/);
  assert.match(js, /form\.elements\.translateAllLanguages/);
  assert.match(js, /readTranslationLanguagesFromForm/);
  // Japanese is a first-class target language (KO↔JA F&B leasing meetings),
  // selectable as one of the subtitle-language pills.
  assert.match(html, /name="translationLanguages" type="checkbox" value="ja"/);
  // languagePair is derived from the selected target languages (the model
  // auto-detects the spoken source), not from removed A/B selects.
  assert.match(js, /deriveLanguagePairFromTargets/);
  assert.match(html, /value="ollama" data-i18n="settings\.topicOllama"/);
  assertLocalized("settings.topicOllama", { en: /Gemma local via Ollama/ });
  assert.match(html, /name="recordProvider"/);
  // Translation tone (register) selector — natural vs business.
  assert.match(html, /name="tone"/);
  assert.match(html, /value="natural"/);
  assert.match(html, /value="business"/);
  assert.match(js, /form\.elements\.tone/);
  // Domain glossary drives terminology-correct translation polish.
  assert.match(html, /name="glossary"/);
  assert.match(js, /form\.elements\.glossary/);
  // The session domain is its own setting (separate from the glossary).
  assert.match(html, /name="translationDomain"/);
  assert.match(js, /form\.elements\.translationDomain/);
  // Engine/domain/glossary are advanced settings: they live INSIDE the
  // settings drawer, not on the main session panel.
  const drawerIndex = html.indexOf('<details class="settings-drawer">');
  assert.ok(drawerIndex > 0, "settings drawer must exist");
  assert.ok(html.indexOf('name="translationProvider"') > drawerIndex, "engine select belongs in the settings drawer");
  assert.ok(html.indexOf('name="translationDomain"') > drawerIndex, "domain belongs in the settings drawer");
  assert.ok(html.indexOf('name="glossary"') > drawerIndex, "glossary belongs in the settings drawer");
  // Un-cleared translation history exports to Excel (CSV download).
  assert.match(html, /id="export-history"/);
  assert.match(js, /export-history/);
  assert.match(js, /history\/export\.csv/);
  // The legacy client-signed QR pairing path is retired. Viewer admission now
  // uses the server-HMAC six-digit Live flow, so no pairing secret or key-sync
  // endpoint may remain in the desktop bundle.
  assert.doesNotMatch(html, /id="pair-generate"|id="pair-qr"|qrcode|supabase/i);
  assert.doesNotMatch(js, /PAIR_SECRET|signPairToken|\/api\/pair-keys|subtitle:mirror/);
  // The desktop creates Live Call directly. It must never expose a web-login
  // launcher, and every session always creates both admission methods.
  assert.doesNotMatch(html, /id="open-meeting-mode"|data-open-live-workspace|name="liveHostWorkspaceUrl"|>Open Live Call</);
  // The explanatory QR/code paragraph was deleted with the rest of the
  // descriptive prose; both admission methods are still always created.
  assert.doesNotMatch(html, /QR and a 6-digit access code are always created together|live-draft-access-note/);
  assert.doesNotMatch(html, /name="liveDraftAccess"|QR 무코드 \+ 코드 링크|코드 필수/);
  assert.match(workspaceJs, /coverImage: liveDraftCoverData/);
  assert.match(workspaceJs, /contentType: file\.type/);
  assert.match(workspaceJs, /base64: window\.btoa\(binary\)/);
  assert.match(workspaceJs, /t\("live\.hostLoginRequired"\)/);
  assertLocalized("live.hostLoginRequired", { en: /Open Settings and sign in/ });
  assert.doesNotMatch(workspaceJs, /Sign in once in the Live workspace window|login page|login screen/i);
  assert.doesNotMatch(html, /id="pt-voice-method-title"|data-i18n="output\.geminiVoice"/);
  assert.doesNotMatch(html, /name="voiceProvider"/);
  // The Gemini-fixed explanation sentence was deleted; the fact remains as a
  // compact label + value note.
  assert.doesNotMatch(html, /자막 엔진은 Gemini 고정이며|pt-voice-method-help/);
  assert.doesNotMatch(html, /name="voiceEngine"/);
  // Built-in industry glossary presets: one click fills glossary + domain +
  // language pair for a prepared meeting type.
  assert.match(html, /name="glossaryPreset"/);
  assert.match(js, /glossary-presets/);
  assert.match(js, /applyGlossaryPreset/);
  // Subtitle settings travel as JSON; API keys remain on the device that stores them.
  assert.match(html, /id="export-settings"/);
  assert.match(html, /id="import-settings"/);
  assert.match(html, /id="import-settings-file"/);
  assert.match(js, /settings\/export/);
  assert.match(js, /importSettingsFromFile/);
  // Fine-grained vertical placement: distance from the anchored edge in px,
  // alongside the top/middle/bottom presets.
  assert.match(html, /name="verticalOffset"/);
  assert.match(js, /verticalOffset/);
  // Per-language subtitle placement on the main panel: each selected language
  // gets its own top/middle/bottom segmented control, plus the shared offset.
  // The old single global position-button row was removed.
  assert.doesNotMatch(html, /id="position-quick"/);
  assert.match(html, /id="subtitle-placement"/);
  assert.match(html, /class="placement-row" data-lang="en"/);
  assert.match(html, /class="placement-row" data-lang="ko"/);
  assert.match(html, /class="placement-row" data-lang="ja"/);
  assert.match(html, /name="pos-en"/);
  assert.match(html, /name="pos-ko"/);
  assert.match(html, /name="pos-ja"/);
  assert.match(js, /syncPlacementRows/);
  assert.match(js, /readSubtitlePositionsFromForm/);
  // Microphone list reliability: refresh when devices change, and unlock
  // device labels (empty before the first permission grant) via a temporary
  // stream so the dropdown shows real microphone names.
  assert.match(js, /addEventListener\("devicechange", hydrateMicrophones\)/);
  assert.match(js, /unlockMicrophoneLabels/);
  // Mid-session language/engine change rebuilds the translation channels in
  // place (re-send subtitle:start with the same sessionId) so stale channels
  // don't keep translating the old configuration.
  assert.match(js, /reconfigureRunningSession/);
  assert.match(js, /CHANNEL_REBUILD_CONTROLS/);
  assert.match(js, /type: "subtitle:start", sessionId: state\.sessionId/);
  // Captions stay on one Gemini contract. OpenAI key settings remain for
  // unrelated whiteboard/agent/transcription features.
  assert.match(html, /name="translationProvider"/);
  assert.match(html, /value="gemini"/);
  assert.doesNotMatch(html, /<select name="translationProvider">/);
  assert.match(html, /data-i18n="output\.engineNote"/);
  assertLocalized("output.engineNote", { ko: /자막 엔진/ });
  assertLocalized("output.engineNoteValue", { ko: /Gemini 고정/ });
  assert.match(js, /translationProvider: "gemini"/);
  assert.doesNotMatch(js, /selectedVoiceProvider|OPENAI_REALTIME_TRANSLATION_LANGUAGES/);
  // Gemini API key entry with its own save button and status badge.
  assert.match(html, /<details class="settings-drawer">\s*<summary data-i18n="settings\.drawerAdvanced">/);
  assert.doesNotMatch(html, /<details class="settings-drawer"[^>]*\sopen(?:\s|>)/);
  assert.match(html, /name="geminiKey"/);
  assert.match(html, /id="save-gemini-key"/);
  assert.match(html, /id="gemini-key-status"/);
  assert.match(js, /hasGeminiKey/);
  assert.match(js, /apiKeys: \{ gemini: geminiKey \}/);
  assert.match(js, /validateGeminiKey/);
  assert.match(js, /\/api\/subtitles\/gemini\/validate/);
  // Second Gemini project key: committed-line glossary finalizer first,
  // parallel Live translation second. Own field, save button, status badge,
  // and wiring.
  assert.match(html, /name="geminiSecondaryKey"/);
  assert.match(html, /id="save-gemini-secondary-key"/);
  assert.match(html, /id="gemini-secondary-key-status"/);
  assert.match(js, /hasGeminiSecondaryKey/);
  assert.match(js, /apiKeys: \{ geminiSecondary: geminiSecondaryKey \}/);
  assert.match(js, /saveGeminiSecondaryKey/);
  // Soniox key: its own save button, so enabling the Soniox engine does not
  // require a Go Live. No validate endpoint exists, so the server's presence
  // flag is the only confirmation, and the value goes nowhere but apiKeys.
  assert.match(html, /name="sonioxKey"[^>]*type="password"/);
  assert.match(html, /id="save-soniox-key"[^>]*data-i18n="keys\.saveSoniox"/);
  assert.match(html, /id="soniox-key-status"/);
  assert.match(js, /saveSonioxKeyButton\?\.addEventListener\("click", saveSonioxKey\)/);
  assert.match(js, /async function saveSonioxKey\(\)/);
  const sonioxSave = extractFunctionBody(js, "async function saveSonioxKey()");
  assert.match(sonioxSave, /await saveSettings\(\{ apiKeys: \{ soniox: sonioxKey \} \}\)/);
  assert.doesNotMatch(sonioxSave, /subtitle:/, "a key save never rewrites the caption settings");
  assert.equal((sonioxSave.match(/saveSettings\(/gu) ?? []).length, 1, "exactly one write per key save");
  assert.match(sonioxSave, /sonioxKeyInput\.value = ""/);
  assert.match(sonioxSave, /updateSonioxKeyStatus\(\)/);
  assertLocalized("keys.saveSoniox", { en: /Save Soniox key/, ko: /Soniox 키 저장/ });
  assertLocalized("key.enterSoniox", { en: /Enter the Soniox API key/, ko: /Soniox API 키를 입력/ });
  assertLocalized("key.sonioxSaved", { en: /Soniox API key saved/, ko: /Soniox API 키를 저장/ });
  // Engine availability is derived from the stored keys and only travels on
  // /api/config, so a flipped key flag must re-read the catalog — otherwise a
  // just-saved Soniox key leaves its engine disabled until a reload.
  assert.match(js, /const ENGINE_KEY_FLAGS = \["hasGeminiKey", "hasSonioxKey"\]/);
  const catalogRefresh = extractFunctionBody(js, "async function refreshCaptionEngineCatalog()");
  assert.match(catalogRefresh, /fetch\("\/api\/config"\)/);
  assert.match(catalogRefresh, /captionEngineSettings\?\.setCatalog\(config\.captionEngines\)/);
  const settingsSave = extractFunctionBody(js, "async function saveSettings(patch)");
  assert.match(settingsSave, /const keyFlagsBefore = engineKeyFlagSignature\(\)/);
  assert.match(settingsSave, /if \(engineKeyFlagSignature\(\) !== keyFlagsBefore\) await refreshCaptionEngineCatalog\(\)/);
  assert.match(js, /if \(engineKeyFlagSignature\(\) !== keyFlagsBefore\) void refreshCaptionEngineCatalog\(\);\s*\n\s*else captionEngineSettings\?\.refresh\(\);/);
  // A failed /api/config leaves no catalog: the picker must say so.
  assert.match(extractFunctionBody(js, "async function loadConfig()"), /captionEngineSettings\?\.setCatalog\(null\);\s*\n\s*showError\(error\);/);
  assert.doesNotMatch(html + js, /openaiSecondary|OpenAISecondary|openaiKey2|save-openai-secondary-key|openai-secondary-key-status/);
  assert.match(captureJs, /CAPTION_AUDIO_PROCESSOR_BUFFER_SIZE = 1_024/);
  // Key registration must be explicit for BOTH providers: a clear
  // registered/unregistered badge, not a vague placeholder.
  assert.match(js, /"key\.registered" : "key\.unregistered"/);
  assertLocalized("key.registered", { ko: /✓ 등록됨/ });
  assertLocalized("key.unregistered", { ko: /미등록/ });
  assert.match(html, /name="ollamaModel"/);
  assert.match(html, /name="ollamaBaseURL"/);
  assert.match(html, /name="maxSubtitleLines"/);
  assert.match(html, /id="topic-list"/);
  assert.match(html, /id="translation-log"/);
  assert.match(html, /class="translation-log"/);
  assert.match(html, /id="clear-history"/);
  assert.match(html, /id="realtime-api-status"/);
  assert.match(html, /id="audio-inspector"/);
  assert.match(html, /id="overlay-enabled"/);
  assert.match(html, /name="overlayEnabled"/);
  assert.match(html, /data-i18n="player\.overlayToggle"/);
  assertLocalized("player.overlayToggle", { en: /Subtitle overlay/ });
  assert.match(html, /id="refresh-audio-devices"/);
  assert.match(html, /id="system-audio-meter"/);
  assert.match(html, /id="mic-audio-meter"/);
  assert.match(html, /실시간 자막 확인 중/);
  // The drawer summary must not repeat the page title two lines above it.
  assert.match(html, /<summary data-i18n="settings\.drawerAdvanced">/);
  assertLocalized("settings.drawerAdvanced", { en: /Advanced/, ko: /고급/ });
  assert.match(html, /데스크톱 앱으로 여는 중/);
  assert.doesNotMatch(html, /Run always-on-top live subtitles/);
  assert.doesNotMatch(html, /Only translated subtitles are shown/);
  assert.match(html, /id="save-openai-key"/);
  assert.match(html, /id="openai-key-status"/);
  assert.doesNotMatch(html, /id="save-openai-secondary-key"|id="openai-secondary-key-status"/);
  assert.match(html, /id="file-protocol-warning"/);
  assert.match(html, /href="subtitle\.css"/);
  assert.match(html, /src="subtitle-dashboard\.js"/);
  assert.match(html, /name="translationFontSize"/);
  assert.match(html, /name="sourceFontSize"/);
  assert.match(html, /name="translationFontSizeRange"/);
  assert.doesNotMatch(html, /id="caption-player-controller"/);
  assert.match(controllerHtml, /id="caption-player-controller"|class="caption-player-controller/);
  assert.doesNotMatch(html, /class="preview-visualizer"/);
  assert.match(controllerHtml, /id="controller-drag"/);
  assert.match(controllerHtml, /class="controller-body"/);
  assert.match(controllerHtml, /id="controller-restart"/);
  assert.match(controllerHtml, /id="controller-stop"/);
  assert.match(controllerHtml, /id="controller-font-down"/);
  assert.match(controllerHtml, /id="controller-font-up"/);
  // Desktop app controls: raise the main window, hide the floating console,
  // quit the app directly.
  assert.match(controllerHtml, /id="controller-main-window"[^>]*data-i18n="controller\.mainWindow"/);
  assertLocalized("controller.mainWindow", { en: /Main/ });
  assert.match(controllerHtml, /id="controller-hide"/);
  assert.match(controllerHtml, /id="controller-quit"/);
  assert.match(controllerJs, /showMainWindow/);
  assert.match(controllerJs, /setControllerVisible/);
  assert.match(controllerJs, /quitApp/);
  // Main sits in the App-controls cluster, before Hide and Quit so the
  // destructive control stays pinned at the far edge.
  const windowCluster = controllerHtml.slice(controllerHtml.indexOf('data-i18n-aria="controller.appControls"'));
  assert.ok(
    windowCluster.indexOf('id="controller-main-window"') < windowCluster.indexOf('id="controller-hide"')
      && windowCluster.indexOf('id="controller-hide"') < windowCluster.indexOf('id="controller-quit"'),
    "App controls order is Main -> Hide -> Quit",
  );
  // Outside Electron every desktop-only control is hidden, Main included.
  assert.match(controllerJs, /if \(mainWindowButton\) mainWindowButton\.hidden = true;/);
  assert.doesNotMatch(controllerHtml, /id="controller-language-preset"/);
  assert.match(controllerHtml, /<select id="controller-display"/u);
  assert.equal((controllerHtml.match(/<select\b/gu) ?? []).length, 1,
    "the display selector is the controller's only dropdown");
  // Languages and the fixed Gemini provider are chosen ahead of time in the workspace.
  assert.doesNotMatch(controllerHtml, /data-controller-languages=/);
  assert.doesNotMatch(controllerHtml, /class="controller-language-set"/);
  assert.doesNotMatch(controllerHtml, /통역 음성 엔진/u);
  // Vertical-gap stepper lives beside the opacity control.
  assert.match(controllerHtml, /id="controller-gap-down"/);
  assert.match(controllerHtml, /id="controller-gap-up"/);
  assert.match(controllerHtml, /id="controller-gap-value"/);
  assert.match(controllerHtml, /id="controller-opacity"/);
  assert.match(controllerHtml, /id="controller-opacity-value"/);
  assert.match(controllerHtml, /data-controller-position="top-center"/);
  assert.match(controllerHtml, /data-controller-position="middle-center"/);
  assert.match(controllerHtml, /data-controller-position="bottom-center"/);
  assert.match(html, /id="opacity-value"/);
  assert.match(html, /subtitle-dashboard\.js/);
  assert.match(controllerHtml, /subtitle-controller\.js/);
  assert.match(js, /type: "subtitle:start"/);
  assert.match(js, /type: "subtitle:audio"/);
  assert.match(js, /syncCaptionPlayerController/);
  assert.match(js, /initCaptionControllerDrag/);
  assert.match(js, /CONTROLLER_POSITION_STORAGE_KEY/);
  assert.match(js, /localStorage\.setItem\(CONTROLLER_POSITION_STORAGE_KEY/);
  assert.match(js, /localStorage\.getItem\(CONTROLLER_POSITION_STORAGE_KEY/);
  assert.match(js, /controllerDragHandle\.addEventListener\("pointerdown"/);
  assert.match(js, /adjustControllerFontSize/);
  assert.match(js, /setControllerSubtitlePosition/);
  assert.match(js, /persistControllerSubtitleSettings/);
  assert.match(js, /const isVisible = state\.running/);
  assert.match(js, /captionPlayerController\.hidden = !isVisible/);
  assert.match(js, /controllerRestartButton\?\.addEventListener\("click", restartCaptionsFromController\)/);
  assert.match(js, /controllerStopButton\?\.addEventListener\("click", stopSubtitles\)/);
  assert.match(js, /controllerLanguagePreset\?\.addEventListener\("change", \(\) => applyControllerLanguagePreset\(\)\)/);
  assert.match(js, /controllerOpacity\?\.addEventListener\("input", \(\) => previewControllerOpacity\(\)\)/);
  assert.match(js, /controllerOpacity\?\.addEventListener\("change", \(\) => persistControllerOpacity\(\)\)/);
  assert.match(js, /window\.addEventListener\("pointermove", moveDrag\)/);
  assert.match(js, /window\.addEventListener\("pointerup", stopDrag\)/);
  assert.match(js, /applyControllerLanguagePreset/);
  assert.match(js, /previewControllerOpacity/);
  assert.match(js, /persistControllerOpacity/);
  assert.match(js, /syncControllerOpacity/);
  assert.match(js, /handleSubtitleControllerCommand/);
  assert.match(js, /setControllerWindowVisible\(state\.running\)/);
  const stopSubtitlesBody = extractFunctionBody(js, "async function stopSubtitles({ waitForAcknowledgement = false } = {})");
  assert.match(stopSubtitlesBody, /state\.running = false[\s\S]*syncRuntimeOutputVisibility\(\)/,
    "the stop path must hide the controller through the single runtime visibility rule");
  assert.match(controllerJs, /type: "subtitle:control"/);
  assert.doesNotMatch(controllerJs, /data-controller-languages/);
  assert.match(controllerJs, /command: "restart"/);
  assert.match(controllerJs, /command: "stop"/);
  assert.match(controllerJs, /command: "offset"/);
  assert.match(controllerJs, /command: "opacity"/);
  assert.match(js, /getOverlayEnabled/);
  assert.match(js, /setOverlayEnabled/);
  assert.match(js, /overlayEnabled: true/);
  assert.match(js, /subtitle:history/);
  assert.match(js, /historyDays/);
  assert.match(js, /\/api\/subtitles\/history/);
  assert.match(js, /\/api\/subtitles\/history\/clear/);
  assert.match(js, /displayMode: "translation_only"/);
  assert.match(js, /maxSubtitleLines: 2/);
  assert.match(js, /ollamaModel: "gemma3n:e2b"/);
  assert.match(js, /Gemini Live: ready/);
  assert.match(js, /t\("status\.realtimeConnected"\)/);
  assertLocalized("status.realtimeConnected", { ko: /실시간 자막 연결됨/ });
  assert.match(js, /t\("history\.recorderFallback"\)/);
  assertLocalized("history.recorderFallback", { ko: /기록 보조 기능 사용 중/ });
  // 2026-07-25 Spotify-shelf round: bare "기록 없음" empty boxes were replaced
  // with warm guidance copy.
  assert.match(js, /t\("history\.empty"\)/);
  assertLocalized("history.empty", { ko: /아직 확정된 자막이 없습니다/ });
  assert.doesNotMatch(js, /"기록 없음"/);
  assert.match(js, /t\("history\.unknownDate"\)/);
  assertLocalized("history.unknownDate", { ko: /날짜 미확인/ });
  assert.match(js, /LOCAL_SERVER_DASHBOARD_URL = "http:\/\/127\.0\.0\.1:3210\/subtitle\.html"/);
  assert.match(js, /location\.protocol === "file:"/);
  assert.match(js, /showFileProtocolWarning/);
  assert.match(js, /apiKeysPatch\.openai = openaiKeyInput\.value\.trim\(\)/);
  assert.match(js, /apiKeysPatch\.gemini = geminiKeyInput\.value\.trim\(\)/);
  assert.match(js, /saveOpenAIKey/);
  assert.match(js, /validateOpenAIKey/);
  assert.match(js, /\/api\/subtitles\/openai\/validate/);
  assert.match(js, /t\("key\.validatingOpenAI"\)/);
  assertLocalized("settings.openaiKey", { en: /OpenAI speech recognition API key/, ko: /OpenAI 음성 인식 API key/ });
  assertLocalized("key.validatingOpenAI", { en: /Validating OpenAI speech recognition/, ko: /OpenAI 음성 인식 확인 중/ });
  assert.match(js, /apiKeys: \{ openai: openaiKey \}/);
  assert.match(js, /renderKeyStatus/);
  assert.match(js, /t\("key\.openaiSaved"\)/);
  assertLocalized("key.openaiSaved", { en: /OpenAI speech recognition verified/, ko: /OpenAI 음성 인식을 확인했고 API key를 저장했습니다/ });
  assert.doesNotMatch(
    Object.values(MESSAGES.en).join("\n") + Object.values(MESSAGES.ko).join("\n"),
    /OpenAI Realtime|OpenAI API key 2|OpenAI Realtime 번역 검증/,
  );
  assert.match(js, /source: capture\.source/);
  assert.match(js, /label: getAudioTrackLabel/);
  assert.match(js, /startAudioLevelMeter/);
  assert.match(js, /ensureAudioContextRunning/);
  assert.match(js, /await context\.resume\(\)/);
  assert.match(js, /watchAudioTrackState/);
  assert.match(js, /setAudioSourceStatus/);
  assert.match(js, /INPUT_SILENCE_WARNING_MS/);
  assert.match(js, /subtitle:input-status/);
  assert.match(js, /broadcastInputStatus/);
  assert.match(js, /message\.type === "subtitle:partial"[\s\S]{0,420}setPreviewText/);
  assert.match(js, /micDeviceId/);
  assert.match(js, /replaceChildren\(new Option\(t\("settings\.systemDefault"\), ""\)\)/);
  assertLocalized("settings.systemDefault", { en: /System default/ });
  assert.match(js, /getDisplayMedia/);
  assert.match(js, /getUserMedia/);
  // A persisted mic deviceId can go stale (unplugged/renumbered device). The
  // capture must fall back to the system default mic instead of failing the
  // whole mic input on OverconstrainedError.
  assert.match(js, /captureMicrophoneStream\(navigator\.mediaDevices, micSelect\.value/);
  assert.match(captureJs, /deviceId: \{ exact: deviceId \}/);
  assert.match(captureJs, /catch \(error\)[\s\S]*?getUserMedia\(\{ audio: getMicrophoneAudioConstraints\(\) \}\)/);
  // Mic failure guidance must point at the actual macOS panel (Microphone),
  // which is separate from Screen & System Audio Recording.
  assert.match(js, /t\("error\.micDenied"\)/);
  assert.match(MESSAGES.ko["error.micDenied"], /개인정보 보호 및 보안.*마이크/);
  assert.match(MESSAGES.en["error.micDenied"], /Privacy & Security > Microphone/);
  // The bundle name macOS shows in Privacy & Security must stay literal in
  // both languages, so the instruction matches what the user sees.
  assert.match(MESSAGES.en["error.micDenied"], /NOVA/);
  assert.match(MESSAGES.ko["error.micDenied"], /NOVA/);
  assert.match(js, /CAPTURE_TIMEOUT_MS = 8000/);
  assert.match(js, /Promise\.allSettled\(tasks\)/);
  assert.match(js, /withMediaCaptureTimeout/);
  assert.match(js, /stopMediaStream\(stream\)/);
  assert.match(captureJs, /echoCancellation: true/);
  assert.match(captureJs, /noiseSuppression: true/);
  assert.match(captureJs, /autoGainControl: true/);
  // System/loopback audio must be requested as a plain `audio: true` signal.
  // Electron defers loopback routing to the main process, so passing a
  // device-style audio constraints object (echoCancellation,
  // suppressLocalAudioPlayback, ...) makes getDisplayMedia throw "Invalid
  // capture constraints". video:true is still required.
  assert.match(js, /getDisplayMedia\(\{[\s\S]*?video: true,[\s\S]*?audio: true,[\s\S]*?\}\)/);
  assert.doesNotMatch(js, /suppressLocalAudioPlayback/);
  assert.match(js, /createGain/);
  assert.match(js, /mute\.gain\.value = 0/);
  assert.match(js, /formatCaptureFailure/);
  assert.match(js, /t\("error\.systemAudioDenied"\)/);
  assert.match(js, /t\("error\.systemAudioFailed", \{ reason \}\)/);
  assert.match(MESSAGES.ko["error.systemAudioDenied"], /NOVA의 Screen & System Audio Recording 권한/);
  assert.match(MESSAGES.ko["error.systemAudioFailed"], /개발 실행 중이면 Electron 항목도 같은 권한이 필요합니다/);
  assert.match(MESSAGES.en["error.systemAudioFailed"], /Screen & System Audio Recording/);
  assert.match(js, /t\("notice\.partialInputs", \{ failures/);
  assertLocalized("notice.partialInputs", { ko: /가능한 입력만으로 시작했습니다/ });
  // Every live status line resolves through the dictionary in both languages.
  /** @type {[string, RegExp][]} */
  const statusKeys = [
    ["status.serviceConnecting", /서비스 연결 중/],
    ["status.captionsReady", /자막 준비됨/],
    ["status.hearing", /말씀을 듣고 있어요/],
    ["status.translating", /번역하고 있어요/],
    ["status.reconnecting", /다시 연결하는 중/],
    ["status.realtimeReconnecting", /실시간 자막 다시 연결 중/],
  ];
  for (const [key, korean] of statusKeys) {
    assert.match(js, new RegExp(`t\\("${key.replace(".", "\\.")}"\\)`));
    assertLocalized(key, { ko: korean });
  }
  assert.match(js, /await stopSubtitles\(\)/);
  assert.match(js, /t\("notice\.settingsSaved"\)/);
  assertLocalized("notice.settingsSaved", { ko: /설정을 저장했습니다/ });
  assert.match(js, /window\.location\.href = "\/api\/settings\/export"/);
  assert.doesNotMatch(js, /includeKeys/);
  // The "keys stay on this device" blurb was explanatory prose and was deleted;
  // the behaviour it described is asserted where it lives (settings-store keeps
  // API keys out of the export payload).
  assert.doesNotMatch(html, /자막 설정만 포함 — API 키는 이 기기에 유지됩니다/);
  assert.match(html, /id="export-settings"[\s\S]{0,200}id="import-settings"/);
});

test("desktop language picker exposes the approved multilingual set and caps simultaneous output at three", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  assert.match(js, /const MAX_SELECTED_LANGUAGES = 3/);
  assert.match(js, /fetch\("\/api\/subtitle-languages"\)/);
  assert.match(js, /subtitleLanguageRegistry = body\.languages/);
  // The static hint text was removed in the 2026-07-25 declutter; the 3-language
  // cap is enforced in JS and surfaced via the validation flash instead.
  assert.match(js, /t\("language\.minimum"\)/);
  assertLocalized("language.minimum", { ko: /최소 2개 언어를 선택해야 합니다/ });
  assert.match(js, /renderPlacementRows/);
  assert.doesNotMatch(html + js, /Realtime_Noel|AutoPreso|Auto Preso/);
});

test("desktop settings stay closed until the native summary is activated and non-caption chrome uses Pretendard", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");

  assert.match(html, /<details class="settings-drawer">\s*<summary data-i18n="settings\.drawerAdvanced">/);
  assert.doesNotMatch(html, /<details class="settings-drawer"[^>]*\sopen(?:\s|>)/);
  assert.match(css, /--ui-font-family:\s*"Pretendard"/);
  for (const match of css.matchAll(/\.subtitle-hero h1\s*\{([^}]*)\}/gs)) {
    assert.match(match[1], /font-family:\s*var\(--ui-font-family\)/);
    assert.doesNotMatch(match[1], /var\(--subtitle-font-family\)/);
  }
  assert.doesNotMatch(css, /\.pt-playback-options/);
  assert.doesNotMatch(css, /\.controller-group\s*\{[^}]*border-left:/s);
  assert.doesNotMatch(css, /radial-gradient/);
});

test("desktop dashboard explains the optional Live handoff without a web launcher", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  const workspaceJs = readFileSync(path.join(rootDir, "public", "subtitle-workspace.js"), "utf8");

  assert.match(html, /class="live-handoff"/);
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /data-i18n="live\.handoffKicker"/);
  assertLocalized("live.handoffKicker", { en: /OPTIONAL · LIVE CALL/ });
  // 2026-07-25 design review: the static Presentation/Meeting mode list was
  // decorative noise and was removed from the workspace.
  assert.doesNotMatch(html, /live-handoff-modes/);
  assert.doesNotMatch(html, /Optional translated audio/);
  assert.doesNotMatch(html, /Townhall/);
  assert.doesNotMatch(html, /data-i18n="live\.handoffFlow"/);
  assert.match(html, /id="schedule-live-call"[^>]*data-i18n="live\.start"/);
  assert.match(html, /id="live-workspace-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="live-draft-cover-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /QR and a 6-digit access code are always created together/);
  assert.doesNotMatch(html, /id="open-meeting-mode"|data-open-live-workspace|>Open Live Call</);
  assert.match(css, /\.live-handoff\s*\{/);
  assert.match(workspaceJs, /await bridge\.startLiveCall\(draft\)/);
  assert.match(workspaceJs, /result\?\.code === "HOST_LOGIN_REQUIRED"/);
  assert.match(workspaceJs, /coverImage: liveDraftCoverData/);
});

test("subtitle dashboard captures audio before opening realtime subtitle sessions", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const startSubtitlesBody = extractFunctionBody(js, "async function startSubtitles()");
  const captureIndex = startSubtitlesBody.indexOf("captures = await captureSelectedAudio(state.settings)");
  const startIndex = startSubtitlesBody.indexOf("await requestSubtitleStart(");

  assert.ok(captureIndex > 0, "dashboard should capture selected audio before starting subtitles");
  assert.ok(startIndex > captureIndex, "subtitle:start should be sent only after local capture succeeds");
  assert.match(js, /t\("status\.inputCheck"\)/);
  assertLocalized("status.inputCheck", { ko: /입력 확인 중/ });
  assert.match(js, /state\.streams = captures\.map/);
});

test("desktop subtitle UI is captions-only and contains no translated-audio lane", async () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const overlay = readFileSync(path.join(rootDir, "public", "subtitle-overlay.js"), "utf8");
  const i18n = readFileSync(path.join(rootDir, "public", "subtitle-i18n.js"), "utf8");

  assert.match(html, /<input name="outputMode" type="hidden" value="captions"\s*\/?>/);
  assert.doesNotMatch(html, /pt-output-group|pt-playback-options|audioLanguage|audioVolume|voiceProvider/);
  assert.doesNotMatch(html, /통역 음성|interpretation audio/iu);
  assert.doesNotMatch(js, /subtitle-audio-player|subtitle:translated-audio|subtitle:audio-control/);
  assert.doesNotMatch(js, /subtitleAudioPlayer|translatedAudioGuard|clearTranslatedAudioQueue|shouldGateTranslatedAudioInput/);
  assert.doesNotMatch(js, /form\.elements\.(?:audioLanguage|audioVolume|voiceProvider)|\b(?:audioLanguage|audioVolume|voiceProvider)\s*:/);
  assert.match(js, /RETIRED_SUBTITLE_SETTING_KEYS/);
  assert.doesNotMatch(js, /geminiTranscribeModel:\s*"gemini-/);
  assert.doesNotMatch(js, /gemini-3\.5-live-translate-preview/);
  assert.doesNotMatch(overlay, /outputMode|isAudioOnlyOutput/);
  assert.doesNotMatch(i18n, /통역 음성|interpretation audio/iu);

  const form = {
    elements: {
      inputMode: { value: "system_mic" },
      micDeviceId: { value: "" },
      translationProvider: { value: "gemini" },
      fontFamily: { value: "Arial" },
      translationFontSize: { value: "38" },
      sourceFontSize: { value: "36" },
      position: { value: "bottom-center" },
      maxWidth: { value: "1500" },
      opacity: { value: "0.9" },
      maxSubtitleLines: { value: "3" },
      overlayEnabled: { checked: true },
      recordProvider: { value: "gemma" },
      ollamaBaseURL: { value: "http://127.0.0.1:11434" },
      ollamaModel: { value: "gemma3n:e2b" },
      tone: { value: "natural" },
      glossary: { value: "" },
      translationDomain: { value: "" },
      verticalOffset: { value: "24" },
    },
  };

  const readSettingsFromForm = new Function(
    "form",
    "state",
    "DEFAULT_SUBTITLE",
    "readNumber",
    "readTranslationLanguagesFromForm",
    "readLiveCallLanguagesFromForm",
    "readSubtitlePositionsFromForm",
    "deriveLanguagePairFromTargets",
    "normalizeCaptionSettings",
    "selectedGlossaryPresetId",
    "selectedGlossaryPresetName",
    "selectedGlossaries",
    extractFunctionBody(js, "function readSettingsFromForm()"),
  );
  const settings = readSettingsFromForm(
    form,
    { settings: { model: "gemini-3.5-live-translate-preview", audioVolume: 0.8, engine: DEFAULT_SUBTITLE_SETTINGS.engine } },
    {
      engine: DEFAULT_SUBTITLE_SETTINGS.engine,
      translationFontSize: 38,
      fontFamily: "Arial",
      maxWidth: 1500,
      opacity: 0.9,
      maxSubtitleLines: 3,
      ollamaBaseURL: "http://127.0.0.1:11434",
      ollamaModel: "gemma3n:e2b",
      tone: "natural",
      verticalOffset: 24,
    },
    (value, fallback) => Number(value) || fallback,
    () => ["en", "ko"],
    () => [],
    () => ({ en: "bottom-center", ko: "bottom-center" }),
    () => ({ a: "en", b: "ko" }),
    (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !["model", "audioVolume"].includes(key))),
    () => "gemini",
    () => "default-cre-ai-en-ko",
    () => [{ sourceKind: "builtin", sourceId: "common_business" }],
  );
  assert.equal(settings.outputMode, "captions");
  assert.deepEqual(settings.engine, DEFAULT_SUBTITLE_SETTINGS.engine);
  assert.equal(Object.hasOwn(settings, "model"), false);
  assert.equal(Object.hasOwn(settings, "audioVolume"), false);
  assert.deepEqual(settings.glossaries, [{ sourceKind: "builtin", sourceId: "common_business" }]);

  /** @type {{ url: string, options: { method: string, body: string } } | null} */
  let request = null;
  const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
  const saveSettings = new AsyncFunction(
    "patch",
    "fetch",
    "state",
    "updateOpenAIKeyPlaceholder",
    "updateOpenAIKeyStatus",
    "updateGeminiKeyStatus",
    "updateGeminiSecondaryKeyStatus",
    extractFunctionBody(js, "async function saveSettings(patch)"),
  );
  await saveSettings(
    { subtitle: settings },
    async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true }) };
    },
    {},
    () => {},
    () => {},
    () => {},
    () => {},
  );
  assert.ok(request, "saving settings must issue an HTTP request");
  assert.equal(request.url, "/api/settings");
  assert.equal(request.options.method, "PUT");
  assert.equal(JSON.parse(request.options.body).subtitle.outputMode, "captions");
});

test("desktop glossary checklist compares only the preset target and blocks mixed source languages", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  // Host presets gate on their FULL target list (multi-target presets stay
  // selectable for every covered language), falling back to languagePair.b.
  assert.match(js, /hostTargetLanguages\(option\)\.some\(\(language\) => targetLanguages\.includes\(language\)\)/u);
  assert.match(js, /\[option\.languagePair\?\.b\]/u);
  assert.doesNotMatch(js, /targetLanguages\.includes\(option\.languagePair\?\.a\)\s*\|\|/u);
  assert.match(js, /input\.dataset\.sourceLanguage/u);
  assert.match(js, /new Set\(selectedInputs\.map\(\(selectedInput\) => selectedInput\.dataset\.sourceLanguage\)\)/u);
  assert.match(js, /setGlossarySelectionStatus\("glossary\.selection\.mixedSources", "error"\)/u);
  assertLocalized("glossary.selection.mixedSources", { ko: /서로 다른 원문 언어/u });
  assert.match(js, /glossary\.selection\.checkConflicts/u);
  assertLocalized("glossary.selection.checkConflicts", { ko: /적용할 때 번역 충돌을 확인합니다/u });
  assert.doesNotMatch(js, /충돌이 발견되면 저장 전에|번역 충돌은 저장 전에/u);
  assert.match(html, /적용할 때 번역 충돌을 확인합니다/u);
  assert.doesNotMatch(html, /충돌이 발견되면 저장 전에|번역 충돌은 저장 전에/u);
  assert.match(js, /selectedSourceLanguage/u);
  assert.match(js, /isSelected \|\| \(isTargetCompatible && isSourceCompatible\)/u);
  assert.match(js, /t\("glossary\.selection\.sourceIncompatible"\)/u);
  assertLocalized("glossary.selection.sourceIncompatible", { ko: /선택한 용어집과 원문 언어가 다름/u });
});

test("subtitle dashboard cannot hang forever while checking audio inputs", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const selectedAudioStart = js.indexOf("async function captureSelectedAudio");
  const systemCaptureIndex = js.indexOf("captureAudioSource(\"system\"", selectedAudioStart);
  const micCaptureIndex = js.indexOf("captureAudioSource(\"mic\"", selectedAudioStart);
  const allSettledIndex = js.indexOf("Promise.allSettled(tasks)", selectedAudioStart);

  assert.ok(systemCaptureIndex > selectedAudioStart, "system audio should be scheduled as a capture task");
  assert.ok(micCaptureIndex > selectedAudioStart, "microphone audio should be scheduled as a capture task");
  assert.ok(allSettledIndex > systemCaptureIndex, "capture tasks should be awaited together");
  assert.ok(allSettledIndex > micCaptureIndex, "mic capture should not wait behind a hung system capture");
  const captureSelectedAudio = js.slice(selectedAudioStart, js.indexOf("async function captureAudioSource", selectedAudioStart));
  assert.equal(
    (captureSelectedAudio.match(/captureAudioSource\("mic"/g) ?? []).length,
    1,
    "system_mic must not schedule duplicate microphone capture streams",
  );
  assert.match(js, /reject\(new Error\(t\("error\.captureTimeout", \{ source: sourceName/);
  assertLocalized("error.captureTimeout", { ko: /\{source\} 캡처가 \{seconds\}초/ });
  assert.match(js, /if \(timedOut \|\| settled\) \{\s*stopMediaStream\(stream\);/);
});

test("subtitle dashboard actively starts Web Audio and reports blocked tracks", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const streamerStart = js.indexOf("async function createAudioStreamer");
  const contextIndex = js.indexOf('const context = new AudioContext({ sampleRate: CAPTION_AUDIO_SAMPLE_RATE, latencyHint: "interactive" })', streamerStart);
  const resumeIndex = js.indexOf("await ensureAudioContextRunning(context, sourceName)", streamerStart);
  const watchIndex = js.indexOf("watchAudioTrackState(media, sourceName)", streamerStart);
  const processIndex = js.indexOf("processor.onaudioprocess", streamerStart);

  assert.ok(contextIndex > streamerStart, "streamer should create an AudioContext");
  assert.ok(resumeIndex > contextIndex, "streamer should resume AudioContext before wiring nodes");
  assert.ok(watchIndex > resumeIndex, "streamer should attach track diagnostics");
  assert.ok(processIndex > watchIndex, "diagnostics should be ready before audio processing starts");
  assert.match(js, /context\.state !== "running"/);
  assert.match(js, /t\("audio\.blocked"\)/);
  assertLocalized("audio.blocked", { en: /Audio blocked/ });
  assert.match(js, /track\.addEventListener\?\.\("mute"/);
  assert.match(js, /track\.addEventListener\?\.\("ended"/);
});

test("subtitle dashboard requests native interactive 24 kHz capture with stateful resampling fallback", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const captureJs = readFileSync(path.join(rootDir, "public", "subtitle-audio-capture.js"), "utf8");
  const streamerStart = js.indexOf("async function createAudioStreamer");
  const streamerEnd = js.indexOf("async function ensureAudioContextRunning", streamerStart);
  const streamerSource = js.slice(streamerStart, streamerEnd);

  assert.match(streamerSource, /new AudioContext\(\{ sampleRate: CAPTION_AUDIO_SAMPLE_RATE, latencyHint: "interactive" \}\)/);
  assert.match(streamerSource, /createCaptionAudioChunker\(\{ inputSampleRate: context\.sampleRate/);
  assert.match(captureJs, /inputSampleRate === CAPTION_AUDIO_SAMPLE_RATE/);
  assert.match(captureJs, /: resample\(input, inputSampleRate, CAPTION_AUDIO_SAMPLE_RATE, carry\);/);
});

test("subtitle dashboard aggregates resampled input into exact 100 ms Live API frames", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const captureJs = readFileSync(path.join(rootDir, "public", "subtitle-audio-capture.js"), "utf8");
  const streamerStart = js.indexOf("async function createAudioStreamer");
  const streamerEnd = js.indexOf("async function ensureAudioContextRunning", streamerStart);
  const streamerSource = js.slice(streamerStart, streamerEnd);

  assert.match(captureJs, /CAPTION_AUDIO_SAMPLE_RATE = 24_000;/);
  assert.match(captureJs, /CAPTION_AUDIO_CHUNK_DURATION_MS = 100;/);
  assert.match(captureJs, /CAPTION_AUDIO_CHUNK_SAMPLES = CAPTION_AUDIO_SAMPLE_RATE/);
  assert.equal(2_400 / 24_000 * 1_000, 100);
  assert.match(captureJs, /let pendingSamples = new Float32Array\(0\);/);
  assert.match(captureJs, /availableSamples\.set\(pendingSamples\);/);
  assert.match(captureJs, /availableSamples\.set\(resampled\.samples, pendingSamples\.length\);/);
  assert.match(captureJs, /while \(availableSamples\.length - offset >= CAPTION_AUDIO_CHUNK_SAMPLES\)/);
  assert.match(captureJs, /availableSamples\.subarray\(offset, offset \+ CAPTION_AUDIO_CHUNK_SAMPLES\)/);
  assert.match(captureJs, /offset \+= CAPTION_AUDIO_CHUNK_SAMPLES;/);
  assert.match(captureJs, /pendingSamples = availableSamples\.slice\(offset\);/);
  assert.match(captureJs, /reset\(\) \{[\s\S]*?pendingSamples = new Float32Array\(0\);/);
  assert.match(streamerSource, /close: async \(\) => \{[\s\S]*?chunker\.reset\(\);/);
});

test("subtitle dashboard renders grouped translation history without flat-only records", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");

  assert.match(html, /id="translation-log" class="translation-log"/);
  assert.match(js, /normalizeHistoryDays\(snapshot\)/);
  assert.match(js, /Array\.isArray\(snapshot\.historyDays\)/);
  assert.match(js, /groupRecordsByDay\(Array\.isArray\(snapshot\.records\)/);
  assert.match(js, /document\.createElement\("details"\)/);
  assert.match(js, /document\.createElement\("summary"\)/);
  assert.match(js, /translation-day-count/);
  assert.match(js, /recordText\.textContent = record\.translatedText \|\| ""/);
  assert.doesNotMatch(js, /translationLog\.replaceChildren\(\.\.\.state\.history\.records\.slice\(0, 12\)\.map/);
  assert.match(js, /dedupeFinalHistoryRecords/);
  assert.match(js, /record\.isFinal === false/);
  assert.match(js, /message\.type === "subtitle:partial"[\s\S]{0,420}setPreviewText\(message\.translatedText, message\.sourceText, true\)/);
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
  assert.match(css, /\.translation-day/);
  assert.match(css, /\.translation-day summary/);
  assert.match(css, /\.translation-record-list/);
});

test("subtitle dashboard exposes source labels and level meter styles", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");

  assert.match(html, /class="subtitle-app-shell"/);
  assert.match(html, /class="subtitle-app-rail"/);
  assert.match(html, /<img src="icons\/radio\.svg" alt="" aria-hidden="true" \/><span data-i18n="nav\.captions">/);
  assertLocalized("nav.captions", { en: /Captions/ });
  assert.match(html, /<img src="icons\/file-text\.svg" alt="" aria-hidden="true" \/><span data-i18n="nav\.records">/);
  assertLocalized("nav.records", { en: /Records/ });
  assert.match(html, /<img src="icons\/users\.svg" alt="" aria-hidden="true" \/><span data-i18n="nav\.livecall">/);
  assertLocalized("nav.livecall", { en: /Live Call/ });
  assert.match(html, /<img src="icons\/settings\.svg" alt="" aria-hidden="true" \/><span data-i18n="nav\.settings">/);
  assertLocalized("nav.settings", { en: /Settings/ });
  assert.match(html, /id="caption-workspace" class="subtitle-dashboard"/);
  assert.doesNotMatch(html, /data-open-live-workspace|id="open-meeting-mode"|>Open Live Call</);
  assert.doesNotMatch(html, /QR and a 6-digit access code are always created together/);
  assert.match(html, /id="start-subtitles"/);
  assert.match(html, /id="stop-subtitles"/);
  assert.match(html, /id="subtitle-preview"/);
  assert.match(html, /id="translation-log-panel"/);
  assert.match(js, /const primaryNavigationLinks = \[\.\.\.document\.querySelectorAll\("\.subtitle-app-rail nav a\[href\^='#'\]"\)\]/);
  assert.match(js, /if \(target === settingsDrawer\) settingsDrawer\.open = true/);
  assert.match(js, /navigationLink\.classList\.toggle\("is-current", isCurrent\)/);
  assert.match(js, /target\.scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
  assert.match(js, /window\.addEventListener\("hashchange"/);
  assert.match(css, /\.audio-inspector/);
  assert.match(css, /\.audio-meter-row/);
  assert.match(css, /\.audio-meter-fill/);
  assert.match(css, /\.overlay-toggle/);
  assert.match(css, /\.caption-player-controller/);
  assert.match(css, /Electron host dashboard/);
  assert.match(css, /\.subtitle-app-shell[\s\S]*?grid-template-columns: 220px minmax\(0, 1fr\)/);
  assert.match(css, /\.subtitle-app-rail nav img[\s\S]*?width: 20px[\s\S]*?filter: none[\s\S]*?opacity: 0\.72/);
  // The two-column track this used to pin was dead: .workspace-shell on the same
  // element sets display:block and wins. Both are gone.
  assert.doesNotMatch(css, /minmax\(400px, 430px\)/u);
  assert.doesNotMatch(css, /#ff6a2a|#6ee7b7|#151311|#1d1915|#26211c/i);
  for (const iconName of ["radio", "file-text", "users", "settings"]) {
    const icon = readFileSync(path.join(rootDir, "public", "icons", `${iconName}.svg`), "utf8");
    assert.match(icon, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(icon, /viewBox="0 0 24 24"/);
  }
  const iconLicense = readFileSync(path.join(rootDir, "public", "icons", "README.md"), "utf8");
  assert.match(iconLicense, /official Feather repository/);
  assert.match(iconLicense, /MIT License/);
  assert.match(css, /\.caption-player-controller[\s\S]*?position: fixed/);
  assert.match(css, /\.caption-player-controller[\s\S]*?border-radius: 8px/);
  assert.match(css, /\.caption-player-controller[\s\S]*?display: grid/);
  assert.match(css, /\.controller-drag/);
  assert.match(css, /\.controller-drag[\s\S]*?touch-action: none/);
  assert.match(css, /\.controller-body/);
  assert.match(css, /\.controller-language-set/);
  assert.match(css, /\.controller-lang-option/);
  assert.match(css, /\.controller-opacity/);
  assert.match(css, /\.subtitle-dashboard-body[\s\S]*?background: var\(--nova-(?:surface-base|bg)\)/);
  assert.match(css, /\.controller-chip\.active/);
  assert.match(css, /\.controller-chip\.active[\s\S]*?color: var\(--nova-fg-intense\)/);
});

test("desktop rail exposes Prepare, Meeting, Records, and Settings with independent meeting tools", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");

  const prepareStart = html.indexOf('data-rail-section="prepare"');
  const meetingPrep = html.indexOf('id="open-meeting-prep"');
  const meetingStart = html.indexOf('data-rail-section="meeting"');
  const captions = html.indexOf('data-workspace-nav="captions"');
  const liveCall = html.indexOf('data-workspace-nav="livecall"');
  const liveCoach = html.indexOf('id="open-live-coach"');
  const liveInterpreter = html.indexOf('id="open-live-interpreter"');
  const records = html.indexOf('data-rail-section="records"');
  const settings = html.indexOf('data-rail-section="settings"');

  assert.ok(prepareStart >= 0 && prepareStart < meetingPrep,
    "Prepare must own the Meeting Prep launcher");
  assert.ok(meetingPrep < meetingStart && meetingStart < captions && captions < liveCall
    && liveCall < liveCoach && liveCoach < liveInterpreter,
  "Meeting must expose Captions, Live Call, Live Coach, then Live Interpreter");
  assert.ok(liveInterpreter < records && records < settings,
    "Records and Settings remain top-level destinations after Meeting");

  assert.match(html, /data-rail-icon="meeting-prep"/);
  assert.match(html, /data-rail-icon="live-coach"/);
  assert.match(html, /data-rail-icon="live-interpreter"/);
  assert.doesNotMatch(html, /id="open-live-interpreter"[^>]*>[\s\S]{0,180}icons\/users\.svg/,
    "Live Interpreter must not reuse the Live Call people icon");

  for (const key of [
    "nav.section.prepare", "nav.section.meeting", "nav.section.records", "nav.section.settings",
    "nav.meetingPrep", "nav.liveCoach", "nav.liveInterpreter",
  ]) assertLocalized(key);

  assert.match(js, /meetingCoachOpenPrep/);
  assert.match(js, /meetingCoachOpenLiveWindows/);
  assert.match(js, /openLiveInterpreter/);
  assert.match(js, /const railNavigationItems = \[\.\.\.document\.querySelectorAll\("\.subtitle-app-rail nav a, \.subtitle-app-rail nav button"\)\]/);
  assert.match(js, /\["ArrowUp", "ArrowDown", "Home", "End"\]/);
  assert.match(js, /availableItems\[nextIndex\]\?\.focus\(\)/);
});

test("Records filters search, type, and status across calendar meetings and local sessions", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");

  assert.match(html, /id="records-search"[^>]*type="search"/u);
  assert.match(html, /id="records-type-filter"[\s\S]*?value="all"[\s\S]*?value="captions"[\s\S]*?value="live-call"[\s\S]*?value="live-coach"[\s\S]*?value="live-interpreter"/u);
  assert.match(html, /id="records-status-filter"[\s\S]*?value="all"[\s\S]*?value="completed"[\s\S]*?value="in-progress"/u);
  assert.match(js, /function applySessionRecordFilters\(\)[\s\S]*?renderRecordsCalendar\([\s\S]*?renderSessionRecords\(/u,
    "one filter pass must feed both the calendar and local rows");
  assert.match(js, /records-search[\s\S]*?addEventListener\("input"/u);
  assert.match(js, /records-type-filter[\s\S]*?addEventListener\("change"/u);
  assert.match(js, /records-status-filter[\s\S]*?addEventListener\("change"/u);

  const filterHelpers = [
    "function normalizeRecordFilterText", "function isRecordObject", "function recordHasFeatureType",
    "function isCompletedSessionRecord", "function matchesSessionRecordFilters",
  ].map((signature) => extractBalancedStatement(js, signature)).join("\n");
  const filtered = vm.runInNewContext(`${filterHelpers}; ({
    coach: matchesSessionRecordFilters({ id: "it-call", kind: "live-call", endedAt: "2026-08-01T00:00:00.000Z", meetingCoach: {} }, { query: "IT-CALL", type: "live-coach", status: "completed" }),
    active: matchesSessionRecordFilters({ id: "open", kind: "local", endedAt: "", isUnterminated: true }, { query: "", type: "captions", status: "in-progress" }),
    wrongType: matchesSessionRecordFilters({ id: "caption", kind: "local", endedAt: "2026-08-01T00:00:00.000Z" }, { query: "", type: "live-call", status: "all" }),
  })`);
  assert.deepEqual({ ...filtered }, { coach: true, active: true, wrongType: false });

  for (const key of [
    "records.filtersLabel", "records.search", "records.type", "records.type.all", "records.type.captions",
    "records.type.liveCall", "records.type.liveCoach", "records.type.liveInterpreter", "records.status",
    "records.status.all", "records.status.completed", "records.status.inProgress", "records.noFilteredResults",
  ]) assertLocalized(key);
});

test("Records Coach detail reads only matching optional history and uses an accessible roving tablist", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");

  assert.match(html, /id="session-detail-tab-coach"[^>]*role="tab"[^>]*data-record-detail-tab="coach"[^>]*tabindex="-1"/u);
  assert.match(html, /id="session-detail-panel-coach"[^>]*role="tabpanel"[^>]*data-record-detail-panel="coach"/u);
  assert.match(js, /detail\.coach[\s\S]*?detail\.meetingCoach/u);
  assert.match(js, /sourceSessionId[\s\S]*?sessionId/u,
    "coach history with an explicit association must match the opened session");
  assert.match(js, /usedAnswers[\s\S]*?unusedRecommendations/u);
  assert.match(js, /renderSessionCoachHistory/u);
  assert.match(js, /textContent =/u);
  assert.doesNotMatch(extractFunctionBody(js, "function renderSessionCoachHistory(container, history)"), /innerHTML|insertAdjacentHTML/u);

  assert.match(js, /function activateSessionDetailView[\s\S]{0,700}"coach"/u);
  assert.match(js, /function activateSessionDetailView[\s\S]{0,900}tabIndex = isSelected \? 0 : -1/u);
  assert.match(js, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/u);
  assert.match(js, /activateSessionDetailView\(tabs\[nextIndex\]\?\.dataset\.recordDetailTab, \{ focus: true \}\)/u);

  const coachHelpers = [
    "function normalizeRecordFilterText", "function isRecordObject", "function coachHistoryEntryText",
    "function sessionCoachHistory",
  ].map((signature) => extractBalancedStatement(js, signature)).join("\n");
  const histories = vm.runInNewContext(`${coachHelpers}; ({
    matching: sessionCoachHistory({ meetingCoach: { sourceSessionId: "session-a", usedAnswers: [{ english: "Yes", korean: "네" }], unusedRecommendations: ["Check inventory"] } }, "session-a"),
    mismatched: sessionCoachHistory({ coach: { sourceSessionId: "session-b", usedAnswers: ["Must not render"] } }, "session-a"),
    malformed: sessionCoachHistory({ coach: "unsafe" }, "session-a"),
  })`);
  assert.deepEqual([...histories.matching.usedAnswers], ["Yes\n네"]);
  assert.deepEqual([...histories.matching.unusedRecommendations], ["Check inventory"]);
  assert.deepEqual([...histories.mismatched.usedAnswers], []);
  assert.deepEqual([...histories.malformed.unusedRecommendations], []);

  for (const key of ["records.coach", "records.coachUsed", "records.coachUnused", "records.coachEmpty"]) {
    assertLocalized(key);
  }
});

test("Dashboard and Records keyboard model never leaves focus inside a hidden surface", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");

  assert.match(html, /data-records-view="month"[^>]*aria-pressed="true"[^>]*tabindex="0"/u);
  assert.match(html, /data-records-view="week"[^>]*aria-pressed="false"[^>]*tabindex="-1"/u);
  assert.match(html, /data-records-view="day"[^>]*aria-pressed="false"[^>]*tabindex="-1"/u);
  assert.match(js, /function activateRecordsCalendarView\(button, \{ focus = false \} = \{\}\)/u);
  assert.match(js, /\["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"\]/u);
  assert.match(js, /sibling\.setAttribute\("aria-pressed", String\(isSelected\)\)/u);
  assert.match(js, /sibling\.tabIndex = isSelected \? 0 : -1/u);
  assert.match(js, /records-search[\s\S]{0,900}event\.key !== "Enter"[\s\S]{0,120}event\.preventDefault\(\)/u,
    "live search must not trigger the enclosing settings form submission");

  assert.match(js, /listPanel: document\.getElementById\("session-records-panel"\)/u);
  assert.match(js, /els\.listPanel\.hidden = true[\s\S]{0,220}els\.panel\.hidden = false[\s\S]{0,220}activateSessionDetailView\("summary", \{ focus: true \}\)/u,
    "detail must become visible before its selected tab receives focus");
  assert.match(js, /els\.listPanel\.hidden = false[\s\S]{0,500}nextFocus\?\.focus\(\)/u,
    "Back must restore the originating record after the list is visible again");

  assert.match(js, /refreshButton\.disabled = true[\s\S]{0,120}refreshButton\.setAttribute\("aria-busy", "true"\)/u);
  assert.match(js, /refreshButton\.disabled = false[\s\S]{0,120}refreshButton\.removeAttribute\("aria-busy"\)/u);
  assert.match(js, /button\.disabled = true[\s\S]{0,120}button\.setAttribute\("aria-busy", "true"\)/u,
    "native feature launch buttons must be single-flight");
  assert.match(js, /trigger\.disabled = true[\s\S]{0,120}trigger\.setAttribute\("aria-busy", "true"\)/u,
    "record detail loading must be single-flight and expose its busy state");

  for (const tab of ["summary", "transcript", "coach", "participants"]) {
    assert.match(html, new RegExp(`id="session-detail-tab-${tab}"[^>]*aria-controls="session-detail-panel-${tab}"`, "u"));
    assert.match(html, new RegExp(`id="session-detail-panel-${tab}"[^>]*aria-labelledby="session-detail-tab-${tab}"`, "u"));
  }
  assert.match(html, /id="settings-tab-general"[^>]*aria-selected="true"[^>]*tabindex="0"/u);
  assert.match(html, /id="settings-tab-advanced"[^>]*aria-selected="false"[^>]*tabindex="-1"/u);
});

test("Records announces only concise finalized status, not every replaced result subtree", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  assert.match(html, /id="session-records-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u);
  for (const id of ["records-cal-grid", "session-records-list", "session-detail-coach", "session-detail-participants"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"[^>]*aria-live=`, "u"), `${id} must not announce a whole replaced subtree`);
  }
  assert.match(html, /id="translation-log"[^>]*data-i18n-aria="history\.committedLabel"[^>]*aria-live="polite"/u,
    "the finalized committed-caption log remains the only transcript live region");
  assert.doesNotMatch(html, /class="subtitle-preview"[^>]*aria-live=/u,
    "partial preview text must never be announced as finalized speech");
});

test("subtitle overlay defaults to the observed two-line rolling-caption layout", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle-overlay.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-overlay.js"), "utf8");

  assert.match(html, /<title>NOVA Subtitle Overlay<\/title>/);
  // Per-language lanes: three position zones; each language renders its own box.
  assert.match(html, /data-zone="top-center"/);
  assert.match(html, /data-zone="middle-center"/);
  assert.match(html, /data-zone="bottom-center"/);
  assert.match(js, /fontFamily: "Arial, Helvetica, sans-serif"/);
  assert.match(js, /displayMode: "translation_only"/);
  assert.match(js, /showSourceText: false/);
  assert.match(js, /maxSubtitleLines: 2/);
  assert.match(js, /lastSubtitleAt/);
  // Double-click the overlay = restart the subtitle session (stall recovery);
  // hover makes the Electron click-through window interactive over the box.
  assert.match(js, /dblclick/);
  assert.match(js, /"subtitle:control"/);
  assert.match(js, /setOverlayInteractive/);
  // Overlay is for subtitles only. Operational status belongs in the
  // controller, so recovery copy must never appear over the presentation.
  assert.doesNotMatch(js, /subtitle-status-indicator|updateStatusIndicator|자막 재연결 중|자막 복구 중|오디오 처리 지연/);
  assert.doesNotMatch(js, /API 연결 중/);
  assert.doesNotMatch(js, /자막 대기 중/);
  assert.doesNotMatch(js, /준비됨/);
  assert.doesNotMatch(js, /음성 감지/);
  assert.doesNotMatch(js, /번역 중/);
  assert.doesNotMatch(js, /연결 복구 중/);
  assert.doesNotMatch(js, /renderStatus/);
  // A subtitle remains readable through a silence gap (generous idle linger) and
  // is replaced when new speech arrives.
  assert.match(js, /SUBTITLE_FINAL_LINGER_MS = 20000/);
  assert.match(js, /SUBTITLE_PREVIOUS_SENTENCE_LINGER_MS = 3000/);
  assert.match(js, /SUBTITLE_LIVE_STALE_MS = 15000/);
  assert.match(js, /INPUT_ACTIVE_GRACE_MS = 1600/);
  assert.match(js, /LIVE_SUBTITLE_RECHECK_MS = 500/);
  assert.match(js, /subtitleLingerMs/);
  assert.match(js, /lane\.timer/);
  assert.match(js, /message\.type === "subtitle:partial"\) renderPredictedSubtitle\(message\)/);
  assert.match(js, /message\.type === "subtitle:committed"\) renderCommittedSubtitle\(message\)/);
  assert.doesNotMatch(js, /isAudioOnlyOutput|outputMode/);
  assert.doesNotMatch(js, /subtitle:partial"\) renderSubtitle/);
  assert.match(js, /PREDICTED_SUBTITLE_MIN_CHARS = 4/);
  assert.match(js, /GEMINI_PREDICTED_SUBTITLE_MIN_CHARS = 10/);
  assert.match(js, /shouldRenderPredictedSubtitle/);
  assert.match(js, /message\.translationProvider === "gemini"/);
  assert.match(js, /renderCommittedSubtitle/);
  // The queue can retain one extra line internally while the product default
  // mirrors the 5fps reference: two visible lines with only the live tail changing.
  assert.match(js, /MAX_SUBTITLE_QUEUE_LINES = 3/);
  assert.match(css, /\.subtitle-lane\.is-live-call \.translation-line[\s\S]*?height: calc\(var\(--subtitle-line-clamp, 3\) \* 1\.18em\)/u,
    "Live Call reserves its complete line stack so text growth cannot move the outer block");
  assert.match(css, /\.subtitle-lane\.is-live-call \.live-call-speaker-label\[hidden\][\s\S]*?visibility: hidden/u,
    "Live Call reserves the speaker row between floor and caption events");
  assert.match(css, /\.subtitle-lane\.is-live-call \.live-call-speaker-label[\s\S]*?height: 44px/u,
    "visible and hidden speaker metadata use the same reserved row height");
  assert.match(css, /\.subtitle-lane\.is-live-call \.subtitle-word[\s\S]*?animation: none/u,
    "frequent Live revisions must not re-run word entry fades");
  // One independent lane per target language, positioned per language.
  assert.match(js, /const lanes = new Map/);
  assert.match(js, /ensureLane/);
  assert.match(js, /positionForLanguage/);
  assert.match(js, /subtitlePositions/);
  // Each lane lingers after its last line, then clears.
  assert.match(js, /armLinger/);
  assert.match(js, /armLinger\(lane, "final"\)/);
  assert.match(js, /armLinger\(lane, "live"\)/);
  assert.match(js, /armPreviousSentenceTrim/);
  assert.match(js, /lane\.trimTimer/);
  // Live Call uses the exact captions-only roll-up path: no source-specific
  // final replacement or first-partial clear may erase a readable sentence.
  assert.doesNotMatch(extractFunctionBody(js, "function renderCommittedSubtitle"), /message\.source === "live-call"/);
  assert.doesNotMatch(extractFunctionBody(js, "function renderPredictedSubtitle"), /message\.source === "live-call"/);
  // Movie-style wrapping: each sentence flows and wraps at the box's real
  // max-width — NO fixed-character pre-wrap (that caused premature mid-sentence
  // breaks). The live partial stays provisional; committed text is solid.
  assert.match(js, /splitSubtitleDisplayParts/);
  assert.doesNotMatch(js, /splitSubtitleCueLines/);
  assert.doesNotMatch(js, /SUBTITLE_CHARS_PER_LINE/);
  // Append-only word rendering (broadcast-caption stability): already-shown words
  // keep their DOM node; only new trailing words are appended, so text never
  // reflows/jitters as each token streams in.
  assert.match(js, /reconcileWords/);
  assert.match(js, /tokenizeWords/);
  assert.match(js, /flow\.appendChild\(span\)/);
  assert.match(js, /subtitle-word/);
  assert.match(js, /subtitle-flow/);
  // YouTube-style smooth roll-up: the flow is translated up by its overflow.
  assert.match(js, /updateRollUp/);
  assert.match(js, /scrollHeight/);
  assert.match(js, /translateY/);
  // The box fills to max-width then wraps, capping visible height to the line
  // budget and bottom-anchoring so the newest line is always kept on screen.
  assert.match(css, /justify-content: flex-end/);
  assert.match(css, /max-height: calc\(var\(--subtitle-line-clamp/);
  assert.match(css, /white-space: normal/);
  // Subtitle height is user-adjustable: the visible line budget follows the
  // maxSubtitleLines setting (up to a cap), driving the CSS height clamp.
  assert.match(js, /function maxSubtitleLines/);
  assert.match(js, /MAX_SUBTITLE_LINES_CAP = 8/);
  assert.doesNotMatch(js, /lane\.renderMode === "live-call"|Math\.min\(3, maxSubtitleLines\(\)\)/,
    "Live Call must use the Caption-only line budget without a renderer fork");
  // Anti-overlap: when 2+ languages share a zone (e.g. EN+KO both at the
  // bottom) each lane auto-shrinks its visible line count and the zone reflows,
  // so the stacked boxes stay compact and never overlap or run off-screen.
  assert.match(js, /visibleLineLimitFor/);
  assert.match(js, /reflowZone/);
  assert.match(js, /setProperty\("--subtitle-line-clamp"/);
  // Source ("원문") display was removed entirely — subtitles are always
  // translation-only, so the source can never render beside the translation.
  assert.doesNotMatch(js, /laneOwnsSourceLine/);
  assert.match(js, /lane\.source\.hidden = true/);
  // When the spoken source language switches, the lane translating INTO that
  // language is stale and is cleared so it doesn't sit beside the new
  // translation (the "영어 원문과 한글 병기" overlap).
  assert.match(js, /clearStaleReverseLane/);
  // Duplicate-line guard: a sentence re-emitted with only a trailing
  // punctuation/space difference must not render twice.
  assert.match(js, /normalizeForDedup/);
  assert.match(js, /stripSubtitlePrefix/);
  assert.doesNotMatch(js, /LANGUAGE_LABELS/);
  assert.doesNotMatch(js, /targetLanguage\.toUpperCase\(\)/);
  assert.match(js, /lane\.predicted/);
  assert.match(js, /splitSubtitleSentences/);
  // Fine-grained vertical placement flows to the overlay as a CSS variable.
  assert.match(js, /--subtitle-vertical-offset/);
  assert.match(css, /var\(--subtitle-vertical-offset/);
  assert.match(js, /subtitle:input-status/);
  assert.match(js, /handleInputStatus\(message\)/);
  assert.match(js, /message\.status === "signal"/);
  assert.match(js, /message\.status === "hearing"/);
  assert.match(js, /isInputActive\(\)/);
  assert.doesNotMatch(js, /입력 신호 없음/);
  assert.match(js, /message\.status === "idle"/);
  assert.match(js, /message\.type === "subtitle:clear"\) clearSubtitleLane\(message\.targetLanguage\)/);
  assert.match(js, /clearSubtitleLane/);
  assert.match(js, /clearSubtitle/);
  assert.match(js, /setTimeout\(connect, 1500\)/);
  assert.match(css, /--translation-font-size: 38px/);
  assert.match(css, /--source-font-size: 36px/);
  assert.match(css, /--subtitle-max-width: 1500px/);
  assert.match(css, /--subtitle-line-clamp: 3/);
  assert.match(css, /max-width: min\(var\(--subtitle-max-width\), 88vw\)/);
  assert.match(css, /text-wrap: pretty/);
  assert.match(css, /word-break: keep-all/);
  assert.match(css, /display: flex/);
  assert.match(css, /flex-direction: column/);
  assert.match(css, /\.subtitle-word\.committed/);
  assert.match(css, /\.subtitle-word\.partial/);
  // Newly appended words fade in (opacity only — never a layout shift, which
  // would fight the roll-up overflow math) and the animation is disabled under
  // reduced-motion.
  assert.match(css, /@keyframes subtitle-word-in/);
  assert.match(css, /\.subtitle-word \{[\s\S]*?animation: subtitle-word-in/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*?\.subtitle-word \{[^}]*animation: none/);
  assert.match(css, /\.subtitle-flow/);
  assert.match(css, /transition: transform 0\.32s/);
  assert.match(css, /transition: background 160ms ease/);
  assert.match(css, /rgba\(206, 211, 219, 0\.95\)/);
  assert.match(css, /translation-only \.source-line/);
  assert.match(css, /--nova-caption-plate: var\(--nova-surface-recessed\)/);
  assert.match(css, /rgb\(from var\(--nova-caption-plate\) r g b \/ var\(--subtitle-opacity\)\)/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /position-bottom-center/);
  assert.doesNotMatch(css, /opacity: var\(--subtitle-opacity\)/);
});

test("Live Call partial and final plates keep the same configured opacity", () => {
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  assert.match(
    css,
    /\.subtitle-box\.partial\s*\{[^}]*\/ 0\.78[^}]*\}/s,
    "Caption-only keeps its existing partial treatment",
  );
  assert.match(
    css,
    /\.subtitle-lane\.is-live-call \.subtitle-box\.partial\s*\{[^}]*\/ var\(--subtitle-opacity\)[^}]*\}/s,
    "Live Call must not replace the user's opacity during partial/final transitions",
  );
});

test("subtitle styles use NOVA semantic tokens and carry no legacy brand colors", () => {
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  // De-branding guarantee: the retired Cushman brand hexes must never reappear.
  for (const banned of ["#1D1740", "#E4002B", "#0093AD", "#8E1000"]) {
    assert.ok(!css.includes(banned), `legacy brand color ${banned} must be removed`);
  }
  assert.match(css, /--nova-surface-base: var\(--nova-grey-950\)/);
  assert.match(css, /--nova-fg-primary: var\(--nova-grey-100\)/);
  assert.match(css, /--nova-status-live: var\(--nova-red-500\)/);
  assert.doesNotMatch(css, /--cw-|filter:\s*invert|9999px/);
});

test("electron main creates always-on-top click-through overlay", () => {
  const source = readFileSync(path.join(rootDir, "electron", "main.js"), "utf8");
  const packageJson = readFileSync(path.join(rootDir, "package.json"), "utf8");
  const launcher = readFileSync(path.join(rootDir, "scripts", "start-desktop.js"), "utf8");
  const preload = readFileSync(path.join(rootDir, "electron", "preload.js"), "utf8");

  assert.match(source, /transparent: true/);
  assert.match(source, /frame: false/);
  assert.match(source, /alwaysOnTop: true/);
  assert.match(source, /setIgnoreMouseEvents\(true/);
  assert.match(source, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true, skipTransformProcessType: true \}\)/);
  // Content protection excludes the overlay from screen capture, which on macOS
  // makes the overlay unreliable above fullscreen/presentation surfaces. The
  // product goal is "always visible until the user turns it off", not capture
  // exclusion, so it must NOT be set.
  assert.doesNotMatch(source, /setContentProtection/);
  // The overlay must float above fullscreen apps and other always-on-top
  // windows: highest standard level plus a relative bump.
  assert.match(source, /OVERLAY_TOP_LEVEL = "screen-saver"/);
  assert.match(source, /setAlwaysOnTop\(true, OVERLAY_TOP_LEVEL, 1\)/);
  // Re-assert the level on the macOS events that drop a window's level
  // (another app going fullscreen, app activation) instead of relying solely
  // on the 1s polling watchdog.
  assert.match(source, /browser-window-focus/);
  assert.match(source, /did-become-active/);
  // Multi-display: exactly one overlay follows the persisted selected display;
  // hot-plug events reconcile its bounds without cloning caption state.
  assert.match(source, /screen\.getAllDisplays\(\)/);
  assert.match(source, /const overlayWindows = new Map\(\)/u);
  assert.match(source, /preferredOverlayDisplayId/u);
  assert.match(source, /display-added/);
  assert.match(source, /display-removed/);
  assert.match(source, /showInactive/);
  assert.match(source, /moveTop\(\)/);
  // The modern Electron 42 loopback audio path (callback audio: "loopback")
  // depends on the MacCatap CoreAudio-tap feature, so it must NOT be disabled.
  assert.doesNotMatch(source, /disable-features.*MacCatapLoopbackAudioForScreenShare/);
  // System audio capture must check the macOS screen-recording permission so
  // failures are diagnosable instead of surfacing as an empty audio stream.
  assert.match(source, /getMediaAccessStatus/);
  // Microphone is a SEPARATE macOS TCC panel from Screen & System Audio
  // Recording. Electron never shows the mic prompt unless the app explicitly
  // asks; without it getUserMedia can return a SILENT stream with no error.
  assert.match(source, /getMediaAccessStatus\("microphone"\)/);
  assert.match(source, /askForMediaAccess\("microphone"\)/);
  // electron-builder signs with hardened runtime; without the audio-input
  // entitlement macOS blocks the microphone at the process level — no prompt,
  // no TCC entry, getUserMedia silently returns nothing. The entitlements file
  // must be wired into the mac build and grant audio input alongside the
  // defaults Electron needs (JIT etc.).
  const entitlements = readFileSync(path.join(rootDir, "build", "entitlements.mac.plist"), "utf8");
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(packageJson, /"entitlements": "build\/entitlements\.mac\.plist"/);
  assert.match(packageJson, /"entitlementsInherit": "build\/entitlements\.mac\.plist"/);
  assert.match(source, /maintainOverlayWindow/);
  assert.match(source, /isQuitting/);
  assert.match(source, /subtitle-overlay:get-enabled/);
  assert.match(source, /subtitle-overlay:set-enabled/);
  assert.match(source, /destroyOverlayWindow/);
  assert.match(source, /app\.quit\(\)/);
  assert.match(source, /requestSingleInstanceLock/);
  assert.match(source, /second-instance/);
  assert.match(source, /PREFERRED_PORT = 3210/);
  assert.match(source, /title: "NOVA Subtitles"/);
  assert.match(source, /title: "NOVA Subtitle Overlay"/);
  assert.match(source, /title: "NOVA Subtitle Controller"/);
  assert.match(source, /createControllerWindow/);
  assert.match(source, /subtitle-controller\.html/);
  assert.match(source, /subtitle-controller:set-visible/);
  assert.match(source, /controllerWindow\.showInactive\(\)/);
  assert.match(preload, /setControllerVisible/);
  assert.match(source, /EADDRINUSE/);
  assert.match(source, /desktopCapturer\.getSources/);
  assert.match(source, /audio: "loopback"/);
  assert.match(source, /useSystemPicker: false/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /setPermissionCheckHandler/);
  assert.match(source, /ALLOWED_RENDERER_PERMISSIONS/);
  assert.match(source, /display-capture/);
  assert.match(source, /DESKTOP_SOURCE_TIMEOUT_MS = 7_000/);
  assert.match(source, /getDesktopSourcesWithTimeout/);
  assert.match(source, /completeDisplayMediaRequest\(callback, \{\}\)/);
  assert.match(source, /overlayEnabled = settings\.subtitle\?\.overlayEnabled !== false/);
  assert.match(source, /settingsStore\.save\(\{ subtitle: \{ overlayEnabled \} \}\)/);
  assert.match(packageJson, /"desktop": "node \.\/scripts\/start-desktop\.js"/);
  // Windows portable must never trigger a UAC/admin prompt.
  assert.match(packageJson, /"requestedExecutionLevel": "asInvoker"/);
  // window.open from the dashboard (e.g. meeting mode) must open the system
  // browser, not an Electron child window.
  assert.match(source, /setWindowOpenHandler/);
  assert.match(source, /shell\.openExternal/);
  assert.match(launcher, /stopExistingDesktop/);
  assert.match(launcher, /pgrep/);
  assert.match(launcher, /spawn\(path\.join\(rootDir, "node_modules", "\.bin", "electron"\)/);
});

test("live-call captions relay the opposite-language lane selected by main", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  // Main removes source-language events before the dashboard sees them. The
  // dashboard relays only that canonical opposite-language screen line.
  assert.match(dashboard, /Main has already removed source-language events/);
  assert.match(dashboard, /opposite-language translation/);
  assert.doesNotMatch(dashboard, /recordOnly: true/);
  assert.match(dashboard, /speakerDepartment/);
  assert.doesNotMatch(dashboard, /caption\.speaker\?\.isParticipant !== true/u,
    "gateway-canonical host captions must reach the desktop too");
  // 2026-08-22: Live Call 기본은 gateway 단일 정본(로컬 엔진 미기동). hybrid는
  // settings.liveCallLocalEngine=true opt-in으로만 선택된다 — 이중 번역 비용 방지.
  assert.match(dashboard, /function resolveLiveCallProducerKind\(\)/u);
  assert.match(dashboard, /liveCallLocalEngine === true \? "hybrid" : "gateway"/u);
  assert.doesNotMatch(dashboard, /captionProducer: "hybrid",/u,
    "hybrid must never be the unconditional producer kind");
  assert.doesNotMatch(dashboard, /hasAutoStartedCaptionsForLiveCall/u,
    "Live Call must not auto-start the independent local producer");
  assert.doesNotMatch(dashboard, /\$\{caption\.speaker[^}]*\}:/, "no Name: text prefix in relayed captions");

  const overlay = readFileSync(path.join(rootDir, "public", "subtitle-overlay.js"), "utf8");
  assert.match(overlay, /live-call-speaker-label/);
  assert.match(overlay, /updateLiveCallSpeaker\(message, lane\)/);
  assert.match(dashboard, /sessionId: String\(caption\.sessionId/);
  assert.match(dashboard, /sourceSeq: Number\.isSafeInteger\(caption\.seq\)/,
    "the gateway sequence must reach the overlay as fallback utterance identity");
  assert.match(dashboard, /speakerRole,/);

  const server = readFileSync(path.join(rootDir, "src", "server.js"), "utf8");
  assert.match(server, /liveCallSpeaker/);
  assert.match(server, /message\.recordOnly === true/);
  assert.match(server, /sourceText: translatedText/);
  assert.match(server, /MAX_PENDING_UNKEYED_LIVE_CALL_SOURCES/,
    "unkeyed source pairing must use a bounded FIFO rather than unbounded Symbol keys");
});

test("Live Call keeps local Caption Only independent from the Gateway relay", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const preflight = extractFunctionBody(dashboard, "async function handleLiveCallPreflight(request)");
  const syncBody = extractFunctionBody(dashboard, "async function syncLiveCallAudioBridge()");
  const hybridStart = extractFunctionBody(dashboard, "async function startHybridCaptionSession(liveState)");
  const capture = extractFunctionBody(dashboard, "function forwardLiveCallHostAudioPacket(packet, capture, sourceName)");
  const floorGate = extractFunctionBody(dashboard, "function applyLiveCallFloorGate(floor)");
  const suppressLateLocal = extractFunctionBody(dashboard, "function shouldSuppressLocalLiveCallOutput(message)");
  const reconnect = extractFunctionBody(dashboard, "async function reconnectLiveCallTranslation()");
  const reconfigure = extractFunctionBody(dashboard, "function reconfigureRunningSession()");
  const reconfigureLive = extractFunctionBody(dashboard, "async function reconfigureLiveCallLocalProvider()");

  assert.match(preflight, /await startLiveCallMicCapture\(\{ requestId \}\)/u);
  assert.match(preflight, /await requestLocalSubtitlePreflight\(requestId, request\)/u);
  assert.match(preflight, /await startHybridCaptionSession\(/u,
    "preflight must start the local Caption Only provider before Go-Live succeeds");
  assert.ok(preflight.indexOf("startLiveCallMicCapture") < preflight.indexOf("startHybridCaptionSession"),
    "the captured stream must exist before the local provider starts");
  assert.doesNotMatch(preflight.slice(0, preflight.indexOf("} catch")), /stopLiveCallAudioBridge/u,
    "successful preflight must preserve its capture through armed-to-live transition");

  assert.match(syncBody, /activeCaptionSessionOwner !== "live-call"[\s\S]*await startHybridCaptionSession\(liveState\)/u);
  assert.match(syncBody, /liveState\.bridge\?\.floorSnapshot/u);
  assert.match(syncBody, /applyLiveCallFloorGate\(floorSnapshot\)/u,
    "initial/recovered sync must reuse the authoritative sanitized floor snapshot");
  assert.match(syncBody, /await bridge\.ensureLiveCallBridge\(\)/u);
  assert.ok(syncBody.indexOf("startHybridCaptionSession") < syncBody.indexOf("await bridge.ensureLiveCallBridge()"),
    "Gateway availability must never gate the local caption provider");
  assert.match(hybridStart, /resolveLiveCallProducerKind\(\)/u);
  assert.match(hybridStart, /activeCaptionProducer = startedProducerKind/u);
  assert.match(capture, /type: "subtitle:audio"/u);
  assert.match(capture, /sendLiveCallAudioFrame/u,
    "the same captured frame must feed the independent Gateway host path");
  assert.doesNotMatch(capture, /if \(isLiveParticipantFloorActive\) return false/u,
    "participant floor must not stop local Caption Only PCM");
  assert.doesNotMatch(floorGate, /startLocalLiveCallFallback|restoreGatewayCaptionProducer|requestSubtitleStart|subtitle:audio/u,
    "floor changes only select the visible producer; they never restart the local provider");
  assert.match(suppressLateLocal, /isLiveParticipantFloorActive/u);
  assert.match(suppressLateLocal, /message\.source !== "live-call"/u,
    "local output is hidden only while a positively identified participant owns the floor");
  assert.match(reconnect, /reconnectLiveCallTranslation/u,
    "Gateway relay recovery remains separate from local caption rendering");
  assert.match(reconfigure, /activeCaptionSessionOwner === "live-call"[\s\S]*reconfigureLiveCallLocalProvider/u);
  assert.match(reconfigureLive, /captionProducer: "local"/u);
  assert.match(reconfigureLive, /kind: "live-call"/u);
  assert.match(reconfigureLive, /liveSessionId: activeLiveFloorSessionId/u,
    "same-session settings reconfigure must retain hybrid relay ownership and meeting identity");
  assert.doesNotMatch(dashboard, /async function startLocalLiveCallFallback|async function restoreGatewayCaptionProducer|subtitle:producer-stop|subtitle:producer-stopped/u);
});

test("Live Call polling leaves a caption-only local producer running", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const start = extractFunctionBody(dashboard, "async function startSubtitles()");
  const sync = extractFunctionBody(dashboard, "async function syncLiveCallAudioBridge()");
  const endedCallBranch = sync.slice(
    sync.indexOf("if (!liveState?.armed || !liveState.live)"),
    sync.indexOf("if (isLiveBridgeStarting)"),
  );

  assert.match(dashboard, /let activeCaptionSessionOwner = "none"/u,
    "caption lifecycle needs ownership separate from the local/gateway producer kind");
  assert.match(start, /activeCaptionSessionOwner = "caption-only"/u,
    "the ordinary Start Caption path must mark its session as independent of Live Call");
  assert.doesNotMatch(endedCallBranch, /activeCaptionProducer !== "none" \|\| state\.sessionId/u,
    "an idle Live Call poll must not stop every active caption session");
  assert.match(endedCallBranch, /activeCaptionSessionOwner === "live-call"[\s\S]*await stopSubtitles\(\)/u,
    "only a session owned by Live Call may be finalized when the call ends");
});

test("Live Call shutdown finalizes its hybrid ownership", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const sync = extractFunctionBody(dashboard, "async function syncLiveCallAudioBridge()");
  const hybrid = extractFunctionBody(dashboard, "async function startHybridCaptionSession(liveState)");
  const stop = extractFunctionBody(dashboard, "async function stopSubtitles({ waitForAcknowledgement = false } = {})");
  const endedCallBranch = sync.slice(
    sync.indexOf("if (!liveState?.armed || !liveState.live)"),
    sync.indexOf("if (isLiveBridgeStarting)"),
  );

  assert.match(hybrid, /activeCaptionSessionOwner = "live-call"/u,
    "the hybrid path must establish Live Call ownership");
  assert.match(endedCallBranch, /activeCaptionSessionOwner === "live-call"[\s\S]*await stopSubtitles\(\)/u,
    "call end must finalize the hybrid-owned session");
  assert.match(endedCallBranch, /stopLiveCallAudioBridge\("live call ended"\)/u);
  assert.match(stop, /activeCaptionSessionOwner = "none"/u,
    "stopping any caption session must clear stale ownership");
  assert.doesNotMatch(dashboard, /startLocalLiveCallFallback|restoreGatewayCaptionProducer/u);
});

test("caption runtime waits for the matching start acknowledgement before exposing controls", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const start = extractFunctionBody(dashboard, "async function startSubtitles()");
  const request = extractFunctionBody(dashboard, "function requestSubtitleStart(payload)");

  assert.match(dashboard, /const CAPTION_RUNTIME_TRANSITIONS = Object\.freeze/u,
    "caption lifecycle must be represented by one explicit state machine");
  assert.match(request, /message\.type === "subtitle:started"/u);
  assert.match(request, /message\.sessionId !== payload\.sessionId/u,
    "a stale acknowledgement from an older start must not open the controller");
  assert.match(request, /message\.captionProducer !== expectedProducer/u);
  assert.match(request, /message\.type === "subtitle:error" && message\.code === "SUBTITLE_START_FAILED"/u);
  assert.match(request, /message\.sessionId && message\.sessionId !== payload\.sessionId/u);
  assert.match(request, /message\.captionProducer && message\.captionProducer !== expectedProducer/u);
  const acknowledgementIndex = start.indexOf("await requestSubtitleStart(");
  const runningIndex = start.indexOf("state.running = true");
  const controllerIndex = start.indexOf("syncRuntimeOutputVisibility()");
  assert.ok(acknowledgementIndex >= 0 && runningIndex > acknowledgementIndex,
    "running must stay false until subtitle:started is received");
  assert.ok(controllerIndex > runningIndex,
    "the controller must become visible only after the acknowledged running state");
});

function createSubtitleStopHandshakeHarness() {
  const source = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const implementation = extractBalancedStatement(source, "function requestSubtitleStop(socket, sessionId)");
  const listeners = new Map();
  const timers = new Map();
  const sent = [];
  const socket = {
    readyState: 1,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    send(data) { sent.push(JSON.parse(data)); },
  };
  const context = {
    WebSocket: { OPEN: 1 }, crypto: { randomUUID: () => "stop-request-fixture" },
    SUBTITLE_STOP_ACK_TIMEOUT_MS: 10_000,
    window: { setTimeout(callback, milliseconds) { timers.set(1, { callback, milliseconds }); return 1; }, clearTimeout(id) { timers.delete(id); } },
  };
  const request = vm.runInNewContext(`${implementation}; requestSubtitleStop;`, context);
  return { request: (sessionId = "old-session") => request(socket, sessionId), sent, timers,
    listeners, socket, emit(message) {
      for (const handler of [...(listeners.get("message") ?? [])]) handler({ data: JSON.stringify(message) });
    }, close() { for (const handler of [...(listeners.get("close") ?? [])]) handler(); } };
}

test("Live Call transition waits for exactly its stop request and session acknowledgement", async () => {
  const harness = createSubtitleStopHandshakeHarness();
  let completed = false;
  const pending = harness.request().then(() => { completed = true; });
  assert.deepEqual(harness.sent, [{ type: "subtitle:stop", sessionId: "old-session", requestId: "stop-request-fixture" }]);
  harness.emit({ type: "subtitle:stopped", sessionId: "other-session", requestId: "stop-request-fixture" });
  harness.emit({ type: "subtitle:stopped", sessionId: "old-session", requestId: "old-request" });
  harness.emit({ type: "subtitle:started", sessionId: "old-session", requestId: "stop-request-fixture" });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(harness.timers.get(1).milliseconds, 10_000);
  harness.emit({ type: "subtitle:stopped", sessionId: "old-session", requestId: "stop-request-fixture" });
  await pending;
  assert.equal(completed, true);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.listeners.get("message").size, 0);
});

test("a stop timeout, closed socket, or matching stop failure never retries and retains a safe reason", async () => {
  for (const [mode, code] of [["timeout", "SUBTITLE_STOP_TIMEOUT"], ["close", "SUBTITLE_STOP_CONNECTION_CLOSED"], ["provider", "SUBTITLE_STOP_FAILED"], ["records", "SUBTITLE_STOP_FAILED"]]) {
    const harness = createSubtitleStopHandshakeHarness();
    const pending = assert.rejects(harness.request(), (error) => error !== null && typeof error === "object" && "code" in error && error.code === code);
    if (mode === "timeout") harness.timers.get(1).callback();
    else if (mode === "close") harness.close();
    else harness.emit({ type: "subtitle:error", code: mode === "records" ? "SUBTITLE_SESSION_FINALIZE_FAILED" : "SUBTITLE_PROVIDER_STOP_FAILED", requestId: "stop-request-fixture", sessionId: "old-session", message: "must not forward raw provider detail" });
    await pending;
    harness.emit({ type: "subtitle:stopped", requestId: "stop-request-fixture", sessionId: "old-session" });
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.listeners.get("message").size, 0);
  }
});

test("a cancelled preflight cannot start a new relay after its old stop acknowledgement arrives", async () => {
  const source = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const implementation = extractBalancedStatement(source, "async function startHybridCaptionSession(liveState)");
  let releaseStop = () => {};
  let reportStopEntered = () => {};
  const stopEntered = new Promise((resolve) => { reportStopEntered = () => resolve(); });
  const stopPending = new Promise((resolve) => { releaseStop = () => resolve(); });
  const stops = [];
  let starts = 0;
  const context = {
    liveBridgePreflightRequestId: "preflight-fixture", liveCaptionStartAttempt: null, state: { running: true, sessionId: "old-session" },
    ensureLiveCallProducerCapability: async () => {},
    stopSubtitles: async (options) => { stops.push(options); reportStopEntered(); await stopPending; },
    ensureWebSocketOpen: async () => {}, transitionCaptionRuntime() {},
    readSettingsFromForm: () => ({}), crypto: { randomUUID: () => "unused" },
    resolveLiveCallProducerKind: () => "gateway", liveCallProducerCapability: "fixture",
    requestSubtitleStart: async () => { starts += 1; }, liveTranslationStallMonitor: { reset() {} },
    startButton: {}, stopButton: {}, syncRuntimeOutputVisibility() {}, setConnectionStatus() {}, t: (key) => key,
    sendCurrentLiveCallFloorGate() {}, flushLiveCallCaptionRelayQueue() {},
  };
  const start = vm.runInNewContext(`${implementation}; startHybridCaptionSession;`, context);
  const pending = start({ sessionId: "call-next", preflightRequestId: "preflight-fixture" });
  await stopEntered;
  assert.equal(stops.length, 1);
  assert.equal(stops[0]?.waitForAcknowledgement, true);
  assert.equal(starts, 0);
  context.liveBridgePreflightRequestId = null;
  releaseStop();
  await assert.rejects(pending, (error) => error !== null && typeof error === "object" && "code" in error && error.code === "LIVE_CALL_PREFLIGHT_CANCELLED");
  assert.equal(starts, 0);
});

test("waiting for a stop acknowledgement keeps caption start locked through duplicate stop and releases on success or failure", async () => {
  const source = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const stopImplementation = extractBalancedStatement(source, "async function stopSubtitles({ waitForAcknowledgement = false } = {})");
  const startImplementation = extractBalancedStatement(source, "async function startSubtitles()");
  for (const outcome of ["acknowledged", "failed"]) {
    let releaseStop = () => {};
    let stopRequests = 0;
    let startWork = 0;
    const acknowledgement = new Promise((resolve, reject) => {
      releaseStop = () => outcome === "acknowledged" ? resolve() : reject(new Error("SUBTITLE_STOP_TIMEOUT"));
    });
    const context = {
      captionRuntimeState: "running", subtitleStopAcknowledgementPromise: null,
      state: { running: true, sessionId: "previous-caption", ws: { readyState: 1 } },
      startButton: { disabled: true }, stopButton: { disabled: false },
      transitionCaptionRuntime(next) { context.captionRuntimeState = next; },
      clearActiveSubtitleSurface() {}, stopLocalStreams() {},
      requestSubtitleStop() { stopRequests += 1; return acknowledgement; },
      WebSocket: { OPEN: 1 }, activeCaptionProducer: "local", activeCaptionSessionOwner: "caption-only",
      liveTranslationStallMonitor: { reset() {} }, resetLiveCallCaptionRelay() {},
      window: { clearTimeout() {} }, liveCaptionSocketRecoveryTimer: null, syncRuntimeOutputVisibility() {},
      clearError() { startWork += 1; },
    };
    const ui = vm.runInNewContext(`${stopImplementation}\n${startImplementation}\n({ stopSubtitles, startSubtitles });`, context);
    const stop = ui.stopSubtitles({ waitForAcknowledgement: true });
    assert.equal(context.captionRuntimeState, "stopping");
    assert.equal(context.startButton.disabled, true);
    assert.equal(context.stopButton.disabled, true);
    const repeatedStop = ui.stopSubtitles();
    await ui.startSubtitles();
    assert.equal(startWork, 0, "even a programmatic start cannot run capture during the handoff");
    assert.equal(stopRequests, 1);
    assert.equal(context.captionRuntimeState, "stopping");
    const completion = outcome === "failed"
      ? Promise.all([assert.rejects(stop, /SUBTITLE_STOP_TIMEOUT/), assert.rejects(repeatedStop, /SUBTITLE_STOP_TIMEOUT/)])
      : Promise.all([stop, repeatedStop]);
    releaseStop();
    await completion;
    assert.equal(context.captionRuntimeState, "idle");
    assert.equal(context.startButton.disabled, false);
    assert.equal(context.stopButton.disabled, true);
    assert.equal(context.subtitleStopAcknowledgementPromise, null);
  }
});

test("a timed-out or cancelled Live Call start cleans only its own pending session and never retries", async () => {
  const source = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const implementation = extractBalancedStatement(source, "async function startHybridCaptionSession(liveState)");
  for (const outcome of ["timeout", "cancelled", "superseded", "success"]) {
    let finishStart = () => {};
    let reportStartEntered = () => {};
    const entered = new Promise((resolve) => { reportStartEntered = () => resolve(); });
    const pendingStart = new Promise((resolve, reject) => {
      finishStart = () => outcome === "timeout"
        ? reject(Object.assign(new Error("SUBTITLE_START_TIMEOUT"), { code: "SUBTITLE_START_TIMEOUT" })) : resolve();
    });
    const calls = { starts: 0, stops: [], rendered: 0 };
    const context = {
      liveBridgePreflightRequestId: "preflight-fixture", liveCaptionStartAttempt: null,
      state: { running: false, sessionId: null }, activeCaptionProducer: "none", activeCaptionSessionOwner: "none",
      ensureLiveCallProducerCapability: async () => {}, ensureWebSocketOpen: async () => {},
      stopSubtitles: async (options) => { calls.stops.push({ ...options, sessionId: context.state.sessionId }); context.state.sessionId = null; },
      transitionCaptionRuntime() {}, readSettingsFromForm: () => ({}), crypto: { randomUUID: () => "unused" },
      resolveLiveCallProducerKind: () => "gateway", liveCallProducerCapability: "fixture",
      requestSubtitleStart: async () => { calls.starts += 1; reportStartEntered(); await pendingStart; },
      liveTranslationStallMonitor: { reset() {} }, startButton: {}, stopButton: {},
      syncRuntimeOutputVisibility() {}, setConnectionStatus() { calls.rendered += 1; }, t: (key) => key,
      sendCurrentLiveCallFloorGate() {}, flushLiveCallCaptionRelayQueue() {},
    };
    const start = vm.runInNewContext(`${implementation}; startHybridCaptionSession;`, context);
    const pending = start({ sessionId: "call-next", preflightRequestId: "preflight-fixture" });
    await entered;
    if (outcome === "cancelled") context.liveBridgePreflightRequestId = null;
    if (outcome === "superseded") {
      context.liveCaptionStartAttempt = {};
      context.state.sessionId = "newer-owner";
    }
    finishStart();
    if (outcome === "success") await pending;
    else await assert.rejects(pending, (error) => error !== null && typeof error === "object" && "code" in error
      && error.code === (outcome === "timeout" ? "SUBTITLE_START_TIMEOUT" : "LIVE_CALL_PREFLIGHT_CANCELLED"));
    assert.equal(calls.starts, 1, `${outcome}: no automatic second paid start`);
    assert.equal(calls.rendered, outcome === "success" ? 1 : 0);
    assert.equal(context.state.running, outcome === "success");
    if (outcome === "timeout" || outcome === "cancelled") {
      assert.deepEqual(calls.stops, [{ waitForAcknowledgement: true, sessionId: "live-call-next" }]);
    } else {
      assert.deepEqual(calls.stops, [], `${outcome}: no cleanup of an unrelated session`);
    }
  }
});

test("text translation failures show their safe reason without clearing captions or restarting either producer", async () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const signatures = [
    "async function handleSubtitleRuntimeError(message)",
    "async function stopSubtitles({ waitForAcknowledgement = false } = {})",
    "function clearActiveSubtitleSurface()",
    "function showError(error)",
    "function setPreviewText(translatedText, sourceText, partial)",
  ];
  const implementation = signatures.map((signature) => extractBalancedStatement(dashboard, signature)).join("\n");
  for (const owner of ["caption-only", "live-call"]) {
    for (const runtime of ["running", "starting"]) {
      const translation = { textContent: "이미 확정된 번역" };
      const source = { textContent: "" };
      const history = { records: [{ translatedText: "이미 확정된 번역" }] };
      const calls = { stopCapture: 0, reconnect: 0, socketSend: 0, clearTimer: 0 };
      const errorBox = { hidden: true, textContent: "", classList: { remove() {} } };
      const context = {
        captionRuntimeState: runtime,
        activeCaptionSessionOwner: owner,
        liveBridgePreflightRequestId: null,
        state: { running: true, sessionId: "session-a", history, previewStatusTimer: null,
          ws: { readyState: 1, send() { calls.socketSend += 1; } } },
        preview: { querySelector(selector) { return selector === ".translation-line" ? translation : source; },
          classList: { remove() {}, toggle() {} } },
        errorBox,
        t: (key) => key,
        transitionCaptionRuntime() {}, setConnectionStatus() {}, setRealtimeApiStatus() {},
        reconnectLiveCallTranslation: async () => { calls.reconnect += 1; },
        stopLocalStreams() { calls.stopCapture += 1; },
        clearTimeout() { calls.clearTimer += 1; },
        window: { clearTimeout() {} }, WebSocket: { OPEN: 1 },
        performance: { now: () => 1000 },
        liveTranslationStallMonitor: { reset() {}, noteOutput() {} }, resetLiveCallCaptionRelay() {},
        liveCaptionSocketRecoveryTimer: null, activeCaptionProducer: "local",
        startButton: { disabled: false }, stopButton: { disabled: false },
        syncRuntimeOutputVisibility() {}, appendScreenPermissionAction() {},
      };
      const ui = vm.runInNewContext(`${implementation}; ({ handleSubtitleRuntimeError, setPreviewText });`, context);
      for (const reason of ["HTTP_AUTH", "QUOTA", "TIMEOUT", "EMPTY", "LANGUAGE", "ECHO"]) {
        const message = `번역을 확정하지 못했습니다: ${reason}`;
        await ui.handleSubtitleRuntimeError({ type: "subtitle:error", code: "TEXT_TRANSLATION_FAILED", reason, message, targetLanguage: "en" });
        assert.equal(errorBox.hidden, false, `${owner}/${runtime}/${reason}: visible explanation`);
        assert.equal(errorBox.textContent, message);
        assert.equal(translation.textContent, "이미 확정된 번역");
        assert.equal(context.state.running, true);
        assert.equal(context.state.sessionId, "session-a");
        assert.equal(context.state.history, history);
        assert.deepEqual(history.records, [{ translatedText: "이미 확정된 번역" }]);
      }
      assert.deepEqual(calls, { stopCapture: 0, reconnect: 0, socketSend: 0, clearTimer: 0 });
      ui.setPreviewText("이후 정상 확정 번역", "source", false);
      assert.equal(translation.textContent, "이후 정상 확정 번역", "new captions remain renderable after a failed line");
    }
  }
});

test("repeated text translation failures count source progress without disabling genuine stall recovery", async () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const monitorImplementation = extractBalancedStatement(dashboard, "function createLiveTranslationStallMonitor");
  const handlerImplementation = extractBalancedStatement(dashboard, "async function handleSubtitleRuntimeError(message)");
  let now = 0;
  let recoveries = 0;
  let shownErrors = 0;
  const context = {
    activeCaptionSessionOwner: "live-call", captionRuntimeState: "running", state: { running: true },
    liveBridgePreflightRequestId: null,
    performance: { now: () => now },
    requestRecovery: () => { recoveries += 1; },
    reconnectLiveCallTranslation: async () => { recoveries += 1; },
    showError() { shownErrors += 1; },
  };
  const ui = vm.runInNewContext(`${monitorImplementation};
    const liveTranslationStallMonitor = createLiveTranslationStallMonitor(requestRecovery, 2000, 1000);
    ${handlerImplementation}; ({ handleSubtitleRuntimeError, monitor: liveTranslationStallMonitor });`, context);
  ui.monitor.noteInput("mic", true, now, true);
  for (now = 500; now <= 10000; now += 500) {
    if (now % 1000 === 0) {
      await ui.handleSubtitleRuntimeError({ code: "TEXT_TRANSLATION_FAILED", reason: "QUOTA", message: "번역 요청 한도를 확인해 주세요." });
    }
    ui.monitor.noteInput("mic", true, now, true);
  }
  assert.equal(shownErrors, 10);
  assert.equal(recoveries, 0, "arriving source utterances must not be mistaken for a stalled input pipeline");
  for (now = 10500; now <= 15000; now += 500) ui.monitor.noteInput("mic", true, now, true);
  assert.equal(recoveries, 1, "continued input without source progress still requests one existing recovery");
});

test("Live Call recovery keeps its controller and record while fatal caption-only errors still stop", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const errorHandler = extractFunctionBody(dashboard, "async function handleSubtitleRuntimeError(message)");
  const reconnect = extractFunctionBody(dashboard, "async function reconnectLiveCallTranslation()");
  const stop = extractFunctionBody(dashboard, "async function stopSubtitles({ waitForAcknowledgement = false } = {})");

  assert.match(dashboard, /message\.type === "subtitle:error"[\s\S]*handleSubtitleRuntimeError\(message\)/u);
  assert.match(errorHandler, /activeCaptionSessionOwner === "live-call"/u);
  assert.match(errorHandler, /transitionCaptionRuntime\("reconnecting"\)/u);
  assert.match(errorHandler, /await reconnectLiveCallTranslation\(\)/u);
  const liveRecoveryBranch = errorHandler.slice(0, errorHandler.indexOf("await stopSubtitles()"));
  assert.doesNotMatch(liveRecoveryBranch, /setControllerWindowVisible\(false\)|await stopSubtitles\(\)/u,
    "recoverable Live errors must not hide the controller or end the record");
  assert.match(errorHandler, /await stopSubtitles\(\)/u,
    "the non-Live branch must preserve Caption-only's stop-on-error behaviour");

  assert.match(reconnect, /bridge\?\.reconnectLiveCallTranslation/u);
  assert.match(reconnect, /await bridge\.reconnectLiveCallTranslation\(\)/u);
  assert.match(reconnect, /const sessionId = state\.sessionId/u);
  assert.doesNotMatch(reconnect, /state\.sessionId = null|type: "subtitle:stop"|await stopSubtitles\(\)/u,
    "Live translation recovery must preserve the app session and committed transcript");
  assert.doesNotMatch(reconnect, /translatedAudio|audio-control/u);
  assert.doesNotMatch(reconnect, /clearUncommittedPreview\(\)/u,
    "recovery must retain the latest partial until a snapshot or newer canonical event replaces it");
  assert.match(stop, /state\.sessionId = null/u,
    "the explicit stop path remains the only path that finalizes the session");
});

test("non-translation runtime errors retain fatal cleanup, Live Call recovery, and start acknowledgement ownership", async () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const implementation = extractBalancedStatement(dashboard, "async function handleSubtitleRuntimeError(message)");
  /** @type {string[]} */
  const calls = [];
  const context = {
    captionRuntimeState: "running", activeCaptionSessionOwner: "caption-only",
    liveBridgePreflightRequestId: "", state: { running: true },
    t: (key) => key,
    transitionCaptionRuntime() {}, setConnectionStatus() {}, setRealtimeApiStatus() {},
    stopSubtitles: async () => { calls.push("stop"); },
    reconnectLiveCallTranslation: async () => { calls.push("reconnect"); },
    showError(error) { calls.push(error.message); },
  };
  const handle = vm.runInNewContext(`${implementation}; handleSubtitleRuntimeError;`, context);
  await handle({ code: "SUBTITLE_RUNTIME_FAILED", message: "기존 오류 안내" });
  assert.deepEqual(calls.splice(0), ["stop", "기존 오류 안내"]);
  context.activeCaptionSessionOwner = "live-call";
  await handle({ code: "SUBTITLE_RUNTIME_FAILED", message: "기존 오류 안내" });
  assert.deepEqual(calls.splice(0), ["reconnect"]);
  context.captionRuntimeState = "starting";
  await handle({ code: "SUBTITLE_START_FAILED", message: "시작 실패" });
  assert.deepEqual(calls, [], "the matching start promise still owns startup failure cleanup");
  context.captionRuntimeState = "running";
  context.liveBridgePreflightRequestId = "preflight-a";
  await handle({ code: "SUBTITLE_PREFLIGHT_FAILED", message: "준비 실패" });
  assert.deepEqual(calls, []);
});

test("Live Call requests one immediate recovery after two seconds of signalled input without captions", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const factorySource = extractBalancedStatement(dashboard, "function createLiveTranslationStallMonitor");
  const createMonitor = new Function(`${factorySource}; return createLiveTranslationStallMonitor;`)();
  const recoveries = [];
  const monitor = createMonitor(() => recoveries.push("recover"), 2_000, 250);

  assert.equal(monitor.noteInput("mic", true, 0, true), false);
  for (let now = 200; now < 2_000; now += 200) monitor.noteInput("mic", true, now, true);
  assert.equal(monitor.noteInput("mic", true, 2_000, true), true);
  assert.deepEqual(recoveries, ["recover"]);
  monitor.noteInput("mic", true, 4_500, true);
  assert.deepEqual(recoveries, ["recover"], "one stall window must never request duplicate reconnects");

  monitor.noteOutput(5_000);
  for (let now = 5_200; now < 7_000; now += 200) monitor.noteInput("mic", true, now, true);
  assert.equal(monitor.noteInput("mic", true, 7_000, true), true, "caption output rearms the two-second deadline");
  assert.deepEqual(recoveries, ["recover", "recover"]);

  monitor.reset();
  monitor.noteInput("mic", true, 10_000, true);
  monitor.noteInput("mic", false, 10_100, true);
  monitor.noteInput("mic", false, 13_000, true);
  assert.deepEqual(recoveries, ["recover", "recover"], "silence must not trigger recovery");
  monitor.noteInput("mic", true, 14_000, false);
  monitor.noteInput("mic", true, 17_000, false);
  assert.deepEqual(recoveries, ["recover", "recover"], "participant floor or audio suppression must suspend recovery");

  assert.match(dashboard, /LIVE_TRANSLATION_STALL_MILLISECONDS = 2_000/u);
  assert.match(dashboard, /noteInput\(\s*sourceName,\s*hasSignal,\s*now,[\s\S]{0,180}!isLiveParticipantFloorActive/u);
  assert.match(dashboard, /noteOutput\(performance\.now\(\)\)/u);
  assert.match(dashboard, /String\(message\.translatedText \?\? ""\)\.trim\(\)/u);
  assert.match(dashboard, /void reconnectLiveCallTranslation\(\)/u);
});

test("Gemini-only subtitle settings never write the retired OpenAI realtime translation model", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  assert.doesNotMatch(dashboard, /gpt-realtime-translate/u);
  assert.match(dashboard, /translationProvider: "gemini"/u);
});

test("a local socket drop re-registers the same Live session without controller flicker", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const connect = extractFunctionBody(dashboard, "function connectWebSocket()");
  const recover = extractFunctionBody(dashboard, "async function recoverLiveCaptionSocket()");

  assert.match(connect, /activeCaptionSessionOwner === "live-call" && state\.running/u);
  assert.match(connect, /transitionCaptionRuntime\("reconnecting"\)/u);
  assert.match(connect, /captionWebSocketReconnectTimer = window\.setTimeout\(connectWebSocket, 1_000\)/u);
  assert.match(connect, /void recoverLiveCaptionSocket\(\)/u);
  const liveCloseBranch = connect.slice(
    connect.indexOf('if (activeCaptionSessionOwner === "live-call" && state.running)'),
    connect.indexOf('setConnectionStatus(t("status.disconnected")'),
  );
  assert.doesNotMatch(liveCloseBranch, /stopSubtitles\(|setControllerWindowVisible\(false\)/u);
  assert.match(recover, /const sessionId = state\.sessionId/u);
  assert.match(recover, /await requestSubtitleStart/u);
  assert.match(recover, /sessionId,/u);
  // 복구는 원래 시작과 같은 프로듀서 종류(기본 gateway, opt-in hybrid)로 재등록한다.
  assert.match(recover, /resolveLiveCallProducerKind\(\)/u);
  assert.match(recover, /captionProducer: recoveredProducerKind/u);
  assert.match(recover, /activeCaptionProducer = recoveredProducerKind/u);
  assert.doesNotMatch(recover, /state\.sessionId = null|stopSubtitles\(|subtitle:stop/u);
});

test("gateway captions relay both speakers while hybrid remains participant-only with floor and session fences", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const begin = dashboard.indexOf("// 2026-07-27 fix: The hidden dashboard can reconnect independently");
  const end = dashboard.indexOf("// subtitle-workspace.js repaints", begin);
  const registration = extractBalancedStatement(dashboard, "if (window.realtimeNoelDesktop?.onLiveCallCaption)");
  for (const producer of ["gateway", "hybrid"]) {
    const received = [];
    /** @type {(caption: Record<string, unknown>) => void} */
    let onCaption = () => { throw new Error("missing caption callback"); };
    const context = {
      activeCaptionProducer: producer, activeCaptionSessionOwner: "live-call", captionRuntimeState: "running",
      activeLiveFloorSessionId: "current-call", activeLiveParticipantId: producer === "hybrid" ? "viewer-1" : "",
      lastAuthorizedLiveParticipantId: "viewer-1", isLiveParticipantFloorActive: true,
      liveFloorGateRevision: 1, appliedLiveFloorGateRevision: producer === "hybrid" ? 1 : -1,
      liveCallProducerCapability: "safe-fixture-capability",
      state: { running: true, sessionId: "live-current-call", ws: { readyState: 1, bufferedAmount: 0, send(value) { received.push(JSON.parse(value)); } } },
      WebSocket: { OPEN: 1 }, t: () => "Participant",
      window: { setTimeout, clearTimeout, realtimeNoelDesktop: { onLiveCallCaption(callback) { onCaption = callback; } } },
    };
    const ui = vm.runInNewContext(`${dashboard.slice(begin, end)}\n${registration}\n({ flushLiveCallCaptionRelayQueue });`, context);
    const host = { sessionId: "current-call", language: "en", sourceLanguage: "ko", text: "Host final", isFinal: true, seq: 1, utteranceKey: "host-one", speakerRole: "host" };
    const participant = { ...host, text: "Participant final", seq: 2, utteranceKey: "participant-two", speakerRole: "participant", speaker: { participantId: "viewer-1", name: "Participant", isParticipant: true } };
    onCaption(host); onCaption(participant); onCaption(host); onCaption(participant);
    assert.deepEqual(received.map((item) => item.translatedText), producer === "gateway" ? ["Host final", "Participant final"] : ["Participant final"]);
    assert.ok(received.every((item) => item.producerCapability === "safe-fixture-capability" && item.sessionId === "current-call"));
    const count = received.length;
    onCaption({ ...host, sessionId: "old-call", utteranceKey: "old-host" });
    context.activeCaptionSessionOwner = "caption-only";
    onCaption({ ...participant, seq: 3, utteranceKey: "outside-live" });
    assert.equal(received.length, count);
    context.activeCaptionSessionOwner = "live-call";
    if (producer === "hybrid") {
      onCaption({ ...participant, seq: 4, utteranceKey: "wrong-speaker", speaker: { participantId: "viewer-other", isParticipant: true } });
      context.appliedLiveFloorGateRevision = 0;
      onCaption({ ...participant, seq: 5, utteranceKey: "awaiting-floor" });
      assert.equal(received.length, count, "hybrid relays must still await the authorized floor acknowledgement");
      context.appliedLiveFloorGateRevision = 1;
      ui.flushLiveCallCaptionRelayQueue();
      assert.equal(received.length, count + 1);
      assert.equal(received.at(-1).utteranceKey, "awaiting-floor");
    }
  }
});

test("Live Call relay survives renderer socket stalls without losing finals or replaying stale partials", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const relayStart = dashboard.indexOf("// 2026-07-27 fix: The hidden dashboard can reconnect independently");
  const relayEnd = dashboard.indexOf("// subtitle-workspace.js repaints", relayStart);
  assert.ok(relayStart >= 0 && relayEnd > relayStart, "the relay section must remain independently testable");
  const relaySource = dashboard.slice(relayStart, relayEnd);
  const registration = extractBalancedStatement(
    dashboard,
    "if (window.realtimeNoelDesktop?.onLiveCallCaption)",
  );
  const received = [];
  const socket = {
    readyState: 0,
    send(payload) { received.push(JSON.parse(payload)); },
  };
  /** @type {(caption: Record<string, unknown>) => void} */
  let onCaption = () => { throw new Error("Live Call caption callback was not registered"); };
  const missingCaptionCallback = onCaption;
  const context = {
    activeCaptionProducer: "hybrid",
    activeCaptionSessionOwner: "live-call",
    captionRuntimeState: "running",
    activeLiveFloorSessionId: "live-stall",
    activeLiveParticipantId: "viewer-1",
    // The relay authorizes a participant caption against the last floor holder
    // so a final that lands after the turn ends is still delivered.
    lastAuthorizedLiveParticipantId: "viewer-1",
    isLiveParticipantFloorActive: true,
    liveFloorGateRevision: 1,
    appliedLiveFloorGateRevision: 1,
    liveCallCaptionRelayFlushTimer: null,
    liveCallCaptionRelayQueue: [],
    liveCallFinalizedCaptionKeys: new Map(),
    MAX_LIVE_CALL_PENDING_PARTIALS: 32,
    MAX_LIVE_CALL_FINALIZED_KEYS: 512,
    LIVE_CALL_CAPTION_RELAY_BUFFER_LIMIT: 1_000_000,
    state: { ws: socket, running: true, sessionId: "live-stall" },
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSED: 3 },
    window: {
      setTimeout,
      clearTimeout,
      realtimeNoelDesktop: {
        onLiveCallCaption(callback) { onCaption = callback; },
      },
    },
    t: () => "Participant",
    JSON,
    Number,
    String,
    Map,
    Set,
  };
  const relay = vm.runInNewContext(
    `${relaySource}\n${registration}\n({ enqueueLiveCallCaptionRelay, flushLiveCallCaptionRelayQueue })`,
    context,
  );
  assert.notEqual(onCaption, missingCaptionCallback, "the desktop bridge must register its caption callback");

  const caption = (overrides = {}) => ({
    type: "caption",
    sessionId: "live-stall",
    language: "en",
    sourceLanguage: "ko",
    utteranceKey: "turn-a",
    seq: 1,
    text: "draft",
    isFinal: false,
    translationStatus: "translated",
    speakerRole: "participant",
    speaker: { isParticipant: true, participantId: "viewer-1" },
    ...overrides,
  });

  // Renderer IPC keeps arriving while its local WS is CONNECTING. A rapid
  // provider burst may replace only the partial for the same canonical key.
  for (let seq = 1; seq <= 1_000; seq += 1) {
    onCaption(caption({ seq, text: `draft-${seq}` }));
  }
  onCaption(caption({ seq: 1_001, text: "First final", isFinal: true }));
  onCaption(caption({
    utteranceKey: "turn-b",
    seq: 1_002,
    text: "Second final",
    isFinal: true,
  }));
  onCaption(caption({ seq: 999, text: "stale after final", isFinal: false }));
  assert.deepEqual(received, [], "CONNECTING must enqueue instead of dropping or sending");

  socket.readyState = context.WebSocket.OPEN;
  relay.flushLiveCallCaptionRelayQueue();
  const finals = received.filter((message) => message.partial === false);
  assert.deepEqual(
    finals.map((message) => [message.sourceSeq, message.utteranceKey, message.translatedText]),
    [
      [1_001, "turn-a", "First final"],
      [1_002, "turn-b", "Second final"],
    ],
    "every final survives and flushes in canonical sequence order",
  );
  assert.equal(
    received.some((message) => message.translatedText === "stale after final"),
    false,
    "a late partial below the final sequence floor must be discarded",
  );

  // A temporarily blocked renderer send is not an acknowledgement. The final
  // stays pending and is delivered exactly once after the next flush.
  socket.readyState = context.WebSocket.CLOSED;
  onCaption(caption({ utteranceKey: "turn-c", seq: 1_003, text: "Third final", isFinal: true }));
  socket.readyState = context.WebSocket.OPEN;
  const originalSend = socket.send;
  socket.send = () => { throw new Error("renderer stalled"); };
  assert.doesNotThrow(() => relay.flushLiveCallCaptionRelayQueue());
  socket.send = originalSend;
  relay.flushLiveCallCaptionRelayQueue();
  assert.equal(received.filter((message) => message.sourceSeq === 1_003).length, 1);
});

test("Live Call reconnect flushes queued captions only after producer recovery is acknowledged", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const recover = extractFunctionBody(dashboard, "async function recoverLiveCaptionSocket()");
  const acknowledgement = recover.indexOf("await requestSubtitleStart(");
  const localAcknowledgement = recover.indexOf('captionProducer: "local"');
  const snapshot = recover.indexOf("liveState.captionSnapshot");
  const flush = recover.indexOf("flushLiveCallCaptionRelayQueue()");
  assert.ok(acknowledgement >= 0, "gateway producer recovery must await its matching start acknowledgement");
  assert.ok(snapshot > acknowledgement, "the acknowledged recovery must consume the producer snapshot");
  assert.ok(snapshot > localAcknowledgement, "snapshot relay must also wait for local provider recovery");
  assert.ok(flush > snapshot, "snapshot captions must enter the relay before queued events flush");
  assert.ok(flush > acknowledgement, "queued captions may flush only after producer recovery succeeds");
});

test("Live Call relay bounds partial memory without discarding finals during a long renderer outage", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const relayStart = dashboard.indexOf("// 2026-07-27 fix: The hidden dashboard can reconnect independently");
  const relayEnd = dashboard.indexOf("// subtitle-workspace.js repaints", relayStart);
  assert.ok(relayStart >= 0 && relayEnd > relayStart, "the relay section must remain independently testable");
  const received = [];
  const socket = {
    readyState: 3,
    bufferedAmount: 0,
    send(payload) { received.push(JSON.parse(payload)); },
  };
  const context = {
    activeCaptionProducer: "hybrid",
    activeCaptionSessionOwner: "live-call",
    captionRuntimeState: "running",
    activeLiveParticipantId: "viewer-1",
    liveFloorGateRevision: 1,
    appliedLiveFloorGateRevision: 1,
    liveCallCaptionRelayFlushTimer: null,
    liveCallCaptionRelayQueue: [],
    liveCallFinalizedCaptionKeys: new Map(),
    MAX_LIVE_CALL_PENDING_PARTIALS: 32,
    MAX_LIVE_CALL_FINALIZED_KEYS: 512,
    LIVE_CALL_CAPTION_RELAY_BUFFER_LIMIT: 1_000_000,
    state: { ws: socket, running: true, sessionId: "live-long-outage" },
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSED: 3 },
    window: { setTimeout, clearTimeout },
    t: () => "Participant",
    console,
    JSON,
    Number,
    String,
    Map,
    Set,
  };
  const relay = vm.runInNewContext(
    `${dashboard.slice(relayStart, relayEnd)}\n({ enqueueLiveCallCaptionRelay, flushLiveCallCaptionRelayQueue, liveCallCaptionRelayQueue })`,
    context,
  );
  const caption = (seq, isFinal) => ({
    sessionId: "live-long-outage",
    language: "en",
    sourceLanguage: "ko",
    utteranceKey: `turn-${seq}`,
    seq,
    text: isFinal ? `final-${seq}` : `partial-${seq}`,
    isFinal,
    translationStatus: "translated",
  });

  for (let seq = 1; seq <= 100; seq += 1) relay.enqueueLiveCallCaptionRelay(caption(seq, false));
  assert.ok(
    relay.liveCallCaptionRelayQueue.filter((entry) => !entry.isFinal).length <= 32,
    "only the replaceable partial backlog may be bounded",
  );
  for (let seq = 101; seq <= 700; seq += 1) relay.enqueueLiveCallCaptionRelay(caption(seq, true));
  assert.equal(
    relay.liveCallCaptionRelayQueue.filter((entry) => entry.isFinal).length,
    600,
    "a prolonged outage must never evict finalized captions",
  );
  relay.enqueueLiveCallCaptionRelay(caption(101, false));
  assert.equal(
    relay.liveCallCaptionRelayQueue.some(
      (entry) => !entry.isFinal && entry.payload.sourceSeq === 101,
    ),
    false,
    "the finalized-key memory cap must not allow a very late partial to replay after its final",
  );

  socket.readyState = context.WebSocket.OPEN;
  relay.flushLiveCallCaptionRelayQueue();
  assert.deepEqual(
    received.filter((message) => message.partial === false).map((message) => message.sourceSeq),
    Array.from({ length: 600 }, (_, index) => index + 101),
    "all finals flush once and in source order",
  );
});

test("Live Call relay refuses captions when gateway ownership is inactive", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const relayStart = dashboard.indexOf("// 2026-07-27 fix: The hidden dashboard can reconnect independently");
  const relayEnd = dashboard.indexOf("// subtitle-workspace.js repaints", relayStart);
  const registration = extractBalancedStatement(
    dashboard,
    "if (window.realtimeNoelDesktop?.onLiveCallCaption)",
  );
  const received = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload) { received.push(JSON.parse(payload)); },
  };
  /** @type {(caption: Record<string, unknown>) => void} */
  let onCaption = () => { throw new Error("Live Call caption callback was not registered"); };
  const missingCaptionCallback = onCaption;
  const context = {
    activeCaptionProducer: "local",
    activeCaptionSessionOwner: "live-call",
    captionRuntimeState: "running",
    activeLiveFloorSessionId: "live-inactive",
    activeLiveParticipantId: "viewer-1",
    liveFloorGateRevision: 1,
    appliedLiveFloorGateRevision: 1,
    liveCallCaptionRelayFlushTimer: null,
    liveCallCaptionRelayQueue: [],
    liveCallFinalizedCaptionKeys: new Map(),
    MAX_LIVE_CALL_PENDING_PARTIALS: 32,
    MAX_LIVE_CALL_FINALIZED_KEYS: 512,
    LIVE_CALL_CAPTION_RELAY_BUFFER_LIMIT: 1_000_000,
    state: { ws: socket, running: true, sessionId: "live-inactive" },
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSED: 3 },
    window: {
      setTimeout,
      clearTimeout,
      realtimeNoelDesktop: { onLiveCallCaption(callback) { onCaption = callback; } },
    },
    t: () => "Participant",
    console,
    JSON,
    Number,
    String,
    Map,
    Set,
  };
  const relay = vm.runInNewContext(
    `${dashboard.slice(relayStart, relayEnd)}\n${registration}\n({ flushLiveCallCaptionRelayQueue })`,
    context,
  );
  assert.notEqual(onCaption, missingCaptionCallback, "the desktop bridge must register its caption callback");
  onCaption({
    sessionId: "live-inactive",
    language: "en",
    sourceLanguage: "ko",
    utteranceKey: "duplicate-turn",
    seq: 77,
    text: "caption received outside gateway ownership",
    isFinal: true,
    translationStatus: "translated",
    speakerRole: "participant",
    speaker: { isParticipant: true, participantId: "viewer-1" },
  });
  context.activeCaptionProducer = "hybrid";
  relay.flushLiveCallCaptionRelayQueue();
  assert.deepEqual(received, [], "inactive gateway ownership must not leak delayed captions");
});

test("Live Call recovery merges an older snapshot before newer queued IPC captions", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const relayStart = dashboard.indexOf("// 2026-07-27 fix: The hidden dashboard can reconnect independently");
  const relayEnd = dashboard.indexOf("// subtitle-workspace.js repaints", relayStart);
  const received = [];
  const socket = {
    readyState: 3,
    bufferedAmount: 0,
    send(payload) { received.push(JSON.parse(payload)); },
  };
  const context = {
    activeCaptionProducer: "hybrid",
    activeCaptionSessionOwner: "live-call",
    captionRuntimeState: "reconnecting",
    activeLiveParticipantId: "viewer-1",
    liveFloorGateRevision: 1,
    appliedLiveFloorGateRevision: 1,
    liveCallCaptionRelayFlushTimer: null,
    liveCallCaptionRelayQueue: [],
    liveCallFinalizedCaptionKeys: new Map(),
    MAX_LIVE_CALL_PENDING_PARTIALS: 32,
    MAX_LIVE_CALL_FINALIZED_KEYS: 512,
    LIVE_CALL_CAPTION_RELAY_BUFFER_LIMIT: 1_000_000,
    state: { ws: socket, running: true, sessionId: "live-snapshot-merge" },
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSED: 3 },
    window: { setTimeout, clearTimeout },
    t: () => "Participant",
    console,
    JSON,
    Number,
    String,
    Map,
    Set,
  };
  const relay = vm.runInNewContext(
    `${dashboard.slice(relayStart, relayEnd)}\n({ enqueueLiveCallCaptionRelay, flushLiveCallCaptionRelayQueue })`,
    context,
  );
  const caption = (seq, utteranceKey, text, isFinal = true) => ({
    sessionId: "live-snapshot-merge",
    language: "en",
    sourceLanguage: "ko",
    utteranceKey,
    seq,
    text,
    isFinal,
    translationStatus: "translated",
  });

  // IPC can advance while the renderer is waiting for its local start ACK.
  relay.enqueueLiveCallCaptionRelay(caption(101, "turn-101", "newer IPC final"));
  // The recovery snapshot is read only after that ACK, so its older event is
  // appended later in wall-clock time but must commit first in source order.
  relay.enqueueLiveCallCaptionRelay(caption(100, "turn-100", "snapshot partial", false));
  relay.enqueueLiveCallCaptionRelay(caption(100, "turn-100", "snapshot final"));

  socket.readyState = context.WebSocket.OPEN;
  context.captionRuntimeState = "running";
  relay.flushLiveCallCaptionRelayQueue();
  assert.deepEqual(
    received.map((message) => [message.sourceSeq, message.partial, message.translatedText]),
    [
      [100, false, "snapshot final"],
      [101, false, "newer IPC final"],
    ],
    "snapshot merge must sort by source sequence and replace its same-turn partial",
  );
});

test("controller restart dispatches by owner without changing Caption-only restart semantics", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const dispatch = extractFunctionBody(dashboard, "async function restartCaptionsFromController()");
  const ordinaryRestart = extractFunctionBody(dashboard, "async function restartSubtitles()");

  assert.match(dispatch, /activeCaptionSessionOwner === "live-call"/u);
  assert.match(dispatch, /await reconnectLiveCallTranslation\(\)/u);
  assert.match(dispatch, /await restartSubtitles\(\)/u);
  assert.match(dashboard, /controllerRestartButton\?\.addEventListener\("click", restartCaptionsFromController\)/u);
  assert.match(dashboard, /message\.command === "restart"[\s\S]*await restartCaptionsFromController\(\)/u);
  assert.match(ordinaryRestart, /await stopSubtitles\(\);[\s\S]*await startSubtitles\(\)/u,
    "Caption-only keeps the established full stop/start restart");
});

test("Live Call preflight proves renderer capture and local subtitle readiness before paid start", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const preflight = extractFunctionBody(dashboard, "async function handleLiveCallPreflight(request)");
  const requestReady = extractFunctionBody(dashboard, "function requestLocalSubtitlePreflight(requestId, request)");
  const cancel = extractFunctionBody(dashboard, "async function cancelLiveCallPreflight(request)");
  const sync = extractFunctionBody(dashboard, "async function syncLiveCallAudioBridge()");

  assert.match(dashboard, /window\.realtimeNoelDesktop\?\.onLiveCallPreflight\?\.\(handleLiveCallPreflight\)/u);
  assert.match(dashboard, /window\.realtimeNoelDesktop\?\.onLiveCallPreflightCancel\?\.\(cancelLiveCallPreflight\)/u);
  assert.match(preflight, /await startLiveCallMicCapture\(\{ requestId \}\)/u,
    "preflight must use the same capture path as the running Live bridge");
  assert.match(dashboard, /if \(liveBridgeCaptureStartPromise\) return liveBridgeCaptureStartPromise/u,
    "concurrent preflights must await the real capture result instead of observing an unfinished capture as ready");
  assert.match(dashboard, /if \(liveBridgeCapture !== capture\) \{[\s\S]*streamer\.close\?\.\(\)[\s\S]*cancelled: true/u,
    "a cancellation racing streamer creation must close the late streamer instead of leaking capture");
  assert.match(preflight, /await requestLocalSubtitlePreflight\(requestId, request\)/u);
  assert.match(preflight, /completeLiveCallPreflight\(requestId, \{ ok: true \}\)/u);
  assert.match(preflight, /LIVE_CALL_AUDIO_CAPTURE_FAILED/u);
  assert.match(preflight, /LIVE_CALL_SUBTITLE_PREFLIGHT_FAILED/u);
  assert.match(requestReady, /type: "subtitle:preflight"/u);
  assert.match(requestReady, /kind: "live-call"/u);
  assert.match(requestReady, /liveSessionId: String\(request\?\.liveSessionId/u);
  assert.match(requestReady, /message\.type !== "subtitle:preflight-ready"/u);
  assert.match(requestReady, /message\.type === "subtitle:preflight-failed"/u);
  assert.match(requestReady, /message\.requestId !== requestId/u);
  assert.doesNotMatch(preflight, /stopSubtitles\(|setControllerWindowVisible\(false\)/u,
    "preflight must not affect the controller or transcript lifecycle");
  const connect = extractFunctionBody(dashboard, "function connectWebSocket()");
  assert.match(connect, /if \(liveBridgePreflightRequestId\)[\s\S]*return;/u,
    "a socket drop during preflight must fail the handshake without stopping or hiding an existing controller");
  assert.match(cancel, /requestId !== liveBridgePreflightRequestId/u);
  assert.match(cancel, /if \(liveState\?\.live\) return/u);
  assert.match(cancel, /stopLiveCallAudioBridge\("preflight cancelled"\)/u);
  // Preflight now starts the local Caption Only provider before Go-Live is
  // allowed to spend money, so cancelling must stop it again — otherwise an
  // aborted start leaves a caption session running with no call behind it. The
  // session id itself is still owned by the normal stop path.
  assert.match(cancel, /if \(activeCaptionSessionOwner === "live-call"\) await stopSubtitles\(\)/u);
  assert.doesNotMatch(cancel, /state\.sessionId = null/u);
  assert.match(sync, /if \(!liveBridgeCapture\)/u,
    "the running bridge must reuse a capture held by successful preflight");
});

// ── Settings import must reject non-object sections ────────────────────────
// `typeof [] === "object"` and `[]` is truthy, so importing `{"subtitle": []}`
// used to sail through to the settings store, where the array shape survived
// the deep merge and JSON.stringify then dropped every string key — the file
// kept `"subtitle": []` and every later save silently no-opped while the UI
// reported success. Unrecoverable without hand-deleting settings.json.

test("settings import rejects array and primitive subtitle/apiKeys sections", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const isPlainSettingsSection = new Function("value", extractFunctionBody(js, "function isPlainSettingsSection"));
  assert.equal(isPlainSettingsSection({}), true);
  assert.equal(isPlainSettingsSection({ glossary: "a" }), true);
  for (const bad of [[], ["en"], null, undefined, "boom", 5, true, 0, ""]) {
    assert.equal(isPlainSettingsSection(bad), false, JSON.stringify(bad) ?? "undefined");
  }

  const importer = extractFunctionBody(js, "async function importSettingsFromFile");
  // The old truthy+typeof pair is gone from the import path.
  assert.doesNotMatch(importer, /typeof parsed\.subtitle === "object"/u);
  assert.doesNotMatch(importer, /typeof parsed\.apiKeys === "object"/u);
  // Both sections are shape-checked, and a bad shape aborts instead of saving.
  assert.match(importer, /!isPlainSettingsSection\(parsed\.subtitle\)/u);
  assert.match(importer, /!isPlainSettingsSection\(parsed\.apiKeys\)/u);
  assert.match(importer, /if \(isPlainSettingsSection\(parsed\.subtitle\)\) patch\.subtitle = parsed\.subtitle;/u);
  assert.match(importer, /if \(isPlainSettingsSection\(parsed\.apiKeys\)\) patch\.apiKeys = parsed\.apiKeys;/u);
  const throwIndex = importer.indexOf('t("error.importSectionShape")');
  assertLocalized("error.importSectionShape", { ko: /항목은 객체여야 합니다/ });
  const saveIndex = importer.indexOf("await saveSettings(patch)");
  assert.ok(throwIndex >= 0 && throwIndex < saveIndex, "the shape check must run before the save");
});


test("dashboard boot preserves canonical server models and does not autosave an obsolete transcription default", async () => {
  const source = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const writes = [];
  const errors = [];
  const serverSettings = JSON.parse(JSON.stringify(DEFAULT_SUBTITLE_SETTINGS));
  const context = vm.createContext({
    DEFAULT_GLOSSARY_PRESET_ID: "default-cre-ai-en-ko", MAX_GLOSSARY_SELECTIONS: 5,
    BUILT_IN_GLOSSARY_OPTIONS: [{ sourceId: "common_business" }],
    state: { settings: {} },
    fetch: async () => ({ json: async () => ({ settings: { subtitle: serverSettings } }) }),
    saveSettings: async patch => { validateSubtitleSettings(patch.subtitle); writes.push(patch); },
    showError: error => errors.push(error),
    writeSettingsToForm() {}, hydrateOverlayEnabled: async () => {}, applyPreviewSettings() {},
    updateOpenAIKeyPlaceholder() {}, updateGeminiKeyStatus() {}, updateGeminiSecondaryKeyStatus() {},
    updateSonioxKeyStatus() {},
    updateOpenAIKeyStatus() {}, updateSessionSummary() {}, updateServiceStrip() {},
    updateAudioInspectorLabels() {}, syncCaptionPlayerController() {},
  });
  const constants = source.slice(source.indexOf("const DEFAULT_SUBTITLE ="), source.indexOf("const state ="));
  vm.runInContext(constants + "\n" + extractBalancedStatement(source, "async function loadConfig()"), context);
  await vm.runInContext("loadConfig()", context);
  assert.equal(errors.length, 0, "canonical server settings must never be rewritten into a rejected model");
  assert.equal(writes.length, 0, "boot does not create a redundant settings request");
  const current = JSON.parse(vm.runInContext("JSON.stringify(state.settings)", context));
  assert.deepEqual(current.engine, JSON.parse(JSON.stringify(DEFAULT_SUBTITLE_SETTINGS.engine)));
  assert.doesNotThrow(() => validateSubtitleSettings(current));
  serverSettings.translationProvider = "retired-provider";
  await vm.runInContext("loadConfig()", context);
  assert.equal(errors.length, 0);
  assert.equal(writes.length, 1, "an actual retired setting may still be normalized once");
  assert.deepEqual(writes[0].subtitle.engine, JSON.parse(JSON.stringify(DEFAULT_SUBTITLE_SETTINGS.engine)));
});
