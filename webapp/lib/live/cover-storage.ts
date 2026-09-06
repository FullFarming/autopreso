/** Private Supabase Storage access for Live Call covers. Image bytes travel
 * directly from Electron to a short-lived signed upload URL. The server only
 * downloads the resulting private object for bounded validation/finalization. */

import { supabaseAdminHeaders } from "../security/supabase-server-access";
import { getLiveStoreConfig } from "./config";
import { LIVE_COVER_BUCKET, MAX_COVER_IMAGE_BYTES } from "./cover-image";
import { LiveSessionError } from "./errors";

type JsonObject = Readonly<Record<string, unknown>>;

export async function createCoverSignedUploadUrl(
  path: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ uploadUrl: string; storageOrigin: string }> {
  const { baseUrl, credential } = getLiveStoreConfig();
  let response: Response;
  try {
    response = await fetchFn(
      `${baseUrl}/storage/v1/object/upload/sign/${LIVE_COVER_BUCKET}/${encodeObjectPath(path)}`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          ...supabaseAdminHeaders(credential),
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
  } catch {
    throw new LiveSessionError("커버 업로드 주소를 만들지 못했습니다.", "COVER_SIGNING_FAILED", 502);
  }
  if (!response.ok) {
    throw new LiveSessionError("커버 업로드 주소를 만들지 못했습니다.", "COVER_SIGNING_FAILED", 502);
  }
  const payload = await readJsonObject(response);
  if (!payload || typeof payload.url !== "string") {
    throw new LiveSessionError("스토리지 응답을 확인할 수 없습니다.", "COVER_STORAGE_RESPONSE_INVALID", 502);
  }
  const uploadUrl = validateStorageSignedUrl(
    new URL(`${baseUrl}/storage/v1${payload.url}`),
    baseUrl,
    `/storage/v1/object/upload/sign/${LIVE_COVER_BUCKET}/${encodeObjectPath(path)}`,
  );
  return { uploadUrl, storageOrigin: new URL(baseUrl).origin };
}

export async function createCoverSignedDownloadUrl(
  path: string,
  expiresInSeconds = 300,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const { baseUrl, credential } = getLiveStoreConfig();
  let response: Response;
  try {
    response = await fetchFn(
      `${baseUrl}/storage/v1/object/sign/${LIVE_COVER_BUCKET}/${encodeObjectPath(path)}`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          ...supabaseAdminHeaders(credential),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      },
    );
  } catch {
    throw new LiveSessionError("커버 이미지를 불러오지 못했습니다.", "COVER_FETCH_FAILED", 502);
  }
  if (response.status === 404 || response.status === 400) {
    throw new LiveSessionError("커버 이미지가 없습니다.", "COVER_NOT_FOUND", 404);
  }
  if (!response.ok) throw new LiveSessionError("커버 이미지를 불러오지 못했습니다.", "COVER_FETCH_FAILED", 502);
  const payload = await readJsonObject(response);
  if (!payload || typeof payload.signedURL !== "string") {
    throw new LiveSessionError("스토리지 응답을 확인할 수 없습니다.", "COVER_STORAGE_RESPONSE_INVALID", 502);
  }
  return validateStorageSignedUrl(
    new URL(`${baseUrl}/storage/v1${payload.signedURL}`),
    baseUrl,
    `/storage/v1/object/sign/${LIVE_COVER_BUCKET}/${encodeObjectPath(path)}`,
  );
}

export async function fetchCoverObjectBounded(
  path: string,
  declaredLength: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; actualContentType: string } | null> {
  const { baseUrl, credential } = getLiveStoreConfig();
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/storage/v1/object/${LIVE_COVER_BUCKET}/${encodeObjectPath(path)}`, {
      method: "GET",
      cache: "no-store",
      headers: supabaseAdminHeaders(credential),
    });
  } catch {
    throw new LiveSessionError("업로드된 커버를 확인하지 못했습니다.", "COVER_FETCH_FAILED", 502);
  }
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new LiveSessionError("업로드된 커버를 확인하지 못했습니다.", "COVER_FETCH_FAILED", 502);

  const headerLength = parseContentLength(response.headers.get("content-length"));
  if (headerLength !== null && headerLength > MAX_COVER_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new LiveSessionError("커버 이미지는 20MB 이하여야 합니다.", "COVER_TOO_LARGE", 413);
  }
  if (headerLength !== null && headerLength !== declaredLength) {
    await response.body?.cancel().catch(() => undefined);
    throw new LiveSessionError("업로드한 이미지 크기가 일치하지 않습니다.", "COVER_LENGTH_MISMATCH", 400);
  }
  if (!response.body) {
    throw new LiveSessionError("업로드한 이미지 크기가 일치하지 않습니다.", "COVER_LENGTH_MISMATCH", 400);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedLength += value.byteLength;
      if (receivedLength > MAX_COVER_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LiveSessionError("커버 이미지는 20MB 이하여야 합니다.", "COVER_TOO_LARGE", 413);
      }
      if (receivedLength > declaredLength) {
        await reader.cancel().catch(() => undefined);
        throw new LiveSessionError("업로드한 이미지 크기가 일치하지 않습니다.", "COVER_LENGTH_MISMATCH", 400);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (receivedLength !== declaredLength) {
    throw new LiveSessionError("업로드한 이미지 크기가 일치하지 않습니다.", "COVER_LENGTH_MISMATCH", 400);
  }
  const bytes = new Uint8Array(receivedLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    actualContentType: (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase(),
  };
}

export async function moveCoverObject(
  sourcePath: string,
  destinationPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const { baseUrl, credential } = getLiveStoreConfig();
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/storage/v1/object/move`, {
      method: "POST",
      cache: "no-store",
      headers: {
        ...supabaseAdminHeaders(credential),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bucketId: LIVE_COVER_BUCKET,
        sourceKey: sourcePath,
        destinationKey: destinationPath,
      }),
    });
  } catch {
    throw new LiveSessionError("검증한 커버를 저장하지 못했습니다.", "COVER_FINALIZE_FAILED", 502);
  }
  if (!response.ok) throw new LiveSessionError("검증한 커버를 저장하지 못했습니다.", "COVER_FINALIZE_FAILED", 502);
}

/** Cleanup is intentionally best-effort: an unavailable storage service must
 * not roll back a successfully finalized session pointer. */
export async function deleteCoverObject(path: string, fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    const { baseUrl, credential } = getLiveStoreConfig();
    await fetchFn(`${baseUrl}/storage/v1/object/${LIVE_COVER_BUCKET}`, {
      method: "DELETE",
      cache: "no-store",
      headers: {
        ...supabaseAdminHeaders(credential),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: [path] }),
    });
  } catch {
    // A pending or replaced object is not addressable by clients.
  }
}

function encodeObjectPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function validateStorageSignedUrl(url: URL, baseUrl: string, expectedPathname: string): string {
  const expectedOrigin = new URL(baseUrl).origin;
  const queryKeys = [...url.searchParams.keys()];
  if (url.origin !== expectedOrigin
    || url.pathname !== expectedPathname
    || url.username
    || url.password
    || url.hash
    || queryKeys.length !== 1
    || queryKeys[0] !== "token"
    || !url.searchParams.get("token")) {
    throw new LiveSessionError("스토리지 응답을 확인할 수 없습니다.", "COVER_STORAGE_RESPONSE_INVALID", 502);
  }
  return url.href;
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readJsonObject(response: Response): Promise<JsonObject | null> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
  } catch {
    return null;
  }
}
