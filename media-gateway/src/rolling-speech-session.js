import { AUDIO_CONFIG, STT_CONFIG } from "./config.js";
import { safeProviderErrorIdentifier } from "./caption-polish.js";
import { PcmTimelineRing } from "./pcm-timeline-ring.js";
import { remapRolloverSpeakers } from "./speaker-registry.js";

const FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;

export class RollingSpeechSession {
  #stream = null;
  #startedAt = 0;
  #overlapFrames = [];
  #terminalError = null;
  #pcmRing = null;
  #streamAudioOffsetMs = 0;
  #utteranceTasks = new Set();

  constructor({ provider, onFinalUtterance, onRemap, capturePcmWindows = false, now = Date.now }) {
    this.provider = provider;
    this.onFinalUtterance = onFinalUtterance;
    this.onRemap = onRemap;
    this.capturePcmWindows = capturePcmWindows;
    this.now = now;
  }

  async start() {
    const pcmRing = this.capturePcmWindows ? new PcmTimelineRing({ sampleRate: AUDIO_CONFIG.inputSampleRate }) : null;
    this.#stream = await this.provider.open({ generation: 0, onFinalUtterance: (utterance) => this.#handleFinalUtterance(utterance, pcmRing) });
    this.#pcmRing = pcmRing;
    this.#streamAudioOffsetMs = 0;
    this.#startedAt = this.now();
  }

  async sendAudio(frame) {
    if (this.#terminalError) throw this.#terminalError;
    if (!(frame instanceof Uint8Array) || frame.byteLength !== FRAME_BYTES) throw new Error("INVALID_AUDIO_FRAME");
    if (this.now() - this.#startedAt >= STT_CONFIG.rolloverMilliseconds) await this.#rollover();
    try {
      await this.#stream.sendAudio(frame);
    } catch (error) {
      // A broken provider stream must not end the session: swap in a fresh
      // stream (losing only the in-flight window) and keep audio flowing.
      console.warn("[stt] stream send failed, restarting stream:", safeProviderErrorIdentifier(error, "STT_STREAM_SEND_FAILED"));
      await this.#restart();
      await this.#stream.sendAudio(frame);
    }
    this.#pcmRing?.push(frame, this.#streamAudioOffsetMs);
    this.#streamAudioOffsetMs += AUDIO_CONFIG.chunkMilliseconds;
    this.#overlapFrames.push(frame.slice());
    const maxFrames = STT_CONFIG.overlapMilliseconds / AUDIO_CONFIG.chunkMilliseconds;
    if (this.#overlapFrames.length > maxFrames) this.#overlapFrames.shift()?.fill(0);
  }

  /** Fail-open recovery: open a brand-new stream with no overlap replay and no
   *  speaker remap. Diarization labels may reset (a new "1" can appear), which
   *  is an acceptable cost compared to a session that stops captioning. */
  async #restart() {
    const previous = this.#stream;
    this.#stream = null;
    if (previous) await Promise.allSettled([previous.close()]);
    const pcmRing = this.capturePcmWindows ? new PcmTimelineRing({ sampleRate: AUDIO_CONFIG.inputSampleRate }) : null;
    try {
      const next = await this.provider.open({
        generation: this.now(),
        onFinalUtterance: (utterance) => this.#handleFinalUtterance(utterance, pcmRing),
      });
      this.#pcmRing?.clear();
      this.#pcmRing = pcmRing;
      this.#stream = next;
      this.#streamAudioOffsetMs = 0;
      this.#clearOverlapFrames();
      this.#startedAt = this.now();
    } catch (error) {
      this.#terminalError = error instanceof Error ? error : new Error("STT_RESTART_FAILED");
      throw this.#terminalError;
    }
  }

  async #rollover() {
    if (typeof this.#stream.getFinalWords !== "function") throw new Error("STT_ROLLOVER_UNSUPPORTED");
    const previous = this.#stream;
    const previousPcmRing = this.#pcmRing;
    const nextPcmRing = this.capturePcmWindows ? new PcmTimelineRing({ sampleRate: AUDIO_CONFIG.inputSampleRate }) : null;
    let nextAudioOffsetMs = 0;
    const next = await this.provider.open({
      generation: this.#startedAt,
      onFinalUtterance: (utterance) => {
        // The first two seconds are replayed only to reconnect provider speaker
        // labels. Emitting them would duplicate captions and create false IDs.
        if (Number(utterance.sourceEndOffsetMs) <= STT_CONFIG.overlapMilliseconds + 500) return;
        return this.#handleFinalUtterance(utterance, nextPcmRing);
      },
    });
    try {
      for (const frame of this.#overlapFrames) {
        await next.sendAudio(frame);
        nextPcmRing?.push(frame, nextAudioOffsetMs);
        nextAudioOffsetMs += AUDIO_CONFIG.chunkMilliseconds;
      }
      if (typeof next.getFinalWords !== "function") throw new Error("STT_ROLLOVER_UNSUPPORTED");
      const [previousWords, nextWords] = await Promise.all([
        previous.getFinalWords(),
        typeof next.waitForFinalWords === "function" ? next.waitForFinalWords(3_000) : next.getFinalWords(),
      ]);
      const mapping = remapRolloverSpeakers(normalizeOverlap(previousWords, true), normalizeOverlap(nextWords, false));
      this.onRemap(mapping);
      await previous.close();
      previousPcmRing?.clear();
      this.#stream = next;
      this.#pcmRing = nextPcmRing;
      this.#streamAudioOffsetMs = nextAudioOffsetMs;
      this.#startedAt = this.now();
    } catch (error) {
      // Rollover remap needs final words inside the overlap window; a silent
      // room makes that impossible (STT_ROLLOVER_WORDS_UNAVAILABLE). That is a
      // normal condition, not a fault — restart fresh instead of poisoning
      // every future frame.
      console.warn("[stt] rollover failed, restarting stream:", safeProviderErrorIdentifier(error, "STT_ROLLOVER_FAILED"));
      await Promise.allSettled([previous.close(), next.close()]);
      previousPcmRing?.clear();
      nextPcmRing?.clear();
      this.#stream = null;
      await this.#restart();
    }
  }

  async close() {
    if (this.#stream) await this.#stream.close();
    await Promise.allSettled(this.#utteranceTasks);
    this.#clearOverlapFrames();
    this.#pcmRing?.clear();
  }

  #handleFinalUtterance(utterance, pcmRing) {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    const pcmWindow = pcmRing?.sliceWindow(utterance.sourceStartOffsetMs, utterance.sourceEndOffsetMs) ?? null;
    const task = Promise.resolve()
      .then(() => this.onFinalUtterance({ ...utterance, pcmWindow }))
      .catch((error) => {
        this.#terminalError = error instanceof Error ? error : new Error("STT_UTTERANCE_FAILED");
      })
      .finally(() => {
        pcmWindow?.fill(0);
        pcmRing?.discardThrough(utterance.sourceEndOffsetMs);
        this.#utteranceTasks.delete(task);
      });
    this.#utteranceTasks.add(task);
    return Promise.resolve();
  }

  #clearOverlapFrames() {
    for (const frame of this.#overlapFrames) frame.fill(0);
    this.#overlapFrames = [];
  }
}

function normalizeOverlap(words, fromEnd) {
  if (words.length === 0) return [];
  const maxEnd = Math.max(...words.map((word) => word.endMs));
  const window = fromEnd
    ? words.filter((word) => word.endMs >= maxEnd - STT_CONFIG.overlapMilliseconds)
    : words.filter((word) => word.startMs <= STT_CONFIG.overlapMilliseconds + 500);
  if (window.length === 0) return [];
  const base = Math.min(...window.map((word) => word.startMs));
  return window.map((word) => ({ ...word, startMs: word.startMs - base, endMs: word.endMs - base }));
}
