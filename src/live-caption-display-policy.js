const LIVE_CAPTION_DISPLAY_LANGUAGES = new Set(["en", "ko"]);

export function sanitizeLiveCaptionDisplayLanguage(value) {
  return LIVE_CAPTION_DISPLAY_LANGUAGES.has(value) ? value : "ko";
}

/** Host speech is translated twice during a Live Call: once by the LOCAL
 *  captions-only engine, which owns the desktop screen and hears the host
 *  microphone directly, and once by the gateway for the web app's captions and
 *  records. Only the participant half of the gateway stream belongs on screen —
 *  the local engine cannot hear participants. Mirroring the host half back was
 *  what required the relay ordering, direction, and retention corrections; the
 *  screen now takes it straight from the engine that produces it. */
/*  Requires POSITIVE host evidence rather than "no participant identity". The
 *  gateway stamps speakerRole on every meeting caption, and meeting is the only
 *  session type that mirrors to the desktop at all, so a caption with no role
 *  is not a host caption — it is a shape this path never receives, and guessing
 *  host there would silently blank the screen. */
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
