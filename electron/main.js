import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, net, safeStorage, screen, session, shell, systemPreferences } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocket } from "ws";

import { startServer } from "../src/server.js";
import { createCaptionPcmResampler } from "../src/caption-pcm-resampler.js";
import { encodeLiveAudioWireFrame } from "../src/live-audio-wire.js";
import { sanitizeLiveCaptionDisplayLanguage, shouldDisplayLiveCaption } from "../src/live-caption-display-policy.js";
import {
  createLiveCaptionIpcRelay,
  resolveControllerDisplay,
  resolveOverlayDisplays,
  resolveSelectedOverlayDisplay,
} from "../src/live-caption-ipc-relay.js";
import { createSettingsStore, migrateSettingsFile, validateSubtitleSettings } from "../src/settings-store.js";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
// The renderer owns the UI language choice (localStorage); it pushes the value
// over IPC so the application menu speaks the same language.
import { normalizeLanguage, setLanguage, t as translate } from "../public/subtitle-i18n.js";

const APP_CONFIG_DIR = "realtime-noel";
const LEGACY_CONFIG_DIR = ["auto", "preso"].join("");
const SETTINGS_PATH = path.join(os.homedir(), ".config", APP_CONFIG_DIR, "settings.json");
const LEGACY_SETTINGS_PATH = path.join(os.homedir(), ".config", LEGACY_CONFIG_DIR, "settings.json");
const PREFERRED_PORT = 3210;
// Keep this below the renderer-side capture timeout (8s in subtitle-dashboard.js)
// so the main process can answer before the renderer reports its own timeout.
const DESKTOP_SOURCE_TIMEOUT_MS = 7_000;
const ALLOWED_RENDERER_PERMISSIONS = new Set(["media", "display-capture", "clipboard-sanitized-write"]);
const OVERLAY_TOP_LEVEL = "screen-saver";
// The console hugs its content, which before Go-Live is much narrower than the
// old fixed 720 floor.
const CONTROLLER_MIN_WIDTH = 420;
const MAX_OVERLAY_DISPLAY_ID_LENGTH = 64;
const DEFAULT_LIVE_WORKSPACE_URL = "https://realtime-noel-web.vercel.app/";
const MAILTO_MAX_URL_LENGTH = 4_096;
const MAX_LIVE_COVER_BYTES = 20 * 1024 * 1024;
const LIVE_COVER_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const LIVE_COVER_UPLOAD_TIMEOUT_MS = 120_000;
// Renderer recovery: a window whose page failed to load never fires
// `ready-to-show`, and a crashed renderer keeps `isDestroyed() === false`, so
// the 1s overlay watchdog cannot see either. Reload with bounded exponential
// backoff instead — a dead overlay display and a dead dashboard (the ONLY host
// mic source during a Live Call) both used to require an app restart.
const RENDERER_RELOAD_BASE_MS = 1_000;
const RENDERER_RELOAD_MAX_MS = 15_000;
const MAX_RENDERER_RELOADS = 5;
// Live Call gateway reconnect mirrors captions-only for the first five attempts,
// then slows to 36–42s for as long as the same call remains active. The 36s
// minimum accounts for the initial burst and keeps EVERY rolling 15-minute
// window within the host-session token limit of 30 requests.
const LIVE_BRIDGE_RECONNECT_BASE_MS = 1_000;
const LIVE_BRIDGE_SLOW_RETRY_MIN_MS = 36_000;
const LIVE_BRIDGE_SLOW_RETRY_JITTER_MS = 6_000;
const LIVE_BRIDGE_SLOW_RETRY_AFTER = 8;
const LIVE_BRIDGE_CREDENTIAL_REFRESH_MAX_MS = 50 * 60 * 1_000;
const LIVE_BRIDGE_CREDENTIAL_REFRESH_SKEW_MS = 60_000;

// NOTE: On Electron 42 (Chromium ~140) the macOS system-audio loopback path
// (the `audio: "loopback"` reply in setDisplayMediaRequestHandler below) is
// implemented THROUGH the MacCatapLoopbackAudioForScreenShare CoreAudio-tap
// feature. A previous build disabled that feature to work around a dead stream
// when launched from Terminal, but for the packaged /Applications app it must
// stay enabled or getDisplayMedia returns a stream with zero audio tracks.

let dashboardWindow = null;
let controllerWindow = null;
let lastServerUrl = "";
let stageWindow = null;
// Always-on-top overlay windows keyed by display id. In single mode the map
// holds exactly one entry following the user's persisted display choice; with
// the controller's "all displays" tick on it holds one per connected screen,
// every one rendering the SAME caption stream from the local server.
const overlayWindows = new Map();
let overlayAllDisplays = false;
let preferredOverlayDisplayId = "";
let selectedOverlayDisplayId = "";
// Overlay windows whose page currently hosts the cursor over a subtitle box —
// these stay clickable (double-click restart) until the cursor leaves; the
// watchdog must not flip them back to click-through mid-hover.
const interactiveOverlayIds = new Set();
let overlayUrl = "";
let server = null;
let overlayWatchdog = null;
let overlayEnabled = true;
// Momentary caption hide, e.g. while a video plays. Separate from
// overlayEnabled on purpose: that one is a persisted SETTING that destroys the
// overlay windows, so reusing it would survive a restart with no indication and
// would reload the renderer. This is visibility-only and in-memory, so quitting
// always clears it.
let overlaysMuted = false;
let isQuitting = false;
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showDashboardWindow();
    if (overlayEnabled) maintainOverlayWindow();
  });
}

// A malformed settings.json used to take the whole app down with no window and
// no dialog — just a dock icon. Anything that makes the store throw (invalid
// JSON, a truncated half-write, `"subtitle": null`) is unrecoverable data, so
// move it aside, boot on freshly-seeded defaults, and tell the host where the
// old file went instead of dying silently.
function quarantineSettingsFile() {
  const quarantinedPath = `${SETTINGS_PATH}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(SETTINGS_PATH, quarantinedPath);
    return quarantinedPath;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    console.error(`[boot] settings quarantine failed: ${error?.message ?? error}`);
    return "";
  }
}

async function loadSettingsStoreResiliently() {
  await migrateSettingsFile({ fromPath: LEGACY_SETTINGS_PATH, toPath: SETTINGS_PATH });
  const settingsStore = createSettingsStore({ filePath: SETTINGS_PATH });
  try {
    return { settingsStore, settings: await settingsStore.load(), quarantinedPath: "" };
  } catch (error) {
    console.error(`[boot] settings.json could not be read: ${error?.message ?? error}`);
    const quarantinedPath = quarantineSettingsFile();
    // The missing file makes load() seed and write defaults.
    const freshStore = createSettingsStore({ filePath: SETTINGS_PATH });
    return { settingsStore: freshStore, settings: await freshStore.load(), quarantinedPath };
  }
}

async function createApp() {
  const { settingsStore, settings, quarantinedPath } = await loadSettingsStoreResiliently();
  overlayEnabled = settings.subtitle?.overlayEnabled !== false;
  preferredOverlayDisplayId = settings.subtitle?.overlayDisplayId ?? "";
  overlayAllDisplays = settings.subtitle?.overlayAllDisplays === true;
  server = await startDesktopServer(settingsStore);
  const liveCallEnabled = isLiveCallEnabled();
  const liveWorkspaceUrl = resolveLiveWorkspaceUrl();
  const localAppOrigin = new URL(server.url).origin;
  // Media capture is LOCAL-ONLY on purpose. The host mic and system-audio
  // loopback are captured by the dashboard renderer (see the backgroundThrottling
  // note on createDashboardWindow), which is served from localAppOrigin. The only
  // remote page Electron ever loads is the read-only /stage view (QR + countdown),
  // which needs neither mic nor display-capture. Granting the remote workspace
  // origin `media`/`display-capture` here meant one XSS or supply-chain compromise
  // on that host became a silent mic tap plus whole-screen capture with no OS
  // picker (useSystemPicker: false) and no prompt.
  const allowedMediaOrigins = new Set([localAppOrigin]);

  await ensureMicrophoneAccess();
  configureSystemAudioCapture(allowedMediaOrigins);
  configureMediaPermissions(allowedMediaOrigins);
  registerOverlayIpc(settingsStore, { localAppOrigin, liveWorkspaceUrl, liveCallEnabled });
  await createDashboardWindow(server.url);
  createControllerWindow(server.url);
  installApplicationMenu(server.url);
  if (overlayEnabled) createOverlayWindow(server.url);

  screen.on("display-metrics-changed", syncOverlayBoundsAndTop);
  screen.on("display-added", syncOverlayBoundsAndTop);
  screen.on("display-removed", syncOverlayBoundsAndTop);
  // Stage view hot-plug: when the extended display appears or disappears the
  // stage window moves to the best remaining display (see C8).
  screen.on("display-added", repositionStageWindow);
  screen.on("display-removed", repositionStageWindow);
  screen.on("display-metrics-changed", repositionStageWindow);
  // Event-driven re-assert: these fire exactly when macOS tends to de-level a
  // floating window (another app activating/going fullscreen, our own windows
  // gaining focus), so the overlay snaps back on top immediately instead of
  // waiting up to a full watchdog tick.
  app.on("browser-window-focus", reassertOverlayTop);
  app.on("did-become-active", reassertOverlayTop);
  overlayWatchdog = setInterval(() => {
    if (overlayEnabled && !isQuitting) maintainOverlayWindow();
  }, 1000);
  if (quarantinedPath) {
    try {
      void dialog.showMessageBox({
        type: "warning",
        title: "Settings were reset",
        message: "NOVA could not read your settings file, so it started with default settings.",
        detail: `The unreadable file was kept at:\n${quarantinedPath}\n\nRe-enter your API keys and glossary in Settings.`,
        buttons: ["OK"],
        noLink: true,
      });
    } catch { /* dialogs are unavailable in headless test runs */ }
  }
}

function syncOverlayBoundsAndTop() {
  syncOverlayBounds();
  positionControllerForOverlayDisplay();
  reassertOverlayTop();
  notifyOverlayDisplaysChanged();
}

function overlayDisplayState() {
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const selected = resolveSelectedOverlayDisplay(displays, preferredOverlayDisplayId, primaryDisplay);
  selectedOverlayDisplayId = selected ? String(selected.id) : "";
  return {
    displays: displays.map((display) => ({
      id: String(display.id),
      label: String(display.label ?? "Display").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 160) || "Display",
      isPrimary: String(display.id) === String(primaryDisplay?.id),
      isConnected: true,
    })),
    selectedDisplayId: selectedOverlayDisplayId,
    allDisplays: overlayAllDisplays,
  };
}

function notifyOverlayDisplaysChanged() {
  const payload = overlayDisplayState();
  for (const rendererWindow of [dashboardWindow, controllerWindow]) {
    if (rendererWindow && !rendererWindow.isDestroyed()) {
      rendererWindow.webContents.send("subtitle-overlay:displays-changed", payload);
    }
  }
}

function positionControllerForOverlayDisplay() {
  if (!controllerWindow || controllerWindow.isDestroyed()) return;
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const overlayDisplay = resolveSelectedOverlayDisplay(displays, preferredOverlayDisplayId, primaryDisplay);
  const target = resolveControllerDisplay(displays, overlayDisplay, primaryDisplay);
  if (!target) return;
  const [currentWidth, currentHeight] = controllerWindow.getSize();
  const width = Math.min(currentWidth, Math.max(CONTROLLER_MIN_WIDTH, target.workArea.width - 48));
  const x = Math.round(target.workArea.x + (target.workArea.width - width) / 2);
  const y = Math.round(target.workArea.y + target.workArea.height - currentHeight - 120);
  controllerWindow.setBounds({ x, y, width, height: currentHeight });
}

// ── Renderer death recovery ────────────────────────────────────────────────
// `isDestroyed()` stays false for a renderer that crashed or whose page never
// loaded, so nothing in the watchdog noticed either failure. Watch the two
// events that actually fire — did-fail-load (the page never rendered) and
// render-process-gone (the page died mid-session) — and reload with bounded
// exponential backoff. `onFailure` runs once the ceiling is reached so callers
// can escalate (the dashboard stops the Live Call bridge and reports it).
function attachRendererRecovery(window, { label, reload, onFailure }) {
  let attempts = 0;
  let reloadTimer = null;
  const clearReloadTimer = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = null;
  };
  const scheduleReload = (reason) => {
    if (isQuitting || reloadTimer || window.isDestroyed()) return;
    if (attempts >= MAX_RENDERER_RELOADS) {
      console.error(`[renderer] ${label} could not be recovered after ${attempts} attempts (${reason})`);
      onFailure?.(reason);
      return;
    }
    const delay = Math.min(RENDERER_RELOAD_BASE_MS * 2 ** attempts, RENDERER_RELOAD_MAX_MS);
    attempts += 1;
    console.warn(`[renderer] ${label} reload attempt ${attempts} in ${delay}ms (${reason})`);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (isQuitting || window.isDestroyed()) return;
      Promise.resolve()
        .then(reload)
        .catch((error) => scheduleReload(`reload failed: ${error?.message ?? error}`));
    }, delay);
  };
  window.webContents.on("did-finish-load", () => {
    attempts = 0;
    clearReloadTimer();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame === false) return;
    // ERR_ABORTED: a navigation superseded by another one, not a real failure.
    if (errorCode === -3) return;
    scheduleReload(`did-fail-load ${errorCode} ${errorDescription ?? ""}`.trim());
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details?.reason === "clean-exit") return;
    scheduleReload(`render-process-gone ${details?.reason ?? "unknown"}`);
  });
  window.webContents.on("unresponsive", () => {
    console.warn(`[renderer] ${label} is unresponsive`);
  });
  window.on("closed", clearReloadTimer);
  return { cancel: clearReloadTimer };
}

async function startDesktopServer(settingsStore) {
  const transcriptsDir = path.join(path.dirname(SETTINGS_PATH), "transcripts");
  try {
    return await startServer({
      host: "127.0.0.1",
      port: PREFERRED_PORT,
      settingsStore,
      transcriptsDir,
      createTranscription: createNoopTranscription,
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
  }
  return startServer({
    host: "127.0.0.1",
    port: 0,
    settingsStore,
    transcriptsDir,
    createTranscription: createNoopTranscription,
  });
}

async function createDashboardWindow(url) {
  dashboardWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: "NOVA Subtitles",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "preload.js"),
      // The dashboard renderer is hidden while a Live Call is running (go-live
      // hides the window) yet it still captures the host mic and forwards PCM
      // frames — never throttle it in the background.
      backgroundThrottling: false,
    },
  });
  // window.open targets (e.g. the web meeting mode) belong in the system
  // browser, never in an Electron child window.
  dashboardWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    openAllowedExternal(targetUrl);
    return { action: "deny" };
  });
  // Bridge diagnostics: the mic capture runs in this renderer, whose console
  // is otherwise invisible in headless launches — mirror its [live-bridge]
  // lines to the main-process stdout.
  dashboardWindow.webContents.on("console-message", (_event, _level, message) => {
    if (typeof message === "string" && message.includes("[live-bridge]")) {
      console.info(`[renderer] ${message}`);
    }
  });
  dashboardWindow.on("closed", () => {
    dashboardWindow = null;
    app.quit();
  });
  // The dashboard renderer is the ONLY host mic source during a Live Call (see
  // the backgroundThrottling note above) and it is HIDDEN at go-live, so its
  // death was completely invisible: the call stayed "live" and every viewer got
  // silence with no error anywhere. Reload it on crash — the renderer's own 3s
  // syncLiveCallAudioBridge poll re-arms mic capture once the page is back — and
  // if it cannot be recovered, stop the bridge and report it to the controller.
  attachRendererRecovery(dashboardWindow, {
    label: "dashboard",
    reload: loadDashboardPage,
    onFailure: (reason) => {
      if (!liveCallSession) {
        // Not in a call, but the main window is still gone for good — a crashed
        // renderer never fires "closed", so nothing else would ever say so.
        try {
          dialog.showErrorBox(
            "NOVA stopped responding",
            `The main window could not be restarted (${reason}). Quit and reopen NOVA.`,
          );
        } catch { /* dialogs are unavailable in headless test runs */ }
        return;
      }
      stopLiveGatewayBridge("dashboard renderer lost");
      setLiveBridgeAlert({
        state: "failed",
        code: "HOST_AUDIO_RENDERER_LOST",
        detail: reason,
        message: "호스트 마이크 창이 응답하지 않아 오디오 전송이 중단되었습니다. Live Call을 종료하고 앱을 다시 시작하세요.",
      });
      notifyLiveBridgeFailure(
        "Host audio stopped",
        "The window that captures your microphone stopped responding and could not be restarted, so participants are no longer hearing you. End the Live Call and restart NOVA.",
      );
    },
  });
  try {
    await dashboardWindow.webContents.session.clearCache();
  } catch {
    console.warn("[subtitle] renderer cache could not be cleared; loading no-store assets");
  }
  // Hoisted so the recovery hookup above can reference it: crash reloads must go
  // through exactly the same no-store path as the very first load.
  async function loadDashboardPage() {
    await dashboardWindow.loadURL(`${url}/subtitle.html`, {
      extraHeaders: "Cache-Control: no-cache, no-store, must-revalidate\r\nPragma: no-cache",
    });
  }
  // A first-load failure must not reject boot — did-fail-load retries it.
  await loadDashboardPage().catch((error) => {
    console.warn(`[subtitle] dashboard first load failed: ${error?.message ?? error}`);
  });
}

function resolveLiveWorkspaceUrl(environment = process.env, isPackaged = app.isPackaged) {
  const override = environment.REALTIME_NOEL_LIVE_URL?.trim() ?? "";
  if (override) {
    if (isPackaged) {
      throw new Error("REALTIME_NOEL_LIVE_URL is allowed only in development");
    }
    return parseLiveWorkspaceUrl(override);
  }
  // Stored loopback override (desktop Settings → Live Call host login):
  // lets the packaged app talk to a local webapp dev server. Loopback-only —
  // a non-loopback stored URL is ignored so the packaged default cannot be
  // silently redirected to an arbitrary host.
  const stored = readLiveHostConfig().workspaceUrl;
  if (stored) {
    try {
      const parsed = parseLiveWorkspaceUrl(stored);
      if (new URL(parsed).protocol === "http:") return parsed;
    } catch {
      // Ignore invalid stored URLs; fall through to the default.
    }
  }
  return DEFAULT_LIVE_WORKSPACE_URL;
}

// ── Desktop host login (Live Call without the login page) ─────────────────
// The host id/password/name live in the app's userData dir, entered once in
// the desktop Settings page. live-call:start uses them to sign in silently,
// so pressing Start goes straight to the QR/countdown stage overlay.

function liveHostConfigPath() {
  return path.join(app.getPath("userData"), "live-host-login.json");
}

function writeLiveHostConfig(config) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(liveHostConfigPath(), JSON.stringify(config), { mode: 0o600 });
}

function encryptHostPassword(password) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("HOST_CREDENTIAL_ENCRYPTION_UNAVAILABLE");
  }
  return safeStorage.encryptString(password).toString("base64");
}

function decryptHostPassword(encrypted) {
  if (!safeStorage.isEncryptionAvailable() || typeof encrypted !== "string" || !encrypted) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return "";
  }
}

function readLiveHostConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(liveHostConfigPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    if (typeof parsed.hostPassword === "string" && parsed.hostPassword) {
      const migrated = { ...parsed };
      try {
        migrated.hostPasswordEncrypted = encryptHostPassword(parsed.hostPassword);
      } finally {
        // Fail closed: a plaintext credential must never survive another read,
        // even if the operating-system encryption service is unavailable.
        delete migrated.hostPassword;
        writeLiveHostConfig(migrated);
      }
      return {
        ...migrated,
        hostPassword: decryptHostPassword(migrated.hostPasswordEncrypted),
      };
    }
    return {
      ...parsed,
      hostPassword: decryptHostPassword(parsed.hostPasswordEncrypted),
    };
  } catch {
    return {};
  }
}

function saveLiveHostConfig(update) {
  const source = update && typeof update === "object" ? update : {};
  const current = readLiveHostConfig();
  const nextPassword = typeof source.hostPassword === "string" && source.hostPassword
    ? source.hostPassword.slice(0, 256)
    : current.hostPassword;
  const next = {
    ...(typeof current.hostId === "string" ? { hostId: current.hostId } : {}),
    ...(typeof current.hostName === "string" ? { hostName: current.hostName } : {}),
    ...(typeof current.workspaceUrl === "string" ? { workspaceUrl: current.workspaceUrl } : {}),
    ...(typeof current.hostPasswordEncrypted === "string"
      ? { hostPasswordEncrypted: current.hostPasswordEncrypted }
      : {}),
    ...(typeof source.hostId === "string" ? { hostId: source.hostId.trim().slice(0, 100) } : {}),
    ...(typeof source.hostName === "string" ? { hostName: source.hostName.trim().slice(0, 40) } : {}),
    ...(typeof source.workspaceUrl === "string" ? { workspaceUrl: source.workspaceUrl.trim().slice(0, 200) } : {}),
    ...(nextPassword ? { hostPasswordEncrypted: encryptHostPassword(nextPassword) } : {}),
  };
  writeLiveHostConfig(next);
  return {
    hasLogin: Boolean(next.hostId && next.hostPasswordEncrypted),
    workspaceUrl: next.workspaceUrl ?? "",
  };
}

async function silentHostLogin(baseUrl) {
  const config = readLiveHostConfig();
  if (!config.hostId || !config.hostPassword) return { ok: false, code: "NO_STORED_LOGIN" };
  const login = await liveCallApi(baseUrl, "/api/login", {
    body: { id: config.hostId, password: config.hostPassword, name: config.hostName || config.hostId },
  });
  // A 401 here means the workspace REJECTED the stored credentials — distinct
  // from NO_STORED_LOGIN, so the renderer can tell the user to fix the values
  // instead of endlessly re-saving the same rejected ones.
  if (!login.ok && login.code === "HOST_LOGIN_REQUIRED") {
    return { ok: false, code: "HOST_LOGIN_REJECTED" };
  }
  return login;
}

function parseLiveWorkspaceUrl(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error("Live workspace URL is invalid");
  }
  const isLoopbackHttp = target.protocol === "http:" && new Set(["127.0.0.1", "localhost", "[::1]"]).has(target.hostname);
  if ((target.protocol !== "https:" && !isLoopbackHttp)
    || target.username
    || target.password
    || target.pathname !== "/"
    || target.search
    || target.hash) {
    throw new Error("Live workspace URL must be HTTPS or loopback HTTP without credentials, path, query, or fragment");
  }
  return target.href;
}

// ── One-button Live Call (desktop-first flow) ─────────────────────────────
// Pressing Start Live Call on the dashboard creates the session + invite
// directly from the main process (riding the host cookies the Live workspace
// stored in the default session) and presents the stage OVERLAY window —
// countdown + QR + access code — without opening the dashboard web page.
// The subtitle controller then shows a Go-Live button to flip it live.

let liveCallSession = null; // { sessionId, version, baseUrl, status }
let isLiveCallStarting = false;
let isLiveCallEnding = false;
let isLiveCallGoingLive = false;

// Bounded so a hung workspace can never freeze Start Live Call or the
// save-time verification; expiry surfaces as NETWORK_UNAVAILABLE.
const LIVE_CALL_API_TIMEOUT_MS = 15_000;

async function liveCallApi(baseUrl, pathname, { method = "POST", body } = {}) {
  const origin = new URL(baseUrl).origin;
  let response;
  try {
    response = await net.fetch(new URL(pathname, baseUrl).href, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json", origin },
      signal: AbortSignal.timeout(LIVE_CALL_API_TIMEOUT_MS),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, code: "NETWORK_UNAVAILABLE" };
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401) return { ok: false, code: "HOST_LOGIN_REQUIRED" };
  if (!response.ok || payload?.ok !== true) {
    return { ok: false, code: typeof payload?.code === "string" ? payload.code : `HTTP_${response.status}` };
  }
  return { ok: true, data: payload.data };
}

function validateLiveCoverSignedUpload(value, sessionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "COVER_STORAGE_RESPONSE_INVALID" };
  const { uploadUrl, storageOrigin, objectPath, uploadTicket } = value;
  const pendingPrefix = `${sessionId}/pending/`;
  if (typeof uploadUrl !== "string"
    || typeof storageOrigin !== "string"
    || typeof objectPath !== "string"
    || typeof uploadTicket !== "string"
    || !objectPath.startsWith(pendingPrefix)
    || !/^[0-9a-f]{32}\.(?:jpg|png|webp)$/u.test(objectPath.slice(pendingPrefix.length))) {
    return { ok: false, code: "COVER_STORAGE_RESPONSE_INVALID" };
  }
  let target;
  let expectedOrigin;
  try {
    target = new URL(uploadUrl);
    expectedOrigin = new URL(storageOrigin);
  } catch {
    return { ok: false, code: "COVER_STORAGE_RESPONSE_INVALID" };
  }
  const expectedPath = `/storage/v1/object/upload/sign/live-covers/${objectPath}`;
  const queryKeys = [...target.searchParams.keys()];
  if (target.protocol !== "https:"
    || expectedOrigin.protocol !== "https:"
    || !/^[a-z0-9-]+\.supabase\.co$/u.test(expectedOrigin.hostname)
    || target.origin !== expectedOrigin.origin
    || expectedOrigin.pathname !== "/"
    || expectedOrigin.search
    || expectedOrigin.hash
    || expectedOrigin.username
    || expectedOrigin.password
    || expectedOrigin.port
    || target.port
    || target.username
    || target.password
    || target.pathname !== expectedPath
    || target.hash
    || queryKeys.length !== 1
    || queryKeys[0] !== "token"
    || !target.searchParams.get("token")) {
    return { ok: false, code: "COVER_STORAGE_RESPONSE_INVALID" };
  }
  return { ok: true, uploadUrl: target.href, objectPath, uploadTicket };
}

function matchesLiveCoverMagicBytes(bytes, contentType) {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  return contentType === "image/webp"
    && bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function validateLiveCoverImage(value) {
  if (value === undefined || value === null) return { ok: true, image: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "INVALID_COVER_IMAGE" };
  }
  const { contentType, size, base64 } = value;
  if (!LIVE_COVER_CONTENT_TYPES.has(contentType)
    || !Number.isSafeInteger(size)
    || size < 1
    || size > MAX_LIVE_COVER_BYTES
    || typeof base64 !== "string"
    || base64.length < 4
    || base64.length > Math.ceil(MAX_LIVE_COVER_BYTES / 3) * 4 + 4
    || base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) {
    return { ok: false, code: "INVALID_COVER_IMAGE" };
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== size || !matchesLiveCoverMagicBytes(bytes, contentType)) {
    return { ok: false, code: "INVALID_COVER_IMAGE" };
  }
  return { ok: true, image: { bytes, contentType } };
}

async function uploadLiveCover(baseUrl, sessionId, image) {
  if (!image) return { ok: true };
  const endpoint = `/api/live-sessions/${encodeURIComponent(sessionId)}/cover`;
  const prepared = await liveCallApi(baseUrl, endpoint, {
    body: {
      action: "prepare",
      size: image.bytes.byteLength,
      contentType: image.contentType,
    },
  });
  if (!prepared.ok) return prepared;
  const signed = validateLiveCoverSignedUpload(prepared.data, sessionId);
  if (!signed.ok) return signed;

  let uploadResponse;
  try {
    uploadResponse = await net.fetch(signed.uploadUrl, {
      method: "PUT",
      credentials: "omit",
      headers: {
        "content-type": image.contentType,
        "cache-control": "max-age=3600",
        "x-upsert": "false",
      },
      signal: AbortSignal.timeout(LIVE_COVER_UPLOAD_TIMEOUT_MS),
      body: image.bytes,
    });
  } catch {
    await discardPreparedLiveCover(baseUrl, endpoint, signed);
    return { ok: false, code: "COVER_UPLOAD_NETWORK_FAILED" };
  }
  if (!uploadResponse.ok) {
    await discardPreparedLiveCover(baseUrl, endpoint, signed);
    return { ok: false, code: liveCoverUploadFailureCode(uploadResponse.status) };
  }
  return liveCallApi(baseUrl, endpoint, {
    body: {
      action: "finalize",
      objectPath: signed.objectPath,
      uploadTicket: signed.uploadTicket,
    },
  });
}

async function discardPreparedLiveCover(baseUrl, endpoint, signed) {
  await liveCallApi(baseUrl, endpoint, {
    body: {
      action: "discard",
      objectPath: signed.objectPath,
      uploadTicket: signed.uploadTicket,
    },
  });
}

function liveCoverUploadFailureCode(status) {
  if (status === 401 || status === 403) return "COVER_UPLOAD_AUTH_EXPIRED";
  if (status === 409) return "COVER_UPLOAD_CONFLICT";
  if (status === 413) return "COVER_TOO_LARGE";
  if (status === 415) return "COVER_UNSUPPORTED_TYPE";
  if (status >= 500) return "COVER_STORAGE_UNAVAILABLE";
  return "COVER_UPLOAD_REJECTED";
}

async function cleanupPreparedLiveSession(baseUrl, sessionId) {
  return liveCallApi(baseUrl, `/api/live-sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

async function failPreparedLiveSession(baseUrl, sessionId, code, cause) {
  const cleanup = await cleanupPreparedLiveSession(baseUrl, sessionId);
  return cleanup.ok
    ? { ok: false, code, cause }
    : { ok: false, code: `${code}_CLEANUP_FAILED`, cause, cleanupCode: cleanup.code };
}

const LIVE_DRAFT_LANGUAGES = new Set(["en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt", "fr", "de", "ru", "hi", "id", "vi", "it"]);
const GLOSSARY_PRESET_ERROR_CODES = new Set([
  "HOST_LOGIN_REQUIRED",
  "NETWORK_UNAVAILABLE",
  "INVALID_GLOSSARY_PRESET",
  "GLOSSARY_PRESET_LIMIT_REACHED",
  "GLOSSARY_PRESET_NAME_CONFLICT",
  "GLOSSARY_PRESET_VERSION_CONFLICT",
  "GLOSSARY_PRESET_NOT_FOUND",
]);
const GLOSSARY_PRESET_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sanitizeGlossaryPresetInput(value, { includeIdentity = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = typeof value.name === "string" ? value.name.normalize("NFC").trim() : "";
  const domain = typeof value.domain === "string" ? value.domain.normalize("NFC").trim() : "";
  const glossary = typeof value.glossary === "string" ? value.glossary.normalize("NFC").trim() : "";
  const languageA = value.languagePair?.a;
  const languageB = value.languagePair?.b;
  if (!name || [...name].length > 80 || /[<>]|\p{Cc}|\p{Cf}/u.test(name)
    || [...domain].length > 600 || /[<>]|\p{Cc}|\p{Cf}/u.test(domain)
    || !glossary || [...glossary].length > 16_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cf}/u.test(glossary)
    || !LIVE_DRAFT_LANGUAGES.has(languageA) || !LIVE_DRAFT_LANGUAGES.has(languageB) || languageA === languageB) {
    return null;
  }
  const input = { name, domain, glossary, languagePair: { a: languageA, b: languageB } };
  if (!includeIdentity) return input;
  if (typeof value.id !== "string" || !GLOSSARY_PRESET_UUID_PATTERN.test(value.id)
    || !Number.isSafeInteger(value.version) || value.version < 1) return null;
  return { id: value.id, version: value.version, ...input };
}

function sanitizeRemoteGlossaryPreset(value) {
  const input = sanitizeGlossaryPresetInput(value, { includeIdentity: true });
  if (!input || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) return null;
  return { ...input, updatedAt: new Date(value.updatedAt).toISOString() };
}

function glossaryPresetFailure(result) {
  const code = GLOSSARY_PRESET_ERROR_CODES.has(result?.code) ? result.code : "NETWORK_UNAVAILABLE";
  return { ok: false, error: typeof result?.error === "string" ? result.error.slice(0, 240) : "용어집을 동기화할 수 없습니다.", code };
}

async function liveCallApiWithHostSession(baseUrl, pathname, options) {
  const first = await liveCallApi(baseUrl, pathname, options);
  if (first.ok || first.code !== "HOST_LOGIN_REQUIRED") return first;
  const login = await silentHostLogin(baseUrl);
  if (!login.ok) {
    if (login.code === "NO_STORED_LOGIN" || login.code === "HOST_LOGIN_REJECTED" || login.code === "HOST_LOGIN_REQUIRED") {
      return { ok: false, error: "호스트 로그인이 필요합니다.", code: "HOST_LOGIN_REQUIRED" };
    }
    return glossaryPresetFailure(login);
  }
  // A single authentication refresh is safe; network failures and application
  // errors are never retried or hidden.
  return liveCallApi(baseUrl, pathname, options);
}

function sanitizeLiveCallDraft(draft, subtitleSettings = {}) {
  const source = draft && typeof draft === "object" ? draft : {};
  const title = typeof source.title === "string" && source.title.trim()
    ? source.title.trim().slice(0, 100)
    : "Live Session";
  const scheduledAt = typeof source.scheduledAt === "string" && Number.isFinite(Date.parse(source.scheduledAt))
    ? new Date(source.scheduledAt).toISOString()
    : null;
  const maxViewers = Number.isInteger(source.maxViewers)
    ? Math.min(50, Math.max(2, source.maxViewers))
    : 50;
  const configuredLanguages = Array.isArray(subtitleSettings.translationLanguages)
    ? subtitleSettings.translationLanguages
    : source.languages;
  const languages = Array.isArray(configuredLanguages)
    ? [...new Set(configuredLanguages.filter((code) => LIVE_DRAFT_LANGUAGES.has(code)))].slice(0, 3)
    : [];
  return {
    title,
    scheduledAt,
    sessionType: "meeting",
    outputMode: subtitleSettings.outputMode === "audio" ? "audio" : "captions",
    voiceProvider: "gemini",
    // The webapp schema is .strict() and glossaryPack is REQUIRED — omitting
    // it turns every create into a 400.
    glossaryPack: "general_cre",
    maxViewers,
    languages: languages.length ? languages : ["ko", "en"],
    displayLanguage: sanitizeLiveCaptionDisplayLanguage(source.displayLanguage),
  };
}

function toLiveCallApiInput(config) {
  return {
    title: config.title,
    scheduledAt: config.scheduledAt,
    sessionType: config.sessionType,
    outputMode: config.outputMode,
    voiceProvider: config.voiceProvider,
    glossaryPack: config.glossaryPack,
    maxViewers: config.maxViewers,
    languages: config.languages,
  };
}

async function openLiveStageOverlay(baseUrl, sessionId, invite) {
  const origin = new URL(baseUrl).origin;
  const stagePath = `/stage/${encodeURIComponent(sessionId)}`;
  const fragment = invite
    ? `#${new URLSearchParams({ invite: invite.url, code: invite.admissionCode }).toString()}`
    : "";
  const placement = stageWindowPlacement();
  const window = new BrowserWindow({
    ...(placement?.bounds ?? { width: 1280, height: 800 }),
    fullscreen: false,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    title: "NOVA Stage",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  try {
    await window.loadURL(`${origin}${stagePath}${fragment}`);
    if (!isExactLiveStageUrl(window.webContents.getURL(), origin, stagePath)) {
      throw new Error("STAGE_OPEN_FAILED");
    }
    adoptStageWindow(window, origin, stagePath);
  } catch {
    if (!window.isDestroyed()) window.destroy();
    throw new Error("STAGE_OPEN_FAILED");
  }
  return window;
}

function isExactLiveStageUrl(value, allowedOrigin, allowedPath) {
  const target = parseHttpTarget(value);
  return Boolean(target
    && target.origin === allowedOrigin
    && target.pathname === allowedPath
    && target.search === "");
}

// Live Call feature flag (LIVE_CALL_CONTRACT C9): default on; only the
// explicit string "false" turns the Live workspace entry points off. Base
// caption features are unaffected either way.
function isLiveCallEnabled(environment = process.env) {
  const raw = environment.REALTIME_NOEL_LIVE_CALL_ENABLED;
  if (typeof raw !== "string") return true;
  return raw.trim().toLowerCase() !== "false";
}

// Pure display selection for the stage view (C8): the QR stage sits on the
// SAME monitor as the caption overlay ("자막이 생성되는 모니터와 동일한 위치"),
// resolved by resolveSelectedOverlayDisplay — the persisted selection, then a
// non-primary display by default. Fullscreen while the primary display remains
// for the controller/dashboard; a mirror-like large window on a single display.
function resolveStageDisplayPlacement(displays, primaryDisplayId, preferredDisplayId = "") {
  const connected = Array.isArray(displays) ? displays.filter(Boolean) : [];
  if (connected.length === 0) return null;
  const target = resolveSelectedOverlayDisplay(connected, preferredDisplayId, { id: primaryDisplayId });
  return { bounds: target.bounds, fullscreen: connected.length > 1 };
}

function stageWindowPlacement() {
  return resolveStageDisplayPlacement(
    screen.getAllDisplays(),
    screen.getPrimaryDisplay().id,
    preferredOverlayDisplayId,
  );
}

function applyStagePlacement(window, placement) {
  if (!window || window.isDestroyed() || !placement) return;
  if (window.isFullScreen() && !placement.fullscreen) window.setFullScreen(false);
  if (!window.isFullScreen()) window.setBounds(placement.bounds);
  if (placement.fullscreen) {
    if (!window.isFullScreen()) window.setFullScreen(true);
  } else {
    window.maximize();
  }
  if (!window.isVisible()) window.show();
}

function repositionStageWindow() {
  if (!stageWindow || stageWindow.isDestroyed()) return;
  applyStagePlacement(stageWindow, stageWindowPlacement());
}

function adoptStageWindow(window, allowedOrigin, allowedPath) {
  if (stageWindow && stageWindow !== window && !stageWindow.isDestroyed()) stageWindow.destroy();
  stageWindow = window;
  const guardNavigation = (event, deprecatedUrl) => {
    const targetUrl = typeof event.url === "string" ? event.url : deprecatedUrl;
    if (isExactLiveStageUrl(targetUrl, allowedOrigin, allowedPath)) return;
    event.preventDefault();
    const target = parseHttpTarget(targetUrl);
    if (!target || target.origin !== allowedOrigin) openAllowedExternal(targetUrl);
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const target = parseHttpTarget(targetUrl);
    if (!target || target.origin !== allowedOrigin) openAllowedExternal(targetUrl);
    return { action: "deny" };
  });
  window.on("closed", () => {
    if (stageWindow === window) stageWindow = null;
  });
  applyStagePlacement(window, stageWindowPlacement());
}

function openAllowedExternal(value) {
  const target = parseAllowedExternalTarget(value);
  if (!target) return false;
  void shell.openExternal(target.href).catch(() => {
    console.warn("[live] external link could not be opened");
  });
  return true;
}

function parseAllowedExternalTarget(value) {
  if (typeof value !== "string" || /[\r\n]/u.test(value)) return null;
  let target;
  try {
    target = new URL(value);
  } catch {
    return null;
  }
  if (target.protocol === "https:" && !target.username && !target.password) return target;
  if (target.protocol !== "mailto:") return null;
  if (value.length > MAILTO_MAX_URL_LENGTH
    || target.href.length > MAILTO_MAX_URL_LENGTH
    || target.host
    || target.hash
    || /%0[ad]/iu.test(value)) {
    return null;
  }
  const allowedFields = new Set(["subject", "body"]);
  const seenFields = new Set();
  for (const [rawField, fieldValue] of target.searchParams) {
    const field = rawField.toLowerCase();
    if (!allowedFields.has(field)
      || seenFields.has(field)
      || /[\r\n]/u.test(fieldValue)
      || /%0[ad]/iu.test(fieldValue)) {
      return null;
    }
    seenFields.add(field);
  }
  if (!target.pathname && seenFields.size === 0) return null;
  return target;
}

function parseHttpTarget(value) {
  try {
    const target = new URL(value);
    if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) return null;
    return target;
  } catch {
    return null;
  }
}

function createOverlayWindow(url) {
  overlayUrl = url;
  syncOverlayBounds();
}

function createControllerWindow(url) {
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const overlayDisplay = resolveSelectedOverlayDisplay(displays, preferredOverlayDisplayId, primaryDisplay);
  const controllerDisplay = resolveControllerDisplay(displays, overlayDisplay, primaryDisplay) ?? primaryDisplay;
  // Wide mini-player bar: every control fits one row on common displays; on
  // narrow screens the row wraps and fit-height grows the window to match.
  // Sized so the packed row NEVER wraps in any state the console can reach.
  // Measured worst case = 1098px of controls + 184px of chrome = 1283, where the
  // 1098 has every conditionally-shown control visible at once: the Live Call
  // group with Host Speak, the voice-provider cluster (shown whenever outputMode
  // is not captions-only), the "Main · Hide · Quit" window cluster, and an
  // elapsed readout grown to `360:12` — its minutes are unbounded, so it widens
  // by a character about an hour into a call and used to push the row over
  // mid-session. The remainder is headroom for one more control.
  // Only the INITIAL width: the renderer measures the console's real content
  // width and the fit-size IPC resizes the window to hug it, in every session
  // state. A fixed width left slack that pushed the right-hand cluster away.
  const width = Math.min(1152, Math.max(CONTROLLER_MIN_WIDTH, controllerDisplay.workArea.width - 48));
  // Mini-player console: a single packed row. This is only the INITIAL
  // height — the renderer measures its exact content height and the
  // subtitle-controller:fit-height IPC resizes the window to hug it, so the
  // transparent window never shows an empty band.
  const height = 84;
  const x = Math.round(controllerDisplay.workArea.x + (controllerDisplay.workArea.width - width) / 2);
  const y = Math.round(controllerDisplay.workArea.y + controllerDisplay.workArea.height - height - 120);
  controllerWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: CONTROLLER_MIN_WIDTH,
    minHeight: height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    show: false,
    title: "NOVA Subtitle Controller",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "preload.js"),
    },
  });
  controllerWindow.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL, 1);
  controllerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  const loadController = () => controllerWindow.loadURL(`${url}/subtitle-controller.html`);
  // The controller is how the host ends a call and now how bridge failures are
  // reported, so a dead controller renderer must come back too.
  attachRendererRecovery(controllerWindow, { label: "controller", reload: loadController });
  void Promise.resolve(loadController()).catch(() => { /* did-fail-load drives the retry */ });
  controllerWindow.on("closed", () => {
    controllerWindow = null;
  });
}

function createOverlayWindowForDisplay(display) {
  const window = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    show: false,
    title: "NOVA Subtitle Overlay",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "preload.js"),
    },
  });
  window.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL, 1);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.setIgnoreMouseEvents(true, { forward: true });
  const displayId = String(display.id);
  const loadOverlay = () => {
    // The first load runs BEFORE syncOverlayBounds records this window in the
    // map, so an "is the current window" test would skip it and leave the
    // display permanently blank. Only a slot already owned by a DIFFERENT
    // window means this one was superseded.
    if (isSupersededOverlayWindow(window, displayId)) return Promise.resolve();
    return window.loadURL(`${overlayUrl}/subtitle-overlay.html`);
  };
  // An overlay whose loadURL failed never fires ready-to-show, so that display
  // silently had no subtitles for the rest of the session. Retry with backoff
  // and show it as soon as the page actually renders.
  attachRendererRecovery(window, { label: `overlay:${display.id}`, reload: loadOverlay });
  // A dead overlay renderer can never restore click-through itself, and the 1s
  // watchdog re-applies `setIgnoreMouseEvents(!interactiveOverlayIds.has(id))`
  // forever — so a crash while the cursor sat on a subtitle box left this
  // fullscreen transparent window swallowing EVERY click on that display, with
  // focusable:false meaning the clicks went nowhere at all. That is
  // indistinguishable from "the app is gone / hidden under the overlay". Drop the
  // stale hover claim the moment the page dies and make the window
  // click-through again immediately, rather than waiting on a reload that may be
  // up to 15s away or may never succeed.
  window.webContents.on("render-process-gone", () => {
    interactiveOverlayIds.delete(window.id);
    if (!window.isDestroyed()) window.setIgnoreMouseEvents(true, { forward: true });
  });
  window.webContents.on("did-finish-load", () => {
    // A freshly loaded document has no hover state, and subtitle-overlay.js only
    // reports `setOverlayInteractive(false)` on a mousemove that CHANGES its
    // local flag — after a reload that flag starts false, so it would never send
    // the release and the stale claim would be permanent.
    interactiveOverlayIds.delete(window.id);
    if (!overlayEnabled || isQuitting || window.isDestroyed() || !isCurrentOverlayWindow(window, displayId)) return;
    window.setIgnoreMouseEvents(true, { forward: true });
    const floor = typeof liveGatewayBridge === "undefined" ? null : liveGatewayBridge?.lastFloorMessage;
    if (typeof liveGatewayBridge !== "undefined"
      && liveGatewayBridge?.ready === true
      && floor?.type === "floor"
      && floor.sessionId === liveGatewayBridge.session?.sessionId) {
      window.webContents.send("live-call:floor", floor);
    }
    window.showInactive();
  });
  void Promise.resolve(loadOverlay()).catch(() => { /* did-fail-load drives the retry */ });
  window.once("ready-to-show", () => {
    if (!overlayEnabled || overlaysMuted || isQuitting || !isCurrentOverlayWindow(window, displayId)) return;
    window.showInactive();
  });
  window.on("closed", () => {
    interactiveOverlayIds.delete(window.id);
    if (overlayWindows.get(displayId) === window) overlayWindows.delete(displayId);
  });
  return window;
}

function isCurrentOverlayWindow(window, displayId) {
  return overlayWindows.get(String(displayId)) === window;
}

function isSupersededOverlayWindow(window, displayId) {
  const current = overlayWindows.get(String(displayId));
  return Boolean(current) && current !== window;
}

// Reconcile the overlay window set with the displays that should carry one.
// Windows for displays that left the set (unplugged, or the "all displays"
// tick turned off) are destroyed; the rest are created or re-bounded in place
// so an already-rendering overlay is never torn down just to move.
function syncOverlayBounds() {
  if (!overlayEnabled || isQuitting || !overlayUrl) return;
  const displays = screen.getAllDisplays();
  const preferredId = typeof preferredOverlayDisplayId === "string" ? preferredOverlayDisplayId : "";
  const primary = typeof screen.getPrimaryDisplay === "function" ? screen.getPrimaryDisplay() : displays[0];
  const targets = resolveOverlayDisplays(displays, preferredId, primary, overlayAllDisplays);
  const selected = resolveSelectedOverlayDisplay(displays, preferredId, primary);
  selectedOverlayDisplayId = selected ? String(selected.id) : "";
  const targetIds = new Set(targets.map((display) => String(display.id)));
  for (const [displayId, window] of [...overlayWindows]) {
    if (targetIds.has(displayId)) continue;
    overlayWindows.delete(displayId);
    if (window && !window.isDestroyed()) window.destroy();
  }
  for (const display of targets) {
    const displayId = String(display.id);
    const existing = overlayWindows.get(displayId);
    if (!existing || existing.isDestroyed()) {
      overlayWindows.set(displayId, createOverlayWindowForDisplay(display));
    } else {
      existing.setBounds(display.bounds);
    }
  }
}

function eachOverlayWindow(callback) {
  for (const window of overlayWindows.values()) {
    if (window && !window.isDestroyed()) callback(window);
  }
}

function maintainOverlayWindow() {
  if (isQuitting) return;
  if (!overlayEnabled || overlaysMuted) {
    eachOverlayWindow((window) => window.hide());
    return;
  }
  syncOverlayBounds();
  reassertOverlayTop();
  eachOverlayWindow((window) => {
    window.setIgnoreMouseEvents(!interactiveOverlayIds.has(window.id), { forward: true });
    if (!window.isVisible()) window.showInactive();
  });
}

// Re-assert the always-on-top level and window ordering. macOS silently drops a
// window's level when another app enters fullscreen, on Space switches, and on
// display sleep/wake. Calling this from focus/activation events (not just the
// 1s watchdog) closes the up-to-1s gap where the overlay could fall behind a
// freshly fullscreened presentation. setVisibleOnAllWorkspaces is intentionally
// NOT re-called here: re-calling it every tick causes Space-rejoin flicker; it
// is set once at window creation.
function reassertOverlayTop() {
  if (!overlayEnabled || overlaysMuted || isQuitting) return;
  eachOverlayWindow((window) => {
    window.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL, 1);
    window.moveTop();
  });
  if (controllerWindow && !controllerWindow.isDestroyed() && controllerWindow.isVisible()) {
    controllerWindow.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL, 1);
    controllerWindow.moveTop();
  }
}

// Live Call arms via the workspace even when captions are not running, so
// the floating controller (Go-Live / End / Host Speak) must be summoned
// explicitly — caption start/stop is what normally shows and hides it.
// ── Live Call gateway bridge (main-process side) ───────────────────────────
// Cloud Run rejects browser WebSockets whose Origin is not the webapp, so the
// desktop cannot connect from the renderer. The main process owns the HOST
// gateway socket instead — authenticated via the trusted non-browser path
// (x-realtime-noel-client + Bearer HOST token, no Origin) — and the renderer
// captures the same 24 kHz / 100 ms PCM packets as Caption-only. The adapter
// below keeps the proven Caption-only FIR and 16 kHz / 40 ms PCM payload while
// adding the gateway's versioned source tag.
const LIVE_BRIDGE_FRAME_BYTES = 1280;
const CAPTION_BRIDGE_PACKET_BYTES = 4_800;
const liveBridgeAudioAdapters = new Map();
let liveGatewayBridge = null; // { socket, ready, session }
// Reconnect state. The timer id MUST be stored so stopLiveGatewayBridge can
// cancel it — without that, ending a call left a pending retry that reopened the
// bridge against a dead session.
let liveBridgeReconnectTimer = null;
let liveBridgeReconnectAttempts = 0;
let liveBridgeCredentialRefreshTimer = null;
// Last bridge problem, surfaced to the controller via live-call:get-state so the
// host is never left watching a running timer over dead air.
let liveBridgeAlert = null;
let hasNotifiedLiveBridgeFailure = false;
let hostSpeakInFlight = null;
let liveTranslationReconnectInFlight = null;
let liveCaptionPreflightSequence = 0;
const liveCaptionPreflightRequests = new Map();
let liveGatewayEnsureInFlight = null;

function getLiveBridgeCredentialRefreshDelay(expiresAt) {
  const expiresAtMilliseconds = Date.parse(String(expiresAt ?? ""));
  if (!Number.isFinite(expiresAtMilliseconds)) return null;
  return Math.min(
    LIVE_BRIDGE_CREDENTIAL_REFRESH_MAX_MS,
    Math.max(0, expiresAtMilliseconds - Date.now() - LIVE_BRIDGE_CREDENTIAL_REFRESH_SKEW_MS),
  );
}

function clearLiveBridgeCredentialRefresh() {
  if (liveBridgeCredentialRefreshTimer) clearTimeout(liveBridgeCredentialRefreshTimer);
  liveBridgeCredentialRefreshTimer = null;
}

function scheduleLiveGatewayCredentialRefresh(bridge, expiresAt) {
  clearLiveBridgeCredentialRefresh();
  const delay = getLiveBridgeCredentialRefreshDelay(expiresAt);
  if (delay === null || isQuitting || liveGatewayBridge !== bridge
    || liveCallSession !== bridge.session || bridge.session.status !== "live") return;
  liveBridgeCredentialRefreshTimer = setTimeout(() => {
    liveBridgeCredentialRefreshTimer = null;
    if (isQuitting || liveGatewayBridge !== bridge
      || liveCallSession !== bridge.session || bridge.session.status !== "live") return;
    // The gateway cannot re-authenticate an open socket. Rotate one minute before
    // expiry; the close handler reconnects with a fresh token and the SAME
    // session object, allowing the gateway's grace reattach to preserve pipeline,
    // floor, caption sequence, and durable transcript continuity.
    try { bridge.socket.close(4001, "gateway credential refresh"); } catch {
      scheduleLiveGatewayReconnect(bridge.session);
    }
  }, delay);
  liveBridgeCredentialRefreshTimer?.unref?.();
}

function setLiveBridgeAlert(alert) {
  liveBridgeAlert = alert;
}

function clearLiveBridgeAlert() {
  liveBridgeAlert = null;
  hasNotifiedLiveBridgeFailure = false;
}

function liveBridgeStatus() {
  const floorState = {
    floorKnown: liveGatewayBridge?.floorKnown === true,
    hostAudioBlocked: liveGatewayBridge?.isHostAudioBlocked !== false,
  };
  if (liveBridgeAlert) {
    const state = ["connecting", "reconnecting", "failed"].includes(liveBridgeAlert.state)
      ? liveBridgeAlert.state
      : "connecting";
    const code = typeof liveBridgeAlert.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(liveBridgeAlert.code)
      ? liveBridgeAlert.code
      : null;
    const attempts = Number.isSafeInteger(liveBridgeAlert.attempts)
      ? Math.max(0, Math.min(1_000_000, liveBridgeAlert.attempts))
      : null;
    // This IPC is polled by an unprivileged renderer. Project only bounded
    // operational metadata; provider errors and renderer-supplied details can
    // contain transcript text, URLs, or credentials and stay main-process-only.
    return { state, code, ...(attempts === null ? {} : { attempts }), ...floorState };
  }
  if (liveGatewayBridge?.ready === true) {
    const languageStatuses = [...(liveGatewayBridge.languageStatuses?.values?.() ?? [])];
    if (languageStatuses.some((status) => status === "preparing" || status === "unavailable")) {
      return { state: "reconnecting", code: "TRANSLATION_RECOVERING", ...floorState };
    }
    return { state: "connected", code: null, ...floorState };
  }
  return { state: liveGatewayBridge ? "connecting" : "idle", code: null, ...floorState };
}

// The only authoritative unmute is an authenticated floor snapshot for this
// exact session with holder:null. Missing/malformed/stale snapshots therefore
// fail closed and cannot leak host mic or loopback audio during a hand-off.
function shouldBlockLiveHostAudioForFloor(message, sessionId) {
  if (!message || message.type !== "floor" || message.sessionId !== sessionId) return true;
  return message.holder !== null;
}

function relayLiveCallFloorToRenderers(message) {
  const rendererWindows = [dashboardWindow, ...overlayWindows.values()];
  for (const rendererWindow of rendererWindows) {
    if (!rendererWindow) continue;
    if (!rendererWindow.isDestroyed()) rendererWindow.webContents.send("live-call:floor", message);
  }
}

// The controller polls live-call:get-state, but a modal is what actually reaches
// a host who is mid-presentation with the dashboard hidden.
function notifyLiveBridgeFailure(title, message, type = "error") {
  if (hasNotifiedLiveBridgeFailure || isQuitting) return;
  hasNotifiedLiveBridgeFailure = true;
  console.error(`[live-bridge] ${title}: ${message}`);
  showControllerWindow();
  try {
    void dialog.showMessageBox({ type, title, message, buttons: ["OK"], noLink: true });
  } catch { /* dialogs are unavailable in headless test runs */ }
}

function clearLiveBridgeReconnect() {
  if (liveBridgeReconnectTimer) clearTimeout(liveBridgeReconnectTimer);
  liveBridgeReconnectTimer = null;
}

function getLiveBridgeReconnectDelay(attempt, random = Math.random) {
  if (attempt < 5) return LIVE_BRIDGE_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt);
  const jitterRatio = Math.min(1, Math.max(0, Number(random()) || 0));
  return LIVE_BRIDGE_SLOW_RETRY_MIN_MS + LIVE_BRIDGE_SLOW_RETRY_JITTER_MS * jitterRatio;
}

// Fast exponential backoff followed by a rate-safe slow-retry mode. The call ends only
// at the explicit stop/end/quit boundaries below; a transient outage must never
// silently turn a still-running two-hour session into dead air forever.
function scheduleLiveGatewayReconnect(armedSession) {
  if (isQuitting || liveBridgeReconnectTimer) return;
  if (liveCallSession !== armedSession || armedSession.status !== "live") return;
  if (liveBridgeReconnectAttempts === LIVE_BRIDGE_SLOW_RETRY_AFTER) {
    notifyLiveBridgeFailure(
      "Live Call is reconnecting",
      "NOVA is still automatically reconnecting audio and captions. The meeting and its saved record remain active.",
      "warning",
    );
  }
  const delay = getLiveBridgeReconnectDelay(liveBridgeReconnectAttempts);
  liveBridgeReconnectAttempts += 1;
  setLiveBridgeAlert({
    state: "reconnecting",
    code: "GATEWAY_RECONNECTING",
    attempts: liveBridgeReconnectAttempts,
    message: "게이트웨이에 다시 연결하고 있습니다…",
  });
  console.warn(`[live-bridge] reconnect attempt ${liveBridgeReconnectAttempts} in ${delay}ms`);
  liveBridgeReconnectTimer = setTimeout(() => {
    liveBridgeReconnectTimer = null;
    if (isQuitting || liveCallSession !== armedSession || armedSession.status !== "live") return;
    void ensureLiveGatewayBridge().then((result) => {
      // An early failure (token/config fetch, unreachable gateway) never opens a
      // socket, so there is no `close` event to drive the next retry — re-arm here.
      if (!result?.ok) scheduleLiveGatewayReconnect(armedSession);
    }, () => scheduleLiveGatewayReconnect(armedSession));
  }, delay);
}

async function fetchGatewayConnection(armedSession) {
  const tokenResult = await liveCallApi(
    armedSession.baseUrl,
    `/api/live-sessions/${encodeURIComponent(armedSession.sessionId)}/gateway-token`,
    { body: {} },
  );
  if (!tokenResult.ok) return tokenResult;
  const credentialRefreshDelay = getLiveBridgeCredentialRefreshDelay(tokenResult.data?.expiresAt);
  if (credentialRefreshDelay === null || credentialRefreshDelay <= 0) {
    return { ok: false, code: "GATEWAY_TOKEN_EXPIRY_INVALID" };
  }
  const configResult = await liveCallApi(armedSession.baseUrl, "/api/live-config", { method: "GET" });
  const gatewayUrl = typeof configResult.data?.gatewayUrl === "string" ? configResult.data.gatewayUrl : "";
  if (!configResult.ok || !gatewayUrl) return { ok: false, code: "GATEWAY_URL_UNAVAILABLE" };
  return {
    ok: true,
    gatewayUrl,
    token: tokenResult.data?.token ?? "",
    expiresAt: tokenResult.data?.expiresAt,
  };
}

function trustedGatewayHeaders(token) {
  return { "x-realtime-noel-client": "desktop-main", authorization: `Bearer ${token}` };
}

async function preflightLiveCallCaptionSession(settingsStore, armedSession) {
  if (!dashboardWindow || dashboardWindow.isDestroyed() || dashboardWindow.webContents?.isDestroyed?.()) {
    return { ok: false, error: "자막 화면을 준비할 수 없습니다.", code: "LIVE_CAPTION_RENDERER_UNAVAILABLE" };
  }
  try {
    const saved = await settingsStore.load();
    validateSubtitleSettings(saved?.subtitle);
    const captionConfig = createGeminiCaptionConfig({
      ...(saved?.subtitle ?? {}),
      languages: armedSession.gatewaySettings?.languages ?? saved?.subtitle?.translationLanguages,
      outputMode: armedSession.gatewaySettings?.outputMode ?? saved?.subtitle?.outputMode,
      audioLanguage: saved?.subtitle?.audioLanguage,
      glossaryPack: armedSession.gatewaySettings?.glossaryPack,
    });
    armedSession.gatewaySettings = {
      ...(armedSession.gatewaySettings ?? {}),
      voiceProvider: "gemini",
      glossaryText: captionConfig.glossary,
      translationTone: captionConfig.tone,
      domainText: captionConfig.domain,
      captionConfig,
      captionConfigFingerprint: geminiCaptionConfigFingerprint(captionConfig),
    };
    return { ok: true };
  } catch (error) {
    console.warn(`[live-bridge] local caption preflight failed: ${error?.message ?? error}`);
    return { ok: false, error: "자막 설정을 확인한 뒤 다시 시작해주세요.", code: "LIVE_CAPTION_PREFLIGHT_FAILED" };
  }
}

function requestRendererLiveCaptionPreflight(armedSession) {
  if (!dashboardWindow || dashboardWindow.isDestroyed() || dashboardWindow.webContents?.isDestroyed?.()) {
    return Promise.resolve({ ok: false, code: "LIVE_CAPTION_RENDERER_UNAVAILABLE" });
  }
  const requestId = `live-caption-preflight-${Date.now()}-${++liveCaptionPreflightSequence}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      liveCaptionPreflightRequests.delete(requestId);
      resolve({ ok: false, code: "LIVE_CAPTION_PREFLIGHT_TIMEOUT" });
    }, 12_000);
    liveCaptionPreflightRequests.set(requestId, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
    });
    dashboardWindow.webContents.send("live-call:preflight-request", {
      requestId,
      liveSessionId: armedSession.sessionId,
      title: armedSession.title ?? "",
      startedAt: armedSession.startedAt ?? "",
    });
  });
}

function cancelRendererLiveCaptionPreflight(requestId) {
  if (!requestId || !dashboardWindow || dashboardWindow.isDestroyed()) return;
  dashboardWindow.webContents.send("live-call:preflight-cancel", { requestId });
}

async function stopLiveGatewayBridge(reason, { terminateRemote = false } = {}) {
  // Cancel any armed retry FIRST: a pending reconnect used to survive
  // stop/end/quit and reopen the bridge against a session that was already gone.
  clearLiveBridgeReconnect();
  clearLiveBridgeCredentialRefresh();
  liveBridgeReconnectAttempts = 0;
  liveBridgeAudioAdapters.clear();
  const bridge = liveGatewayBridge;
  if (!bridge) return;
  liveGatewayBridge = null;
  bridge.captionRelay?.close();
  if (terminateRemote && bridge.socket.readyState === WebSocket.OPEN) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bridge.socket.off("message", onMessage);
        bridge.socket.off("close", finish);
        resolve();
      };
      const onMessage = (data) => {
        let message;
        try { message = JSON.parse(data.toString("utf8")); } catch { return; }
        if (message.type === "stopped" && message.sessionId === bridge.session.sessionId) finish();
      };
      const timer = setTimeout(finish, 1_500);
      bridge.socket.on("message", onMessage);
      bridge.socket.once("close", finish);
      try { bridge.socket.send(JSON.stringify({ type: "stop" })); } catch { finish(); }
    });
  }
  try { bridge.socket.close(1000, reason || "bridge stopped"); } catch { /* closed */ }
  console.info(`[live-bridge] stopped${reason ? ` (${reason})` : ""}`);
}

function adaptCaptionPcmForGateway(source, bytes) {
  let adapter = liveBridgeAudioAdapters.get(source);
  if (!adapter) {
    adapter = { pending: Buffer.alloc(0), downsample: createCaptionPcmResampler() };
    liveBridgeAudioAdapters.set(source, adapter);
  }
  const resampled = adapter.downsample(bytes);
  const available = adapter.pending.length > 0
    ? Buffer.concat([adapter.pending, resampled])
    : resampled;
  const frames = [];
  let offset = 0;
  while (available.length - offset >= LIVE_BRIDGE_FRAME_BYTES) {
    frames.push(available.subarray(offset, offset + LIVE_BRIDGE_FRAME_BYTES));
    offset += LIVE_BRIDGE_FRAME_BYTES;
  }
  adapter.pending = Buffer.from(available.subarray(offset));
  return frames;
}

async function ensureLiveGatewayBridgeOnce() {
  const armedSession = liveCallSession;
  if (!armedSession || armedSession.status !== "live") return { ok: false, code: "NOT_LIVE" };
  if (liveGatewayBridge?.session === armedSession) {
    return { ok: true, streaming: liveGatewayBridge.ready === true };
  }
  const connection = await fetchGatewayConnection(armedSession);
  if (!connection.ok) return connection;
  if (liveCallSession !== armedSession || armedSession.status !== "live" || isQuitting) {
    return { ok: false, code: "NOT_LIVE" };
  }
  // Host authorization requires the EXACT current session version; anything
  // (invites, admission, config) may have bumped it since arming, so always
  // read it fresh right before the gateway start.
  const currentSession = await liveCallApi(
    armedSession.baseUrl,
    `/api/live-sessions/${encodeURIComponent(armedSession.sessionId)}`,
    { method: "GET" },
  );
  if (currentSession.ok && Number.isSafeInteger(currentSession.data?.version)) {
    armedSession.version = currentSession.data.version;
  }
  // The session can end outside live-call:end (stage closed, cleanup, another
  // device). Disarm instead of retrying against a dead session forever —
  // which also blocked Start Live Call with LIVE_CALL_ALREADY_ARMED.
  const currentStatus = currentSession.ok ? currentSession.data?.status : null;
  if (currentStatus === "stopped" || currentStatus === "failed" || currentSession.code === "LIVE_SESSION_NOT_FOUND") {
    armedSession.status = "stopped";
    if (liveCallSession === armedSession) liveCallSession = null;
    relayLiveCallFloorToRenderers({
      type: "live-call-ended",
      sessionId: armedSession.sessionId,
    });
    void stopLiveGatewayBridge("session already ended", { terminateRemote: true });
    return { ok: false, code: "SESSION_ENDED" };
  }
  if (liveCallSession !== armedSession || armedSession.status !== "live" || isQuitting) {
    return { ok: false, code: "NOT_LIVE" };
  }
  if (liveGatewayBridge?.session === armedSession) {
    return { ok: true, streaming: liveGatewayBridge.ready === true };
  }
  let socket;
  try {
    socket = new WebSocket(connection.gatewayUrl, { headers: trustedGatewayHeaders(connection.token) });
  } catch {
    return { ok: false, code: "GATEWAY_UNREACHABLE" };
  }
  const captionRelayState = armedSession.captionRelayState ?? {
    lastFinalSeqByLanguage: new Map(),
    finalSnapshotByLanguage: new Map(),
  };
  armedSession.captionRelayState = captionRelayState;
  const bridge = {
    socket,
    ready: false,
    session: armedSession,
    floorKnown: false,
    isHostAudioBlocked: true,
    lastFloorMessage: null,
    languageStatuses: new Map(),
  };
  bridge.captionRelay = createLiveCaptionIpcRelay({
    lastFinalSeqByLanguage: captionRelayState.lastFinalSeqByLanguage,
    finalSnapshotByLanguage: captionRelayState.finalSnapshotByLanguage,
    send: (caption) => {
      if (liveGatewayBridge !== bridge) return;
      if (!dashboardWindow || dashboardWindow.isDestroyed() || dashboardWindow.webContents?.isDestroyed?.()) return;
      // The dashboard is the only caption IPC consumer. It relays the event to
      // the local subtitle WebSocket, which then fans out to every overlay.
      // Sending the same structured clone directly to N overlay renderers only
      // filled unused IPC queues; overlays subscribe directly only to floor.
      dashboardWindow.webContents.send("live-call:caption", caption);
    },
  });
  liveGatewayBridge = bridge;
  socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token: connection.token })));
  socket.on("message", (data) => {
    // 2026-07-26 fix: a replaced socket can flush queued callbacks after a new
    // bridge owns the session. Fence it so stale producer epochs never repaint
    // the canonical desktop transcript.
    if (liveGatewayBridge !== bridge) return;
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (message.type === "authenticated") {
      socket.send(JSON.stringify({
        type: "start",
        sessionId: armedSession.sessionId,
        version: armedSession.version,
        ...(armedSession.gatewaySettings ?? {}),
      }));
    } else if (message.type === "started" || message.type === "restarted") {
      bridge.ready = true;
      // A live pipeline is proof of recovery — reset the backoff so a later drop
      // hours into the call gets the full fast-retry budget again.
      liveBridgeReconnectAttempts = 0;
      clearLiveBridgeAlert();
      scheduleLiveGatewayCredentialRefresh(bridge, connection.expiresAt);
      console.info("[live-bridge] gateway host pipeline is running");
    } else if (message.type === "language-status") {
      if (!bridge.ready || message.sessionId !== armedSession.sessionId) return;
      if (typeof message.language !== "string" || !["en", "ko"].includes(message.language)) return;
      if (!["preparing", "ready", "unavailable"].includes(message.status)) return;
      // Keep provider details inside the main process. The controller receives
      // only the aggregate state from liveBridgeStatus on its next poll.
      bridge.languageStatuses.set(message.language, message.status);
    } else if (message.type === "caption") {
      if (!bridge.ready) return;
      if (message.sessionId !== armedSession.sessionId) return;
      // The gateway retains both language lanes for web history. Desktop
      // surfaces receive only the translated lane opposite this utterance's
      // detected source language, independent of the old fixed display setting.
      if (!shouldDisplayLiveCaption(message, armedSession.displayLanguage)) return;
      bridge.captionRelay.push(message);
    } else if (message.type === "floor") {
      // Floor authority exists only after this socket's host pipeline started.
      // A pre-start payload must never be able to unmute local capture.
      if (!bridge.ready) return;
      bridge.floorKnown = message.sessionId === armedSession.sessionId
        && (message.holder === null
          || (typeof message.holder?.participantId === "string" && message.holder.participantId.length > 0));
      bridge.isHostAudioBlocked = shouldBlockLiveHostAudioForFloor(message, armedSession.sessionId);
      // Any block is also a PCM epoch boundary. Discard sub-frame FIR/carry
      // state so host audio captured immediately before the hand-off cannot be
      // completed and forwarded after Host Speak resumes the floor.
      if (bridge.isHostAudioBlocked) liveBridgeAudioAdapters.clear();
      if (!bridge.floorKnown) {
        // Do not expose untrusted fields to renderers, but close their local
        // fallback gate immediately instead of waiting for the next state poll.
        bridge.lastFloorMessage = {
          type: "floor",
          sessionId: armedSession.sessionId,
          holder: { participantId: "unavailable" },
        };
        relayLiveCallFloorToRenderers(bridge.lastFloorMessage);
        return;
      }
      // 2026-07-26 fix: a floor change is an utterance boundary. Forward it to
      // every local caption surface before participant/host audio can produce
      // the next hypothesis, so the previous speaker's final cannot linger.
      bridge.lastFloorMessage = message;
      relayLiveCallFloorToRenderers(message);
    } else if (message.type === "error") {
      console.warn(`[live-bridge] gateway error: ${message.code ?? "unknown"}`);
      // A rejected start leaves the socket open but useless: close it so the
      // reconnect path retries with a freshly-read session version.
      if (!bridge.ready && ["SESSION_REVOKED", "INVALID_START", "HOST_START_TIMEOUT"].includes(message.code)) {
        try { socket.close(4000, "start rejected"); } catch { /* closed */ }
      }
    }
  });
  socket.on("error", (error) => {
    console.warn(`[live-bridge] socket error: ${error?.message ?? error}`);
  });
  socket.on("close", () => {
    if (liveGatewayBridge !== bridge) return;
    bridge.isHostAudioBlocked = true;
    bridge.floorKnown = false;
    liveBridgeAudioAdapters.clear();
    clearLiveBridgeCredentialRefresh();
    bridge.captionRelay.close();
    liveGatewayBridge = null;
    // Token rotation or a transient drop mid-call: reconnect while still live.
    if (liveCallSession === armedSession && armedSession.status === "live" && !isQuitting) {
      scheduleLiveGatewayReconnect(armedSession);
    }
  });
  return { ok: true, streaming: false };
}

async function ensureLiveGatewayBridge() {
  const armedSession = liveCallSession;
  if (!armedSession || armedSession.status !== "live") return { ok: false, code: "NOT_LIVE" };
  if (liveGatewayBridge?.session === armedSession) {
    return { ok: true, streaming: liveGatewayBridge.ready === true };
  }
  if (liveBridgeReconnectTimer) return { ok: true, streaming: false, reconnecting: true };
  if (liveGatewayEnsureInFlight) return liveGatewayEnsureInFlight;
  liveGatewayEnsureInFlight = ensureLiveGatewayBridgeOnce()
    .catch(() => ({ ok: false, code: "GATEWAY_UNREACHABLE" }))
    .then((result) => {
      const isRecoverable = !result.ok && !["NOT_LIVE", "SESSION_ENDED"].includes(result.code);
      if (isRecoverable && liveCallSession === armedSession && armedSession.status === "live" && !isQuitting) {
        setLiveBridgeAlert({
          state: "reconnecting",
          code: "GATEWAY_RECONNECTING",
          attempts: liveBridgeReconnectAttempts,
          message: "게이트웨이에 다시 연결하고 있습니다…",
        });
        scheduleLiveGatewayReconnect(armedSession);
        return { ok: true, streaming: false, reconnecting: true };
      }
      return result;
    })
    .finally(() => { liveGatewayEnsureInFlight = null; });
  return liveGatewayEnsureInFlight;
}

async function restartLiveTranslationBridge() {
  if (liveTranslationReconnectInFlight) return liveTranslationReconnectInFlight;
  liveTranslationReconnectInFlight = (async () => {
    const armedSession = liveCallSession;
    if (!armedSession || armedSession.status !== "live") return { ok: false, code: "NOT_LIVE" };
    setLiveBridgeAlert({
      state: "reconnecting",
      code: "TRANSLATION_RECONNECTING",
      message: "번역 연결을 다시 준비하고 있습니다…",
    });
    liveBridgeAudioAdapters.clear();

    let bridge = liveGatewayBridge;
    if (!bridge?.ready || bridge.socket.readyState !== WebSocket.OPEN) {
      stopLiveGatewayBridge("manual translation reconnect");
      const result = await ensureLiveGatewayBridge();
      if (!result.ok) scheduleLiveGatewayReconnect(armedSession);
      return result;
    }

    const current = await liveCallApi(
      armedSession.baseUrl,
      `/api/live-sessions/${encodeURIComponent(armedSession.sessionId)}`,
      { method: "GET" },
    );
    if (!current.ok) return current;
    if (Number.isSafeInteger(current.data?.version)) armedSession.version = current.data.version;
    if (liveCallSession !== armedSession || liveGatewayBridge !== bridge) {
      return { ok: false, code: "LIVE_CALL_STATE_CHANGED" };
    }

    bridge.ready = false;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bridge.socket.off("message", onMessage);
        bridge.socket.off("close", onClose);
        resolve(result);
      };
      const onMessage = (data) => {
        let message;
        try { message = JSON.parse(data.toString("utf8")); } catch { return; }
        if (message.type === "restarted") finish({ ok: true, streaming: true });
        else if (message.type === "error") {
          try { bridge.socket.close(4000, "translation restart rejected"); } catch { /* closed */ }
          finish({ ok: false, code: typeof message.code === "string" ? message.code : "GATEWAY_ERROR" });
        }
      };
      const onClose = () => finish({ ok: false, code: "GATEWAY_CLOSED" });
      const timer = setTimeout(() => {
        try { bridge.socket.close(4000, "translation restart timeout"); } catch { /* closed */ }
        finish({ ok: false, code: "GATEWAY_TIMEOUT" });
      }, 20_000);
      bridge.socket.on("message", onMessage);
      bridge.socket.once("close", onClose);
      try {
        bridge.socket.send(JSON.stringify({
          type: "restart",
          sessionId: armedSession.sessionId,
          version: armedSession.version,
          ...(armedSession.gatewaySettings ?? {}),
        }));
      } catch {
        finish({ ok: false, code: "GATEWAY_UNREACHABLE" });
      }
    });
  })().finally(() => { liveTranslationReconnectInFlight = null; });
  return liveTranslationReconnectInFlight;
}

// Host Speak: reclaim the speaking floor from a participant. Prefers the
// running bridge socket; otherwise opens a short-lived trusted connection.
function hostSpeakViaGateway(gatewayUrl, token) {
  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "GATEWAY_TIMEOUT" }), 10_000);
    try {
      socket = new WebSocket(gatewayUrl, { headers: trustedGatewayHeaders(token) });
    } catch {
      finish({ ok: false, code: "GATEWAY_UNREACHABLE" });
      return;
    }
    socket.on("error", () => finish({ ok: false, code: "GATEWAY_UNREACHABLE" }));
    socket.on("close", () => finish({ ok: false, code: "GATEWAY_CLOSED" }));
    socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token })));
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (message.type === "authenticated") socket.send(JSON.stringify({ type: "host-speak" }));
      else if (message.type === "host-speak-started") finish({ ok: true });
      else if (message.type === "error") finish({ ok: false, code: typeof message.code === "string" ? message.code : "GATEWAY_ERROR" });
    });
  });
}

function hostSpeakViaActiveBridge() {
  const bridge = liveGatewayBridge;
  if (!bridge?.ready || bridge.socket.readyState !== WebSocket.OPEN) return null;
  if (hostSpeakInFlight) return hostSpeakInFlight;
  hostSpeakInFlight = new Promise((resolve) => {
    const socket = bridge.socket;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      resolve(result);
    };
    const onMessage = (data) => {
      let message;
      try { message = JSON.parse(data.toString("utf8")); } catch { return; }
      if (message.type === "host-speak-started") finish({ ok: true });
      else if (message.type === "error") finish({ ok: false, code: typeof message.code === "string" ? message.code : "GATEWAY_ERROR" });
    };
    const onClose = () => finish({ ok: false, code: "GATEWAY_CLOSED" });
    const timer = setTimeout(() => finish({ ok: false, code: "GATEWAY_TIMEOUT" }), 3_000);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    try { socket.send(JSON.stringify({ type: "host-speak" })); } catch { finish({ ok: false, code: "GATEWAY_UNREACHABLE" }); }
  }).finally(() => { hostSpeakInFlight = null; });
  return hostSpeakInFlight;
}

// After the host ends a Live Call, pull the speaker-attributed transcript
// (and the meeting summary, when the workspace has already generated it)
// and import both into the local Records store. The summary generation on
// the workspace is asynchronous, so it is retried briefly before importing
// without one — the local server then generates its own from the lines.
async function archiveLiveCallSession(endedSession, localAppOrigin) {
  // 2026-07-26 fix: the gateway-canonical desktop session already owns this
  // exact record id. Wait for the renderer to finalize it and preserve its
  // bilingual source/translation lines; import is only a crash fallback.
  const localRecordUrl = new URL(
    `/api/subtitles/sessions/live-${encodeURIComponent(endedSession.sessionId)}`,
    localAppOrigin,
  );
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const response = await net.fetch(localRecordUrl.href);
      const payload = response.ok ? await response.json() : null;
      if (payload?.ok === true
        && typeof payload.data?.endedAt === "string"
        && payload.data.endedAt
        && Array.isArray(payload.data?.lines)
        && payload.data.lines.length > 0) return;
    } catch { /* fallback import below */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const language = endedSession.languages?.[0] ?? "ko";
  const transcript = await liveCallApi(
    endedSession.baseUrl,
    `/api/live-sessions/${encodeURIComponent(endedSession.sessionId)}/transcript?language=${encodeURIComponent(language)}`,
    { method: "GET" },
  );
  if (!transcript.ok || !Array.isArray(transcript.data?.utterances) || !transcript.data.utterances.length) return;
  let summary = null;
  for (let attempt = 0; attempt < 3 && !summary; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
    const result = await liveCallApi(
      endedSession.baseUrl,
      `/api/live-sessions/${encodeURIComponent(endedSession.sessionId)}/summary?language=${encodeURIComponent(language)}`,
      { method: "GET" },
    );
    if (result.ok && result.data?.summary) summary = result.data.summary;
  }
  const lines = transcript.data.utterances.map((utterance) => ({
    at: utterance.emittedAt,
    speaker: utterance.speaker,
    sourceText: utterance.text,
  }));
  await net.fetch(new URL("/api/subtitles/sessions/import", localAppOrigin).href, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: `live-${endedSession.sessionId}`,
      title: endedSession.title || "Live Call",
      startedAt: endedSession.startedAt ?? "",
      endedAt: new Date().toISOString(),
      lines,
      summary,
    }),
  });
}

// ── Window reachability ────────────────────────────────────────────────────
// The three host surfaces sit at different window levels on purpose: the
// floating controller and the per-display subtitle overlays are pinned at
// OVERLAY_TOP_LEVEL ("screen-saver") so they float above the normal-level main
// window. Go-Live then HIDES the main window (never closes it — its renderer is
// the only host mic source), and a hidden window is also dropped from the macOS
// Window menu, so the main window had no path back at all: the app looked like
// it had vanished behind the overlay.
//
// These helpers only show / raise / focus. They never load, reload, recreate or
// close a window, and they never touch liveCallSession, the gateway bridge or
// the caption pipeline — so no reachability action can reach the before-quit
// path that deliberately ends a Live Call.
function showDashboardWindow() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
  if (dashboardWindow.isMinimized()) dashboardWindow.restore();
  // show() alone leaves the window wherever it was in the stacking order;
  // moveTop() lifts it above the other normal-level windows and focus()
  // activates the app so it is actually in front of other applications.
  dashboardWindow.show();
  dashboardWindow.moveTop();
  dashboardWindow.focus();
  return true;
}

// Bring the subtitle overlays back to the front without touching the persisted
// `overlayEnabled` setting: this is exactly what the 1s watchdog already does
// (reconcile bounds, re-assert the top level, re-show), just on demand. There is
// deliberately no menu "hide overlays" counterpart — overlay visibility is owned
// by the persisted setting, so a menu-driven hide would be undone within a
// second by the watchdog (or would have to rewrite the setting, i.e. change
// policy).
function showSubtitleOverlays() {
  if (!overlayEnabled || isQuitting) return false;
  maintainOverlayWindow();
  return [...overlayWindows.values()].some((window) => window && !window.isDestroyed());
}

function showControllerWindow() {
  if (!controllerWindow || controllerWindow.isDestroyed()) {
    if (!lastServerUrl) return false;
    createControllerWindow(lastServerUrl);
  }
  if (!controllerWindow || controllerWindow.isDestroyed()) return false;
  controllerWindow.showInactive();
  controllerWindow.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL, 1);
  controllerWindow.moveTop();
  return true;
}

// Application menu: none of the three host surfaces can be relied on to bring
// the others back. The floating controller and the overlays have no dock/taskbar
// presence (skipTaskbar), and the main window is hidden at Go-Live, which also
// removes it from the macOS Window menu. This submenu is the one place that can
// reach all three, whatever state the others are in.
function installApplicationMenu(serverUrl) {
  lastServerUrl = serverUrl;
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: translate("menu.surfaces"),
      submenu: [
        {
          label: translate("menu.showMainWindow"),
          accelerator: "CommandOrControl+Shift+M",
          click: () => { showDashboardWindow(); },
        },
        { type: "separator" },
        {
          label: translate("menu.showCaptionController"),
          accelerator: "CommandOrControl+Shift+C",
          click: () => { showControllerWindow(); },
        },
        {
          label: translate("menu.hideCaptionController"),
          click: () => {
            if (controllerWindow && !controllerWindow.isDestroyed()) controllerWindow.hide();
          },
        },
        { type: "separator" },
        {
          label: translate("menu.showSubtitleOverlays"),
          accelerator: "CommandOrControl+Shift+O",
          click: () => { showSubtitleOverlays(); },
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The renderer is the source of truth for the UI language; rebuild the menu
// whenever it reports a change so the labels follow.
function applyUiLanguage(language) {
  const next = normalizeLanguage(language);
  if (!next) return null;
  setLanguage(next);
  installApplicationMenu(lastServerUrl);
  return next;
}

function destroyOverlayWindow() {
  const windows = [...overlayWindows.values()];
  overlayWindows.clear();
  for (const window of windows) {
    if (window && !window.isDestroyed()) window.destroy();
  }
}

function registerOverlayIpc(settingsStore, { localAppOrigin, liveWorkspaceUrl, liveCallEnabled }) {
  ipcMain.handle("system:open-screen-recording-settings", () => {
    if (process.platform !== "darwin") return false;
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    return true;
  });
  ipcMain.handle("live-workspace:get-enabled", (event) => (
    isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))
      ? liveCallEnabled === true
      : false
  ));
  // One-button Live Call: create session + invite with the stored host
  // cookies, then show the stage overlay (countdown + QR + code).
  ipcMain.handle("live-call:start", async (event, draft) => {
    if (liveCallEnabled !== true) return { ok: false, code: "LIVE_CALL_DISABLED" };
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (liveCallSession) return { ok: false, code: "LIVE_CALL_ALREADY_ARMED" };
    if (isLiveCallStarting) return { ok: false, code: "LIVE_CALL_START_IN_PROGRESS" };
    isLiveCallStarting = true;
    try {
    const cover = validateLiveCoverImage(draft?.coverImage);
    if (!cover.ok) return cover;
    const savedSettings = await settingsStore.load();
    const input = sanitizeLiveCallDraft(draft, savedSettings?.subtitle);
    const login = await silentHostLogin(liveWorkspaceUrl);
    if (!login.ok) {
      return { ok: false, code: login.code === "NO_STORED_LOGIN" ? "HOST_LOGIN_REQUIRED" : login.code };
    }
    const created = await liveCallApi(liveWorkspaceUrl, "/api/live-sessions", { body: toLiveCallApiInput(input) });
    if (!created.ok) return created;
    const sessionData = created.data;
    if (!sessionData || typeof sessionData.id !== "string" || !sessionData.id) {
      return { ok: false, code: "INVALID_SESSION_RESPONSE" };
    }
    const coverUpload = await uploadLiveCover(liveWorkspaceUrl, sessionData.id, cover.image);
    if (!coverUpload.ok) {
      return failPreparedLiveSession(
        liveWorkspaceUrl,
        sessionData.id,
        "COVER_UPLOAD_FAILED",
        coverUpload.code,
      );
    }
    return await armPreparedLiveSession(sessionData, input);
    } finally {
      isLiveCallStarting = false;
    }
  });
  // Arm a prepared (status: preparing) session: create the invite, open the
  // stage overlay (QR + code), snapshot the desktop subtitle settings, and
  // record the armed session for the audio bridge. Shared by "start now" and
  // "start a pre-registered session". When failSessionOnError is false a
  // transient stage/invite error leaves the registered session intact.
  async function armPreparedLiveSession(sessionData, config, { failSessionOnError = true } = {}) {
    const fail = async (step, code) => {
      if (failSessionOnError) return failPreparedLiveSession(liveWorkspaceUrl, sessionData.id, step, code);
      return { ok: false, code: code ?? step };
    };
    const invite = await liveCallApi(liveWorkspaceUrl, `/api/live-sessions/${encodeURIComponent(sessionData.id)}/invites`, {
      body: { action: "create" },
    });
    if (!invite.ok) return fail("INVITE_CREATE_FAILED", invite.code);
    if (typeof invite.data?.inviteToken !== "string"
      || !invite.data.inviteToken
      || !/^[0-9]{6}$/u.test(invite.data.admissionCode)
      || !Number.isSafeInteger(invite.data.version)) {
      return fail("INVITE_CREATE_FAILED", "INVALID_INVITE_RESPONSE");
    }
    const origin = new URL(liveWorkspaceUrl).origin;
    const inviteUrl = `${origin}/m/watch#invite=${encodeURIComponent(invite.data.inviteToken)}`;
    try {
      await openLiveStageOverlay(liveWorkspaceUrl, sessionData.id, {
        url: inviteUrl,
        admissionCode: invite.data.admissionCode,
      });
    } catch {
      return fail("STAGE_OPEN_FAILED", "STAGE_LOAD_FAILED");
    }
    // Mirror the desktop subtitle settings into the gateway start message so
    // Live Call translation behaves exactly like local captions: glossary,
    // business tone, and domain hints feed the same second-pass finalizer.
    // Best-effort: a missing settings file never blocks go-live.
    let liveCaptionConfig = null;
    try {
      const savedSettings = await settingsStore.load();
      // The selected preset is cached with its full text in local Settings.
      // Live Call therefore uses the exact Caption-only glossary even when the
      // remote custom-preset list is temporarily unreachable.
      liveCaptionConfig = createGeminiCaptionConfig({
        ...(savedSettings?.subtitle ?? {}),
        languages: config.languages,
        outputMode: config.outputMode,
        glossaryPack: config.glossaryPack,
      });
    } catch { /* settings parity is best-effort */ }
    // A fresh call must never inherit the previous call's bridge failure banner.
    clearLiveBridgeAlert();
    liveCallSession = {
      sessionId: sessionData.id,
      version: invite.data.version,
      baseUrl: liveWorkspaceUrl,
      status: sessionData.status,
      title: config.title,
      languages: config.languages,
      displayLanguage: sanitizeLiveCaptionDisplayLanguage(config.displayLanguage),
      startedAt: new Date().toISOString(),
      // The gateway host `start` message must mirror the session settings the
      // webapp created — the renderer audio bridge sends these verbatim.
      gatewaySettings: {
        sessionType: config.sessionType,
        outputMode: config.outputMode,
        voiceProvider: "gemini",
        maxViewers: config.maxViewers,
        glossaryPack: config.glossaryPack,
        glossaryText: liveCaptionConfig?.glossary ?? "",
        translationTone: liveCaptionConfig?.tone ?? "natural",
        domainText: liveCaptionConfig?.domain ?? "",
        ...(liveCaptionConfig ? {
          captionConfig: liveCaptionConfig,
          captionConfigFingerprint: geminiCaptionConfigFingerprint(liveCaptionConfig),
        } : {}),
        languages: config.languages,
        inputSource: "mic",
      },
    };
    // The stage (QR) is on the extended display; the host controls live on
    // the floating controller, so it must be visible the moment we arm.
    showControllerWindow();
    return {
      ok: true,
      sessionId: sessionData.id,
      admissionCode: invite.data.admissionCode,
      scheduledAt: sessionData.scheduledAt ?? null,
    };
  }

  // Pre-registration: create the session (title, schedule, cover, languages)
  // WITHOUT arming it. It stays `preparing` on the workspace until the host
  // loads and starts it — same assets, no re-entry.
  ipcMain.handle("live-call:register", async (event, draft) => {
    if (liveCallEnabled !== true) return { ok: false, code: "LIVE_CALL_DISABLED" };
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (isLiveCallStarting) return { ok: false, code: "LIVE_CALL_START_IN_PROGRESS" };
    isLiveCallStarting = true;
    try {
      const cover = validateLiveCoverImage(draft?.coverImage);
      if (!cover.ok) return cover;
      const savedSettings = await settingsStore.load();
      const input = sanitizeLiveCallDraft(draft, savedSettings?.subtitle);
      const login = await silentHostLogin(liveWorkspaceUrl);
      if (!login.ok) {
        return { ok: false, code: login.code === "NO_STORED_LOGIN" ? "HOST_LOGIN_REQUIRED" : login.code };
      }
      const created = await liveCallApi(liveWorkspaceUrl, "/api/live-sessions", { body: toLiveCallApiInput(input) });
      if (!created.ok) return created;
      const sessionData = created.data;
      if (!sessionData || typeof sessionData.id !== "string" || !sessionData.id) {
        return { ok: false, code: "INVALID_SESSION_RESPONSE" };
      }
      const coverUpload = await uploadLiveCover(liveWorkspaceUrl, sessionData.id, cover.image);
      if (!coverUpload.ok) {
        return failPreparedLiveSession(liveWorkspaceUrl, sessionData.id, "COVER_UPLOAD_FAILED", coverUpload.code);
      }
      return {
        ok: true,
        registered: true,
        sessionId: sessionData.id,
        title: input.title,
        scheduledAt: sessionData.scheduledAt ?? null,
      };
    } finally {
      isLiveCallStarting = false;
    }
  });
  // Upcoming registered sessions for the workspace list.
  ipcMain.handle("live-call:list-registered", async (event) => {
    if (liveCallEnabled !== true) return { ok: false, code: "LIVE_CALL_DISABLED" };
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    const login = await silentHostLogin(liveWorkspaceUrl);
    if (!login.ok) {
      return { ok: false, code: login.code === "NO_STORED_LOGIN" ? "HOST_LOGIN_REQUIRED" : login.code };
    }
    const listed = await liveCallApi(liveWorkspaceUrl, "/api/live-sessions?scope=mine", { method: "GET" });
    if (!listed.ok) return listed;
    const sessions = (Array.isArray(listed.data?.sessions) ? listed.data.sessions : [])
      .filter((session) => session?.status === "preparing" && typeof session.id === "string")
      .map((session) => ({
        id: session.id,
        title: String(session.title ?? ""),
        scheduledAt: session.scheduledAt ?? null,
      }));
    return { ok: true, sessions };
  });
  // Load a registered session and arm it, reusing its saved title, schedule,
  // cover image, and language configuration.
  ipcMain.handle("live-call:start-registered", async (event, sessionId, options) => {
    if (liveCallEnabled !== true) return { ok: false, code: "LIVE_CALL_DISABLED" };
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (liveCallSession) return { ok: false, code: "LIVE_CALL_ALREADY_ARMED" };
    if (isLiveCallStarting) return { ok: false, code: "LIVE_CALL_START_IN_PROGRESS" };
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, code: "INVALID_SESSION_ID" };
    isLiveCallStarting = true;
    try {
      const login = await silentHostLogin(liveWorkspaceUrl);
      if (!login.ok) {
        return { ok: false, code: login.code === "NO_STORED_LOGIN" ? "HOST_LOGIN_REQUIRED" : login.code };
      }
      const detail = await liveCallApi(liveWorkspaceUrl, `/api/live-sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
      if (!detail.ok) return detail;
      const sessionData = detail.data;
      if (!sessionData || sessionData.id !== sessionId) return { ok: false, code: "INVALID_SESSION_RESPONSE" };
      if (sessionData.status !== "preparing") return { ok: false, code: "SESSION_NOT_PREPARING" };
      // A transient invite/stage failure must NOT destroy the registration.
      return await armPreparedLiveSession(sessionData, {
        title: String(sessionData.title ?? ""),
        languages: Array.isArray(sessionData.languages) ? sessionData.languages : ["ko", "en"],
        sessionType: sessionData.sessionType ?? "meeting",
        outputMode: sessionData.outputMode ?? "captions",
        voiceProvider: sessionData.voiceProvider ?? "gemini",
        maxViewers: Number.isSafeInteger(sessionData.maxViewers) ? sessionData.maxViewers : 50,
        glossaryPack: sessionData.glossaryPack ?? "general_cre",
        displayLanguage: sanitizeLiveCaptionDisplayLanguage(options?.displayLanguage),
      }, { failSessionOnError: false });
    } finally {
      isLiveCallStarting = false;
    }
  });
  ipcMain.handle("live-call:save-host-login", async (event, config) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false };
    let saved;
    try {
      saved = saveLiveHostConfig(config);
    } catch (error) {
      const code = error instanceof Error && error.message === "HOST_CREDENTIAL_ENCRYPTION_UNAVAILABLE"
        ? error.message
        : "HOST_LOGIN_SAVE_FAILED";
      return { ok: false, code };
    }
    if (!saved.hasLogin) {
      return { ok: true, hasLogin: false, verified: false, verificationCode: "NO_STORED_LOGIN", workspaceUrl: saved.workspaceUrl };
    }
    // Verify against the live workspace right away so the Settings page shows
    // whether Start Live Call will actually succeed, not just that a file was
    // written locally.
    const login = await silentHostLogin(liveWorkspaceUrl);
    return {
      ok: true,
      hasLogin: saved.hasLogin,
      verified: login.ok === true,
      verificationCode: login.ok ? null : login.code,
      workspaceUrl: saved.workspaceUrl,
    };
  });
  ipcMain.handle("live-call:get-host-login-status", (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false };
    const config = readLiveHostConfig();
    return { ok: true, hasLogin: Boolean(config.hostId && config.hostPassword), hostId: config.hostId ?? "", hostName: config.hostName ?? "", workspaceUrl: config.workspaceUrl ?? "" };
  });
  ipcMain.handle("glossary-presets:list", async (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) {
      return { ok: false, error: "허용되지 않은 요청입니다.", code: "FORBIDDEN" };
    }
    const result = await liveCallApiWithHostSession(liveWorkspaceUrl, "/api/glossary-presets", { method: "GET" });
    if (!result.ok) return glossaryPresetFailure(result);
    const presets = Array.isArray(result.data?.presets)
      ? result.data.presets.map(sanitizeRemoteGlossaryPreset)
      : null;
    if (!presets || presets.length > 50 || presets.some((preset) => !preset)) {
      return glossaryPresetFailure({ code: "NETWORK_UNAVAILABLE" });
    }
    return { ok: true, data: { presets } };
  });
  ipcMain.handle("glossary-presets:create", async (event, value) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) {
      return { ok: false, error: "허용되지 않은 요청입니다.", code: "FORBIDDEN" };
    }
    const input = sanitizeGlossaryPresetInput(value);
    if (!input) return { ok: false, error: "용어집 입력이 올바르지 않습니다.", code: "INVALID_GLOSSARY_PRESET" };
    const result = await liveCallApiWithHostSession(liveWorkspaceUrl, "/api/glossary-presets", { method: "POST", body: input });
    if (!result.ok) return glossaryPresetFailure(result);
    const preset = sanitizeRemoteGlossaryPreset(result.data?.preset);
    return preset
      ? { ok: true, data: { preset } }
      : glossaryPresetFailure({ code: "NETWORK_UNAVAILABLE" });
  });
  ipcMain.handle("glossary-presets:update", async (event, value) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) {
      return { ok: false, error: "허용되지 않은 요청입니다.", code: "FORBIDDEN" };
    }
    const input = sanitizeGlossaryPresetInput(value, { includeIdentity: true });
    if (!input) return { ok: false, error: "용어집 입력이 올바르지 않습니다.", code: "INVALID_GLOSSARY_PRESET" };
    const { id, ...body } = input;
    const result = await liveCallApiWithHostSession(liveWorkspaceUrl, `/api/glossary-presets/${encodeURIComponent(id)}`, { method: "PATCH", body });
    if (!result.ok) return glossaryPresetFailure(result);
    const preset = sanitizeRemoteGlossaryPreset(result.data?.preset);
    return preset
      ? { ok: true, data: { preset } }
      : glossaryPresetFailure({ code: "NETWORK_UNAVAILABLE" });
  });
  ipcMain.handle("glossary-presets:delete", async (event, value) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) {
      return { ok: false, error: "허용되지 않은 요청입니다.", code: "FORBIDDEN" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.id !== "string" || !GLOSSARY_PRESET_UUID_PATTERN.test(value.id)
      || !Number.isSafeInteger(value.version) || value.version < 1) {
      return { ok: false, error: "용어집 입력이 올바르지 않습니다.", code: "INVALID_GLOSSARY_PRESET" };
    }
    const result = await liveCallApiWithHostSession(liveWorkspaceUrl, `/api/glossary-presets/${encodeURIComponent(value.id)}`, {
      method: "DELETE",
      body: { version: value.version },
    });
    if (!result.ok) return glossaryPresetFailure(result);
    return result.data?.id === value.id
      ? { ok: true, data: { id: value.id } }
      : glossaryPresetFailure({ code: "NETWORK_UNAVAILABLE" });
  });
  ipcMain.handle("live-call:get-state", (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) {
      return { armed: false, live: false };
    }
    return liveCallSession
      ? {
        armed: true,
        live: liveCallSession.status === "live",
        sessionId: liveCallSession.sessionId,
        liveStartedAt: liveCallSession.liveStartedAt ?? null,
        // The records calendar places a meeting by its title and the moment the
        // call actually went live, so the renderer needs both when it starts
        // captions for this call.
        title: liveCallSession.title ?? "",
        // Bounded to one committed cue per configured language. The dashboard
        // can replay this after its local WebSocket recovers without asking the
        // gateway to resend an unbounded transcript or losing the last final.
        captionSnapshot: [...(liveCallSession.captionRelayState?.finalSnapshotByLanguage?.values?.() ?? [])],
        // Gateway/host-audio health. The controller polls this handler, so a
        // dead bridge is no longer invisible behind a still-ticking timer.
        bridge: liveBridgeStatus(),
      }
      : { armed: false, live: false, bridge: null };
  });
  ipcMain.handle("live-call:host-speak", async (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (!liveCallSession) return { ok: false, code: "NOT_ARMED" };
    // 2026-07-26 fix: floor alternation reuses the authenticated HOST bridge.
    // Minting a token and opening another socket for every press exhausted the
    // token rate limit and turned ordinary alternation into request timeouts.
    const activeBridgeResult = await hostSpeakViaActiveBridge();
    if (activeBridgeResult) return activeBridgeResult;
    const armedSession = liveCallSession;
    const tokenResult = await liveCallApi(
      armedSession.baseUrl,
      `/api/live-sessions/${encodeURIComponent(armedSession.sessionId)}/gateway-token`,
      { body: {} },
    );
    if (!tokenResult.ok) return tokenResult;
    const configResult = await liveCallApi(armedSession.baseUrl, "/api/live-config", { method: "GET" });
    const gatewayUrl = typeof configResult.data?.gatewayUrl === "string" ? configResult.data.gatewayUrl : "";
    if (!configResult.ok || !gatewayUrl) return { ok: false, code: "GATEWAY_URL_UNAVAILABLE" };
    return hostSpeakViaGateway(gatewayUrl, tokenResult.data?.token);
  });
  ipcMain.handle("live-call:go-live", async (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (!liveCallSession) return { ok: false, code: "NOT_ARMED" };
    if (isLiveCallEnding) return { ok: false, code: "LIVE_CALL_END_IN_PROGRESS" };
    if (isLiveCallGoingLive) return { ok: false, code: "LIVE_CALL_GO_LIVE_IN_PROGRESS" };
    isLiveCallGoingLive = true;
    try {
    const armedSession = liveCallSession;
    const rendererPreflight = await requestRendererLiveCaptionPreflight(armedSession);
    if (!rendererPreflight.ok) return rendererPreflight;
    const preflightRequestId = rendererPreflight.requestId;
    // The renderer preflight persists the current form first. Loading settings
    // before it completed made Go-Live use the previous glossary revision.
    const preflight = await preflightLiveCallCaptionSession(settingsStore, armedSession);
    if (!preflight.ok) {
      cancelRendererLiveCaptionPreflight(preflightRequestId);
      return preflight;
    }
    // The invite-time version can go stale (any config change bumps it) and a
    // stale /start silently fails as a version conflict. Re-read the session
    // right before starting so Go-Live is never rejected for staleness.
    const current = await liveCallApi(
      armedSession.baseUrl,
      `/api/live-sessions/${encodeURIComponent(armedSession.sessionId)}`,
      { method: "GET" },
    );
    if (!current.ok) {
      cancelRendererLiveCaptionPreflight(preflightRequestId);
      return current;
    }
    if (current.ok && Number.isSafeInteger(current.data?.version)) {
      armedSession.version = current.data.version;
    }
    const started = await liveCallApi(armedSession.baseUrl, `/api/live-sessions/${encodeURIComponent(armedSession.sessionId)}/start`, {
      body: { version: armedSession.version },
    });
    if (!started.ok) {
      cancelRendererLiveCaptionPreflight(preflightRequestId);
      return started;
    }
    if (liveCallSession !== armedSession) {
      cancelRendererLiveCaptionPreflight(preflightRequestId);
      return { ok: false, code: "NOT_ARMED" };
    }
    armedSession.version = started.data.version ?? armedSession.version;
    armedSession.status = started.data.status ?? "live";
    // Stamp the moment the call actually went live (not arm time) so the
    // controller's elapsed timer starts from zero at Go-Live.
    armedSession.liveStartedAt = new Date().toISOString();
    // The QR/countdown stage has done its job once the call is live: close it,
    // and the main dashboard window steps aside too (hidden, NOT closed — its
    // renderer keeps running the mic audio bridge). Only the floating
    // controller and the subtitle overlays remain on the host's screens.
    if (stageWindow && !stageWindow.isDestroyed()) stageWindow.destroy();
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.hide();
    return { ok: true, status: armedSession.status };
    } finally {
      isLiveCallGoingLive = false;
    }
  });
  // The desktop has no browser host-dashboard; the renderer asks the main
  // process to run the gateway host connection (Cloud Run only accepts the
  // desktop via the trusted non-browser path, which browsers cannot use) and
  // then forwards microphone PCM frames over IPC.
  ipcMain.handle("live-call:bridge-ensure", async (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (!dashboardWindow || dashboardWindow.isDestroyed() || event.sender !== dashboardWindow.webContents) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return ensureLiveGatewayBridge();
  });
  ipcMain.on("live-call:preflight-result", (event, requestId, result) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return;
    if (!dashboardWindow || dashboardWindow.isDestroyed() || event.sender !== dashboardWindow.webContents) return;
    if (typeof requestId !== "string" || requestId.length > 128) return;
    const pending = liveCaptionPreflightRequests.get(requestId);
    if (!pending) return;
    liveCaptionPreflightRequests.delete(requestId);
    const code = typeof result?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(result.code)
      ? result.code
      : "LIVE_CAPTION_PREFLIGHT_FAILED";
    pending.resolve(result?.ok === true
      ? { ok: true, requestId }
      : { ok: false, requestId, code });
  });
  ipcMain.handle("live-call:translation-reconnect", async (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (!dashboardWindow || dashboardWindow.isDestroyed() || event.sender !== dashboardWindow.webContents) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return restartLiveTranslationBridge();
  });
  ipcMain.handle("live-call:audio-failed", async (event, detail) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (!dashboardWindow || dashboardWindow.isDestroyed() || event.sender !== dashboardWindow.webContents) {
      return { ok: false, code: "FORBIDDEN" };
    }
    if (!liveCallSession || liveCallSession.status !== "live") return { ok: false, code: "NOT_LIVE" };
    const safeDetail = String(detail ?? "")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .trim()
      .slice(0, 300);
    await stopLiveGatewayBridge("host audio capture failed", { terminateRemote: true });
    setLiveBridgeAlert({
      state: "failed",
      code: "HOST_AUDIO_CAPTURE_FAILED",
      message: safeDetail || "호스트 오디오를 시작하지 못했습니다. 입력 설정과 권한을 확인한 뒤 Live Call을 다시 시작하세요.",
    });
    notifyLiveBridgeFailure(
      "Host audio unavailable",
      safeDetail || "Check the selected audio input and macOS permissions, then restart the Live Call.",
    );
    return { ok: false, code: "HOST_AUDIO_CAPTURE_FAILED" };
  });
  ipcMain.on("live-call:audio-frame", (event, packet) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return;
    if (!dashboardWindow || dashboardWindow.isDestroyed() || event.sender !== dashboardWindow.webContents) return;
    const bridge = liveGatewayBridge;
    if (!bridge?.ready || bridge.socket.readyState !== WebSocket.OPEN) return;
    if (bridge.isHostAudioBlocked) return;
    const isKnownSource = packet?.source === "system" || packet?.source === "mic";
    const pcm = packet?.pcm;
    const bytes = Buffer.isBuffer(pcm)
      ? pcm
      : pcm instanceof ArrayBuffer
        ? Buffer.from(pcm)
        : ArrayBuffer.isView(pcm)
          ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
          : null;
    if (!isKnownSource || packet.sampleRate !== 24_000
      || packet.frameDurationMs !== 100 || !bytes || bytes.length !== CAPTION_BRIDGE_PACKET_BYTES) {
      if (!bridge.didLogBadFrame) {
        bridge.didLogBadFrame = true;
        console.warn(`[live-bridge] dropped caption PCM packet: source=${String(packet?.source)} bytes=${bytes?.length ?? "n/a"}`);
      }
      return;
    }
    const pcmFrames = adaptCaptionPcmForGateway(packet.source, bytes);
    for (const pcmFrame of pcmFrames) {
      const frame = encodeLiveAudioWireFrame(packet.source, pcmFrame);
      if (!frame) {
        if (!bridge.didLogBadFrame) {
          bridge.didLogBadFrame = true;
          console.warn("[live-bridge] dropped malformed gateway audio frame");
        }
        continue;
      }
      bridge.forwardedFrames = (bridge.forwardedFrames ?? 0) + 1;
      if (bridge.forwardedFrames === 1) console.info("[live-bridge] first audio frame forwarded to gateway");
      if (bridge.forwardedFrames % 250 === 0) console.info(`[live-bridge] ${bridge.forwardedFrames} audio frames forwarded`);
      bridge.socket.send(frame);
    }
  });
  ipcMain.handle("live-call:end", async (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return { ok: false, code: "FORBIDDEN" };
    if (!liveCallSession) return { ok: false, code: "NOT_ARMED" };
    if (isLiveCallEnding) return { ok: false, code: "LIVE_CALL_END_IN_PROGRESS" };
    isLiveCallEnding = true;
    const endingSession = liveCallSession;
    try {
      const ended = await liveCallApi(
        endingSession.baseUrl,
        `/api/live-sessions/${encodeURIComponent(endingSession.sessionId)}`,
        {
          method: "DELETE",
          // The current host-owned terminal route is idempotent and does not
          // consume this yet; send the known version so the desktop contract
          // remains optimistic when the route adopts version guarding.
          body: { version: endingSession.version },
        },
      );
      if (!ended.ok) return ended;
      if (ended.data?.id !== endingSession.sessionId || ended.data?.status !== "stopped") {
        return { ok: false, code: "INVALID_END_RESPONSE" };
      }
      if (liveCallSession !== endingSession) return { ok: false, code: "LIVE_CALL_STATE_CHANGED" };
      liveCallSession = null;
      relayLiveCallFloorToRenderers({
        type: "live-call-ended",
        sessionId: endingSession.sessionId,
      });
      await stopLiveGatewayBridge("live call ended", { terminateRemote: true });
      clearLiveBridgeAlert();
      if (stageWindow && !stageWindow.isDestroyed()) stageWindow.destroy();
      // The dashboard was hidden at go-live; ending the call brings it back so
      // the host lands on records/summary/settings.
      restoreDashboardAfterLiveCall();
      // Archive the meeting record into the local Records page: transcript
      // (speaker-attributed) plus the workspace summary when it is already
      // generated. Best-effort — archiving must never block the End result.
      archiveLiveCallSession(endingSession, localAppOrigin).catch((error) => {
        console.warn(`[live] session archive skipped: ${error?.message ?? error}`);
      });
      return { ok: true, sessionId: endingSession.sessionId, status: "stopped" };
    } finally {
      isLiveCallEnding = false;
    }
  });
  ipcMain.handle("subtitle-overlay:list-displays", (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) {
      return { displays: [], selectedDisplayId: "" };
    }
    return overlayDisplayState();
  });
  ipcMain.handle("subtitle-overlay:select-display", async (event, displayId) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) {
      return { displays: [], selectedDisplayId: "" };
    }
    if (typeof displayId !== "string"
      || displayId.length < 1
      || displayId.length > MAX_OVERLAY_DISPLAY_ID_LENGTH
      || /[\u0000-\u001f\u007f]/u.test(displayId)) return overlayDisplayState();
    const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === displayId) ?? null;
    if (!display) return overlayDisplayState();
    const previousPreferredDisplayId = preferredOverlayDisplayId;
    preferredOverlayDisplayId = displayId;
    try {
      await settingsStore.save({ subtitle: { overlayDisplayId: preferredOverlayDisplayId } });
    } catch (error) {
      preferredOverlayDisplayId = previousPreferredDisplayId;
      throw error;
    }
    if (overlayEnabled) syncOverlayBounds();
    positionControllerForOverlayDisplay();
    // The QR stage shares the caption monitor, so a new selection moves it too.
    repositionStageWindow();
    notifyOverlayDisplaysChanged();
    return overlayDisplayState();
  });
  // "All displays" tick: mirror the same captions onto every connected screen.
  // Persist first so a crash cannot leave the windows and the setting disagreeing.
  ipcMain.handle("subtitle-overlay:set-all-displays", async (event, allDisplays) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) {
      return overlayDisplayState();
    }
    if (typeof allDisplays !== "boolean") return overlayDisplayState();
    const previous = overlayAllDisplays;
    overlayAllDisplays = allDisplays;
    try {
      await settingsStore.save({ subtitle: { overlayAllDisplays } });
    } catch (error) {
      overlayAllDisplays = previous;
      throw error;
    }
    if (overlayEnabled) syncOverlayBounds();
    positionControllerForOverlayDisplay();
    repositionStageWindow();
    notifyOverlayDisplaysChanged();
    return overlayDisplayState();
  });
  ipcMain.handle("subtitle-overlay:get-enabled", () => overlayEnabled);
  ipcMain.handle("subtitle-overlay:set-muted", (event, muted) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return overlaysMuted;
    overlaysMuted = Boolean(muted);
    if (overlaysMuted) {
      eachOverlayWindow((window) => window.hide());
    } else if (overlayEnabled) {
      // Straight back on screen rather than waiting up to a second for the tick.
      maintainOverlayWindow();
    }
    return overlaysMuted;
  });
  ipcMain.handle("subtitle-overlay:get-muted", (event) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return false;
    return overlaysMuted;
  });
  ipcMain.handle("subtitle-overlay:set-enabled", async (_event, enabled) => {
    overlayEnabled = Boolean(enabled);
    await settingsStore.save({ subtitle: { overlayEnabled } });
    // A stale mute would keep the overlay invisible right after the user turned
    // it on, which reads as the setting being broken.
    if (overlayEnabled) overlaysMuted = false;
    if (overlayEnabled) {
      createOverlayWindow(server.url);
      maintainOverlayWindow();
    } else {
      destroyOverlayWindow();
    }
    return overlayEnabled;
  });
  // Hover-driven interactivity for the click-through overlay: while the cursor
  // is over a subtitle box the page asks to receive real clicks (double-click
  // restart); leaving the box restores full click-through.
  ipcMain.handle("subtitle-overlay:set-interactive", (event, interactive) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return false;
    if (interactive) interactiveOverlayIds.add(window.id);
    else interactiveOverlayIds.delete(window.id);
    window.setIgnoreMouseEvents(!interactive, { forward: true });
    return true;
  });
  // Quit the whole app straight from the floating controller.
  // The controller's "Main" button. Visibility only — the dashboard renderer is
  // the host microphone source during a Live Call, so this must never reload or
  // recreate it, and it must not touch session state.
  ipcMain.handle("app:show-main-window", () => showDashboardWindow());
  // UI language: the dashboard renderer persists the choice and reports it here
  // so the application menu is rebuilt in the same language.
  ipcMain.handle("app:set-ui-language", (event, language) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return null;
    return applyUiLanguage(language);
  });
  ipcMain.handle("app:quit", () => {
    isQuitting = true;
    app.quit();
    return true;
  });
  // JS-driven window drag: -webkit-app-region is unreliable on transparent
  // always-on-top windows (macOS), so the drag strip streams pointer deltas.
  ipcMain.on("subtitle-controller:move-by", (event, deltaX, deltaY) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return;
    if (!controllerWindow || controllerWindow.isDestroyed()) return;
    const dx = Number(deltaX);
    const dy = Number(deltaY);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = controllerWindow.getPosition();
    controllerWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  // The console asks for the exact content height so the transparent window
  // hugs it — no empty band, even when the voice row appears in audio mode.
  ipcMain.on("subtitle-controller:fit-height", (event, contentHeight, contentWidth) => {
    if (!isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))) return;
    if (!controllerWindow || controllerWindow.isDestroyed()) return;
    const height = Number(contentHeight);
    if (!Number.isFinite(height)) return;
    const clampedHeight = Math.round(Math.min(240, Math.max(64, height)));
    const [x, y] = controllerWindow.getPosition();
    const [currentWidth, currentHeight] = controllerWindow.getSize();
    // Width follows the content as well. The console's clusters change with the
    // session -- the Live Call group, Host Speak and the voice row all come and
    // go -- so a fixed width leaves slack, and the right-hand cluster was being
    // pushed across it. Never wider than the work area.
    const workArea = screen.getDisplayNearestPoint({ x, y }).workArea;
    const requestedWidth = Number(contentWidth);
    const clampedWidth = Number.isFinite(requestedWidth) && requestedWidth > 0
      ? Math.round(Math.min(workArea.width - 48, Math.max(CONTROLLER_MIN_WIDTH, requestedWidth)))
      : currentWidth;
    if (clampedHeight === currentHeight && clampedWidth === currentWidth) return;
    // Keep the console optically where it was instead of letting a width change
    // drag it sideways.
    const centeredX = Math.round(x + (currentWidth - clampedWidth) / 2);
    const maxX = workArea.x + workArea.width - clampedWidth;
    const nextX = Math.min(Math.max(workArea.x, centeredX), Math.max(workArea.x, maxX));
    controllerWindow.setMinimumSize(Math.min(CONTROLLER_MIN_WIDTH, clampedWidth), clampedHeight);
    controllerWindow.setBounds({ x: nextX, y, width: clampedWidth, height: clampedHeight });
  });
  ipcMain.handle("subtitle-controller:set-visible", (_event, visible) => {
    if (!controllerWindow || controllerWindow.isDestroyed()) createControllerWindow(server.url);
    if (!controllerWindow || controllerWindow.isDestroyed()) return false;
    if (visible) {
      controllerWindow.showInactive();
      controllerWindow.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL, 1);
      controllerWindow.moveTop();
    } else {
      controllerWindow.hide();
    }
    return controllerWindow.isVisible();
  });
}

// Microphone is a separate macOS TCC panel from Screen & System Audio
// Recording. Electron does not reliably show the mic prompt on its own — and
// when the grant is missing, getUserMedia returns a SILENT stream with no
// error, which looks like "mic captured but no signal". Ask explicitly on
// startup so the OS prompt appears, and log actionable guidance when denied.
async function ensureMicrophoneAccess() {
  if (process.platform !== "darwin") return;
  try {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    if (status === "not-determined") {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      console.warn(`[overlay] microphone access ${granted ? "granted" : "declined"} via system prompt`);
      return;
    }
    if (status === "denied" || status === "restricted") {
      console.warn(
        `[overlay] microphone access is "${status}". ` +
        "Enable NOVA under System Settings > Privacy & Security > Microphone, then restart the app.",
      );
    }
  } catch (error) {
    console.warn(`[overlay] microphone access check failed: ${error?.message ?? error}`);
  }
}

function screenCaptureAccessStatus() {
  if (process.platform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

function completeDisplayMediaRequest(callback, response) {
  try {
    callback(response);
    return true;
  } catch (error) {
    // 2026-07-26 fix: Electron throws synchronously when getDisplayMedia asked
    // for video but a denied/cancelled picker has no video source. Because the
    // request handler is async, allowing that throw to escape becomes an
    // UnhandledPromiseRejectionWarning in the main process. Electron has
    // already rejected the renderer request at this boundary; contain only the
    // native callback throw so the app can keep running and the renderer's
    // existing capture error path can report the failure to the user.
    console.warn(`[overlay] display media request could not be completed: ${error?.message ?? error}`);
    return false;
  }
}

function configureSystemAudioCapture(allowedMediaOrigins) {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const requestingUrl = request.securityOrigin ?? request.frame?.url ?? "";
    const hasUserGesture = request.userGesture === true;
    if (!hasUserGesture || !isAllowedOrigin(requestingUrl, allowedMediaOrigins)) {
      completeDisplayMediaRequest(callback, {});
      return;
    }
    const access = screenCaptureAccessStatus();
    if (access === "denied" || access === "restricted") {
      // Without the macOS "Screen & System Audio Recording" grant, getSources
      // returns an empty list and the renderer would only see a generic empty
      // stream. Log the real cause so the failure is diagnosable, then bail.
      console.warn(
        `[overlay] system audio capture blocked: screen recording permission is "${access}". ` +
        "Grant NOVA under System Settings > Privacy & Security > Screen & System Audio Recording, then restart.",
      );
      completeDisplayMediaRequest(callback, {});
      return;
    }
    try {
      const sources = await getDesktopSourcesWithTimeout();
      if (sources.length === 0) {
        console.warn(
          "[overlay] system audio capture found no screen sources " +
          `(screen recording permission: "${access}"). The app may need the permission granted and a restart.`,
        );
        completeDisplayMediaRequest(callback, {});
        return;
      }
      completeDisplayMediaRequest(callback, { video: sources[0], audio: "loopback" });
    } catch (error) {
      console.warn(`[overlay] system audio capture failed: ${error?.message ?? error}`);
      completeDisplayMediaRequest(callback, {});
    }
  }, { useSystemPicker: false });
}

function configureMediaPermissions(allowedMediaOrigins) {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(
      details?.isMainFrame === true
      && ALLOWED_RENDERER_PERMISSIONS.has(permission)
      && isAllowedOrigin(details.requestingUrl, allowedMediaOrigins),
    );
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (!ALLOWED_RENDERER_PERMISSIONS.has(permission)) return false;
    if (details?.isMainFrame !== true) return false;
    return isAllowedOrigin(requestingOrigin, allowedMediaOrigins);
  });
}

function getDesktopSourcesWithTimeout() {
  return Promise.race([
    desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("desktop source lookup timed out")), DESKTOP_SOURCE_TIMEOUT_MS);
    }),
  ]);
}

function isAllowedOrigin(value, allowedMediaOrigins) {
  try {
    const target = new URL(value);
    return !target.username
      && !target.password
      && (target.protocol === "http:" || target.protocol === "https:")
      && allowedMediaOrigins.has(target.origin);
  } catch {
    return false;
  }
}

function createNoopTranscription() {
  return {
    ready: async () => {},
    sendAudio: () => {},
    stop: () => {},
    close: () => {},
  };
}

// Boot must never reject silently. An unhandled rejection here left the user
// with a dock icon and nothing else — no window, no dialog, no log they'd find.
if (singleInstanceLock) {
  app.whenReady().then(createApp).catch((error) => {
    console.error(`[boot] startup failed: ${error?.stack ?? error}`);
    try {
      dialog.showErrorBox(
        "NOVA could not start",
        `${error?.message ?? error}\n\nIf this keeps happening, move ~/.config/${APP_CONFIG_DIR}/settings.json aside and try again.`,
      );
    } catch { /* dialogs are unavailable in headless test runs */ }
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS: clicking the dock icon (or ⌘-Tab-ing into the app) fires "activate",
// which is the OS-standard "bring this app back" gesture. There was no handler,
// so once Go-Live hid the main window the dock icon did nothing and the window
// was gone from the Window menu too — the app was running, capturing the host
// mic, and completely unreachable. Re-showing is visibility-only: it never
// reloads or recreates the mic-owning renderer and never touches the live
// session, so activating during a call cannot interrupt it.
app.on("activate", () => {
  if (isQuitting) return;
  showDashboardWindow();
  if (overlayEnabled) maintainOverlayWindow();
});

// Every exit path — Quit menu, the controller's app:quit, Cmd+Q, window
// close on non-mac — must end an armed live call so guests are never left in
// a zombie session. The DELETE is idempotent and hard-capped at 4s so
// quitting can never hang.
let hasTerminatedLiveCallOnQuit = false;
// Re-show the main dashboard window after a Live Call ends — but never while
// the app is quitting (the quit path also ends the call; popping a window up
// mid-quit would fight the shutdown).
function restoreDashboardAfterLiveCall() {
  if (isQuitting) return;
  showDashboardWindow();
}

async function terminateLiveCallForShutdown() {
  const endingSession = liveCallSession;
  if (!endingSession) return;
  liveCallSession = null;
  try {
    await Promise.race([
      Promise.allSettled([
        stopLiveGatewayBridge("app quitting", { terminateRemote: true }),
        liveCallApi(endingSession.baseUrl, `/api/live-sessions/${encodeURIComponent(endingSession.sessionId)}`, {
          method: "DELETE",
          body: { version: endingSession.version },
        }),
      ]),
      new Promise((resolve) => setTimeout(resolve, 4_000)),
    ]);
    console.info("[live] live call terminated on app quit");
  } catch (error) {
    console.warn(`[live] quit-time live call termination failed: ${error?.message ?? error}`);
  }
}

app.on("before-quit", (event) => {
  if (liveCallSession && !hasTerminatedLiveCallOnQuit) {
    hasTerminatedLiveCallOnQuit = true;
    event.preventDefault();
    void terminateLiveCallForShutdown().finally(() => app.quit());
    return;
  }
  isQuitting = true;
  overlayEnabled = false;
  clearLiveBridgeReconnect();
  if (overlayWatchdog) clearInterval(overlayWatchdog);
  eachOverlayWindow((window) => window.hide());
  destroyOverlayWindow();
  stageWindow?.destroy();
  dashboardWindow?.destroy();
  server?.httpServer?.close();
});
