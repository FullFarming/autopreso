import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LiveSessionError, toLiveFailure } from "../errors";
import { AuthenticationError, AuthorizationError } from "../../auth/live-auth";
import { readBoundedJsonBody, BoundedJsonBodyError } from "../../security/bounded-json-body";
import { LiveAdmissionError } from "../../security/live-admission-store";
import { speakerRosterReplaceSchema } from "./validation";
import { normalizeSpeakerPhoto, readSpeakerPhotoBody } from "./photo";
import type { SpeakerRosterStore } from "./store";

export interface SpeakerRosterDependencies<RequestType extends Request> {
  store: SpeakerRosterStore;
  requireHost(request: RequestType): Promise<{ hostId: string }>;
  authorizePhoto(request: RequestType, sessionId: string): Promise<void>;
  rateLimit(hostId: string, sessionId: string, kind: "roster" | "photo"): Promise<void>;
}
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
function apiSuccess(data: unknown, options: ResponseInit) { return Response.json({ ok: true, data }, options); }
function apiError(error: string, code: string, status: number, headers: HeadersInit) {
  return Response.json({ ok: false, error, code }, { status, headers });
}

export function createSpeakerRosterHandlers<RequestType extends Request>(dependencies: SpeakerRosterDependencies<RequestType>) {
  return {
    async get(request: RequestType, rawId: string) {
      try {
        const sessionId = parseId(rawId);
        const { hostId } = await dependencies.requireHost(request);
        return apiSuccess(await dependencies.store.get(sessionId, hostId), { headers: privateHeaders });
      } catch (error) { return failure(error); }
    },
    async put(request: RequestType, rawId: string) {
      try {
        const sessionId = parseId(rawId);
        const { hostId } = await dependencies.requireHost(request);
        await dependencies.store.get(sessionId, hostId);
        await dependencies.rateLimit(hostId, sessionId, "roster");
        const input = speakerRosterReplaceSchema.safeParse(await readBoundedJsonBody(request, 64 * 1024));
        if (!input.success) throw new LiveSessionError("발언자 설정을 확인하세요. 이름은 40자, 회사·부서는 80자까지 입력할 수 있습니다.", "SPEAKER_ROSTER_INVALID", 400);
        return apiSuccess(await dependencies.store.replace(sessionId, hostId, input.data), { headers: privateHeaders });
      } catch (error) { return failure(error); }
    },
    async postPhoto(request: RequestType, rawId: string) {
      try {
        const sessionId = parseId(rawId);
        const { hostId } = await dependencies.requireHost(request);
        await dependencies.store.get(sessionId, hostId);
        await dependencies.rateLimit(hostId, sessionId, "photo");
        const bytes = await readSpeakerPhotoBody(request);
        const output = await normalizeSpeakerPhoto(bytes, request.headers.get("content-type")?.trim().toLowerCase() ?? "");
        return apiSuccess(await dependencies.store.createPhoto(sessionId, hostId, randomUUID(), {
          contentType: "image/webp", bytesBase64: output.toString("base64"),
        }), { headers: privateHeaders });
      } catch (error) { return failure(error); }
    },
    async getPhoto(request: RequestType, rawId: string, rawPhotoId: string) {
      try {
        const sessionId = parseId(rawId); const photoId = parseId(rawPhotoId);
        await dependencies.authorizePhoto(request, sessionId);
        const photo = await dependencies.store.getPhoto(sessionId, photoId);
        const bytes = Buffer.from(photo.bytesBase64, "base64");
        if (!bytes.length || bytes.length > 256 * 1024) throw new LiveSessionError("사진을 불러올 수 없습니다.", "SPEAKER_PHOTO_INVALID", 500);
        // An immutable asset identity does not make a revoked admission grant cacheable.
        return new Response(new Uint8Array(bytes), { headers: {
          ...privateHeaders, "Content-Type": photo.contentType, "Content-Length": String(bytes.length),
          "Content-Disposition": "inline", "Referrer-Policy": "no-referrer",
        } });
      } catch (error) { return failure(error); }
    },
  };
}

function parseId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw new LiveSessionError("회의 또는 사진 정보가 올바르지 않습니다.", "SPEAKER_ROSTER_INVALID", 400);
  return result.data.toLowerCase();
}
function failure(error: unknown): Response {
  if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401, privateHeaders);
  if (error instanceof AuthorizationError) return apiError(error.message, "SPEAKER_ROSTER_FORBIDDEN", 403, privateHeaders);
  if (error instanceof LiveAdmissionError || error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status, privateHeaders);
  const result = toLiveFailure(error);
  return apiError(result.body.error, result.body.code, result.status, privateHeaders);
}
