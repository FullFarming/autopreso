// Workspace chrome for the desktop dashboard: page routing between
// Captions / Live Call / Records / Settings,
// the footer Restart control, and the local Live Call draft. This file owns
// presentation glue only — all caption/session logic stays in
// subtitle-dashboard.js, which binds by element id and keeps working
// regardless of which page a control lives on.

const PAGE_COPY = {
  captions: { title: "Captions Configuration", subtitle: "Configure how captions are generated and delivered." },
  livecall: { title: "Live Call", subtitle: "Schedule a host-only live session." },
  records: { title: "Records", subtitle: "Manage and review your caption records." },
  settings: { title: "Settings", subtitle: "Manage your audio, translation, and application preferences." },
};

const LIVE_DRAFT_STORAGE_KEY = "realtime-noel-live-draft";

const main = document.querySelector("main.subtitle-dashboard");
const form = document.getElementById("subtitle-settings");
const navLinks = document.querySelectorAll("[data-workspace-nav]");
const pages = document.querySelectorAll("[data-workspace-page]");
const pageTitle = document.getElementById("workspace-page-title");
const pageSubtitle = document.getElementById("workspace-page-subtitle");
const footer = document.querySelector(".workspace-footer");

function activatePage(page) {
  if (!PAGE_COPY[page] || !main) return;
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
  if (pageTitle) pageTitle.textContent = PAGE_COPY[page].title;
  if (pageSubtitle) pageSubtitle.textContent = PAGE_COPY[page].subtitle;
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
  overlayChip.textContent = isOn ? "Active" : "Not Active";
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
  const field = form?.elements?.[name];
  field?.addEventListener?.("change", persistLiveDraft);
  field?.addEventListener?.("input", persistLiveDraft);
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
    throw new Error("Choose a JPEG, PNG, or WebP image.");
  }
  if (file.size <= 0 || file.size > MAX_COVER_IMAGE_BYTES) {
    throw new Error("The cover image must be no larger than 5MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasValidCoverImageSignature(bytes, file.type)) {
    throw new Error("The selected file does not match its image type.");
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

coverButton?.addEventListener("click", () => coverInput?.click());
coverInput?.addEventListener("change", async () => {
  const file = coverInput.files?.[0];
  liveDraftCoverData = null;
  if (!file) {
    setCoverStatus("No image selected.");
    if (coverPreview) coverPreview.hidden = true;
    return;
  }
  setCoverStatus("Preparing image…");
  try {
    const serialized = await serializeCoverImage(file);
    if (coverInput.files?.[0] !== file) return;
    liveDraftCoverData = serialized;
    if (liveDraftCoverPreviewUrl) URL.revokeObjectURL(liveDraftCoverPreviewUrl);
    liveDraftCoverPreviewUrl = URL.createObjectURL(file);
    if (coverPreview) {
      coverPreview.src = liveDraftCoverPreviewUrl;
      coverPreview.alt = `Selected cover: ${serialized.name}`;
      coverPreview.hidden = false;
    }
    setCoverStatus(`${serialized.name} · ${(serialized.size / 1024 / 1024).toFixed(1)}MB`);
  } catch (error) {
    if (coverPreview) coverPreview.hidden = true;
    setCoverStatus(error instanceof Error ? error.message : "Could not prepare the cover image.", true);
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

function liveDraftScheduledAt() {
  const date = fieldValue("liveDraftDate");
  if (!date) return null;
  const time = fieldValue("liveDraftTime") || "09:00";
  const stamp = Date.parse(`${date}T${time}`);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

// When Start fails on host sign-in, remember it: a later successful save in
// Settings returns here and retries automatically instead of making the user
// re-navigate and press Start again.
let pendingLiveCallRetry = false;

startLiveCallButton?.addEventListener("click", async () => {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.startLiveCall) {
    if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = "Live Call is available in the desktop app only.";
    return;
  }
  startLiveCallButton.disabled = true;
  startLiveCallButton.setAttribute("aria-busy", "true");
  if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = "Creating the live session…";
  const selectedCover = coverInput?.files?.[0];
  try {
    if (selectedCover && !liveDraftCoverData) {
      liveDraftCoverData = await serializeCoverImage(selectedCover);
      setCoverStatus(`${liveDraftCoverData.name} · ${(liveDraftCoverData.size / 1024 / 1024).toFixed(1)}MB`);
    }
    const draft = {
      title: fieldValue("liveDraftTitle"),
      scheduledAt: liveDraftScheduledAt(),
      maxViewers: Number.parseInt(fieldValue("liveDraftCapacity"), 10) || 50,
      languages: [...document.querySelectorAll('input[name="translationLanguages"]:checked')].map((input) => input.value),
      coverImage: liveDraftCoverData,
    };
    const result = await bridge.startLiveCall(draft);
    if (result?.code === "HOST_LOGIN_REQUIRED" || result?.code === "HOST_LOGIN_REJECTED") {
      const authorizationMessage = result.code === "HOST_LOGIN_REJECTED"
        ? "The workspace rejected the saved host ID/password. Update them in Settings to the host account the workspace accepts."
        : "Host authorization is required. Open Settings and save the host authorization.";
      pendingLiveCallRetry = true;
      if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = authorizationMessage;
      if (hostLoginSection) hostLoginSection.hidden = false;
      if (hostLoginStatus) {
        hostLoginStatus.textContent = authorizationMessage;
        hostLoginStatus.classList.add("is-error");
      }
      activatePage("settings");
      hostLoginSection?.scrollIntoView({ behavior: "smooth", block: "center" });
      form?.elements?.liveHostId?.focus();
      return;
    }
    if (result?.ok) pendingLiveCallRetry = false;
    if (liveWorkspaceStatus) {
      liveWorkspaceStatus.textContent = result?.ok
        ? `Stage overlay is up — access code ${result.admissionCode ?? "?"}. Press Go-Live on the controller to begin.`
        : LIVE_CALL_START_MESSAGES[result?.code]
          ?? `Could not start Live Call. Please try again. (code: ${result?.code ?? "unknown"})`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start Live Call.";
    if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = message;
    if (selectedCover) setCoverStatus(message, true);
  } finally {
    startLiveCallButton.disabled = false;
    startLiveCallButton.removeAttribute("aria-busy");
  }
});

// Human-readable start failures; unknown codes fall back to a generic retry
// message so raw machine codes never reach the status line.
const LIVE_CALL_START_MESSAGES = {
  HTTP_400: "The workspace rejected the session settings — the app and server versions may be out of sync. Update the app and try again.",
  LIVE_CALL_DISABLED: "Live Call is turned off in this build.",
  LIVE_CALL_ALREADY_ARMED: "A Live Call stage is already open. End it from the controller first.",
  LIVE_CALL_START_IN_PROGRESS: "The stage is already being created — one moment.",
  NETWORK_UNAVAILABLE: "The workspace could not be reached. Check the network and try again.",
  LOGIN_RATE_LIMITED: "The workspace is rate-limiting sign-ins. Wait a minute and try again.",
  INVALID_COVER_IMAGE: "The cover image could not be used. Choose a JPEG, PNG, or WebP under 5MB.",
  COVER_UPLOAD_FAILED: "The cover image upload failed. Try again or start without a cover.",
  INVITE_CREATE_FAILED: "The invite could not be created. Try again.",
  STAGE_OPEN_FAILED: "The stage window could not be opened. Try again.",
  SESSION_NOT_PREPARING: "That registered session has already started or ended. Refresh the list.",
  INVALID_SESSION_ID: "The registered session could not be identified. Refresh the list.",
};

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
    setCoverStatus(`${liveDraftCoverData.name} · ${(liveDraftCoverData.size / 1024 / 1024).toFixed(1)}MB`);
  }
  return {
    title: fieldValue("liveDraftTitle"),
    scheduledAt: liveDraftScheduledAt(),
    maxViewers: Number.parseInt(fieldValue("liveDraftCapacity"), 10) || 50,
    languages: [...document.querySelectorAll('input[name="translationLanguages"]:checked')].map((input) => input.value),
    coverImage: liveDraftCoverData,
  };
}

function formatRegisteredSchedule(scheduledAt) {
  if (!scheduledAt) return "바로 시작 가능";
  const stamp = Date.parse(scheduledAt);
  if (!Number.isFinite(stamp)) return "바로 시작 가능";
  const at = new Date(stamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function renderRegisteredSessions(sessions, statusText = "") {
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
    title.textContent = session.title || "(제목 없음)";
    const schedule = document.createElement("span");
    schedule.textContent = formatRegisteredSchedule(session.scheduledAt);
    meta.append(title, schedule);
    const startButton = document.createElement("button");
    startButton.type = "button";
    startButton.className = "accent compact";
    startButton.textContent = "불러와서 시작";
    startButton.addEventListener("click", () => { void startRegisteredSession(session.id, startButton); });
    row.append(meta, startButton);
    rows.push(row);
  }
  registeredSessionList.replaceChildren(...rows);
}

async function refreshRegisteredSessions({ quiet = false } = {}) {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.listRegisteredLiveCalls || !registeredSessionList) return;
  if (!quiet) renderRegisteredSessions([], "등록된 세션을 불러오는 중…");
  try {
    const result = await bridge.listRegisteredLiveCalls();
    if (!result?.ok) {
      renderRegisteredSessions([], LIVE_CALL_START_MESSAGES[result?.code] ?? "등록된 세션을 불러오지 못했습니다.");
      return;
    }
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    renderRegisteredSessions(sessions, sessions.length ? "" : "등록된 세션이 없습니다. Register for Later로 세션을 등록해 두세요.");
  } catch {
    renderRegisteredSessions([], "등록된 세션을 불러오지 못했습니다.");
  }
}

async function startRegisteredSession(sessionId, button) {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.startRegisteredLiveCall) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = "등록된 세션을 불러오는 중…";
  try {
    const result = await bridge.startRegisteredLiveCall(sessionId);
    if (liveWorkspaceStatus) {
      liveWorkspaceStatus.textContent = result?.ok
        ? `Stage overlay is up — access code ${result.admissionCode ?? "?"}. Press Go-Live on the controller to begin.`
        : LIVE_CALL_START_MESSAGES[result?.code]
          ?? `등록된 세션을 시작하지 못했습니다. (code: ${result?.code ?? "unknown"})`;
    }
    if (result?.ok) void refreshRegisteredSessions({ quiet: true });
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

registerLiveCallButton?.addEventListener("click", async () => {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.registerLiveCall) {
    if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = "Live Call is available in the desktop app only.";
    return;
  }
  registerLiveCallButton.disabled = true;
  registerLiveCallButton.setAttribute("aria-busy", "true");
  if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = "세션을 등록하는 중…";
  try {
    const draft = await collectLiveDraft();
    const result = await bridge.registerLiveCall(draft);
    if (liveWorkspaceStatus) {
      liveWorkspaceStatus.textContent = result?.ok
        ? `세션이 등록되었습니다 — ${result.title || "(제목 없음)"}. 아래 목록에서 언제든 불러와 시작할 수 있습니다.`
        : LIVE_CALL_START_MESSAGES[result?.code]
          ?? `세션을 등록하지 못했습니다. (code: ${result?.code ?? "unknown"})`;
    }
    if (result?.ok) void refreshRegisteredSessions({ quiet: true });
  } catch (error) {
    if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = error instanceof Error ? error.message : "세션을 등록하지 못했습니다.";
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

async function refreshHostLoginStatus() {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.getLiveHostLoginStatus || !hostLoginSection) return;
  hostLoginSection.hidden = false;
  try {
    const status = await bridge.getLiveHostLoginStatus();
    if (!status?.ok) return;
    if (form?.elements?.liveHostId && !form.elements.liveHostId.value) form.elements.liveHostId.value = status.hostId;
    if (form?.elements?.liveHostName && !form.elements.liveHostName.value) form.elements.liveHostName.value = status.hostName;
    if (hostLoginStatus) {
      hostLoginStatus.textContent = status.hasLogin ? "Authorized — Start Live Call can create the stage." : "Authorization required";
      hostLoginStatus.classList.toggle("is-error", !status.hasLogin);
    }
  } catch {
    // Bridge unavailable: leave the section as-is.
  }
}

const HOST_LOGIN_VERIFICATION_MESSAGES = {
  HOST_LOGIN_REJECTED: "Saved, but the workspace rejected this ID/password. Enter the host account the workspace accepts, then save again.",
  NETWORK_UNAVAILABLE: "Saved, but the workspace could not be reached. Check the network, then save again to re-verify.",
  LOGIN_RATE_LIMITED: "Saved, but the workspace is rate-limiting sign-ins. Wait a minute, then save again to re-verify.",
  NO_STORED_LOGIN: "Authorization required — enter both the host ID and password.",
};

function hostLoginSaveResultMessage(result) {
  if (!result?.ok) {
    return result?.code === "HOST_CREDENTIAL_ENCRYPTION_UNAVAILABLE"
      ? "This device cannot encrypt the password (OS keychain unavailable). Unlock it and try again."
      : "Could not save the host authorization.";
  }
  if (!result.hasLogin) return HOST_LOGIN_VERIFICATION_MESSAGES.NO_STORED_LOGIN;
  if (result.verified) return "Authorized — the workspace accepted the sign-in. Start Live Call opens the QR stage directly.";
  return HOST_LOGIN_VERIFICATION_MESSAGES[result.verificationCode]
    ?? `Saved, but the workspace sign-in failed (${result.verificationCode ?? "unknown"}).`;
}

const saveHostLoginButton = document.getElementById("save-live-host-login");
saveHostLoginButton?.addEventListener("click", async () => {
  const bridge = window.realtimeNoelDesktop;
  if (!bridge?.saveLiveHostLogin) return;
  saveHostLoginButton.disabled = true;
  saveHostLoginButton.setAttribute("aria-busy", "true");
  if (hostLoginStatus) {
    hostLoginStatus.textContent = "Saving and verifying host authorization…";
    hostLoginStatus.classList.remove("is-error");
  }
  try {
    const result = await bridge.saveLiveHostLogin({
      hostId: fieldValue("liveHostId"),
      hostName: fieldValue("liveHostName"),
      hostPassword: fieldValue("liveHostPassword"),
    });
    if (form?.elements?.liveHostPassword) form.elements.liveHostPassword.value = "";
    const isVerified = Boolean(result?.ok && result.hasLogin && result.verified);
    if (hostLoginStatus) {
      hostLoginStatus.textContent = hostLoginSaveResultMessage(result);
      hostLoginStatus.classList.toggle("is-error", !isVerified);
    }
    // The host came here from a failed Start Live Call: finish their errand
    // for them — go back to the Live Call page and retry automatically.
    if (isVerified && pendingLiveCallRetry) {
      pendingLiveCallRetry = false;
      activatePage("livecall");
      if (liveWorkspaceStatus) liveWorkspaceStatus.textContent = "Host sign-in verified — retrying Start Live Call…";
      startLiveCallButton?.click();
    }
  } catch {
    if (hostLoginStatus) {
      hostLoginStatus.textContent = "Could not save the host authorization.";
      hostLoginStatus.classList.add("is-error");
    }
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

// ── Password reveal: host sign-in password visibility toggle ───────────────

const hostPasswordReveal = document.getElementById("live-host-password-reveal");
hostPasswordReveal?.addEventListener("click", () => {
  const field = form?.elements?.liveHostPassword;
  if (!field) return;
  const reveal = field.type === "password";
  field.type = reveal ? "text" : "password";
  hostPasswordReveal.textContent = reveal ? "숨김" : "표시";
  hostPasswordReveal.setAttribute("aria-pressed", String(reveal));
  hostPasswordReveal.setAttribute("aria-label", reveal ? "비밀번호 숨김" : "비밀번호 표시");
});

activatePage("captions");
