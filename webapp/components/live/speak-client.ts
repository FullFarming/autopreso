// Participant speaking-floor client: captures the phone mic as 16 kHz mono
// PCM16 frames (40 ms / 1,280 bytes — the gateway HOST audio contract) and
// streams them over the viewer's existing gateway WebSocket while the
// participant holds the floor. The gateway grants the floor via speak-start
// and revokes it with speak-ended (explicit end, preemption, or errors).

const LIVE_PCM_FRAME_BYTES = 1_280;
const MAX_FRAME_AGE_MILLISECONDS = 750;

interface WorkletChunkMessage {
  type: "chunk";
  recordedAt: number;
  pcm: ArrayBuffer;
}

function isWorkletChunk(value: unknown): value is WorkletChunkMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "chunk"
    && typeof message.recordedAt === "number"
    && message.pcm instanceof ArrayBuffer;
}

export interface SpeakSession {
  stop(): Promise<void>;
}

/** Starts streaming the mic into `socket`. The caller has already received
 *  speak-started; this only owns capture. Stop is idempotent. */
export async function startSpeakCapture(socket: WebSocket): Promise<SpeakSession> {
  let isStopped = false;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    await context.resume();
    await context.audioWorklet.addModule("/live-audio-worklet.js");
    const worklet = new AudioWorkletNode(context, "live-pcm-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    context.createMediaStreamSource(stream).connect(worklet);
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (isStopped || !isWorkletChunk(event.data) || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - event.data.recordedAt > MAX_FRAME_AGE_MILLISECONDS) return;
      if (event.data.pcm.byteLength !== LIVE_PCM_FRAME_BYTES) return;
      socket.send(event.data.pcm);
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    await context?.close().catch(() => undefined);
    throw error;
  }
  return {
    async stop() {
      if (isStopped) return;
      isStopped = true;
      for (const track of stream.getTracks()) track.stop();
      await context?.close().catch(() => undefined);
    },
  };
}
