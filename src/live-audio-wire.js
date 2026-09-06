const LIVE_AUDIO_MAGIC = 0x4e;
const LIVE_AUDIO_VERSION = 1;
const LIVE_AUDIO_FLAGS = 0;
const LIVE_AUDIO_PCM_BYTES = 1_280;

const LIVE_AUDIO_SOURCE_CODES = Object.freeze({
  system: 1,
  mic: 2,
});

export const LIVE_AUDIO_WIRE_BYTES = 4 + LIVE_AUDIO_PCM_BYTES;

export function encodeLiveAudioWireFrame(source, pcm) {
  const sourceCode = LIVE_AUDIO_SOURCE_CODES[source];
  if (!sourceCode || !Buffer.isBuffer(pcm) || pcm.length !== LIVE_AUDIO_PCM_BYTES) return null;

  const frame = Buffer.allocUnsafe(LIVE_AUDIO_WIRE_BYTES);
  frame[0] = LIVE_AUDIO_MAGIC;
  frame[1] = LIVE_AUDIO_VERSION;
  frame[2] = sourceCode;
  frame[3] = LIVE_AUDIO_FLAGS;
  pcm.copy(frame, 4);
  return frame;
}
