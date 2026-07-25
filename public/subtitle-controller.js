import {
  applyDocumentLanguage,
  applyTranslations,
  initLanguage,
  subscribe as subscribeToLanguage,
  t,
} from "./subtitle-i18n.js";

const DEFAULT_SUBTITLE = {
  translationLanguages: ["en", "ko"],
  outputMode: "captions",
  voiceProvider: "gemini",
  translationFontSize: 38,
  verticalOffset: 48,
  opacity: 0.92,
  position: "bottom-center",
  subtitlePositions: { en: "bottom-center", ko: "bottom-center", ja: "top-center" },
};

const opacityInput = document.getElementById("controller-opacity");
const opacityValue = document.getElementById("controller-opacity-value");
const fontSize = document.getElementById("controller-font-size");
const gapValue = document.getElementById("controller-gap-value");
const vuFill = document.getElementById("controller-vu-fill");
const elapsedReadout = document.getElementById("controller-elapsed");
const positionButtons = [...document.querySelectorAll("[data-controller-position]")];
const voiceProviderGroup = document.getElementById("controller-voice-provider");
const voiceProviderButtons = [...document.querySelectorAll("[data-controller-voice-provider]")];
let settings = { ...DEFAULT_SUBTITLE };
let ws = null;

// The dashboard owns the language choice; this window reads the same key and
// repaints its own labels whenever it changes.
initLanguage();
applyDocumentLanguage(document);
applyTranslations(document);
window.addEventListener("storage", (event) => {
  if (event?.key === "realtime-noel-ui-language") initLanguage();
});
subscribeToLanguage(() => {
  applyDocumentLanguage(document);
  applyTranslations(document);
  renderSettings();
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
document.getElementById("controller-font-down")?.addEventListener("click", () => sendControl({ command: "font", delta: -2 }));
document.getElementById("controller-font-up")?.addEventListener("click", () => sendControl({ command: "font", delta: 2 }));
// Vertical gap: how far the subtitle sits from its anchored screen edge.
document.getElementById("controller-gap-down")?.addEventListener("click", () => sendControl({ command: "offset", delta: -8 }));
document.getElementById("controller-gap-up")?.addEventListener("click", () => sendControl({ command: "offset", delta: 8 }));
opacityInput?.addEventListener("input", () => updateOpacityReadout(Number(opacityInput.value)));
opacityInput?.addEventListener("change", () => sendControl({ command: "opacity", opacity: Number(opacityInput.value) }));
for (const button of positionButtons) {
  button.addEventListener("click", () => sendControl({ command: "position", position: button.dataset.controllerPosition }));
}
for (const button of voiceProviderButtons) {
  button.addEventListener("click", () => {
    sendControl({ command: "voice-provider", voiceProvider: button.dataset.controllerVoiceProvider });
  });
}

connect();

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "settings" && message.settings?.subtitle) {
      settings = { ...DEFAULT_SUBTITLE, ...message.settings.subtitle };
      renderSettings();
    }
    if (message.type === "subtitle:input-status") updateVuMeter(message);
  });
  ws.addEventListener("close", () => setTimeout(connect, 1000));
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
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "subtitle:control", ...payload }));
}

function renderSettings() {
  const languages = Array.isArray(settings.translationLanguages) && settings.translationLanguages.length
    ? settings.translationLanguages.filter(isSupportedLanguage)
    : DEFAULT_SUBTITLE.translationLanguages;
  if (fontSize) fontSize.textContent = `${Math.round(Number(settings.translationFontSize) || DEFAULT_SUBTITLE.translationFontSize)}px`;
  if (gapValue) gapValue.textContent = String(Math.round(Number(settings.verticalOffset ?? DEFAULT_SUBTITLE.verticalOffset)));
  if (opacityInput) opacityInput.value = String(Number(settings.opacity) || DEFAULT_SUBTITLE.opacity);
  updateOpacityReadout(Number(settings.opacity) || DEFAULT_SUBTITLE.opacity);
  const activePosition = settings.subtitlePositions?.[languages[0]] || settings.position || DEFAULT_SUBTITLE.position;
  for (const button of positionButtons) {
    button.classList.toggle("active", button.dataset.controllerPosition === activePosition);
  }
  const isCaptionsOnly = settings.outputMode === "captions";
  if (voiceProviderGroup) voiceProviderGroup.hidden = isCaptionsOnly;
  for (const button of voiceProviderButtons) {
    const isActive = button.dataset.controllerVoiceProvider === (settings.voiceProvider === "openai" ? "openai" : "gemini");
    button.classList.toggle("active", isActive);
    button.ariaChecked = String(isActive);
    button.setAttribute("aria-checked", String(isActive));
  }
}

function updateOpacityReadout(opacity) {
  document.documentElement.style.setProperty("--subtitle-opacity", String(opacity));
  if (opacityValue) opacityValue.textContent = `${Math.round(opacity * 100)}%`;
}

// Status writes go through these two helpers so the data-i18n marker stays in
// step with the text: keyed messages survive a language switch, one-off
// interpolated ones do not carry a key.
function setControllerStatus(key) {
  if (!liveCallStatus) return;
  liveCallStatus.dataset.i18n = key;
  liveCallStatus.textContent = t(key);
}

function setControllerText(text) {
  if (!liveCallStatus) return;
  delete liveCallStatus.dataset.i18n;
  liveCallStatus.textContent = text;
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
const liveCallStatus = document.getElementById("controller-live-call-status");
if (window.realtimeNoelDesktop?.getLiveCallState && liveCallGroup && goLiveButton && endLiveCallButton && liveCallStatus) {
  let isEndingLiveCall = false;
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
      liveCallGroup.hidden = !state?.armed;
      if (state?.armed) {
        goLiveButton.disabled = Boolean(state.live);
        goLiveButton.dataset.i18n = state.live ? "controller.live" : "controller.goLive";
        goLiveButton.textContent = t(goLiveButton.dataset.i18n);
        goLiveButton.classList.toggle("is-live", Boolean(state.live));
        // Host Speak only matters once the call is live and a guest may be
        // holding the speaking floor.
        if (hostSpeakButton) hostSpeakButton.hidden = !state.live;
        endLiveCallButton.disabled = isEndingLiveCall;
        if (state.live && state.liveStartedAt) setLiveElapsed(state.liveStartedAt);
        if (!state.live) stopLiveElapsed();
      } else {
        if (hostSpeakButton) hostSpeakButton.hidden = true;
        stopLiveElapsed();
        setControllerStatus("controller.captionsReady");
      }
    } catch {
      liveCallGroup.hidden = true;
      stopLiveElapsed();
    }
  };
  hostSpeakButton?.addEventListener("click", async () => {
    if (!window.realtimeNoelDesktop?.hostSpeak) return;
    hostSpeakButton.disabled = true;
    hostSpeakButton.setAttribute("aria-busy", "true");
    setControllerStatus("controller.reclaiming");
    try {
      const result = await window.realtimeNoelDesktop.hostSpeak();
      setControllerStatus(result?.ok ? "controller.hasFloor" : "controller.reclaimFailed");
    } catch {
      setControllerStatus("controller.reclaimFailed");
    } finally {
      hostSpeakButton.disabled = false;
      hostSpeakButton.removeAttribute("aria-busy");
    }
  });
  goLiveButton.addEventListener("click", async () => {
    goLiveButton.disabled = true;
    setControllerStatus("controller.startingLive");
    try {
      const result = await window.realtimeNoelDesktop.goLiveCall();
      if (result?.ok) setControllerStatus("controller.liveStarted");
      else setControllerText(t("controller.goLiveFailedCode", { code: result?.code ?? "unknown" }));
    } catch {
      setControllerStatus("controller.goLiveFailed");
    } finally {
      void syncLiveCall();
    }
  });
  endLiveCallButton.addEventListener("click", async () => {
    if (!window.confirm(t("controller.endConfirm"))) return;
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
      endLiveCallButton.removeAttribute("aria-busy");
      if (!liveCallGroup.hidden) endLiveCallButton.disabled = false;
    }
  });
  void syncLiveCall();
  window.setInterval(() => { void syncLiveCall(); }, 3_000);
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
// empty band above or below — even when the voice-provider row appears in
// audio mode. The renderer measures, the main process clamps and resizes. ───
const consoleRoot = document.querySelector(".caption-controller-window");
if (consoleRoot && window.realtimeNoelDesktop?.fitControllerHeight && typeof ResizeObserver !== "undefined") {
  let lastRequestedHeight = 0;
  const requestFit = () => {
    const height = Math.ceil(consoleRoot.getBoundingClientRect().height);
    if (!height || height === lastRequestedHeight) return;
    lastRequestedHeight = height;
    window.realtimeNoelDesktop.fitControllerHeight(height);
  };
  new ResizeObserver(requestFit).observe(consoleRoot);
  requestFit();
}
