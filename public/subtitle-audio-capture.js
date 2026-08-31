export const CAPTION_AUDIO_SAMPLE_RATE = 24_000;
export const CAPTION_AUDIO_CHUNK_DURATION_MS = 100;
export const CAPTION_AUDIO_PROCESSOR_BUFFER_SIZE = 1_024;

const CAPTION_AUDIO_CHUNK_SAMPLES = CAPTION_AUDIO_SAMPLE_RATE
  * CAPTION_AUDIO_CHUNK_DURATION_MS / 1_000;

export function getMicrophoneAudioConstraints(deviceId = "") {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

export async function captureMicrophoneStream(
  mediaDevices,
  deviceId = "",
  onFallback = (error) => { void error; },
) {
  if (!deviceId) {
    return mediaDevices.getUserMedia({ audio: getMicrophoneAudioConstraints() });
  }
  try {
    return await mediaDevices.getUserMedia({ audio: getMicrophoneAudioConstraints(deviceId) });
  } catch (error) {
    onFallback(error);
    return mediaDevices.getUserMedia({ audio: getMicrophoneAudioConstraints() });
  }
}

export function createCaptionAudioChunker({ inputSampleRate, source, onChunk }) {
  let carry = new Float32Array(0);
  let pendingSamples = new Float32Array(0);

  return {
    push(input) {
      const resampled = inputSampleRate === CAPTION_AUDIO_SAMPLE_RATE
        ? { samples: input, carry: new Float32Array(0) }
        : resample(input, inputSampleRate, CAPTION_AUDIO_SAMPLE_RATE, carry);
      carry = resampled.carry;
      if (resampled.samples.length === 0) return;
      const availableSamples = new Float32Array(pendingSamples.length + resampled.samples.length);
      availableSamples.set(pendingSamples);
      availableSamples.set(resampled.samples, pendingSamples.length);
      let offset = 0;
      while (availableSamples.length - offset >= CAPTION_AUDIO_CHUNK_SAMPLES) {
        const pcm = pcm16FromFloat32(
          availableSamples.subarray(offset, offset + CAPTION_AUDIO_CHUNK_SAMPLES),
        );
        onChunk({
          source,
          sampleRate: CAPTION_AUDIO_SAMPLE_RATE,
          frameDurationMs: CAPTION_AUDIO_CHUNK_DURATION_MS,
          pcm: pcm.buffer,
        });
        offset += CAPTION_AUDIO_CHUNK_SAMPLES;
      }
      pendingSamples = availableSamples.slice(offset);
    },
    reset() {
      carry = new Float32Array(0);
      pendingSamples = new Float32Array(0);
    },
  };
}

export function pcm16ArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function pcm16FromFloat32(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

function resample(input, fromRate, toRate, carry) {
  const merged = new Float32Array(carry.length + input.length);
  merged.set(carry);
  merged.set(input, carry.length);
  const ratio = fromRate / toRate;
  const outputLength = Math.floor((merged.length - 1) / ratio);
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, merged.length - 1);
    const weight = sourceIndex - left;
    output[index] = merged[left] * (1 - weight) + merged[right] * weight;
  }
  const consumed = Math.floor(outputLength * ratio);
  return { samples: output, carry: merged.slice(consumed) };
}
