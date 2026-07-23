const SILENCE_PEAK = 64;
const TARGET_PEAK = 26_000;
const LIMIT_PEAK = 30_000;

export function conditionPcm16Chunk(bytes, { maxGain = 2 } = {}) {
  assertPcm16(bytes);
  if (!Number.isFinite(maxGain) || maxGain < 1 || maxGain > 2) throw new Error("INVALID_PCM_GAIN");
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let peak = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 2) peak = Math.max(peak, Math.abs(input.getInt16(offset, true)));
  if (peak <= SILENCE_PEAK) return bytes.slice();
  const gain = Math.min(maxGain, TARGET_PEAK / peak);
  const output = new Uint8Array(bytes.byteLength);
  const outputView = new DataView(output.buffer);
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const scaled = Math.round(input.getInt16(offset, true) * gain);
    outputView.setInt16(offset, Math.max(-LIMIT_PEAK, Math.min(LIMIT_PEAK, scaled)), true);
  }
  return output;
}

export class Pcm16StreamConditioner {
  #isFirstChunk = true;
  #lastSample = 0;

  constructor({ sampleRate, fadeMilliseconds = 5, maxGain = 2, preserveGain = false }) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("INVALID_PCM_SAMPLE_RATE");
    if (!Number.isFinite(fadeMilliseconds) || fadeMilliseconds <= 0 || fadeMilliseconds > 10) throw new Error("INVALID_PCM_FADE");
    this.fadeSamples = Math.max(1, Math.round(sampleRate * fadeMilliseconds / 1_000));
    this.maxGain = maxGain;
    this.preserveGain = preserveGain;
  }

  process(bytes) {
    assertPcm16(bytes);
    const output = this.preserveGain ? bytes.slice() : conditionPcm16Chunk(bytes, { maxGain: this.maxGain });
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    if (this.#isFirstChunk) {
      const fadeSamples = Math.min(this.fadeSamples, output.byteLength / 2);
      for (let index = 0; index < fadeSamples; index += 1) {
        const factor = fadeSamples === 1 ? 1 : index / (fadeSamples - 1);
        view.setInt16(index * 2, Math.round(view.getInt16(index * 2, true) * factor), true);
      }
      this.#isFirstChunk = false;
    }
    if (output.byteLength > 0) this.#lastSample = view.getInt16(output.byteLength - 2, true);
    return output;
  }

  finish() {
    if (this.#isFirstChunk || this.#lastSample === 0) return new Uint8Array();
    const output = new Uint8Array(this.fadeSamples * 2);
    const view = new DataView(output.buffer);
    for (let index = 0; index < this.fadeSamples; index += 1) {
      const factor = this.fadeSamples === 1 ? 0 : 1 - index / (this.fadeSamples - 1);
      view.setInt16(index * 2, Math.round(this.#lastSample * factor), true);
    }
    this.#lastSample = 0;
    return output;
  }
}

function assertPcm16(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 2 !== 0) throw new Error("INVALID_PCM16_CHUNK");
}
