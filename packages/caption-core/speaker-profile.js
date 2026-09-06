const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError("INVALID_SPEAKER_PROFILE");
  return value.toLowerCase();
}

function text(value, maximum, required = false) {
  if (typeof value !== "string") throw new TypeError("INVALID_SPEAKER_PROFILE");
  const normalized = value.normalize("NFC").trim();
  if ((required && !normalized) || normalized.length > maximum || /[<>\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("INVALID_SPEAKER_PROFILE");
  }
  return normalized;
}

export function normalizeSpeakerProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("INVALID_SPEAKER_PROFILE");
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new TypeError("INVALID_SPEAKER_PROFILE");
  return Object.freeze({
    id: uuid(value.id), version: value.version,
    displayName: text(value.displayName, 40, true),
    company: text(value.company ?? "", 80), department: text(value.department ?? "", 80),
    photoAssetId: value.photoAssetId == null ? null : uuid(value.photoAssetId),
  });
}

export function buildSpeakerPhotoUrl(sessionId, photoAssetId) {
  return `/api/live-sessions/${uuid(sessionId)}/speakers/photos/${uuid(photoAssetId)}`;
}
