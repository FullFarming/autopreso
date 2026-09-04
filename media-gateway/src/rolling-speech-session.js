import { randomUUID } from "node:crypto";
import { AUDIO_CONFIG, STT_CONFIG } from "./config.js";
import { PcmTimelineRing } from "./pcm-timeline-ring.js";
import { remapRolloverSpeakers } from "./speaker-registry.js";

const FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const CLOSE_TIMEOUT_MILLISECONDS = 5_000;
/** A provider that advertises its own connection limit is rolled this long
 *  before that limit so the replacement is already carrying audio when the
 *  provider would otherwise cut the stream mid-utterance. */
const ROLLOVER_LEAD_MILLISECONDS = 30_000;
/** Never roll faster than this, whatever a provider claims: each roll opens a
 *  second paid connection and drains the old tail in the background. */
const MINIMUM_ROLLOVER_MILLISECONDS = 60_000;

/** Rollover clock for one open stream. Gemini streams advertise no limit and
 *  keep the 540 s `STT_CONFIG.rolloverMilliseconds`; Soniox advertises
 *  `maxConnectionMilliseconds` (290 min) and rolls shortly before it. */
export function resolveRolloverMilliseconds(stream) {
  const limit = stream?.maxConnectionMilliseconds;
  if (!Number.isFinite(limit) || limit <= 0) return STT_CONFIG.rolloverMilliseconds;
  return Math.max(MINIMUM_ROLLOVER_MILLISECONDS, limit - ROLLOVER_LEAD_MILLISECONDS);
}

export class RollingSpeechSession {
  #stream = null;
  #startedAt = 0;
  #rolloverMilliseconds = STT_CONFIG.rolloverMilliseconds;
  #overlapFrames = [];
  #terminalError = null;
  #pcmRing = null;
  #streamAudioOffsetMs = 0;
  #utteranceTasks = new Set();
  #drainingStreams = new Set();
  #retiringStreams = new Set();

  #startPromise = null;
  #closePromise = null;
  #isClosing = false;
  #isClosed = false;
  #pendingOpens = new Set();
  #streamCloseTasks = new WeakMap();
  #streamAdmissions = new WeakMap();
  #writeTail = Promise.resolve();
  #pendingWrites = 0;
  #removeExternalAbort = null;

  constructor({
    provider, onFinalUtterance, onPartialTranscript = null, onPartialTranslation = null, onRemap,
    capturePcmWindows = false, now = Date.now,
    maxPendingUtterances = 64,
  }) {
    this.provider = provider;
    this.onFinalUtterance = onFinalUtterance;
    this.onPartialTranscript = onPartialTranscript;
    this.onPartialTranslation = onPartialTranslation;
    this.onRemap = onRemap;
    this.capturePcmWindows = capturePcmWindows;
    this.now = now;
    if (!Number.isSafeInteger(maxPendingUtterances) || maxPendingUtterances < 1 || maxPendingUtterances > 256) {
      throw new Error("STT_UTTERANCE_BACKPRESSURE_LIMIT_INVALID");
    }
    this.maxPendingUtterances = maxPendingUtterances;
  }

  start({ signal } = {}) {
    if (this.#isClosing || this.#isClosed) return Promise.reject(new Error("STT_STREAM_CLOSED"));
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#startPromise) return this.#startPromise;
    if (signal?.aborted) return Promise.reject(new Error("STT_DRAIN_ABORTED"));
    const abort = () => this.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.#removeExternalAbort = () => signal?.removeEventListener("abort", abort);
    this.#startPromise = (async () => {
      const pcmRing = this.capturePcmWindows ? new PcmTimelineRing({ sampleRate: AUDIO_CONFIG.inputSampleRate }) : null;
      this.#stream = await this.#openStream({
        generation: 0,
        onFinalUtterance: (utterance) => this.#handleFinalUtterance(utterance, pcmRing),
        onPartialTranscript: this.onPartialTranscript,
        onPartialTranslation: this.onPartialTranslation,
      });
      this.#pcmRing = pcmRing;
      this.#streamAudioOffsetMs = 0;
      this.#startedAt = this.now();
      this.#rolloverMilliseconds = resolveRolloverMilliseconds(this.#stream);
    })().catch((error) => { this.#terminalError = error; throw error; });
    return this.#startPromise;
  }

  async #openStream(options) {
    const controller = new AbortController();
    const sourceGeneration = randomUUID();
    // `partialsRetired` flips at swap time, the moment a replacement stream
    // owns the lanes; `isRetired` flips only once close() has resolved. A
    // draining socket may keep emitting for seconds in between, and its
    // partials would otherwise race the new stream's on the same lane (both
    // peek the same coming seq). Its finals stay welcome until the real
    // retire: delivering the tail is the whole reason the drain exists.
    const admission = { isRetired: false, partialsRetired: false };
    this.#pendingOpens.add(controller);
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(this.#terminalError ?? new Error("STT_STREAM_CLOSED"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const connecting = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw this.#terminalError ?? new Error("STT_STREAM_CLOSED");
      return this.provider.open({
        ...options, signal: controller.signal,
        onFinalUtterance: (utterance) => {
          if (!admission.isRetired && !controller.signal.aborted && !this.#isClosed) return options.onFinalUtterance({ ...utterance, sourceGeneration });
        },
        onPartialTranscript: (value) => {
          if (!admission.partialsRetired && !admission.isRetired && !controller.signal.aborted && !this.#isClosing && !this.#isClosed) return options.onPartialTranscript?.(value);
        },
        onPartialTranslation: (value) => {
          if (!admission.partialsRetired && !admission.isRetired && !controller.signal.aborted && !this.#isClosing && !this.#isClosed) return options.onPartialTranslation?.(value);
        },
      });
    }).then(async (stream) => {
      this.#streamAdmissions.set(stream, admission);
      if (controller.signal.aborted || this.#isClosing || this.#isClosed) {
        await this.#closeStreamOnce(stream);
        throw this.#terminalError ?? new Error("STT_STREAM_CLOSED");
      }
      return stream;
    });
    try { return await Promise.race([connecting, aborted]); }
    finally {
      controller.signal.removeEventListener("abort", onAbort);
      this.#pendingOpens.delete(controller);
    }
  }

  sendAudio(frame) {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#isClosing || this.#isClosed || !this.#stream) return Promise.reject(new Error("STT_STREAM_CLOSED"));
    if (!(frame instanceof Uint8Array) || frame.byteLength !== FRAME_BYTES) return Promise.reject(new Error("INVALID_AUDIO_FRAME"));
    if (this.#pendingWrites >= 250) return Promise.reject(new Error("STT_AUDIO_BACKPRESSURE"));
    this.#pendingWrites += 1;
    const ownedFrame = frame.slice();
    const work = this.#writeTail.then(async () => {
      if (this.#terminalError) throw this.#terminalError;
      if (this.#isClosed) throw new Error("STT_STREAM_CLOSED");
      if (!this.#isClosing && this.now() - this.#startedAt >= this.#rolloverMilliseconds) await this.#rollover();
      await this.#stream.sendAudio(ownedFrame);
      this.#pcmRing?.push(ownedFrame, this.#streamAudioOffsetMs);
      this.#streamAudioOffsetMs += AUDIO_CONFIG.chunkMilliseconds;
      this.#overlapFrames.push(ownedFrame.slice());
      const maxFrames = STT_CONFIG.overlapMilliseconds / AUDIO_CONFIG.chunkMilliseconds;
      if (this.#overlapFrames.length > maxFrames) this.#overlapFrames.shift()?.fill(0);
    }).catch((error) => {
      this.#terminalError ??= error instanceof Error ? error : new Error("STT_STREAM_SEND_FAILED");
      this.#stream?.abort?.();
      throw this.#terminalError;
    }).finally(() => { this.#pendingWrites -= 1; ownedFrame.fill(0); });
    this.#writeTail = work.catch(() => undefined);
    return work;
  }

  async #rollover() {
    if (this.#retiringStreams.size >= 1) throw new Error("STT_DRAIN_BACKPRESSURE");
    const previous = this.#stream;
    if (previous.supportsRolloverRemap !== false && typeof previous.getFinalWords !== "function") {
      throw new Error("STT_ROLLOVER_UNSUPPORTED");
    }
    const previousPcmRing = this.#pcmRing;
    const nextPcmRing = this.capturePcmWindows ? new PcmTimelineRing({ sampleRate: AUDIO_CONFIG.inputSampleRate }) : null;
    let nextAudioOffsetMs = 0;
    let isOverlapReplay = true;
    const next = await this.#openStream({
      generation: this.#startedAt,
      onFinalUtterance: (utterance) => {
        // The first two seconds are replayed only to reconnect provider speaker
        // labels. Emitting them would duplicate captions and create false IDs.
        if (isOverlapReplay && Number(utterance.sourceEndOffsetMs) <= STT_CONFIG.overlapMilliseconds + 500) return;
        return this.#handleFinalUtterance(utterance, nextPcmRing);
      },
      // Rollover overlap is replayed audio. Suppressing its interim transcript
      // prevents a duplicate partial from flashing just before the old stream
      // closes; new live audio resumes partials after the replay finishes.
      onPartialTranscript: (value) => {
        if (!isOverlapReplay) return this.onPartialTranscript?.(value);
      },
      onPartialTranslation: (value) => {
        if (!isOverlapReplay) return this.onPartialTranslation?.(value);
      },
    });
    try {
      const shouldRemap = previous.supportsRolloverRemap !== false && next.supportsRolloverRemap !== false;
      if (!shouldRemap) {
        // 2026-08-27 fix: Transcribe has no diarization identity to remap, so
        // replaying the overlap can only duplicate a provider final. Swap the
        // write target first, then let audioStreamEnd drain the old tail.
        isOverlapReplay = false;
        this.#stream = next;
        this.#pcmRing = nextPcmRing;
        this.#streamAudioOffsetMs = 0;
        this.#startedAt = this.now();
        this.#rolloverMilliseconds = resolveRolloverMilliseconds(next);
        this.#clearOverlapFrames();
        this.#retirePartials(previous);
        this.#drainPrevious(previous, previousPcmRing);
        return;
      }
      for (const frame of this.#overlapFrames) {
        await next.sendAudio(frame);
        nextPcmRing?.push(frame, nextAudioOffsetMs);
        nextAudioOffsetMs += AUDIO_CONFIG.chunkMilliseconds;
      }
      isOverlapReplay = false;
      if (typeof next.getFinalWords !== "function") throw new Error("STT_ROLLOVER_UNSUPPORTED");
      const [previousWords, nextWords] = await Promise.all([
        previous.getFinalWords(),
        typeof next.waitForFinalWords === "function" ? next.waitForFinalWords(3_000) : next.getFinalWords(),
      ]);
      const mapping = remapRolloverSpeakers(normalizeOverlap(previousWords, true), normalizeOverlap(nextWords, false));
      this.onRemap(mapping);
      this.#retirePartials(previous);
      await this.#closeStreamOnce(previous);
      previousPcmRing?.clear();
      this.#stream = next;
      this.#pcmRing = nextPcmRing;
      this.#streamAudioOffsetMs = nextAudioOffsetMs;
      this.#startedAt = this.now();
      this.#rolloverMilliseconds = resolveRolloverMilliseconds(next);
    } catch (error) {
      await Promise.allSettled([this.#closeStreamOnce(previous), this.#closeStreamOnce(next)]);
      previousPcmRing?.clear();
      nextPcmRing?.clear();
      this.#terminalError = error instanceof Error ? error : new Error("STT_ROLLOVER_FAILED");
      throw this.#terminalError;
    }
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#isClosing = true;
    for (const controller of this.#pendingOpens) controller.abort();
    this.#closePromise = (async () => {
      let deadline;
      try {
        await Promise.race([(async () => {
          await this.#writeTail;
          const activeClose = this.#stream ? this.#closeStreamOnce(this.#stream) : Promise.resolve();
          const outcomes = await Promise.allSettled([activeClose, ...this.#drainingStreams]);
          const failure = outcomes.find((outcome) => outcome.status === "rejected");
          if (failure) this.#terminalError ??= failure.reason instanceof Error ? failure.reason : new Error("STT_DRAIN_FAILED");
          await Promise.allSettled(this.#utteranceTasks);
        })(), new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("STT_DRAIN_TIMEOUT")), CLOSE_TIMEOUT_MILLISECONDS);
        })]);
      } catch (error) {
        this.#terminalError ??= error instanceof Error ? error : new Error("STT_DRAIN_FAILED");
        // 2026-08-31 fix: A stalled write must not prevent closing its socket.
        // Keep this boundary below the gateway's eight-second shutdown budget.
        this.abort();
        for (const stream of [this.#stream, ...this.#retiringStreams]) {
          if (stream) void this.#closeStreamOnce(stream).catch(() => undefined);
        }
      } finally {
        clearTimeout(deadline);
        this.#removeExternalAbort?.();
        this.#isClosed = true;
        this.#clearOverlapFrames();
        this.#pcmRing?.clear();
      }
    })();
    return this.#closePromise;
  }

  async gracefulDrain() {
    await this.close();
    if (this.#terminalError) throw this.#terminalError;
    this.#stream?.assertDrained?.();
  }

  abort() {
    this.#terminalError ??= new Error("STT_DRAIN_ABORTED");
    this.#isClosing = true;
    this.#removeExternalAbort?.();
    for (const controller of this.#pendingOpens) controller.abort();
    this.#stream?.abort?.();
    for (const stream of this.#retiringStreams) stream.abort?.();
    this.#clearOverlapFrames();
    this.#pcmRing?.clear();
  }

  /** The stream no longer owns the caption lanes: drop its partials from now
   *  on while its finals keep flowing until `#closeStreamOnce` retires it. */
  #retirePartials(stream) {
    const admission = this.#streamAdmissions.get(stream);
    if (admission) admission.partialsRetired = true;
  }

  #closeStreamOnce(stream) {
    let task = this.#streamCloseTasks.get(stream);
    if (!task) {
      task = Promise.resolve().then(() => stream.close())
        .then(() => stream.assertDrained?.())
        .finally(() => {
          const admission = this.#streamAdmissions.get(stream);
          if (admission) admission.isRetired = true;
        });
      this.#streamCloseTasks.set(stream, task);
    }
    return task;
  }

  #drainPrevious(stream, pcmRing) {
    this.#retiringStreams.add(stream);
    const task = this.#closeStreamOnce(stream)
      .catch((error) => {
        this.#terminalError ??= error instanceof Error ? error : new Error("STT_STREAM_DRAIN_FAILED");
        this.#stream?.abort?.();
      })
      .finally(() => { pcmRing?.clear(); this.#drainingStreams.delete(task); this.#retiringStreams.delete(stream); });
    this.#drainingStreams.add(task);
  }

  #handleFinalUtterance(utterance, pcmRing) {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#isClosed) return Promise.resolve();
    if (this.#utteranceTasks.size >= this.maxPendingUtterances) {
      this.#terminalError = new Error("STT_UTTERANCE_BACKPRESSURE");
      this.#stream?.abort?.();
      return Promise.reject(this.#terminalError);
    }
    const pcmWindow = pcmRing?.sliceWindow(utterance.sourceStartOffsetMs, utterance.sourceEndOffsetMs) ?? null;
    const task = Promise.resolve()
      .then(() => {
        if (this.#terminalError || this.#isClosed) return;
        return this.onFinalUtterance({ ...utterance, pcmWindow });
      })
      .catch((error) => {
        this.#terminalError = error instanceof Error ? error : new Error("STT_UTTERANCE_FAILED");
        this.#stream?.abort?.();
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
