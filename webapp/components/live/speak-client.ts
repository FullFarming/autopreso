// Participant speaking-floor client: captures the phone mic as 16 kHz mono
// PCM16 frames (40 ms / 1,280 bytes — the gateway HOST audio contract) and
// streams them over the viewer's existing gateway WebSocket.

const LIVE_PCM_FRAME_BYTES = 1_280;
const LIVE_PCM_SAMPLE_RATE = 16_000;
const MAX_FRAME_AGE_MILLISECONDS = 750;

interface WorkletChunkMessage {
  type: "chunk";
  recordedAt: number;
  pcm: ArrayBuffer;
}

export type SpeakCaptureErrorCode =
  | "MIC_PERMISSION_DENIED"
  | "MIC_DEVICE_NOT_FOUND"
  | "MIC_DEVICE_BUSY"
  | "MIC_UNSUPPORTED"
  | "MIC_INSECURE_CONTEXT"
  | "AUDIO_INIT_FAILED";

const CAPTURE_ERROR_MESSAGES: Record<SpeakCaptureErrorCode, string> = {
  MIC_PERMISSION_DENIED: "브라우저의 마이크 권한이 차단되어 있습니다.",
  MIC_DEVICE_NOT_FOUND: "사용할 수 있는 마이크를 찾지 못했습니다.",
  MIC_DEVICE_BUSY: "다른 앱이 마이크를 사용 중입니다. 해당 앱을 닫고 다시 시도해 주세요.",
  MIC_UNSUPPORTED: "이 브라우저에서는 마이크 발언을 지원하지 않습니다.",
  MIC_INSECURE_CONTEXT: "보안 연결(HTTPS)에서만 마이크를 사용할 수 있습니다.",
  AUDIO_INIT_FAILED: "브라우저의 오디오 장치를 시작하지 못했습니다.",
};

export class SpeakCaptureError extends Error {
  readonly code: SpeakCaptureErrorCode;

  constructor(code: SpeakCaptureErrorCode, cause?: unknown) {
    super(CAPTURE_ERROR_MESSAGES[code], { cause });
    this.name = "SpeakCaptureError";
    this.code = code;
  }
}

export interface SpeakSession {
  stop(): Promise<void>;
}

export interface SpeakCaptureOptions {
  /** Normalized 0…1 input energy for the in-button waveform. */
  onLevel?(level: number): void;
}

export interface PreparedSpeakCapture {
  /** Starts frame delivery after the gateway grants the floor. */
  start(socket: WebSocket, options?: SpeakCaptureOptions): Promise<SpeakSession>;
  /** Releases a capture that never received the floor. Idempotent. */
  stop(): Promise<void>;
}

function isWorkletChunk(value: unknown): value is WorkletChunkMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "chunk"
    && typeof message.recordedAt === "number"
    && message.pcm instanceof ArrayBuffer;
}

function getAudioContextConstructor(): typeof AudioContext {
  const standard: unknown = Reflect.get(globalThis, "AudioContext");
  const webkit: unknown = Reflect.get(globalThis, "webkitAudioContext");
  const candidate: unknown = typeof standard === "function" ? standard : webkit;
  if (typeof candidate !== "function") throw new SpeakCaptureError("MIC_UNSUPPORTED");
  return candidate as typeof AudioContext;
}

function closeAudioContextWithoutBlocking(context: AudioContext | null): void {
  if (!context) return;
  try {
    void context.close().catch(() => {
      console.warn("[live-speak] AudioContext close failed");
    });
  } catch {
    console.warn("[live-speak] AudioContext close failed");
  }
}

function classifyCaptureError(error: unknown): SpeakCaptureError {
  if (error instanceof SpeakCaptureError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return new SpeakCaptureError("MIC_PERMISSION_DENIED", error);
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return new SpeakCaptureError("MIC_DEVICE_NOT_FOUND", error);
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return new SpeakCaptureError("MIC_DEVICE_BUSY", error);
  }
  return new SpeakCaptureError("AUDIO_INIT_FAILED", error);
}

function calculatePcmLevel(pcm: ArrayBuffer): number {
  const samples = new Int16Array(pcm);
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = sample / (sample < 0 ? 0x8000 : 0x7fff);
    sumSquares += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(sumSquares / samples.length));
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Cleanup must remain idempotent even after a browser/device teardown.
    }
  }
}

/**
 * Acquires both browser-owned resources during the Speak click. This is the
 * only reliable timing across iOS Safari, Chromium, Firefox and Samsung
 * Internet because a later gateway acknowledgement is no longer a user
 * activation.
 */
export async function prepareSpeakCapture(): Promise<PreparedSpeakCapture> {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (typeof mediaDevices?.getUserMedia !== "function") {
    const isSecure: unknown = Reflect.get(globalThis, "isSecureContext");
    throw new SpeakCaptureError(isSecure === false ? "MIC_INSECURE_CONTEXT" : "MIC_UNSUPPORTED");
  }

  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  try {
    const AudioContextConstructor = getAudioContextConstructor();
    context = new AudioContextConstructor();

    // Both calls are intentionally made before the first await. Moving either
    // one below a gateway/network wait breaks browser user-activation rules.
    let resumePromise: Promise<void>;
    let streamPromise: Promise<MediaStream>;
    try {
      resumePromise = context.resume();
    } catch (error) {
      resumePromise = Promise.reject(error);
    }
    try {
      streamPromise = mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error) {
      streamPromise = Promise.reject(error);
    }
    const [streamResult, resumeResult] = await Promise.allSettled([streamPromise, resumePromise]);
    if (streamResult.status === "fulfilled") stream = streamResult.value;
    if (streamResult.status === "rejected") throw classifyCaptureError(streamResult.reason);
    if (resumeResult.status === "rejected") throw new SpeakCaptureError("AUDIO_INIT_FAILED", resumeResult.reason);
    if (context.state !== "running") throw new SpeakCaptureError("AUDIO_INIT_FAILED");
  } catch (error) {
    if (stream) stopStream(stream);
    closeAudioContextWithoutBlocking(context);
    throw classifyCaptureError(error);
  }
  if (!stream || !context) throw new SpeakCaptureError("AUDIO_INIT_FAILED");
  return buildPreparedCapture(stream, context);
}

function buildPreparedCapture(
  preparedStream: MediaStream,
  preparedContext: AudioContext,
): PreparedSpeakCapture {
  let isStopped = false;
  let isStarted = false;
  let activeStop: (() => void) | null = null;

  const stopPrepared = async () => {
    if (isStopped) return;
    isStopped = true;
    activeStop?.();
    stopStream(preparedStream);
    // Browser-owned AudioContext shutdown is best-effort cleanup. Safari can
    // leave close() pending indefinitely; microphone tracks and the speaking
    // floor must already be released and stop() must still settle immediately.
    closeAudioContextWithoutBlocking(preparedContext);
  };

  return {
    async start(socket, options = {}) {
      if (isStopped || isStarted) throw new SpeakCaptureError("AUDIO_INIT_FAILED");
      isStarted = true;
      let source: MediaStreamAudioSourceNode | null = null;
      let worklet: AudioWorkletNode | null = null;
      let processor: ScriptProcessorNode | null = null;

      const stopNodes = () => {
        options.onLevel?.(0);
        if (worklet) worklet.port.onmessage = null;
        if (processor) processor.onaudioprocess = null;
        try { worklet?.disconnect(); } catch { /* already disconnected */ }
        try { processor?.disconnect(); } catch { /* already disconnected */ }
        try { source?.disconnect(); } catch { /* already disconnected */ }
      };
      activeStop = stopNodes;

      try {
        const handlePcm = (pcm: ArrayBuffer, recordedAt: number) => {
          if (isStopped || socket.readyState !== 1) return;
          if (Date.now() - recordedAt > MAX_FRAME_AGE_MILLISECONDS) return;
          if (pcm.byteLength !== LIVE_PCM_FRAME_BYTES) return;
          options.onLevel?.(calculatePcmLevel(pcm));
          socket.send(pcm);
        };

        if (typeof preparedContext.audioWorklet?.addModule === "function") {
          try {
            await preparedContext.audioWorklet.addModule("/live-audio-worklet.js");
            if (isStopped) throw new Error("CAPTURE_STOPPED");
            const candidate: unknown = Reflect.get(globalThis, "AudioWorkletNode");
            if (typeof candidate !== "function") throw new Error("AUDIO_WORKLET_NODE_UNAVAILABLE");
            const WorkletNodeConstructor = candidate as typeof AudioWorkletNode;
            worklet = new WorkletNodeConstructor(preparedContext, "live-pcm-processor", {
              numberOfInputs: 1,
              numberOfOutputs: 0,
              channelCount: 1,
            });
            worklet.port.onmessage = (event: MessageEvent<unknown>) => {
              if (!isWorkletChunk(event.data)) return;
              handlePcm(event.data.pcm, event.data.recordedAt);
            };
            source = preparedContext.createMediaStreamSource(preparedStream);
            source.connect(worklet);
          } catch {
            worklet?.disconnect();
            worklet = null;
            source?.disconnect();
            source = null;
          }
        }

        if (isStopped) throw new Error("CAPTURE_STOPPED");
        if (!worklet) {
          const createScriptProcessor = preparedContext.createScriptProcessor;
          if (typeof createScriptProcessor !== "function") throw new Error("SCRIPT_PROCESSOR_UNAVAILABLE");
          const frameSamples = LIVE_PCM_FRAME_BYTES / 2;
          processor = createScriptProcessor.call(preparedContext, 4096, 1, 1);
          let queue = new Float32Array(0);
          const sourceRate = preparedContext.sampleRate;
          processor.onaudioprocess = (audioEvent) => {
            if (isStopped || socket.readyState !== 1) return;
            const input = audioEvent.inputBuffer.getChannelData(0);
            const ratio = sourceRate / LIVE_PCM_SAMPLE_RATE;
            const resampled = new Float32Array(Math.floor(input.length / ratio));
            for (let index = 0; index < resampled.length; index += 1) {
              const position = index * ratio;
              const base = Math.floor(position);
              const next = Math.min(base + 1, input.length - 1);
              const fraction = position - base;
              resampled[index] = input[base] * (1 - fraction) + input[next] * fraction;
            }
            const merged = new Float32Array(queue.length + resampled.length);
            merged.set(queue);
            merged.set(resampled, queue.length);
            let offset = 0;
            while (merged.length - offset >= frameSamples) {
              const frame = new Int16Array(frameSamples);
              for (let index = 0; index < frameSamples; index += 1) {
                const sample = Math.max(-1, Math.min(1, merged[offset + index]));
                frame[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
              }
              handlePcm(frame.buffer, Date.now());
              offset += frameSamples;
            }
            queue = merged.slice(offset);
          };
          source = preparedContext.createMediaStreamSource(preparedStream);
          source.connect(processor);
          // ScriptProcessor must reach destination to receive callbacks. It
          // writes silence, so this does not play the microphone back.
          processor.connect(preparedContext.destination);
        }
      } catch (error) {
        await stopPrepared();
        throw new SpeakCaptureError("AUDIO_INIT_FAILED", error);
      }

      return {
        stop: stopPrepared,
      };
    },
    stop: stopPrepared,
  };
}
