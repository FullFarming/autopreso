// Admin console window (Plan B Task 5). A plain sandboxed BrowserWindow on the
// remote workspace origin that shares the default session's cookie jar, so the
// `/console` pages see the same `rnw_session` the desktop verified at boot. It
// deliberately mirrors the login window's hardening and adds nothing: no
// preload (the console has no desktop bridge to call), no media grants
// (`configureMediaPermissions` only ever allows the local app origin), and a
// navigation allowlist so a link inside the console cannot turn this window
// into a general-purpose browser.

const CONSOLE_PATH_PREFIXES = ["/console", "/records"];
const CONSOLE_EXACT_PATHS = new Set(["/admin", "/admin/", "/login"]);

/** @returns {"allowed" | "blocked"} */
export function classifyDesktopConsoleNavigation(value, baseUrl) {
  try {
    const target = new URL(value);
    const origin = new URL(baseUrl).origin;
    if (target.origin !== origin || target.username || target.password) return "blocked";
    if (CONSOLE_EXACT_PATHS.has(target.pathname)) return "allowed";
    if (CONSOLE_PATH_PREFIXES.some((prefix) => target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))) return "allowed";
  } catch { /* Untrusted navigation is denied. */ }
  return "blocked";
}

function isOffOriginHttpTarget(value, baseUrl) {
  try {
    const target = new URL(value);
    return (target.protocol === "https:" || target.protocol === "http:") && target.origin !== new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Opens the console, or focuses the one already open. Returns the window that
 * is showing the console so the caller can track its `closed` event.
 *
 * @param {{ BrowserWindowClass: any, browserSession: unknown, baseUrl: string, title: string, existing?: any, openExternal: (url: string) => unknown }} options
 */
export function openDesktopConsoleWindow({ BrowserWindowClass, browserSession, baseUrl, title, existing = null, openExternal }) {
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized?.()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  const window = new BrowserWindowClass({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 640,
    title,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  function guardNavigation(event, legacyUrl) {
    const url = typeof event.url === "string" ? event.url : legacyUrl;
    if (classifyDesktopConsoleNavigation(url, baseUrl) === "allowed") return;
    event.preventDefault();
  }
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Same-origin targets already have a window (this one); anything else that
    // is a real web page belongs in the system browser, never in a child window.
    if (isOffOriginHttpTarget(url, baseUrl)) openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });
  void Promise.resolve()
    .then(() => window.loadURL(new URL("/console", baseUrl).href))
    .catch(() => { if (!window.isDestroyed()) window.destroy(); });
  return window;
}
