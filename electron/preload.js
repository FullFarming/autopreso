// Sandboxed preload — must stay CommonJS: Electron's sandbox executes this as a
// classic script with a limited require() shim, so ESM `import` fails to load
// and silently removes the whole bridge in packaged builds.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("realtimeNoelDesktop", {
  isElectron: true,
  getLiveCallEnabled: () => ipcRenderer.invoke("live-workspace:get-enabled"),
  startLiveCall: (draft) => ipcRenderer.invoke("live-call:start", draft),
  registerLiveCall: (draft) => ipcRenderer.invoke("live-call:register", draft),
  listRegisteredLiveCalls: () => ipcRenderer.invoke("live-call:list-registered"),
  startRegisteredLiveCall: (sessionId, options) => ipcRenderer.invoke("live-call:start-registered", sessionId, options),
  getLiveCallState: () => ipcRenderer.invoke("live-call:get-state"),
  moveControllerBy: (deltaX, deltaY) => ipcRenderer.send("subtitle-controller:move-by", deltaX, deltaY),
  fitControllerHeight: (height, width) => ipcRenderer.send("subtitle-controller:fit-height", height, width),
  goLiveCall: () => ipcRenderer.invoke("live-call:go-live"),
  hostSpeak: () => ipcRenderer.invoke("live-call:host-speak"),
  ensureLiveCallBridge: () => ipcRenderer.invoke("live-call:bridge-ensure"),
  sendLiveCallAudioFrame: (frame) => ipcRenderer.send("live-call:audio-frame", frame),
  onLiveCallCaption: (listener) => {
    const handler = (_event, caption) => listener(caption);
    ipcRenderer.on("live-call:caption", handler);
    return () => ipcRenderer.removeListener("live-call:caption", handler);
  },
  endLiveCall: () => ipcRenderer.invoke("live-call:end"),
  saveLiveHostLogin: (config) => ipcRenderer.invoke("live-call:save-host-login", config),
  getLiveHostLoginStatus: () => ipcRenderer.invoke("live-call:get-host-login-status"),
  getOverlayEnabled: () => ipcRenderer.invoke("subtitle-overlay:get-enabled"),
  setOverlayEnabled: (enabled) => ipcRenderer.invoke("subtitle-overlay:set-enabled", Boolean(enabled)),
  setControllerVisible: (visible) => ipcRenderer.invoke("subtitle-controller:set-visible", Boolean(visible)),
  setOverlayInteractive: (interactive) => ipcRenderer.invoke("subtitle-overlay:set-interactive", Boolean(interactive)),
  showMainWindow: () => ipcRenderer.invoke("app:show-main-window"),
  // The renderer owns the UI language; the main process needs it for the
  // application menu labels.
  setUiLanguage: (language) => ipcRenderer.invoke("app:set-ui-language", language),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  openScreenRecordingSettings: () => ipcRenderer.invoke("system:open-screen-recording-settings"),
});
