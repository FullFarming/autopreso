const MIN_SAMPLE_MILLISECONDS = 200;
const MAX_BUFFER_MILLISECONDS = 4_000;
const MIN_PITCH_HERTZ = 70;
const MAX_PITCH_HERTZ = 350;

export function estimateAcousticRange(pcm, { sampleRate = 16_000 } = {}) {
  assertPcm(pcm, sampleRate);
  const samples = toNormalizedSamples(pcm);
  if (samples.length < sampleRate * MIN_SAMPLE_MILLISECONDS / 1_000) return uncertain();
  const windowSamples = Math.round(sampleRate * 40 / 1_000);
  const hopSamples = Math.round(sampleRate * 20 / 1_000);
  const pitches = [];
  let candidateWindows = 0;
  let correlationTotal = 0;

  for (let start = 0; start + windowSamples <= samples.length; start += hopSamples) {
    const window = samples.subarray(start, start + windowSamples);
    const rootMeanSquare = calculateRootMeanSquare(window);
    if (rootMeanSquare < 0.015 || rootMeanSquare > 0.95) continue;
    candidateWindows += 1;
    const pitch = estimateWindowPitch(window, sampleRate);
    if (!pitch) continue;
    pitches.push(pitch.hertz);
    correlationTotal += pitch.correlation;
  }

  if (candidateWindows < 4 || pitches.length < 4 || pitches.length / candidateWindows < 0.35) return uncertain();
  const medianPitch = median(pitches);
  const deviations = pitches.map((pitch) => Math.abs(pitch - medianPitch));
  const relativeDeviation = median(deviations) / medianPitch;
  const meanCorrelation = correlationTotal / pitches.length;
  if (relativeDeviation > 0.18 || meanCorrelation < 0.62) return uncertain();
  const range = medianPitch < 145 ? "low" : medianPitch <= 235 ? "mid" : "high";
  return { range, confidence: Math.min(1, meanCorrelation * (1 - relativeDeviation)) };
}

export class AcousticRangeSession {
  #chunks = [];
  #bufferedBytes = 0;
  #profiles = new Map();

  constructor({ sampleRate = 16_000 } = {}) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("INVALID_PCM_SAMPLE_RATE");
    this.sampleRate = sampleRate;
    this.maxBufferedBytes = sampleRate * 2 * MAX_BUFFER_MILLISECONDS / 1_000;
  }

  get bufferedBytes() {
    return this.#bufferedBytes;
  }

  push(pcm) {
    assertPcm(pcm, this.sampleRate);
    const owned = pcm.slice();
    this.#chunks.push(owned);
    this.#bufferedBytes += owned.byteLength;
    while (this.#bufferedBytes > this.maxBufferedBytes && this.#chunks.length > 1) {
      const discarded = this.#chunks.shift();
      this.#bufferedBytes -= discarded.byteLength;
      discarded.fill(0);
    }
  }

  resolveSpeakerRange(speakerId) {
    const pcm = concatenate(this.#chunks, this.#bufferedBytes);
    this.#clearAudio();
    let result;
    try {
      result = estimateAcousticRange(pcm, { sampleRate: this.sampleRate });
    } finally {
      pcm.fill(0);
    }
    if (result.range === "uncertain") throw new Error("ACOUSTIC_RANGE_UNCERTAIN");
    const profile = this.#profiles.get(speakerId);
    if (!profile) {
      this.#profiles.set(speakerId, { stableRange: result.range, conflictRange: null, conflictCount: 0 });
      return result.range;
    }
    if (profile.stableRange === result.range) {
      profile.conflictRange = null;
      profile.conflictCount = 0;
      return profile.stableRange;
    }
    if (profile.conflictRange === result.range) profile.conflictCount += 1;
    else {
      profile.conflictRange = result.range;
      profile.conflictCount = 1;
    }
    if (profile.conflictCount >= 2) throw new Error("ACOUSTIC_RANGE_CONFLICT");
    return profile.stableRange;
  }

  clear() {
    this.#clearAudio();
    this.#profiles.clear();
  }

  #clearAudio() {
    for (const chunk of this.#chunks) chunk.fill(0);
    this.#chunks = [];
    this.#bufferedBytes = 0;
  }
}

function estimateWindowPitch(window, sampleRate) {
  const mean = window.reduce((sum, sample) => sum + sample, 0) / window.length;
  const centered = Float64Array.from(window, (sample) => sample - mean);
  const minimumLag = Math.floor(sampleRate / MAX_PITCH_HERTZ);
  const maximumLag = Math.min(Math.ceil(sampleRate / MIN_PITCH_HERTZ), centered.length - 2);
  const correlations = [];
  let bestCorrelation = -1;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let numerator = 0;
    let energyA = 0;
    let energyB = 0;
    for (let index = 0; index + lag < centered.length; index += 1) {
      const a = centered[index];
      const b = centered[index + lag];
      numerator += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const correlation = energyA > 0 && energyB > 0 ? numerator / Math.sqrt(energyA * energyB) : 0;
    correlations.push({ lag, correlation });
    bestCorrelation = Math.max(bestCorrelation, correlation);
  }
  if (bestCorrelation < 0.6) return null;
  const selected = correlations.find(({ correlation }) => correlation >= bestCorrelation * 0.97);
  if (!selected) return null;
  return { hertz: sampleRate / selected.lag, correlation: selected.correlation };
}

function calculateRootMeanSquare(samples) {
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / samples.length);
}

function toNormalizedSamples(pcm) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float64Array(pcm.byteLength / 2);
  for (let offset = 0; offset < pcm.byteLength; offset += 2) samples[offset / 2] = view.getInt16(offset, true) / 32_768;
  return samples;
}

function concatenate(chunks, byteLength) {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function uncertain() {
  return { range: "uncertain", confidence: 0 };
}

function assertPcm(pcm, sampleRate) {
  if (!(pcm instanceof Uint8Array) || pcm.byteLength % 2 !== 0) throw new Error("INVALID_PCM16_CHUNK");
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("INVALID_PCM_SAMPLE_RATE");
}
