const LIVE_CAPTION_DISPLAY_LANGUAGES = new Set(["en", "ko"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPTURE_FIELDS = new Set(["kind", "streamGeneration", "captureEpoch", "captureStartedAt", "captureEndedAt", "finalization"]);

function isUtcTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isIndependentTranslationCaption(caption) {
  const capture = caption.translationCapture;
  if (!capture || typeof capture !== "object" || Array.isArray(capture)
    || Object.keys(capture).length !== CAPTURE_FIELDS.size
    || Object.keys(capture).some(key => !CAPTURE_FIELDS.has(key))) return false;
  return capture.kind === "independent-live-translation"
    && typeof capture.streamGeneration === "string" && UUID_PATTERN.test(capture.streamGeneration)
    && typeof capture.captureEpoch === "string" && UUID_PATTERN.test(capture.captureEpoch)
    && capture.finalization === "application-sentence-boundary"
    && isUtcTimestamp(capture.captureEndedAt)
    && (capture.captureStartedAt === null || (isUtcTimestamp(capture.captureStartedAt)
      && Date.parse(capture.captureStartedAt) <= Date.parse(capture.captureEndedAt)))
    && caption.translationStatus === "translated"
    && caption.sourceText == null && caption.sourceLanguage == null
    && caption.authoritativeSourceId == null && caption.sourceStartedAt == null && caption.origin == null;
}

export function sanitizeLiveCaptionDisplayLanguage(value) {
  return LIVE_CAPTION_DISPLAY_LANGUAGES.has(value) ? value : "ko";
}

// Hybrid mode has a local host-caption producer; gateway-only mode does not.
// Only positive host metadata may suppress that duplicate in hybrid mode.
export function isHostOriginLiveCaption(caption) {
  if (!caption || typeof caption !== "object") return false;
  if (caption.speakerRole !== "host") return false;
  if (caption.speaker?.isParticipant === true) return false;
  return !(typeof caption.speaker?.participantId === "string" && caption.speaker.participantId.length > 0);
}

/** @param {unknown} [producerKind] */
export function shouldDisplayLiveCaption(caption, displayLanguage, producerKind = "none") {
  if (!caption || caption.translationStatus === "failed") return false;
  if (producerKind !== "gateway" && producerKind !== "hybrid") return false;
  if (caption.origin === "source") return false;
  if (producerKind === "hybrid" && isHostOriginLiveCaption(caption)) return false;
  if (!LIVE_CAPTION_DISPLAY_LANGUAGES.has(caption.language)) return false;
  if (caption.translationCapture != null) {
    if (!isIndependentTranslationCaption(caption)) return false;
    // 2026-09-01 fix: A stream observation selects presentation only; it never
    // becomes an authoritative source-language claim or a guessed source link.
    if (LIVE_CAPTION_DISPLAY_LANGUAGES.has(caption.observedSourceLanguage)) {
      return caption.language !== caption.observedSourceLanguage;
    }
    return LIVE_CAPTION_DISPLAY_LANGUAGES.has(displayLanguage) && caption.language === displayLanguage;
  }
  if (!LIVE_CAPTION_DISPLAY_LANGUAGES.has(caption.sourceLanguage)) return false;
  // 2026-07-26 fix: Live Call follows caption-only direction switching. The
  // screen shows the EN↔KO lane opposite the current utterance, regardless of
  // the session's historical fixed-language setting; same-language provider
  // echoes and source events remain record-only.
  return caption.sourceLanguage !== caption.language;
}
