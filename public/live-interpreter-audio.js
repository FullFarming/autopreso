export const INTERPRETER_MAX_QUEUE_SECONDS = 4;
export const INTERPRETER_MAX_PCM_BYTES = 256 * 1024;

const PLAYBACK_LEAD_SECONDS = 0.08;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function pcmBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    throw new Error("통역 음성 PCM 형식이 올바르지 않습니다.");
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("통역 음성 PCM 형식이 올바르지 않습니다.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function decodeInterpreterPcm16(value) {
  const bytes = pcmBytes(value);
  if (bytes.byteLength > INTERPRETER_MAX_PCM_BYTES) {
    throw new Error("통역 음성 PCM 크기가 허용 범위를 초과했습니다.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new Error("통역 음성 PCM 길이가 올바르지 않습니다.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}

/**
 * @param {unknown} context
 * @returns {asserts context is AudioContext}
 */
function assertAudioContext(context) {
  if (!context || typeof context !== "object"
    || !("createMediaStreamDestination" in context) || typeof context.createMediaStreamDestination !== "function"
    || !("createGain" in context) || typeof context.createGain !== "function"
    || !("createBuffer" in context) || typeof context.createBuffer !== "function"
    || !("createBufferSource" in context) || typeof context.createBufferSource !== "function"
    || !("resume" in context) || typeof context.resume !== "function"
    || !("close" in context) || typeof context.close !== "function") {
    throw new Error("통역 음성 재생 장치를 초기화할 수 없습니다.");
  }
}

/**
 * @param {unknown} audio
 * @returns {asserts audio is HTMLAudioElement}
 */
function assertAudioElement(audio) {
  if (!audio || typeof audio !== "object" || !("play" in audio) || typeof audio.play !== "function"
    || !("pause" in audio) || typeof audio.pause !== "function") {
    throw new Error("통역 음성 출력 장치를 초기화할 수 없습니다.");
  }
}

/**
 * @param {{
 *   createAudioContext?: () => unknown,
 *   createAudioElement?: () => unknown,
 *   onPlaybackGate?: (lane: string, active: boolean) => void,
 *   onFailure?: (error: Error, lane: string) => void,
 *   maxQueueSeconds?: number,
 * }} [options]
 */
export function createInterpreterAudioRouter({
  createAudioContext = () => new AudioContext({ sampleRate: 24_000, latencyHint: "interactive" }),
  createAudioElement = () => document.createElement("audio"),
  onPlaybackGate = () => {},
  onFailure = () => {},
  maxQueueSeconds = INTERPRETER_MAX_QUEUE_SECONDS,
} = {}) {
  const laneStates = new Map();

  function gate(lane, state, active) {
    if (state.isGated === active) return;
    state.isGated = active;
    onPlaybackGate(lane, active);
  }

  function stopSources(lane, state) {
    for (const source of state.sources) {
      try { source.stop(); } catch { /* Source may already be complete. */ }
      source.disconnect?.();
    }
    state.sources.clear();
    state.nextStart = state.context.currentTime;
    gate(lane, state, false);
  }

  async function closeState(lane, state) {
    stopSources(lane, state);
    state.audio.pause?.();
    state.audio.srcObject = null;
    state.gain.disconnect?.();
    await state.context.close();
    laneStates.delete(lane);
  }

  async function configureLane(lane, sinkId, volume = 0.8) {
    const laneName = String(lane ?? "").trim();
    const outputDeviceId = String(sinkId ?? "").trim();
    if (!laneName || !outputDeviceId) throw new Error("출력 장치를 선택하세요.");
    const previous = laneStates.get(laneName);
    if (previous) await closeState(laneName, previous);

    const context = createAudioContext();
    assertAudioContext(context);
    const destination = context.createMediaStreamDestination();
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, Number(volume) || 0));
    gain.connect(destination);
    const audio = createAudioElement();
    assertAudioElement(audio);
    const state = {
      audio, context, destination, gain, isFailed: false, isGated: false,
      nextStart: context.currentTime, sources: new Set(), volume: gain.gain.value,
    };
    try {
      audio.autoplay = true;
      audio.srcObject = destination.stream;
      if (typeof audio.setSinkId !== "function") {
        throw new Error("선택한 출력 장치로 연결할 수 없습니다.");
      }
      await audio.setSinkId(outputDeviceId);
      await context.resume();
      await audio.play();
      laneStates.set(laneName, state);
      return true;
    } catch (cause) {
      await closeState(laneName, state);
      const error = cause instanceof Error
        ? cause
        : new Error("선택한 출력 장치로 연결할 수 없습니다.");
      onFailure(error, laneName);
      throw error;
    }
  }

  function failLane(lane, state, error) {
    stopSources(lane, state);
    state.isFailed = true;
    onFailure(error, lane);
  }

  function enqueue(lane, pcm, sampleRate) {
    const laneName = String(lane ?? "");
    const state = laneStates.get(laneName);
    if (!state || state.isFailed || Number(sampleRate) !== 24_000) return false;
    let samples;
    try {
      samples = decodeInterpreterPcm16(pcm);
    } catch (cause) {
      failLane(laneName, state, cause instanceof Error ? cause : new Error("통역 음성 PCM 형식이 올바르지 않습니다."));
      return false;
    }
    const buffer = state.context.createBuffer(1, samples.length, 24_000);
    buffer.getChannelData(0).set(samples);
    const startAt = Math.max(state.context.currentTime + PLAYBACK_LEAD_SECONDS, state.nextStart);
    const projectedEnd = startAt + buffer.duration;
    if (projectedEnd - state.context.currentTime > maxQueueSeconds) {
      failLane(laneName, state, new Error("통역 음성 지연이 길어져 재연결이 필요합니다."));
      return false;
    }
    const source = state.context.createBufferSource();
    source.buffer = buffer;
    source.connect(state.gain);
    state.sources.add(source);
    gate(laneName, state, true);
    source.addEventListener("ended", () => {
      state.sources.delete(source);
      source.disconnect?.();
      if (state.sources.size === 0) gate(laneName, state, false);
    }, { once: true });
    source.start(startAt);
    state.nextStart = projectedEnd;
    return true;
  }

  function setVolume(lane, volume) {
    const state = laneStates.get(String(lane ?? ""));
    if (!state) return false;
    state.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    state.gain.gain.value = state.volume;
    return true;
  }

  function isPlaybackGateActive(lane) {
    return Boolean(laneStates.get(String(lane ?? ""))?.isGated);
  }

  async function close() {
    await Promise.all([...laneStates].map(([lane, state]) => closeState(lane, state)));
  }

  return { close, configureLane, enqueue, isPlaybackGateActive, setVolume };
}
