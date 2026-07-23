export const MAX_TTS_INPUT_BYTES = 4_999;

const NATURAL_BOUNDARY = /[\s.!?;:。！？；：、]/u;

export function segmentTextForStreamingTts(text, requestedMaxBytes = MAX_TTS_INPUT_BYTES) {
  const value = String(text);
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 4) throw new Error("INVALID_TTS_SEGMENT_LIMIT");
  const maxBytes = Math.min(requestedMaxBytes, MAX_TTS_INPUT_BYTES);
  if (!value) return [];
  const codePoints = Array.from(value);
  const segments = [];
  let start = 0;

  while (start < codePoints.length) {
    let bytes = 0;
    let end = start;
    let lastBoundary = -1;
    while (end < codePoints.length) {
      const nextBytes = Buffer.byteLength(codePoints[end], "utf8");
      if (bytes + nextBytes > maxBytes) break;
      bytes += nextBytes;
      end += 1;
      if (NATURAL_BOUNDARY.test(codePoints[end - 1])) lastBoundary = end;
    }
    if (end === start) throw new Error("TTS_CODE_POINT_EXCEEDS_LIMIT");
    const cut = end < codePoints.length && lastBoundary > start ? lastBoundary : end;
    segments.push(codePoints.slice(start, cut).join(""));
    start = cut;
  }
  return segments;
}
