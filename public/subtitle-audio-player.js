const MAX_QUEUE_SECONDS = 30;
const MAX_QUEUE_PCM_BYTES = 24_000 * 2 * MAX_QUEUE_SECONDS;
const MAX_PCM_BYTES = 256 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_PCM_BYTES / 3);
const INPUT_SUPPRESSION_TAIL_SECONDS = 0.75;
const STARTUP_LEAD_SECONDS = 0.25;
const MAX_ADAPTIVE_PLAYBACK_RATE = 1.6;
const MAX_PLAYBACK_RATE_RISE_PER_CHUNK = 0.08;
const MAX_PLAYBACK_RATE_FALL_PER_CHUNK = 0.04;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function getAdaptivePlaybackRate(queueAheadSeconds, previousRate = 1) {
  const queueAhead = Math.max(0, Number.isFinite(Number(queueAheadSeconds)) ? Number(queueAheadSeconds) : 0);
  const currentRate = Math.max(1, Math.min(MAX_ADAPTIVE_PLAYBACK_RATE,
    Number.isFinite(Number(previousRate)) ? Number(previousRate) : 1));
  let targetRate = 1;
  if (queueAhead >= 10) targetRate = MAX_ADAPTIVE_PLAYBACK_RATE;
  else if (queueAhead > 4) targetRate = 1.25 + ((queueAhead - 4) / 6) * 0.2;
  else if (queueAhead > 1) targetRate = 1 + ((queueAhead - 1) / 3) * 0.25;
  const delta = targetRate - currentRate;
  if (delta > 0) return Math.min(MAX_ADAPTIVE_PLAYBACK_RATE, currentRate + Math.min(delta, MAX_PLAYBACK_RATE_RISE_PER_CHUNK));
  return Math.max(1, currentRate + Math.max(delta, -MAX_PLAYBACK_RATE_FALL_PER_CHUNK));
}

function audioFingerprint(message) {
  const audio = message.audio;
  let firstHash = 2_166_136_261;
  let secondHash = 5_381;
  for (let index = 0; index < audio.length; index += 1) {
    const code = audio.charCodeAt(index);
    firstHash = Math.imul(firstHash ^ code, 16_777_619) >>> 0;
    secondHash = (Math.imul(secondHash, 33) ^ code) >>> 0;
  }
  return `${message.source ?? ""}:${message.targetLanguage ?? ""}:${audio.length}:${firstHash}:${secondHash}`;
}

export function shouldGateTranslatedAudioInput(outputMode, isPlaybackActive, source) {
  return source !== "mic"
    && (outputMode === "audio" || outputMode === "captions_audio")
    && Boolean(isPlaybackActive);
}

export function createTranslatedAudioGuard({
  maxEntries = 48,
  retentionMs = 30_000,
  now = () => Date.now(),
} = {}) {
  let activeStreamId = null;
  let lastSeq = -1;
  let sequenceFloor = -1;
  const recentFingerprints = new Map();
  const retiredStreamIds = new Set();

  function selectStream(message) {
    const streamId = typeof message?.streamId === "string" && message.streamId ? message.streamId : null;
    if (!streamId || streamId === activeStreamId) return true;
    if (retiredStreamIds.has(streamId)) return false;
    if (activeStreamId) {
      retiredStreamIds.add(activeStreamId);
      while (retiredStreamIds.size > 8) retiredStreamIds.delete(retiredStreamIds.values().next().value);
    }
    activeStreamId = streamId;
    lastSeq = -1;
    sequenceFloor = -1;
    recentFingerprints.clear();
    return true;
  }

  function prune(timestamp) {
    for (const [fingerprint, expiresAt] of recentFingerprints) {
      if (expiresAt > timestamp) continue;
      recentFingerprints.delete(fingerprint);
    }
    while (recentFingerprints.size > maxEntries) {
      const oldest = recentFingerprints.keys().next().value;
      if (oldest === undefined) break;
      recentFingerprints.delete(oldest);
    }
  }

  function shouldAccept(message) {
    if (!message || typeof message.audio !== "string") return false;
    if (!selectStream(message)) return false;
    const sequence = message.seq;
    if (Number.isSafeInteger(sequence)) {
      if (sequence <= sequenceFloor || sequence <= lastSeq) return false;
      lastSeq = sequence;
    }
    const timestamp = now();
    prune(timestamp);
    const fingerprint = audioFingerprint(message);
    if ((recentFingerprints.get(fingerprint) ?? 0) > timestamp) return false;
    recentFingerprints.set(fingerprint, timestamp + retentionMs);
    prune(timestamp);
    return true;
  }

  function markControl(message) {
    if (!selectStream(message)) return false;
    const sequence = message?.seq;
    if (!Number.isSafeInteger(sequence)) return true;
    if (sequence <= sequenceFloor || sequence <= lastSeq) return false;
    sequenceFloor = Math.max(sequenceFloor, sequence);
    lastSeq = Math.max(lastSeq, sequence);
    return true;
  }

  function reset() {
    activeStreamId = null;
    lastSeq = -1;
    sequenceFloor = -1;
    recentFingerprints.clear();
    retiredStreamIds.clear();
  }

  return {
    markControl,
    reset,
    shouldAccept,
    get activeStreamId() { return activeStreamId; },
  };
}

/**
 * @param {unknown} value
 * @returns {asserts value is AudioContext}
 */
function assertAudioContext(value) {
  if (!value || typeof value !== "object"
    || !("currentTime" in value) || typeof value.currentTime !== "number"
    || !("createGain" in value) || typeof value.createGain !== "function"
    || !("createBuffer" in value) || typeof value.createBuffer !== "function"
    || !("createBufferSource" in value) || typeof value.createBufferSource !== "function"
    || !("resume" in value) || typeof value.resume !== "function"
    || !("close" in value) || typeof value.close !== "function") {
    throw new Error("통역 음성 재생 장치를 초기화할 수 없습니다.");
  }
}

export function decodePcm16Base64(audio) {
  if (typeof audio !== "string" || !audio) throw new Error("통역 음성 데이터가 올바르지 않습니다.");
  if (audio.length > MAX_BASE64_LENGTH) throw new Error("통역 음성 PCM 크기가 허용 범위를 초과했습니다.");
  if (audio.length % 4 !== 0 || !CANONICAL_BASE64.test(audio)) throw new Error("통역 음성 base64 형식이 올바르지 않습니다.");
  const paddingBytes = audio.endsWith("==") ? 2 : audio.endsWith("=") ? 1 : 0;
  const decodedByteLength = (audio.length / 4) * 3 - paddingBytes;
  if (decodedByteLength > MAX_PCM_BYTES) throw new Error("통역 음성 PCM 크기가 허용 범위를 초과했습니다.");
  let binary;
  try {
    binary = atob(audio);
  } catch {
    throw new Error("통역 음성 데이터를 해석할 수 없습니다.");
  }
  if (binary.length === 0 || binary.length > MAX_PCM_BYTES || binary.length % 2 !== 0) {
    throw new Error("통역 음성 PCM 길이가 올바르지 않습니다.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}

/**
 * @param {{
 *   createAudioContext?: () => unknown,
 *   onFailure?: (error: Error) => void,
 *   onQueueRestart?: (detail: { reason: "backlog", droppedSeconds: number }) => void,
 *   maxQueueSeconds?: number,
 *   maxQueuePcmBytes?: number,
 * }} [options]
 */
export function createSubtitleAudioPlayer({
  createAudioContext = () => new AudioContext({ sampleRate: 24_000 }),
  onFailure = () => {},
  onQueueRestart = () => {},
  maxQueueSeconds = MAX_QUEUE_SECONDS,
  maxQueuePcmBytes = MAX_QUEUE_PCM_BYTES,
} = {}) {
  let context = null;
  let gain = null;
  let nextStart = 0;
  let volume = 0.8;
  let isFailed = false;
  let queuedPcmBytes = 0;
  let suppressInputUntil = 0;
  let playbackRate = 1;
  const scheduledSources = new Set();
  const sourceByteLengths = new Map();

  function ensureContext() {
    if (context) return;
    const nextContext = createAudioContext();
    assertAudioContext(nextContext);
    context = nextContext;
    gain = context.createGain();
    gain.gain.value = volume;
    gain.connect(context.destination);
    nextStart = context.currentTime;
  }

  function stopScheduledSources() {
    for (const source of scheduledSources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended; disconnect still follows below.
      }
      source.disconnect();
    }
    scheduledSources.clear();
    sourceByteLengths.clear();
    queuedPcmBytes = 0;
    playbackRate = 1;
  }

  function clear() {
    if (scheduledSources.size > 0 && context) {
      suppressInputUntil = Math.max(suppressInputUntil, context.currentTime + INPUT_SUPPRESSION_TAIL_SECONDS);
    }
    stopScheduledSources();
    nextStart = context?.currentTime ?? 0;
  }

  function restartQueue(droppedSeconds) {
    clear();
    onQueueRestart({ reason: "backlog", droppedSeconds });
  }

  function setVolume(nextVolume) {
    volume = Math.max(0, Math.min(1, Number.isFinite(Number(nextVolume)) ? Number(nextVolume) : 0.8));
    if (gain) gain.gain.value = volume;
  }

  async function resume(nextVolume = volume) {
    setVolume(nextVolume);
    ensureContext();
    isFailed = false;
    try {
      await context.resume();
    } catch {
      const error = new Error("통역 음성 재생을 시작할 수 없습니다. 출력 장치를 확인하세요.");
      failClosed(error);
      throw error;
    }
    if (context.state !== undefined && context.state !== "running") {
      const error = new Error("통역 음성 재생 권한이 활성화되지 않았습니다. 다시 시작하세요.");
      failClosed(error);
      throw error;
    }
    nextStart = Math.max(context.currentTime, nextStart);
  }

  function failClosed(error) {
    clear();
    isFailed = true;
    onFailure(error);
  }

  function enqueue({ audio, sampleRate }) {
    if (!context || isFailed) return false;
    const rate = Number(sampleRate);
    if (rate !== 24_000) {
      clear();
      onFailure(new Error("통역 음성 형식이 올바르지 않습니다. 다음 음성부터 계속 재생합니다."));
      return false;
    }
    let samples;
    try {
      samples = decodePcm16Base64(audio);
    } catch (error) {
      clear();
      onFailure(error instanceof Error ? error : new Error("통역 음성 데이터를 해석할 수 없습니다."));
      return false;
    }
    let hasNonZeroSample = false;
    for (const sample of samples) {
      if (sample === 0) continue;
      hasNonZeroSample = true;
      break;
    }
    if (!hasNonZeroSample) return true;
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const pcmByteLength = samples.length * 2;
    let isQueueIdle = scheduledSources.size === 0;
    const queueAhead = Math.max(0, nextStart - context.currentTime);
    let nextPlaybackRate = isQueueIdle ? 1 : getAdaptivePlaybackRate(queueAhead + buffer.duration, playbackRate);
    const projectedQueueDuration = queueAhead + buffer.duration / nextPlaybackRate;
    if (projectedQueueDuration > maxQueueSeconds || queuedPcmBytes + pcmByteLength > maxQueuePcmBytes) {
      restartQueue(projectedQueueDuration);
      isQueueIdle = true;
      nextPlaybackRate = 1;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = nextPlaybackRate;
    source.connect(gain);
    scheduledSources.add(source);
    sourceByteLengths.set(source, pcmByteLength);
    queuedPcmBytes += pcmByteLength;
    source.addEventListener("ended", () => {
      scheduledSources.delete(source);
      const byteLength = sourceByteLengths.get(source) ?? 0;
      sourceByteLengths.delete(source);
      queuedPcmBytes = Math.max(0, queuedPcmBytes - byteLength);
      source.disconnect();
      if (scheduledSources.size === 0) playbackRate = 1;
    }, { once: true });
    // A bounded one-frame lead absorbs ordinary WebSocket arrival jitter. It
    // is applied only after the queue has fully drained, never between chunks.
    const startAt = isQueueIdle
      ? context.currentTime + STARTUP_LEAD_SECONDS
      : Math.max(context.currentTime, nextStart);
    source.start(startAt);
    playbackRate = nextPlaybackRate;
    nextStart = startAt + buffer.duration / playbackRate;
    suppressInputUntil = Math.max(suppressInputUntil, nextStart + INPUT_SUPPRESSION_TAIL_SECONDS);
    return true;
  }

  function isInputSuppressionActive() {
    return Boolean(context && context.state === "running" && context.currentTime < suppressInputUntil);
  }

  async function close() {
    clear();
    const activeContext = context;
    context = null;
    gain?.disconnect();
    gain = null;
    nextStart = 0;
    if (activeContext) await activeContext.close();
  }

  return {
    clear,
    close,
    enqueue,
    isInputSuppressionActive,
    resume,
    setVolume,
    get isFailed() { return isFailed; },
    get volume() { return volume; },
  };
}
