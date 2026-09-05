import { initSubtitleControls } from "./subtitle-controls.js";
import { mountSpeakerController } from "./subtitle-speakers.js";
import { applyControllerAppearance, createLatestAppearanceSender } from "./controller-appearance.js";
import {
  applyDocumentLanguage,
  applyTranslations,
  initLanguage,
  readStoredLanguage,
  setLanguage,
  subscribe as subscribeToLanguage,
  t,
} from "./subtitle-i18n.js";
import { mountSystemLanguageButton } from "./system-language-button.js";
import { SYSTEM_LANGUAGE_STORAGE_KEY } from "./system-language.js";

const DEFAULT_SUBTITLE = {
  inputMode: "system_mic",
  micDeviceId: "",
  translationLanguages: ["en", "ko"],
  outputMode: "captions",
  translationFontSize: 38,
  verticalOffset: 48,
  opacity: 0.92,
  position: "bottom-center",
  subtitlePositions: { en: "bottom-center", ko: "bottom-center", ja: "top-center" },
};

const fontRange = document.getElementById("controller-font-range");
const appearanceSender = createLatestAppearanceSender((message) => sendControl(message));
let appearanceEdits = {};
const unsentAppearanceCommands = new Map();
const opacityInput = document.getElementById("controller-opacity");
const opacityValue = document.getElementById("controller-opacity-value");
const fontSize = document.getElementById("controller-font-size");
const gapValue = document.getElementById("controller-gap-value");
const vuFill = document.getElementById("controller-vu-fill");
const elapsedReadout = document.getElementById("controller-elapsed");
const liveCallStatus = document.getElementById("controller-live-call-status");
const healthLabel = document.getElementById("controller-health-label");
const healthDetail = document.getElementById("controller-health-detail");
const positionButtons = [...document.querySelectorAll("[data-controller-position]")];
let settings = { ...DEFAULT_SUBTITLE };
let ws = null;
const TRANSLATION_EVENT_STALE_MS = 5_000;
const TRANSLATION_ACTIVE_CAPTION_MS = 3_000;
const translationHealth = {
  socketState: "connecting",
  bridgeState: "idle",
  isLive: false,
  mediaWaiting: false,
  lastEventAt: null,
  lastCaptionAt: null,
  signalSinceAt: null,
  lastInputStatus: "",
  pipelineStatus: "",
};
let lastRenderedHealthState = "";
let isLiveActionStatusLocked = false;
const translationInputHealth = new Map();
let translationInputConfiguration = "";

initLanguage();
applyDocumentLanguage(document);
applyTranslations(document);
window.addEventListener("storage", (event) => {
  if (event.key !== SYSTEM_LANGUAGE_STORAGE_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  setLanguage(readStoredLanguage());
});
subscribeToLanguage(() => {
  applyDocumentLanguage(document);
  applyTranslations(document);
  renderSettings();
  renderOverlayDisplayState(overlayDisplayState);
  renderTranslationHealth();
});
mountSystemLanguageButton(document.getElementById("controller-system-language"), {
  onOpenChange(isOpen) {
    document.querySelector(".caption-controller-window")?.classList.toggle("is-language-menu-open", isOpen);
  },
});

document.getElementById("controller-restart")?.addEventListener("click", () => sendControl({ command: "restart" }));
document.getElementById("controller-stop")?.addEventListener("click", () => sendControl({ command: "stop" }));
// Desktop-only app controls: raise the main window (it is hidden while a Live
// Call runs, and the overlays sit above it, so this is the way back to it),
// hide this floating console (subtitles keep running; it comes back on the next
// session start or from the dashboard), and quit the whole app directly.
const mainWindowButton = document.getElementById("controller-main-window");
const hideButton = document.getElementById("controller-hide");
const quitButton = document.getElementById("controller-quit");
const displaySelect = document.getElementById("controller-display");
const allDisplaysTick = document.getElementById("controller-all-displays");
if (window.realtimeNoelDesktop?.isElectron) {
  mainWindowButton?.addEventListener("click", () => {
    // Show/raise only — the main window's renderer is the host microphone
    // source, so the running call is untouched.
    void window.realtimeNoelDesktop.showMainWindow?.();
  });
  hideButton?.addEventListener("click", () => {
    void window.realtimeNoelDesktop.setControllerVisible(false);
  });
  quitButton?.addEventListener("click", () => {
    void window.realtimeNoelDesktop.quitApp?.();
  });
} else {
  if (mainWindowButton) mainWindowButton.hidden = true;
  if (hideButton) hideButton.hidden = true;
  if (quitButton) quitButton.hidden = true;
}

// ── Caption display selection ──────────────────────────────────────────────
// Main owns all display geometry. This renderer deals only in opaque ids and
// labels, so selecting a monitor cannot become a renderer-controlled window
// placement primitive.
let overlayDisplayState = { displays: [], selectedDisplayId: "", allDisplays: false };
let isSelectingOverlayDisplay = false;

function normalizeOverlayDisplayState(value) {
  const displays = Array.isArray(value?.displays)
    ? value.displays.filter((display) => display
      && (typeof display.id === "string" || Number.isSafeInteger(display.id))
      && typeof display.label === "string"
      && display.label.trim()
      && display.isConnected !== false)
    : [];
  const selectedDisplayId = typeof value?.selectedDisplayId === "string"
    || Number.isSafeInteger(value?.selectedDisplayId)
    ? String(value.selectedDisplayId)
    : "";
  return { displays, selectedDisplayId, allDisplays: value?.allDisplays === true, controllerAvailableHeight: value?.controllerAvailableHeight };
}

function renderOverlayDisplayState(state) {
  if (!displaySelect) return;
  while (displaySelect.firstChild) displaySelect.removeChild(displaySelect.firstChild);
  for (const display of state.displays) {
    const option = document.createElement("option");
    option.value = String(display.id);
    option.textContent = display.label;
    if (display.isPrimary) option.textContent += ` · ${t("controller.primaryDisplay")}`;
    displaySelect.append(option);
  }
  if (state.displays.length === 0) {
    const option = document.createElement("option");
    option.textContent = t("controller.displayUnavailable");
    displaySelect.append(option);
  } else if (state.displays.some((display) => String(display.id) === String(state.selectedDisplayId))) {
    displaySelect.value = String(state.selectedDisplayId);
  } else {
    displaySelect.selectedIndex = 0;
  }
  displaySelect.disabled = isSelectingOverlayDisplay || state.displays.length === 0;
  renderAllDisplaysTick(state);
  renderScreenCheckboxes(state);
}

// With the tick on, every screen carries the same captions, so choosing ONE
// caption display is meaningless — disable the picker rather than leaving a
// control that silently does nothing.
function renderAllDisplaysTick(state) {
  if (!allDisplaysTick) return;
  allDisplaysTick.setAttribute("aria-checked", state.allDisplays ? "true" : "false");
  allDisplaysTick.disabled = isSelectingOverlayDisplay || state.displays.length === 0;
  if (displaySelect) {
    displaySelect.disabled = displaySelect.disabled || state.allDisplays;
  }
}

async function refreshOverlayDisplays() {
  if (!window.realtimeNoelDesktop?.listOverlayDisplays) return;
  try {
    overlayDisplayState = normalizeOverlayDisplayState(
      await window.realtimeNoelDesktop.listOverlayDisplays(),
    );
  } catch {
    overlayDisplayState = { displays: [], selectedDisplayId: "", allDisplays: false };
  }
  renderOverlayDisplayState(overlayDisplayState);
}

if (displaySelect && window.realtimeNoelDesktop?.listOverlayDisplays) {
  displaySelect.addEventListener("change", async () => {
    const display = overlayDisplayState.displays.find(
      (candidate) => String(candidate.id) === displaySelect.value,
    );
    if (!display || isSelectingOverlayDisplay) return;
    isSelectingOverlayDisplay = true;
    displaySelect.disabled = true;
    displaySelect.setAttribute("aria-busy", "true");
    try {
      overlayDisplayState = normalizeOverlayDisplayState(
        await window.realtimeNoelDesktop.selectOverlayDisplay(display.id),
      );
    } catch {
      await refreshOverlayDisplays();
    } finally {
      isSelectingOverlayDisplay = false;
      displaySelect.removeAttribute("aria-busy");
      renderOverlayDisplayState(overlayDisplayState);
    }
  });
  allDisplaysTick?.addEventListener("click", async () => {
    if (isSelectingOverlayDisplay || !window.realtimeNoelDesktop?.setOverlayAllDisplays) return;
    const next = allDisplaysTick.getAttribute("aria-checked") !== "true";
    isSelectingOverlayDisplay = true;
    allDisplaysTick.disabled = true;
    allDisplaysTick.setAttribute("aria-busy", "true");
    try {
      overlayDisplayState = normalizeOverlayDisplayState(
        await window.realtimeNoelDesktop.setOverlayAllDisplays(next),
      );
    } catch {
      await refreshOverlayDisplays();
    } finally {
      isSelectingOverlayDisplay = false;
      allDisplaysTick.removeAttribute("aria-busy");
      renderOverlayDisplayState(overlayDisplayState);
    }
  });
  const unsubscribeOverlayDisplays = window.realtimeNoelDesktop.onOverlayDisplaysChanged?.((state) => {
    overlayDisplayState = normalizeOverlayDisplayState(state);
    renderOverlayDisplayState(overlayDisplayState);
  });
  if (typeof unsubscribeOverlayDisplays === "function") {
    window.addEventListener("beforeunload", unsubscribeOverlayDisplays, { once: true });
  }
  void refreshOverlayDisplays();
} else if (displaySelect) {
  displaySelect.hidden = true;
}

document.getElementById("controller-font-down")?.addEventListener("click", () => sendControl({ command: "font", delta: -2 }));
document.getElementById("controller-font-up")?.addEventListener("click", () => sendControl({ command: "font", delta: 2 }));
// Vertical gap: how far the subtitle sits from its anchored screen edge.
document.getElementById("controller-gap-down")?.addEventListener("click", () => sendControl({ command: "offset", delta: -8 }));
document.getElementById("controller-gap-up")?.addEventListener("click", () => sendControl({ command: "offset", delta: 8 }));
function previewAppearance(message, commit = false) {
  const next = applyControllerAppearance(settings, message);
  if (!next) return;
  appearanceEdits = { ...appearanceEdits, ...(message.command === "font-size" ? { translationFontSize: next.translationFontSize, sourceFontSize: next.sourceFontSize }
    : message.command === "opacity" ? { opacity: next.opacity } : { position: next.position, subtitlePositions: next.subtitlePositions }) };
  settings = next;
  renderSettings();
  if (commit) appearanceSender.commit(message); else appearanceSender.input(message);
}
for (const [input, command] of [[opacityInput, "opacity"], [fontRange, "font-size"]]) {
  const value = () => command === "opacity" ? { command, opacity: 1 - Number(input.value) / 100 } : { command, fontSize: Number(input.value) };
  input?.addEventListener("input", () => previewAppearance(value()));
  input?.addEventListener("change", () => previewAppearance(value(), true));
  input?.addEventListener("blur", () => appearanceSender.flush());
}
for (const button of positionButtons) {
  button.addEventListener("click", () => previewAppearance({ command: "position", position: button.dataset.controllerPosition }, true));
}
connect();

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  translationHealth.socketState = "connecting";
  renderTranslationHealth();
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("open", () => {
    translationHealth.socketState = "open";
    for (const payload of unsentAppearanceCommands.values()) sendControl({ ...payload, preview: false });
    unsentAppearanceCommands.clear();
    renderTranslationHealth();
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "settings" && message.settings?.subtitle) {
      for (const [key, value] of Object.entries(appearanceEdits)) {
        if (JSON.stringify(message.settings.subtitle[key]) === JSON.stringify(value)) delete appearanceEdits[key];
      }
      settings = { ...DEFAULT_SUBTITLE, ...message.settings.subtitle, ...appearanceEdits };
      renderSettings();
    }
    if (message.type === "subtitle:input-status") updateVuMeter(message);
    noteTranslationHealthEvent(message);
  });
  ws.addEventListener("close", () => {
    translationHealth.socketState = "closed";
    renderTranslationHealth();
    setTimeout(connect, 1000);
  });
}

// ── VU meter: the server already broadcasts subtitle:input-status with a
// 0..1 level for mic/system, so the brand zone shows a live signal bar with
// no new plumbing. Peak-hold with decay so speech reads as motion, not
// flicker; style writes are cheap (one width mutation per message). ─────────
let vuLevel = 0;
let vuDecayTimer = null;
function updateVuMeter(message) {
  if (!vuFill) return;
  const level = Number.isFinite(Number(message.level)) ? Math.max(0, Math.min(1, Number(message.level))) : 0;
  vuLevel = Math.max(level, vuLevel * 0.72);
  vuFill.style.width = `${Math.round(Math.min(1, vuLevel * 3.2) * 100)}%`;
  clearTimeout(vuDecayTimer);
  vuDecayTimer = setTimeout(() => {
    vuLevel = 0;
    vuFill.style.width = "0%";
  }, 1200);
}

function sendControl(payload) {
  if (ws?.readyState !== WebSocket.OPEN) {
    if (["font-size", "opacity", "position"].includes(payload.command)) unsentAppearanceCommands.set(payload.command, payload);
    return;
  }
  ws.send(JSON.stringify({ type: "subtitle:control", ...payload }));
}

function renderSettings() {
  const languages = Array.isArray(settings.translationLanguages) && settings.translationLanguages.length
    ? settings.translationLanguages.filter(isSupportedLanguage)
    : DEFAULT_SUBTITLE.translationLanguages;
  if (fontSize) fontSize.textContent = `${Math.round(Number(settings.translationFontSize) || DEFAULT_SUBTITLE.translationFontSize)}px`;
  if (gapValue) gapValue.textContent = String(Math.round(Number(settings.verticalOffset ?? DEFAULT_SUBTITLE.verticalOffset)));
  if (fontRange) fontRange.value = String(settings.translationFontSize ?? DEFAULT_SUBTITLE.translationFontSize);
  const opacity = Number.isFinite(Number(settings.opacity)) ? Number(settings.opacity) : DEFAULT_SUBTITLE.opacity;
  if (opacityInput) opacityInput.value = String(Math.round((1 - opacity) * 100));
  updateOpacityReadout(opacity);
  const activePosition = settings.subtitlePositions?.[languages[0]] || settings.position || DEFAULT_SUBTITLE.position;
  for (const button of positionButtons) {
    button.classList.toggle("active", button.dataset.controllerPosition === activePosition);
    button.setAttribute("aria-pressed", String(button.dataset.controllerPosition === activePosition));
  }
}

function updateOpacityReadout(opacity) {
  document.documentElement.style.setProperty("--subtitle-opacity", String(opacity));
  if (opacityValue) opacityValue.textContent = `${Math.round((1 - opacity) * 100)}%`;
}

// Status writes go through these two helpers so the data-i18n marker stays in
// step with the text: keyed messages survive a language switch, one-off
// interpolated ones do not carry a key.
function setControllerStatus(key, connectionState = "") {
  if (!liveCallStatus || !healthLabel) return;
  delete liveCallStatus.dataset.i18n;
  healthLabel.dataset.i18n = key;
  if (connectionState) liveCallStatus.dataset.connectionState = connectionState;
  else delete liveCallStatus.dataset.connectionState;
  healthLabel.textContent = t(key);
  if (healthDetail) healthDetail.hidden = true;
  lastRenderedHealthState = "";
}

function setControllerText(text) {
  if (!liveCallStatus || !healthLabel) return;
  delete liveCallStatus.dataset.i18n;
  delete healthLabel.dataset.i18n;
  delete liveCallStatus.dataset.connectionState;
  healthLabel.textContent = text;
  if (healthDetail) healthDetail.hidden = true;
  lastRenderedHealthState = "";
}

function resetTranslationHealthEvents() {
  translationInputHealth.clear();
  translationHealth.lastEventAt = null;
  translationHealth.lastCaptionAt = null;
  translationHealth.signalSinceAt = null;
  translationHealth.lastInputStatus = "";
  translationHealth.pipelineStatus = "";
  lastRenderedHealthState = "";
}

function refreshTranslationInputHealth(now) {
  const configuration = JSON.stringify([settings.inputMode, settings.micDeviceId ?? ""]);
  if (configuration !== translationInputConfiguration) {
    translationInputConfiguration = configuration;
    resetTranslationHealthEvents();
  }
  const sources = new Set(settings.inputMode === "system_mic" ? ["mic", "system"]
    : settings.inputMode === "mic" ? ["mic"] : settings.inputMode === "system" ? ["system"] : []);
  for (const [source, input] of translationInputHealth) {
    if (!sources.has(source) || now - input.observedAt > TRANSLATION_EVENT_STALE_MS) translationInputHealth.delete(source);
  }
  const inputs = [...translationInputHealth.values()];
  const signals = inputs.filter(input => input.status === "signal");
  translationHealth.lastInputStatus = signals.length > 0 ? "signal" : inputs.length > 0 ? "waiting" : "";
  translationHealth.signalSinceAt = signals.length > 0 ? Math.min(...signals.map(input => input.signalSinceAt)) : null;
  return sources;
}

function noteTranslationHealthEvent(message) {
  if (!message || typeof message.type !== "string") return;
  const now = Date.now();
  const configuredSources = refreshTranslationInputHealth(now);
  if (message.type === "subtitle:input-status") {
    if (!configuredSources.has(message.source) || !["signal", "waiting", "silent", "idle"].includes(message.status)) return;
    const previous = translationInputHealth.get(message.source);
    // 2026-09-01 fix: 한 입력의 무음이 다른 입력의 연속 신호를 덮어쓰지 않도록 따로 만료시킨다.
    translationInputHealth.set(message.source, {
      status: message.status, observedAt: now,
      signalSinceAt: message.status === "signal" ? previous?.status === "signal" ? previous.signalSinceAt : now : null,
    });
    translationHealth.lastEventAt = now;
  } else if (message.type === "subtitle:partial" || message.type === "subtitle:committed") {
    translationHealth.lastEventAt = now;
    translationHealth.lastCaptionAt = now;
    translationHealth.pipelineStatus = "listening";
  } else if (message.type === "subtitle:status") {
    translationHealth.lastEventAt = now;
    translationHealth.pipelineStatus = String(message.status ?? "");
  } else if (message.type === "subtitle:stopped" || message.type === "subtitle:started") {
    resetTranslationHealthEvents();
  } else {
    return;
  }
  renderTranslationHealth(now);
}

function translationHealthState(now = Date.now()) {
  if (translationHealth.socketState !== "open"
    || ["failed", "idle"].includes(translationHealth.bridgeState)) return "disconnected";
  if (["connecting", "reconnecting"].includes(translationHealth.bridgeState)
    || ["recovering", "reconnecting", "degraded"].includes(translationHealth.pipelineStatus)) return "recovering";
  if (!Number.isFinite(translationHealth.lastEventAt)) return "waiting";
  if (now - translationHealth.lastEventAt > TRANSLATION_EVENT_STALE_MS) return "recovering";
  if (["waiting", "silent", "idle"].includes(translationHealth.lastInputStatus)) return "waiting";
  if (translationHealth.lastInputStatus === "signal") {
    const hasRecentOutput = Number.isFinite(translationHealth.lastCaptionAt)
      && Number.isFinite(translationHealth.signalSinceAt)
      && translationHealth.lastCaptionAt >= translationHealth.signalSinceAt
      && now - translationHealth.lastCaptionAt <= TRANSLATION_ACTIVE_CAPTION_MS;
    if (hasRecentOutput) return "healthy";
    if (Number.isFinite(translationHealth.signalSinceAt)
      && now - translationHealth.signalSinceAt > TRANSLATION_ACTIVE_CAPTION_MS) return "recovering";
    return "waiting";
  }
  if (Number.isFinite(translationHealth.lastCaptionAt)
    && now - translationHealth.lastCaptionAt <= TRANSLATION_ACTIVE_CAPTION_MS) return "healthy";
  return "waiting";
}

function translationHealthDetail(state, now = Date.now()) {
  if (!Number.isFinite(translationHealth.lastEventAt)) {
    if (state === "disconnected") return t("controller.healthRestartAction");
    return state === "recovering"
      ? t("controller.healthAutomaticRecovery")
      : t("controller.healthSpeakAction");
  }
  const elapsedSeconds = Math.max(0, Math.floor((now - translationHealth.lastEventAt) / 1000));
  const elapsed = elapsedSeconds < 2
    ? t("controller.healthUpdatedNow")
    : elapsedSeconds < 60
      ? t("controller.healthUpdatedSeconds", { seconds: elapsedSeconds })
      : t("controller.healthUpdatedMinutes", { minutes: Math.floor(elapsedSeconds / 60) });
  if (state === "disconnected") return `${t("controller.healthRestartAction")} · ${elapsed}`;
  if (state === "recovering") return `${t("controller.healthAutomaticRecovery")} · ${elapsed}`;
  if (state === "waiting") return `${t("controller.healthSpeakAction")} · ${elapsed}`;
  return elapsed;
}

function renderTranslationHealth(now = Date.now()) {
  if (isLiveActionStatusLocked) return;
  if (!translationHealth.isLive || !liveCallStatus || !healthLabel) return;
  refreshTranslationInputHealth(now);
  if (translationHealth.mediaWaiting && translationHealth.socketState === "open"
    && translationHealth.bridgeState !== "failed") {
    setControllerStatus("controller.waitingForParticipants", "waiting");
    return;
  }
  const state = translationHealthState(now);
  const key = `controller.health.${state}`;
  if (state !== lastRenderedHealthState) {
    healthLabel.dataset.i18n = key;
    healthLabel.textContent = t(key);
    liveCallStatus.dataset.connectionState = state;
    lastRenderedHealthState = state;
  }
  if (healthDetail) {
    healthDetail.textContent = translationHealthDetail(state, now);
    healthDetail.hidden = false;
  }
}

function syncLiveBridgeStatus(state) {
  const wasLive = translationHealth.isLive;
  translationHealth.isLive = Boolean(state?.armed && state.live);
  translationHealth.mediaWaiting = Boolean(state?.mediaWaiting);
  translationHealth.bridgeState = String(state?.bridge?.state ?? "idle");
  // A new call must earn its own healthy state; a recent event from the prior
  // session would otherwise make dead audio look healthy for several seconds.
  if (wasLive !== translationHealth.isLive) resetTranslationHealthEvents();
  renderTranslationHealth();
}

function isSupportedLanguage(language) {
  return ["en", "ko", "ja"].includes(language);
}

// ── Live Call: the desktop arms a session via Start Live Call; this console
// then shows Go-Live to flip it live for every participant. ────────────────
const liveCallGroup = document.getElementById("controller-live-call");
const goLiveButton = document.getElementById("controller-go-live");
const hostSpeakButton = document.getElementById("controller-host-speak");
const endLiveCallButton = document.getElementById("controller-end-live-call");
const enginePill = document.getElementById("controller-engine");
// Read-only pill for the admin-deployed Live Call engine. Fed by the bounded
// `bridge.engine` projection of live-call:get-state; text only, never markup.
function renderEnginePill(engine) {
  if (!enginePill) return;
  const state = ["connecting", "ready", "failed"].includes(engine?.state) ? engine.state : "";
  if (!state) {
    enginePill.hidden = true;
    enginePill.textContent = "";
    delete enginePill.dataset.state;
    return;
  }
  const key = state === "ready" ? "controller.engineReady" : state === "failed" ? "controller.engineFailed" : "controller.engineConnecting";
  const roles = Array.isArray(engine.roles) ? engine.roles : [];
  const detail = roles.map((row) => `${row.role}: ${row.model}`).join(" · ");
  enginePill.dataset.state = state;
  enginePill.dataset.i18n = key;
  enginePill.textContent = state === "failed" && typeof engine.code === "string" ? `${t(key)} (${engine.code})` : t(key);
  enginePill.title = detail;
  enginePill.hidden = false;
}
if (window.realtimeNoelDesktop?.getLiveCallState && liveCallGroup && goLiveButton && endLiveCallButton && liveCallStatus) {
  let isEndingLiveCall = false;
  let isGoingLive = false;
  // Elapsed "now playing" timer: ticks only while live, renders next to End.
  let liveStartedAtMs = null;
  let elapsedTimer = null;
  const renderElapsed = () => {
    if (!elapsedReadout || !Number.isFinite(liveStartedAtMs)) return;
    const totalSeconds = Math.max(0, Math.floor((Date.now() - liveStartedAtMs) / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    elapsedReadout.textContent = `${minutes}:${seconds}`;
  };
  const setLiveElapsed = (startedAtIso) => {
    const parsed = Date.parse(startedAtIso ?? "");
    if (!Number.isFinite(parsed)) return stopLiveElapsed();
    liveStartedAtMs = parsed;
    if (elapsedReadout) elapsedReadout.hidden = false;
    renderElapsed();
    if (!elapsedTimer) elapsedTimer = setInterval(renderElapsed, 1000);
  };
  const stopLiveElapsed = () => {
    liveStartedAtMs = null;
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    if (elapsedReadout) elapsedReadout.hidden = true;
  };
  const syncLiveCall = async () => {
    try {
      const state = await window.realtimeNoelDesktop.getLiveCallState();
      syncLiveBridgeStatus(state);
      liveCallGroup.hidden = !state?.armed;
      document.getElementById("controller-stop").hidden = Boolean(state?.armed);
      document.getElementById("controller-web-output-status").textContent = state?.live ? "진행 중" : state?.armed ? "준비 중" : "사용 안 함";
      if (state?.armed) {
        goLiveButton.disabled = isGoingLive || Boolean(state.live);
        goLiveButton.dataset.i18n = state.live && state.mediaWaiting
          ? "controller.waitingForParticipants" : state.live ? "controller.live" : "controller.goLive";
        goLiveButton.textContent = t(goLiveButton.dataset.i18n);
        goLiveButton.classList.toggle("is-live", Boolean(state.live && !state.mediaWaiting));
        // Host Speak only matters once the call is live and a guest may be
        // holding the speaking floor.
        if (hostSpeakButton) hostSpeakButton.hidden = !state.live;
        renderEnginePill(state.bridge?.engine ?? null);
        endLiveCallButton.disabled = isEndingLiveCall;
        if (state.live && state.liveStartedAt) setLiveElapsed(state.liveStartedAt);
        if (!state.live) stopLiveElapsed();
      } else {
        translationHealth.isLive = false;
        translationHealth.bridgeState = "idle";
        if (hostSpeakButton) hostSpeakButton.hidden = true;
        renderEnginePill(null);
        stopLiveElapsed();
        setControllerStatus("controller.captionsReady");
      }
    } catch {
      syncLiveBridgeStatus(null);
      liveCallGroup.hidden = true;
      stopLiveElapsed();
    }
  };
  hostSpeakButton?.addEventListener("click", async () => {
    if (!window.realtimeNoelDesktop?.hostSpeak) return;
    isLiveActionStatusLocked = true;
    hostSpeakButton.disabled = true;
    hostSpeakButton.setAttribute("aria-busy", "true");
    setControllerStatus("controller.reclaiming");
    try {
      const result = await window.realtimeNoelDesktop.hostSpeak();
      setControllerStatus(result?.ok ? "controller.hasFloor" : "controller.reclaimFailed");
    } catch {
      setControllerStatus("controller.reclaimFailed");
    } finally {
      isLiveActionStatusLocked = false;
      hostSpeakButton.disabled = false;
      hostSpeakButton.removeAttribute("aria-busy");
    }
  });
  goLiveButton.addEventListener("click", async () => {
    // 2026-08-31 fix: 상태 조회가 완료돼도 진행 중인 시작 요청의 잠금을 유지한다.
    if (isGoingLive) return;
    isGoingLive = true;
    isLiveActionStatusLocked = true;
    goLiveButton.disabled = true;
    goLiveButton.setAttribute("aria-busy", "true");
    setControllerStatus("controller.startingLive");
    try {
      const result = await window.realtimeNoelDesktop.goLiveCall();
      if (result?.ok) setControllerStatus("controller.liveStarted");
      else setControllerText(t("controller.goLiveFailedCode", { code: result?.code ?? "unknown" }));
    } catch {
      setControllerStatus("controller.goLiveFailed");
    } finally {
      isGoingLive = false;
      isLiveActionStatusLocked = false;
      goLiveButton.removeAttribute("aria-busy");
      void syncLiveCall();
    }
  });
  endLiveCallButton.addEventListener("click", async () => {
    if (!window.confirm(t("controller.endConfirm"))) return;
    isLiveActionStatusLocked = true;
    isEndingLiveCall = true;
    endLiveCallButton.disabled = true;
    endLiveCallButton.setAttribute("aria-busy", "true");
    setControllerStatus("controller.ending");
    try {
      const result = await window.realtimeNoelDesktop.endLiveCall();
      if (result?.ok === false) throw new Error(t("controller.endFailed"));
      liveCallGroup.hidden = true;
      setControllerText("");
      await syncLiveCall();
    } catch {
      liveCallGroup.hidden = false;
      setControllerStatus("controller.endFailed");
      endLiveCallButton.disabled = false;
    } finally {
      isEndingLiveCall = false;
      isLiveActionStatusLocked = false;
      endLiveCallButton.removeAttribute("aria-busy");
      if (!liveCallGroup.hidden) endLiveCallButton.disabled = false;
    }
  });
  void syncLiveCall();
  window.setInterval(() => { void syncLiveCall(); }, 3_000);
  window.setInterval(() => renderTranslationHealth(), 1_000);
}

// ── Drag-to-move: -webkit-app-region is unreliable on this transparent
// always-on-top window (macOS), so the drag strip streams pointer deltas to
// the main process, which moves the BrowserWindow. ─────────────────────────
const dragStrip = document.getElementById("controller-drag");
if (dragStrip && window.realtimeNoelDesktop?.moveControllerBy) {
  let dragPointerId = null;
  let lastX = 0;
  let lastY = 0;
  dragStrip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragPointerId = event.pointerId;
    lastX = event.screenX;
    lastY = event.screenY;
    dragStrip.setPointerCapture(event.pointerId);
  });
  dragStrip.addEventListener("pointermove", (event) => {
    if (dragPointerId !== event.pointerId) return;
    const deltaX = event.screenX - lastX;
    const deltaY = event.screenY - lastY;
    if (!deltaX && !deltaY) return;
    lastX = event.screenX;
    lastY = event.screenY;
    window.realtimeNoelDesktop.moveControllerBy(deltaX, deltaY);
  });
  const endDrag = (event) => {
    if (dragPointerId !== event.pointerId) return;
    dragPointerId = null;
    try { dragStrip.releasePointerCapture(event.pointerId); } catch { /* released */ }
  };
  dragStrip.addEventListener("pointerup", endDrag);
  dragStrip.addEventListener("pointercancel", endDrag);
}

// ── Fit-height: the window hugs the console exactly, so there is never an
// empty band above or below. The renderer measures, the main process clamps
// and resizes. ───
const consoleRoot = document.querySelector(".caption-controller-window");
if (consoleRoot && window.realtimeNoelDesktop?.fitControllerHeight && typeof ResizeObserver !== "undefined") {
  let lastRequestedHeight = 0;
  let lastRequestedWidth = 0;
  const requestFit = () => {
    const rect = consoleRoot.getBoundingClientRect();
    const height = Math.ceil(rect.height);
    // Width too: the console hugs its content, and the clusters change with the
    // session (Live Call group and Host Speak), so a fixed window
    // width leaves slack the right-hand cluster used to be pushed across.
    // A small buffer, because the shell is capped at the window width: without
    // it the row WRAPS the moment a control grows (the elapsed readout gains a
    // character about an hour into a call) instead of the window widening, and
    // the console silently becomes two rows tall mid-session.
    const width = Math.ceil(rect.width) + 16;
    if (!height) return;
    if (height === lastRequestedHeight && width === lastRequestedWidth) return;
    lastRequestedHeight = height;
    lastRequestedWidth = width;
    window.realtimeNoelDesktop.fitControllerHeight(height, width);
  };
  new ResizeObserver(requestFit).observe(consoleRoot);
  requestFit();
}

// ── Momentary caption hide ────────────────────────────────────────────────────
// A video is playing and the captions should be off screen for a moment. This is
// NOT the overlay setting: the engine keeps running, lines keep being recorded,
// and because the flag lives in the main process's memory, quitting clears it.
// The button carries the state visibly — a mute the user forgot about would
// otherwise look exactly like broken captions.
const muteCaptionsButton = document.getElementById("controller-mute-captions");
if (muteCaptionsButton && window.realtimeNoelDesktop?.setOverlaysMuted) {
  const paint = (muted) => {
    muteCaptionsButton.setAttribute("aria-pressed", String(muted));
    muteCaptionsButton.classList.toggle("is-muted", muted);
    muteCaptionsButton.textContent = muted ? "자막 다시 표시" : "자막 잠시 숨기기";
    const key = muted ? "controller.showCaptions" : "controller.hideCaptions";
    muteCaptionsButton.dataset.i18nTitle = key;
    muteCaptionsButton.dataset.i18nAria = key;
    muteCaptionsButton.title = t(key);
    muteCaptionsButton.setAttribute("aria-label", t(key));
    // The icon flips via CSS on .is-muted -- both SVGs are in the markup, since
    // innerHTML is forbidden here and pinned by two tests.
  };
  muteCaptionsButton.addEventListener("click", async () => {
    const next = muteCaptionsButton.getAttribute("aria-pressed") !== "true";
    // Paint from what the main process reports, not from the optimistic guess:
    // a rejected origin check returns the unchanged value.
    paint(Boolean(await window.realtimeNoelDesktop.setOverlaysMuted(next)));
  });
  // The controller can be reopened mid-session, so adopt the real state.
  void window.realtimeNoelDesktop.getOverlaysMuted?.().then((muted) => paint(Boolean(muted))).catch(() => {});
} else if (muteCaptionsButton) {
  muteCaptionsButton.hidden = true;
}


function renderScreenCheckboxes(state) {
  document.documentElement.style.setProperty("--controller-available-height", `${Math.max(200, Number(state.controllerAvailableHeight) || 720)}px`);
  const container = document.getElementById("controller-display-options");
  if (!container) return;
  container.replaceChildren();
  const controllerDisplay = state.displays.find((display) => display.isInternal) ?? state.displays.find((display) => display.isPrimary);
  document.getElementById("controller-display-location").textContent = controllerDisplay?.isInternal ? "MacBook 내장 화면" : controllerDisplay?.label ?? "화면 연결 확인 중";
  const count = state.displays.filter((display) => display.isSelected).length;
  document.getElementById("controller-output-count").textContent = count ? `${count}개 화면에 표시` : "로컬 화면 표시 안 함";
  for (const display of state.displays) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = display.isSelected === true;
    input.disabled = isSelectingOverlayDisplay;
    label.append(input, document.createTextNode(display.isInternal ? "MacBook 내장 화면" : display.label));
    input.addEventListener("change", async () => {
      const ids = state.displays.filter((candidate) => String(candidate.id) === String(display.id) ? input.checked : candidate.isSelected).map((candidate) => String(candidate.id));
      isSelectingOverlayDisplay = true;
      for (const input of container.querySelectorAll("input")) input.disabled = true;
      try {
        overlayDisplayState = normalizeOverlayDisplayState(await window.realtimeNoelDesktop.selectOverlayDisplays(ids));
      } catch { await refreshOverlayDisplays(); }
      finally { isSelectingOverlayDisplay = false; renderOverlayDisplayState(overlayDisplayState); }
    });
    container.append(label);
  }
}

let openControllerPopover = null;
let popoverTrigger = null;
function closeControllerPopover(restoreFocus = true) {
  if (!openControllerPopover) return;
  openControllerPopover.hidden = true;
  openControllerPopover = null;
  popoverTrigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) popoverTrigger?.focus();
  appearanceSender.flush();
}
for (const trigger of document.querySelectorAll("[data-controller-popover]")) {
  trigger.addEventListener("click", () => {
    const panel = document.getElementById(trigger.dataset.controllerPopover);
    const wasOpen = panel === openControllerPopover;
    closeControllerPopover(false);
    if (wasOpen) return;
    openControllerPopover = panel;
    popoverTrigger = trigger;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    panel.querySelector("button,input")?.focus();
  });
}
for (const button of document.querySelectorAll("[data-close-popover]")) button.addEventListener("click", () => closeControllerPopover());
document.addEventListener("keydown", (event) => {
  if (!openControllerPopover) return;
  if (event.key === "Escape") { event.preventDefault(); closeControllerPopover(); }
  if (event.key === "Tab") {
    const focusable = [...openControllerPopover.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled)")];
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
document.addEventListener("pointerdown", (event) => {
  if (openControllerPopover && !openControllerPopover.contains(event.target) && !popoverTrigger?.contains(event.target)) closeControllerPopover(false);
});
window.addEventListener("beforeunload", () => appearanceSender.close(), { once: true });

mountSpeakerController(document.getElementById("controller-speaker-popover"), document.getElementById("controller-current-speaker"), window.realtimeNoelDesktop);

initSubtitleControls();
