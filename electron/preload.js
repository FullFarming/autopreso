// Sandboxed preload — must stay CommonJS: Electron's sandbox executes this as a
// classic script with a limited require() shim, so ESM `import` fails to load
// and silently removes the whole bridge in packaged builds.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("realtimeNoelDesktop", {
  isElectron: true,
  getLiveCallEnabled: () => ipcRenderer.invoke("live-workspace:get-enabled"),
  getLiveInterpreterEnabled: () => ipcRenderer.invoke("live-interpreter:get-enabled"),
  openLiveInterpreter: () => ipcRenderer.invoke("live-interpreter:open"),
  closeLiveInterpreter: () => ipcRenderer.invoke("live-interpreter:close"),
  getLiveInterpreterSnapshot: () => ipcRenderer.invoke("live-interpreter:get-snapshot"),
  startLiveInterpreter: (config) => ipcRenderer.invoke("live-interpreter:start", config),
  sendLiveInterpreterAudio: (packet) => ipcRenderer.send("live-interpreter:audio", packet),
  reconnectLiveInterpreter: (lane) => ipcRenderer.invoke("live-interpreter:reconnect", { lane }),
  stopLiveInterpreter: () => ipcRenderer.invoke("live-interpreter:stop"),
  getLiveInterpreterDevicePreflight: () => ipcRenderer.invoke("live-interpreter:get-device-preflight"),
  onLiveInterpreterSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("live-interpreter:snapshot", handler);
    return () => ipcRenderer.removeListener("live-interpreter:snapshot", handler);
  },
  meetingCoachGetSnapshot: () => ipcRenderer.invoke("meeting-coach:get-snapshot"),
  meetingCoachInterview: (request) => ipcRenderer.invoke("meeting-coach:interview", request),
  meetingCoachSaveDraft: (request) => ipcRenderer.invoke("meeting-coach:save-draft", request),
  meetingCoachFreezeBrief: (request) => ipcRenderer.invoke("meeting-coach:freeze-brief", request),
  meetingCoachStart: (request) => ipcRenderer.invoke("meeting-coach:start", request),
  meetingCoachOpenPrep: () => ipcRenderer.invoke("meeting-coach:open-prep"),
  meetingCoachOpenRecord: () => ipcRenderer.invoke("meeting-coach:open-record"),
  meetingCoachOpenResponse: () => ipcRenderer.invoke("meeting-coach:open-response"),
  meetingCoachOpenLiveWindows: () => ipcRenderer.invoke("meeting-coach:open-live-windows"),
  meetingCoachArrangeWindows: () => ipcRenderer.invoke("meeting-coach:arrange-windows"),
  meetingCoachAnswerTurn: (request) => ipcRenderer.invoke("meeting-coach:answer-turn", request),
  meetingCoachManualAction: (request) => ipcRenderer.invoke("meeting-coach:manual-action", request),
  meetingCoachUseRecommendation: (request) => ipcRenderer.invoke("meeting-coach:use-recommendation", request),
  meetingCoachEnd: (request) => ipcRenderer.invoke("meeting-coach:end", request),
  onMeetingCoachSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("meeting-coach:snapshot", handler);
    return () => ipcRenderer.removeListener("meeting-coach:snapshot", handler);
  },
  startLiveCall: (draft) => ipcRenderer.invoke("live-call:start", draft),
  registerLiveCall: (draft) => ipcRenderer.invoke("live-call:register", draft),
  listRegisteredLiveCalls: () => ipcRenderer.invoke("live-call:list-registered"),
  startRegisteredLiveCall: (sessionId, options) => ipcRenderer.invoke("live-call:start-registered", sessionId, options),
  deleteRegisteredLiveCall: (sessionId) => ipcRenderer.invoke("live-call:delete-registered", sessionId),
  getLiveCallState: () => ipcRenderer.invoke("live-call:get-state"),
  getLiveCallSpeakers: (sessionId) => ipcRenderer.invoke("live-call:speakers-get", sessionId),
  saveLiveCallSpeakers: (sessionId, body) => ipcRenderer.invoke("live-call:speakers-save", sessionId, body),
  listLiveCallSpeakerParticipants: (sessionId) => ipcRenderer.invoke("live-call:speakers-participants", sessionId),
  uploadLiveCallSpeakerPhoto: (sessionId, photo) => ipcRenderer.invoke("live-call:speakers-photo-upload", sessionId, photo),
  liveCallReadSpeakerPhoto: (input) => ipcRenderer.invoke("live-call:speakers-photo-read", input),
  refreshLiveCallArchive: (recordId) => ipcRenderer.invoke("live-call:archive-refresh", recordId),
  moveControllerBy: (deltaX, deltaY) => ipcRenderer.send("subtitle-controller:move-by", deltaX, deltaY),
  fitControllerHeight: (height, width) => ipcRenderer.send("subtitle-controller:fit-height", height, width),
  goLiveCall: () => ipcRenderer.invoke("live-call:go-live"),
  hostSpeak: () => ipcRenderer.invoke("live-call:host-speak"),
  getLiveCallProducerCapability: () => ipcRenderer.invoke("live-call:get-producer-capability"),
  ensureLiveCallBridge: () => ipcRenderer.invoke("live-call:bridge-ensure"),
  reconnectLiveCallTranslation: () => ipcRenderer.invoke("live-call:translation-reconnect"),
  onLiveCallPreflight: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on("live-call:preflight-request", handler);
    return () => ipcRenderer.removeListener("live-call:preflight-request", handler);
  },
  completeLiveCallPreflight: (requestId, result) => ipcRenderer.send("live-call:preflight-result", requestId, result),
  onLiveCallPreflightCancel: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on("live-call:preflight-cancel", handler);
    return () => ipcRenderer.removeListener("live-call:preflight-cancel", handler);
  },
  sendLiveCallAudioFrame: (packet) => ipcRenderer.send("live-call:audio-frame", packet),
  reportLiveCallAudioFailure: (detail) => ipcRenderer.invoke("live-call:audio-failed", detail),
  onLiveCallCaption: (listener) => {
    const handler = (_event, caption) => listener(caption);
    ipcRenderer.on("live-call:caption", handler);
    return () => ipcRenderer.removeListener("live-call:caption", handler);
  },
  onLiveCallFloor: (listener) => {
    const handler = (_event, floor) => listener(floor);
    ipcRenderer.on("live-call:floor", handler);
    return () => ipcRenderer.removeListener("live-call:floor", handler);
  },
  endLiveCall: () => ipcRenderer.invoke("live-call:end"),
  getHostSession: () => ipcRenderer.invoke("host-session:get"),
  openHostLogin: () => ipcRenderer.invoke("host-session:open-login"),
  logoutHostSession: () => ipcRenderer.invoke("host-session:logout"),
  openConsole: () => ipcRenderer.invoke("console:open"),
  listGlossaryPresets: () => ipcRenderer.invoke("glossary-presets:list"),
  createGlossaryPreset: (input) => ipcRenderer.invoke("glossary-presets:create", input),
  updateGlossaryPreset: (input) => ipcRenderer.invoke("glossary-presets:update", input),
  deleteGlossaryPreset: (input) => ipcRenderer.invoke("glossary-presets:delete", input),
  readGlossaryPresetVersion: (input) => ipcRenderer.invoke("glossary-presets:read-version", input),
  getOverlayEnabled: () => ipcRenderer.invoke("subtitle-overlay:get-enabled"),
  setOverlayEnabled: (enabled) => ipcRenderer.invoke("subtitle-overlay:set-enabled", Boolean(enabled)),
  listOverlayDisplays: () => ipcRenderer.invoke("subtitle-overlay:list-displays"),
  selectOverlayDisplays: (displayIds) => ipcRenderer.invoke("subtitle-overlay:select-displays", displayIds),
  selectOverlayDisplay: (displayId) => ipcRenderer.invoke("subtitle-overlay:select-display", displayId),
  setOverlayAllDisplays: (allDisplays) => ipcRenderer.invoke("subtitle-overlay:set-all-displays", allDisplays),
  onOverlayDisplaysChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("subtitle-overlay:displays-changed", handler);
    return () => ipcRenderer.removeListener("subtitle-overlay:displays-changed", handler);
  },
  // Momentary caption hide (e.g. while a video plays). Not persisted.
  setOverlaysMuted: (muted) => ipcRenderer.invoke("subtitle-overlay:set-muted", Boolean(muted)),
  getOverlaysMuted: () => ipcRenderer.invoke("subtitle-overlay:get-muted"),
  setControllerVisible: (visible) => ipcRenderer.invoke("subtitle-controller:set-visible", Boolean(visible)),
  setOverlayInteractive: (interactive) => ipcRenderer.invoke("subtitle-overlay:set-interactive", Boolean(interactive)),
  showMainWindow: () => ipcRenderer.invoke("app:show-main-window"),
  // The renderer owns the UI language; the main process needs it for the
  // application menu labels.
  setUiLanguage: (language) => ipcRenderer.invoke("app:set-ui-language", language),
  getUiLanguage: () => ipcRenderer.invoke("app:get-ui-language"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  openScreenRecordingSettings: () => ipcRenderer.invoke("system:open-screen-recording-settings"),
});
