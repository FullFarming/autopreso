import { CAPTION_LANGUAGE_CODES } from "./languages.js";

// Pure Soniox wire helpers shared by the desktop transport and the gateway adapter.
// Source: soniox.com/docs/api-reference/stt/websocket-api, /docs/stt/rt/real-time-translation,
// /docs/stt/concepts/language-restrictions (fetched 2026-09-02).
export const SONIOX_MODEL = "stt-rt-v5";
export const SONIOX_ENDPOINTS = Object.freeze({
  us: "wss://stt-rt.soniox.com/transcribe-websocket",
  jp: "wss://stt-rt.jp.soniox.com/transcribe-websocket",
});
export const SONIOX_CONTROL = Object.freeze({ finalize: '{"type":"finalize"}', keepalive: '{"type":"keepalive"}' });

export const sonioxLanguageCode = (language) => ["zh-Hans", "zh-Hant"].includes(language) ? "zh" : language;

const MAX_CONTEXT_CHARACTERS = 9_000; // documented cap ~10,000 chars / 8,000 tokens; stay under it
const MAX_TRANSLATION_TERMS = 200;
// 200 pairs of long phrases would still overflow the context payload, so the
// pair count and the combined character budget are both enforced.
const MAX_TRANSLATION_TERM_CHARACTERS = 3_000;
// Control and format characters never belong in a provider prompt payload.
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f\p{Cf}]/u;

function boundedTerms(values, limit) {
  const out = [];
  const seen = new Set();
  let used = 0;
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw ?? "").normalize("NFC").trim();
    if (!value || UNSAFE_TEXT_PATTERN.test(value)) continue;
    const key = value.toLocaleLowerCase("und");
    if (seen.has(key)) continue;
    if (used + value.length > limit) break;
    seen.add(key);
    out.push(value);
    used += value.length;
  }
  return out;
}

/**
 * `translation_terms` obey two caps: at most MAX_TRANSLATION_TERMS pairs, and
 * at most MAX_TRANSLATION_TERM_CHARACTERS characters counting both sides of
 * every pair. Pairs are taken in order and adding stops at the first pair that
 * would exceed either bound.
 *
 * @param {unknown} values
 * @returns {Array<{source: string, target: string}>}
 */
function boundedTermPairs(values) {
  const out = [];
  let used = 0;
  for (const pair of Array.isArray(values) ? values : []) {
    if (out.length >= MAX_TRANSLATION_TERMS) break;
    if (!pair || typeof pair.source !== "string" || typeof pair.target !== "string") continue;
    if (UNSAFE_TEXT_PATTERN.test(pair.source) || UNSAFE_TEXT_PATTERN.test(pair.target)) continue;
    const source = pair.source.trim();
    const target = pair.target.trim();
    if (!source || !target) continue;
    if (used + source.length + target.length > MAX_TRANSLATION_TERM_CHARACTERS) break;
    used += source.length + target.length;
    out.push({ source, target });
  }
  return out;
}

/**
 * Builds the single JSON frame Soniox expects before any audio.
 *
 * @param {{apiKey?: string, model?: string, languageMode?: string, languages?: string[],
 *   translation?: boolean, targetLanguage?: string,
 *   context?: {terms?: unknown, translationTerms?: unknown, domain?: unknown},
 *   clientReferenceId?: string}} [input]
 * @returns {Record<string, unknown>}
 */
export function buildSonioxConfig({
  apiKey,
  model = SONIOX_MODEL,
  languageMode = "auto",
  languages = ["en", "ko"],
  translation = true,
  targetLanguage,
  context = {},
  clientReferenceId = "",
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("SONIOX_API_KEY_REQUIRED");
  if (model !== SONIOX_MODEL) throw new Error("SONIOX_MODEL_INVALID");
  if (!Array.isArray(languages) || languages.length < 1 || languages.length > 3
    || new Set(languages).size !== languages.length
    || !languages.every((code) => CAPTION_LANGUAGE_CODES.includes(code))) throw new Error("SONIOX_LANGUAGES_INVALID");
  const hints = languageMode === "auto" ? [...languages] : [languageMode];
  if (!hints.every((code) => CAPTION_LANGUAGE_CODES.includes(code))) throw new Error("SONIOX_LANGUAGE_MODE_INVALID");
  const config = /** @type {Record<string, unknown>} */ ({
    api_key: apiKey,
    model,
    audio_format: "pcm_s16le",
    sample_rate: 16000,
    num_channels: 1,
    language_hints: [...new Set(hints.map(sonioxLanguageCode))],
    // Output targets are hints, not a restriction on the speaker's input.
    language_hints_strict: languageMode !== "auto",
    enable_language_identification: true,
    enable_speaker_diarization: false,
    enable_endpoint_detection: true,
    endpoint_latency_adjustment_level: 0,
    endpoint_sensitivity: 0.0,
    max_endpoint_delay_ms: 2000,
    ...(clientReferenceId ? { client_reference_id: String(clientReferenceId).slice(0, 128) } : {}),
  });
  const terms = boundedTerms(context.terms, MAX_CONTEXT_CHARACTERS / 2);
  const translationTerms = boundedTermPairs(context.translationTerms);
  const general = typeof context.domain === "string" && context.domain.trim()
    ? [{ key: "domain", value: context.domain.trim().slice(0, 500) }]
    : [];
  if (terms.length || translationTerms.length || general.length) {
    config.context = {
      ...(general.length ? { general } : {}),
      ...(terms.length ? { terms } : {}),
      ...(translationTerms.length ? { translation_terms: translationTerms } : {}),
    };
  }
  if (translation) {
    if (targetLanguage !== undefined && !languages.includes(targetLanguage)) throw new Error("SONIOX_TRANSLATION_TARGET_INVALID");
    const target = targetLanguage ?? (languages.length === 1 ? languages[0] : undefined);
    if (target) {
      config.translation = { type: "one_way", target_language: sonioxLanguageCode(target) };
    } else {
      if (languages.length !== 2) throw new Error("SONIOX_TRANSLATION_TARGET_REQUIRED");
      const [a, b] = languages.includes("ko") ? ["ko", languages.find((code) => code !== "ko")] : languages;
      config.translation = sonioxLanguageCode(a) === sonioxLanguageCode(b)
        ? { type: "one_way", target_language: sonioxLanguageCode(a) }
        : { type: "two_way", language_a: sonioxLanguageCode(a), language_b: sonioxLanguageCode(b) };
    }
  }
  return config;
}

/**
 * Token reducer per Soniox semantics: final tokens append once; non-final
 * tokens are the current provisional suffix and replace the previous one;
 * `<end>` / `<fin>` close a segment. Tokens may be sub-words or spaces, so
 * text is concatenated verbatim (never trimmed or space-joined).
 *
 * Ordering contract (Task 5 ruling 4): partials are flushed once per `apply()`
 * after the whole token array is folded - source lane first, then translation
 * lanes - while a `<end>` / `<fin>` token closes the segment inline, emitting
 * the source final, then the translation finals, then the boundary. A
 * translation token that is already final in the same frame as `<end>` is
 * therefore committed without ever producing a partial.
 */
export function createSonioxTokenReducer({
  onSourcePartial,
  onSourceFinal,
  onTranslationPartial,
  onTranslationFinal,
  onBoundary,
  makeSegmentId = defaultSegmentId,
}) {
  let segmentId = makeSegmentId();
  let source = { committed: "", preview: "", language: null, startMs: null, endMs: null };
  const translations = new Map(); // language -> { committed, preview, sourceLanguage }
  const laneFor = (language) => {
    const key = language ?? "unknown";
    if (!translations.has(key)) translations.set(key, { committed: "", preview: "", sourceLanguage: null });
    return translations.get(key);
  };
  function emitSegment(kind) {
    if (source.committed.trim()) {
      onSourceFinal({
        text: source.committed,
        language: source.language,
        sourceLanguage: null,
        segmentId,
        startMs: source.startMs,
        endMs: source.endMs,
        isFinal: true,
      });
    }
    for (const [language, lane] of translations) {
      if (lane.committed.trim()) {
        onTranslationFinal({
          text: lane.committed,
          language,
          sourceLanguage: lane.sourceLanguage,
          segmentId,
          startMs: null,
          endMs: null,
          isFinal: true,
        });
      }
    }
    onBoundary(kind, { segmentId });
    reset();
  }
  function reset() {
    segmentId = makeSegmentId();
    source = { committed: "", preview: "", language: null, startMs: null, endMs: null };
    translations.clear();
  }
  return {
    reset,
    /**
     * True while the open segment holds committed (`is_final`) source text
     * that no `<end>` / `<fin>` has closed yet - the condition under which
     * the client may ask the provider for a manual boundary. Whitespace-only
     * finals and translation-lane text never count.
     */
    hasPendingFinalText() {
      return source.committed.trim().length > 0;
    },
    apply(result) {
      const tokens = Array.isArray(result?.tokens) ? result.tokens : [];
      let sourceChanged = false;
      const changedTranslations = new Set();
      let sourcePreview = "";
      const translationPreview = new Map();
      for (const token of tokens) {
        if (!token || typeof token.text !== "string") continue;
        if (token.text === "<end>" || token.text === "<fin>") {
          emitSegment(token.text === "<end>" ? "endpoint" : "manual-finalize");
          // Provisional tokens that preceded the boundary in this same frame
          // belong to the segment just closed; they must not be flushed as a
          // partial of the fresh segment below.
          sourceChanged = false;
          sourcePreview = "";
          changedTranslations.clear();
          translationPreview.clear();
          continue;
        }
        if (token.translation_status === "translation") {
          const language = token.language ?? "unknown";
          const lane = laneFor(token.language);
          lane.sourceLanguage = token.source_language ?? lane.sourceLanguage;
          if (token.is_final) lane.committed += token.text;
          else translationPreview.set(language, (translationPreview.get(language) ?? "") + token.text);
          changedTranslations.add(language);
          continue;
        }
        source.language = token.language ?? source.language;
        if (token.is_final) {
          source.committed += token.text;
          if (Number.isFinite(token.start_ms)) {
            source.startMs = source.startMs === null ? token.start_ms : Math.min(source.startMs, token.start_ms);
          }
          if (Number.isFinite(token.end_ms)) {
            source.endMs = source.endMs === null ? token.end_ms : Math.max(source.endMs, token.end_ms);
          }
        } else {
          sourcePreview += token.text;
        }
        sourceChanged = true;
      }
      if (sourceChanged) {
        source.preview = sourcePreview;
        const text = source.committed + source.preview;
        if (text.trim()) {
          onSourcePartial({
            text,
            language: source.language,
            sourceLanguage: null,
            segmentId,
            startMs: source.startMs,
            endMs: source.endMs,
            isFinal: false,
          });
        }
      }
      for (const language of changedTranslations) {
        const lane = laneFor(language);
        lane.preview = translationPreview.get(language) ?? "";
        const text = lane.committed + lane.preview;
        if (text.trim()) {
          onTranslationPartial({
            text,
            language,
            sourceLanguage: lane.sourceLanguage,
            segmentId,
            startMs: null,
            endMs: null,
            isFinal: false,
          });
        }
      }
    },
  };
}

/**
 * True when a result frame carries at least one content token (not just a
 * `<end>` / `<fin>` marker, and not an empty `tokens` array): the frames that
 * count as "new tokens" for the finalize scheduler's idle rule.
 *
 * @param {unknown} result
 * @returns {boolean}
 */
export function hasSonioxContentTokens(result) {
  const tokens = /** @type {any} */ (result)?.tokens;
  return Array.isArray(tokens)
    && tokens.some((token) => token && typeof token.text === "string" && token.text !== "<end>" && token.text !== "<fin>");
}

/**
 * Decides when the client must ask Soniox for a manual `<fin>` boundary.
 *
 * Spike 2026-09-02: 17 s of continuous speech produced zero `<end>` tokens,
 * and the reducer above commits only on `<end>` / `<fin>`, so a talk that never
 * pauses never yields a final. Two rules share ONE armed timer:
 *  - idle: at least `idleMilliseconds` since the last content token while
 *    final source text is pending (the caller decides what counts as a token -
 *    an empty result frame does not);
 *  - cap: the segment, measured from its FIRST token (not from the boundary
 *    that opened it), is older than `maxSegmentMilliseconds` while final text
 *    is pending; pending text that itself arrives past the cap fires at once.
 * A finalize already in flight is never re-sent before the next boundary, and
 * `dispose()` cancels the timer for good. Timers are injectable for tests.
 *
 * @param {{idleMilliseconds?: number, maxSegmentMilliseconds?: number, now?: () => number,
 *   setTimer?: (callback: () => void, delay: number) => any, clearTimer?: (timer: any) => void,
 *   onFinalize?: () => void}} [input]
 */
export function createSonioxFinalizeScheduler({
  idleMilliseconds = 1_200,
  maxSegmentMilliseconds = 15_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onFinalize,
} = {}) {
  let timer = null;
  let inFlight = false;
  let disposed = false;
  let segmentStartMs = null;

  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function fire() {
    cancel();
    if (disposed || inFlight) return;
    inFlight = true;
    onFinalize?.();
  }
  return {
    /** @param {{hasPendingFinalText?: boolean, atMs?: number}} [note] */
    noteTokens({ hasPendingFinalText = false, atMs = now() } = {}) {
      if (disposed) return;
      if (segmentStartMs === null) segmentStartMs = atMs;
      if (inFlight) return;
      if (!hasPendingFinalText) { cancel(); return; }
      const capDeadline = segmentStartMs + maxSegmentMilliseconds;
      if (atMs >= capDeadline) { fire(); return; }
      cancel();
      timer = setTimer(fire, Math.max(0, Math.min(atMs + idleMilliseconds, capDeadline) - atMs));
    },
    noteBoundary() { cancel(); inFlight = false; segmentStartMs = null; },
    noteFinalizeSent() { cancel(); inFlight = true; },
    isFinalizeInFlight() { return inFlight; },
    dispose() { cancel(); disposed = true; },
  };
}

let segmentCounter = 0;
function defaultSegmentId() {
  segmentCounter = (segmentCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `sx-${Date.now().toString(36)}-${segmentCounter.toString(36)}`;
}
