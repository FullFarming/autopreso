import {
  createSubtitleAudioPlayer,
  createTranslatedAudioGuard,
  shouldGateTranslatedAudioInput,
} from "./subtitle-audio-player.js";
import { buildMonthGrid, buildTimeGrid } from "./records-calendar.js";
// Every user-visible string in this file resolves through t(); subtitle-workspace.js
// owns restoring/persisting the choice and the declarative data-i18n pass.
import { getLanguage, subscribe as subscribeToLanguage, t } from "./subtitle-i18n.js";

const SAMPLE_RATE = 24000;
const LIVE_AUDIO_CHUNK_DURATION_MS = 100;
const LIVE_AUDIO_CHUNK_SAMPLES = SAMPLE_RATE * LIVE_AUDIO_CHUNK_DURATION_MS / 1_000;
const AUDIO_PROCESSOR_BUFFER_SIZE = 1024;
const LOCAL_SERVER_DASHBOARD_URL = "http://127.0.0.1:3210/subtitle.html";
const HISTORY_TIME_ZONE = "Asia/Seoul";
const INPUT_SIGNAL_THRESHOLD = 0.035;
const INPUT_SILENCE_WARNING_MS = 5000;
const INPUT_STATUS_BROADCAST_MS = 1000;
const CAPTURE_TIMEOUT_MS = 8000;
// Normal translated sentences can exceed three seconds. This cap prevents
// unbounded memory growth while preserving ordinary continuous speech.
const MAX_TRANSLATED_AUDIO_QUEUE_SECONDS = 30;
const DEFAULT_SUBTITLE = {
  inputMode: "system_mic",
  micDeviceId: "",
  languagePair: { a: "en", b: "ko" },
  translationLanguages: ["en", "ko"],
  outputMode: "captions",
  voiceProvider: "gemini",
  audioLanguage: "en",
  audioVolume: 0.8,
  displayMode: "translation_only",
  showSourceText: false,
  translateAllLanguages: false,
  model: "gpt-realtime-translate",
  fontFamily: "Arial, Helvetica, sans-serif",
  translationFontSize: 38,
  sourceFontSize: 36,
  position: "bottom-center",
  subtitlePositions: { en: "bottom-center", ko: "bottom-center", ja: "top-center" },
  maxWidth: 1500,
  opacity: 0.92,
  maxSubtitleLines: 2,
  overlayEnabled: true,
  recordProvider: "ollama",
  ollamaBaseURL: "http://127.0.0.1:11434",
  ollamaModel: "gemma3n:e2b",
  tone: "natural",
  translationProvider: "gemini",
  glossary: "",
  translationDomain: "",
  verticalOffset: 48,
};

const OPENAI_REALTIME_TRANSLATION_LANGUAGES = new Set([
  "en", "es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it",
]);

const state = {
  ws: null,
  settings: { ...DEFAULT_SUBTITLE },
  sessionId: null,
  streams: [],
  streamers: [],
  running: false,
  hasOpenAIKey: false,
  hasOpenAISecondaryKey: false,
  hasGeminiKey: false,
  hasGeminiSecondaryKey: false,
  previewStatusTimer: null,
  history: { records: [], topics: [], historyDays: [], recorderStatus: {} },
  audioMeters: new Map(),
};

const form = document.getElementById("subtitle-settings");
const startButton = document.getElementById("start-subtitles");
const stopButton = document.getElementById("stop-subtitles");
const captionPlayerController = document.getElementById("caption-player-controller");
const controllerDragHandle = document.getElementById("controller-drag");
const controllerRestartButton = document.getElementById("controller-restart");
const controllerStopButton = document.getElementById("controller-stop");
const controllerFontDownButton = document.getElementById("controller-font-down");
const controllerFontUpButton = document.getElementById("controller-font-up");
const controllerFontSize = document.getElementById("controller-font-size");
const controllerPositionButtons = [...document.querySelectorAll("[data-controller-position]")];
const controllerLanguagePreset = document.getElementById("controller-language-preset");
const controllerOpacity = document.getElementById("controller-opacity");
const controllerOpacityValue = document.getElementById("controller-opacity-value");
const connectionStatus = document.getElementById("connection-status");
const errorBox = document.getElementById("subtitle-error");
const preview = document.getElementById("subtitle-preview");
const previewPanel = preview.closest(".preview-panel");
const micSelect = form.elements.micDeviceId;
const openaiKeyInput = form.elements.openaiKey;
const openaiSecondaryKeyInput = form.elements.openaiSecondaryKey;
const opacityValue = document.getElementById("opacity-value");
const saveOpenAIKeyButton = document.getElementById("save-openai-key");
const openaiKeyStatus = document.getElementById("openai-key-status");
const saveOpenAISecondaryKeyButton = document.getElementById("save-openai-secondary-key");
const openaiSecondaryKeyStatus = document.getElementById("openai-secondary-key-status");
const geminiKeyInput = form.elements.geminiKey;
const saveGeminiKeyButton = document.getElementById("save-gemini-key");
const geminiKeyStatus = document.getElementById("gemini-key-status");
const geminiSecondaryKeyInput = form.elements.geminiSecondaryKey;
const saveGeminiSecondaryKeyButton = document.getElementById("save-gemini-secondary-key");
const geminiSecondaryKeyStatus = document.getElementById("gemini-secondary-key-status");
const fileProtocolWarning = document.getElementById("file-protocol-warning");
const overlayEnabledInput = document.getElementById("overlay-enabled");
const sessionSummary = document.getElementById("session-summary");
const topicList = document.getElementById("topic-list");
const translationLog = document.getElementById("translation-log");
const translationCount = document.getElementById("translation-count");
const recorderStatus = document.getElementById("recorder-status");
const clearHistoryButton = document.getElementById("clear-history");
const realtimeApiStatus = document.getElementById("realtime-api-status");
const topicModelStatus = document.getElementById("topic-model-status");
const refreshAudioDevicesButton = document.getElementById("refresh-audio-devices");
const playbackOptions = document.getElementById("pt-playback-options");
const audioVolumeValue = document.getElementById("audio-volume-value");
const primaryNavigationLinks = [...document.querySelectorAll(".subtitle-app-rail nav a[href^='#']")];
const settingsDrawer = document.querySelector("details.settings-drawer");
const CONTROLLER_POSITION_STORAGE_KEY = "realtime-noel-caption-controller-position";
const audioStatus = {
  system: {
    label: document.getElementById("system-audio-label"),
    meter: document.getElementById("system-audio-meter"),
    state: document.getElementById("system-audio-state"),
  },
  mic: {
    label: document.getElementById("mic-audio-label"),
    meter: document.getElementById("mic-audio-meter"),
    state: document.getElementById("mic-audio-state"),
  },
};

const subtitleAudioPlayer = createSubtitleAudioPlayer({
  maxQueueSeconds: MAX_TRANSLATED_AUDIO_QUEUE_SECONDS,
  onQueueRestart: () => {
    setPreviewStatus(t("audio.recoveryContinuing"), 2400);
    showNotice(t("notice.audioQueueTrimmed"));
  },
  onFailure: (error) => {
    showError(error);
  },
});
const translatedAudioGuard = createTranslatedAudioGuard();

function clearTranslatedAudioQueue() {
  // The player owns the source set and clears each source with source.stop()
  // followed by source.disconnect() before dropping the in-memory queue.
  subtitleAudioPlayer.clear();
}

function failTranslatedAudio(error) {
  clearTranslatedAudioQueue();
  showError(error);
  setPreviewStatus(t("audio.recoveryWaiting"), 2400);
}

if (location.protocol === "file:") {
  showFileProtocolWarning();
} else {
  connectWebSocket();
  loadSubtitleLanguages().then(() => loadConfig());
  loadSubtitleHistory();
  loadSessionRecords();
  hydrateMicrophones();
}

function showFileProtocolWarning() {
  if (fileProtocolWarning) fileProtocolWarning.hidden = false;
  setConnectionStatus(t("status.openInDesktopApp"), "error");
  startButton.disabled = true;
  stopButton.disabled = true;
  setPreviewText(t("status.reopeningLocalServer"), "", true);
  setTimeout(() => {
    location.href = LOCAL_SERVER_DASHBOARD_URL;
  }, 700);
}

form.addEventListener("input", (event) => {
  if (event.target === openaiKeyInput || event.target === openaiSecondaryKeyInput || event.target === geminiKeyInput || event.target === geminiSecondaryKeyInput) return;
  const previousSettings = state.settings;
  syncLinkedControl(event.target);
  syncLanguageControls(event.target);
  syncAudioLanguageOptions(readTranslationLanguagesFromForm(), form.elements.audioLanguage?.value);
  enforcePtOutputAvailability();
  state.settings = readSettingsFromForm();
  if (event.target?.name === "audioVolume") subtitleAudioPlayer.setVolume(state.settings.audioVolume);
  if (["outputMode", "voiceProvider", "audioLanguage", "translationLanguages"].includes(event.target?.name)
    && (previousSettings.outputMode !== state.settings.outputMode
      || previousSettings.voiceProvider !== state.settings.voiceProvider
      || previousSettings.audioLanguage !== state.settings.audioLanguage
      || event.target?.name === "translationLanguages")) {
    subtitleAudioPlayer.clear();
  }
  if (state.running && event.target?.name === "outputMode" && state.settings.outputMode !== "captions") {
    void subtitleAudioPlayer.resume(state.settings.audioVolume).catch(showError);
  }
  applyPreviewSettings(state.settings);
  updatePtOutputControls();
  if (state.running) syncRuntimeOutputVisibility();
  updateSessionSummary();
  updateServiceStrip();
  updateAudioInspectorLabels();
  clearError();
});

// Settings that change the SET of translation channels (which languages, which
// engine). When one of these changes mid-session the running channels are stale
// and keep translating the old configuration — so we rebuild them.
const CHANNEL_REBUILD_CONTROLS = new Set(["translationLanguages", "outputMode", "voiceProvider", "audioLanguage"]);

form.addEventListener("change", (event) => {
  syncLanguageControls(event.target);
  syncAudioLanguageOptions(readTranslationLanguagesFromForm(), form.elements.audioLanguage?.value);
  enforcePtOutputAvailability();
  state.settings = readSettingsFromForm();
  updatePtOutputControls();
  updateAudioInspectorLabels();
  if (event.target === overlayEnabledInput) syncDesktopOverlayVisibility(state.settings.overlayEnabled);
  const name = event.target?.name;
  saveSettings({ subtitle: state.settings })
    .then(() => {
      if (state.running && name === "inputMode") {
        // Audio sources changed — a full restart re-captures the right inputs.
        void restartSubtitles();
        showNotice(t("notice.inputRestarted"));
        return;
      }
      if (state.running && CHANNEL_REBUILD_CONTROLS.has(name)) {
        // Rebuild the server-side translation channels in place (audio capture
        // keeps running) so the live output matches the new language/engine.
        reconfigureRunningSession();
        showNotice(t("notice.channelsRebuilt"));
        return;
      }
      showNotice(t("notice.settingsSaved"));
    })
    .catch(showError);
});

startButton.addEventListener("click", startSubtitles);
stopButton.addEventListener("click", stopSubtitles);
controllerRestartButton?.addEventListener("click", restartSubtitles);
controllerStopButton?.addEventListener("click", stopSubtitles);
controllerFontDownButton?.addEventListener("click", () => adjustControllerFontSize(-2));
controllerFontUpButton?.addEventListener("click", () => adjustControllerFontSize(2));
controllerLanguagePreset?.addEventListener("change", () => applyControllerLanguagePreset());
controllerOpacity?.addEventListener("input", () => previewControllerOpacity());
controllerOpacity?.addEventListener("change", () => persistControllerOpacity());
for (const button of controllerPositionButtons) {
  button.addEventListener("click", () => setControllerSubtitlePosition(button.dataset.controllerPosition));
}
initCaptionControllerDrag();
saveOpenAIKeyButton.addEventListener("click", saveOpenAIKey);
saveOpenAISecondaryKeyButton.addEventListener("click", saveOpenAISecondaryKey);
saveGeminiKeyButton.addEventListener("click", saveGeminiKey);
saveGeminiSecondaryKeyButton?.addEventListener("click", saveGeminiSecondaryKey);
// Download the un-cleared translation history as an Excel-compatible CSV.
document.getElementById("export-history")?.addEventListener("click", () => {
  window.location.href = "/api/subtitles/history/export.csv";
});

function activatePrimaryNavigation(link, shouldUpdateHash = true) {
  const targetHash = link.getAttribute("href");
  const target = targetHash === "#settings-drawer"
    ? settingsDrawer
    : document.querySelector(targetHash);
  if (!target) return;

  if (target === settingsDrawer) settingsDrawer.open = true;
  for (const navigationLink of primaryNavigationLinks) {
    const isCurrent = navigationLink === link;
    navigationLink.classList.toggle("is-current", isCurrent);
    if (isCurrent) navigationLink.setAttribute("aria-current", "page");
    else navigationLink.removeAttribute("aria-current");
  }
  if (shouldUpdateHash) window.history.replaceState(null, "", targetHash);
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

for (const navigationLink of primaryNavigationLinks) {
  navigationLink.addEventListener("click", (event) => {
    event.preventDefault();
    activatePrimaryNavigation(navigationLink);
  });
}

window.addEventListener("hashchange", () => {
  const navigationLink = primaryNavigationLinks.find((link) => link.getAttribute("href") === window.location.hash);
  if (navigationLink) activatePrimaryNavigation(navigationLink, false);
});

const initialNavigationLink = primaryNavigationLinks.find((link) => link.getAttribute("href") === window.location.hash);
if (initialNavigationLink) activatePrimaryNavigation(initialNavigationLink, false);

// Live Call feature flag (desktop host, REALTIME_NOEL_LIVE_CALL_ENABLED):
// when the host disables Live Call, hide the whole entry section. Base
// caption features are unaffected.
if (window.realtimeNoelDesktop?.getLiveCallEnabled) {
  window.realtimeNoelDesktop.getLiveCallEnabled().then((liveCallEnabled) => {
    if (liveCallEnabled) return;
    document.querySelector(".live-handoff")?.setAttribute("hidden", "");
  }).catch(() => {});
}

document.getElementById("export-settings")?.addEventListener("click", () => {
  window.location.href = "/api/settings/export";
});
const importSettingsFileInput = document.getElementById("import-settings-file");
document.getElementById("import-settings")?.addEventListener("click", () => importSettingsFileInput?.click());
importSettingsFileInput?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await importSettingsFromFile(file);
});

// Built-in industry glossary presets: selecting one fills glossary + domain +
// language pair together and saves, so a prepared meeting type (hotel
// investment EN↔KO, F&B leasing KO↔JA, …) is one click away.
let glossaryPresets = [];
async function hydrateGlossaryPresets() {
  const select = form.elements.glossaryPreset;
  if (!select) return;
  try {
    glossaryPresets = await fetch("/api/glossary-presets").then((res) => res.json());
    for (const preset of glossaryPresets) {
      select.append(new Option(`${preset.label} — ${preset.industry}`, preset.id));
    }
  } catch {
    // Presets are a convenience; the manual glossary textarea still works.
  }
}
hydrateGlossaryPresets();
form.elements.glossaryPreset?.addEventListener("change", (event) => applyGlossaryPreset(event.target.value));

async function applyGlossaryPreset(presetId) {
  const preset = glossaryPresets.find((entry) => entry.id === presetId);
  if (!preset) return;
  if (form.elements.glossary) form.elements.glossary.value = preset.glossary;
  if (form.elements.translationDomain) form.elements.translationDomain.value = preset.domain;
  writeTranslationLanguageCheckboxes([preset.languagePair.a, preset.languagePair.b]);
  syncPlacementRows([preset.languagePair.a, preset.languagePair.b]);
  markLanguageMinimum();
  state.settings = readSettingsFromForm();
  applyPreviewSettings(state.settings);
  updateAudioInspectorLabels();
  try {
    await saveSettings({ subtitle: state.settings });
    if (state.running) {
      // A running session keeps translating with the OLD glossary until its
      // channels are rebuilt — reconfigure in place (audio capture untouched).
      reconfigureRunningSession();
      showNotice(t("notice.presetAppliedRebuilt", { label: preset.label }));
    } else {
      showNotice(t("notice.presetApplied", { label: preset.label }));
    }
  } catch (error) {
    showError(error);
  }
}

// A patch section must be a PLAIN object. An array is truthy AND passes
// `typeof x === "object"`, which is how importing `{"subtitle": []}` used to
// reach the settings store: the array shape survived the deep merge and
// JSON.stringify then dropped every string key assigned to it, so the file kept
// `"subtitle": []` and every later save silently no-opped while the UI reported
// success — unrecoverable without hand-deleting settings.json.
function isPlainSettingsSection(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function importSettingsFromFile(file) {
  clearError();
  try {
    const parsed = JSON.parse(await file.text());
    if (!isPlainSettingsSection(parsed) || (!parsed.subtitle && !parsed.apiKeys)) {
      throw new Error(t("error.importNotSettingsFile"));
    }
    if ((parsed.subtitle !== undefined && !isPlainSettingsSection(parsed.subtitle))
      || (parsed.apiKeys !== undefined && !isPlainSettingsSection(parsed.apiKeys))) {
      throw new Error(t("error.importSectionShape"));
    }
    const patch = {};
    if (isPlainSettingsSection(parsed.subtitle)) patch.subtitle = parsed.subtitle;
    if (isPlainSettingsSection(parsed.apiKeys)) patch.apiKeys = parsed.apiKeys;
    const body = await saveSettings(patch);
    if (body.settings?.subtitle) {
      state.settings = { ...DEFAULT_SUBTITLE, ...body.settings.subtitle };
      writeSettingsToForm(state.settings);
      applyPreviewSettings(state.settings);
    }
    showNotice(t("notice.settingsImported"));
  } catch (error) {
    showError(error);
  }
}
clearHistoryButton.addEventListener("click", clearSubtitleHistory);
refreshAudioDevicesButton.addEventListener("click", hydrateMicrophones);
// Keep the mic list current as devices are plugged/unplugged (AirPods, USB
// interfaces) without requiring a manual refresh.
navigator.mediaDevices.addEventListener("devicechange", hydrateMicrophones);

// Per-language subtitle placement. Each language has a top/middle/bottom
// segmented control (radios); the generic form change handler persists them via
// readSettingsFromForm + saveSettings, so we only need readers and the helpers
// that keep visible rows in sync with which languages are being translated.
// Language registry: fetched from the server (single source of truth in
// src/subtitle-languages.js) with the core trio as the offline fallback.
const MAX_SELECTED_LANGUAGES = 3;
let subtitleLanguageRegistry = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "ko", label: "Korean", nativeLabel: "\ud55c\uad6d\uc5b4" },
  { code: "ja", label: "Japanese", nativeLabel: "\u65e5\u672c\u8a9e" },
];
let supportedLanguageCodes = new Set(subtitleLanguageRegistry.map((language) => language.code));

function isSupportedLanguageCode(code) {
  return supportedLanguageCodes.has(code);
}

async function loadSubtitleLanguages() {
  try {
    const body = await fetch("/api/subtitle-languages").then((res) => res.json());
    if (Array.isArray(body?.languages) && body.languages.length >= 3) {
      subtitleLanguageRegistry = body.languages;
      supportedLanguageCodes = new Set(body.languages.map((language) => language.code));
    }
  } catch {
    // Offline / older server: keep the core trio.
  }
  renderLanguagePills();
  renderPlacementRows();
}

// Korean display names for the search box — users search in Korean first
// ("일본어"), but English names and ISO codes match too.
const LANGUAGE_KO_LABELS = {
  en: "영어", ko: "한국어", ja: "일본어", "zh-Hans": "중국어(간체)", "zh-Hant": "중국어(번체)", es: "스페인어",
  fr: "프랑스어", de: "독일어", pt: "포르투갈어", ru: "러시아어",
  hi: "힌디어", vi: "베트남어", id: "인도네시아어", it: "이탈리아어",
};

function languageDisplayName(language) {
  const native = language.nativeLabel || language.label || language.code;
  // The Korean alias is only useful while the UI itself is Korean; the English
  // UI shows the native name (and the search box still matches Korean input).
  if (getLanguage() !== "ko") return native;
  const koLabel = LANGUAGE_KO_LABELS[language.code];
  return koLabel && koLabel !== native ? `${koLabel} · ${native}` : native;
}

// Search-and-tag language picker. Instead of listing every registry language
// as a pill, the selected languages render as removable chips and new ones are
// added through a type-ahead search (Korean name, English name, native name,
// or ISO code). The underlying form state is still a hidden checkbox per
// registry language — every existing reader (readSettingsFromForm,
// syncLanguageControls, placement rows, presets) keeps working unchanged.
function renderLanguagePills() {
  const container = document.querySelector(".language-pills");
  if (!container) return;
  const selected = new Set([
    ...(Array.isArray(state.settings?.translationLanguages) ? state.settings.translationLanguages : []),
    ...[...container.querySelectorAll('input[name="translationLanguages"]:checked')].map((input) => input.value),
  ]);
  container.replaceChildren();
  container.classList.add("language-tag-picker");

  for (const language of subtitleLanguageRegistry) {
    const input = document.createElement("input");
    input.name = "translationLanguages";
    input.type = "checkbox";
    input.value = language.code;
    input.checked = selected.has(language.code);
    input.hidden = true;
    container.append(input);
  }

  const chips = document.createElement("div");
  chips.className = "language-chips";
  container.append(chips);

  const search = document.createElement("div");
  search.className = "language-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.id = "language-search-input";
  searchInput.placeholder = t("language.searchPlaceholder");
  searchInput.autocomplete = "off";
  searchInput.setAttribute("aria-label", t("language.searchLabel"));
  const suggestions = document.createElement("ul");
  suggestions.className = "language-suggestions";
  suggestions.hidden = true;
  search.append(searchInput, suggestions);
  container.append(search);

  searchInput.addEventListener("input", () => renderLanguageSuggestions(searchInput.value));
  searchInput.addEventListener("focus", () => renderLanguageSuggestions(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      // Never submit the settings form from the search box; add the top match.
      event.preventDefault();
      const first = suggestions.querySelector("[data-language-code]");
      if (first) addLanguageTag(first.dataset.languageCode);
    }
    if (event.key === "Escape") {
      suggestions.hidden = true;
    }
  });
  document.addEventListener("click", (event) => {
    if (!search.contains(event.target)) suggestions.hidden = true;
  });

  renderLanguageChips();
}

function languageSearchMatches(query) {
  const q = String(query ?? "").trim().toLowerCase();
  const selected = new Set(readCheckedLanguageCodes());
  return subtitleLanguageRegistry.filter((language) => {
    if (selected.has(language.code)) return false;
    if (!q) return true;
    const haystack = [
      language.code,
      language.label,
      language.nativeLabel,
      LANGUAGE_KO_LABELS[language.code],
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

function readCheckedLanguageCodes() {
  return [...form.querySelectorAll('input[name="translationLanguages"]:checked')].map((input) => input.value);
}

function renderLanguageSuggestions(query) {
  const suggestions = document.querySelector(".language-suggestions");
  if (!suggestions) return;
  const matches = languageSearchMatches(query);
  suggestions.replaceChildren();
  const atMax = readCheckedLanguageCodes().length >= MAX_SELECTED_LANGUAGES;
  if (atMax) {
    const li = document.createElement("li");
    li.className = "language-suggestion-empty";
    li.textContent = t("language.maxSelected", { max: MAX_SELECTED_LANGUAGES });
    suggestions.append(li);
    suggestions.hidden = false;
    return;
  }
  if (matches.length === 0) {
    const li = document.createElement("li");
    li.className = "language-suggestion-empty";
    li.textContent = t("language.noMatch");
    suggestions.append(li);
    suggestions.hidden = false;
    return;
  }
  for (const language of matches) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "language-suggestion";
    button.dataset.languageCode = language.code;
    button.textContent = `${languageDisplayName(language)} (${language.code})`;
    button.addEventListener("click", () => addLanguageTag(language.code));
    li.append(button);
    // The Enter-key shortcut reads the first row's code from the li as well.
    li.dataset.languageCode = language.code;
    suggestions.append(li);
  }
  suggestions.hidden = false;
}

function addLanguageTag(code) {
  if (readCheckedLanguageCodes().length >= MAX_SELECTED_LANGUAGES) return;
  const input = form.querySelector(`input[name="translationLanguages"][value="${code}"]`);
  if (!input || input.checked) return;
  input.checked = true;
  // Bubble a real change event so the form's save/rebuild pipeline runs
  // exactly as if a checkbox had been clicked.
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const searchInput = document.getElementById("language-search-input");
  if (searchInput) {
    searchInput.value = "";
    searchInput.focus();
  }
  const suggestions = document.querySelector(".language-suggestions");
  if (suggestions) suggestions.hidden = true;
  renderLanguageChips();
}

function removeLanguageTag(code) {
  const input = form.querySelector(`input[name="translationLanguages"][value="${code}"]`);
  if (!input || !input.checked) return;
  input.checked = false;
  // syncLanguageControls reverts this change (and flashes the hint) if it
  // would drop the selection below the 2-language minimum.
  input.dispatchEvent(new Event("change", { bubbles: true }));
  renderLanguageChips();
}

// Selected languages as removable tags, ordered as the registry lists them.
function renderLanguageChips() {
  const chips = document.querySelector(".language-chips");
  if (!chips) return;
  chips.replaceChildren();
  const selected = new Set(readCheckedLanguageCodes());
  const atMinimum = selected.size <= 2;
  for (const language of subtitleLanguageRegistry) {
    if (!selected.has(language.code)) continue;
    const chip = document.createElement("span");
    chip.className = `language-chip${atMinimum ? " at-minimum" : ""}`;
    const text = document.createElement("span");
    text.textContent = languageDisplayName(language);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "language-chip-remove";
    remove.setAttribute("aria-label", t("language.remove", { language: languageDisplayName(language) }));
    remove.textContent = "×";
    remove.addEventListener("click", () => removeLanguageTag(language.code));
    chip.append(text, remove);
    chips.append(chip);
  }
}
const SUBTITLE_POSITION_VALUES = ["top-center", "middle-center", "bottom-center"];

function renderPlacementRows() {
  const container = document.querySelector(".placement-rows");
  if (!container) return;
  const existing = readSubtitlePositionsFromForm();
  container.replaceChildren();
  for (const language of subtitleLanguageRegistry) {
    const row = document.createElement("div");
    row.className = "placement-row";
    row.dataset.lang = language.code;
    row.hidden = true;
    const chip = document.createElement("span");
    chip.className = "lang-chip";
    chip.textContent = language.code.toUpperCase();
    const controls = document.createElement("div");
    controls.className = "seg-toggle";
    controls.setAttribute("role", "radiogroup");
    controls.setAttribute("aria-label", t("language.positionLabel", { language: languageDisplayName(language) }));
    for (const [value, labelKey] of [["top-center", "position.top"], ["middle-center", "position.middle"], ["bottom-center", "position.bottom"]]) {
      const option = document.createElement("label");
      option.className = "seg-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `pos-${language.code}`;
      input.value = value;
      input.checked = (existing[language.code] ?? DEFAULT_SUBTITLE.subtitlePositions[language.code] ?? DEFAULT_SUBTITLE.position) === value;
      const text = document.createElement("span");
      text.dataset.i18n = labelKey;
      text.textContent = t(labelKey);
      option.append(input, text);
      controls.append(option);
    }
    row.append(chip, controls);
    container.append(row);
  }
}

function readSubtitlePositionsFromForm() {
  const positions = {};
  for (const language of supportedLanguageCodes) {
    const checked = form.querySelector(`input[name="pos-${language}"]:checked`);
    if (checked && SUBTITLE_POSITION_VALUES.includes(checked.value)) positions[language] = checked.value;
  }
  return { ...DEFAULT_SUBTITLE.subtitlePositions, ...positions };
}

// A placement row is only meaningful for a language that is actually being
// translated, so hide rows for unselected languages.
function syncPlacementRows(languages = readTranslationLanguagesFromForm()) {
  const selected = new Set(languages);
  for (const language of supportedLanguageCodes) {
    const row = document.querySelector(`.placement-row[data-lang="${language}"]`);
    if (row) row.hidden = !selected.has(language);
  }
}

function updateVerticalOffsetValue(offset) {
  const label = document.getElementById("vertical-offset-value");
  if (label) label.textContent = `${offset}px`;
}

async function loadConfig() {
  try {
    const config = await fetch("/api/config").then((res) => res.json());
    if (config.settings?.subtitle) state.settings = { ...DEFAULT_SUBTITLE, ...config.settings.subtitle };
    state.hasOpenAIKey = Boolean(config.settings?.hasOpenAIKey);
    state.hasOpenAISecondaryKey = Boolean(config.settings?.hasOpenAISecondaryKey);
    state.hasGeminiKey = Boolean(config.settings?.hasGeminiKey);
    state.hasGeminiSecondaryKey = Boolean(config.settings?.hasGeminiSecondaryKey);
    writeSettingsToForm(state.settings);
    await hydrateOverlayEnabled();
    applyPreviewSettings(state.settings);
    updateOpenAIKeyPlaceholder();
    updateOpenAISecondaryKeyPlaceholder();
    updateGeminiKeyStatus();
    updateGeminiSecondaryKeyStatus();
    updateOpenAIKeyStatus();
    updateOpenAISecondaryKeyStatus();
    updateSessionSummary();
    updateServiceStrip();
    updateAudioInspectorLabels();
    syncCaptionPlayerController();
  } catch (error) {
    showError(error);
  }
}

async function hydrateOverlayEnabled() {
  if (!window.realtimeNoelDesktop?.getOverlayEnabled) return;
  try {
    const overlayEnabled = await window.realtimeNoelDesktop.getOverlayEnabled();
    state.settings.overlayEnabled = overlayEnabled !== false;
    overlayEnabledInput.checked = state.settings.overlayEnabled;
  } catch {
    overlayEnabledInput.checked = state.settings.overlayEnabled !== false;
  }
}

function syncDesktopOverlayVisibility(enabled) {
  if (!window.realtimeNoelDesktop?.setOverlayEnabled) return;
  window.realtimeNoelDesktop.setOverlayEnabled(enabled).catch(showError);
}

function selectedOutputMode() {
  const value = form.querySelector('input[name="outputMode"]:checked')?.value;
  // captions_audio is retired; anything unrecognised falls back to captions.
  return value === "audio" ? value : "captions";
}

function enforcePtOutputAvailability() {
  for (const input of form.querySelectorAll('input[name="outputMode"]')) {
    input.disabled = false;
  }
  const targetLanguage = form.elements.audioLanguage?.value || "en";
  const normalizedLanguage = targetLanguage.toLowerCase() === "zh-cn" ? "zh" : targetLanguage.toLowerCase().split("-")[0];
  const openAIInput = form.querySelector('input[name="voiceProvider"][value="openai"]');
  const isOpenAISupported = OPENAI_REALTIME_TRANSLATION_LANGUAGES.has(normalizedLanguage);
  if (openAIInput) openAIInput.disabled = !isOpenAISupported;
  if (!isOpenAISupported && selectedVoiceProvider() === "openai") {
    const geminiInput = form.querySelector('input[name="voiceProvider"][value="gemini"]');
    if (geminiInput) geminiInput.checked = true;
    clearTranslatedAudioQueue();
  }
}

function selectedVoiceProvider() {
  return form.querySelector('input[name="voiceProvider"]:checked')?.value === "openai" ? "openai" : "gemini";
}

function syncAudioLanguageOptions(languages, preferredLanguage) {
  const select = form.elements.audioLanguage;
  if (!select) return;
  const selectedLanguages = Array.isArray(languages) && languages.length > 0 ? languages : ["en"];
  const preferred = selectedLanguages.includes(preferredLanguage) ? preferredLanguage : selectedLanguages[0];
  select.replaceChildren(...selectedLanguages.map((code) => {
    const language = subtitleLanguageRegistry.find((entry) => entry.code === code);
    const option = document.createElement("option");
    option.value = code;
    option.textContent = language ? languageDisplayName(language) : code.toUpperCase();
    return option;
  }));
  select.value = preferred;
}

function updatePtOutputControls() {
  const outputMode = selectedOutputMode();
  const voiceProvider = selectedVoiceProvider();
  if (playbackOptions) playbackOptions.hidden = outputMode === "captions";
  // State-only line: it says something ONLY when the chosen voice language has
  // no OpenAI Realtime voice, so Gemini voice is used instead.
  const openAIHelp = document.getElementById("pt-openai-voice-help");
  if (openAIHelp) {
    const targetLanguage = form.elements.audioLanguage?.value || "en";
    const normalizedLanguage = targetLanguage.toLowerCase() === "zh-cn" ? "zh" : targetLanguage.toLowerCase().split("-")[0];
    const isUnsupported = !OPENAI_REALTIME_TRANSLATION_LANGUAGES.has(normalizedLanguage);
    openAIHelp.textContent = isUnsupported ? t("output.openaiUnsupported") : "";
    openAIHelp.hidden = !isUnsupported;
  }
  if (audioVolumeValue) audioVolumeValue.textContent = `${Math.round(readNumber(form.elements.audioVolume?.value, DEFAULT_SUBTITLE.audioVolume) * 100)}%`;
  startButton.dataset.i18n = outputMode === "audio"
    ? "start.audio"
    : "start.captions";
  startButton.textContent = t(startButton.dataset.i18n);
  void voiceProvider;
}

function syncRuntimeOutputVisibility() {
  const isAudioOnly = state.running && state.settings.outputMode === "audio";
  if (previewPanel) previewPanel.hidden = isAudioOnly;
  syncCaptionPlayerController();
  void setControllerWindowVisible(state.running && !isAudioOnly);
}

async function loadSubtitleHistory() {
  try {
    const body = await fetch("/api/subtitles/history").then((res) => res.json());
    if (body.ok && body.data) renderHistory(body.data);
  } catch {
    renderHistory(state.history);
  }
}

// ── Session records: per-session timestamped source transcript + AI summary.
// Sessions are recorded server-side (subtitle:start → stop); this panel lists
// them, expands the raw timeline, and requests/re-renders AI summaries. ──────

// Looked up lazily: the initial load runs during module evaluation, before
// module-level consts declared this far down would be initialized (TDZ).
function getSessionRecordsList() {
  return document.getElementById("session-records-list");
}

function setSessionRecordsStatus(message, isError = false) {
  const status = document.getElementById("session-records-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

async function loadSessionRecords() {
  if (!getSessionRecordsList() && !document.getElementById("records-cal-grid")) return;
  try {
    const body = await fetch("/api/subtitles/sessions").then((res) => res.json());
    if (!body.ok) return;
    const sessions = body.data ?? [];
    // Only Live Call meetings have a meeting time worth placing on a calendar;
    // caption-only sessions go to the plain list below it.
    renderRecordsCalendar(sessions.filter((session) => session.kind === "live-call"));
    renderSessionRecords(sessions.filter((session) => session.kind !== "live-call"));
  } catch {
    // Server unavailable — keep whatever is on screen.
  }
}

// ── Records calendar: Outlook-style month / week / day over Live Call meetings,
// anchored on today. Placement maths lives in records-calendar.js so it can be
// tested without a DOM; this only renders. ───────────────────────────────────

const recordsCalendar = { view: "month", anchor: new Date(), meetings: [] };
function recordsWeekday(dayIndex) {
  return t(`records.weekday.${dayIndex}`);
}
const RECORDS_DAY_START_HOUR = 7;
const RECORDS_HOUR_HEIGHT = 44;

function formatRecordsClock(minutes) {
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(Math.round(minutes % 60)).padStart(2, "0");
  return `${hour}:${minute}`;
}

function renderRecordsCalendar(meetings) {
  if (Array.isArray(meetings)) recordsCalendar.meetings = meetings;
  const grid = document.getElementById("records-cal-grid");
  if (!grid) return;
  const period = document.getElementById("records-cal-period");
  const { anchor, view } = recordsCalendar;

  if (period) {
    if (view === "month") {
      period.textContent = t("records.monthPeriod", { year: anchor.getFullYear(), month: anchor.getMonth() + 1 });
    } else if (view === "day") {
      period.textContent = t("records.dayPeriod", {
        month: anchor.getMonth() + 1,
        day: anchor.getDate(),
        weekday: recordsWeekday(anchor.getDay()),
      });
    } else {
      const week = buildTimeGrid({ anchor, days: 7, meetings: [] });
      const first = week.days[0].date;
      const last = week.days[6].date;
      period.textContent = t("records.weekPeriod", {
        fromMonth: first.getMonth() + 1,
        fromDay: first.getDate(),
        toMonth: last.getMonth() + 1,
        toDay: last.getDate(),
      });
    }
  }

  grid.replaceChildren();
  grid.dataset.view = view;
  if (view === "month") grid.append(buildRecordsMonth());
  else grid.append(buildRecordsTimeGrid(view === "week" ? 7 : 1));

  const count = recordsCalendar.meetings.length;
  setSessionRecordsStatus(count ? t("records.meetingCount", { count }) : "");
}

function buildRecordsMonth() {
  const wrap = document.createElement("div");
  wrap.className = "records-month";

  const head = document.createElement("div");
  head.className = "records-month-head";
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const cell = document.createElement("span");
    cell.textContent = recordsWeekday(dayIndex);
    head.append(cell);
  }
  wrap.append(head);

  const { weeks } = buildMonthGrid({ anchor: recordsCalendar.anchor, meetings: recordsCalendar.meetings });
  const body = document.createElement("div");
  body.className = "records-month-body";
  body.style.setProperty("--records-week-count", String(weeks.length));
  for (const week of weeks) {
    for (const cell of week) {
      const dayCell = document.createElement("div");
      dayCell.className = "records-month-cell";
      dayCell.classList.toggle("is-outside", !cell.isCurrentMonth);
      dayCell.classList.toggle("is-today", cell.isToday);

      const number = document.createElement("span");
      number.className = "records-month-date";
      number.textContent = String(cell.date.getDate());
      dayCell.append(number);

      for (const segment of cell.meetings) {
        dayCell.append(buildRecordsChip(segment));
      }
      body.append(dayCell);
    }
  }
  wrap.append(body);
  return wrap;
}

function buildRecordsChip(segment) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "records-chip";
  chip.classList.toggle("is-unterminated", Boolean(segment.isUnterminated));
  const time = document.createElement("b");
  time.textContent = segment.isContinuation ? t("records.continued") : formatRecordsClock(segment.startMinute);
  const label = document.createElement("span");
  label.textContent = segment.title || t("records.noTitle");
  chip.append(time, label);
  chip.addEventListener("click", () => { void openSessionRecordDetail({ id: segment.id, title: segment.title }); });
  return chip;
}

function buildRecordsTimeGrid(days) {
  const wrap = document.createElement("div");
  wrap.className = "records-time";
  wrap.style.setProperty("--records-hour-height", `${RECORDS_HOUR_HEIGHT}px`);
  wrap.style.setProperty("--records-day-count", String(days));

  const grid = buildTimeGrid({ anchor: recordsCalendar.anchor, days, meetings: recordsCalendar.meetings });
  // The gutter normally opens at 07:00, but a meeting earlier than that must be
  // drawn where it happened -- clamping it to the first row would show a 00:30
  // call sitting at 07:00.
  const earliest = grid.days.reduce(
    (min, day) => day.segments.reduce((inner, segment) => Math.min(inner, segment.startMinute), min),
    RECORDS_DAY_START_HOUR * 60,
  );
  const startHour = Math.max(0, Math.min(RECORDS_DAY_START_HOUR, Math.floor(earliest / 60)));

  const head = document.createElement("div");
  head.className = "records-time-head";
  head.append(document.createElement("span"));
  for (const day of grid.days) {
    const label = document.createElement("span");
    label.className = "records-time-day";
    label.classList.toggle("is-today", day.isToday);
    label.textContent = days === 1
      ? `${day.date.getMonth() + 1}.${day.date.getDate()} ${recordsWeekday(day.date.getDay())}`
      : `${recordsWeekday(day.date.getDay())} ${day.date.getDate()}`;
    head.append(label);
  }
  wrap.append(head);

  const body = document.createElement("div");
  body.className = "records-time-body";

  const gutter = document.createElement("div");
  gutter.className = "records-time-gutter";
  for (let hour = startHour; hour < 24; hour += 1) {
    const mark = document.createElement("span");
    mark.textContent = t("records.hourMark", { hour: String(hour).padStart(2, "0") });
    gutter.append(mark);
  }
  body.append(gutter);

  for (const day of grid.days) {
    const column = document.createElement("div");
    column.className = "records-time-column";
    for (let hour = startHour; hour < 24; hour += 1) {
      const slot = document.createElement("div");
      slot.className = "records-time-slot";
      column.append(slot);
    }
    for (const segment of day.segments) {
      column.append(buildRecordsBlock(segment, segment.clusterLaneCount ?? day.laneCount, startHour));
    }
    body.append(column);
  }
  wrap.append(body);
  return wrap;
}

function buildRecordsBlock(segment, laneCount, startHour) {
  const block = document.createElement("button");
  block.type = "button";
  block.className = "records-block";
  block.classList.toggle("is-unterminated", Boolean(segment.isUnterminated));
  // Offsets are minutes from the gutter's first hour, which the caller widened
  // if any meeting starts earlier than the default open time.
  const topMinutes = Math.max(0, segment.startMinute - startHour * 60);
  const heightMinutes = Math.max(12, segment.endMinute - Math.max(segment.startMinute, startHour * 60));
  block.style.top = `calc(${topMinutes} / 60 * var(--records-hour-height))`;
  block.style.height = `calc(${heightMinutes} / 60 * var(--records-hour-height))`;
  const width = 100 / Math.max(1, laneCount);
  block.style.left = `${segment.lane * width}%`;
  block.style.width = `calc(${width}% - 3px)`;

  const time = document.createElement("b");
  time.textContent = `${formatRecordsClock(segment.startMinute)}–${formatRecordsClock(segment.endMinute)}`;
  const label = document.createElement("span");
  label.textContent = segment.title || t("records.noTitle");
  block.append(time, label);
  block.addEventListener("click", () => { void openSessionRecordDetail({ id: segment.id, title: segment.title }); });
  return block;
}

function stepRecordsCalendar(direction) {
  const next = new Date(recordsCalendar.anchor.getTime());
  if (recordsCalendar.view === "month") next.setMonth(next.getMonth() + direction);
  else if (recordsCalendar.view === "week") next.setDate(next.getDate() + 7 * direction);
  else next.setDate(next.getDate() + direction);
  recordsCalendar.anchor = next;
  renderRecordsCalendar();
}

function formatSessionRecordTime(iso) {
  const time = Date.parse(iso ?? "");
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(getLanguage() === "ko" ? "ko-KR" : "en-US", {
    timeZone: "Asia/Seoul",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(time));
}

function renderSessionRecords(sessions) {
  const list = getSessionRecordsList();
  if (!list) return;
  list.replaceChildren();
  const details = document.getElementById("records-local-sessions");
  // Nothing to reach means nothing to show: the disclosure hides entirely rather
  // than explaining its own emptiness.
  if (details) details.hidden = sessions.length === 0;
  for (const session of sessions) {
    list.append(buildSessionRecordCard(session));
  }
}

// Caption-only sessions: a plain Toss-style list row. They have no meeting time,
// so they are never placed on the calendar -- the record still has to be
// reachable, which is what this list is for.
function buildSessionRecordCard(session) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "records-local-row";

  const heading = document.createElement("div");
  heading.className = "records-local-heading";
  const titleEl = document.createElement("strong");
  titleEl.textContent = session.title || formatSessionRecordTime(session.startedAt) || session.id;
  const meta = document.createElement("span");
  const period = [formatSessionRecordTime(session.startedAt), formatSessionRecordTime(session.endedAt)]
    .filter(Boolean).join(" – ");
  meta.textContent = `${period} · ${t("records.lineCount", { count: session.lineCount })}`;
  heading.append(titleEl, meta);

  const right = document.createElement("span");
  right.className = "records-local-right";
  right.textContent = session.hasSummary ? t("records.summaryBadge") : "";

  row.append(heading, right);
  row.addEventListener("click", () => { void openSessionRecordDetail(session); });
  return row;
}

// ── Session detail subview: hides the record panels and shows the source
// transcript and the AI summary together for one session. ────────────────────
function sessionDetailElements() {
  return {
    page: document.getElementById("records-page"),
    panel: document.getElementById("session-record-detail-page"),
    title: document.getElementById("session-detail-title"),
    meta: document.getElementById("session-detail-meta"),
    transcript: document.getElementById("session-detail-transcript"),
    summary: document.getElementById("session-detail-summary"),
    generate: document.getElementById("session-detail-generate-summary"),
    audio: document.getElementById("session-detail-audio"),
    exportButton: document.getElementById("session-detail-export"),
    tabs: [...document.querySelectorAll("[data-transcript-lang]")],
  };
}

// Held so a language tab re-renders from what is already loaded instead of
// refetching the whole transcript.
const openSessionDetail = { id: "", lines: [], language: "en" };

function renderOpenSessionTranscript() {
  const els = sessionDetailElements();
  if (!els.transcript) return;
  renderSessionTranscript(els.transcript, openSessionDetail.lines, openSessionDetail.language);
  for (const tab of els.tabs) {
    const isSelected = tab.dataset.transcriptLang === openSessionDetail.language;
    tab.classList.toggle("is-selected", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
  }
}

async function openSessionRecordDetail(session) {
  const els = sessionDetailElements();
  if (!els.panel) return;
  try {
    const body = await fetch(`/api/subtitles/sessions/${encodeURIComponent(session.id)}`).then((res) => res.json());
    if (!body.ok) throw new Error(body.error || t("records.loadFailed"));
    const detail = body.data;
    // Prefer the record's own meta: a calendar chip only carries id and title,
    // so reading audioSources/lineCount off it lost the audio players entirely.
    const meta = detail.meta ?? {};
    const startedAt = meta.startedAt || session.startedAt;
    const endedAt = meta.endedAt || meta.effectiveEnd || session.endedAt;
    els.title.textContent = meta.title || session.title || formatSessionRecordTime(startedAt) || session.id;
    const period = [formatSessionRecordTime(startedAt), formatSessionRecordTime(endedAt)].filter(Boolean).join(" ~ ");
    els.meta.textContent = `${period} · ${t("records.lineCount", { count: meta.lineCount ?? session.lineCount ?? 0 })}`;
    openSessionDetail.id = session.id;
    openSessionDetail.lines = detail.lines ?? [];
    // Open on whichever language the record actually has, so a KO-only session
    // does not land on an empty EN tab.
    const hasEnglish = openSessionDetail.lines.some((line) => transcriptTextForLanguage(line, "en"));
    openSessionDetail.language = hasEnglish ? "en" : "ko";
    renderOpenSessionTranscript();
    els.summary.replaceChildren();
    if (detail.summary) {
      renderSessionSummary(els.summary, detail.summary);
      els.generate.hidden = true;
    } else {
      const pending = document.createElement("p");
      pending.textContent = t("records.noSummary");
      els.summary.append(pending);
      els.generate.hidden = false;
      els.generate.onclick = () => { void generateSessionDetailSummary(session); };
    }
    els.audio.replaceChildren();
    const audioSources = Array.isArray(meta.audioSources) ? meta.audioSources
      : (Array.isArray(session.audioSources) ? session.audioSources : []);
    for (const source of audioSources) {
      const label = document.createElement("span");
      label.textContent = source === "system" ? t("records.systemAudio") : t("records.micAudio");
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "none";
      player.src = `/api/subtitles/sessions/${encodeURIComponent(session.id)}/audio/${encodeURIComponent(source)}`;
      els.audio.append(label, player);
    }
    if (els.exportButton) {
      els.exportButton.hidden = openSessionDetail.lines.length === 0;
      els.exportButton.onclick = () => exportSessionTranscript(session);
    }
    els.page?.classList.add("is-detail-view");
    els.panel.hidden = false;
  } catch (error) {
    setSessionRecordsStatus(error.message, true);
  }
}

function closeSessionRecordDetail() {
  const els = sessionDetailElements();
  if (!els.panel) return;
  els.panel.hidden = true;
  els.page?.classList.remove("is-detail-view");
}

async function generateSessionDetailSummary(session) {
  const els = sessionDetailElements();
  els.generate.disabled = true;
  els.generate.setAttribute("aria-busy", "true");
  try {
    const body = await fetch(`/api/subtitles/sessions/${encodeURIComponent(session.id)}/summary`, { method: "POST" })
      .then((res) => res.json());
    if (!body.ok) throw new Error(body.error || t("records.summaryFailed"));
    session.hasSummary = true;
    renderSessionSummary(els.summary, body.data);
    els.generate.hidden = true;
    setSessionRecordsStatus(t("records.summaryReady"));
  } catch (error) {
    setSessionRecordsStatus(error.message, true);
  } finally {
    els.generate.disabled = false;
    els.generate.removeAttribute("aria-busy");
  }
}

document.getElementById("session-detail-back")?.addEventListener("click", closeSessionRecordDetail);

// The requested language may be either side of a turn: a Korean speaker's line
// has Korean in sourceText and English in translatedText, and an English
// speaker's line is the reverse. Returns "" when the line has nothing in that
// language, so the caller can skip it instead of printing the wrong language.
function transcriptTextForLanguage(line, language) {
  const source = String(line.sourceText ?? "").trim();
  const translated = String(line.translatedText ?? "").trim();
  const sourceLanguage = String(line.sourceLanguage ?? "").slice(0, 2).toLowerCase();
  const targetLanguage = String(line.targetLanguage ?? "").slice(0, 2).toLowerCase();
  if (targetLanguage === language && translated) return translated;
  if (sourceLanguage === language && source) return source;
  // Language unlabelled (older records, or a record-only 원문 relay): fall back
  // to whichever side exists so the turn is never silently dropped.
  if (!sourceLanguage && !targetLanguage) return source || translated;
  return "";
}

function renderSessionTranscript(container, lines, language = "en") {
  container.replaceChildren();
  const inLanguage = lines
    .map((line) => ({ line, text: transcriptTextForLanguage(line, language) }))
    .filter((entry) => entry.text);
  if (!inLanguage.length) {
    const empty = document.createElement("p");
    empty.textContent = t("records.noLines");
    container.append(empty);
    return;
  }
  const list = document.createElement("ol");
  list.className = "session-transcript-lines";
  for (const { line, text: lineText } of inLanguage) {
    const item = document.createElement("li");
    const stamp = document.createElement("time");
    const totalSeconds = Math.floor((line.elapsedMs ?? 0) / 1000);
    stamp.textContent = `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
    item.append(stamp);
    if (line.speaker) {
      const speaker = document.createElement("strong");
      speaker.className = "session-transcript-speaker";
      speaker.textContent = line.speaker;
      item.append(speaker);
    }
    const text = document.createElement("span");
    text.textContent = lineText;
    item.append(text);
    list.append(item);
  }
  container.append(list);
}

function renderSessionSummary(container, summary) {
  container.replaceChildren();
  if (!summary) return;
  if (summary.title) {
    const title = document.createElement("h3");
    title.textContent = summary.title;
    container.append(title);
  }
  if (summary.overview) {
    const overview = document.createElement("p");
    overview.textContent = summary.overview;
    container.append(overview);
  }
  for (const chapter of summary.chapters ?? []) {
    const heading = document.createElement("strong");
    heading.textContent = chapter.heading;
    const body = document.createElement("p");
    body.textContent = chapter.summary;
    container.append(heading, body);
  }
  if (summary.decisions?.length) {
    const label = document.createElement("strong");
    label.textContent = t("records.decisions");
    const list = document.createElement("ul");
    for (const decision of summary.decisions) {
      const item = document.createElement("li");
      item.textContent = decision;
      list.append(item);
    }
    container.append(label, list);
  }
  if (summary.actionItems?.length) {
    const label = document.createElement("strong");
    label.textContent = t("records.actionItems");
    const list = document.createElement("ul");
    for (const action of summary.actionItems) {
      const item = document.createElement("li");
      item.textContent = action.owner ? `${action.description} — ${action.owner}` : action.description;
      list.append(item);
    }
    container.append(label, list);
  }
}

document.getElementById("refresh-session-records")?.addEventListener("click", () => void loadSessionRecords());
document.getElementById("records-cal-prev")?.addEventListener("click", () => stepRecordsCalendar(-1));
document.getElementById("records-cal-next")?.addEventListener("click", () => stepRecordsCalendar(1));
document.getElementById("records-cal-today")?.addEventListener("click", () => {
  recordsCalendar.anchor = new Date();
  renderRecordsCalendar();
});
for (const button of document.querySelectorAll("[data-records-view]")) {
  button.addEventListener("click", () => {
    recordsCalendar.view = button.dataset.recordsView ?? "month";
    for (const sibling of document.querySelectorAll("[data-records-view]")) {
      const isSelected = sibling === button;
      sibling.classList.toggle("is-selected", isSelected);
      sibling.setAttribute("aria-pressed", String(isSelected));
    }
    renderRecordsCalendar();
  });
}

function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener("open", () => setConnectionStatus(t("status.captionsReady"), "active"));
  ws.addEventListener("close", () => {
    setConnectionStatus(t("status.disconnected"), "error");
    clearTranslatedAudioQueue();
    stopLocalStreams();
    void setControllerWindowVisible(false);
  });
  ws.addEventListener("error", () => setConnectionStatus(t("status.checkConnection"), "error"));
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "settings" && message.settings?.subtitle) {
      state.settings = { ...DEFAULT_SUBTITLE, ...message.settings.subtitle };
      state.hasOpenAIKey = Boolean(message.settings.hasOpenAIKey);
      state.hasOpenAISecondaryKey = Boolean(message.settings.hasOpenAISecondaryKey);
      state.hasGeminiKey = Boolean(message.settings.hasGeminiKey);
      state.hasGeminiSecondaryKey = Boolean(message.settings.hasGeminiSecondaryKey);
      writeSettingsToForm(state.settings);
      applyPreviewSettings(state.settings);
      updateOpenAIKeyPlaceholder();
      updateOpenAISecondaryKeyPlaceholder();
      updateOpenAIKeyStatus();
      updateOpenAISecondaryKeyStatus();
      updateGeminiKeyStatus();
      updateGeminiSecondaryKeyStatus();
      updateSessionSummary();
      updateServiceStrip();
      updateAudioInspectorLabels();
    }
    if (message.type === "subtitle:status") {
      if (message.status === "connecting") setConnectionStatus(t("status.serviceConnecting"), "active");
      else if (message.status === "api_ready") {
        setConnectionStatus(t("status.captionsReady"), "active");
        setRealtimeApiStatus(t("status.realtimeConnected"), "active");
      } else if (message.status === "hearing") {
        setConnectionStatus(t("status.hearing"), "active");
        setPreviewStatus(t("status.hearing"), 1200);
      } else if (message.status === "translating") {
        setConnectionStatus(t("status.translating"), "active");
        setPreviewStatus(t("status.translating"), 1800);
      } else if (message.status === "reconnecting") {
        setConnectionStatus(t("status.reconnecting"), "active");
        setRealtimeApiStatus(t("status.realtimeReconnecting"), "active");
        setPreviewStatus(t("status.reconnecting"), 1800);
      } else setConnectionStatus(message.status === "listening" ? t("status.receivingCaptions") : t("status.captionsReady"), message.status === "listening" ? "active" : "");
    }
    if (message.type === "subtitle:partial" && state.settings.outputMode !== "audio") {
      setPreviewText(message.translatedText, message.sourceText, true);
      return;
    }
    if (message.type === "subtitle:committed" && state.settings.outputMode !== "audio") {
      setPreviewText(message.translatedText, message.sourceText, false);
    }
    if (message.type === "subtitle:translated-audio") {
      if (!state.running || !state.sessionId || state.settings.outputMode === "captions" || message.targetLanguage !== state.settings.audioLanguage) return;
      const isCanonicalAudio = message.mimeType === "audio/pcm;rate=24000"
        && message.sampleRate === 24_000
        && typeof message.audio === "string";
      if (!isCanonicalAudio) {
        failTranslatedAudio(new Error(t("error.badAudioFrame")));
        return;
      }
      const previousAudioStreamId = translatedAudioGuard.activeStreamId;
      if (!translatedAudioGuard.shouldAccept(message)) return;
      if (previousAudioStreamId && previousAudioStreamId !== translatedAudioGuard.activeStreamId) clearTranslatedAudioQueue();
      const base64Audio = message.audio;
      subtitleAudioPlayer.enqueue({ audio: base64Audio, sampleRate: message.sampleRate });
    }
    if (message.type === "subtitle:audio-control" && (message.action === "clear" || message.action === "restart")) {
      if (!translatedAudioGuard.markControl(message)) return;
      clearTranslatedAudioQueue();
      if (message.action === "restart") setPreviewStatus(t("audio.recoveryContinuing"), 2400);
    }
    if (message.type === "subtitle:history") {
      renderHistory(message);
    }
    if (message.type === "subtitle:sessions") {
      renderSessionRecords(message.sessions ?? []);
    }
    if (message.type === "subtitle:session-summary") {
      setSessionRecordsStatus(t("records.summaryReady"));
      void loadSessionRecords();
    }
    if (message.type === "subtitle:control") {
      void handleSubtitleControllerCommand(message);
    }
    if (message.type === "subtitle:error") {
      void stopSubtitles();
      showError(new Error(message.message));
    }
  });
}

async function startSubtitles() {
  if (state.running) return;
  clearError();
  let captures = [];
  startButton.disabled = true;
  stopButton.disabled = true;
  try {
    state.settings = readSettingsFromForm();
    if (state.settings.outputMode !== "captions") {
      await subtitleAudioPlayer.resume(state.settings.audioVolume);
    }
    const patch = { subtitle: state.settings };
    const apiKeysPatch = {};
    if (openaiKeyInput.value.trim()) apiKeysPatch.openai = openaiKeyInput.value.trim();
    if (openaiSecondaryKeyInput?.value.trim()) apiKeysPatch.openaiSecondary = openaiSecondaryKeyInput.value.trim();
    if (geminiKeyInput?.value.trim()) apiKeysPatch.gemini = geminiKeyInput.value.trim();
    if (geminiSecondaryKeyInput?.value.trim()) apiKeysPatch.geminiSecondary = geminiSecondaryKeyInput.value.trim();
    if (Object.keys(apiKeysPatch).length > 0) patch.apiKeys = apiKeysPatch;
    if (!state.hasGeminiKey && !geminiKeyInput?.value.trim()) {
      throw new Error(t("key.geminiRequired"));
    }
    if (state.settings.outputMode !== "captions" && state.settings.voiceProvider === "openai"
      && !state.hasOpenAIKey && !openaiKeyInput.value.trim()) {
      throw new Error(t("key.openaiVoiceRequired"));
    }
    await saveSettings(patch);
    if (geminiKeyInput?.value.trim()) {
      state.hasGeminiKey = true;
      geminiKeyInput.value = "";
      updateGeminiKeyStatus();
    }
    if (geminiSecondaryKeyInput?.value.trim()) {
      state.hasGeminiSecondaryKey = true;
      geminiSecondaryKeyInput.value = "";
      updateGeminiSecondaryKeyStatus();
    }
    if (openaiKeyInput.value.trim()) {
      state.hasOpenAIKey = true;
      openaiKeyInput.value = "";
      updateOpenAIKeyPlaceholder();
      updateOpenAIKeyStatus();
      updateServiceStrip();
    }
    if (openaiSecondaryKeyInput?.value.trim()) {
      state.hasOpenAISecondaryKey = true;
      openaiSecondaryKeyInput.value = "";
      updateOpenAISecondaryKeyPlaceholder();
      updateOpenAISecondaryKeyStatus();
      updateServiceStrip();
    }
    await ensureWebSocketOpen();
    setConnectionStatus(t("status.checkingInputs"), "active");
    setPreviewStatus(t("status.inputCheck"), 1200);

    captures = await captureSelectedAudio(state.settings);
    state.streams = captures.map((capture) => capture.stream);
    // The successful capture unlocked device labels — refresh the mic list so
    // it shows real microphone names for the next selection.
    void hydrateMicrophones();

    state.sessionId = crypto.randomUUID();
    translatedAudioGuard.reset();
    state.ws.send(JSON.stringify({
      type: "subtitle:start",
      sessionId: state.sessionId,
      settings: state.settings,
      meeting: await describeActiveMeeting(),
    }));
    if (state.settings.outputMode !== "audio") setPreviewStatus(t("status.waitingForCaptions"), 1800);

    for (const capture of captures) {
      const streamer = await createAudioStreamer(capture.stream, capture.source, capture.label, (audio) => {
        // Backpressure guard: if the server stops draining our socket, drop
        // frames instead of letting the browser's ws buffer grow without bound
        // (audio queues up, subtitles fall behind, then appear frozen).
        if ((state.ws?.bufferedAmount ?? 0) > 1_000_000) return;
        if (shouldGateTranslatedAudioInput(
          state.settings.outputMode,
          subtitleAudioPlayer.isInputSuppressionActive(),
          capture.source,
        )) return;
        if (state.ws?.readyState === WebSocket.OPEN && state.sessionId) {
          state.ws.send(JSON.stringify({
            type: "subtitle:audio",
            sessionId: state.sessionId,
            source: capture.source,
            audio,
          }));
        }
      });
      state.streamers.push(streamer);
    }
    state.running = true;
    stopButton.disabled = false;
    syncRuntimeOutputVisibility();
    setConnectionStatus(t("status.receivingCaptions"), "active");
    if (state.settings.outputMode !== "captions" && state.settings.inputMode !== "mic") {
      showNotice(t("notice.audioFeedbackWarning"));
    }
  } catch (error) {
    if (state.streams.length === 0) {
      for (const capture of captures) capture.stream.getTracks().forEach((track) => track.stop());
    }
    await stopSubtitles();
    showError(error);
  }
}

async function stopSubtitles() {
  const sessionId = state.sessionId;
  state.sessionId = null;
  clearTranslatedAudioQueue();
  stopLocalStreams();
  if (state.ws?.readyState === WebSocket.OPEN && sessionId) {
    state.ws.send(JSON.stringify({ type: "subtitle:stop", sessionId }));
  }
  state.running = false;
  startButton.disabled = false;
  stopButton.disabled = true;
  syncRuntimeOutputVisibility();
}

// Rebuild the running session's translation channels without tearing down the
// local audio capture: re-send subtitle:start with the SAME sessionId and the
// new settings. The server stops the old channels and opens fresh ones, and the
// still-running audio streamers (same sessionId) feed straight into them — so a
// mid-session language/engine switch never leaves stale channels translating
// the old configuration.
function reconfigureRunningSession() {
  if (!state.running || !state.sessionId || state.ws?.readyState !== WebSocket.OPEN) return;
  clearTranslatedAudioQueue();
  state.ws.send(JSON.stringify({ type: "subtitle:start", sessionId: state.sessionId, settings: state.settings }));
}

async function handleSubtitleControllerCommand(message) {
  if (message.command === "stop") {
    await stopSubtitles();
    return;
  }
  if (message.command === "restart") {
    await restartSubtitles();
    return;
  }
  if (message.command === "font") {
    adjustControllerFontSize(Number.isFinite(Number(message.delta)) ? Number(message.delta) : 0);
    return;
  }
  if (message.command === "offset") {
    adjustControllerVerticalOffset(Number.isFinite(Number(message.delta)) ? Number(message.delta) : 0);
    return;
  }
  if (message.command === "position") {
    setControllerSubtitlePosition(message.position);
    return;
  }
  if (message.command === "languages") {
    applyControllerLanguagePreset(message.languages);
    return;
  }
  if (message.command === "voice-provider") {
    const provider = message.voiceProvider === "openai" ? "openai" : "gemini";
    const input = form.querySelector(`input[name="voiceProvider"][value="${provider}"]`);
    if (input && !input.disabled) {
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  if (message.command === "opacity") {
    setControllerOpacity(message.opacity);
  }
}

function setControllerWindowVisible(visible) {
  if (!window.realtimeNoelDesktop?.setControllerVisible) return Promise.resolve(false);
  return window.realtimeNoelDesktop.setControllerVisible(Boolean(visible)).catch((error) => {
    showError(error);
    return false;
  });
}

async function restartSubtitles() {
  await stopSubtitles();
  await startSubtitles();
  showNotice(t("notice.captionEngineRestarted"));
}

function stopLocalStreams() {
  for (const streamer of state.streamers) streamer.close?.();
  for (const stream of state.streams) stopMediaStream(stream);
  state.streams = [];
  state.streamers = [];
  stopAudioMeters();
  updateAudioInspectorLabels();
}

async function captureSelectedAudio(settings) {
  const tasks = [];
  if (settings.inputMode === "system" || settings.inputMode === "system_mic") {
    tasks.push(captureAudioSource("system", t("audio.systemAudio"), captureSystemAudio));
  }
  if (settings.inputMode === "mic" || settings.inputMode === "system_mic") {
    tasks.push(captureAudioSource("mic", selectedMicrophoneLabel(), captureMicrophoneAudio));
  }

  const results = await Promise.allSettled(tasks);
  const captures = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason.message || String(result.reason));

  if (captures.length === 0) {
    throw new Error(failures.join(" "));
  }
  if (failures.length > 0) showNotice(t("notice.partialInputs", { failures: failures.join(" ") }));
  return captures;
}

async function captureAudioSource(source, fallbackLabel, capture) {
  try {
    const stream = await withMediaCaptureTimeout(capture(), source);
    return { source, stream, label: getAudioTrackLabel(stream, fallbackLabel) };
  } catch (error) {
    setAudioSourceStatus(source, t("audio.unavailable"), 0);
    throw new Error(formatCaptureFailure(source, error));
  }
}

async function captureSystemAudio() {
  // Electron routes this request through the main-process loopback handler
  // (callback({ video, audio: "loopback" })). System/loopback audio is not a
  // real input device, so passing a device-style audio constraints object
  // (echo cancellation, local-audio suppression, gain control, ...) makes
  // getDisplayMedia reject with "Invalid capture constraints". The renderer must pass
  // `audio: true` as a plain signal and let the main process supply the
  // loopback track. `video: true` is required or getDisplayMedia fails outright;
  // we stop the video track immediately below.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  stream.getVideoTracks().forEach((track) => track.stop());
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(t("error.noSystemAudioTrack"));
  }
  return stream;
}

async function captureMicrophoneAudio() {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (!micSelect.value) return navigator.mediaDevices.getUserMedia({ audio });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: micSelect.value } } });
  } catch (error) {
    // A persisted device id can go stale (mic unplugged, ids renumbered) and
    // then the exact constraint throws OverconstrainedError. Permission errors
    // would fail again anyway, so always retry once on the system default mic
    // rather than losing the whole mic input.
    console.warn(`[subtitle] selected microphone failed (${error?.name ?? error}); retrying with system default`);
    return navigator.mediaDevices.getUserMedia({ audio });
  }
}

function withMediaCaptureTimeout(promise, sourceName) {
  let settled = false;
  let timedOut = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (settled) return;
      settled = true;
      reject(new Error(t("error.captureTimeout", { source: sourceName, seconds: CAPTURE_TIMEOUT_MS / 1000 })));
    }, CAPTURE_TIMEOUT_MS);

    promise.then((stream) => {
      if (timedOut || settled) {
        stopMediaStream(stream);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(stream);
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function stopMediaStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}


async function createAudioStreamer(media, sourceName, label, onChunk) {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  await ensureAudioContextRunning(context, sourceName);
  const source = context.createMediaStreamSource(media);
  const processor = context.createScriptProcessor(AUDIO_PROCESSOR_BUFFER_SIZE, 1, 1);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  let carry = new Float32Array(0);
  let pendingSamples = new Float32Array(0);
  const meter = startAudioLevelMeter(sourceName, label, analyser);
  const cleanupTrackDiagnostics = watchAudioTrackState(media, sourceName);

  context.addEventListener?.("statechange", () => {
    if (context.state === "running") setAudioSourceStatus(sourceName, t("audio.ready"), 0);
    if (context.state === "suspended") setAudioSourceStatus(sourceName, t("audio.paused"), 0);
  });

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = context.sampleRate === SAMPLE_RATE
      ? { samples: input, carry: new Float32Array(0) }
      : resample(input, context.sampleRate, SAMPLE_RATE, carry);
    carry = resampled.carry;
    if (resampled.samples.length === 0) return;
    const availableSamples = new Float32Array(pendingSamples.length + resampled.samples.length);
    availableSamples.set(pendingSamples);
    availableSamples.set(resampled.samples, pendingSamples.length);
    let offset = 0;
    while (availableSamples.length - offset >= LIVE_AUDIO_CHUNK_SAMPLES) {
      onChunk(pcm16ToBase64(availableSamples.subarray(offset, offset + LIVE_AUDIO_CHUNK_SAMPLES)));
      offset += LIVE_AUDIO_CHUNK_SAMPLES;
    }
    pendingSamples = availableSamples.slice(offset);
  };

  source.connect(processor);
  source.connect(analyser);
  const mute = context.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(context.destination);

  return {
    close: async () => {
      // A trailing fragment shorter than the Live API's 100 ms frame belongs to
      // the ending session and must not leak into a later session.
      pendingSamples = new Float32Array(0);
      cleanupTrackDiagnostics();
      meter.close();
      processor.disconnect();
      mute.disconnect();
      source.disconnect();
      await context.close();
    },
  };
}

async function ensureAudioContextRunning(context, sourceName) {
  if (context.state === "running") return;
  setAudioSourceStatus(sourceName, t("audio.starting"), 0);
  try {
    await context.resume();
  } catch {
    setAudioSourceStatus(sourceName, t("audio.blocked"), 0);
    throw new Error(t("error.audioEngineStart", { source: sourceName }));
  }
  if (context.state !== "running") {
    setAudioSourceStatus(sourceName, t("audio.blocked"), 0);
    throw new Error(t("error.audioEngineSuspended", { source: sourceName }));
  }
}

function watchAudioTrackState(media, sourceName) {
  const tracks = media.getAudioTracks();
  const cleanups = tracks.map((track) => {
    const onMute = () => setAudioSourceStatus(sourceName, t("audio.muted"), 0);
    const onUnmute = () => setAudioSourceStatus(sourceName, t("audio.ready"), 0);
    const onEnded = () => setAudioSourceStatus(sourceName, t("audio.ended"), 0);
    track.addEventListener?.("mute", onMute);
    track.addEventListener?.("unmute", onUnmute);
    track.addEventListener?.("ended", onEnded);
    if (track.muted) onMute();
    if (track.readyState === "ended") onEnded();
    return () => {
      track.removeEventListener?.("mute", onMute);
      track.removeEventListener?.("unmute", onUnmute);
      track.removeEventListener?.("ended", onEnded);
    };
  });
  return () => cleanups.forEach((cleanup) => cleanup());
}

function startAudioLevelMeter(sourceName, label, analyser) {
  const data = new Uint8Array(analyser.fftSize);
  let frame = 0;
  let silentSince = performance.now();
  let lastBroadcastAt = 0;
  let lastBroadcastStatus = "";
  setAudioSourceLabel(sourceName, label);

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 6);
    const now = performance.now();
    const isFeedbackSuppressed = shouldGateTranslatedAudioInput(
      state.settings.outputMode,
      subtitleAudioPlayer.isInputSuppressionActive(),
      sourceName,
    );
    const hasSignal = !isFeedbackSuppressed && level > INPUT_SIGNAL_THRESHOLD;
    if (hasSignal) silentSince = now;
    const inputStatus = hasSignal ? "signal" : now - silentSince > INPUT_SILENCE_WARNING_MS ? "silent" : "waiting";
    setAudioSourceStatus(sourceName, isFeedbackSuppressed ? t("audio.outputIsolated") : hasSignal ? t("audio.signal") : t("audio.noSignal"), isFeedbackSuppressed ? 0 : level);
    if (inputStatus !== lastBroadcastStatus || now - lastBroadcastAt > INPUT_STATUS_BROADCAST_MS) {
      broadcastInputStatus(sourceName, inputStatus, isFeedbackSuppressed ? 0 : level);
      lastBroadcastStatus = inputStatus;
      lastBroadcastAt = now;
    }
    frame = requestAnimationFrame(tick);
  };

  tick();
  const close = () => {
    cancelAnimationFrame(frame);
    state.audioMeters.delete(sourceName);
  };
  state.audioMeters.set(sourceName, { close });
  return { close };
}

function broadcastInputStatus(sourceName, status, level) {
  if (state.ws?.readyState !== WebSocket.OPEN || !state.sessionId) return;
  state.ws.send(JSON.stringify({
    type: "subtitle:input-status",
    sessionId: state.sessionId,
    source: sourceName,
    status,
    level,
  }));
}

function stopAudioMeters() {
  for (const meter of state.audioMeters.values()) meter.close();
  state.audioMeters.clear();
  setAudioSourceStatus("system", inputModeUses("system") ? t("audio.ready") : t("audio.off"), 0);
  setAudioSourceStatus("mic", inputModeUses("mic") ? t("audio.ready") : t("audio.off"), 0);
}

function updateAudioInspectorLabels() {
  setAudioSourceLabel("system", t("audio.systemAudio"));
  setAudioSourceLabel("mic", selectedMicrophoneLabel());
  if (state.running) return;
  setAudioSourceStatus("system", inputModeUses("system") ? t("audio.ready") : t("audio.off"), 0);
  setAudioSourceStatus("mic", inputModeUses("mic") ? t("audio.ready") : t("audio.off"), 0);
}

function inputModeUses(sourceName) {
  const mode = form.elements.inputMode.value || state.settings.inputMode;
  if (sourceName === "system") return mode === "system" || mode === "system_mic";
  return mode === "mic" || mode === "system_mic";
}

function setAudioSourceLabel(sourceName, label) {
  const target = audioStatus[sourceName]?.label;
  if (target) target.textContent = label || (sourceName === "system" ? t("audio.systemAudio") : t("settings.systemDefault"));
}

function setAudioSourceStatus(sourceName, status, level) {
  const target = audioStatus[sourceName];
  if (!target) return;
  if (target.state) target.state.textContent = status;
  if (target.meter) target.meter.style.width = `${Math.round(Math.max(0, Math.min(1, level)) * 100)}%`;
}

function selectedMicrophoneLabel() {
  return micSelect.selectedOptions[0]?.textContent || t("settings.systemDefault");
}

function getAudioTrackLabel(stream, fallback) {
  return stream.getAudioTracks()[0]?.label || fallback;
}

function resample(input, fromRate, toRate, carry) {
  const merged = new Float32Array(carry.length + input.length);
  merged.set(carry);
  merged.set(input, carry.length);
  const ratio = fromRate / toRate;
  const outputLength = Math.floor((merged.length - 1) / ratio);
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, merged.length - 1);
    const weight = sourceIndex - left;
    output[index] = merged[left] * (1 - weight) + merged[right] * weight;
  }
  const consumed = Math.floor(outputLength * ratio);
  return { samples: output, carry: merged.slice(consumed) };
}

function pcm16ToBase64(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

// Device labels stay empty until the page has held a mic permission grant at
// least once. Only open a temporary stream when labels are actually missing,
// so routine devicechange refreshes don't grab the microphone.
async function unlockMicrophoneLabels(devices) {
  const audioInputs = devices.filter((item) => item.kind === "audioinput");
  if (audioInputs.length === 0 || audioInputs.some((device) => device.label)) return devices;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
  return navigator.mediaDevices.enumerateDevices();
}

async function hydrateMicrophones() {
  try {
    const selectedDeviceId = state.settings.micDeviceId || micSelect.value;
    const devices = await unlockMicrophoneLabels(await navigator.mediaDevices.enumerateDevices());
    micSelect.replaceChildren(new Option(t("settings.systemDefault"), ""));
    for (const device of devices.filter((item) => item.kind === "audioinput")) {
      if (!device.deviceId) continue;
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${device.deviceId.slice(0, 8)}`;
      micSelect.append(option);
    }
    if ([...micSelect.options].some((option) => option.value === selectedDeviceId)) {
      micSelect.value = selectedDeviceId;
    }
    updateAudioInspectorLabels();
  } catch {
    updateAudioInspectorLabels();
    // Users can still start system-audio-only subtitles without microphone permission.
  }
}

async function saveSettings(patch) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || t("error.saveSettingsFailed"));
  if (body.settings) {
    state.hasOpenAIKey = Boolean(body.settings.hasOpenAIKey);
    state.hasOpenAISecondaryKey = Boolean(body.settings.hasOpenAISecondaryKey);
    state.hasGeminiKey = Boolean(body.settings.hasGeminiKey);
    state.hasGeminiSecondaryKey = Boolean(body.settings.hasGeminiSecondaryKey);
    updateOpenAIKeyPlaceholder();
    updateOpenAISecondaryKeyPlaceholder();
    updateOpenAIKeyStatus();
    updateOpenAISecondaryKeyStatus();
    updateGeminiKeyStatus();
    updateGeminiSecondaryKeyStatus();
  }
  return body;
}

function readSettingsFromForm() {
  const translationFontSize = readNumber(form.elements.translationFontSize.value, DEFAULT_SUBTITLE.translationFontSize);
  const sourceFontSize = readNumber(form.elements.sourceFontSize.value, Math.max(14, translationFontSize - 2));
  const translationLanguages = readTranslationLanguagesFromForm();
  const subtitlePositions = readSubtitlePositionsFromForm();
  // `position` is now a back-compat fallback only (the overlay uses
  // subtitlePositions per language); keep it meaningful = the first shown
  // language's placement.
  const position = subtitlePositions[translationLanguages[0]] || form.elements.position?.value || DEFAULT_SUBTITLE.position;
  const translationProvider = "gemini";
  const requestedOutputMode = selectedOutputMode();
  const outputMode = requestedOutputMode;
  const voiceProvider = selectedVoiceProvider();
  const requestedAudioLanguage = form.elements.audioLanguage?.value;
  const audioLanguage = translationLanguages.includes(requestedAudioLanguage) ? requestedAudioLanguage : translationLanguages[0];
  return {
    ...state.settings,
    inputMode: form.elements.inputMode.value,
    micDeviceId: form.elements.micDeviceId.value,
    languagePair: deriveLanguagePairFromTargets(translationLanguages),
    translationLanguages,
    outputMode,
    voiceProvider,
    audioLanguage,
    audioVolume: Math.max(0, Math.min(1, readNumber(form.elements.audioVolume?.value, DEFAULT_SUBTITLE.audioVolume))),
    displayMode: "translation_only",
    // Source ("원문") display removed — subtitles are always translation-only.
    showSourceText: false,
    translateAllLanguages: translationLanguages.length >= 3,
    model: "gpt-realtime-translate",
    fontFamily: form.elements.fontFamily.value || DEFAULT_SUBTITLE.fontFamily,
    translationFontSize,
    sourceFontSize,
    position,
    subtitlePositions,
    maxWidth: Number(form.elements.maxWidth.value) || DEFAULT_SUBTITLE.maxWidth,
    opacity: readNumber(form.elements.opacity.value, DEFAULT_SUBTITLE.opacity),
    maxSubtitleLines: Math.min(8, Math.max(1, Math.round(readNumber(form.elements.maxSubtitleLines.value, DEFAULT_SUBTITLE.maxSubtitleLines)))),
    overlayEnabled: Boolean(form.elements.overlayEnabled.checked),
    recordProvider: form.elements.recordProvider.value,
    ollamaBaseURL: form.elements.ollamaBaseURL.value || DEFAULT_SUBTITLE.ollamaBaseURL,
    ollamaModel: form.elements.ollamaModel.value || DEFAULT_SUBTITLE.ollamaModel,
    tone: form.elements.tone?.value === "business" ? "business" : "natural",
    translationProvider,
    glossary: form.elements.glossary?.value ?? "",
    translationDomain: form.elements.translationDomain?.value ?? "",
    verticalOffset: Math.min(600, Math.max(0, Math.round(readNumber(form.elements.verticalOffset?.value, DEFAULT_SUBTITLE.verticalOffset)))),
  };
}

function writeSettingsToForm(settings) {
  form.elements.inputMode.value = settings.inputMode;
  form.elements.micDeviceId.value = settings.micDeviceId ?? "";
  writeTranslationLanguageCheckboxes(settings.translationLanguages ?? [settings.languagePair?.a ?? "en", settings.languagePair?.b ?? "ko"]);
  form.elements.displayMode.value = "translation_only";
  if (form.elements.translateAllLanguages) form.elements.translateAllLanguages.checked = readTranslationLanguagesFromForm().length >= 3;
  form.elements.recordProvider.value = settings.recordProvider ?? DEFAULT_SUBTITLE.recordProvider;
  if (form.elements.tone) form.elements.tone.value = settings.tone ?? DEFAULT_SUBTITLE.tone;
  if (form.elements.translationProvider) {
    form.elements.translationProvider.value = "gemini";
  }
  syncAudioLanguageOptions(
    settings.translationLanguages ?? [settings.languagePair?.a ?? "en", settings.languagePair?.b ?? "ko"],
    settings.audioLanguage ?? DEFAULT_SUBTITLE.audioLanguage,
  );
  const outputMode = ["captions", "audio"].includes(settings.outputMode) ? settings.outputMode : DEFAULT_SUBTITLE.outputMode;
  const outputModeInput = form.querySelector(`input[name="outputMode"][value="${outputMode}"]`);
  if (outputModeInput) outputModeInput.checked = true;
  const voiceProvider = settings.voiceProvider === "openai" ? "openai" : "gemini";
  const voiceProviderInput = form.querySelector(`input[name="voiceProvider"][value="${voiceProvider}"]`);
  if (voiceProviderInput) voiceProviderInput.checked = true;
  if (form.elements.audioVolume) form.elements.audioVolume.value = Math.max(0, Math.min(1, readNumber(settings.audioVolume, DEFAULT_SUBTITLE.audioVolume)));
  enforcePtOutputAvailability();
  updatePtOutputControls();
  if (form.elements.glossary) form.elements.glossary.value = settings.glossary ?? "";
  if (form.elements.translationDomain) form.elements.translationDomain.value = settings.translationDomain ?? "";
  if (form.elements.verticalOffset) form.elements.verticalOffset.value = settings.verticalOffset ?? DEFAULT_SUBTITLE.verticalOffset;
  updateVerticalOffsetValue(settings.verticalOffset ?? DEFAULT_SUBTITLE.verticalOffset);
  const perLanguagePositions = { ...DEFAULT_SUBTITLE.subtitlePositions, ...(settings.subtitlePositions ?? {}) };
  for (const language of supportedLanguageCodes) {
    const value = perLanguagePositions[language] ?? settings.position ?? "bottom-center";
    const radio = form.querySelector(`input[name="pos-${language}"][value="${value}"]`);
    if (radio) radio.checked = true;
  }
  syncPlacementRows(settings.translationLanguages ?? readTranslationLanguagesFromForm());
  markLanguageMinimum();
  form.elements.ollamaBaseURL.value = settings.ollamaBaseURL ?? DEFAULT_SUBTITLE.ollamaBaseURL;
  form.elements.ollamaModel.value = settings.ollamaModel ?? DEFAULT_SUBTITLE.ollamaModel;
  form.elements.maxSubtitleLines.value = settings.maxSubtitleLines ?? DEFAULT_SUBTITLE.maxSubtitleLines;
  form.elements.overlayEnabled.checked = settings.overlayEnabled !== false;
  form.elements.fontFamily.value = settings.fontFamily;
  form.elements.translationFontSize.value = settings.translationFontSize;
  form.elements.translationFontSizeRange.value = settings.translationFontSize;
  form.elements.sourceFontSize.value = settings.sourceFontSize;
  form.elements.sourceFontSizeRange.value = settings.sourceFontSize;
  form.elements.position.value = settings.position;
  form.elements.maxWidth.value = settings.maxWidth;
  form.elements.opacity.value = settings.opacity;
  updateOpacityValue(settings.opacity);
}

function normalizeLanguagePair(a, b) {
  if (a === b) return a === "ko" ? { a: "ko", b: "en" } : { a, b: "ko" };
  return { a, b };
}

// languagePair is now derived from the selected target languages (legacy field
// still consumed by the glossary-preset matcher); the model auto-detects the
// spoken source, so there is no user-facing from/to direction anymore.
function deriveLanguagePairFromTargets(languages) {
  const list = (Array.isArray(languages) ? languages : []).filter((language) => isSupportedLanguageCode(language));
  const a = list[0] ?? "en";
  const b = list[1] ?? (a === "ko" ? "en" : "ko");
  return normalizeLanguagePair(a, b);
}

function readTranslationLanguagesFromForm() {
  const selected = [...form.querySelectorAll('input[name="translationLanguages"]:checked')]
    .map((input) => input.value)
    .filter((language) => isSupportedLanguageCode(language));
  if (selected.length >= 2) return selected.slice(0, MAX_SELECTED_LANGUAGES);
  const fallback = Array.isArray(state.settings.translationLanguages) ? state.settings.translationLanguages : [];
  const merged = [...new Set([...selected, ...fallback, "en", "ko"])].filter((language) => isSupportedLanguageCode(language));
  return merged.slice(0, 2);
}

function writeTranslationLanguageCheckboxes(languages = []) {
  const selected = new Set(languages.filter((language) => isSupportedLanguageCode(language)).slice(0, MAX_SELECTED_LANGUAGES));
  if (selected.size < 2) {
    selected.add("en");
    selected.add("ko");
  }
  for (const input of form.querySelectorAll('input[name="translationLanguages"]')) {
    input.checked = selected.has(input.value);
  }
  if (form.elements.translateAllLanguages) form.elements.translateAllLanguages.checked = selected.size >= 3;
  syncAudioLanguageOptions([...selected], form.elements.audioLanguage?.value ?? state.settings.audioLanguage);
  renderLanguageChips();
}

// The language pills are the single source of truth. Enforce a 2-language
// minimum (the translator needs at least two languages) by reverting an
// un-check that would drop below two, with a brief invalid flash, and keep the
// placement rows in step with what's selected.
function syncLanguageControls(target) {
  if (target?.name !== "translationLanguages") return;
  const checked = form.querySelectorAll('input[name="translationLanguages"]:checked');
  if (checked.length < 2 && target.checked === false) {
    target.checked = true;
    flashLanguageMinimum();
  }
  markLanguageMinimum();
  renderLanguageChips();
  syncPlacementRows(readTranslationLanguagesFromForm());
}

function markLanguageMinimum() {
  const atMinimum = form.querySelectorAll('input[name="translationLanguages"]:checked').length <= 2;
  for (const input of form.querySelectorAll('input[name="translationLanguages"]')) {
    input.closest(".lang-pill")?.classList.toggle("at-minimum", atMinimum && input.checked);
  }
}

let languageMinimumTimer = null;
function flashLanguageMinimum() {
  const group = document.querySelector(".language-targets");
  const hint = document.getElementById("language-targets-hint");
  if (!group) return;
  clearTimeout(languageMinimumTimer);
  group.classList.add("invalid");
  // The hint is empty + hidden by default (decluttered workspace); it only
  // appears for this validation flash, then hides again.
  if (hint) { hint.textContent = t("language.minimum"); hint.hidden = false; }
  languageMinimumTimer = setTimeout(() => {
    group.classList.remove("invalid");
    if (hint) { hint.textContent = ""; hint.hidden = true; }
  }, 1200);
}

function updateOpenAIKeyPlaceholder() {
  openaiKeyInput.placeholder = state.hasOpenAIKey ? t("key.configuredPlaceholder") : "sk-...";
}

function updateOpenAISecondaryKeyPlaceholder() {
  if (!openaiSecondaryKeyInput) return;
  openaiSecondaryKeyInput.placeholder = state.hasOpenAISecondaryKey ? t("key.configuredPlaceholder") : "sk-... (separate Project)";
}

async function saveOpenAIKey() {
  clearError();
  const openaiKey = openaiKeyInput.value.trim();
  if (!openaiKey) {
    showError(new Error(state.hasOpenAIKey ? t("key.replaceHint") : t("key.enterOpenAI")));
    return;
  }
  try {
    openaiKeyStatus.textContent = t("key.validatingOpenAI");
    await validateOpenAIKey(openaiKey);
    await saveSettings({ apiKeys: { openai: openaiKey } });
    openaiKeyInput.value = "";
    state.hasOpenAIKey = true;
    updateOpenAIKeyPlaceholder();
    updateOpenAIKeyStatus();
    updateServiceStrip();
    showNotice(t("key.openaiSaved"));
  } catch (error) {
    updateOpenAIKeyStatus();
    showError(error);
  }
}

async function saveOpenAISecondaryKey() {
  clearError();
  const openaiSecondaryKey = openaiSecondaryKeyInput?.value.trim() ?? "";
  if (!openaiSecondaryKey) {
    showError(new Error(state.hasOpenAISecondaryKey ? t("key.replaceHintSecondary") : t("key.enterOpenAISecondary")));
    return;
  }
  try {
    openaiSecondaryKeyStatus.textContent = t("key.validatingOpenAI");
    await validateOpenAIKey(openaiSecondaryKey);
    await saveSettings({ apiKeys: { openaiSecondary: openaiSecondaryKey } });
    openaiSecondaryKeyInput.value = "";
    state.hasOpenAISecondaryKey = true;
    updateOpenAISecondaryKeyPlaceholder();
    updateOpenAISecondaryKeyStatus();
    updateServiceStrip();
    showNotice(t("key.openaiSecondarySaved"));
  } catch (error) {
    updateOpenAISecondaryKeyStatus();
    showError(error);
  }
}

async function validateOpenAIKey(openaiKey) {
  const res = await fetch("/api/subtitles/openai/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: openaiKey }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || t("key.openaiValidateFailed"));
  return body;
}

function updateOpenAIKeyStatus() {
  renderKeyStatus(openaiKeyStatus, state.hasOpenAIKey);
}

function updateOpenAISecondaryKeyStatus() {
  renderKeyStatus(openaiSecondaryKeyStatus, state.hasOpenAISecondaryKey);
}

function updateGeminiKeyStatus() {
  renderKeyStatus(geminiKeyStatus, state.hasGeminiKey);
  if (geminiKeyInput) geminiKeyInput.placeholder = state.hasGeminiKey ? t("key.configuredPlaceholder") : "AIza...";
}

// Explicit registration badge: the key never round-trips to the client, so
// this badge is the user's only confirmation that a key is stored.
function renderKeyStatus(element, registered) {
  if (!element) return;
  element.dataset.i18n = registered ? "key.registered" : "key.unregistered";
  element.textContent = t(element.dataset.i18n);
  element.classList.toggle("registered", Boolean(registered));
}

async function saveGeminiKey() {
  clearError();
  const geminiKey = geminiKeyInput.value.trim();
  if (!geminiKey) {
    showError(new Error(state.hasGeminiKey ? t("key.replaceHint") : t("key.enterGemini")));
    return;
  }
  try {
    geminiKeyStatus.textContent = t("key.validatingGemini");
    await validateGeminiKey(geminiKey);
    geminiKeyStatus.textContent = t("key.savingGemini");
    await saveSettings({ apiKeys: { gemini: geminiKey } });
    geminiKeyInput.value = "";
    state.hasGeminiKey = true;
    updateGeminiKeyStatus();
    updateServiceStrip();
    showNotice(t("key.geminiSaved"));
  } catch (error) {
    updateGeminiKeyStatus();
    showError(error);
  }
}

async function validateGeminiKey(geminiKey) {
  const res = await fetch("/api/subtitles/gemini/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: geminiKey }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || t("key.geminiValidateFailed"));
  return body;
}

function updateGeminiSecondaryKeyStatus() {
  if (!geminiSecondaryKeyStatus) return;
  renderKeyStatus(geminiSecondaryKeyStatus, state.hasGeminiSecondaryKey);
  if (state.hasGeminiSecondaryKey) {
    geminiSecondaryKeyStatus.dataset.i18n = "key.registeredSecondary";
    geminiSecondaryKeyStatus.textContent = t("key.registeredSecondary");
  }
  if (geminiSecondaryKeyInput) geminiSecondaryKeyInput.placeholder = state.hasGeminiSecondaryKey ? t("key.configuredPlaceholder") : "AIza... (separate Project)";
}

// Second Gemini key: a separate Gemini project for committed-line glossary
// finalization first, and extra Live channels second. Key 1 keeps the realtime
// Gemini 3.5 Live Translate socket responsive while key 2 handles terminology
// correction after an utterance commits.
async function saveGeminiSecondaryKey() {
  clearError();
  const geminiSecondaryKey = geminiSecondaryKeyInput?.value.trim() ?? "";
  if (!geminiSecondaryKey) {
    showError(new Error(state.hasGeminiSecondaryKey ? t("key.replaceHintSecondary") : t("key.enterGeminiSecondary")));
    return;
  }
  try {
    geminiSecondaryKeyStatus.textContent = t("key.validatingGemini");
    await validateGeminiKey(geminiSecondaryKey);
    geminiSecondaryKeyStatus.textContent = t("key.savingGemini2");
    await saveSettings({ apiKeys: { geminiSecondary: geminiSecondaryKey } });
    geminiSecondaryKeyInput.value = "";
    state.hasGeminiSecondaryKey = true;
    updateGeminiSecondaryKeyStatus();
    showNotice(t("key.geminiSecondarySaved"));
  } catch (error) {
    updateGeminiSecondaryKeyStatus();
    showError(error);
  }
}

function applyPreviewSettings(settings) {
  document.documentElement.style.setProperty("--subtitle-font-family", settings.fontFamily);
  document.documentElement.style.setProperty("--translation-font-size", `${settings.translationFontSize}px`);
  document.documentElement.style.setProperty("--source-font-size", `${settings.sourceFontSize}px`);
  document.documentElement.style.setProperty("--subtitle-max-width", `${settings.maxWidth}px`);
  document.documentElement.style.setProperty("--subtitle-opacity", String(settings.opacity));
  document.documentElement.style.setProperty("--subtitle-line-clamp", String(settings.maxSubtitleLines ?? 2));
  document.documentElement.style.setProperty("--subtitle-vertical-offset", `${settings.verticalOffset ?? DEFAULT_SUBTITLE.verticalOffset}px`);
  preview.classList.add("translation-only");
  preview.querySelector(".source-line").hidden = true;
  updateOpacityValue(settings.opacity);
  updateVerticalOffsetValue(settings.verticalOffset ?? DEFAULT_SUBTITLE.verticalOffset);
  syncCaptionPlayerController();
}

function setPreviewText(translatedText, sourceText, partial) {
  clearTimeout(state.previewStatusTimer);
  state.previewStatusTimer = null;
  preview.querySelector(".translation-line").textContent = translatedText || "";
  void sourceText;
  const sourceLine = preview.querySelector(".source-line");
  sourceLine.textContent = "";
  sourceLine.hidden = true;
  preview.classList.toggle("partial", partial);
}

function setPreviewStatus(translatedText, ms) {
  setPreviewText(translatedText, "", true);
  state.previewStatusTimer = setTimeout(() => {
    preview.querySelector(".translation-line").textContent = "";
    preview.querySelector(".source-line").textContent = "";
    preview.classList.remove("partial");
    state.previewStatusTimer = null;
  }, ms);
}

function renderHistory(snapshot) {
  const records = dedupeFinalHistoryRecords(Array.isArray(snapshot.records) ? snapshot.records : []);
  state.history = {
    records,
    topics: Array.isArray(snapshot.topics) ? snapshot.topics : [],
    historyDays: normalizeHistoryDays(snapshot),
    recorderStatus: snapshot.recorderStatus ?? {},
  };
  translationCount.textContent = String(countHistoryRecords(state.history.historyDays, state.history.records));
  recorderStatus.textContent = recorderStatusText(state.history.recorderStatus);
  setTopicModelStatus(recorderStatus.textContent, state.history.recorderStatus?.lastError ? "error" : "active");
  topicList.replaceChildren(...topicNodes(state.history.topics));
  translationLog.replaceChildren(...historyDayNodes(state.history.historyDays));
}

function normalizeHistoryDays(snapshot) {
  if (Array.isArray(snapshot.historyDays)) {
    return snapshot.historyDays.map(normalizeHistoryDay).filter(Boolean);
  }
  return groupRecordsByDay(Array.isArray(snapshot.records) ? snapshot.records : []);
}

function normalizeHistoryDay(day) {
  if (!day || typeof day !== "object") return null;
  const items = dedupeFinalHistoryRecords(Array.isArray(day.items) ? day.items : []);
  const dateKey = typeof day.dateKey === "string" && day.dateKey ? day.dateKey : dateKeyFromRecord(items[0]);
  const label = typeof day.label === "string" && day.label ? day.label : labelFromDateKey(dateKey);
  const latestAt = typeof day.latestAt === "string" ? day.latestAt : latestRecordDate(items);
  const count = items.length;
  return { dateKey, label, latestAt, count, items };
}

function groupRecordsByDay(records) {
  const groups = new Map();
  for (const record of dedupeFinalHistoryRecords(records)) {
    const dateKey = dateKeyFromRecord(record);
    const group = groups.get(dateKey) ?? {
      dateKey,
      label: labelFromDateKey(dateKey),
      latestAt: "",
      count: 0,
      items: [],
    };
    group.count += 1;
    group.items.push(record);
    if (record.createdAt && record.createdAt > group.latestAt) group.latestAt = record.createdAt;
    groups.set(dateKey, group);
  }
  return [...groups.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

function historyDayNodes(days) {
  if (days.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("history.empty");
    return [empty];
  }
  return days.map((day, index) => {
    const item = document.createElement("article");
    item.className = "translation-day";

    const details = document.createElement("details");
    details.open = index === 0;

    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.textContent = day.label;
    const count = document.createElement("span");
    count.className = "translation-day-count";
    count.textContent = t("history.sentenceCount", { count: day.count });
    summary.append(label, count);

    const recordList = document.createElement("ol");
    recordList.className = "translation-record-list";
    recordList.replaceChildren(...day.items.map((record) => {
      const recordItem = document.createElement("li");
      const recordText = document.createElement("span");
      recordText.textContent = record.translatedText || "";
      recordItem.append(recordText);
      return recordItem;
    }));

    details.append(summary, recordList);
    item.append(details);
    return item;
  });
}

function countHistoryRecords(days, records) {
  if (days.length > 0) return days.reduce((total, day) => total + day.count, 0);
  return records.length;
}

function hasTranslatedText(record) {
  return typeof record?.translatedText === "string" && record.translatedText.trim().length > 0;
}

function dedupeFinalHistoryRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    if (!hasTranslatedText(record) || record.isFinal === false) return false;
    const text = record.translatedText.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
    const identity = Number.isSafeInteger(record.seq)
      ? `seq:${record.seq}`
      : `text:${record.targetLanguage ?? ""}:${record.speakerId ?? ""}:${text}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function dateKeyFromRecord(record) {
  if (typeof record?.createdAt !== "string") return "unknown";
  const time = Date.parse(record.createdAt);
  if (!Number.isFinite(time)) return "unknown";
  return formatHistoryDateKey(time);
}

function labelFromDateKey(dateKey) {
  return dateKey === "unknown" ? t("history.unknownDate") : dateKey;
}

function formatHistoryDateKey(time) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: HISTORY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return new Date(time).toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
}

function latestRecordDate(records) {
  return records.reduce((latest, record) => {
    if (typeof record.createdAt !== "string") return latest;
    return record.createdAt > latest ? record.createdAt : latest;
  }, "");
}

function topicNodes(topics) {
  if (topics.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("history.topicsEmpty");
    return [empty];
  }
  return topics.slice(0, 8).map((topic) => {
    const item = document.createElement("article");
    item.className = "topic-item";
    const title = document.createElement("strong");
    title.textContent = topic.topic;
    const count = document.createElement("span");
    count.textContent = t("history.sentenceCount", { count: topic.count });
    const latest = document.createElement("p");
    latest.textContent = topic.items?.[0]?.translatedText ?? "";
    item.append(title, count, latest);
    return item;
  });
}

function recorderStatusText(status) {
  if (state.settings.recordProvider === "none") return t("history.recorderOff");
  if (status?.lastError) return t("history.recorderFallback");
  return t("history.recorderReady");
}

async function clearSubtitleHistory() {
  try {
    const body = await fetch("/api/subtitles/history/clear", { method: "POST" }).then((res) => res.json());
    if (body.ok && body.data) renderHistory(body.data);
  } catch (error) {
    showError(error);
  }
}

function updateSessionSummary() {
  const input = form.elements.inputMode.selectedOptions[0]?.textContent ?? "";
  const languageNames = readTranslationLanguagesFromForm().map((language) => languageLabel(language));
  const languageSummary = languageNames.length >= 3
    ? languageNames.join(" · ")
    : `${languageNames[0]} ↔ ${languageNames[1]}`;
  sessionSummary.textContent = `${input} · ${languageSummary}`;
}

function updateServiceStrip() {
  const openAIStatus = state.hasOpenAIKey
    ? state.hasOpenAISecondaryKey && readTranslationLanguagesFromForm().length >= 3
      ? "OpenAI Realtime: ready · dual project"
      : "OpenAI Realtime: ready"
    : "OpenAI Realtime: key needed";
  const geminiStatus = state.hasGeminiKey ? "Gemini Live: ready" : "Gemini Live: key needed";
  const usesOpenAIVoice = state.settings.outputMode !== "captions" && state.settings.voiceProvider === "openai";
  const realtimeStatus = usesOpenAIVoice
    ? `${geminiStatus} · ${openAIStatus.replace("OpenAI Realtime", "OpenAI voice")}`
    : geminiStatus;
  const isRealtimeReady = state.hasGeminiKey && (!usesOpenAIVoice || state.hasOpenAIKey);
  setRealtimeApiStatus(realtimeStatus, isRealtimeReady ? "active" : "error");
  setTopicModelStatus(recorderStatusText(state.history.recorderStatus), state.history.recorderStatus?.lastError ? "error" : "active");
}

function languageLabel(language) {
  const entry = subtitleLanguageRegistry.find((candidate) => candidate.code === language);
  if (entry) return entry.label;
  if (language === "ko") return "Korean";
  if (language === "ja") return "Japanese";
  return "English";
}

function setRealtimeApiStatus(text, kind) {
  realtimeApiStatus.textContent = text;
  realtimeApiStatus.classList.toggle("active", kind === "active");
  realtimeApiStatus.classList.toggle("error", kind === "error");
}

function setTopicModelStatus(text, kind) {
  topicModelStatus.textContent = text;
  topicModelStatus.classList.toggle("active", kind === "active");
  topicModelStatus.classList.toggle("error", kind === "error");
}

function setConnectionStatus(text, kind) {
  connectionStatus.textContent = text;
  connectionStatus.classList.toggle("active", kind === "active");
  connectionStatus.classList.toggle("error", kind === "error");
}

function showError(error) {
  errorBox.hidden = false;
  errorBox.classList.remove("notice");
  errorBox.textContent = error.message || String(error);
  appendScreenPermissionAction(errorBox.textContent);
  setConnectionStatus(t("status.problem"), "error");
}

// macOS re-binds the screen-recording grant to each build's code signature, so
// every fresh install needs the user to re-enable it — give them a one-click path.
function appendScreenPermissionAction(message) {
  if (!/Screen & System Audio Recording/.test(message || "")) return;
  if (!window.realtimeNoelDesktop?.openScreenRecordingSettings) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary compact";
  button.textContent = t("error.openSystemSettings");
  button.addEventListener("click", () => {
    void window.realtimeNoelDesktop.openScreenRecordingSettings();
  });
  errorBox.append(" ", button);
}

function clearError() {
  errorBox.hidden = true;
  errorBox.classList.remove("notice");
  errorBox.textContent = "";
}

function showNotice(message) {
  errorBox.hidden = false;
  errorBox.classList.add("notice");
  errorBox.textContent = message;
  appendScreenPermissionAction(message);
}

function ensureWebSocketOpen() {
  if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    state.ws?.addEventListener("open", resolve, { once: true });
    state.ws?.addEventListener("error", () => reject(new Error(t("error.websocketClosed"))), { once: true });
  });
}

function syncLinkedControl(target) {
  if (target === form.elements.translationFontSizeRange) {
    form.elements.translationFontSize.value = target.value;
    keepSourceTwoPixelsSmaller();
  }
  if (target === form.elements.translationFontSize) {
    form.elements.translationFontSizeRange.value = target.value;
    keepSourceTwoPixelsSmaller();
  }
  if (target === form.elements.sourceFontSizeRange) {
    form.elements.sourceFontSize.value = target.value;
  }
  if (target === form.elements.sourceFontSize) {
    form.elements.sourceFontSizeRange.value = target.value;
  }
}

function syncCaptionPlayerController() {
  if (!captionPlayerController) return;
  const isVisible = state.running && state.settings.outputMode !== "audio";
  captionPlayerController.hidden = !isVisible;
  captionPlayerController.classList.toggle("active", isVisible);
  if (isVisible) restoreCaptionControllerPosition();
  if (controllerFontSize) {
    const size = readNumber(form.elements.translationFontSize?.value, state.settings.translationFontSize ?? DEFAULT_SUBTITLE.translationFontSize);
    controllerFontSize.textContent = `${Math.round(size)}px`;
  }
  const languages = readTranslationLanguagesFromForm();
  const positions = readSubtitlePositionsFromForm();
  const activePosition = positions[languages[0]] || state.settings.position || DEFAULT_SUBTITLE.position;
  for (const button of controllerPositionButtons) {
    button.classList.toggle("active", button.dataset.controllerPosition === activePosition);
  }
  if (controllerLanguagePreset) {
    controllerLanguagePreset.value = languages.join(",");
    if (controllerLanguagePreset.value !== languages.join(",")) controllerLanguagePreset.value = deriveLanguagePairFromTargets(languages).a + "," + deriveLanguagePairFromTargets(languages).b;
  }
  syncControllerOpacity();
}

function initCaptionControllerDrag() {
  if (!captionPlayerController || !controllerDragHandle) return;
  let drag = null;
  const startDrag = (event) => {
    if (captionPlayerController.hidden) return;
    const rect = captionPlayerController.getBoundingClientRect();
    drag = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    captionPlayerController.classList.add("dragging");
    controllerDragHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event) => {
    if (!drag) return;
    placeCaptionController(event.clientX - drag.offsetX, event.clientY - drag.offsetY, { persist: false });
  };
  const stopDrag = (event) => {
    if (!drag) return;
    drag = null;
    captionPlayerController.classList.remove("dragging");
    controllerDragHandle.releasePointerCapture?.(event.pointerId);
    persistCaptionControllerPosition();
  };
  controllerDragHandle.addEventListener("pointerdown", (event) => {
    startDrag(event);
  });
  controllerDragHandle.addEventListener("pointermove", moveDrag);
  controllerDragHandle.addEventListener("pointerup", stopDrag);
  controllerDragHandle.addEventListener("pointercancel", () => {
    drag = null;
    captionPlayerController.classList.remove("dragging");
  });
  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("pointerup", stopDrag);
  window.addEventListener("resize", () => {
    if (!captionPlayerController.hidden) persistCaptionControllerPosition();
  });
}

function restoreCaptionControllerPosition() {
  if (!captionPlayerController || captionPlayerController.dataset.positioned === "1") return;
  const saved = readStoredControllerPosition();
  if (saved) {
    placeCaptionController(saved.x, saved.y, { persist: false });
  } else {
    placeControllerNearSubtitle();
  }
  captionPlayerController.dataset.positioned = "1";
}

function placeControllerNearSubtitle() {
  if (!captionPlayerController) return;
  const position = state.settings.position || DEFAULT_SUBTITLE.position;
  const rect = captionPlayerController.getBoundingClientRect();
  const centerX = Math.max(12, Math.round((window.innerWidth - rect.width) / 2));
  let y = window.innerHeight - rect.height - 92;
  if (position === "top-center") y = 84;
  if (position === "middle-center") y = Math.round((window.innerHeight - rect.height) / 2) - 84;
  placeCaptionController(centerX, y, { persist: false });
}

function readStoredControllerPosition() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONTROLLER_POSITION_STORAGE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

function placeCaptionController(x, y, { persist = true } = {}) {
  if (!captionPlayerController) return;
  const rect = captionPlayerController.getBoundingClientRect();
  const maxX = Math.max(12, window.innerWidth - rect.width - 12);
  const maxY = Math.max(12, window.innerHeight - rect.height - 12);
  const nextX = Math.min(maxX, Math.max(12, Math.round(x)));
  const nextY = Math.min(maxY, Math.max(12, Math.round(y)));
  captionPlayerController.style.left = `${nextX}px`;
  captionPlayerController.style.top = `${nextY}px`;
  captionPlayerController.style.transform = "none";
  if (persist) localStorage.setItem(CONTROLLER_POSITION_STORAGE_KEY, JSON.stringify({ x: nextX, y: nextY }));
}

function persistCaptionControllerPosition() {
  if (!captionPlayerController) return;
  const rect = captionPlayerController.getBoundingClientRect();
  placeCaptionController(rect.left, rect.top);
}

async function persistControllerSubtitleSettings(message) {
  state.settings = readSettingsFromForm();
  applyPreviewSettings(state.settings);
  updateSessionSummary();
  try {
    await saveSettings({ subtitle: state.settings });
    showNotice(message);
  } catch (error) {
    showError(error);
  }
}

function adjustControllerFontSize(delta) {
  const current = readNumber(form.elements.translationFontSize.value, DEFAULT_SUBTITLE.translationFontSize);
  const next = Math.min(96, Math.max(14, Math.round(current + delta)));
  form.elements.translationFontSize.value = next;
  form.elements.translationFontSizeRange.value = next;
  keepSourceTwoPixelsSmaller();
  void persistControllerSubtitleSettings(t("notice.fontSizeSaved"));
}

function adjustControllerVerticalOffset(delta) {
  if (!form.elements.verticalOffset) return;
  const current = readNumber(form.elements.verticalOffset.value, DEFAULT_SUBTITLE.verticalOffset);
  const next = Math.min(600, Math.max(0, Math.round(current + delta)));
  form.elements.verticalOffset.value = next;
  updateVerticalOffsetValue(next);
  void persistControllerSubtitleSettings(t("notice.edgeOffsetSaved"));
}

function setControllerSubtitlePosition(position) {
  if (!SUBTITLE_POSITION_VALUES.includes(position)) return;
  for (const language of readTranslationLanguagesFromForm()) {
    const radio = form.querySelector(`input[name="pos-${language}"][value="${position}"]`);
    if (radio) radio.checked = true;
  }
  void persistControllerSubtitleSettings(t("notice.positionSaved"));
}

function applyControllerLanguagePreset(nextLanguages) {
  const languages = (Array.isArray(nextLanguages) ? nextLanguages : controllerLanguagePreset?.value.split(",") ?? [])
    .filter((language) => isSupportedLanguageCode(language));
  if (languages.length < 2) return;
  if (controllerLanguagePreset) controllerLanguagePreset.value = languages.join(",");
  writeTranslationLanguageCheckboxes(languages);
  syncPlacementRows(languages);
  state.settings = readSettingsFromForm();
  applyPreviewSettings(state.settings);
  updateSessionSummary();
  updateServiceStrip();
  saveSettings({ subtitle: state.settings })
    .then(() => {
      if (state.running) {
        reconfigureRunningSession();
        showNotice(t("notice.languagesSavedRebuilt"));
        return;
      }
      showNotice(t("notice.languagesSaved"));
    })
    .catch(showError);
}

function previewControllerOpacity() {
  if (!controllerOpacity) return;
  form.elements.opacity.value = controllerOpacity.value;
  state.settings = readSettingsFromForm();
  applyPreviewSettings(state.settings);
}

function persistControllerOpacity() {
  if (!controllerOpacity) return;
  setControllerOpacity(controllerOpacity.value);
}

function setControllerOpacity(value) {
  const opacity = Math.max(0.2, Math.min(1, readNumber(value, state.settings.opacity ?? DEFAULT_SUBTITLE.opacity)));
  form.elements.opacity.value = opacity;
  if (controllerOpacity) controllerOpacity.value = String(opacity);
  void persistControllerSubtitleSettings(t("notice.opacitySaved"));
}

function syncControllerOpacity() {
  if (!controllerOpacity) return;
  const opacity = readNumber(form.elements.opacity.value, state.settings.opacity ?? DEFAULT_SUBTITLE.opacity);
  controllerOpacity.value = String(opacity);
  if (controllerOpacityValue) controllerOpacityValue.textContent = `${Math.round(opacity * 100)}%`;
}

function keepSourceTwoPixelsSmaller() {
  const translationSize = readNumber(form.elements.translationFontSize.value, DEFAULT_SUBTITLE.translationFontSize);
  const sourceSize = Math.max(14, translationSize - 2);
  form.elements.sourceFontSize.value = sourceSize;
  form.elements.sourceFontSizeRange.value = sourceSize;
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function updateOpacityValue(value) {
  if (opacityValue) opacityValue.textContent = `${Math.round(Number(value) * 100)}%`;
  if (controllerOpacityValue) controllerOpacityValue.textContent = `${Math.round(Number(value) * 100)}%`;
}

function formatCaptureFailure(source, error) {
  const isDenied = error?.name === "NotAllowedError" || /permission denied|denied|not allowed/i.test(error?.message || "");
  // These name "NOVA" on purpose: build.productName is NOVA, so that is the
  // bundle name macOS shows in Privacy & Security and the instruction has to
  // match what the user actually sees in that list.
  const reason = error?.message || error;
  if (source === "system") {
    return isDenied ? t("error.systemAudioDenied") : t("error.systemAudioFailed", { reason });
  }
  return isDenied ? t("error.micDenied") : t("error.micFailed", { reason });
}

// ── Live Call host audio bridge ────────────────────────────────────────────
// Cloud Run only admits the desktop through the trusted non-browser path, so
// the MAIN process owns the gateway host socket. This renderer's only job is
// the microphone: once the call is live it captures 16 kHz mono PCM and
// forwards 40ms (1280-byte) frames over IPC.
const LIVE_BRIDGE_SAMPLE_RATE = 16_000;
const LIVE_BRIDGE_FRAME_SAMPLES = LIVE_BRIDGE_SAMPLE_RATE * 40 / 1_000;
let liveBridgeCapture = null;
let isLiveBridgeStarting = false;

function stopLiveCallAudioBridge(reason) {
  if (!liveBridgeCapture) return;
  const capture = liveBridgeCapture;
  liveBridgeCapture = null;
  try { capture.processor?.disconnect(); } catch { /* detached */ }
  try { capture.sourceNode?.disconnect(); } catch { /* detached */ }
  try { capture.stream?.getTracks().forEach((track) => track.stop()); } catch { /* stopped */ }
  try { void capture.audioContext?.close(); } catch { /* closed */ }
  console.info(`[live-bridge] mic capture stopped${reason ? ` (${reason})` : ""}`);
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const outputLength = Math.floor(input.length * toRate / fromRate);
  const output = new Float32Array(outputLength);
  const step = fromRate / toRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * step;
    const base = Math.floor(position);
    const fraction = position - base;
    const next = Math.min(base + 1, input.length - 1);
    output[index] = input[base] * (1 - fraction) + input[next] * fraction;
  }
  return output;
}

async function startLiveCallMicCapture() {
  const capture = { pcmQueue: new Float32Array(0) };
  liveBridgeCapture = capture;
  try {
    capture.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    capture.audioContext = new AudioContext({ sampleRate: LIVE_BRIDGE_SAMPLE_RATE });
    capture.sourceNode = capture.audioContext.createMediaStreamSource(capture.stream);
    capture.processor = capture.audioContext.createScriptProcessor(4096, 1, 1);
    capture.processor.onaudioprocess = (audioEvent) => {
      if (liveBridgeCapture !== capture) return;
      const captured = resampleLinear(
        audioEvent.inputBuffer.getChannelData(0),
        capture.audioContext.sampleRate,
        LIVE_BRIDGE_SAMPLE_RATE,
      );
      // Silent-mic detector: a live session where every frame is ~0 means the
      // OS handed us a muted/wrong device — the gateway then captions nothing
      // ("Audio Timeout"). Logged with the [live-bridge] prefix so the main
      // process mirrors it into the app log.
      let rmsEnergy = 0;
      for (let sampleIndex = 0; sampleIndex < captured.length; sampleIndex += 1) {
        rmsEnergy += captured[sampleIndex] * captured[sampleIndex];
      }
      capture.rmsSum = (capture.rmsSum ?? 0) + rmsEnergy;
      capture.rmsSamples = (capture.rmsSamples ?? 0) + captured.length;
      const rmsNow = Date.now();
      if (rmsNow - (capture.rmsLoggedAt ?? 0) >= 5_000 && capture.rmsSamples > 0) {
        const rms = Math.sqrt(capture.rmsSum / capture.rmsSamples);
        console.info(`[live-bridge] mic rms=${rms.toFixed(4)}${rms < 0.001 ? " — SILENT INPUT: check macOS mic permission and the selected input device" : ""}`);
        capture.rmsSum = 0;
        capture.rmsSamples = 0;
        capture.rmsLoggedAt = rmsNow;
      }
      const merged = new Float32Array(capture.pcmQueue.length + captured.length);
      merged.set(capture.pcmQueue);
      merged.set(captured, capture.pcmQueue.length);
      let offset = 0;
      while (merged.length - offset >= LIVE_BRIDGE_FRAME_SAMPLES) {
        const frame = new Int16Array(LIVE_BRIDGE_FRAME_SAMPLES);
        for (let index = 0; index < LIVE_BRIDGE_FRAME_SAMPLES; index += 1) {
          const sample = Math.max(-1, Math.min(1, merged[offset + index]));
          frame[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        window.realtimeNoelDesktop.sendLiveCallAudioFrame(frame.buffer);
        offset += LIVE_BRIDGE_FRAME_SAMPLES;
      }
      capture.pcmQueue = merged.slice(offset);
    };
    capture.sourceNode.connect(capture.processor);
    capture.processor.connect(capture.audioContext.destination);
    console.info("[live-bridge] host microphone is streaming to the gateway");
  } catch (error) {
    console.warn(`[live-bridge] microphone unavailable: ${error?.message ?? error}`);
    stopLiveCallAudioBridge("microphone unavailable");
  }
}

let hasAutoStartedCaptionsForLiveCall = false;

// Identity for the transcript record. A caption session started while a Live Call
// is live IS that meeting, so the record is anchored to the call's own start time
// and title -- that is what puts it on the records calendar. Captions started
// without a call stay a plain local session and never reach the calendar.
async function describeActiveMeeting() {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.getLiveCallState) return { kind: "local" };
  let liveState = null;
  try {
    liveState = await bridge.getLiveCallState();
  } catch {
    return { kind: "local" };
  }
  if (!liveState?.armed || !liveState.live) return { kind: "local" };
  return {
    kind: "live-call",
    liveSessionId: typeof liveState.sessionId === "string" ? liveState.sessionId : "",
    title: typeof liveState.title === "string" ? liveState.title : "",
    // Absent means the server falls back to its own clock rather than dropping
    // the record.
    startedAt: typeof liveState.liveStartedAt === "string" ? liveState.liveStartedAt : "",
  };
}

async function syncLiveCallAudioBridge() {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.getLiveCallState || !bridge.ensureLiveCallBridge) return;
  let liveState = null;
  try { liveState = await bridge.getLiveCallState(); } catch { return; }
  if (!liveState?.armed || !liveState.live) {
    if (liveBridgeCapture) stopLiveCallAudioBridge("live call ended");
    hasAutoStartedCaptionsForLiveCall = false;
    return;
  }
  // Going live should put the host straight into caption mode: start the
  // local subtitle engine once per call if it is not already running.
  if (!hasAutoStartedCaptionsForLiveCall) {
    hasAutoStartedCaptionsForLiveCall = true;
    if (!state.running) document.getElementById("start-subtitles")?.click();
  }
  if (isLiveBridgeStarting) return;
  isLiveBridgeStarting = true;
  try {
    const result = await bridge.ensureLiveCallBridge();
    if (!result?.ok) {
      console.warn(`[live-bridge] gateway bridge unavailable: ${result?.code ?? "unknown"}`);
      return;
    }
    // Capture starts once and keeps feeding frames; main drops them until the
    // gateway pipeline reports started.
    if (!liveBridgeCapture) await startLiveCallMicCapture();
  } finally {
    isLiveBridgeStarting = false;
  }
}

if (window.realtimeNoelDesktop?.ensureLiveCallBridge) {
  window.setInterval(() => { void syncLiveCallAudioBridge(); }, 3_000);
}

// ── Live Call participant captions → local subtitle system ────────────────
// The gateway mirrors every live caption to the desktop host socket and the
// main process forwards it over the live-call:caption IPC channel. Speak
// (participant) speech never passes through the local audio pipeline, so it
// is relayed into the server's live-call caption ingest — the overlay,
// preview, history, and session records then treat it exactly like a native
// line. Host speech is skipped: the local engine already captions it.
// ── UI language changes ───────────────────────────────────────────────────
// subtitle-workspace.js repaints every static data-i18n node; the dynamic
// panels this file renders have to be rebuilt from their current state.
subscribeToLanguage(() => {
  renderLanguagePills();
  renderPlacementRows();
  writeSettingsToForm(state.settings);
  renderLanguageChips();
  updatePtOutputControls();
  updateAudioInspectorLabels();
  updateSessionSummary();
  updateServiceStrip();
  renderHistory(state.history);
  renderRecordsCalendar();
  void loadSessionRecords();
});

if (window.realtimeNoelDesktop?.onLiveCallCaption) {
  window.realtimeNoelDesktop.onLiveCallCaption((caption) => {
    if (!caption || caption.speaker?.isParticipant !== true) return;
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    const text = String(caption.text ?? "").trim();
    if (!text) return;
    // Screen captions follow the subtitle policy exactly: only the
    // TRANSLATED direction renders (Korean input → English, English input →
    // Korean). The untranslated source lane (origin:"source") never reaches
    // the overlay — its FINALS are relayed record-only so the session record
    // keeps the 원문 alongside the translation.
    if (caption.origin === "source") {
      if (caption.isFinal !== true) return;
      state.ws.send(JSON.stringify({
        type: "subtitle:live-call-caption",
        recordOnly: true,
        partial: false,
        targetLanguage: String(caption.language ?? ""),
        sourceText: "",
        speaker: String(caption.speaker?.name ?? caption.speaker?.label ?? t("live.participant")),
        translatedText: text,
      }));
      return;
    }
    state.ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      partial: caption.isFinal !== true,
      targetLanguage: String(caption.language ?? ""),
      sourceText: "",
      speaker: String(caption.speaker?.name ?? caption.speaker?.label ?? t("live.participant")),
      speakerDepartment: String(caption.speaker?.department ?? ""),
      speakerJobTitle: String(caption.speaker?.jobTitle ?? ""),
      translatedText: text,
    }));
  });
}

// ── Session detail: language tabs + per-session export ───────────────────────
for (const tab of document.querySelectorAll("[data-transcript-lang]")) {
  tab.addEventListener("click", () => {
    openSessionDetail.language = tab.dataset.transcriptLang === "ko" ? "ko" : "en";
    renderOpenSessionTranscript();
  });
}

function exportSessionTranscript(session) {
  const rows = [["elapsed", "speaker", "source", "translation", "sourceLanguage", "targetLanguage"]];
  for (const line of openSessionDetail.lines) {
    const totalSeconds = Math.floor((line.elapsedMs ?? 0) / 1000);
    rows.push([
      `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`,
      line.speaker ?? "",
      line.sourceText ?? "",
      line.translatedText ?? "",
      line.sourceLanguage ?? "",
      line.targetLanguage ?? "",
    ]);
  }
  // Excel opens UTF-8 CSV correctly only with a BOM; without it Korean arrives
  // as mojibake.
  const csv = "\ufeff" + rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/gu, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const stamp = (session.startedAt ?? "").slice(0, 16).replace(/[:T]/gu, "-");
  link.download = `${(session.title || session.id).slice(0, 60)}-${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
