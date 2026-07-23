// Browser audio capture pipeline: getUserMedia / getDisplayMedia →
// Web Audio downmix to mono → fixed-ratio linear resample → PCM16 LE base64
// chunks. The capture rate is 24 kHz (OpenAI realtime); the Gemini transport
// continuously resamples and packetizes exact 100ms frames (see geminiChannel.ts).

export const OPENAI_SAMPLE_RATE = 24000;
export const GEMINI_SAMPLE_RATE = 16000;

/**
 * Linear-interpolation resampler for base64 PCM16 mono audio.
 * Ported from autopreso/src/gemini-live-translate.js resamplePcm16Base64,
 * using DataView instead of Node Buffer.
 *
 * Fixed rate-ratio stepping (not endpoint-aligned): streamed chunks must
 * keep a constant phase across chunk boundaries or the audio drifts.
 */
export function resamplePcm16Base64(base64: string, fromRate: number, toRate: number): string {
  if (fromRate === toRate) return base64;
  const input = base64ToBytes(base64);
  const inputSamples = Math.floor(input.byteLength / 2);
  if (inputSamples === 0) return base64;
  const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outputSamples = Math.max(1, Math.floor((inputSamples * toRate) / fromRate));
  const output = new DataView(new ArrayBuffer(outputSamples * 2));
  const step = fromRate / toRate;
  for (let i = 0; i < outputSamples; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    const fraction = position - index;
    const current = inputView.getInt16(index * 2, true);
    const next = index + 1 < inputSamples ? inputView.getInt16((index + 1) * 2, true) : current;
    output.setInt16(i * 2, Math.round(current + (next - current) * fraction), true);
  }
  return bytesToBase64(new Uint8Array(output.buffer));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function createStreamingPcm16Resampler(fromRate: number, toRate: number) {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error("PCM_SAMPLE_RATE_INVALID");
  }
  const step = fromRate / toRate;
  let pending = new Int16Array(0);
  let sourcePosition = 0;
  return {
    push(base64: string): Uint8Array {
      const bytes = base64ToBytes(base64);
      const sampleCount = Math.floor(bytes.byteLength / 2);
      if (sampleCount === 0) return new Uint8Array(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
      const incoming = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) incoming[index] = view.getInt16(index * 2, true);
      const combined = new Int16Array(pending.length + incoming.length);
      combined.set(pending);
      combined.set(incoming, pending.length);
      const output: number[] = [];
      while (sourcePosition < combined.length - 1) {
        const index = Math.floor(sourcePosition);
        const fraction = sourcePosition - index;
        const current = combined[index];
        const next = combined[index + 1];
        output.push(Math.round(current + (next - current) * fraction));
        sourcePosition += step;
      }
      const consumed = Math.min(combined.length, Math.floor(sourcePosition));
      pending = combined.slice(consumed);
      sourcePosition -= consumed;
      const result = new DataView(new ArrayBuffer(output.length * 2));
      for (let index = 0; index < output.length; index += 1) result.setInt16(index * 2, output[index], true);
      return new Uint8Array(result.buffer);
    },
    reset() {
      pending = new Int16Array(0);
      sourcePosition = 0;
    },
  };
}

/** Fixed-ratio linear resampler for Float32 sample chunks. */
function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const inputSamples = input.length;
  if (inputSamples === 0) return input;
  const outputSamples = Math.max(1, Math.floor((inputSamples * toRate) / fromRate));
  const output = new Float32Array(outputSamples);
  const step = fromRate / toRate;
  for (let i = 0; i < outputSamples; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    const fraction = position - index;
    const current = input[index] ?? 0;
    const next = index + 1 < inputSamples ? input[index + 1] : current;
    output[i] = current + (next - current) * fraction;
  }
  return output;
}

function floatToPcm16Base64(samples: Float32Array): string {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytesToBase64(new Uint8Array(view.buffer));
}

export interface AudioCapture {
  stop(): void;
}

/**
 * Captures a MediaStream's audio, downmixes to mono, resamples to
 * `targetSampleRate`, and emits ~100ms base64 PCM16 LE chunks.
 */
// Conservative client-side voice gate. Cuts realtime audio-input cost by not
// streaming dead air, WITHOUT clipping words:
//   - OPEN at a low RMS threshold so even soft speech opens the gate
//   - flush a pre-roll of the most recent chunks so the onset is never lost
//   - after level drops, keep streaming a tail so the server VAD still sees the
//     trailing silence and fires speech_stopped (utterance boundary preserved)
const GATE_OPEN_LEVEL = 0.045;   // on the onLevel 0..1 scale (sqrt(rms)*4)
const GATE_CLOSE_LEVEL = 0.03;   // hysteresis to avoid flapping
const GATE_TAIL_MS = 1000;       // keep sending after speech so VAD finalizes
const PREROLL_CHUNKS = 3;        // ~270ms of lead-in flushed on open

export function createPcmCapture({
  stream,
  targetSampleRate = OPENAI_SAMPLE_RATE,
  onChunk,
  onLevel,
  silenceGate = true,
}: {
  stream: MediaStream;
  targetSampleRate?: number;
  onChunk: (base64Pcm16: string) => void;
  onLevel?: (value: number) => void;
  /** Skip sending near-silent audio (cost saver). Default on. */
  silenceGate?: boolean;
}): AudioCapture {
  const AudioContextCtor: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  const context = new AudioContextCtor();
  const sourceNode = context.createMediaStreamSource(stream);
  // Capture cadence remains independent of provider packet size. Gemini's
  // provider boundary assembles these callbacks into exact 100ms frames.
  const processor = context.createScriptProcessor(4096, 1, 1);

  let stopped = false;
  let gateOpen = false;
  let belowSinceMs = 0;
  const preroll: string[] = [];

  let clockMs = 0; // monotonic ms derived from chunk durations (no Date.now)
  processor.onaudioprocess = (event) => {
    if (stopped) return; // a queued event can fire after disconnect
    const inputBuffer = event.inputBuffer;
    const channelCount = inputBuffer.numberOfChannels;
    const frameCount = inputBuffer.length;
    let mono: Float32Array;
    if (channelCount <= 1) {
      mono = inputBuffer.getChannelData(0).slice();
    } else {
      mono = new Float32Array(frameCount);
      for (let c = 0; c < channelCount; c += 1) {
        const data = inputBuffer.getChannelData(c);
        for (let i = 0; i < frameCount; i += 1) mono[i] += data[i];
      }
      for (let i = 0; i < frameCount; i += 1) mono[i] /= channelCount;
    }
    const resampled = resampleFloat32(mono, context.sampleRate, targetSampleRate);
    let sum = 0;
    for (let i = 0; i < mono.length; i += 4) sum += mono[i] * mono[i];
    const level = Math.min(1, Math.sqrt(sum / Math.max(1, mono.length / 4)) * 4);
    if (onLevel) onLevel(level);

    const base64 = floatToPcm16Base64(resampled);

    if (!silenceGate) {
      onChunk(base64);
      return;
    }

    const chunkMs = (frameCount / context.sampleRate) * 1000;
    clockMs += chunkMs;

    if (level >= GATE_OPEN_LEVEL) {
      if (!gateOpen) {
        gateOpen = true;
        for (const lead of preroll) onChunk(lead); // never clip the onset
        preroll.length = 0;
      }
      belowSinceMs = 0;
      onChunk(base64);
      return;
    }

    // Below the open threshold.
    if (gateOpen) {
      if (level < GATE_CLOSE_LEVEL) {
        if (belowSinceMs === 0) belowSinceMs = clockMs;
        if (clockMs - belowSinceMs >= GATE_TAIL_MS) {
          gateOpen = false; // stop sending dead air until speech resumes
          belowSinceMs = 0;
          return;
        }
      } else {
        belowSinceMs = 0; // still in the soft-speech band — keep open
      }
      onChunk(base64); // tail: let the server VAD see trailing silence
      return;
    }

    // Gate closed: buffer a rolling pre-roll so the next onset isn't clipped.
    preroll.push(base64);
    if (preroll.length > PREROLL_CHUNKS) preroll.shift();
  };

  sourceNode.connect(processor);
  // ScriptProcessor only fires when connected to the graph output; a zero-gain
  // sink keeps the captured audio inaudible (avoids echo of tab audio).
  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  processor.connect(silentGain);
  silentGain.connect(context.destination);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { processor.disconnect(); } catch { /* noop */ }
      try { sourceNode.disconnect(); } catch { /* noop */ }
      try { silentGain.disconnect(); } catch { /* noop */ }
      void context.close().catch(() => undefined);
    },
  };
}

export async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

/**
 * Tab/screen audio via getDisplayMedia. Video must be requested for the
 * picker to appear; the video track is stopped immediately, keeping audio.
 * Throws if the chosen surface carries no audio track.
 */
export async function getTabAudioStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  } as any);
  for (const track of stream.getVideoTracks()) track.stop();
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(
      "선택한 화면에 오디오가 없습니다. 탭 공유 시 '탭 오디오 공유' 체크박스를 켜 주세요.",
    );
  }
  return new MediaStream(audioTracks);
}

export function stopStream(stream: MediaStream | null | undefined) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* noop */ }
  }
}
