// Workspace chrome for the desktop dashboard: page routing between
// Captions / Live Call / Records / Settings,
// the footer Restart control, and the local Live Call draft. This file owns
// presentation glue only — all caption/session logic stays in
// subtitle-dashboard.js, which binds by element id and keeps working
// regardless of which page a control lives on.
//
// It is also the page's i18n owner: it restores the stored UI language, runs
// the declarative data-i18n pass, and re-runs it whenever the language changes.

import {
  applyDocumentLanguage,
  applyTranslations,
  initLanguage,
  readStoredLanguage,
  setLanguage,
  subscribe,
  t,
} from "./subtitle-i18n.js";
import { mountSystemLanguageButton } from "./system-language-button.js";
import { SYSTEM_LANGUAGE_STORAGE_KEY } from "./system-language.js";

const PAGE_TITLE_KEYS = {
  captions: "page.captions.title",
  livecall: "page.livecall.title",
  records: "page.records.title",
  settings: "page.settings.title",
};

const LIVE_DRAFT_STORAGE_KEY = "realtime-noel-live-draft";

const main = document.querySelector("main.subtitle-dashboard");
const form = document.getElementById("subtitle-settings");
const navLinks = document.querySelectorAll("[data-workspace-nav]");
const pages = document.querySelectorAll("[data-workspace-page]");
const pageTitle = document.getElementById("workspace-page-title");
const footer = document.querySelector(".workspace-footer");

// Restore the stored choice and paint every static string before anything else
// reads the DOM.
initLanguage();
applyDocumentLanguage(document);
applyTranslations(document);

function activatePage(page) {
  if (!PAGE_TITLE_KEYS[page] || !main) return;
  main.dataset.activePage = page;
  for (const section of pages) {
    section.classList.toggle("is-active", section.dataset.workspacePage === page);
  }
  for (const link of navLinks) {
    const isCurrent = link.dataset.workspaceNav === page && link.closest("nav");
    link.classList.toggle("is-current", Boolean(isCurrent));
    if (link.closest("nav")) {
      if (isCurrent) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }
  if (pageTitle) {
    pageTitle.dataset.i18n = PAGE_TITLE_KEYS[page];
    pageTitle.textContent = t(PAGE_TITLE_KEYS[page]);
  }
  // The caption session footer only makes sense on the captions page.
  if (footer) footer.hidden = page !== "captions";
  if (page === "settings") {
    const drawer = document.querySelector("details.settings-drawer");
    if (drawer) drawer.open = true;
  }
}

for (const link of navLinks) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    activatePage(link.dataset.workspaceNav ?? "captions");
  });
}

function fieldValue(name) {
  const field = form?.elements?.[name];
  if (!field) return "";
  return typeof field.value === "string" ? field.value : "";
}

// ── Footer: overlay status chip + Restart ─────────────────────────────────

const overlayCheckbox = document.getElementById("overlay-enabled");
const overlayChip = document.getElementById("overlay-status-chip");
const startButton = document.getElementById("start-subtitles");
const stopButton = document.getElementById("stop-subtitles");
const restartButton = document.getElementById("restart-subtitles");

function syncOverlayChip() {
  if (!overlayChip) return;
  const isOn = Boolean(overlayCheckbox?.checked);
  overlayChip.dataset.i18n = isOn ? "player.overlayActive" : "player.overlayInactive";
  overlayChip.textContent = t(overlayChip.dataset.i18n);
  overlayChip.classList.toggle("is-active", isOn);
}
overlayCheckbox?.addEventListener("change", syncOverlayChip);
window.setTimeout(syncOverlayChip, 800);
syncOverlayChip();

restartButton?.addEventListener("click", () => {
  if (!startButton || !stopButton) return;
  if (stopButton.disabled) {
    // Nothing running — Restart degrades to a plain start.
    startButton.click();
    return;
  }
  stopButton.click();
  const startedAt = Date.now();
  const waitForIdle = window.setInterval(() => {
    if (!startButton.disabled) {
      window.clearInterval(waitForIdle);
      startButton.click();
    } else if (Date.now() - startedAt > 8_000) {
      window.clearInterval(waitForIdle);
    }
  }, 250);
});

// ── Live Call draft: local persistence + cover preview ────────────────────

const DRAFT_FIELDS = ["liveDraftTitle", "liveDraftDate", "liveDraftTime", "liveDraftCapacity"];
const MAX_COVER_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_COVER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function restoreLiveDraft() {
  try {
    const raw = localStorage.getItem(LIVE_DRAFT_STORAGE_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    for (const name of DRAFT_FIELDS) {
      const field = form?.elements?.[name];
      if (field && typeof draft[name] === "string" && draft[name]) field.value = draft[name];
    }
  } catch {
    // A corrupt draft never blocks the page.
  }
}

function persistLiveDraft() {
  try {
    const draft = Object.fromEntries(DRAFT_FIELDS.map((name) => [name, fieldValue(name)]));
    localStorage.setItem(LIVE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage may be unavailable; the workspace form is the source of truth.
  }
}

for (const name of DRAFT_FIELDS) {
  for (const field of form?.querySelectorAll(`[name="${name}"]`) ?? []) {
    field.addEventListener("change", persistLiveDraft);
    field.addEventListener("input", persistLiveDraft);
  }
}
restoreLiveDraft();

const coverButton = document.getElementById("live-draft-cover-button");
const coverInput = document.getElementById("live-draft-cover");
const coverPreview = document.getElementById("live-draft-cover-preview");
const coverStatus = document.getElementById("live-draft-cover-status");
let liveDraftCoverData = null;
let liveDraftCoverPreviewUrl = "";

function setCoverStatus(message, isError = false) {
  if (!coverStatus) return;
  delete coverStatus.dataset.i18n;
  coverStatus.textContent = message;
  coverStatus.classList.toggle("is-error", isError);
}

function hasValidCoverImageSignature(bytes, contentType) {
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    return bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a;
  }
  if (contentType === "image/webp") {
    return String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  }
  return false;
}

async function serializeCoverImage(file) {
  if (!ALLOWED_COVER_IMAGE_TYPES.has(file.type)) {
    throw new Error(t("live.coverInvalidType"));
  }
  if (file.size <= 0 || file.size > MAX_COVER_IMAGE_BYTES) {
    throw new Error(t("live.coverTooLarge"));
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasValidCoverImageSignature(bytes, file.type)) {
    throw new Error(t("live.coverSignatureMismatch"));
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return {
    name: file.name.normalize("NFC").slice(0, 255),
    contentType: file.type,
    size: file.size,
    base64: window.btoa(binary),
  };
}

function coverSizeSummary(cover) {
  return `${cover.name} · ${(cover.size / 1024 / 1024).toFixed(1)}MB`;
}

coverButton?.addEventListener("click", () => coverInput?.click());
coverInput?.addEventListener("change", async () => {
  const file = coverInput.files?.[0];
  liveDraftCoverData = null;
  if (!file) {
    setCoverStatus(t("live.coverNone"));
    if (coverPreview) coverPreview.hidden = true;
    return;
  }
  setCoverStatus(t("live.coverPreparing"));
  try {
    const serialized = await serializeCoverImage(file);
    if (coverInput.files?.[0] !== file) return;
    liveDraftCoverData = serialized;
    if (liveDraftCoverPreviewUrl) URL.revokeObjectURL(liveDraftCoverPreviewUrl);
    liveDraftCoverPreviewUrl = URL.createObjectURL(file);
    if (coverPreview) {
      coverPreview.src = liveDraftCoverPreviewUrl;
      coverPreview.alt = t("live.coverSelected", { name: serialized.name });
      coverPreview.hidden = false;
    }
    setCoverStatus(coverSizeSummary(serialized));
  } catch (error) {
    if (coverPreview) coverPreview.hidden = true;
    setCoverStatus(error instanceof Error ? error.message : t("live.coverFailed"), true);
  }
});


// ── Live Call language selection ────────────────────────────────────────────
// Live Call has its own language dropdown (name="liveCallTranslationLanguages").
// When nothing is selected there, it inherits the caption subtitle languages —
// the pre-split behavior (spoken language is auto-detected, viewers pick their
// own display language on the web).

const LANGUAGE_MIRROR_LABELS = { en: "English", ko: "한국어", ja: "日本語" };

function selectedLiveCallLanguages() {
  const explicit = [...document.querySelectorAll('input[name="liveCallTranslationLanguages"]:checked')].map((input) => input.value);
  if (explicit.length) return explicit;
  return [...document.querySelectorAll('input[name="translationLanguages"]:checked')].map((input) => input.value);
}

function syncLiveDraftLanguages() {
  const container = document.getElementById("live-draft-languages");
  if (!container) return;
  const selected = selectedLiveCallLanguages();
  container.replaceChildren(...(selected.length ? selected : ["en", "ko"]).map((code) => {
    const chip = document.createElement("span");
    chip.className = "live-draft-language-chip";
    chip.textContent = LANGUAGE_MIRROR_LABELS[code] ?? code.toUpperCase();
    return chip;
  }));
}
form?.addEventListener("change", syncLiveDraftLanguages);
window.setTimeout(syncLiveDraftLanguages, 800);
syncLiveDraftLanguages();



// ── One-button Live Call start: session + invite are created by the main
// process with the stored host cookies; the stage overlay window (countdown
// + QR + access code) opens instead of the dashboard web page. ────────────

const startLiveCallButton = document.getElementById("schedule-live-call");
const liveWorkspaceStatus = document.getElementById("live-workspace-status");

function setLiveStatus(message) {
  if (!liveWorkspaceStatus) return;
  delete liveWorkspaceStatus.dataset.i18n;
  liveWorkspaceStatus.textContent = message;
}

function liveDraftScheduledAt() {
  const date = fieldValue("liveDraftDate");
  if (!date) return null;
  const time = fieldValue("liveDraftTime") || "09:00";
  const stamp = Date.parse(`${date}T${time}`);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

startLiveCallButton?.addEventListener("click", async () => {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.startLiveCall) {
    setLiveStatus(t("live.desktopOnly"));
    return;
  }
  startLiveCallButton.disabled = true;
  startLiveCallButton.setAttribute("aria-busy", "true");
  setLiveStatus(t("live.creating"));
  const selectedCover = coverInput?.files?.[0];
  try {
    if (selectedCover && !liveDraftCoverData) {
      liveDraftCoverData = await serializeCoverImage(selectedCover);
      setCoverStatus(coverSizeSummary(liveDraftCoverData));
    }
    const draft = {
      title: fieldValue("liveDraftTitle"),
      scheduledAt: liveDraftScheduledAt(),
      maxViewers: Number.parseInt(fieldValue("liveDraftCapacity"), 10) || 200,
      participantSpeakingEnabled: Boolean(document.querySelector('input[name="liveDraftSpeaking"]')?.checked),
      languages: selectedLiveCallLanguages(),
      coverImage: liveDraftCoverData,
    };
    const result = await bridge.startLiveCall(draft);
    if (result?.code === "HOST_LOGIN_REQUIRED" || result?.code === "HOST_LOGIN_REJECTED") {
      const authorizationMessage = result.code === "HOST_LOGIN_REJECTED"
        ? t("live.hostLoginRejected")
        : t("live.hostLoginRequired");
      hostAccountId = "";
      setHostLoginNotice("settings.hostSignedOut", true);
      setLiveStatus(authorizationMessage);
      if (hostLoginSection) hostLoginSection.hidden = false;
      if (hostLoginStatus) {
        delete hostLoginStatus.dataset.i18n;
        hostLoginStatus.textContent = authorizationMessage;
        hostLoginStatus.classList.add("is-error");
      }
      activatePage("settings");
      hostLoginSection?.scrollIntoView({ behavior: "smooth", block: "center" });
      openHostLoginButton?.focus();
      return;
    }
    setLiveStatus(result?.ok
      ? t("live.stageUp", { code: result.admissionCode ?? "?" })
      : liveCallFailureMessage(result?.code, "live.startFailed"));
  } catch (error) {
    const message = error instanceof Error ? error.message : t("live.startFailedPlain");
    setLiveStatus(message);
    if (selectedCover) setCoverStatus(message, true);
  } finally {
    startLiveCallButton.disabled = false;
    startLiveCallButton.removeAttribute("aria-busy");
  }
});

// Human-readable start failures; unknown codes fall back to a generic retry
// message so raw machine codes never reach the status line.
const LIVE_CALL_FAILURE_CODES = new Set([
  "HTTP_400",
  "LIVE_CALL_DISABLED",
  "LIVE_CALL_ALREADY_ARMED",
  "LIVE_CALL_START_IN_PROGRESS",
  "NETWORK_UNAVAILABLE",
  "LOGIN_RATE_LIMITED",
  "INVALID_COVER_IMAGE",
  "COVER_UPLOAD_FAILED",
  "INVITE_CREATE_FAILED",
  "STAGE_OPEN_FAILED",
  "SESSION_NOT_PREPARING",
  "INVALID_SESSION_ID",
]);

function liveCallFailureMessage(code, fallbackKey) {
  if (LIVE_CALL_FAILURE_CODES.has(code)) return t(`live.err.${code}`);
  return t(fallbackKey, { code: code ?? "unknown" });
}

// ── Pre-registered sessions: register now, start later with the SAME saved
// title, cover image, and schedule. List renders with replaceChildren (no
// innerHTML — enforced by tests). ────────────────────────────────────────────

const registerLiveCallButton = document.getElementById("register-live-call");
const registeredSessionList = document.getElementById("live-registered-list");
const refreshRegisteredButton = document.getElementById("refresh-registered-sessions");

async function collectLiveDraft() {
  const selectedCover = coverInput?.files?.[0];
  if (selectedCover && !liveDraftCoverData) {
    liveDraftCoverData = await serializeCoverImage(selectedCover);
    setCoverStatus(coverSizeSummary(liveDraftCoverData));
  }
  return {
    title: fieldValue("liveDraftTitle"),
    scheduledAt: liveDraftScheduledAt(),
    maxViewers: Number.parseInt(fieldValue("liveDraftCapacity"), 10) || 200,
    participantSpeakingEnabled: Boolean(document.querySelector('input[name="liveDraftSpeaking"]')?.checked),
    languages: selectedLiveCallLanguages(),
    coverImage: liveDraftCoverData,
  };
}

function formatRegisteredSchedule(scheduledAt) {
  if (!scheduledAt) return t("live.registeredStartNow");
  const stamp = Date.parse(scheduledAt);
  if (!Number.isFinite(stamp)) return t("live.registeredStartNow");
  const at = new Date(stamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

let registeredSessionsSnapshot = { sessions: [], statusText: "" };

function renderRegisteredSessions(sessions, statusText = "") {
  registeredSessionsSnapshot = { sessions, statusText };
  if (!registeredSessionList) return;
  const rows = [];
  if (statusText) {
    const note = document.createElement("p");
    note.className = "pt-output-help";
    note.textContent = statusText;
    rows.push(note);
  }
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = "live-registered-item";
    const meta = document.createElement("div");
    meta.className = "live-registered-meta";
    const title = document.createElement("strong");
    title.textContent = session.title || t("live.registeredNoTitle");
    const schedule = document.createElement("span");
    schedule.textContent = formatRegisteredSchedule(session.scheduledAt);
    meta.append(title, schedule);
    const startButton = document.createElement("button");
    startButton.type = "button";
    startButton.className = "accent compact";
    startButton.textContent = t("live.registeredStart");
    startButton.addEventListener("click", () => { void startRegisteredSession(session.id, startButton); });
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "compact live-registered-delete";
    deleteButton.textContent = t("live.registeredDelete");
    // Two-click confirm: the first click only re-labels the button, so a slip
    // never ends a registration; the confirm state resets on the next render.
    deleteButton.addEventListener("click", () => {
      if (deleteButton.dataset.confirming !== "true") {
        deleteButton.dataset.confirming = "true";
        deleteButton.textContent = t("live.registeredDeleteConfirm");
        return;
      }
      void deleteRegisteredSession(session.id, deleteButton);
    });
    row.append(meta, startButton, deleteButton);
    rows.push(row);
  }
  registeredSessionList.replaceChildren(...rows);
}

async function deleteRegisteredSession(sessionId, button) {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.deleteRegisteredLiveCall) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await bridge.deleteRegisteredLiveCall(sessionId);
    setLiveStatus(result?.ok
      ? t("live.registeredDeleted")
      : liveCallFailureMessage(result?.code, "live.registeredDeleteFailed"));
    if (result?.ok) {
      void refreshRegisteredSessions({ quiet: true });
      return;
    }
  } catch {
    setLiveStatus(t("live.registeredDeleteFailed", { code: "unknown" }));
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    delete button.dataset.confirming;
    button.textContent = t("live.registeredDelete");
  }
}

async function refreshRegisteredSessions({ quiet = false } = {}) {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.listRegisteredLiveCalls || !registeredSessionList) return;
  if (!quiet) renderRegisteredSessions([], t("live.loadingRegistered"));
  try {
    const result = await bridge.listRegisteredLiveCalls();
    if (!result?.ok) {
      renderRegisteredSessions([], liveCallFailureMessage(result?.code, "live.registeredLoadFailed"));
      return;
    }
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    renderRegisteredSessions(sessions, sessions.length ? "" : t("live.registeredEmpty"));
  } catch {
    renderRegisteredSessions([], t("live.registeredLoadFailed"));
  }
}

async function startRegisteredSession(sessionId, button) {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.startRegisteredLiveCall) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setLiveStatus(t("live.loadingRegistered"));
  try {
    const result = await bridge.startRegisteredLiveCall(sessionId);
    setLiveStatus(result?.ok
      ? t("live.stageUp", { code: result.admissionCode ?? "?" })
      : liveCallFailureMessage(result?.code, "live.registeredStartFailed"));
    if (result?.ok) void refreshRegisteredSessions({ quiet: true });
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

registerLiveCallButton?.addEventListener("click", async () => {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.registerLiveCall) {
    setLiveStatus(t("live.desktopOnly"));
    return;
  }
  registerLiveCallButton.disabled = true;
  registerLiveCallButton.setAttribute("aria-busy", "true");
  setLiveStatus(t("live.registering"));
  try {
    const draft = await collectLiveDraft();
    const result = await bridge.registerLiveCall(draft);
    setLiveStatus(result?.ok
      ? t("live.registered.ok", { title: result.title || t("live.registeredNoTitle") })
      : liveCallFailureMessage(result?.code, "live.registerFailed"));
    if (result?.ok) void refreshRegisteredSessions({ quiet: true });
  } catch (error) {
    setLiveStatus(error instanceof Error ? error.message : t("live.registerFailedPlain"));
  } finally {
    registerLiveCallButton.disabled = false;
    registerLiveCallButton.removeAttribute("aria-busy");
  }
});

refreshRegisteredButton?.addEventListener("click", () => { void refreshRegisteredSessions(); });
if (window.realtimeNoelDesktop?.listRegisteredLiveCalls) void refreshRegisteredSessions({ quiet: true });


// ── Shared host session ──────────────────────────────────────────────────

const hostLoginSection = document.getElementById("live-host-login-section");
const hostLoginStatus = document.getElementById("live-host-login-status");
const hostAccount = document.getElementById("live-host-account");
const openHostLoginButton = document.getElementById("open-live-host-login");
const logoutHostSessionButton = document.getElementById("logout-live-host-session");
let hostAccountId = "";
let hostLoginNotice = { key: "settings.hostSessionChecking", values: undefined, isError: false };
let hostSessionRequest = null;
let isHostSessionActionPending = false;

function renderHostLoginStatus() {
  if (hostAccount) hostAccount.textContent = hostAccountId || t("settings.hostSignedOut");
  if (hostLoginStatus) {
    delete hostLoginStatus.dataset.i18n;
    hostLoginStatus.textContent = t(hostLoginNotice.key, hostLoginNotice.values);
    hostLoginStatus.classList.toggle("is-error", hostLoginNotice.isError);
  }
  if (openHostLoginButton) openHostLoginButton.hidden = Boolean(hostAccountId);
  if (logoutHostSessionButton) logoutHostSessionButton.hidden = !hostAccountId;
  for (const button of [openHostLoginButton, logoutHostSessionButton]) {
    if (!button) continue;
    button.disabled = isHostSessionActionPending;
    if (isHostSessionActionPending) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }
}

function setHostLoginNotice(key, isError = false, values) {
  hostLoginNotice = { key, isError, values };
  renderHostLoginStatus();
}

// Hidden desktop-only sections must not leave gaps in the settings ordinals.
function renumberConfigSections() {
  for (const page of document.querySelectorAll("[data-workspace-page]")) {
    let ordinal = 0;
    for (const marker of page.querySelectorAll("[data-cfg-ordinal]")) {
      const section = marker.closest("section");
      if (section?.hidden) { marker.textContent = ""; continue; }
      ordinal += 1;
      marker.textContent = String(ordinal);
    }
  }
}
renumberConfigSections();

function acceptHostSession(result) {
  if (result?.ok && typeof result.data?.userId === "string" && result.data.userId) {
    hostAccountId = result.data.userId;
    setHostLoginNotice("settings.hostSessionReady");
    return true;
  }
  if (result?.code === "HOST_LOGIN_REQUIRED" || result?.code === "HOST_LOGIN_REJECTED") {
    hostAccountId = "";
    setHostLoginNotice("settings.hostSignedOut", true);
  } else if (result?.code === "RATE_LIMITED" && Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds > 0) {
    setHostLoginNotice("hostSession.rateLimited", true, { seconds: result.retryAfterSeconds });
  } else {
    // A transport failure is not evidence that the previously known account signed out.
    setHostLoginNotice("settings.hostSessionUnavailable", true);
  }
  return false;
}

function refreshHostLoginStatus() {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.getHostSession || !hostLoginSection || isHostSessionActionPending) return Promise.resolve();
  if (hostSessionRequest) return hostSessionRequest;
  hostLoginSection.hidden = false;
  renumberConfigSections();
  hostSessionRequest = (async () => {
    try { acceptHostSession(await bridge.getHostSession()); }
    catch { setHostLoginNotice("settings.hostSessionUnavailable", true); }
  })().finally(() => { hostSessionRequest = null; });
  return hostSessionRequest;
}

openHostLoginButton?.addEventListener("click", async () => {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.openHostLogin || isHostSessionActionPending) return;
  isHostSessionActionPending = true;
  setHostLoginNotice("settings.hostSigningIn");
  try {
    await hostSessionRequest;
    const result = await bridge.openHostLogin();
    if (result?.code === "LOGIN_CANCELLED") setHostLoginNotice("settings.hostLoginCancelled");
    else if (result?.code === "LIVE_SESSION_ACTIVE") setHostLoginNotice("settings.hostLogoutLive", true);
    else acceptHostSession(result);
  } catch { setHostLoginNotice("settings.hostSessionUnavailable", true); }
  finally { isHostSessionActionPending = false; renderHostLoginStatus(); }
});

logoutHostSessionButton?.addEventListener("click", async () => {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.logoutHostSession || isHostSessionActionPending) return;
  isHostSessionActionPending = true;
  setHostLoginNotice("settings.hostSigningOut");
  try {
    await hostSessionRequest;
    const result = await bridge.logoutHostSession();
    if (result?.ok) {
      hostAccountId = "";
      setHostLoginNotice("settings.hostSignedOut");
    } else setHostLoginNotice(result?.code === "LIVE_SESSION_ACTIVE" ? "settings.hostLogoutLive" : "settings.hostSessionUnavailable", true);
  } catch { setHostLoginNotice("settings.hostSessionUnavailable", true); }
  finally { isHostSessionActionPending = false; renderHostLoginStatus(); }
});
window.addEventListener("focus", () => {
  if (document.visibilityState === "visible") void refreshHostLoginStatus();
});
void refreshHostLoginStatus();

// ── Theme: monochrome light/dark switch component (hero top-right),
// persisted per device ─────────────────────────────────────────────────────

const THEME_STORAGE_KEY = "realtime-noel-workspace-theme";
const themeSwitch = document.getElementById("workspace-theme-toggle");

function applyTheme(theme) {
  const isLight = theme === "light";
  document.body.classList.toggle("theme-light", isLight);
  themeSwitch?.querySelectorAll("[data-theme-choice]").forEach((button) => {
    const isActive = button.dataset.themeChoice === (isLight ? "light" : "dark");
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}
themeSwitch?.addEventListener("click", (event) => {
  const choice = event.target?.closest?.("[data-theme-choice]")?.dataset?.themeChoice;
  if (choice !== "light" && choice !== "dark") return;
  applyTheme(choice);
  try { localStorage.setItem(THEME_STORAGE_KEY, choice); } catch { /* storage optional */ }
});
try { applyTheme(localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark"); } catch { applyTheme("dark"); }

window.addEventListener("storage", (event) => {
  if (event.key !== SYSTEM_LANGUAGE_STORAGE_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  setLanguage(readStoredLanguage());
});

subscribe(() => {
  applyDocumentLanguage(document);
  applyTranslations(document);
  syncOverlayChip();
  syncLiveDraftLanguages();
  renderHostLoginStatus();
  renderRegisteredSessions(registeredSessionsSnapshot.sessions, registeredSessionsSnapshot.statusText);
  activatePage(main?.dataset.activePage ?? "captions");
});
mountSystemLanguageButton(document.getElementById("workspace-system-language"));

activatePage("captions");
