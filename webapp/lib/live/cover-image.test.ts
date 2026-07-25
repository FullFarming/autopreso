import assert from "node:assert/strict";
import { test } from "node:test";

import {
  coverImagePath,
  coverImageVersion,
  coverImageVersionFromPath,
  MAX_COVER_IMAGE_BYTES,
  sniffCoverImageType,
  validateCoverImage,
} from "./cover-image";

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

test("sniffCoverImageType detects jpeg, png, and webp from magic bytes", () => {
  assert.equal(sniffCoverImageType(bytesOf(...JPEG_HEADER, 0x00)), "image/jpeg");
  assert.equal(sniffCoverImageType(bytesOf(...PNG_HEADER, 0x00)), "image/png");
  assert.equal(sniffCoverImageType(bytesOf(...WEBP_HEADER, 0x00)), "image/webp");
  assert.equal(sniffCoverImageType(bytesOf(0x47, 0x49, 0x46, 0x38)), null); // GIF is not allowed
  assert.equal(sniffCoverImageType(bytesOf()), null);
});

test("validateCoverImage accepts a small jpeg and reports its content type", () => {
  const result = validateCoverImage(bytesOf(...JPEG_HEADER, 1, 2, 3));
  assert.deepEqual(result, { ok: true, contentType: "image/jpeg" });
});

test("cover path embeds a content-hash version and round-trips it", async () => {
  const version = await coverImageVersion(bytesOf(...JPEG_HEADER, 9, 9, 9));
  assert.match(version, /^[0-9a-f]{16}$/u);
  const again = await coverImageVersion(bytesOf(...JPEG_HEADER, 9, 9, 9));
  assert.equal(version, again); // deterministic per content
  const path = coverImagePath("0192d0f4-9f72-7a36-91f5-6a76ef736f41", version);
  assert.equal(coverImageVersionFromPath(path), version);
  assert.equal(coverImageVersionFromPath("0192d0f4/cover"), null);
  assert.equal(coverImageVersionFromPath(null), null);
});

test("validateCoverImage rejects unknown formats and oversized payloads", () => {
  const unknown = validateCoverImage(bytesOf(0x00, 0x01, 0x02, 0x03));
  assert.equal(unknown.ok, false);
  const oversized = validateCoverImage(new Uint8Array(MAX_COVER_IMAGE_BYTES + 1).fill(0xff));
  assert.equal(oversized.ok, false);
  const empty = validateCoverImage(bytesOf());
  assert.equal(empty.ok, false);
});
