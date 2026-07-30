import {
  createSubtitleAudioPlayer,
  createTranslatedAudioGuard,
  shouldGateTranslatedAudioInput,
} from "./subtitle-audio-player.js";
import {
  CAPTION_AUDIO_PROCESSOR_BUFFER_SIZE,
  CAPTION_AUDIO_SAMPLE_RATE,
  captureMicrophoneStream,
  createCaptionAudioChunker,
  pcm16ArrayBufferToBase64,
} from "./subtitle-audio-capture.js";
import { buildMonthGrid, buildTimeGrid } from "./records-calendar.js";
// Every user-visible string in this file resolves through t(); subtitle-workspace.js
// owns restoring/persisting the choice and the declarative data-i18n pass.
import { getLanguage, subscribe as subscribeToLanguage, t } from "./subtitle-i18n.js";

const LOCAL_SERVER_DASHBOARD_URL = "http://127.0.0.1:3210/subtitle.html";
const HISTORY_TIME_ZONE = "Asia/Seoul";
const INPUT_SIGNAL_THRESHOLD = 0.035;
const INPUT_SILENCE_WARNING_MS = 5000;
const INPUT_STATUS_BROADCAST_MS = 1000;
const LIVE_TRANSLATION_STALL_MILLISECONDS = 2_000;
const LIVE_TRANSLATION_SIGNAL_GAP_MILLISECONDS = 250;
const CAPTURE_TIMEOUT_MS = 8000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 5_000;
const SUBTITLE_START_ACK_TIMEOUT_MS = 10_000;
const SUBTITLE_PREFLIGHT_ACK_TIMEOUT_MS = 2_000;
// Normal translated sentences can exceed three seconds. This cap prevents
// unbounded memory growth while preserving ordinary continuous speech.
const MAX_TRANSLATED_AUDIO_QUEUE_SECONDS = 30;
const DEFAULT_GLOSSARY_PRESET_ID = "default-cre-ai-en-ko";
const CUSTOM_GLOSSARY_PRESET_VALUE = "custom";
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
  model: "gemini-3.5-live-translate-preview",
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
  glossaryPresetId: DEFAULT_GLOSSARY_PRESET_ID,
  glossaryPresetName: "",
  verticalOffset: 48,
};

const state = {
  ws: null,
  settings: { ...DEFAULT_SUBTITLE },
  sessionId: null,
  streams: [],
  streamers: [],
  running: false,
  hasOpenAIKey: false,
  hasGeminiKey: false,
  hasGeminiSecondaryKey: false,
  previewStatusTimer: null,
  history: { records: [], topics: [], historyDays: [], recorderStatus: {} },
  audioMeters: new Map(),
};

const CAPTION_RUNTIME_TRANSITIONS = Object.freeze({
  idle: new Set(["starting"]),
  starting: new Set(["running", "stopping", "failed"]),
  running: new Set(["reconnecting", "stopping"]),
  reconnecting: new Set(["running", "stopping", "failed"]),
  stopping: new Set(["idle"]),
  failed: new Set(["idle", "starting", "reconnecting", "stopping"]),
});
let captionRuntimeState = "idle";
let liveTranslationReconnectPromise = null;
let captionWebSocketReconnectTimer = null;
let liveCaptionSocketRecoveryPromise = null;
let liveCaptionSocketRecoveryTimer = null;

function createLiveTranslationStallMonitor(
  onStall,
  stallMilliseconds = LIVE_TRANSLATION_STALL_MILLISECONDS,
  signalGapMilliseconds = LIVE_TRANSLATION_SIGNAL_GAP_MILLISECONDS,
) {
  const signalBySource = new Map();
  let signalWindowStartedAt = null;
  let lastSignalAt = null;
  let isRecoveryRequested = false;

  const suspend = () => {
    signalBySource.clear();
    signalWindowStartedAt = null;
    lastSignalAt = null;
  };

  return {
    noteInput(source, hasSignal, now, isEligible) {
      signalBySource.set(source, hasSignal === true);
      if (!isEligible) {
        suspend();
        return false;
      }
      if (![...signalBySource.values()].some(Boolean)) return false;
      if (lastSignalAt === null || now - lastSignalAt > signalGapMilliseconds) signalWindowStartedAt = now;
      lastSignalAt = now;
      if (isRecoveryRequested || signalWindowStartedAt === null || now - signalWindowStartedAt < stallMilliseconds) return false;
      isRecoveryRequested = true;
      onStall();
      return true;
    },
    noteOutput(now) {
      isRecoveryRequested = false;
      const hasSignal = [...signalBySource.values()].some(Boolean);
      signalWindowStartedAt = hasSignal ? now : null;
      lastSignalAt = hasSignal ? now : null;
    },
    suspend,
    reset() {
      suspend();
      isRecoveryRequested = false;
    },
  };
}

const liveTranslationStallMonitor = createLiveTranslationStallMonitor(() => {
  void reconnectLiveCallTranslation();
});

function transitionCaptionRuntime(nextState) {
  if (captionRuntimeState === nextState) return true;
  if (!CAPTION_RUNTIME_TRANSITIONS[captionRuntimeState]?.has(nextState)) {
    console.warn(`[subtitle-runtime] ignored invalid transition ${captionRuntimeState} -> ${nextState}`);
    return false;
  }
  captionRuntimeState = nextState;
  return true;
}

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
const opacityValue = document.getElementById("opacity-value");
const saveOpenAIKeyButton = document.getElementById("save-openai-key");
const openaiKeyStatus = document.getElementById("openai-key-status");
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
  if (event.target === openaiKeyInput || event.target === geminiKeyInput || event.target === geminiSecondaryKeyInput || event.target === glossaryPresetNameInput) return;
  if (event.target === form.elements.glossary
    || event.target === form.elements.translationDomain
    || event.target?.name === "translationLanguages") {
    markGlossaryPresetCustom();
  }
  const previousSettings = state.settings;
  syncLinkedControl(event.target);
  syncLanguageControls(event.target);
  syncAudioLanguageOptions(readTranslationLanguagesFromForm(), form.elements.audioLanguage?.value);
  state.settings = readSettingsFromForm();
  if (event.target?.name === "audioVolume") subtitleAudioPlayer.setVolume(state.settings.audioVolume);
  if (["outputMode", "audioLanguage", "translationLanguages"].includes(event.target?.name)
    && (previousSettings.outputMode !== state.settings.outputMode
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
const CHANNEL_REBUILD_CONTROLS = new Set(["translationLanguages", "outputMode", "audioLanguage"]);

form.addEventListener("change", (event) => {
  if (event.target === glossaryPresetNameInput) return;
  syncLanguageControls(event.target);
  syncAudioLanguageOptions(readTranslationLanguagesFromForm(), form.elements.audioLanguage?.value);
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
controllerRestartButton?.addEventListener("click", restartCaptionsFromController);
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

// Settings uses two peer panels instead of nesting operational controls inside
// an always-visible engine form. Switching is local-only and preserves every
// form value because both panels remain mounted.
const settingsViewTabs = [...document.querySelectorAll("[data-settings-view]")];
const settingsViewPanels = [...document.querySelectorAll("[data-settings-panel]")];

function activateSettingsView(view, { focus = false } = {}) {
  const selected = view === "advanced" ? "advanced" : "general";
  for (const tab of settingsViewTabs) {
    const isSelected = tab.dataset.settingsView === selected;
    tab.classList.toggle("is-selected", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    if (focus && isSelected) tab.focus();
  }
  for (const panel of settingsViewPanels) {
    panel.hidden = panel.dataset.settingsPanel !== selected;
  }
  if (selected === "advanced" && settingsDrawer) settingsDrawer.open = true;
}

for (const tab of settingsViewTabs) {
  tab.addEventListener("click", () => activateSettingsView(tab.dataset.settingsView));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = settingsViewTabs.indexOf(tab);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? settingsViewTabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + settingsViewTabs.length) % settingsViewTabs.length;
    activateSettingsView(settingsViewTabs[nextIndex]?.dataset.settingsView, { focus: true });
  });
}
activateSettingsView("general");
document.getElementById("manage-glossaries")?.addEventListener("click", () => activateSettingsView("advanced"));

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

// Built-ins remain local and deterministic; only user-created presets cross
// the authenticated Electron bridge. Keeping both sources in one native select
// preserves keyboard, screen-reader, and older-browser behaviour.
let glossaryPresets = [];
let syncedGlossaryPresets = [];
let builtInGlossaryPresetStatus = "pending";
let syncedGlossaryPresetStatus = "pending";
let editingCustomPreset = null;
let isGlossaryPresetBusy = false;
let isGlossaryDeleteConfirmationOpen = false;

const glossaryPresetSelect = form.elements.glossaryPreset;
const glossaryPresetEditor = document.getElementById("glossary-preset-editor");
const glossaryPresetNameInput = document.getElementById("glossary-preset-name");
const createGlossaryPresetButton = document.getElementById("create-glossary-preset");
const saveGlossaryPresetButton = document.getElementById("save-glossary-preset");
const cancelGlossaryPresetButton = document.getElementById("cancel-glossary-preset");
const updateGlossaryPresetButton = document.getElementById("update-glossary-preset");
const deleteGlossaryPresetButton = document.getElementById("delete-glossary-preset");
const confirmDeleteGlossaryPresetButton = document.getElementById("confirm-delete-glossary-preset");
const cancelDeleteGlossaryPresetButton = document.getElementById("cancel-delete-glossary-preset");
const glossaryPresetActions = document.querySelector(".glossary-preset-actions");
const glossaryPresetStatus = document.getElementById("glossary-preset-status");

const GLOSSARY_PRESET_ERROR_CODES = new Set([
  "HOST_LOGIN_REQUIRED",
  "NETWORK_UNAVAILABLE",
  "INVALID_GLOSSARY_PRESET",
  "GLOSSARY_PRESET_LIMIT_REACHED",
  "GLOSSARY_PRESET_NAME_CONFLICT",
  "GLOSSARY_PRESET_VERSION_CONFLICT",
  "GLOSSARY_PRESET_NOT_FOUND",
  "DESKTOP_BRIDGE_UNAVAILABLE",
]);

function glossaryPresetDisplayName(preset) {
  return String(preset?.name ?? preset?.label ?? "").trim();
}

function normalizeSyncedGlossaryPreset(value) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id ?? "").trim();
  const name = String(value.name ?? "").trim();
  const languageA = String(value.languagePair?.a ?? "").trim();
  const languageB = String(value.languagePair?.b ?? "").trim();
  const version = Number(value.version);
  if (!id || !name || !languageA || !languageB || !Number.isSafeInteger(version) || version < 1) return null;
  return {
    id,
    name,
    domain: String(value.domain ?? ""),
    glossary: String(value.glossary ?? ""),
    languagePair: { a: languageA, b: languageB },
    version,
    updatedAt: String(value.updatedAt ?? ""),
    source: "user",
  };
}

function findGlossaryPreset(presetId) {
  const builtIn = glossaryPresets.find((entry) => entry.id === presetId);
  if (builtIn) return { ...builtIn, source: "builtin" };
  return syncedGlossaryPresets.find((entry) => entry.id === presetId) ?? null;
}

function createGlossaryPresetOption(preset, source) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.dataset.source = source;
  option.dataset.name = glossaryPresetDisplayName(preset);
  option.textContent = source === "builtin" && preset.industry
    ? `${preset.label} — ${preset.industry}`
    : glossaryPresetDisplayName(preset);
  return option;
}

function appendCachedGlossaryPresetOption(presetId, presetName) {
  const group = document.getElementById("glossary-preset-users");
  if (!group || !presetId || !presetName) return null;
  const option = document.createElement("option");
  option.value = presetId;
  option.dataset.source = "cached";
  option.dataset.name = presetName;
  option.textContent = `${presetName} (${t("glossary.cachedSuffix")})`;
  group.append(option);
  return option;
}

function renderGlossaryPresetOptions({ persistConfirmedMissing = false } = {}) {
  if (!glossaryPresetSelect) return;
  const customOption = document.createElement("option");
  customOption.value = CUSTOM_GLOSSARY_PRESET_VALUE;
  customOption.textContent = t("glossary.presetCustom");

  const builtInGroup = document.createElement("optgroup");
  builtInGroup.id = "glossary-preset-builtins";
  builtInGroup.label = t("glossary.groupBuiltIn");
  for (const preset of glossaryPresets) builtInGroup.append(createGlossaryPresetOption(preset, "builtin"));

  const userGroup = document.createElement("optgroup");
  userGroup.id = "glossary-preset-users";
  userGroup.label = t("glossary.groupSynced");
  for (const preset of syncedGlossaryPresets) userGroup.append(createGlossaryPresetOption(preset, "user"));
  glossaryPresetSelect.replaceChildren(customOption, builtInGroup, userGroup);
  restoreGlossaryPresetSelection(
    state.settings?.glossaryPresetId,
    state.settings?.glossaryPresetName,
    { persistConfirmedMissing },
  );
}

function selectedGlossaryPresetId() {
  const value = glossaryPresetSelect?.value ?? CUSTOM_GLOSSARY_PRESET_VALUE;
  return value === CUSTOM_GLOSSARY_PRESET_VALUE ? "" : value;
}

function selectedGlossaryPresetName() {
  const option = glossaryPresetSelect?.selectedOptions?.[0];
  return option?.dataset?.source === "user" || option?.dataset?.source === "cached"
    ? String(option.dataset.name ?? "")
    : "";
}

function selectedEditableGlossaryPreset() {
  if (editingCustomPreset) return editingCustomPreset;
  return syncedGlossaryPresets.find((preset) => preset.id === selectedGlossaryPresetId()) ?? null;
}

function syncGlossaryPresetActions() {
  const editablePreset = selectedEditableGlossaryPreset();
  const canEdit = Boolean(editablePreset && Number.isSafeInteger(editablePreset.version));
  if (updateGlossaryPresetButton) {
    updateGlossaryPresetButton.hidden = !canEdit || isGlossaryDeleteConfirmationOpen;
    updateGlossaryPresetButton.disabled = isGlossaryPresetBusy;
  }
  if (deleteGlossaryPresetButton) {
    deleteGlossaryPresetButton.hidden = !canEdit || isGlossaryDeleteConfirmationOpen;
    deleteGlossaryPresetButton.disabled = isGlossaryPresetBusy;
  }
  if (confirmDeleteGlossaryPresetButton) {
    confirmDeleteGlossaryPresetButton.hidden = !canEdit || !isGlossaryDeleteConfirmationOpen;
    confirmDeleteGlossaryPresetButton.disabled = isGlossaryPresetBusy;
  }
  if (cancelDeleteGlossaryPresetButton) {
    cancelDeleteGlossaryPresetButton.hidden = !canEdit || !isGlossaryDeleteConfirmationOpen;
    cancelDeleteGlossaryPresetButton.disabled = isGlossaryPresetBusy;
  }
}

function openGlossaryPresetDeleteConfirmation() {
  const current = selectedEditableGlossaryPreset();
  if (!current || isGlossaryPresetBusy) return;
  isGlossaryDeleteConfirmationOpen = true;
  setGlossaryPresetStatus(t("glossary.deleteConfirm", { name: current.name }));
  syncGlossaryPresetActions();
  confirmDeleteGlossaryPresetButton?.focus();
}

function closeGlossaryPresetDeleteConfirmation({ restoreFocus = true, clearStatus = true } = {}) {
  if (!isGlossaryDeleteConfirmationOpen) return;
  isGlossaryDeleteConfirmationOpen = false;
  syncGlossaryPresetActions();
  if (clearStatus) setGlossaryPresetStatus();
  if (restoreFocus && !deleteGlossaryPresetButton?.hidden) deleteGlossaryPresetButton.focus();
}

function setGlossaryPresetStatus(message = "", kind = "") {
  if (!glossaryPresetStatus) return;
  glossaryPresetStatus.textContent = message;
  glossaryPresetStatus.classList.toggle("is-error", kind === "error");
}

function persistMissingGlossaryPresetReference() {
  if (!state.settings?.glossaryPresetId && !state.settings?.glossaryPresetName) return;
  state.settings = { ...state.settings, glossaryPresetId: "", glossaryPresetName: "" };
  void saveSettings({ subtitle: state.settings }).catch(showError);
}

function restoreGlossaryPresetSelection(presetId, presetName = "", { persistConfirmedMissing = false } = {}) {
  if (!glossaryPresetSelect) return;
  const requestedId = String(presetId ?? "").trim();
  const requestedName = String(presetName ?? "").trim();
  if (!requestedId) {
    glossaryPresetSelect.value = CUSTOM_GLOSSARY_PRESET_VALUE;
    syncGlossaryPresetActions();
    return;
  }

  let option = [...glossaryPresetSelect.options].find((entry) => entry.value === requestedId);
  const isConfirmedMissingUserPreset = Boolean(requestedName) && syncedGlossaryPresetStatus === "loaded";
  const isConfirmedMissingBuiltInPreset = !requestedName && builtInGlossaryPresetStatus === "loaded";
  if (!option && requestedName && !isConfirmedMissingUserPreset) {
    option = appendCachedGlossaryPresetOption(requestedId, requestedName);
  }
  if (option) {
    glossaryPresetSelect.value = requestedId;
    syncGlossaryPresetActions();
    return;
  }

  glossaryPresetSelect.value = CUSTOM_GLOSSARY_PRESET_VALUE;
  if ((isConfirmedMissingUserPreset || isConfirmedMissingBuiltInPreset) && persistConfirmedMissing) {
    editingCustomPreset = null;
    setGlossaryPresetStatus(t("glossary.remoteMissing"), "error");
    persistMissingGlossaryPresetReference();
  }
  syncGlossaryPresetActions();
}

function markGlossaryPresetCustom() {
  const selectedUserPreset = syncedGlossaryPresets.find((preset) => preset.id === selectedGlossaryPresetId());
  if (selectedUserPreset) editingCustomPreset = selectedUserPreset;
  if (glossaryPresetSelect) glossaryPresetSelect.value = CUSTOM_GLOSSARY_PRESET_VALUE;
  state.settings = { ...state.settings, glossaryPresetId: "", glossaryPresetName: "" };
  syncGlossaryPresetActions();
}

function glossaryPresetError(value, fallbackCode = "INVALID_GLOSSARY_PRESET") {
  const code = String(value?.code ?? "").trim();
  const resolvedCode = GLOSSARY_PRESET_ERROR_CODES.has(code) ? code : fallbackCode;
  const error = new Error(t(`glossary.error.${resolvedCode}`));
  error.code = resolvedCode;
  return error;
}

async function invokeGlossaryPresetBridge(method, input) {
  const bridge = window.realtimeNoelDesktop;
  if (typeof bridge?.[method] !== "function") throw glossaryPresetError({ code: "DESKTOP_BRIDGE_UNAVAILABLE" });
  let result;
  try {
    result = input === undefined ? await bridge[method]() : await bridge[method](input);
  } catch (error) {
    throw glossaryPresetError(error, "NETWORK_UNAVAILABLE");
  }
  if (!result?.ok) throw glossaryPresetError(result);
  return result.data;
}

async function hydrateGlossaryPresets() {
  if (!glossaryPresetSelect) return;
  setGlossaryPresetStatus(t("glossary.loadingSynced"));
  const builtInRequest = fetch("/api/glossary-presets").then((response) => {
    if (!response.ok) throw new Error("BUILTIN_GLOSSARY_PRESETS_UNAVAILABLE");
    return response.json();
  });
  const syncedRequest = typeof window.realtimeNoelDesktop?.listGlossaryPresets === "function"
    ? invokeGlossaryPresetBridge("listGlossaryPresets")
    : Promise.reject(glossaryPresetError({ code: "DESKTOP_BRIDGE_UNAVAILABLE" }));
  const [builtInResult, syncedResult] = await Promise.allSettled([builtInRequest, syncedRequest]);

  if (builtInResult.status === "fulfilled" && Array.isArray(builtInResult.value)) {
    glossaryPresets = builtInResult.value;
    builtInGlossaryPresetStatus = "loaded";
  } else {
    builtInGlossaryPresetStatus = "unavailable";
  }

  if (syncedResult.status === "fulfilled" && Array.isArray(syncedResult.value?.presets)) {
    syncedGlossaryPresets = syncedResult.value.presets.map(normalizeSyncedGlossaryPreset).filter(Boolean);
    syncedGlossaryPresetStatus = "loaded";
    setGlossaryPresetStatus();
  } else {
    syncedGlossaryPresetStatus = "unavailable";
    const error = syncedResult.status === "rejected"
      ? glossaryPresetError(syncedResult.reason, "NETWORK_UNAVAILABLE")
      : glossaryPresetError({ code: "INVALID_GLOSSARY_PRESET" });
    setGlossaryPresetStatus(error.message, "error");
  }
  renderGlossaryPresetOptions({ persistConfirmedMissing: true });
}

void hydrateGlossaryPresets();
glossaryPresetSelect?.addEventListener("change", (event) => {
  event.stopPropagation();
  closeGlossaryPresetDeleteConfirmation({ restoreFocus: false });
  editingCustomPreset = null;
  if (event.target.value === CUSTOM_GLOSSARY_PRESET_VALUE) {
    state.settings = readSettingsFromForm();
    syncGlossaryPresetActions();
    void saveSettings({ subtitle: state.settings }).catch(showError);
    return;
  }
  void applyGlossaryPreset(event.target.value);
});

async function applyGlossaryPreset(presetId) {
  const preset = findGlossaryPreset(presetId);
  if (!preset) return;
  closeGlossaryPresetDeleteConfirmation({ restoreFocus: false });
  editingCustomPreset = null;
  if (form.elements.glossary) form.elements.glossary.value = preset.glossary;
  if (form.elements.translationDomain) form.elements.translationDomain.value = preset.domain;
  writeTranslationLanguageCheckboxes([preset.languagePair.a, preset.languagePair.b]);
  syncPlacementRows([preset.languagePair.a, preset.languagePair.b]);
  markLanguageMinimum();
  state.settings = readSettingsFromForm();
  applyPreviewSettings(state.settings);
  updateAudioInspectorLabels();
  syncGlossaryPresetActions();
  try {
    await saveSettings({ subtitle: state.settings });
    const label = glossaryPresetDisplayName(preset);
    if (state.running) {
      // A running session keeps translating with the OLD glossary until its
      // channels are rebuilt — reconfigure in place (audio capture untouched).
      reconfigureRunningSession();
      showNotice(t("notice.presetAppliedRebuilt", { label }));
    } else {
      showNotice(t("notice.presetApplied", { label }));
    }
  } catch (error) {
    showError(error);
  }
}

function currentGlossaryPresetInput(name) {
  const languages = readTranslationLanguagesFromForm();
  return {
    name: String(name ?? "").trim(),
    domain: form.elements.translationDomain?.value ?? "",
    glossary: form.elements.glossary?.value ?? "",
    languagePair: deriveLanguagePairFromTargets(languages),
  };
}

function setGlossaryPresetBusy(isBusy) {
  isGlossaryPresetBusy = isBusy;
  glossaryPresetEditor?.setAttribute("aria-busy", String(isBusy));
  if (saveGlossaryPresetButton) saveGlossaryPresetButton.disabled = isBusy;
  if (createGlossaryPresetButton) createGlossaryPresetButton.disabled = isBusy;
  syncGlossaryPresetActions();
}

function openGlossaryPresetEditor() {
  if (!glossaryPresetEditor || !createGlossaryPresetButton) return;
  closeGlossaryPresetDeleteConfirmation({ restoreFocus: false });
  glossaryPresetEditor.hidden = false;
  createGlossaryPresetButton.setAttribute("aria-expanded", "true");
  if (glossaryPresetNameInput) {
    glossaryPresetNameInput.value = "";
    glossaryPresetNameInput.focus();
  }
}

function closeGlossaryPresetEditor({ restoreFocus = true } = {}) {
  if (!glossaryPresetEditor || !createGlossaryPresetButton) return;
  glossaryPresetEditor.hidden = true;
  createGlossaryPresetButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) createGlossaryPresetButton.focus();
}

async function registerGlossaryPreset() {
  if (!glossaryPresetNameInput?.reportValidity()) return;
  setGlossaryPresetBusy(true);
  try {
    const data = await invokeGlossaryPresetBridge(
      "createGlossaryPreset",
      currentGlossaryPresetInput(glossaryPresetNameInput.value),
    );
    const preset = normalizeSyncedGlossaryPreset(data?.preset);
    if (!preset) throw glossaryPresetError({ code: "INVALID_GLOSSARY_PRESET" });
    syncedGlossaryPresets = [...syncedGlossaryPresets.filter((entry) => entry.id !== preset.id), preset];
    syncedGlossaryPresetStatus = "loaded";
    closeGlossaryPresetDeleteConfirmation({ restoreFocus: false });
    editingCustomPreset = null;
    state.settings = { ...state.settings, glossaryPresetId: preset.id, glossaryPresetName: preset.name };
    renderGlossaryPresetOptions();
    state.settings = readSettingsFromForm();
    await saveSettings({ subtitle: state.settings });
    closeGlossaryPresetEditor({ restoreFocus: false });
    setGlossaryPresetStatus(t("glossary.created", { name: preset.name }));
  } catch (error) {
    const resolvedError = glossaryPresetError(error);
    setGlossaryPresetStatus(resolvedError.message, "error");
    showError(resolvedError);
  } finally {
    setGlossaryPresetBusy(false);
    if (glossaryPresetEditor?.hidden) createGlossaryPresetButton?.focus();
  }
}

async function updateSelectedGlossaryPreset() {
  const current = selectedEditableGlossaryPreset();
  if (!current) return;
  setGlossaryPresetBusy(true);
  try {
    const data = await invokeGlossaryPresetBridge("updateGlossaryPreset", {
      id: current.id,
      version: current.version,
      ...currentGlossaryPresetInput(current.name),
    });
    const preset = normalizeSyncedGlossaryPreset(data?.preset);
    if (!preset) throw glossaryPresetError({ code: "INVALID_GLOSSARY_PRESET" });
    syncedGlossaryPresets = [...syncedGlossaryPresets.filter((entry) => entry.id !== preset.id), preset];
    closeGlossaryPresetDeleteConfirmation({ restoreFocus: false });
    editingCustomPreset = null;
    state.settings = { ...state.settings, glossaryPresetId: preset.id, glossaryPresetName: preset.name };
    renderGlossaryPresetOptions();
    state.settings = readSettingsFromForm();
    await saveSettings({ subtitle: state.settings });
    setGlossaryPresetStatus(t("glossary.updated", { name: preset.name }));
  } catch (error) {
    const resolvedError = glossaryPresetError(error);
    setGlossaryPresetStatus(resolvedError.message, "error");
    showError(resolvedError);
  } finally {
    setGlossaryPresetBusy(false);
  }
}

async function deleteSelectedGlossaryPreset() {
  const current = selectedEditableGlossaryPreset();
  if (!current || !isGlossaryDeleteConfirmationOpen) return;
  let wasDeleted = false;
  setGlossaryPresetBusy(true);
  try {
    await invokeGlossaryPresetBridge("deleteGlossaryPreset", { id: current.id, version: current.version });
    syncedGlossaryPresets = syncedGlossaryPresets.filter((entry) => entry.id !== current.id);
    closeGlossaryPresetDeleteConfirmation({ restoreFocus: false, clearStatus: false });
    editingCustomPreset = null;
    state.settings = { ...state.settings, glossaryPresetId: "", glossaryPresetName: "" };
    renderGlossaryPresetOptions();
    state.settings = readSettingsFromForm();
    await saveSettings({ subtitle: state.settings });
    setGlossaryPresetStatus(t("glossary.deleted"));
    wasDeleted = true;
  } catch (error) {
    const resolvedError = glossaryPresetError(error);
    setGlossaryPresetStatus(resolvedError.message, "error");
    showError(resolvedError);
  } finally {
    setGlossaryPresetBusy(false);
    if (wasDeleted) glossaryPresetSelect?.focus();
  }
}

createGlossaryPresetButton?.addEventListener("click", openGlossaryPresetEditor);
cancelGlossaryPresetButton?.addEventListener("click", closeGlossaryPresetEditor);
saveGlossaryPresetButton?.addEventListener("click", () => { void registerGlossaryPreset(); });
updateGlossaryPresetButton?.addEventListener("click", () => { void updateSelectedGlossaryPreset(); });
deleteGlossaryPresetButton?.addEventListener("click", openGlossaryPresetDeleteConfirmation);
confirmDeleteGlossaryPresetButton?.addEventListener("click", () => { void deleteSelectedGlossaryPreset(); });
cancelDeleteGlossaryPresetButton?.addEventListener("click", () => closeGlossaryPresetDeleteConfirmation());
glossaryPresetActions?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !isGlossaryDeleteConfirmationOpen) return;
  event.preventDefault();
  closeGlossaryPresetDeleteConfirmation();
});

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
    const shouldNormalizeGeminiProviders = config.settings?.subtitle
      && (config.settings.subtitle.translationProvider !== "gemini"
        || config.settings.subtitle.voiceProvider !== "gemini");
    if (config.settings?.subtitle) {
      state.settings = {
        ...DEFAULT_SUBTITLE,
        ...config.settings.subtitle,
        translationProvider: "gemini",
        voiceProvider: "gemini",
      };
    }
    state.hasOpenAIKey = Boolean(config.settings?.hasOpenAIKey);
    state.hasGeminiKey = Boolean(config.settings?.hasGeminiKey);
    state.hasGeminiSecondaryKey = Boolean(config.settings?.hasGeminiSecondaryKey);
    writeSettingsToForm(state.settings);
    await hydrateOverlayEnabled();
    applyPreviewSettings(state.settings);
    updateOpenAIKeyPlaceholder();
    updateGeminiKeyStatus();
    updateGeminiSecondaryKeyStatus();
    updateOpenAIKeyStatus();
    updateSessionSummary();
    updateServiceStrip();
    updateAudioInspectorLabels();
    syncCaptionPlayerController();
    if (shouldNormalizeGeminiProviders) await saveSettings({ subtitle: state.settings });
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
  if (playbackOptions) playbackOptions.hidden = outputMode === "captions";
  if (audioVolumeValue) audioVolumeValue.textContent = `${Math.round(readNumber(form.elements.audioVolume?.value, DEFAULT_SUBTITLE.audioVolume) * 100)}%`;
  startButton.dataset.i18n = outputMode === "audio"
    ? "start.audio"
    : "start.captions";
  startButton.textContent = t(startButton.dataset.i18n);
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
    participants: document.getElementById("session-detail-participants"),
    generate: document.getElementById("session-detail-generate-summary"),
    audio: document.getElementById("session-detail-audio"),
    exportButton: document.getElementById("session-detail-export"),
    tabs: [...document.querySelectorAll("[data-transcript-lang]")],
    viewTabs: [...document.querySelectorAll("[data-record-detail-tab]")],
    viewPanels: [...document.querySelectorAll("[data-record-detail-panel]")],
  };
}

// Held so a language tab re-renders from what is already loaded instead of
// refetching the whole transcript.
const openSessionDetail = { id: "", lines: [], participants: [], language: "en", view: "summary" };

function activateSessionDetailView(view, { focus = false } = {}) {
  const els = sessionDetailElements();
  const available = new Set(["summary", "transcript", "participants"]);
  openSessionDetail.view = available.has(view) ? view : "summary";
  for (const tab of els.viewTabs) {
    const isSelected = tab.dataset.recordDetailTab === openSessionDetail.view;
    tab.classList.toggle("is-selected", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    if (focus && isSelected) tab.focus();
  }
  for (const panel of els.viewPanels) {
    panel.hidden = panel.dataset.recordDetailPanel !== openSessionDetail.view;
  }
}

function renderOpenSessionTranscript() {
  const els = sessionDetailElements();
  if (!els.transcript) return;
  renderSessionTranscript(els.transcript, openSessionDetail.lines, openSessionDetail.language);
  for (const tab of els.tabs) {
    const isSelected = tab.dataset.transcriptLang === openSessionDetail.language;
    tab.classList.toggle("is-selected", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  }
  els.transcript.setAttribute("aria-labelledby", `session-transcript-tab-${openSessionDetail.language}`);
}

function stableParticipantColor(identity) {
  let hash = 0;
  for (const character of String(identity ?? "")) hash = ((hash << 5) - hash + character.codePointAt(0)) | 0;
  return Math.abs(hash) % 5 + 1;
}

function participantName(participant, index) {
  if (typeof participant === "string") return participant.trim() || `${t("live.participant")} ${index + 1}`;
  return String(participant?.displayName ?? participant?.name ?? participant?.label ?? "").trim()
    || `${t("live.participant")} ${index + 1}`;
}

function renderSessionParticipants(container, participants) {
  container.replaceChildren();
  if (!participants.length) {
    const empty = document.createElement("p");
    empty.textContent = `${t("live.participant")} · 0`;
    container.append(empty);
    return;
  }
  participants.forEach((participant, index) => {
    const name = participantName(participant, index);
    const identity = typeof participant === "string"
      ? participant
      : participant?.participantId ?? participant?.speakerId ?? participant?.id ?? name;
    const row = document.createElement("div");
    row.className = "session-detail-participant";
    const avatar = document.createElement("span");
    avatar.className = `session-detail-participant-avatar color-${stableParticipantColor(identity)}`;
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = Array.from(name)[0]?.toUpperCase() ?? "";
    const copy = document.createElement("div");
    copy.className = "session-detail-participant-copy";
    const heading = document.createElement("strong");
    heading.textContent = name;
    copy.append(heading);
    if (participant && typeof participant === "object") {
      const meta = [participant.department, participant.jobTitle].map((value) => String(value ?? "").trim()).filter(Boolean);
      if (meta.length) {
        const detail = document.createElement("span");
        detail.textContent = meta.join(" · ");
        copy.append(detail);
      }
    }
    row.append(avatar, copy);
    container.append(row);
  });
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
    openSessionDetail.participants = Array.isArray(detail.participants)
      ? detail.participants
      : (Array.isArray(meta.participants) ? meta.participants : []);
    // Open on whichever language the record actually has, so a KO-only session
    // does not land on an empty EN tab.
    const hasEnglish = openSessionDetail.lines.some((line) => transcriptTextForLanguage(line, "en"));
    openSessionDetail.language = hasEnglish ? "en" : "ko";
    renderOpenSessionTranscript();
    renderSessionParticipants(els.participants, openSessionDetail.participants);
    activateSessionDetailView("summary");
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
  if (state.ws?.readyState === WebSocket.OPEN || state.ws?.readyState === WebSocket.CONNECTING) return state.ws;
  window.clearTimeout(captionWebSocketReconnectTimer);
  captionWebSocketReconnectTimer = null;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setConnectionStatus(t("status.captionsReady"), "active");
    if (activeCaptionSessionOwner === "live-call" && state.running) void recoverLiveCaptionSocket();
  });
  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    clearTranslatedAudioQueue();
    state.ws = null;
    captionWebSocketReconnectTimer = window.setTimeout(connectWebSocket, 1_000);
    if (liveBridgePreflightRequestId) {
      setConnectionStatus(t("status.reconnecting"), "active");
      return;
    }
    if (activeCaptionSessionOwner === "live-call" && state.running) {
      transitionCaptionRuntime("reconnecting");
      setConnectionStatus(t("status.reconnecting"), "active");
      setRealtimeApiStatus(t("status.realtimeReconnecting"), "active");
      return;
    }
    setConnectionStatus(t("status.disconnected"), "error");
    void stopSubtitles();
  });
  ws.addEventListener("error", () => setConnectionStatus(t("status.checkConnection"), "error"));
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "settings" && message.settings?.subtitle) {
      state.settings = { ...DEFAULT_SUBTITLE, ...message.settings.subtitle };
      state.hasOpenAIKey = Boolean(message.settings.hasOpenAIKey);
      state.hasGeminiKey = Boolean(message.settings.hasGeminiKey);
      state.hasGeminiSecondaryKey = Boolean(message.settings.hasGeminiSecondaryKey);
      writeSettingsToForm(state.settings);
      applyPreviewSettings(state.settings);
      updateOpenAIKeyPlaceholder();
      updateOpenAIKeyStatus();
      updateGeminiKeyStatus();
      updateGeminiSecondaryKeyStatus();
      updateSessionSummary();
      updateServiceStrip();
      updateAudioInspectorLabels();
    }
    if (message.type === "subtitle:status") {
      if (message.status === "idle") clearActiveSubtitleSurface();
      if (message.status === "connecting") {
        if (activeCaptionSessionOwner === "live-call" && state.running) transitionCaptionRuntime("reconnecting");
        setConnectionStatus(t("status.serviceConnecting"), "active");
      }
      else if (message.status === "api_ready") {
        if (captionRuntimeState === "reconnecting") transitionCaptionRuntime("running");
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
      if (activeCaptionSessionOwner === "live-call" && String(message.translatedText ?? "").trim()) {
        liveTranslationStallMonitor.noteOutput(performance.now());
      }
      setPreviewText(message.translatedText, message.sourceText, true);
      return;
    }
    if (message.type === "subtitle:committed" && state.settings.outputMode !== "audio") {
      if (activeCaptionSessionOwner === "live-call" && String(message.translatedText ?? "").trim()) {
        liveTranslationStallMonitor.noteOutput(performance.now());
      }
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
      void handleSubtitleRuntimeError(message);
    }
  });
  return ws;
}

async function recoverLiveCaptionSocket() {
  if (liveCaptionSocketRecoveryPromise) return liveCaptionSocketRecoveryPromise;
  if (activeCaptionSessionOwner !== "live-call" || !state.running || !state.sessionId) return false;
  const sessionId = state.sessionId;
  liveCaptionSocketRecoveryPromise = (async () => {
    transitionCaptionRuntime("reconnecting");
    const liveState = await window.realtimeNoelDesktop?.getLiveCallState?.();
    if (!liveState?.armed || !liveState.live) return false;
    await requestSubtitleStart({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId,
      settings: state.settings,
      meeting: {
        kind: "live-call",
        liveSessionId: String(liveState.sessionId ?? ""),
        title: String(liveState.title ?? ""),
        startedAt: String(liveState.liveStartedAt ?? ""),
      },
    });
    if (state.sessionId !== sessionId || activeCaptionSessionOwner !== "live-call") return false;
    for (const caption of liveState.captionSnapshot ?? []) {
      enqueueLiveCallCaptionRelay(caption);
    }
    transitionCaptionRuntime("running");
    setConnectionStatus(t("status.receivingCaptions"), "active");
    setRealtimeApiStatus(t("status.realtimeConnected"), "active");
    flushLiveCallCaptionRelayQueue();
    return true;
  })().catch((error) => {
    console.warn(`[live-bridge] local caption socket recovery failed: ${error?.message ?? error}`);
    window.clearTimeout(liveCaptionSocketRecoveryTimer);
    liveCaptionSocketRecoveryTimer = window.setTimeout(() => { void recoverLiveCaptionSocket(); }, 1_000);
    return false;
  }).finally(() => {
    liveCaptionSocketRecoveryPromise = null;
  });
  return liveCaptionSocketRecoveryPromise;
}

function requestSubtitleStart(payload) {
  const socket = state.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(t("error.websocketClosed")));
  }
  const expectedProducer = payload.captionProducer === "gateway" ? "gateway" : "local";
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, acknowledgement) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve(acknowledgement);
    };
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "subtitle:started") {
        if (message.sessionId !== payload.sessionId) return;
        if (message.captionProducer !== expectedProducer) return;
        finish(null, message);
        return;
      }
      if (message.type === "subtitle:error" && message.code === "SUBTITLE_START_FAILED") {
        if (message.sessionId && message.sessionId !== payload.sessionId) return;
        if (message.captionProducer && message.captionProducer !== expectedProducer) return;
        finish(new Error(message.message || t("error.subtitleStartFailed")));
      }
    };
    const onClose = () => finish(new Error(t("error.websocketClosed")));
    const timer = window.setTimeout(
      () => finish(new Error(t("error.subtitleStartTimeout"))),
      SUBTITLE_START_ACK_TIMEOUT_MS,
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.send(JSON.stringify(payload));
  });
}

async function handleSubtitleRuntimeError(message) {
  // Initial-start errors are owned by requestSubtitleStart, which rejects the
  // matching promise and lets that start path release its own capture exactly once.
  if (captionRuntimeState === "starting") return;
  if (liveBridgePreflightRequestId && message.code === "SUBTITLE_PREFLIGHT_FAILED") return;
  if (activeCaptionSessionOwner === "live-call" && state.running) {
    transitionCaptionRuntime("reconnecting");
    setConnectionStatus(t("status.reconnecting"), "active");
    setRealtimeApiStatus(t("status.realtimeReconnecting"), "active");
    await reconnectLiveCallTranslation();
    return;
  }
  await stopSubtitles();
  showError(new Error(message.message));
}

async function startSubtitles() {
  if (state.running || captionRuntimeState === "starting" || captionRuntimeState === "stopping") return;
  if (captionRuntimeState === "failed") transitionCaptionRuntime("idle");
  transitionCaptionRuntime("starting");
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
    if (geminiKeyInput?.value.trim()) apiKeysPatch.gemini = geminiKeyInput.value.trim();
    if (geminiSecondaryKeyInput?.value.trim()) apiKeysPatch.geminiSecondary = geminiSecondaryKeyInput.value.trim();
    if (Object.keys(apiKeysPatch).length > 0) patch.apiKeys = apiKeysPatch;
    if (!state.hasGeminiKey && !geminiKeyInput?.value.trim()) {
      throw new Error(t("key.geminiRequired"));
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
    await requestSubtitleStart({
      type: "subtitle:start",
      sessionId: state.sessionId,
      settings: state.settings,
      meeting: await describeActiveMeeting(),
    });
    if (state.settings.outputMode !== "audio") setPreviewStatus(t("status.waitingForCaptions"), 1800);

    for (const capture of captures) {
      const streamer = await createAudioStreamer(capture.stream, capture.source, capture.label, (packet) => {
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
            audio: pcm16ArrayBufferToBase64(packet.pcm),
          }));
        }
      });
      state.streamers.push(streamer);
    }
    state.running = true;
    activeCaptionProducer = "local";
    activeCaptionSessionOwner = "caption-only";
    transitionCaptionRuntime("running");
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
  if (captionRuntimeState !== "stopping") transitionCaptionRuntime("stopping");
  clearActiveSubtitleSurface();
  const sessionId = state.sessionId;
  state.sessionId = null;
  clearTranslatedAudioQueue();
  stopLocalStreams();
  if (state.ws?.readyState === WebSocket.OPEN && sessionId) {
    state.ws.send(JSON.stringify({ type: "subtitle:stop", sessionId }));
  }
  state.running = false;
  activeCaptionProducer = "none";
  activeCaptionSessionOwner = "none";
  liveTranslationStallMonitor.reset();
  resetLiveCallCaptionRelay();
  window.clearTimeout(liveCaptionSocketRecoveryTimer);
  liveCaptionSocketRecoveryTimer = null;
  transitionCaptionRuntime("idle");
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
    await restartCaptionsFromController();
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

async function restartCaptionsFromController() {
  if (activeCaptionSessionOwner === "live-call") {
    await reconnectLiveCallTranslation();
    return;
  }
  await restartSubtitles();
}

function clearActiveSubtitleSurface() {
  clearTimeout(state.previewStatusTimer);
  state.previewStatusTimer = null;
  preview.querySelector(".translation-line").textContent = "";
  preview.querySelector(".source-line").textContent = "";
  preview.classList.remove("partial");
}

function clearUncommittedPreview() {
  if (!preview.classList.contains("partial")) return;
  clearActiveSubtitleSurface();
}

async function reconnectLiveCallTranslation() {
  if (liveTranslationReconnectPromise) return liveTranslationReconnectPromise;
  if (activeCaptionSessionOwner !== "live-call" || !state.running || !state.sessionId) return false;
  const sessionId = state.sessionId;
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.reconnectLiveCallTranslation) {
    transitionCaptionRuntime("reconnecting");
    setConnectionStatus(t("status.reconnecting"), "active");
    return false;
  }
  liveTranslationReconnectPromise = (async () => {
    transitionCaptionRuntime("reconnecting");
    clearTranslatedAudioQueue();
    translatedAudioGuard.reset();
    setConnectionStatus(t("status.reconnecting"), "active");
    setRealtimeApiStatus(t("status.realtimeReconnecting"), "active");
    const result = await bridge.reconnectLiveCallTranslation();
    if (state.sessionId !== sessionId || activeCaptionSessionOwner !== "live-call") return false;
    if (!result?.ok) return false;
    transitionCaptionRuntime("running");
    clearError();
    setConnectionStatus(t("status.receivingCaptions"), "active");
    setRealtimeApiStatus(t("status.realtimeConnected"), "active");
    flushLiveCallCaptionRelayQueue();
    return true;
  })().catch((error) => {
    console.warn(`[live-bridge] translation reconnect failed: ${error?.message ?? error}`);
    return false;
  }).finally(() => {
    liveTranslationReconnectPromise = null;
  });
  return liveTranslationReconnectPromise;
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
  return captureMicrophoneStream(navigator.mediaDevices, micSelect.value, (error) => {
    console.warn(`[subtitle] selected microphone failed (${error?.name ?? error}); retrying with system default`);
  });
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
  const context = new AudioContext({ sampleRate: CAPTION_AUDIO_SAMPLE_RATE, latencyHint: "interactive" });
  await ensureAudioContextRunning(context, sourceName);
  const source = context.createMediaStreamSource(media);
  const processor = context.createScriptProcessor(CAPTION_AUDIO_PROCESSOR_BUFFER_SIZE, 1, 1);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  const chunker = createCaptionAudioChunker({ inputSampleRate: context.sampleRate, source: sourceName, onChunk });
  const meter = startAudioLevelMeter(sourceName, label, analyser);
  const cleanupTrackDiagnostics = watchAudioTrackState(media, sourceName);

  context.addEventListener?.("statechange", () => {
    if (context.state === "running") setAudioSourceStatus(sourceName, t("audio.ready"), 0);
    if (context.state === "suspended") setAudioSourceStatus(sourceName, t("audio.paused"), 0);
  });

  processor.onaudioprocess = (event) => {
    chunker.push(event.inputBuffer.getChannelData(0));
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
      chunker.reset();
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
    liveTranslationStallMonitor.noteInput(
      sourceName,
      hasSignal,
      now,
      activeCaptionSessionOwner === "live-call" && state.running && !isLiveHostAudioBlocked && !isFeedbackSuppressed,
    );
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
    state.hasGeminiKey = Boolean(body.settings.hasGeminiKey);
    state.hasGeminiSecondaryKey = Boolean(body.settings.hasGeminiSecondaryKey);
    updateOpenAIKeyPlaceholder();
    updateOpenAIKeyStatus();
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
  const requestedAudioLanguage = form.elements.audioLanguage?.value;
  const audioLanguage = translationLanguages.includes(requestedAudioLanguage) ? requestedAudioLanguage : translationLanguages[0];
  return {
    ...state.settings,
    inputMode: form.elements.inputMode.value,
    micDeviceId: form.elements.micDeviceId.value,
    languagePair: deriveLanguagePairFromTargets(translationLanguages),
    translationLanguages,
    outputMode,
    voiceProvider: "gemini",
    audioLanguage,
    audioVolume: Math.max(0, Math.min(1, readNumber(form.elements.audioVolume?.value, DEFAULT_SUBTITLE.audioVolume))),
    displayMode: "translation_only",
    // Source ("원문") display removed — subtitles are always translation-only.
    showSourceText: false,
    translateAllLanguages: translationLanguages.length >= 3,
    model: DEFAULT_SUBTITLE.model,
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
    glossaryPresetId: selectedGlossaryPresetId(),
    glossaryPresetName: selectedGlossaryPresetName(),
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
  if (form.elements.voiceProvider) form.elements.voiceProvider.value = "gemini";
  if (form.elements.audioVolume) form.elements.audioVolume.value = Math.max(0, Math.min(1, readNumber(settings.audioVolume, DEFAULT_SUBTITLE.audioVolume)));
  updatePtOutputControls();
  if (form.elements.glossary) form.elements.glossary.value = settings.glossary ?? "";
  if (form.elements.translationDomain) form.elements.translationDomain.value = settings.translationDomain ?? "";
  restoreGlossaryPresetSelection(settings.glossaryPresetId, settings.glossaryPresetName, { persistConfirmedMissing: true });
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
  const geminiStatus = state.hasGeminiKey ? "Gemini Live: ready" : "Gemini Live: key needed";
  setRealtimeApiStatus(geminiStatus, state.hasGeminiKey ? "active" : "error");
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
  const socket = state.ws?.readyState === WebSocket.CONNECTING ? state.ws : connectWebSocket();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      socket?.removeEventListener("open", onOpen);
      socket?.removeEventListener("error", onError);
      socket?.removeEventListener("close", onError);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error(t("error.websocketClosed")));
    const timer = window.setTimeout(onError, WEBSOCKET_OPEN_TIMEOUT_MS);
    socket?.addEventListener("open", onOpen, { once: true });
    socket?.addEventListener("error", onError, { once: true });
    socket?.addEventListener("close", onError, { once: true });
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
// the MAIN process owns the gateway host socket. Capture remains in this
// renderer and deliberately uses the same source selection, microphone
// constraints, 24 kHz engine, and 100 ms framing as Caption-only.
let liveBridgeCapture = null;
let isLiveBridgeStarting = false;
let liveBridgePreflightRequestId = null;
let liveBridgeCaptureStartPromise = null;
let isLiveHostAudioBlocked = true;
let activeLiveFloorSessionId = "";
let liveFloorGateRevision = 0;

function applyLiveCallFloorGate(floor) {
  if (floor?.type === "live-call-ended") {
    if (!activeLiveFloorSessionId || floor.sessionId !== activeLiveFloorSessionId) return;
    clearActiveSubtitleSurface();
    stopLiveCallAudioBridge("live call ended");
    if (activeCaptionSessionOwner === "live-call") void stopSubtitles();
    isLiveHostAudioBlocked = true;
    activeLiveFloorSessionId = "";
    liveTranslationStallMonitor.reset();
    return;
  }
  liveFloorGateRevision += 1;
  const isCurrentFloor = floor?.type === "floor"
    && activeLiveFloorSessionId.length > 0
    && floor.sessionId === activeLiveFloorSessionId;
  const hasValidParticipant = typeof floor?.holder?.participantId === "string"
    && floor.holder.participantId.length > 0;
  // Only an authenticated, current-session holder:null snapshot reopens host
  // audio. Every malformed or stale value stays muted instead of guessing.
  isLiveHostAudioBlocked = !(isCurrentFloor && floor.holder === null);
  if (isLiveHostAudioBlocked) liveTranslationStallMonitor.suspend();
  if (isCurrentFloor && (floor.holder === null || hasValidParticipant)) clearUncommittedPreview();
}

function stopLiveCallAudioBridge(reason) {
  liveTranslationStallMonitor.suspend();
  if (!liveBridgeCapture) return;
  const capture = liveBridgeCapture;
  liveBridgeCapture = null;
  for (const streamer of capture.streamers ?? []) void streamer.close?.();
  for (const stream of capture.streams ?? []) stopMediaStream(stream);
  console.info(`[live-bridge] audio capture stopped${reason ? ` (${reason})` : ""}`);
}

async function startLiveCallMicCapture({ requestId = "" } = {}) {
  if (liveBridgeCapture?.ready) return { ok: true, reused: true };
  if (liveBridgeCaptureStartPromise) return liveBridgeCaptureStartPromise;
  if (liveBridgeCapture?.failed) stopLiveCallAudioBridge("retrying capture");
  const capture = { streams: [], streamers: [], requestId };
  liveBridgeCapture = capture;
  liveBridgeCaptureStartPromise = (async () => {
    try {
      state.settings = readSettingsFromForm();
      const sources = await captureSelectedAudio(state.settings);
      if (liveBridgeCapture !== capture) {
        for (const source of sources) stopMediaStream(source.stream);
        return { ok: false, cancelled: true };
      }
      capture.streams = sources.map((source) => source.stream);
      for (const source of sources) {
        if (liveBridgeCapture !== capture) return { ok: false, cancelled: true };
        const streamer = await createAudioStreamer(source.stream, source.source, source.label, (packet) => {
          if (liveBridgeCapture !== capture) return;
          if (isLiveHostAudioBlocked) return;
          window.realtimeNoelDesktop.sendLiveCallAudioFrame(packet);
        });
        if (liveBridgeCapture !== capture) {
          void streamer.close?.();
          return { ok: false, cancelled: true };
        }
        capture.streamers.push(streamer);
      }
      if (liveBridgeCapture !== capture) return { ok: false, cancelled: true };
      capture.ready = true;
      console.info(`[live-bridge] ${sources.map((source) => source.source).join("+")} audio is streaming to the gateway`);
      return { ok: true };
    } catch (error) {
      console.warn(`[live-bridge] audio capture unavailable: ${error?.message ?? error}`);
      for (const streamer of capture.streamers) void streamer.close?.();
      for (const stream of capture.streams) stopMediaStream(stream);
      capture.streamers = [];
      capture.streams = [];
      capture.failed = true;
      return { ok: false, error };
    }
  })();
  try {
    return await liveBridgeCaptureStartPromise;
  } finally {
    liveBridgeCaptureStartPromise = null;
  }
}

function requestLocalSubtitlePreflight(requestId, request) {
  const socket = state.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(t("error.websocketClosed")));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type !== "subtitle:preflight-ready") {
        if (message.type === "subtitle:preflight-failed" && message.requestId === requestId) {
          finish(new Error(message.message || t("error.subtitleStartFailed")));
        }
        return;
      }
      if (message.requestId !== requestId) return;
      finish();
    };
    const onClose = () => finish(new Error(t("error.websocketClosed")));
    const timer = window.setTimeout(
      () => finish(new Error(t("error.subtitleStartTimeout"))),
      SUBTITLE_PREFLIGHT_ACK_TIMEOUT_MS,
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.send(JSON.stringify({
      type: "subtitle:preflight",
      requestId,
      settings: state.settings,
      meeting: {
        kind: "live-call",
        liveSessionId: String(request?.liveSessionId ?? ""),
        title: String(request?.title ?? ""),
        startedAt: String(request?.startedAt ?? ""),
      },
    }));
  });
}

async function handleLiveCallPreflight(request) {
  const requestId = typeof request?.requestId === "string" ? request.requestId : "";
  const bridge = window.realtimeNoelDesktop;
  if (!requestId || !bridge?.completeLiveCallPreflight) return;
  liveBridgePreflightRequestId = requestId;
  let failureCode = "LIVE_CALL_AUDIO_CAPTURE_FAILED";
  try {
    state.settings = readSettingsFromForm();
    // 2026-07-27 fix: Main reloads the saved settings after preflight. Persist
    // the exact validated form first so Live Call and Caption Only share the
    // same glossary, tone, and domain on their first translated utterance.
    await saveSettings({ subtitle: state.settings });
    await ensureWebSocketOpen();
    const captureResult = await startLiveCallMicCapture({ requestId });
    if (!captureResult?.ok) throw captureResult?.error ?? new Error("audio capture unavailable");
    if (liveBridgePreflightRequestId !== requestId) return;
    failureCode = "LIVE_CALL_SUBTITLE_PREFLIGHT_FAILED";
    await requestLocalSubtitlePreflight(requestId, request);
    if (liveBridgePreflightRequestId !== requestId) return;
    await bridge.completeLiveCallPreflight(requestId, { ok: true });
  } catch (error) {
    if (liveBridgePreflightRequestId !== requestId) return;
    liveBridgePreflightRequestId = null;
    stopLiveCallAudioBridge("preflight failed");
    await bridge.completeLiveCallPreflight(requestId, {
      ok: false,
      code: failureCode,
      message: String(error?.message ?? error),
    });
  }
}

async function cancelLiveCallPreflight(request) {
  const requestId = typeof request?.requestId === "string" ? request.requestId : "";
  if (!requestId || requestId !== liveBridgePreflightRequestId) return;
  let liveState = null;
  try { liveState = await window.realtimeNoelDesktop?.getLiveCallState?.(); } catch { /* cancellation is best-effort */ }
  if (liveState?.live) return;
  liveBridgePreflightRequestId = null;
  stopLiveCallAudioBridge("preflight cancelled");
}

window.realtimeNoelDesktop?.onLiveCallPreflight?.(handleLiveCallPreflight);
window.realtimeNoelDesktop?.onLiveCallPreflightCancel?.(cancelLiveCallPreflight);

let activeCaptionProducer = "none";
let activeCaptionSessionOwner = "none";

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
  const floorGateRevisionAtRequest = liveFloorGateRevision;
  let liveState = null;
  try { liveState = await bridge.getLiveCallState(); } catch { return; }
  if (!liveState?.armed || !liveState.live) {
    if (liveBridgeCapture) stopLiveCallAudioBridge("live call ended");
    liveFloorGateRevision += 1;
    isLiveHostAudioBlocked = true;
    activeLiveFloorSessionId = "";
    if (activeCaptionSessionOwner === "live-call") await stopSubtitles();
    return;
  }
  activeLiveFloorSessionId = String(liveState.sessionId ?? "");
  if (liveFloorGateRevision === floorGateRevisionAtRequest) {
    isLiveHostAudioBlocked = liveState.bridge?.floorKnown === true
      ? liveState.bridge.hostAudioBlocked !== false
      : true;
  }
  liveBridgePreflightRequestId = null;
  if (liveBridgeCapture?.failed) return;
  if (isLiveBridgeStarting) return;
  isLiveBridgeStarting = true;
  try {
    if (activeCaptionSessionOwner === "caption-only" || activeCaptionProducer === "none") {
      await startGatewayCaptionSession(liveState);
    }
    // 2026-07-29 perf: Live Call has exactly one Gemini translation producer.
    // The gateway result feeds both web and desktop captions, avoiding a paid
    // local duplicate while keeping the renderer capture solely as gateway PCM.
    const result = await bridge.ensureLiveCallBridge();
    if (!result?.ok) {
      console.warn(`[live-bridge] gateway bridge unavailable: ${result?.code ?? "unknown"}`);
      return;
    }
    // Capture starts once and keeps feeding frames; main drops them until the
    // gateway pipeline reports started.
    if (!liveBridgeCapture) {
      const captureResult = await startLiveCallMicCapture();
      if (captureResult.cancelled) return;
      if (!captureResult.ok) {
        const error = captureResult.error instanceof Error
          ? captureResult.error
          : new Error(String(captureResult.error ?? t("error.micFailed", { reason: "unknown" })));
        showError(error);
        setConnectionStatus(error.message, "error");
        await bridge.reportLiveCallAudioFailure?.(error.message);
        return;
      }
    }
  } catch (error) {
    console.warn(`[live-bridge] producer transition failed: ${error?.message ?? error}`);
  } finally {
    isLiveBridgeStarting = false;
  }
}

async function startGatewayCaptionSession(liveState) {
  if (state.running) await stopSubtitles();
  await ensureWebSocketOpen();
  transitionCaptionRuntime("starting");
  state.settings = readSettingsFromForm();
  state.sessionId = `live-${String(liveState.sessionId ?? crypto.randomUUID())}`;
  translatedAudioGuard.reset();
  await requestSubtitleStart({
    type: "subtitle:start",
    captionProducer: "gateway",
    sessionId: state.sessionId,
    settings: state.settings,
    meeting: {
      kind: "live-call",
      liveSessionId: String(liveState.sessionId ?? ""),
      title: String(liveState.title ?? ""),
      startedAt: String(liveState.liveStartedAt ?? ""),
    },
  });
  for (const caption of liveState.captionSnapshot ?? []) {
    enqueueLiveCallCaptionRelay(caption);
  }
  activeCaptionProducer = "gateway";
  activeCaptionSessionOwner = "live-call";
  state.running = true;
  liveTranslationStallMonitor.reset();
  transitionCaptionRuntime("running");
  startButton.disabled = true;
  stopButton.disabled = false;
  syncRuntimeOutputVisibility();
  setConnectionStatus(t("status.receivingCaptions"), "active");
  flushLiveCallCaptionRelayQueue();
}

window.realtimeNoelDesktop?.onLiveCallFloor?.(applyLiveCallFloorGate);

if (window.realtimeNoelDesktop?.ensureLiveCallBridge) {
  window.setInterval(() => { void syncLiveCallAudioBridge(); }, 1_000);
}

// ── Live Call canonical captions → local subtitle system ──────────────────
// 2026-07-26 fix: Gateway events for both host and participant speech enter
// one local ingest path so overlay, preview, history, and records stay equal.
// 2026-07-27 fix: The hidden dashboard can reconnect independently from the
// gateway. Keep canonical captions until the gateway producer acknowledgement
// restores the relay instead of dropping every event during that gap.
const MAX_LIVE_CALL_PENDING_PARTIALS = 32;
const MAX_LIVE_CALL_FINALIZED_KEYS = 512;
const LIVE_CALL_CAPTION_RELAY_BUFFER_LIMIT = 1_000_000;
let liveCallCaptionRelayFlushTimer = null;
const liveCallCaptionRelayQueue = [];
const liveCallFinalizedCaptionKeys = new Map();
const liveCallFinalSeqByLane = new Map();
const liveCallDeliveredFinalSeqByLane = new Map();

function getLiveCallCaptionRelayKey(caption) {
  const sessionId = String(caption.sessionId ?? state.sessionId ?? "");
  const language = String(caption.language ?? "");
  const utteranceKey = String(caption.utteranceKey ?? "");
  const sourceSeq = Number.isSafeInteger(caption.seq) ? String(caption.seq) : "";
  const identity = utteranceKey || sourceSeq;
  return identity ? `${sessionId}\u0000${language}\u0000${identity}` : "";
}

function getLiveCallCaptionRelayLane(caption) {
  return `${String(caption.sessionId ?? state.sessionId ?? "")}\u0000${String(caption.language ?? "")}`;
}

function rememberFinalizedLiveCallCaption(key) {
  if (!key) return;
  liveCallFinalizedCaptionKeys.delete(key);
  liveCallFinalizedCaptionKeys.set(key, true);
  while (liveCallFinalizedCaptionKeys.size > MAX_LIVE_CALL_FINALIZED_KEYS) {
    const oldestKey = liveCallFinalizedCaptionKeys.keys().next().value;
    liveCallFinalizedCaptionKeys.delete(oldestKey);
  }
}

function normalizeLiveCallCaptionRelay(caption) {
  const text = String(caption?.text ?? "").trim();
  if (!text || caption?.translationStatus === "failed") return null;
  // Main has already removed source-language events and selected the single
  // opposite-language translation that belongs on the desktop screen.
  const speakerRole = caption.speakerRole === "participant"
    || caption.speaker?.isParticipant === true
    ? "participant"
    : "host";
  const speakerName = speakerRole === "host"
    ? "Host"
    : String(caption.speakerName
      ?? caption.speaker?.name
      ?? caption.speaker?.label
      ?? t("live.participant"));
  const key = getLiveCallCaptionRelayKey(caption);
  const isFinal = caption.isFinal === true;
  return {
    key,
    lane: getLiveCallCaptionRelayLane(caption),
    isFinal,
    canonicalSeq: Number.isSafeInteger(caption.seq) ? caption.seq : null,
    payload: {
      type: "subtitle:live-call-caption",
      sessionId: String(caption.sessionId ?? ""),
      partial: !isFinal,
      targetLanguage: String(caption.language ?? ""),
      sourceLanguage: String(caption.sourceLanguage ?? ""),
      utteranceKey: String(caption.utteranceKey ?? ""),
      sourceSeq: Number.isSafeInteger(caption.seq) ? caption.seq : null,
      sourceText: String(caption.sourceText ?? (caption.origin === "source" ? text : "")),
      speaker: speakerName,
      speakerRole,
      speakerDepartment: speakerRole === "participant"
        ? String(caption.speakerDepartment ?? caption.speaker?.department ?? "")
        : "",
      speakerJobTitle: speakerRole === "participant"
        ? String(caption.speakerJobTitle ?? caption.speaker?.jobTitle ?? "")
        : "",
      translatedText: text,
    },
  };
}

function isLiveCallCaptionRelayReady() {
  return activeCaptionProducer === "gateway"
    && (typeof activeCaptionSessionOwner === "undefined"
      || (activeCaptionSessionOwner === "live-call" && state.running))
    && (typeof captionRuntimeState === "undefined" || captionRuntimeState === "running")
    && state.ws?.readyState === WebSocket.OPEN;
}

function scheduleLiveCallCaptionRelayFlush() {
  if (liveCallCaptionRelayFlushTimer) return;
  liveCallCaptionRelayFlushTimer = window.setTimeout(() => {
    liveCallCaptionRelayFlushTimer = null;
    flushLiveCallCaptionRelayQueue();
  }, 100);
}

function trimLiveCallCaptionRelayQueue() {
  let partialCount = liveCallCaptionRelayQueue.reduce(
    (count, entry) => count + (entry.isFinal ? 0 : 1),
    0,
  );
  while (partialCount > MAX_LIVE_CALL_PENDING_PARTIALS) {
    const partialIndex = liveCallCaptionRelayQueue.findIndex((entry) => !entry.isFinal);
    if (partialIndex < 0) return;
    liveCallCaptionRelayQueue.splice(partialIndex, 1);
    partialCount -= 1;
  }
}

function enqueueLiveCallCaptionRelay(caption) {
  const entry = normalizeLiveCallCaptionRelay(caption);
  if (!entry) return false;
  const finalSeq = liveCallFinalSeqByLane.get(entry.lane);
  const deliveredFinalSeq = liveCallDeliveredFinalSeqByLane.get(entry.lane);
  if (!entry.isFinal
    && entry.canonicalSeq !== null
    && finalSeq !== undefined
    && entry.canonicalSeq <= finalSeq) return false;
  if (entry.isFinal
    && entry.canonicalSeq !== null
    && deliveredFinalSeq !== undefined
    && entry.canonicalSeq <= deliveredFinalSeq) return false;
  if (entry.key && liveCallFinalizedCaptionKeys.has(entry.key)) return false;

  if (entry.isFinal) {
    rememberFinalizedLiveCallCaption(entry.key);
    if (entry.canonicalSeq !== null) {
      liveCallFinalSeqByLane.set(entry.lane, Math.max(finalSeq ?? -1, entry.canonicalSeq));
    }
    for (let index = liveCallCaptionRelayQueue.length - 1; index >= 0; index -= 1) {
      const queued = liveCallCaptionRelayQueue[index];
      const isSameFinalizedIdentity = queued.key && queued.key === entry.key;
      const isStaleLanePartial = queued.lane === entry.lane
        && entry.canonicalSeq !== null
        && queued.canonicalSeq !== null
        && queued.canonicalSeq <= entry.canonicalSeq;
      if (!queued.isFinal && (isSameFinalizedIdentity || isStaleLanePartial)) {
        liveCallCaptionRelayQueue.splice(index, 1);
      }
    }
  }

  if (isLiveCallCaptionRelayReady()
    && (state.ws?.bufferedAmount ?? 0) <= LIVE_CALL_CAPTION_RELAY_BUFFER_LIMIT) {
    try {
      state.ws.send(JSON.stringify(entry.payload));
      if (entry.isFinal && entry.canonicalSeq !== null) {
        liveCallDeliveredFinalSeqByLane.set(entry.lane, entry.canonicalSeq);
      }
      return true;
    } catch {
      // The socket can close after readyState is observed. Queue this exact
      // event so the producer recovery acknowledgement can release it later.
    }
  }

  if (!entry.isFinal && entry.key) {
    const partialIndex = liveCallCaptionRelayQueue.findIndex(
      (queued) => !queued.isFinal && queued.key === entry.key,
    );
    if (partialIndex >= 0) liveCallCaptionRelayQueue[partialIndex] = entry;
    else liveCallCaptionRelayQueue.push(entry);
  } else {
    liveCallCaptionRelayQueue.push(entry);
  }
  trimLiveCallCaptionRelayQueue();
  if (isLiveCallCaptionRelayReady()) scheduleLiveCallCaptionRelayFlush();
  return false;
}

function flushLiveCallCaptionRelayQueue() {
  if (!isLiveCallCaptionRelayReady()) return false;
  liveCallCaptionRelayQueue.sort((left, right) => {
    const leftSeq = left.canonicalSeq ?? Number.MAX_SAFE_INTEGER;
    const rightSeq = right.canonicalSeq ?? Number.MAX_SAFE_INTEGER;
    if (leftSeq !== rightSeq) return leftSeq - rightSeq;
    if (left.isFinal !== right.isFinal) return left.isFinal ? -1 : 1;
    return 0;
  });
  while (liveCallCaptionRelayQueue.length > 0) {
    if ((state.ws?.bufferedAmount ?? 0) > LIVE_CALL_CAPTION_RELAY_BUFFER_LIMIT) {
      scheduleLiveCallCaptionRelayFlush();
      return false;
    }
    const entry = liveCallCaptionRelayQueue[0];
    try {
      state.ws.send(JSON.stringify(entry.payload));
      liveCallCaptionRelayQueue.shift();
      if (entry.isFinal && entry.canonicalSeq !== null) {
        liveCallDeliveredFinalSeqByLane.set(entry.lane, entry.canonicalSeq);
      }
    } catch {
      return false;
    }
  }
  return true;
}

function resetLiveCallCaptionRelay() {
  window.clearTimeout(liveCallCaptionRelayFlushTimer);
  liveCallCaptionRelayFlushTimer = null;
  liveCallCaptionRelayQueue.length = 0;
  liveCallFinalizedCaptionKeys.clear();
  liveCallFinalSeqByLane.clear();
  liveCallDeliveredFinalSeqByLane.clear();
}

// ── UI language changes ───────────────────────────────────────────────────
// subtitle-workspace.js repaints every static data-i18n node; the dynamic
// panels this file renders have to be rebuilt from their current state.
subscribeToLanguage(() => {
  renderLanguagePills();
  renderPlacementRows();
  renderGlossaryPresetOptions();
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
    if (!caption || activeCaptionProducer !== "gateway") return;
    if (activeCaptionSessionOwner !== "live-call" || !state.running) return;
    if (typeof activeLiveFloorSessionId !== "undefined"
      && caption.sessionId !== activeLiveFloorSessionId) return;
    if (String(caption.text ?? "").trim() && typeof liveTranslationStallMonitor !== "undefined") {
      liveTranslationStallMonitor.noteOutput(performance.now());
    }
    enqueueLiveCallCaptionRelay(caption);
  });
}

// ── Session detail: local-only content/language tabs + per-session export ────
for (const tab of document.querySelectorAll("[data-record-detail-tab]")) {
  tab.addEventListener("click", () => activateSessionDetailView(tab.dataset.recordDetailTab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-record-detail-tab]")];
    const currentIndex = tabs.indexOf(tab);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    activateSessionDetailView(tabs[nextIndex]?.dataset.recordDetailTab, { focus: true });
  });
}

for (const tab of document.querySelectorAll("[data-transcript-lang]")) {
  tab.addEventListener("click", () => {
    openSessionDetail.language = tab.dataset.transcriptLang === "ko" ? "ko" : "en";
    renderOpenSessionTranscript();
  });
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-transcript-lang]")];
    const currentIndex = tabs.indexOf(tab);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    openSessionDetail.language = next?.dataset.transcriptLang === "ko" ? "ko" : "en";
    renderOpenSessionTranscript();
    next?.focus();
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
