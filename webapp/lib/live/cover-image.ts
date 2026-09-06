/** Session cover contract. The browser may do a quick signature check for
 * feedback, but only this server-side parser decides whether an upload is an
 * image that can be attached to a session. */

export const MAX_COVER_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_COVER_IMAGE_DIMENSION = 8_192;
export const MAX_COVER_IMAGE_PIXELS = 40_000_000;
export const LIVE_COVER_BUCKET = "live-covers";

export type CoverImageType = "image/jpeg" | "image/png" | "image/webp";

type ImageDimensions = Readonly<{ width: number; height: number }>;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

export function sniffCoverImageType(bytes: Uint8Array): CoverImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && pngHeader.every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export type CoverImageValidation =
  | { ok: true; contentType: CoverImageType }
  | { ok: false; reason: "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE" | "INVALID_STRUCTURE" | "DIMENSIONS_TOO_LARGE" };

export function validateCoverImage(bytes: Uint8Array): CoverImageValidation {
  if (bytes.length === 0) return { ok: false, reason: "EMPTY" };
  if (bytes.length > MAX_COVER_IMAGE_BYTES) return { ok: false, reason: "TOO_LARGE" };
  const contentType = sniffCoverImageType(bytes);
  if (!contentType) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  const dimensions = contentType === "image/png"
    ? parsePng(bytes)
    : contentType === "image/jpeg"
      ? parseJpeg(bytes)
      : parseWebp(bytes);
  if (!dimensions) return { ok: false, reason: "INVALID_STRUCTURE" };
  if (!hasSafeDimensions(dimensions)) return { ok: false, reason: "DIMENSIONS_TOO_LARGE" };
  return { ok: true, contentType };
}

function hasSafeDimensions({ width, height }: ImageDimensions): boolean {
  return Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_COVER_IMAGE_DIMENSION
    && height <= MAX_COVER_IMAGE_DIMENSION
    && width * height <= MAX_COVER_IMAGE_PIXELS;
}

function parsePng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 57) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let dimensions: ImageDimensions | null = null;
  let hasImageData = false;
  let hasEndedImageData = false;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > bytes.length) return null;
    const type = ascii(bytes, typeOffset, 4);
    if (!/^[A-Za-z]{4}$/u.test(type)) return null;
    if (crc32(bytes, typeOffset, dataEnd) !== view.getUint32(dataEnd)) return null;

    if (offset === 8 && type !== "IHDR") return null;
    if (type === "IHDR") {
      if (dimensions || length !== 13) return null;
      const width = view.getUint32(dataOffset);
      const height = view.getUint32(dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8];
      const colorType = bytes[dataOffset + 9];
      const validDepths = new Map<number, ReadonlySet<number>>([
        [0, new Set([1, 2, 4, 8, 16])],
        [2, new Set([8, 16])],
        [3, new Set([1, 2, 4, 8])],
        [4, new Set([8, 16])],
        [6, new Set([8, 16])],
      ]);
      if (!width || !height
        || !validDepths.get(colorType)?.has(bitDepth)
        || bytes[dataOffset + 10] !== 0
        || bytes[dataOffset + 11] !== 0
        || bytes[dataOffset + 12] > 1) return null;
      dimensions = { width, height };
    } else if (type === "IDAT") {
      if (!dimensions || hasEndedImageData) return null;
      hasImageData = true;
    } else if (hasImageData && type !== "IEND") {
      hasEndedImageData = true;
    }

    if (type === "IEND") {
      if (length !== 0 || !dimensions || !hasImageData || chunkEnd !== bytes.length) return null;
      return dimensions;
    }
    // Unknown critical chunks cannot be safely decoded as ordinary PNG.
    if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90
      && !new Set(["IHDR", "PLTE", "IDAT"]).has(type)) return null;
    offset = chunkEnd;
  }
  return null;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 23 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  let hasScan = false;
  let isInsideScan = false;

  while (offset < bytes.length) {
    if (isInsideScan) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      const scanMarker = bytes[offset];
      if (scanMarker === 0x00 || scanMarker >= 0xd0 && scanMarker <= 0xd7) {
        offset += 1;
        continue;
      }
      offset -= 1;
      isInsideScan = false;
    }

    if (offset + 2 > bytes.length || bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) return offset === bytes.length && hasScan ? dimensions : null;
    if (marker === 0xd8 || marker === 0x00 || marker >= 0xd0 && marker <= 0xd7) return null;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes[offset] * 256 + bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (dimensions || segmentLength < 11) return null;
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      const componentCount = bytes[offset + 7];
      if (!width || !height || componentCount < 1 || segmentLength !== 8 + 3 * componentCount) return null;
      dimensions = { width, height };
    }
    if (marker === 0xda) {
      if (!dimensions || segmentLength < 6) return null;
      hasScan = true;
      isInsideScan = true;
    }
    offset += segmentLength;
  }
  return null;
}

function parseWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return null;
  let offset = 12;
  let canvas: ImageDimensions | null = null;
  let image: ImageDimensions | null = null;
  let hasAnimatedFrame = false;
  let isAnimatedCanvas = false;
  let hasAnimationHeader = false;

  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + length % 2;
    if (!/^[\x20-\x7e]{4}$/u.test(type) || dataEnd < dataOffset || chunkEnd > bytes.length) return null;

    if (type === "VP8X") {
      if (canvas || length !== 10) return null;
      canvas = {
        width: 1 + readUint24LittleEndian(bytes, dataOffset + 4),
        height: 1 + readUint24LittleEndian(bytes, dataOffset + 7),
      };
      isAnimatedCanvas = (bytes[dataOffset] & 0x02) !== 0;
      if (!hasSafeDimensions(canvas)) return null;
    } else if (type === "VP8L") {
      if (image || hasAnimatedFrame || isAnimatedCanvas) return null;
      const frame = parseVp8LosslessDimensions(bytes, dataOffset, length);
      if (!frame) return null;
      if (!hasSafeDimensions(frame) || canvas && (frame.width !== canvas.width || frame.height !== canvas.height)) return null;
      image = frame;
    } else if (type === "VP8 ") {
      if (image || hasAnimatedFrame || isAnimatedCanvas) return null;
      const frame = parseVp8LossyDimensions(bytes, dataOffset, length);
      if (!frame) return null;
      if (!hasSafeDimensions(frame) || canvas && (frame.width !== canvas.width || frame.height !== canvas.height)) return null;
      image = frame;
    } else if (type === "ANIM") {
      if (!canvas || !isAnimatedCanvas || hasAnimationHeader || length !== 6) return null;
      hasAnimationHeader = true;
    } else if (type === "ANMF") {
      if (!canvas || !isAnimatedCanvas || !hasAnimationHeader || length < 24) return null;
      const frameX = readUint24LittleEndian(bytes, dataOffset) * 2;
      const frameY = readUint24LittleEndian(bytes, dataOffset + 3) * 2;
      const frame = {
        width: readUint24LittleEndian(bytes, dataOffset + 6) + 1,
        height: readUint24LittleEndian(bytes, dataOffset + 9) + 1,
      };
      const encodedFrame = parseAnimatedWebpFrame(bytes, dataOffset + 16, dataEnd);
      if (!hasSafeDimensions(frame)
        || !encodedFrame
        || encodedFrame.width !== frame.width
        || encodedFrame.height !== frame.height
        || frameX + frame.width > canvas.width
        || frameY + frame.height > canvas.height) return null;
      hasAnimatedFrame = true;
      image = canvas;
    }
    offset = chunkEnd;
  }
  if (offset !== bytes.length || !image || isAnimatedCanvas && (!hasAnimationHeader || !hasAnimatedFrame)) return null;
  return canvas ?? image;
}

function parseAnimatedWebpFrame(bytes: Uint8Array, start: number, end: number): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  let image: ImageDimensions | null = null;
  let hasAlpha = false;
  while (offset + 8 <= end) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + length % 2;
    if (dataEnd < dataOffset || chunkEnd > end) return null;
    if (type === "ALPH") {
      if (hasAlpha || image || length < 1) return null;
      hasAlpha = true;
    } else if (type === "VP8 ") {
      if (image) return null;
      image = parseVp8LossyDimensions(bytes, dataOffset, length);
    } else if (type === "VP8L") {
      if (image || hasAlpha) return null;
      image = parseVp8LosslessDimensions(bytes, dataOffset, length);
    } else {
      return null;
    }
    if (!image && type !== "ALPH") return null;
    offset = chunkEnd;
  }
  return offset === end && image && hasSafeDimensions(image) ? image : null;
}

function parseVp8LosslessDimensions(bytes: Uint8Array, offset: number, length: number): ImageDimensions | null {
  if (length < 5 || bytes[offset] !== 0x2f) return null;
  return {
    width: 1 + bytes[offset + 1] + ((bytes[offset + 2] & 0x3f) << 8),
    height: 1 + ((bytes[offset + 2] & 0xc0) >>> 6)
      + (bytes[offset + 3] << 2)
      + ((bytes[offset + 4] & 0x0f) << 10),
  };
}

function parseVp8LossyDimensions(bytes: Uint8Array, offset: number, length: number): ImageDimensions | null {
  if (length < 10
    || bytes[offset + 3] !== 0x9d
    || bytes[offset + 4] !== 0x01
    || bytes[offset + 5] !== 0x2a) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint16(offset + 6, true) & 0x3fff,
    height: view.getUint16(offset + 8, true) & 0x3fff,
  };
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let index = offset; index < offset + length; index += 1) result += String.fromCharCode(bytes[index]);
  return result;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function pendingCoverImagePath(sessionId: string, nonce: string, contentType: CoverImageType): string {
  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
  return `${sessionId}/pending/${nonce}.${extension}`;
}

export function isPendingCoverImagePath(sessionId: string, path: string, contentType: CoverImageType): boolean {
  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
  const prefix = `${sessionId}/pending/`;
  return path.startsWith(prefix) && new RegExp(`^[0-9a-f]{32}\\.${extension}$`, "u").test(path.slice(prefix.length));
}

export function coverImagePath(sessionId: string, version: string): string {
  return `${sessionId}/cover-${version}`;
}

export function coverImageVersionFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const marker = path.lastIndexOf("/cover-");
  if (marker === -1) return null;
  const version = path.slice(marker + "/cover-".length);
  return /^[0-9a-f]{8,64}$/u.test(version) ? version : null;
}

export async function coverImageVersion(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest).slice(0, 8)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
