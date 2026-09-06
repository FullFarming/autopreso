import { LiveSessionError } from "../errors";

// `sharp` is a native module. Loading it at module scope made every import of this file (and so
// the roster GET, which never touches an image) fail with ERR_DLOPEN_FAILED when the platform
// binary was not traced into the serverless bundle. Only the photo normalizer needs it.
async function loadSharp() {
  return (await import("sharp")).default;
}

export const MAX_SPEAKER_PHOTO_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_SPEAKER_PHOTO_OUTPUT_BYTES = 256 * 1024;
const CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function readSpeakerPhotoBody(request: Pick<Request, "headers" | "body">): Promise<Uint8Array> {
  if (!CONTENT_TYPES.has(request.headers.get("content-type")?.trim().toLowerCase() ?? "")) throw invalidPhoto();
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null && (!/^[1-9]\d*$/u.test(rawLength) || Number(rawLength) > MAX_SPEAKER_PHOTO_INPUT_BYTES)) {
    throw oversizedPhoto();
  }
  if (!request.body) throw invalidPhoto();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SPEAKER_PHOTO_INPUT_BYTES) { await reader.cancel(); throw oversizedPhoto(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size || (rawLength !== null && Number(rawLength) !== size)) throw invalidPhoto();
  return Buffer.concat(chunks);
}

export async function normalizeSpeakerPhoto(bytes: Uint8Array, contentType: string): Promise<Buffer> {
  if (bytes.byteLength > MAX_SPEAKER_PHOTO_INPUT_BYTES) throw oversizedPhoto();
  if (!bytes.byteLength || !CONTENT_TYPES.has(contentType)) throw invalidPhoto();
  try {
    const sharp = await loadSharp();
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning", animated: false });
    const metadata = await image.metadata();
    const expected = contentType === "image/jpeg" ? "jpeg" : contentType === "image/png" ? "png" : "webp";
    if (metadata.format !== expected || (metadata.pages ?? 1) > 1) throw invalidPhoto();
    // EXIF and other metadata are omitted by default; only decoded raster pixels survive.
    const output = await image.rotate().resize(384, 384, { fit: "cover", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    if (output.byteLength > MAX_SPEAKER_PHOTO_OUTPUT_BYTES) throw oversizedPhoto();
    return output;
  } catch (error) {
    if (error instanceof LiveSessionError) throw error;
    throw invalidPhoto();
  }
}
function invalidPhoto() { return new LiveSessionError("완전한 JPEG, PNG, WebP 사진을 선택하세요.", "SPEAKER_PHOTO_INVALID", 415); }
function oversizedPhoto() { return new LiveSessionError("사진은 2MB 이하로 선택하세요.", "SPEAKER_PHOTO_TOO_LARGE", 413); }
