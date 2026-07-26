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
  changeLanguage,
  getLanguage,
  initLanguage,
  subscribe,
  t,
} from "./subtitle-i18n.js";

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

const DRAFT_FIELDS = ["liveDraftTitle", "liveDraftDate", "liveDraftTime", "liveDraftCapacity", "liveDisplayLanguage"];
const MAX_COVER_IMAGE_BYTES = 5 * 1024 * 1024;
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


// ── Live Call follows the caption configuration ────────────────────────────
// Live Call is an optional layer ON TOP of captions: its languages mirror the
// caption subtitle languages (spoken language is auto-detected, viewers pick
// their own display language on the web).

const LANGUAGE_MIRROR_LABELS = { en: "English", ko: "한국어", ja: "日本語" };

function syncLiveDraftLanguages() {
  const container = document.getElementById("live-draft-languages");
  if (!container) return;
  const selected = [...document.querySelectorAll('input[name="translationLanguages"]:checked')].map((input) => input.value);
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

function liveDisplayLanguage() {
  return fieldValue("liveDisplayLanguage") === "en" ? "en" : "ko";
}

// When Start fails on host sign-in, remember it: a later successful save in
// Settings returns here and retries automatically instead of making the user
// re-navigate and press Start again.
let pendingLiveCallRetry = false;

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
      maxViewers: Number.parseInt(fieldValue("liveDraftCapacity"), 10) || 50,
      languages: [...document.querySelectorAll('input[name="translationLanguages"]:checked')].map((input) => input.value),
      displayLanguage: liveDisplayLanguage(),
      coverImage: liveDraftCoverData,
    };
    const result = await bridge.startLiveCall(draft);
    if (result?.code === "HOST_LOGIN_REQUIRED" || result?.code === "HOST_LOGIN_REJECTED") {
      const authorizationMessage = result.code === "HOST_LOGIN_REJECTED"
        ? t("live.hostLoginRejected")
        : t("live.hostLoginRequired");
      pendingLiveCallRetry = true;
      setLiveStatus(authorizationMessage);
      if (hostLoginSection) hostLoginSection.hidden = false;
      if (hostLoginStatus) {
        delete hostLoginStatus.dataset.i18n;
        hostLoginStatus.textContent = authorizationMessage;
        hostLoginStatus.classList.add("is-error");
      }
      activatePage("settings");
      hostLoginSection?.scrollIntoView({ behavior: "smooth", block: "center" });
      form?.elements?.liveHostId?.focus();
      return;
    }
    if (result?.ok) pendingLiveCallRetry = false;
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
    maxViewers: Number.parseInt(fieldValue("liveDraftCapacity"), 10) || 50,
    languages: [...document.querySelectorAll('input[name="translationLanguages"]:checked')].map((input) => input.value),
    displayLanguage: liveDisplayLanguage(),
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
    row.append(meta, startButton);
    rows.push(row);
  }
  registeredSessionList.replaceChildren(...rows);
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
    const result = await bridge.startRegisteredLiveCall(sessionId, { displayLanguage: liveDisplayLanguage() });
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


// ── Live Call host authorization (desktop only): credentials stay in the
// main process and are never exposed to the participant workspace. ─────────

const hostLoginSection = document.getElementById("live-host-login-section");
const hostLoginStatus = document.getElementById("live-host-login-status");

function setHostLoginStatus(message, isError) {
  if (!hostLoginStatus) return;
  delete hostLoginStatus.dataset.i18n;
  hostLoginStatus.textContent = message;
  hostLoginStatus.classList.toggle("is-error", Boolean(isError));
}

// Section ordinals are generated, not written into the markup: the host-login
// section is hidden unless the desktop bridge is present, and hard-coded numbers
// made Settings read "1, 3" with a hole where section 2 used to be.
function renumberConfigSections() {
  for (const page of document.querySelectorAll("[data-workspace-page]")) {
    let ordinal = 0;
    for (const marker of page.querySelectorAll("[data-cfg-ordinal]")) {
      const section = marker.closest("section");
      if (section?.hidden) {
        marker.textContent = "";
        continue;
      }
      ordinal += 1;
      marker.textContent = String(ordinal);
    }
  }
}

renumberConfigSections();

async function refreshHostLoginStatus() {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.getLiveHostLoginStatus || !hostLoginSection) return;
  hostLoginSection.hidden = false;
  // Revealing a section shifts every ordinal after it.
  renumberConfigSections();
  try {
    const status = await bridge.getLiveHostLoginStatus();
    if (!status?.ok) return;
    if (form?.elements?.liveHostId && !form.elements.liveHostId.value) form.elements.liveHostId.value = status.hostId;
    if (form?.elements?.liveHostName && !form.elements.liveHostName.value) form.elements.liveHostName.value = status.hostName;
    setHostLoginStatus(status.hasLogin ? t("settings.authorized") : t("settings.authorizationRequired"), !status.hasLogin);
  } catch {
    // Bridge unavailable: leave the section as-is.
  }
}

const HOST_LOGIN_VERIFICATION_KEYS = {
  HOST_LOGIN_REJECTED: "settings.hostRejected",
  NETWORK_UNAVAILABLE: "settings.hostNetworkUnavailable",
  LOGIN_RATE_LIMITED: "settings.hostRateLimited",
  NO_STORED_LOGIN: "settings.hostNoStoredLogin",
};

function hostLoginSaveResultMessage(result) {
  if (!result?.ok) {
    return result?.code === "HOST_CREDENTIAL_ENCRYPTION_UNAVAILABLE"
      ? t("settings.hostKeychainUnavailable")
      : t("settings.hostSaveFailed");
  }
  if (!result.hasLogin) return t(HOST_LOGIN_VERIFICATION_KEYS.NO_STORED_LOGIN);
  if (result.verified) return t("settings.authorizedVerified");
  const key = HOST_LOGIN_VERIFICATION_KEYS[result.verificationCode];
  return key ? t(key) : t("settings.hostVerifyFailed", { code: result.verificationCode ?? "unknown" });
}

const saveHostLoginButton = document.getElementById("save-live-host-login");
saveHostLoginButton?.addEventListener("click", async () => {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.saveLiveHostLogin) return;
  saveHostLoginButton.disabled = true;
  saveHostLoginButton.setAttribute("aria-busy", "true");
  setHostLoginStatus(t("settings.savingHostAuthorization"), false);
  try {
    const result = await bridge.saveLiveHostLogin({
      hostId: fieldValue("liveHostId"),
      hostName: fieldValue("liveHostName"),
      hostPassword: fieldValue("liveHostPassword"),
    });
    if (form?.elements?.liveHostPassword) form.elements.liveHostPassword.value = "";
    const isVerified = Boolean(result?.ok && result.hasLogin && result.verified);
    setHostLoginStatus(hostLoginSaveResultMessage(result), !isVerified);
    // The host came here from a failed Start Live Call: finish their errand
    // for them — go back to the Live Call page and retry automatically.
    if (isVerified && pendingLiveCallRetry) {
      pendingLiveCallRetry = false;
      activatePage("livecall");
      setLiveStatus(t("live.hostVerifiedRetry"));
      startLiveCallButton?.click();
    }
  } catch {
    setHostLoginStatus(t("settings.hostSaveFailed"), true);
  } finally {
    saveHostLoginButton.disabled = false;
    saveHostLoginButton.removeAttribute("aria-busy");
  }
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

// ── App language: same switch component as the theme control, sitting next to
// it. The renderer owns the setting; the main process is told over IPC so the
// application menu follows. ────────────────────────────────────────────────

const languageSwitch = document.getElementById("workspace-language-toggle");

function syncLanguageSwitch() {
  const current = getLanguage();
  languageSwitch?.querySelectorAll("[data-language-choice]").forEach((button) => {
    const isActive = button.dataset.languageChoice === current;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function publishLanguageToMainProcess() {
  const setter = window.realtimeNoelDesktop?.setUiLanguage;
  if (typeof setter !== "function") return;
  try {
    void Promise.resolve(setter(getLanguage())).catch(() => {});
  } catch {
    // The bridge is optional (browser preview).
  }
}

languageSwitch?.addEventListener("click", (event) => {
  const choice = event.target?.closest?.("[data-language-choice]")?.dataset?.languageChoice;
  if (!choice) return;
  changeLanguage(choice);
});

subscribe(() => {
  applyDocumentLanguage(document);
  applyTranslations(document);
  syncLanguageSwitch();
  syncOverlayChip();
  syncLiveDraftLanguages();
  renderRegisteredSessions(registeredSessionsSnapshot.sessions, registeredSessionsSnapshot.statusText);
  activatePage(main?.dataset.activePage ?? "captions");
  publishLanguageToMainProcess();
});
syncLanguageSwitch();
publishLanguageToMainProcess();

// ── Password reveal: host sign-in password visibility toggle ───────────────

const hostPasswordReveal = document.getElementById("live-host-password-reveal");
hostPasswordReveal?.addEventListener("click", () => {
  const field = form?.elements?.liveHostPassword;
  if (!field) return;
  const reveal = field.type === "password";
  field.type = reveal ? "text" : "password";
  hostPasswordReveal.dataset.i18n = reveal ? "settings.hide" : "settings.reveal";
  hostPasswordReveal.dataset.i18nAria = reveal ? "settings.hideLabel" : "settings.revealLabel";
  hostPasswordReveal.textContent = t(hostPasswordReveal.dataset.i18n);
  hostPasswordReveal.setAttribute("aria-pressed", String(reveal));
  hostPasswordReveal.setAttribute("aria-label", t(hostPasswordReveal.dataset.i18nAria));
});

activatePage("captions");
