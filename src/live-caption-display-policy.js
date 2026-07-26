const LIVE_CAPTION_DISPLAY_LANGUAGES = new Set(["en", "ko"]);

export function sanitizeLiveCaptionDisplayLanguage(value) {
  return LIVE_CAPTION_DISPLAY_LANGUAGES.has(value) ? value : "ko";
}

export function shouldDisplayLiveCaption(caption, displayLanguage) {
  if (!caption || caption.translationStatus === "failed") return false;
  void displayLanguage;
  if (caption.origin === "source") return false;
  if (!LIVE_CAPTION_DISPLAY_LANGUAGES.has(caption.language)) return false;
  if (!LIVE_CAPTION_DISPLAY_LANGUAGES.has(caption.sourceLanguage)) return false;
  // 2026-07-26 fix: Live Call follows caption-only direction switching. The
  // screen shows the EN↔KO lane opposite the current utterance, regardless of
  // the session's historical fixed-language setting; same-language provider
  // echoes and source events remain record-only.
  return caption.sourceLanguage !== caption.language;
}
