import { AUDIO_CONFIG } from '../config.js';
import { RollingSpeechSession } from '../rolling-speech-session.js';
import { SonioxRealtimeAdapter } from './soniox-realtime-adapter.js';

const DEFAULT_ALIGNMENT_TOLERANCE_MS = 250;
const DEFAULT_ALIGNMENT_HOLD_MS = 3_000;
const DEFAULT_LANE_REOPEN_BACKOFF_MS = 1_000;
const MAX_LANE_REOPEN_BACKOFF_MS = 8_000;
const DEFAULT_MAX_LANE_REOPEN_ATTEMPTS = 3;
/** Lanes roll this far apart so three Soniox connections (six with the
 *  desktop's mic + system pair) never renew at the same instant. */
const LANE_ROLLOVER_STAGGER_MS = 60_000;
const TEXT_SIMILARITY_THRESHOLD = 0.8;

// Independent recognition diverges in punctuation, spacing and segment
// boundaries far more often than in words. Time range is therefore the primary
// key and normalized text only decides whether an overlapping candidate really
// is the same speech.
function normalizeText(text) {
  return String(text ?? '').normalize('NFC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function bigrams(text) {
  const set = new Map();
  if (text.length < 2) { if (text) set.set(text, 1); return set; }
  for (let index = 0; index < text.length - 1; index++) {
    const gram = text.slice(index, index + 2);
    set.set(gram, (set.get(gram) ?? 0) + 1);
  }
  return set;
}

export function textSimilarity(left, right) {
  const a = normalizeText(left); const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.max(TEXT_SIMILARITY_THRESHOLD, Math.min(a.length, b.length) / Math.max(a.length, b.length));
  const left2 = bigrams(a); const right2 = bigrams(b);
  let shared = 0; let total = 0;
  for (const [gram, count] of left2) { total += count; shared += Math.min(count, right2.get(gram) ?? 0); }
  for (const count of right2.values()) total += count;
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * Finds the contiguous run of `queue` parts that carries `source`'s speech.
 * Returns `{ start, count }` on a match, `null` when the lane has already
 * covered the source's time range without matching (resolved: nothing more
 * will come), and `undefined` while the lane has not yet produced anything
 * reaching the end of the source (still pending).
 */
export function findAlignedRange(source, queue, toleranceMs = DEFAULT_ALIGNMENT_TOLERANCE_MS) {
  const sourceStart = source.sourceStartOffsetMs; const sourceEnd = source.sourceEndOffsetMs;
  const duration = Math.max(1, sourceEnd - sourceStart);
  let best = null;
  let covered = false;
  for (let start = 0; start < queue.length; start++) {
    const first = queue[start];
    if (first.sourceEndOffsetMs >= sourceEnd - toleranceMs) covered = true;
    if (first.sourceLanguage !== source.sourceLanguage) continue;
    if (first.sourceEndOffsetMs <= sourceStart || first.sourceStartOffsetMs >= sourceEnd) continue;
    const texts = []; let rangeEnd = first.sourceStartOffsetMs;
    for (let end = start; end < queue.length; end++) {
      const part = queue[end];
      if (part.sourceLanguage !== source.sourceLanguage) break;
      if (end > start && part.sourceStartOffsetMs >= sourceEnd - toleranceMs) break;
      texts.push(part.text);
      rangeEnd = Math.max(rangeEnd, part.sourceEndOffsetMs);
      const overlap = Math.min(rangeEnd, sourceEnd) - Math.max(first.sourceStartOffsetMs, sourceStart);
      if (overlap < duration / 2) continue;
      const score = Math.max(textSimilarity(source.text, texts.join(' ')), textSimilarity(source.text, texts.join('')));
      if (score >= TEXT_SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { start, count: end - start + 1, score };
      if (rangeEnd >= sourceEnd - toleranceMs) break;
    }
  }
  if (best) return { start: best.start, count: best.count };
  return covered ? null : undefined;
}

export class SonioxFanoutAdapter {
  constructor({
    translationLanguages, createAdapter = options => new SonioxRealtimeAdapter(options),
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    alignmentToleranceMs = DEFAULT_ALIGNMENT_TOLERANCE_MS, alignmentHoldMs = DEFAULT_ALIGNMENT_HOLD_MS,
    laneReopenBackoffMs = DEFAULT_LANE_REOPEN_BACKOFF_MS, maxLaneReopenAttempts = DEFAULT_MAX_LANE_REOPEN_ATTEMPTS,
    ...options
  }) {
    if (!Array.isArray(translationLanguages) || translationLanguages.length !== 3 || new Set(translationLanguages).size !== 3) throw new Error('SONIOX_LANGUAGES_INVALID');
    this.provider = 'soniox';
    this.languages = [...translationLanguages];
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.alignmentToleranceMs = alignmentToleranceMs; this.alignmentHoldMs = alignmentHoldMs;
    this.laneReopenBackoffMs = laneReopenBackoffMs; this.maxLaneReopenAttempts = maxLaneReopenAttempts;
    this.adapters = this.languages.map(targetLanguage => createAdapter({ ...options, translation: true, translationLanguages, targetLanguage }));
  }

  async open({ onFinalUtterance, onPartialTranscript, onPartialTranslation, onConnectionState = (_state) => {}, signal, ...options }) {
    const { languages, now, setTimer, clearTimer, alignmentToleranceMs, alignmentHoldMs } = this;
    const laneCount = languages.length;
    const pending = languages.map(() => []);
    const streams = [];
    const failedLanes = new Set();
    /** Lanes whose RSS died and are waiting for (or in) a reopen. */
    const recoveringLanes = new Set();
    const reopenAttempts = languages.map(() => 0);
    const reopenTimers = languages.map(() => null);
    const droppedFrames = languages.map(() => 0);
    /** Session-clock milliseconds at which each lane's current RSS started
     *  counting from zero; reopened lanes are shifted back onto lane 0's clock. */
    const laneOffsetBaseMs = languages.map(() => 0);
    const deferredPartials = languages.map(() => null);
    const sourceDeadlines = new WeakMap();
    let sentMilliseconds = 0;
    let isClosed = false;
    let terminalError = null;
    let timer = null;
    let callbackTail = Promise.resolve();
    const fail = error => {
      terminalError ??= error;
      clearTimer(timer); timer = null;
      for (const reopenTimer of reopenTimers) if (reopenTimer) clearTimer(reopenTimer);
      for (const stream of streams) stream?.abort?.();
    };
    const laneIsLive = index => !failedLanes.has(index) && !recoveringLanes.has(index);

    const releaseDeferredPartials = () => {
      for (let index = 1; index < laneCount; index++) {
        const partial = deferredPartials[index];
        if (!partial) continue;
        deferredPartials[index] = null;
        if (!isClosed && !terminalError) onPartialTranslation?.(partial);
      }
    };
    const flush = (force = false) => {
      while (pending[0].length) {
        const source = pending[0][0];
        const matches = pending.map((queue, index) => {
          if (index === 0) return { start: 0, count: 1 };
          if (!laneIsLive(index)) return null;
          return findAlignedRange(source, queue, alignmentToleranceMs);
        });
        // `undefined` = that lane may still answer; `null` = resolved missing.
        // Dead or recovering lanes never hold a final: their translation is
        // missing and the pipeline's COMBINED_TRANSLATION_MISSING path shows
        // the source instead.
        if (matches.some(match => match === undefined) && !force && now() < sourceDeadlines.get(source)) break;
        pending[0].shift();
        const translations = { ...source.translations };
        for (let index = 1; index < laneCount; index++) {
          const match = matches[index];
          if (!match) continue;
          const segments = pending[index].splice(match.start, match.count);
          const language = languages[index];
          const texts = segments.map(segment => segment.sourceLanguage === language ? segment.text : segment.translations?.[language]?.text);
          if (texts.every(text => typeof text === 'string' && text.trim())) translations[language] = { text: texts.join(' ') };
        }
        for (let index = 1; index < laneCount; index++) {
          pending[index] = pending[index].filter(value => value.sourceEndOffsetMs > source.sourceEndOffsetMs + alignmentToleranceMs);
        }
        callbackTail = callbackTail.then(() => { if (!isClosed && !terminalError) return onFinalUtterance({ ...source, translations }); }).catch(fail);
      }
      if (!pending[0].length) { clearTimer(timer); timer = null; releaseDeferredPartials(); }
      if (pending[0].length && timer === null && !isClosed && !terminalError) {
        timer = setTimer(() => { timer = null; flush(); }, Math.max(1, sourceDeadlines.get(pending[0][0]) - now()));
        timer?.unref?.();
      }
      return callbackTail;
    };

    const handlePartialTranslation = (index, value) => {
      if (isClosed || terminalError) return;
      // While lane 0's final is held for alignment and this lane has already
      // finalized its own copy of that speech, an interim for a newer segment
      // would flash over the held caption (it peeks the same coming seq).
      // Keep the latest one and release it with the final.
      const queued = pending[index];
      const heldElsewhere = pending[0].length > 0 && queued.length > 0
        && typeof value?.segmentId === 'string' && !queued.some(segment => segment.segmentId === value.segmentId);
      if (heldElsewhere) { deferredPartials[index] = value; return; }
      deferredPartials[index] = null;
      return onPartialTranslation?.(value);
    };

    const createLaneStream = index => new RollingSpeechSession({
      provider: { open: input => this.adapters[index].open({ ...options, ...input,
        onContinuityDiscard: index === 0 ? options.onContinuityDiscard : () => onConnectionState({
          status: "failed", code: "SONIOX_TRANSLATION_INTERRUPTED", language: languages[index],
        }),
      }) },
      now, setTimer, clearTimer,
      rolloverOffsetMilliseconds: index * LANE_ROLLOVER_STAGGER_MS,
      onRemap() {},
      onConnectionState: state => onConnectionState({ ...state, language: languages[index] }),
      onPartialTranscript: index === 0 ? onPartialTranscript : null,
      onPartialTranslation: value => handlePartialTranslation(index, value),
      onFinalUtterance: value => {
        if (isClosed || terminalError) return;
        if (pending[index].length >= 64) {
          if (index === 0) fail(new Error('STT_UTTERANCE_BACKPRESSURE'));
          else laneFailed(index, new Error('STT_UTTERANCE_BACKPRESSURE'));
          return;
        }
        const base = laneOffsetBaseMs[index];
        const accepted = { ...value,
          sourceStartOffsetMs: base + value.sourceSessionStartOffsetMs,
          sourceEndOffsetMs: base + value.sourceSessionEndOffsetMs,
        };
        if (index === 0) sourceDeadlines.set(accepted, now() + alignmentHoldMs);
        pending[index].push(accepted);
        return flush();
      },
    });

    const markLaneFailed = index => {
      recoveringLanes.delete(index);
      failedLanes.add(index);
      pending[index] = [];
      deferredPartials[index] = null;
      streams[index]?.abort?.();
      onConnectionState({ status: "failed", code: "SONIOX_TRANSLATION_UNAVAILABLE", language: languages[index] });
      void flush();
    };
    /** A secondary lane's RSS is terminal. Reopen it with capped backoff; only
     *  `maxLaneReopenAttempts` consecutive failures abandon the lane. */
    const laneFailed = (index, _error) => {
      if (isClosed || terminalError || failedLanes.has(index) || recoveringLanes.has(index)) return;
      streams[index]?.abort?.();
      pending[index] = [];
      deferredPartials[index] = null;
      reopenAttempts[index] += 1;
      if (reopenAttempts[index] >= this.maxLaneReopenAttempts) { markLaneFailed(index); return; }
      recoveringLanes.add(index);
      onConnectionState({ status: "connecting", code: "SONIOX_TRANSLATION_RECOVERING", language: languages[index] });
      void flush();
      const backoff = Math.min(MAX_LANE_REOPEN_BACKOFF_MS, this.laneReopenBackoffMs * 2 ** (reopenAttempts[index] - 1));
      reopenTimers[index] = setTimer(() => {
        reopenTimers[index] = null;
        if (isClosed || terminalError) return;
        const stream = createLaneStream(index);
        void stream.start({ signal }).then(() => {
          if (isClosed || terminalError) { stream.abort(); return; }
          streams[index] = stream;
          laneOffsetBaseMs[index] = sentMilliseconds;
          recoveringLanes.delete(index);
          onConnectionState({ status: "ready", language: languages[index] });
        }, () => {
          recoveringLanes.delete(index);
          if (isClosed || terminalError) return;
          laneFailed(index);
        });
      }, backoff);
      reopenTimers[index]?.unref?.();
    };

    const outcomes = await Promise.allSettled(languages.map(async (_language, index) => {
      const stream = createLaneStream(index);
      streams[index] = stream;
      await stream.start({ signal });
      return stream;
    }));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) {
      await Promise.allSettled(streams.filter(Boolean).map(stream => { stream.abort?.(); return stream.close(); }));
      throw failure.reason;
    }
    return {
      supportsRolloverRemap: false,
      managesOwnRollover: true,
      get droppedFrames() { return [...droppedFrames]; },
      async sendAudio(frame) {
        if (isClosed) throw new Error('STT_STREAM_CLOSED');
        if (terminalError) throw terminalError;
        const results = await Promise.allSettled(streams.map((stream, index) => laneIsLive(index) ? stream.sendAudio(frame) : undefined));
        sentMilliseconds += AUDIO_CONFIG.chunkMilliseconds;
        for (let index = 0; index < results.length; index++) {
          const result = results[index];
          if (result.status !== 'rejected') { if (index > 0 && laneIsLive(index)) reopenAttempts[index] = 0; continue; }
          if (index === 0) throw result.reason;
          if (!laneIsLive(index)) continue;
          if (result.reason?.message === 'STT_AUDIO_BACKPRESSURE') { droppedFrames[index] += 1; continue; }
          droppedFrames[index] += 1;
          laneFailed(index, result.reason);
        }
      },
      assertDrained() { if (terminalError) throw terminalError; },
      abort() {
        isClosed = true; clearTimer(timer); timer = null;
        for (const reopenTimer of reopenTimers) if (reopenTimer) clearTimer(reopenTimer);
        for (const stream of streams) stream?.abort?.();
      },
      async close() {
        for (let index = 0; index < reopenTimers.length; index++) { if (reopenTimers[index]) clearTimer(reopenTimers[index]); reopenTimers[index] = null; }
        const outcomes = await Promise.allSettled(streams.map((stream, index) => failedLanes.has(index) || recoveringLanes.has(index) ? stream.close().catch(() => undefined) : stream.close()));
        await flush(true); await callbackTail; isClosed = true; clearTimer(timer); timer = null;
        const failure = outcomes.find(outcome => outcome.status === 'rejected');
        if (failure) throw failure.reason;
      },
    };
  }
}
