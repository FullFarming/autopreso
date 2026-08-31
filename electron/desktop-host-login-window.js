import { classifyDesktopLoginNavigation } from "./desktop-host-session.js";

export function openDesktopHostLogin({ BrowserWindowClass, browserSession, hostSession, baseUrl, title, onWindow, onFailure }) {
  return new Promise((resolve) => {
    const window = new BrowserWindowClass({
      width: 1100,
      height: 800,
      minWidth: 480,
      minHeight: 640,
      title,
      show: true,
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
    onWindow(window);
    let isSettled = false;
    let isVerifying = false;
    let loadTimer;
    function finish(result) {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(loadTimer);
      resolve(result);
      if (!window.isDestroyed()) window.destroy();
    }
    function guardNavigation(event, legacyUrl) {
      const url = typeof event.url === "string" ? event.url : legacyUrl;
      const kind = classifyDesktopLoginNavigation(url, baseUrl);
      if (kind === "login") return;
      event.preventDefault();
      if (kind === "authenticated") void verifyNavigation(null, url);
    }
    async function verifyNavigation(_event, url) {
      if (isSettled || isVerifying || classifyDesktopLoginNavigation(url, baseUrl) !== "authenticated") return;
      isVerifying = true;
      const result = await hostSession.ensureSession({ force: true });
      if (isSettled) return;
      if (!result.ok) {
        const shouldRetry = await onFailure(result);
        isVerifying = false;
        if (shouldRetry && !isSettled) await verifyNavigation(null, url);
        return;
      }
      finish(result);
    }
    window.webContents.on("will-navigate", guardNavigation);
    window.webContents.on("will-redirect", guardNavigation);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("did-navigate", verifyNavigation);
    window.webContents.on("did-navigate-in-page", verifyNavigation);
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.on("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });
    window.on("closed", () => finish({ ok: false, code: "LOGIN_CANCELLED" }));
    async function loadLogin() {
      let hasLoadFailed = false;
      try {
        await Promise.race([
          window.loadURL(new URL("/login", baseUrl).href),
          new Promise((_resolve, reject) => {
            loadTimer = setTimeout(() => {
              if (!window.isDestroyed()) window.webContents.stop();
              reject(new Error("LOGIN_PAGE_LOAD_TIMEOUT"));
            }, 15_000);
          }),
        ]);
      } catch {
        hasLoadFailed = true;
      } finally {
        clearTimeout(loadTimer);
      }
      if (hasLoadFailed) {
        if (isSettled || isVerifying) return;
        window.show();
        const shouldRetry = await onFailure({ ok: false, code: "NETWORK_UNAVAILABLE" });
        if (shouldRetry && !isSettled) await loadLogin();
      }
    }
    void loadLogin();
  });
}
