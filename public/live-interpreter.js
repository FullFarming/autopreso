import {
  CAPTION_AUDIO_SAMPLE_RATE,
  captureMicrophoneStream,
  createCaptionAudioChunker,
} from "/subtitle-audio-capture.js";
import { createInterpreterAudioRouter } from "/live-interpreter-audio.js";
import { createNovaTranscriptRenderer } from "/nova-transcript.js";
import { LIVE_INTERPRETER_LANGUAGE_OPTIONS } from "/subtitle-language-catalog.js";

const TARGET_LANGUAGES = LIVE_INTERPRETER_LANGUAGE_OPTIONS;

const MAX_PLAYED_EVENT_IDS = 256;
const LANE_CODES = Object.freeze({ inbound: "INBOUND", outbound: "OUTBOUND", user: "USER", other: "OTHER" });
const bridge = window.realtimeNoelDesktop;

const elements = {
  clearTranscript: document.querySelector("#clear-transcript"),
  connectionStatus: document.querySelector("#connection-status"),
  inPersonPanel: document.querySelector("#in-person-panel"),
  jumpToLatest: document.querySelector("#jump-to-latest"),
  latencyValue: document.querySelector("#latency-value"),
  liveSettingsSummary: document.querySelector("#live-settings-summary"),
  liveSettingsSummaryText: document.querySelector("#live-settings-summary-text"),
  modeButtons: [...document.querySelectorAll("[data-mode]")],
  muteAll: document.querySelector("#mute-all-button"),
  onlinePanel: document.querySelector("#online-panel"),
  otherLanguage: document.querySelector("#other-language"),
  preflight: document.querySelector("#preflight-button"),
  pttButtons: [...document.querySelectorAll("[data-ptt-lane]")],
  pttStatus: document.querySelector("#ptt-status"),
  recoveryAction: document.querySelector("#recovery-action"),
  recoveryBar: document.querySelector("#recovery-bar"),
  recoveryMessage: document.querySelector("#recovery-message"),
  shell: document.querySelector(".interpreter-shell"),
  start: document.querySelector("#start-button"),
  stop: document.querySelector("#stop-button"),
  swapLanguages: document.querySelector("#swap-languages"),
  transcriptLog: document.querySelector("#transcript-log"),
  userLanguage: document.querySelector("#user-language"),
};

const state = {
  activePttLane: null,
  activeTranscriptRowIds: new Map(),
  captures: new Map(),
  committedTranscriptRowIds: new Map(),
  isRunning: false,
  mode: "ONLINE",
  mutedLanes: new Set(),
  playedEventIds: new Set(),
  nextTranscriptSequence: 0,
  unsubscribeSnapshot: null,
  recovery: { kind: "reconnect", lane: "" },
};

const transcriptRenderer = createNovaTranscriptRenderer({
  container: elements.transcriptLog,
  scrollBehavior: "smooth",
  classNames: {
    row: "transcript-entry",
    metadata: "transcript-meta",
    source: "transcript-source",
    translation: "transcript-translation",
  },
  onLatestChange({ hasUnseenLatest }) {
    elements.jumpToLatest.hidden = !hasUnseenLatest;
  },
});

const audioRouter = createInterpreterAudioRouter({
  onPlaybackGate: (lane, active) => setLaneStatus(lane, active ? "재생" : "연결됨", active ? "live" : "ok"),
  onFailure: (error, lane) => {
    setLaneStatus(lane, "오류", "error");
    setConnectionStatus(error.message, "error");
    showRecovery(error, lane);
  },
});

function appendOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function populateLanguages() {
  for (const select of [elements.userLanguage, elements.otherLanguage]) {
    for (const language of TARGET_LANGUAGES) appendOption(select, language.code, language.nativeLabel);
  }
  elements.userLanguage.value = "ko";
  elements.otherLanguage.value = "en";
  updateLanguagePreflight();
}

function updatePreflightCheck(name, status, label) {
  const row = document.querySelector(`[data-preflight-check="${name}"]`);
  const value = document.querySelector(`[data-preflight-status="${name}"]`);
  if (!row || !value) return;
  row.classList.toggle("is-ready", status === "ready");
  row.classList.toggle("is-error", status === "error");
  value.textContent = label;
}

function updateLanguagePreflight() {
  const isValid = Boolean(elements.userLanguage.value && elements.otherLanguage.value
    && elements.userLanguage.value !== elements.otherLanguage.value);
  updatePreflightCheck("languages", isValid ? "ready" : "error", isValid ? "확인됨" : "언어 중복");
  return isValid;
}

function deviceLabel(device, index, fallback) {
  const label = String(device.label ?? "").trim();
  return label || `${fallback} ${index + 1}`;
}

function replaceDeviceOptions(select, devices, fallback) {
  const selected = select.value;
  select.replaceChildren();
  devices.forEach((device, index) => appendOption(select, device.deviceId, deviceLabel(device, index, fallback)));
  if (devices.some((device) => device.deviceId === selected)) select.value = selected;
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) throw new Error("오디오 장치를 확인할 수 없습니다.");
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === "audioinput");
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  for (const select of [document.querySelector("#online-mic-input"), document.querySelector("#in-person-mic-input")]) {
    replaceDeviceOptions(select, microphones, "마이크");
  }
  for (const select of [document.querySelector("#online-local-output"), document.querySelector("#in-person-output")]) {
    replaceDeviceOptions(select, outputs, "스피커");
  }
  const virtualOutput = document.querySelector("#online-virtual-output");
  replaceDeviceOptions(virtualOutput, outputs, "출력");
  const blackHole = outputs.find((device) => /blackhole/iu.test(device.label));
  if (blackHole) virtualOutput.value = blackHole.deviceId;
  updatePreflightCheck("microphone", microphones.length > 0 ? "ready" : "error", microphones.length > 0 ? "확인됨" : "없음");
  const hasSystemAudio = typeof navigator.mediaDevices.getDisplayMedia === "function";
  updatePreflightCheck(
    "system",
    state.mode !== "ONLINE" || hasSystemAudio ? "ready" : "error",
    state.mode !== "ONLINE" ? "해당 없음" : hasSystemAudio ? "확인됨" : "없음",
  );
  updatePreflightCheck("blackhole", state.mode !== "ONLINE" || blackHole ? "ready" : "error", state.mode !== "ONLINE" ? "해당 없음" : blackHole ? "확인됨" : "없음");
  return { microphones, outputs, hasBlackHole: Boolean(blackHole) };
}

function statusDot(root) {
  return root?.querySelector(".status-dot");
}

function paintDot(dot, tone) {
  if (!dot) return;
  dot.className = `status-dot status-dot-${tone}`;
}

function setConnectionStatus(label, tone = "neutral") {
  const statusLabel = elements.connectionStatus.querySelector(".status-label");
  statusLabel.textContent = String(label ?? "대기");
  paintDot(statusDot(elements.connectionStatus), tone);
}

function setLaneStatus(lane, label, tone = "neutral") {
  const laneName = String(lane ?? "").toLowerCase();
  const status = document.querySelector(`[data-lane-status="${laneName}"]`);
  if (status) {
    status.textContent = label;
    paintDot(status.closest(".lane-state")?.querySelector(".status-dot"), tone);
  }
  if ((laneName === "user" || laneName === "other") && elements.pttStatus) {
    elements.pttStatus.textContent = label;
    paintDot(elements.pttStatus.closest(".lane-state")?.querySelector(".status-dot"), tone);
  }
}

function setMode(mode) {
  if (state.isRunning || !["ONLINE", "IN_PERSON"].includes(mode)) return;
  state.mode = mode;
  if (mode === "IN_PERSON" && state.recovery.kind === "blackhole") clearRecovery();
  for (const button of elements.modeButtons) button.setAttribute("aria-selected", String(button.dataset.mode === mode));
  elements.onlinePanel.hidden = mode !== "ONLINE";
  elements.inPersonPanel.hidden = mode !== "IN_PERSON";
  void refreshDevices().catch((error) => showRecovery(error));
}

function getLaneVolume(lane) {
  const input = lane === "user" || lane === "other"
    ? document.querySelector("#in-person-volume")
    : document.querySelector(`#${lane}-volume`);
  return Number(input?.value ?? 80) / 100;
}

const RECOVERY_PRESENTATION = Object.freeze({
  permission: Object.freeze({ message: "오디오 권한 필요", action: "권한 설정" }),
  devices: Object.freeze({ message: "오디오 장치 확인 필요", action: "장치 새로고침" }),
  blackhole: Object.freeze({
    message: "온라인 통역에는 BlackHole 2ch가 필요합니다. 설치한 뒤 Teams/Zoom 마이크로 선택하세요.",
    action: "설치 후 다시 검사",
  }),
  reconnect: Object.freeze({ message: "통역 연결 복구 필요", action: "재연결" }),
});

function classifyRecovery(value) {
  const text = String(value ?? "").toLowerCase();
  if (/permission|denied|notallowed|권한/u.test(text)) return "permission";
  if (/blackhole/u.test(text)) return "blackhole";
  if (/device|microphone|audio|output|input|마이크|오디오|장치/u.test(text)) return "devices";
  return "reconnect";
}

function showRecovery(error, lane = "") {
  const errorText = error instanceof Error
    ? `${error.name} ${error.message}`
    : typeof error === "object" && error && "code" in error
      ? String(error.code)
      : String(error ?? "");
  const kind = classifyRecovery(errorText);
  const presentation = RECOVERY_PRESENTATION[kind];
  state.recovery = { kind, lane: String(lane ?? "").toLowerCase() };
  elements.recoveryMessage.textContent = presentation.message;
  elements.recoveryAction.textContent = presentation.action;
  elements.recoveryBar.hidden = false;
}

function clearRecovery() {
  elements.recoveryBar.hidden = true;
}

async function performRecovery() {
  elements.recoveryAction.disabled = true;
  try {
    if (state.recovery.kind === "permission") {
      if (typeof bridge?.openScreenRecordingSettings !== "function") throw new Error("권한 설정 연결 없음");
      await bridge.openScreenRecordingSettings();
    } else if (state.recovery.kind === "devices" || state.recovery.kind === "blackhole") {
      await runPreflight();
    } else {
      if (typeof bridge?.reconnectLiveInterpreter !== "function") throw new Error("재연결 기능 없음");
      const lanes = state.recovery.lane
        ? [state.recovery.lane]
        : state.mode === "ONLINE" ? ["inbound", "outbound"] : ["user", "other"];
      await Promise.all(lanes.map((lane) => bridge.reconnectLiveInterpreter(LANE_CODES[lane])));
    }
    clearRecovery();
  } catch (error) {
    showRecovery(error, state.recovery.lane);
  } finally {
    elements.recoveryAction.disabled = false;
  }
}

async function requestMicrophonePermission() {
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") throw new Error("마이크 장치 없음");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
}

async function runPreflight() {
  elements.preflight.disabled = true;
  setConnectionStatus("점검 중", "warn");
  try {
    if (!updateLanguagePreflight()) throw new Error("언어 중복");
    await requestMicrophonePermission();
    const local = await refreshDevices();
    const remoteEnvelope = typeof bridge?.getLiveInterpreterDevicePreflight === "function"
      ? await bridge.getLiveInterpreterDevicePreflight()
      : null;
    if (remoteEnvelope?.ok === false) throw new Error(String(remoteEnvelope.error ?? "장치 점검 실패"));
    const remote = remoteEnvelope?.ok === true ? remoteEnvelope.data : remoteEnvelope;
    if (remote?.ready === false) throw new Error(String(remote.error ?? "장치 점검 실패"));
    if (local.microphones.length === 0) throw new Error("마이크 없음");
    if (local.outputs.length === 0) throw new Error("출력 장치 없음");
    if (state.mode === "ONLINE" && !local.hasBlackHole) throw new Error("BlackHole 없음");
    if (state.mode === "ONLINE" && !document.querySelector("#virtual-mic-confirmed").checked) {
      throw new Error("회의 앱 마이크 확인 필요");
    }
    const microphoneSelect = document.querySelector(state.mode === "ONLINE" ? "#online-mic-input" : "#in-person-mic-input");
    const microphone = local.microphones.find((device) => device.deviceId === microphoneSelect.value) ?? local.microphones[0];
    const virtualOutputSelect = document.querySelector("#online-virtual-output");
    const virtualOutput = local.outputs.find((device) => device.deviceId === virtualOutputSelect.value);
    if (state.mode === "ONLINE" && !/blackhole/iu.test(virtualOutput?.label ?? "")) throw new Error("BlackHole 출력 선택 필요");
    const devicePreflight = {
      microphone: {
        available: Boolean(microphone),
        deviceId: String(microphone?.deviceId ?? ""),
        label: String(microphone?.label ?? ""),
      },
      systemAudio: state.mode === "ONLINE"
        ? { available: typeof navigator.mediaDevices.getDisplayMedia === "function", method: "display-capture" }
        : { available: false, method: "none" },
      virtualOutput: state.mode === "ONLINE"
        ? {
            available: Boolean(virtualOutput),
            deviceId: String(virtualOutput?.deviceId ?? ""),
            label: String(virtualOutput?.label ?? ""),
          }
        : { available: false, deviceId: "", label: "" },
    };
    if (state.mode === "ONLINE" && !devicePreflight.systemAudio.available) throw new Error("시스템 오디오 없음");
    updatePreflightCheck("microphone", "ready", "확인됨");
    updatePreflightCheck("system", "ready", state.mode === "ONLINE" ? "확인됨" : "해당 없음");
    updatePreflightCheck("blackhole", "ready", state.mode === "ONLINE" ? "확인됨" : "해당 없음");
    clearRecovery();
    setConnectionStatus("점검 완료", "ok");
    return devicePreflight;
  } catch (error) {
    const recovery = classifyRecovery(error instanceof Error ? error.message : error);
    if (recovery === "blackhole") updatePreflightCheck("blackhole", "error", "확인 필요");
    if (recovery === "devices") updatePreflightCheck("microphone", "error", "확인 필요");
    if (recovery === "permission") updatePreflightCheck("system", "error", "권한 필요");
    setConnectionStatus(error instanceof Error ? error.message : "점검 실패", "error");
    showRecovery(error);
    throw error;
  } finally {
    elements.preflight.disabled = false;
  }
}

function captureConstraints(kind, deviceId) {
  if (kind === "system") return { audio: true, video: true };
  return deviceId;
}

async function openCapture(kind, deviceId, lane) {
  const laneName = String(lane).toLowerCase();
  await stopCapture(laneName);
  const stream = kind === "system"
    ? await navigator.mediaDevices.getDisplayMedia(captureConstraints(kind, deviceId))
    : await captureMicrophoneStream(navigator.mediaDevices, captureConstraints(kind, deviceId));
  if (stream.getAudioTracks().length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(kind === "system" ? "시스템 오디오 없음" : "마이크 오디오 없음");
  }
  const context = new AudioContext({ sampleRate: CAPTION_AUDIO_SAMPLE_RATE, latencyHint: "interactive" });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(1_024, 1, 1);
  const silent = context.createGain();
  silent.gain.value = 0;
  const chunker = createCaptionAudioChunker({
    inputSampleRate: context.sampleRate,
    source: LANE_CODES[laneName],
    onChunk: (packet) => {
      if (!state.isRunning || state.mutedLanes.has(laneName) || audioRouter.isPlaybackGateActive(laneName)) return;
      if (state.mode === "IN_PERSON" && state.activePttLane !== laneName) return;
      bridge?.sendLiveInterpreterAudio?.({
        lane: LANE_CODES[laneName], sampleRate: packet.sampleRate,
        frameDurationMs: packet.frameDurationMs, pcm: packet.pcm,
      });
    },
  });
  processor.addEventListener("audioprocess", (event) => chunker.push(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);
  await context.resume();
  const capture = { context, processor, silent, source, stream };
  for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => void handleCaptureEnded(laneName), { once: true });
  state.captures.set(laneName, capture);
}

async function stopCapture(lane) {
  const laneName = String(lane ?? "").toLowerCase();
  const capture = state.captures.get(laneName);
  if (!capture) return;
  state.captures.delete(laneName);
  capture.source.disconnect();
  capture.processor.disconnect();
  capture.silent.disconnect();
  for (const track of capture.stream.getTracks()) track.stop();
  await capture.context.close();
}

async function stopAllCaptures() {
  await Promise.all([...state.captures.keys()].map((lane) => stopCapture(lane)));
}

async function handleCaptureEnded(lane) {
  if (!state.isRunning || !state.captures.has(lane)) return;
  await stopCapture(lane);
  setLaneStatus(lane, "입력 종료", "error");
  setConnectionStatus("입력 종료", "error");
  showRecovery(new Error("오디오 입력 장치 연결 종료"), lane);
}

async function configureOutputs() {
  if (state.mode === "ONLINE") {
    await audioRouter.configureLane("inbound", document.querySelector("#online-local-output").value, getLaneVolume("inbound"));
    await audioRouter.configureLane("outbound", document.querySelector("#online-virtual-output").value, getLaneVolume("outbound"));
    return;
  }
  const outputDeviceId = document.querySelector("#in-person-output").value;
  await audioRouter.configureLane("user", outputDeviceId, getLaneVolume("user"));
  await audioRouter.configureLane("other", outputDeviceId, getLaneVolume("other"));
}

async function startSession() {
  if (state.isRunning) return;
  if (elements.userLanguage.value === elements.otherLanguage.value) {
    setConnectionStatus("언어 중복", "error");
    return;
  }
  if (typeof bridge?.startLiveInterpreter !== "function" || typeof bridge?.sendLiveInterpreterAudio !== "function") {
    setConnectionStatus("데스크톱 연결 없음", "error");
    return;
  }
  elements.start.disabled = true;
  setConnectionStatus("연결 중", "warn");
  let isRemoteStarted = false;
  try {
    const devicePreflight = await runPreflight();
    await configureOutputs();
    if (state.mode === "ONLINE") {
      const captureResults = await Promise.allSettled([
        openCapture("system", "", "inbound"),
        openCapture("mic", document.querySelector("#online-mic-input").value, "outbound"),
      ]);
      const failedCapture = captureResults.find((result) => result.status === "rejected");
      if (failedCapture?.status === "rejected") throw failedCapture.reason;
    }
    const result = await bridge.startLiveInterpreter({
      mode: state.mode,
      userLanguage: elements.userLanguage.value,
      otherLanguage: elements.otherLanguage.value,
      devicePreflight,
    });
    if (result?.ok === false) throw new Error(String(result.error ?? "연결 실패"));
    isRemoteStarted = true;
    state.isRunning = true;
    paintRunningState(true);
    clearRecovery();
    setConnectionStatus("연결됨", "ok");
  } catch (error) {
    await stopAllCaptures();
    await audioRouter.close();
    if (isRemoteStarted) {
      try { await bridge.stopLiveInterpreter(); } catch { /* Local fail-close is already complete. */ }
    }
    state.isRunning = false;
    paintRunningState(false);
    setConnectionStatus(error instanceof Error ? error.message : "연결 실패", "error");
    showRecovery(error);
  }
}

async function stopSession() {
  elements.stop.disabled = true;
  await releasePtt();
  await stopAllCaptures();
  await audioRouter.close();
  try { await bridge?.stopLiveInterpreter?.(); } catch { /* Local teardown remains authoritative. */ }
  state.isRunning = false;
  state.mutedLanes.clear();
  paintRunningState(false);
  clearRecovery();
  setConnectionStatus("중지됨", "neutral");
}

function selectedLanguageLabel(select) {
  return select.selectedOptions[0]?.textContent?.trim() || select.value;
}

function renderLiveSettingsSummary() {
  const mode = state.mode === "ONLINE" ? "온라인" : "대면";
  const route = `${selectedLanguageLabel(elements.userLanguage)}→${selectedLanguageLabel(elements.otherLanguage)}`;
  const devices = state.mode === "ONLINE" ? "시스템+마이크 / BlackHole" : "PTT / 스피커";
  elements.liveSettingsSummaryText.textContent = `${mode} · ${route} · ${devices}`;
}

function paintRunningState(running) {
  elements.shell.classList.toggle("is-live", running);
  elements.liveSettingsSummary.hidden = !running;
  if (running) renderLiveSettingsSummary();
  elements.start.disabled = running;
  elements.stop.disabled = !running;
  elements.preflight.disabled = running;
  for (const button of elements.modeButtons) button.disabled = running;
  elements.userLanguage.disabled = running;
  elements.otherLanguage.disabled = running;
  elements.swapLanguages.disabled = running;
  for (const lane of state.mode === "ONLINE" ? ["inbound", "outbound"] : ["user", "other"]) {
    setLaneStatus(lane, running ? "연결됨" : "대기", running ? "ok" : "neutral");
  }
}

async function pressPtt(lane) {
  if (!state.isRunning || state.mode !== "IN_PERSON" || state.activePttLane === lane) return;
  await releasePtt();
  state.activePttLane = lane;
  for (const button of elements.pttButtons) button.setAttribute("aria-pressed", String(button.dataset.pttLane === lane));
  setLaneStatus(lane, "말하는 중", "live");
  try {
    await openCapture("mic", document.querySelector("#in-person-mic-input").value, lane);
  } catch (error) {
    state.activePttLane = null;
    for (const button of elements.pttButtons) button.setAttribute("aria-pressed", "false");
    setConnectionStatus(error instanceof Error ? error.message : "마이크 오류", "error");
    showRecovery(error, lane);
  }
}

async function releasePtt() {
  const lane = state.activePttLane;
  if (!lane) return;
  state.activePttLane = null;
  for (const button of elements.pttButtons) button.setAttribute("aria-pressed", "false");
  await stopCapture(lane);
  setLaneStatus(lane, "연결됨", "ok");
}

function transcriptId(record, fallback) {
  const candidate = record?.eventId ?? record?.id ?? fallback;
  return String(candidate ?? "").slice(0, 128);
}

function transcriptLane(record) {
  const laneName = String(record?.lane ?? "").toLowerCase();
  return LANE_CODES[laneName] ? laneName : "";
}

function adaptInterpreterTranscript(record, id, status) {
  return {
    id,
    sourceText: record?.source ?? record?.sourceText ?? record?.inputTranscript ?? "",
    translatedText: record?.translation ?? record?.translatedText ?? record?.outputTranscript ?? "",
    speaker: String(record?.lane ?? "").toUpperCase() || "LIVE",
    time: formatTime(record?.timestamp ?? record?.createdAt),
    type: "live-interpreter",
    status: record?.errorCode ? "error" : status,
  };
}

function getActiveTranscriptRowId(laneName) {
  const currentId = state.activeTranscriptRowIds.get(laneName);
  if (currentId) return currentId;
  state.nextTranscriptSequence += 1;
  const nextId = `live-${laneName}-${state.nextTranscriptSequence}`;
  state.activeTranscriptRowIds.set(laneName, nextId);
  return nextId;
}

function upsertPartialTranscript(record) {
  if (!record || typeof record !== "object") return;
  const laneName = transcriptLane(record);
  if (!laneName) return;
  transcriptRenderer.update(adaptInterpreterTranscript(record, getActiveTranscriptRowId(laneName), "partial"));
}

function upsertCommittedTranscript(record) {
  if (!record || typeof record !== "object") return;
  const recordId = transcriptId(record, "");
  if (!recordId) return;
  const laneName = transcriptLane(record);
  let rowId = state.committedTranscriptRowIds.get(recordId);
  if (!rowId) {
    rowId = (laneName && state.activeTranscriptRowIds.get(laneName)) || recordId;
    state.committedTranscriptRowIds.set(recordId, rowId);
    if (laneName && state.activeTranscriptRowIds.get(laneName) === rowId) {
      state.activeTranscriptRowIds.delete(laneName);
    }
  }
  transcriptRenderer.update(adaptInterpreterTranscript(record, rowId, "final"));
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function rememberAudioEvent(eventId) {
  if (!eventId || state.playedEventIds.has(eventId)) return false;
  state.playedEventIds.add(eventId);
  while (state.playedEventIds.size > MAX_PLAYED_EVENT_IDS) state.playedEventIds.delete(state.playedEventIds.values().next().value);
  return true;
}

function applyAudioDelta(delta) {
  if (!delta || typeof delta !== "object") return;
  const lane = String(delta.lane ?? "").toLowerCase();
  const eventId = String(delta.eventId ?? "");
  if (!LANE_CODES[lane] || !rememberAudioEvent(eventId)) return;
  if (!audioRouter.enqueue(lane, delta.audioBase64, delta.sampleRate)) setLaneStatus(lane, "재생 오류", "error");
}

const LANE_STATE_PRESENTATION = Object.freeze({
  ACTIVE: Object.freeze({ label: "연결됨", tone: "ok" }),
  CONNECTING: Object.freeze({ label: "연결 중", tone: "warn" }),
  CLOSING: Object.freeze({ label: "종료 중", tone: "warn" }),
  CLOSED: Object.freeze({ label: "대기", tone: "neutral" }),
  IDLE: Object.freeze({ label: "대기", tone: "neutral" }),
  ERROR: Object.freeze({ label: "오류", tone: "error" }),
});

function presentLaneState(value) {
  return LANE_STATE_PRESENTATION[String(value ?? "").toUpperCase()]
    ?? { label: "대기", tone: "neutral" };
}

function applySnapshot(snapshot) {
  snapshot = unwrapSnapshot(snapshot);
  if (!snapshot || typeof snapshot !== "object") return;
  const connectionMap = {
    CONNECTED: ["연결됨", "ok"], CONNECTING: ["연결 중", "warn"],
    ERROR: ["오류", "error"], IDLE: ["대기", "neutral"],
    RECONNECTING: ["재연결 중", "warn"], RUNNING: ["통역 중", "live"], STOPPED: ["중지됨", "neutral"],
  };
  const snapshotState = String(snapshot.state ?? "").toUpperCase();
  const [label, tone] = connectionMap[snapshotState] ?? ["대기", "neutral"];
  if (snapshotState === "RUNNING" && !state.isRunning) {
    state.isRunning = true;
    paintRunningState(true);
  } else if (["IDLE", "STOPPED"].includes(snapshotState) && state.isRunning) {
    state.isRunning = false;
    paintRunningState(false);
  }
  setConnectionStatus(label, tone);
  for (const record of Array.isArray(snapshot.records) ? snapshot.records : []) upsertCommittedTranscript(record);
  const laneValues = interpreterLaneEntries(snapshot.lanes);
  let latency = Number(snapshot.latencyMs);
  for (const lane of laneValues) {
    const laneName = String(lane?.lane ?? lane?.name ?? "").toLowerCase();
    if (!LANE_CODES[laneName]) continue;
    const laneState = presentLaneState(lane.state);
    setLaneStatus(laneName, laneState.label, laneState.tone);
    if (lane.errorCode) showRecovery({ code: lane.errorCode }, laneName);
    if (lane.inputTranscript || lane.outputTranscript) {
      upsertPartialTranscript(lane);
    }
    if (Number.isFinite(Number(lane.latencyMs))) latency = Math.max(Number.isFinite(latency) ? latency : 0, Number(lane.latencyMs));
  }
  if (Number.isFinite(latency) && latency >= 0) elements.latencyValue.textContent = `${Math.round(latency)} ms`;
  if (snapshot.errorCode) showRecovery({ code: snapshot.errorCode });
  applyAudioDelta(snapshot.audioDelta);
}

function unwrapSnapshot(value) {
  if (value?.ok === true && value.data && typeof value.data === "object") return value.data;
  return value;
}

function interpreterLaneEntries(lanes) {
  if (Array.isArray(lanes)) return lanes;
  if (!lanes || typeof lanes !== "object") return [];
  return Object.entries(lanes).map(([lane, value]) => (
    value && typeof value === "object" ? { ...value, lane } : { lane, state: value }
  ));
}

function bindEvents() {
  elements.modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  elements.swapLanguages.addEventListener("click", () => {
    const userLanguage = elements.userLanguage.value;
    elements.userLanguage.value = elements.otherLanguage.value;
    elements.otherLanguage.value = userLanguage;
    updateLanguagePreflight();
  });
  elements.userLanguage.addEventListener("change", updateLanguagePreflight);
  elements.otherLanguage.addEventListener("change", updateLanguagePreflight);
  elements.preflight.addEventListener("click", () => void runPreflight().catch(() => {}));
  elements.recoveryAction.addEventListener("click", () => void performRecovery());
  elements.start.addEventListener("click", () => void startSession());
  elements.stop.addEventListener("click", () => void stopSession());
  document.querySelectorAll("[data-mute-lane]").forEach((button) => button.addEventListener("click", () => {
    const lane = button.dataset.muteLane;
    state.mutedLanes.has(lane) ? state.mutedLanes.delete(lane) : state.mutedLanes.add(lane);
    button.setAttribute("aria-pressed", String(state.mutedLanes.has(lane)));
  }));
  elements.muteAll.addEventListener("click", () => {
    const shouldMute = elements.muteAll.getAttribute("aria-pressed") !== "true";
    elements.muteAll.setAttribute("aria-pressed", String(shouldMute));
    const lanes = state.mode === "ONLINE" ? ["inbound", "outbound"] : ["user", "other"];
    for (const lane of lanes) shouldMute ? state.mutedLanes.add(lane) : state.mutedLanes.delete(lane);
  });
  document.querySelectorAll("[data-volume-lane]").forEach((input) => input.addEventListener("input", () => {
    input.nextElementSibling.textContent = input.value;
    const lanes = input.dataset.volumeLane === "in-person" ? ["user", "other"] : [input.dataset.volumeLane];
    for (const lane of lanes) audioRouter.setVolume(lane, Number(input.value) / 100);
  }));
  document.querySelectorAll("[data-reconnect-lane]").forEach((button) => button.addEventListener("click", async () => {
    const lane = button.dataset.reconnectLane;
    setLaneStatus(lane, "재연결 중", "warn");
    try {
      await bridge?.reconnectLiveInterpreter?.(LANE_CODES[lane]);
      clearRecovery();
    } catch (error) {
      setLaneStatus(lane, "재연결 실패", "error");
      showRecovery(error, lane);
    }
  }));
  for (const button of elements.pttButtons) {
    button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture?.(event.pointerId); void pressPtt(button.dataset.pttLane); });
    button.addEventListener("pointerup", () => void releasePtt());
    button.addEventListener("pointercancel", () => void releasePtt());
    button.addEventListener("keydown", (event) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); void pressPtt(button.dataset.pttLane); }
    });
    button.addEventListener("keyup", (event) => { if (event.key === " " || event.key === "Enter") void releasePtt(); });
  }
  elements.jumpToLatest.addEventListener("click", () => transcriptRenderer.moveToLatest());
  elements.clearTranscript.addEventListener("click", () => {
    transcriptRenderer.replace([]);
    state.activeTranscriptRowIds.clear();
    state.committedTranscriptRowIds.clear();
  });
  window.addEventListener("blur", () => void releasePtt());
  window.addEventListener("beforeunload", () => {
    state.unsubscribeSnapshot?.();
    state.unsubscribeSnapshot = null;
    void stopAllCaptures();
    void audioRouter.close();
  });
}

async function initialize() {
  populateLanguages();
  bindEvents();
  try { await refreshDevices(); } catch { setConnectionStatus("장치 확인 필요", "warn"); }
  if (typeof bridge?.onLiveInterpreterSnapshot === "function") {
    const unsubscribe = bridge.onLiveInterpreterSnapshot(applySnapshot);
    if (typeof unsubscribe === "function") state.unsubscribeSnapshot = unsubscribe;
  }
  if (typeof bridge?.getLiveInterpreterSnapshot === "function") {
    try { applySnapshot(await bridge.getLiveInterpreterSnapshot()); } catch { setConnectionStatus("대기", "neutral"); }
  }
}

void initialize();
