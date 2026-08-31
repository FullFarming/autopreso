const LIVE_CAPTION_DISPLAY_LANGUAGES = new Set(["en", "ko"]);

export function sanitizeLiveCaptionDisplayLanguage(value) {
  return LIVE_CAPTION_DISPLAY_LANGUAGES.has(value) ? value : "ko";
}

// The local Caption Only engine owns host speech on the desktop. The gateway
// still translates that same host PCM for the web transcript, but replaying it
// locally would duplicate or race the local result. Positive host metadata is
// required so an unknown payload fails visible instead of being guessed away.
export function isHostOriginLiveCaption(caption) {
  if (!caption || typeof caption !== "object") return false;
  if (caption.speakerRole !== "host") return false;
  if (caption.speaker?.isParticipant === true) return false;
  return !(typeof caption.speaker?.participantId === "string" && caption.speaker.participantId.length > 0);
}

export function shouldDisplayLiveCaption(caption, displayLanguage) {
  if (!caption || caption.translationStatus === "failed") return false;
  void displayLanguage;
  if (caption.origin === "source") return false;
  if (isHostOriginLiveCaption(caption)) return false;
  if (!LIVE_CAPTION_DISPLAY_LANGUAGES.has(caption.language)) return false;
  if (!LIVE_CAPTION_DISPLAY_LANGUAGES.has(caption.sourceLanguage)) return false;
  // 2026-07-26 fix: Live Call follows caption-only direction switching. The
  // screen shows the EN↔KO lane opposite the current utterance, regardless of
  // the session's historical fixed-language setting; same-language provider
  // echoes and source events remain record-only.
  return caption.sourceLanguage !== caption.language;
}
