// Sandboxed preload for the remote login window - must stay CommonJS like
// electron/preload.js (the sandbox runs it as a classic script). It exposes a
// single capability: asking the main process to open the Google login URL in
// the system browser. The main process re-validates the URL and the state.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("novaDesktopLogin", {
  openExternal: (url) => ipcRenderer.invoke("desktop-login:open-external", url),
});
