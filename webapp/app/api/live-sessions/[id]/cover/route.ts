import { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import {
  coverImagePath,
  coverImageVersion,
  MAX_COVER_IMAGE_BYTES,
  validateCoverImage,
} from "@/lib/live/cover-image";
import { deleteCoverObject, fetchCoverObject, uploadCoverObject } from "@/lib/live/cover-storage";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";

type CoverBodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "LENGTH_MISMATCH" | "TOO_LARGE" };

async function readBoundedCoverBody(
  request: NextRequest,
  declaredLength: number,
): Promise<CoverBodyReadResult> {
  if (!request.body) return { ok: false, reason: "LENGTH_MISMATCH" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedLength += value.byteLength;
      if (receivedLength > MAX_COVER_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "TOO_LARGE" };
      }
      if (receivedLength > declaredLength) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "LENGTH_MISMATCH" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (receivedLength !== declaredLength) {
    return { ok: false, reason: "LENGTH_MISMATCH" };
  }
  const bytes = new Uint8Array(receivedLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** Contract C10: host uploads the stage/waiting-room cover image.
 *  Validated by magic bytes (never the declared content type), capped at
 *  5MB, stored in the private live-covers bucket under a content-hash path.
 *  Order matters: ownership check → storage upload → flag update, so a
 *  failed upload can never strand hasCoverImage=true without an object. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const [{ hostId }, { id: rawId }] = await Promise.all([requireHost(request), context.params]);
    const sessionId = parseSessionId(rawId);
    const store = getLiveSessionStore();
    const session = await store.get(sessionId);
    if (!session || session.hostId !== hostId) throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    if (session.status === "stopped" || session.status === "failed") {
      return apiError("종료된 세션에는 커버를 올릴 수 없습니다.", "SESSION_ENDED", 409);
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
      return apiError("Content-Length가 필요합니다.", "COVER_LENGTH_REQUIRED", 411);
    }
    if (declaredLength > MAX_COVER_IMAGE_BYTES) {
      return apiError("커버 이미지는 5MB 이하여야 합니다.", "COVER_TOO_LARGE", 413);
    }
    const body = await readBoundedCoverBody(request, declaredLength);
    if (!body.ok) {
      if (body.reason === "TOO_LARGE") {
        return apiError("커버 이미지는 5MB 이하여야 합니다.", "COVER_TOO_LARGE", 413);
      }
      return apiError("선언된 이미지 길이와 실제 전송 길이가 다릅니다.", "COVER_LENGTH_MISMATCH", 400);
    }
    const bytes = body.bytes;
    const validation = validateCoverImage(bytes);
    if (!validation.ok) {
      if (validation.reason === "TOO_LARGE") return apiError("커버 이미지는 5MB 이하여야 합니다.", "COVER_TOO_LARGE", 413);
      return apiError("JPEG, PNG, WebP 이미지만 업로드할 수 있습니다.", "COVER_UNSUPPORTED_TYPE", 415);
    }
    const version = await coverImageVersion(bytes);
    const path = coverImagePath(sessionId, version);
    await uploadCoverObject(path, bytes, validation.contentType);
    await new LiveSessionService(store).setCoverImage(hostId, sessionId, path);
    if (session.coverImageVersion && session.coverImageVersion !== version) {
      await deleteCoverObject(coverImagePath(sessionId, session.coverImageVersion));
    }
    return apiSuccess({ hasCoverImage: true, coverImageVersion: version });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}

/** Contract C10: proxy the cover image to the stage view and viewers.
 *  The bucket stays private; this route never exposes storage credentials
 *  and only serves sessions that actually have a cover. The session id is
 *  an unguessable UUID capability, matching how invites reach viewers. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const { id: rawId } = await context.params;
    const sessionId = parseSessionId(rawId);
    const session = await getLiveSessionStore().get(sessionId);
    if (!session?.hasCoverImage || !session.coverImageVersion) return apiError("커버 이미지가 없습니다.", "COVER_NOT_FOUND", 404);
    const object = await fetchCoverObject(coverImagePath(sessionId, session.coverImageVersion));
    if (!object) return apiError("커버 이미지가 없습니다.", "COVER_NOT_FOUND", 404);
    return new Response(object.bytes, {
      status: 200,
      headers: {
        "Content-Type": object.contentType,
        // The URL carries a content-hash cache key (?v=), so long-lived
        // per-URL caching is safe and replacements still show immediately.
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}
