import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { z } from "zod";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import {
  coverImagePath,
  isPendingCoverImagePath,
  MAX_COVER_IMAGE_BYTES,
  pendingCoverImagePath,
  validateCoverImage,
} from "@/lib/live/cover-image";
import {
  createCoverSignedDownloadUrl,
  createCoverSignedUploadUrl,
  deleteCoverObject,
  fetchCoverObjectBounded,
  moveCoverObject,
} from "@/lib/live/cover-storage";
import { LiveSessionError, toLiveFailure } from "@/lib/live/errors";
import { isLiveCallEnabled } from "@/lib/live/feature-flag";
import { LiveSessionService } from "@/lib/live/service";
import { getLiveSessionStore } from "@/lib/live/store";
import { parseSessionId } from "@/lib/live/validation";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { LIVE_ADMISSION_PEPPER } from "@/lib/security/config";
import { hmacHex, timingSafeEqual } from "@/lib/security/hmac";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceCoverUploadRateLimit } from "@/lib/security/live-rate-limit";

const coverContentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
const coverPrepareSchema = z.object({
  action: z.literal("prepare"),
  size: z.number().int().positive().max(MAX_COVER_IMAGE_BYTES),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
}).strict();
const coverFinalizeSchema = z.object({
  action: z.literal("finalize"),
  objectPath: z.string().min(1).max(300),
  uploadTicket: z.string().min(1).max(4_096),
}).strict();
const coverDiscardSchema = z.object({
  action: z.literal("discard"),
  objectPath: z.string().min(1).max(300),
  uploadTicket: z.string().min(1).max(4_096),
}).strict();
const coverActionSchema = z.discriminatedUnion("action", [
  coverPrepareSchema,
  coverFinalizeSchema,
  coverDiscardSchema,
]);
const coverTicketClaimsSchema = z.object({
  sessionId: z.uuid(),
  objectPath: z.string().min(1).max(300),
  size: z.number().int().positive().max(MAX_COVER_IMAGE_BYTES),
  contentType: coverContentTypeSchema,
  expiresAt: z.number().int().positive(),
}).strict();
type CoverTicketClaims = z.infer<typeof coverTicketClaimsSchema>;

const COVER_TICKET_TTL_MILLISECONDS = 30 * 60 * 1_000;

/** Prepare returns only a short-lived capability; finalize re-downloads the
 * private object and validates it before the session ever references it. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const [{ hostId }, { id: rawId }] = await Promise.all([requireHost(request), context.params]);
    const sessionId = parseSessionId(rawId);
    const store = getLiveSessionStore();
    const session = await store.get(sessionId);
    if (!session || session.hostId !== hostId) {
      throw new LiveSessionError("세션을 찾을 수 없습니다.", "SESSION_NOT_FOUND", 404);
    }
    if (session.status === "stopped" || session.status === "failed") {
      return apiError("종료된 세션에는 커버를 올릴 수 없습니다.", "SESSION_ENDED", 409);
    }

    const parsed = coverActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("커버 요청이 올바르지 않습니다.", "INVALID_COVER_REQUEST", 400);

    if (parsed.data.action === "prepare") {
      await enforceCoverUploadRateLimit(hostId, sessionId, new SupabaseLiveAdmissionStore());
      const nonce = randomUUID().replaceAll("-", "");
      const objectPath = pendingCoverImagePath(sessionId, nonce, parsed.data.contentType);
      const { uploadUrl, storageOrigin } = await createCoverSignedUploadUrl(objectPath);
      const uploadTicket = await signCoverUploadTicket({
        sessionId,
        objectPath,
        size: parsed.data.size,
        contentType: parsed.data.contentType,
        expiresAt: Date.now() + COVER_TICKET_TTL_MILLISECONDS,
      });
      return apiSuccess({ uploadUrl, storageOrigin, objectPath, uploadTicket });
    }

    const { objectPath, uploadTicket } = parsed.data;
    if (!isPendingCoverImagePath(sessionId, objectPath, contentTypeFromPendingPath(objectPath))) {
      return apiError("커버 업로드 경로가 올바르지 않습니다.", "COVER_PATH_INVALID", 400);
    }
    if (parsed.data.action === "discard") {
      await verifyCoverUploadTicket(uploadTicket, sessionId, objectPath);
      await deleteCoverObject(objectPath);
      return apiSuccess({ discarded: true });
    }

    let finalPath: string | null = null;
    try {
      const claims = await verifyCoverUploadTicket(uploadTicket, sessionId, objectPath);
      const { size, contentType } = claims;
      const object = await fetchCoverObjectBounded(objectPath, size);
      if (!object) throw new LiveSessionError("업로드한 커버가 없습니다.", "COVER_UPLOAD_MISSING", 400);
      const { bytes, actualContentType } = object;
      if (bytes.byteLength !== size) {
        throw new LiveSessionError("업로드한 이미지 크기가 일치하지 않습니다.", "COVER_LENGTH_MISMATCH", 400);
      }
      if (actualContentType !== contentType) {
        throw new LiveSessionError("업로드한 이미지 형식이 일치하지 않습니다.", "COVER_TYPE_MISMATCH", 415);
      }
      const validation = validateCoverImage(bytes);
      if (!validation.ok) throw coverValidationError(validation.reason);
      if (validation.contentType !== contentType) {
        throw new LiveSessionError("업로드한 이미지 형식이 일치하지 않습니다.", "COVER_TYPE_MISMATCH", 415);
      }

      // The pending path is never published. A second random name prevents
      // replay and gives each accepted replacement a cache-busting version.
      const version = randomUUID().replaceAll("-", "");
      finalPath = coverImagePath(sessionId, version);
      await moveCoverObject(objectPath, finalPath);
      const expectedCurrentPath = session.coverImageVersion
        ? coverImagePath(sessionId, session.coverImageVersion)
        : null;
      await new LiveSessionService(store).setCoverImage(hostId, sessionId, finalPath, expectedCurrentPath);
      if (session.coverImageVersion && session.coverImageVersion !== version) {
        await deleteCoverObject(coverImagePath(sessionId, session.coverImageVersion));
      }
      return apiSuccess({ hasCoverImage: true, coverImageVersion: version });
    } catch (error: unknown) {
      await deleteCoverObject(objectPath);
      if (finalPath) await deleteCoverObject(finalPath);
      throw error;
    }
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401);
    if (error instanceof LiveAdmissionError) return apiError(error.message, error.code, error.status);
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}

/** The bucket remains private. A small redirect response avoids routing a
 * possible 20 MiB download back through the function response limit. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    if (!isLiveCallEnabled()) return apiError("Live Call 기능이 비활성화되어 있습니다.", "LIVE_CALL_DISABLED", 403);
    const { id: rawId } = await context.params;
    const sessionId = parseSessionId(rawId);
    const session = await getLiveSessionStore().get(sessionId);
    if (!session?.hasCoverImage || !session.coverImageVersion) {
      return apiError("커버 이미지가 없습니다.", "COVER_NOT_FOUND", 404);
    }
    const signedUrl = await createCoverSignedDownloadUrl(coverImagePath(sessionId, session.coverImageVersion));
    return new Response(null, {
      status: 307,
      headers: {
        Location: signedUrl,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    const failure = toLiveFailure(error);
    return apiError(failure.body.error, failure.body.code, failure.status);
  }
}

async function signCoverUploadTicket(claims: CoverTicketClaims): Promise<string> {
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = await hmacHex(LIVE_ADMISSION_PEPPER, `cover-upload\0${encoded}`);
  return `${encoded}.${signature}`;
}

async function verifyCoverUploadTicket(
  token: string,
  sessionId: string,
  objectPath: string,
): Promise<CoverTicketClaims> {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[0-9a-f]{64}$/u.test(signature)) {
    throw invalidCoverTicket();
  }
  const expected = await hmacHex(LIVE_ADMISSION_PEPPER, `cover-upload\0${encoded}`);
  if (!timingSafeEqual(signature, expected)) throw invalidCoverTicket();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalidCoverTicket();
  }
  const parsed = coverTicketClaimsSchema.safeParse(decoded);
  if (!parsed.success
    || parsed.data.sessionId !== sessionId
    || parsed.data.objectPath !== objectPath
    || parsed.data.expiresAt < Date.now()
    || !isPendingCoverImagePath(sessionId, objectPath, parsed.data.contentType)) throw invalidCoverTicket();
  return parsed.data;
}

function contentTypeFromPendingPath(path: string): "image/jpeg" | "image/png" | "image/webp" {
  if (path.endsWith(".jpg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  return "image/webp";
}

function invalidCoverTicket(): LiveSessionError {
  return new LiveSessionError("커버 업로드 확인 정보가 만료되었거나 올바르지 않습니다.", "COVER_UPLOAD_TICKET_INVALID", 400);
}

function coverValidationError(reason: "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE" | "INVALID_STRUCTURE" | "DIMENSIONS_TOO_LARGE"): LiveSessionError {
  if (reason === "TOO_LARGE") return new LiveSessionError("커버 이미지는 20MB 이하여야 합니다.", "COVER_TOO_LARGE", 413);
  if (reason === "DIMENSIONS_TOO_LARGE") {
    return new LiveSessionError("커버 이미지 해상도가 너무 큽니다.", "COVER_DIMENSIONS_TOO_LARGE", 422);
  }
  return new LiveSessionError("완전한 JPEG, PNG, WebP 이미지만 업로드할 수 있습니다.", "COVER_INVALID_IMAGE", 415);
}
