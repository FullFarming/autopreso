/** Contract C10: Supabase Storage access for session cover images.
 *  The bucket is private; viewers never talk to storage directly — the
 *  cover API route proxies bytes with the service credential. */

import { supabaseAdminHeaders } from "../security/supabase-server-access";
import { getLiveStoreConfig } from "./config";
import { LIVE_COVER_BUCKET, type CoverImageType } from "./cover-image";
import { LiveSessionError } from "./errors";

export async function uploadCoverObject(
  path: string,
  bytes: Uint8Array,
  contentType: CoverImageType,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const { baseUrl, credential } = getLiveStoreConfig();
  const response = await fetchFn(`${baseUrl}/storage/v1/object/${LIVE_COVER_BUCKET}/${path}`, {
    method: "POST",
    cache: "no-store",
    headers: {
      ...supabaseAdminHeaders(credential),
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) throw new LiveSessionError("커버 이미지를 저장하지 못했습니다.", "COVER_UPLOAD_FAILED", 502);
}

/** Best-effort removal of a replaced cover object. Failures are swallowed —
 *  an orphaned old cover is invisible (clients only know the new version). */
export async function deleteCoverObject(path: string, fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    const { baseUrl, credential } = getLiveStoreConfig();
    await fetchFn(`${baseUrl}/storage/v1/object/${LIVE_COVER_BUCKET}/${path}`, {
      method: "DELETE",
      cache: "no-store",
      headers: supabaseAdminHeaders(credential),
    });
  } catch {
    // Orphaned objects are bounded (5MB per replaced cover) and harmless.
  }
}

export async function fetchCoverObject(
  path: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const { baseUrl, credential } = getLiveStoreConfig();
  const response = await fetchFn(`${baseUrl}/storage/v1/object/${LIVE_COVER_BUCKET}/${path}`, {
    method: "GET",
    cache: "no-store",
    headers: supabaseAdminHeaders(credential),
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new LiveSessionError("커버 이미지를 불러오지 못했습니다.", "COVER_FETCH_FAILED", 502);
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}
