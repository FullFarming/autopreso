export class PcmTimelineRing {
  #frames = [];
  #bufferedBytes = 0;

  constructor({ sampleRate, maxMilliseconds = 10_000 }) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("INVALID_PCM_SAMPLE_RATE");
    if (!Number.isSafeInteger(maxMilliseconds) || maxMilliseconds <= 0) throw new Error("INVALID_PCM_RING_LIMIT");
    this.sampleRate = sampleRate;
    this.maxMilliseconds = maxMilliseconds;
  }

  get bufferedBytes() {
    return this.#bufferedBytes;
  }

  push(pcm, startOffsetMs) {
    if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new Error("INVALID_PCM16_CHUNK");
    if (!Number.isFinite(startOffsetMs) || startOffsetMs < 0) throw new Error("INVALID_PCM_OFFSET");
    const durationMilliseconds = pcm.byteLength / 2 / this.sampleRate * 1_000;
    const frame = { startOffsetMs, endOffsetMs: startOffsetMs + durationMilliseconds, pcm: pcm.slice() };
    const previous = this.#frames.at(-1);
    if (previous && Math.abs(previous.endOffsetMs - frame.startOffsetMs) > 0.5) throw new Error("PCM_TIMELINE_GAP");
    this.#frames.push(frame);
    this.#bufferedBytes += frame.pcm.byteLength;
    const newestEnd = frame.endOffsetMs;
    while (this.#frames.length > 0 && newestEnd - this.#frames[0].startOffsetMs > this.maxMilliseconds) {
      this.#discardFirst();
    }
  }

  sliceWindow(sourceStartOffsetMs, sourceEndOffsetMs) {
    if (!Number.isFinite(sourceStartOffsetMs)
      || !Number.isFinite(sourceEndOffsetMs)
      || sourceStartOffsetMs < 0
      || sourceEndOffsetMs <= sourceStartOffsetMs
      || this.#frames.length === 0) return null;
    const first = this.#frames[0];
    const last = this.#frames.at(-1);
    if (sourceStartOffsetMs < first.startOffsetMs || sourceEndOffsetMs > last.endOffsetMs + 0.5) return null;
    const all = new Uint8Array(this.#bufferedBytes);
    let offset = 0;
    for (const frame of this.#frames) {
      all.set(frame.pcm, offset);
      offset += frame.pcm.byteLength;
    }
    const startSample = Math.max(0, Math.floor((sourceStartOffsetMs - first.startOffsetMs) * this.sampleRate / 1_000));
    const endSample = Math.min(all.byteLength / 2, Math.ceil((sourceEndOffsetMs - first.startOffsetMs) * this.sampleRate / 1_000));
    const sliced = all.slice(startSample * 2, endSample * 2);
    all.fill(0);
    return sliced.byteLength > 0 ? sliced : null;
  }

  discardThrough(sourceEndOffsetMs) {
    while (this.#frames[0]?.endOffsetMs <= sourceEndOffsetMs + 0.5) this.#discardFirst();
  }

  clear() {
    for (const frame of this.#frames) frame.pcm.fill(0);
    this.#frames = [];
    this.#bufferedBytes = 0;
  }

  #discardFirst() {
    const frame = this.#frames.shift();
    if (!frame) return;
    frame.pcm.fill(0);
    this.#bufferedBytes -= frame.pcm.byteLength;
  }
}
