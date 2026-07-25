/** Contract C10: session cover image shown behind the stage countdown and
 *  the viewer waiting room. Uploads are validated by magic bytes (never by
 *  the client-declared content type) and hard-capped at 5MB. A cover upload
 *  failure must never block session creation or start. */

export const MAX_COVER_IMAGE_BYTES = 5 * 1024 * 1024;
export const LIVE_COVER_BUCKET = "live-covers";

export type CoverImageType = "image/jpeg" | "image/png" | "image/webp";

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
  | { ok: false; reason: "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE" };

export function validateCoverImage(bytes: Uint8Array): CoverImageValidation {
  if (bytes.length === 0) return { ok: false, reason: "EMPTY" };
  if (bytes.length > MAX_COVER_IMAGE_BYTES) return { ok: false, reason: "TOO_LARGE" };
  const contentType = sniffCoverImageType(bytes);
  if (!contentType) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  return { ok: true, contentType };
}

/** Storage object path for a session cover. The path embeds a content-hash
 *  version so replacing the cover changes the client URL — mounted stages
 *  and waiting rooms pick up the new image on their next session refresh. */
export function coverImagePath(sessionId: string, version: string): string {
  return `${sessionId}/cover-${version}`;
}

/** Extract the version segment back out of a stored object path. */
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
