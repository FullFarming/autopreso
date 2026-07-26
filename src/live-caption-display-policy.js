const LIVE_CAPTION_DISPLAY_LANGUAGES = new Set(["en", "ko"]);

export function sanitizeLiveCaptionDisplayLanguage(value) {
  return LIVE_CAPTION_DISPLAY_LANGUAGES.has(value) ? value : "ko";
}

export function shouldDisplayLiveCaption(caption, displayLanguage) {
  if (!caption || caption.translationStatus === "failed") return false;
  const selectedLanguage = sanitizeLiveCaptionDisplayLanguage(displayLanguage);
  if (caption.language !== selectedLanguage) return false;
  if (caption.origin === "source") return true;
  // A provider can echo the source into its same-language output lane. Without
  // canonical source identity that echo is indistinguishable from a valid
  // translation, so the screen fails closed instead of showing two lines.
  return typeof caption.sourceLanguage === "string"
    && caption.sourceLanguage !== selectedLanguage;
}
