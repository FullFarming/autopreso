import { RollingSpeechSession } from '../rolling-speech-session.js';
import { SonioxRealtimeAdapter } from './soniox-realtime-adapter.js';

// Independent recognition can diverge. Only matching source text AND acoustic
// bounds may contribute a translation to the authoritative source record.
function findAlignedRange(source, queue) {
  const sourceText = source.text.normalize('NFC').trim();
  for (let start = 0; start < queue.length; start++) {
    if (Math.abs(source.sourceStartOffsetMs - queue[start].sourceStartOffsetMs) > 80) continue;
    const parts = [];
    for (let end = start; end < queue.length; end++) {
      const part = queue[end];
      if (part.sourceLanguage !== source.sourceLanguage || part.sourceEndOffsetMs > source.sourceEndOffsetMs + 80) break;
      parts.push(part.text.normalize('NFC').trim());
      if (Math.abs(source.sourceEndOffsetMs - part.sourceEndOffsetMs) <= 80
        && [parts.join(' '), parts.join('')].includes(sourceText)) return { start, count: end - start + 1 };
    }
  }
  return null;
}

export class SonioxFanoutAdapter {
  constructor({ translationLanguages, createAdapter = options => new SonioxRealtimeAdapter(options), ...options }) {
    if (!Array.isArray(translationLanguages) || translationLanguages.length !== 3 || new Set(translationLanguages).size !== 3) throw new Error('SONIOX_LANGUAGES_INVALID');
    this.provider = 'soniox';
    this.languages = [...translationLanguages];
    this.adapters = this.languages.map(targetLanguage => createAdapter({ ...options, translation: true, translationLanguages, targetLanguage }));
  }

  async open({ onFinalUtterance, onPartialTranscript, onPartialTranslation, onConnectionState = (_state) => {}, signal, ...options }) {
    const languages = this.languages;
    const pending = this.languages.map(() => []);
    const streams = [];
    const failedLanes = new Set();
    const sourceDeadlines = new WeakMap();
    let isClosed = false;
    let terminalError = null;
    let timer = null;
    let callbackTail = Promise.resolve();
    const fail = error => {
      terminalError ??= error;
      clearTimeout(timer);
      for (const stream of streams) stream?.abort?.();
    };
    const flush = (allowMissing = false, force = false) => {
      while (pending[0].length) {
        const source = pending[0][0];
        const matches = pending.map((queue, index) => index === 0 ? { start: 0, count: 1 } : findAlignedRange(source, queue));
        if (matches.some(match => match === null)
          && (!allowMissing || (!force && Date.now() < sourceDeadlines.get(source)))) break;
        pending[0].shift();
        const translations = { ...source.translations };
        for (let index = 1; index < pending.length; index++) {
          const match = matches[index];
          if (match === null) continue;
          const segments = pending[index].splice(match.start, match.count);
          const language = this.languages[index];
          const texts = segments.map(segment => segment.sourceLanguage === language ? segment.text : segment.translations?.[language]?.text);
          if (texts.every(text => typeof text === 'string' && text.trim())) translations[language] = { text: texts.join(' ') };
        }
        for (let index = 1; index < pending.length; index++) {
          pending[index] = pending[index].filter(value => value.sourceEndOffsetMs > source.sourceEndOffsetMs + 80);
        }
        callbackTail = callbackTail.then(() => { if (!isClosed && !terminalError) return onFinalUtterance({ ...source, translations }); }).catch(fail);
      }
      if (!pending[0].length) { clearTimeout(timer); timer = null; }
      if (pending[0].length && timer === null) {
        // Missing/misaligned lanes reach the pipeline's explicit
        // COMBINED_TRANSLATION_MISSING path; another source is never substituted.
        timer = setTimeout(() => { timer = null; flush(true); }, Math.max(1, sourceDeadlines.get(pending[0][0]) - Date.now()));
        timer.unref?.();
      }
      return callbackTail;
    };
    const outcomes = await Promise.allSettled(this.adapters.map(async (adapter, index) => {
      const stream = new RollingSpeechSession({
        provider: { open: input => adapter.open({ ...options, ...input,
          onContinuityDiscard: index === 0 ? options.onContinuityDiscard : () => onConnectionState({
            status: "failed", code: "SONIOX_TRANSLATION_INTERRUPTED", language: languages[index],
          }),
        }) },
        onRemap() {},
        onConnectionState: state => onConnectionState({ ...state, language: this.languages[index] }),
        onPartialTranscript: index === 0 ? onPartialTranscript : null,
        onPartialTranslation: value => onPartialTranslation?.(value),
        onFinalUtterance: value => {
          if (isClosed || terminalError) return;
          if (pending[index].length >= 64) {
            if (index === 0) fail(new Error('STT_UTTERANCE_BACKPRESSURE'));
            else { failedLanes.add(index); streams[index]?.abort(); }
            return;
          }
          const accepted = { ...value,
            sourceStartOffsetMs: value.sourceSessionStartOffsetMs,
            sourceEndOffsetMs: value.sourceSessionEndOffsetMs,
          };
          if (index === 0) sourceDeadlines.set(accepted, Date.now() + 3_000);
          pending[index].push(accepted);
          return flush();
        },
      });
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
      async sendAudio(frame) {
        if (isClosed) throw new Error('STT_STREAM_CLOSED');
        if (terminalError) throw terminalError;
        const results = await Promise.allSettled(streams.map((stream, index) => failedLanes.has(index) ? undefined : stream.sendAudio(frame)));
        for (let index = 0; index < results.length; index++) {
          const result = results[index];
          if (result.status !== 'rejected') continue;
          if (index === 0) throw result.reason;
          failedLanes.add(index);
          streams[index].abort();
          onConnectionState({ status: "failed", code: "SONIOX_TRANSLATION_UNAVAILABLE", language: languages[index] });
        }
      },
      assertDrained() { if (terminalError) throw terminalError; },
      abort() { isClosed = true; clearTimeout(timer); for (const stream of streams) stream?.abort?.(); },
      async close() {
        const outcomes = await Promise.allSettled(streams.map(stream => stream.close()));
        await flush(true, true); await callbackTail; isClosed = true; clearTimeout(timer);
        const failure = outcomes.find(outcome => outcome.status === 'rejected');
        if (failure) throw failure.reason;
      },
    };
  }
}
