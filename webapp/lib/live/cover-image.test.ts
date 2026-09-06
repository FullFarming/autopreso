import assert from "node:assert/strict";
import { test } from "node:test";

import {
  coverImagePath,
  coverImageVersion,
  coverImageVersionFromPath,
  MAX_COVER_IMAGE_BYTES,
  MAX_COVER_IMAGE_DIMENSION,
  MAX_COVER_IMAGE_PIXELS,
  sniffCoverImageType,
  validateCoverImage,
} from "./cover-image";

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, payload.length);
  result.set(typeBytes, 4);
  result.set(payload, 8);
  const checksumInput = new Uint8Array(typeBytes.length + payload.length);
  checksumInput.set(typeBytes);
  checksumInput.set(payload, typeBytes.length);
  view.setUint32(8 + payload.length, crc32(checksumInput));
  return result;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function validPng(width = 1920, height = 1080): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return concat(
    bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", bytesOf(0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01)),
    pngChunk("IEND", bytesOf()),
  );
}

function validJpeg(width = 1920, height = 1080): Uint8Array {
  return bytesOf(
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >>> 8, height & 0xff, width >>> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00,
    0x11, 0x22, 0xff, 0x00, 0x33,
    0xff, 0xd9,
  );
}

function validWebp(width = 1920, height = 1080): Uint8Array {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  const payload = bytesOf(
    0x2f,
    widthMinusOne & 0xff,
    ((widthMinusOne >>> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6),
    (heightMinusOne >>> 2) & 0xff,
    (heightMinusOne >>> 10) & 0x0f,
  );
  const result = new Uint8Array(12 + 8 + payload.length + 1);
  result.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  result.set(new TextEncoder().encode("WEBPVP8L"), 8);
  new DataView(result.buffer).setUint32(16, payload.length, true);
  result.set(payload, 20);
  return result;
}

function webpChunk(type: string, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + payload.length + payload.length % 2);
  chunk.set(new TextEncoder().encode(type), 0);
  new DataView(chunk.buffer).setUint32(4, payload.length, true);
  chunk.set(payload, 8);
  return chunk;
}

function extendedWebp(canvasWidth: number, canvasHeight: number, ...chunks: Uint8Array[]): Uint8Array {
  const canvas = new Uint8Array(10);
  canvas[0] = chunks.some((chunk) => new TextDecoder().decode(chunk.subarray(0, 4)) === "ANMF") ? 0x02 : 0;
  const widthMinusOne = canvasWidth - 1;
  const heightMinusOne = canvasHeight - 1;
  canvas.set([
    widthMinusOne & 0xff,
    (widthMinusOne >>> 8) & 0xff,
    (widthMinusOne >>> 16) & 0xff,
  ], 4);
  canvas.set([
    heightMinusOne & 0xff,
    (heightMinusOne >>> 8) & 0xff,
    (heightMinusOne >>> 16) & 0xff,
  ], 7);
  const body = concat(webpChunk("VP8X", canvas), ...chunks);
  const result = concat(new TextEncoder().encode("RIFF"), new Uint8Array(4), new TextEncoder().encode("WEBP"), body);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}

function losslessWebpChunk(width: number, height: number): Uint8Array {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  return webpChunk("VP8L", bytesOf(
    0x2f,
    widthMinusOne & 0xff,
    ((widthMinusOne >>> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6),
    (heightMinusOne >>> 2) & 0xff,
    (heightMinusOne >>> 10) & 0x0f,
  ));
}

test("20 MiB cover contract accepts structurally complete JPEG, PNG, and WebP images", () => {
  assert.equal(MAX_COVER_IMAGE_BYTES, 20 * 1024 * 1024);
  for (const [bytes, contentType] of [
    [validJpeg(), "image/jpeg"],
    [validPng(), "image/png"],
    [validWebp(), "image/webp"],
  ] as const) {
    assert.equal(sniffCoverImageType(bytes), contentType);
    assert.deepEqual(validateCoverImage(bytes), { ok: true, contentType });
  }
});

test("magic-byte lookalikes and truncated image structures are rejected", () => {
  for (const bytes of [
    bytesOf(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3),
    bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3),
    bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50),
  ]) {
    assert.deepEqual(validateCoverImage(bytes), { ok: false, reason: "INVALID_STRUCTURE" });
  }

  const badPngCrc = validPng();
  badPngCrc[29] ^= 0xff;
  assert.deepEqual(validateCoverImage(badPngCrc), { ok: false, reason: "INVALID_STRUCTURE" });
});

test("dimension and pixel ceilings permit 8K but reject decompression-bomb metadata", () => {
  assert.ok(MAX_COVER_IMAGE_DIMENSION >= 7680);
  assert.ok(MAX_COVER_IMAGE_PIXELS >= 7680 * 4320);
  assert.deepEqual(validateCoverImage(validPng(7680, 4320)), { ok: true, contentType: "image/png" });
  assert.deepEqual(
    validateCoverImage(validPng(MAX_COVER_IMAGE_DIMENSION + 1, 100)),
    { ok: false, reason: "DIMENSIONS_TOO_LARGE" },
  );
  assert.deepEqual(
    validateCoverImage(validPng(8000, Math.floor(MAX_COVER_IMAGE_PIXELS / 8000) + 1)),
    { ok: false, reason: "DIMENSIONS_TOO_LARGE" },
  );
});

test("WebP extended canvas cannot hide an oversized or inconsistent inner frame", () => {
  const hiddenHugeFrame = extendedWebp(320, 180, losslessWebpChunk(8192, 8192));
  assert.equal(validateCoverImage(hiddenHugeFrame).ok, false);

  const animationHeader = webpChunk("ANIM", new Uint8Array(6));
  const animationFrameHeader = new Uint8Array(16);
  animationFrameHeader.set([99, 0, 0], 6);
  animationFrameHeader.set([99, 0, 0], 9);
  const validAnimationFrame = webpChunk("ANMF", concat(animationFrameHeader, losslessWebpChunk(100, 100)));
  assert.deepEqual(
    validateCoverImage(extendedWebp(320, 180, animationHeader, validAnimationFrame)),
    { ok: true, contentType: "image/webp" },
  );

  const emptyAnimationFrame = webpChunk("ANMF", animationFrameHeader);
  assert.equal(validateCoverImage(extendedWebp(320, 180, animationHeader, emptyAnimationFrame)).ok, false);

  const outsideFrameHeader = animationFrameHeader.slice();
  // x offset is stored in half-pixel units: 150 means x=300. The 100px frame
  // then exceeds the 320px canvas and must fail closed.
  outsideFrameHeader.set([150, 0, 0], 0);
  const outsideCanvas = extendedWebp(
    320,
    180,
    animationHeader,
    webpChunk("ANMF", concat(outsideFrameHeader, losslessWebpChunk(100, 100))),
  );
  assert.equal(validateCoverImage(outsideCanvas).ok, false);
});

test("cover path embeds a version and round-trips it", async () => {
  const version = await coverImageVersion(validJpeg());
  assert.match(version, /^[0-9a-f]{16}$/u);
  assert.equal(version, await coverImageVersion(validJpeg()));
  const path = coverImagePath("0192d0f4-9f72-7a36-91f5-6a76ef736f41", version);
  assert.equal(coverImageVersionFromPath(path), version);
  assert.equal(coverImageVersionFromPath("0192d0f4/cover"), null);
  assert.equal(coverImageVersionFromPath(null), null);
});

test("unknown, empty, and oversized payloads retain distinct rejection reasons", () => {
  assert.deepEqual(validateCoverImage(bytesOf(0x47, 0x49, 0x46, 0x38)), { ok: false, reason: "UNSUPPORTED_TYPE" });
  assert.deepEqual(validateCoverImage(new Uint8Array(MAX_COVER_IMAGE_BYTES + 1)), { ok: false, reason: "TOO_LARGE" });
  assert.deepEqual(validateCoverImage(bytesOf()), { ok: false, reason: "EMPTY" });
});
