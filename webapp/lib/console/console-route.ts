import type { NextResponse } from "next/server";

import { captionEngineCatalogForClient, EngineSelectionError, normalizeEngineSelection } from "../../../packages/caption-core/caption-engine-catalog.js";
import { AuthenticationError, AuthorizationError } from "../auth/live-auth";
import { apiError } from "../security/api-response";
import { BoundedJsonBodyError } from "../security/bounded-json-body";
import { CsrfError } from "../security/csrf";
import { privateNoStoreHeaders } from "../security/live-topic-validation";
import { ConsoleStoreError } from "./console-store";
import type { EngineSelection } from "./engine-defaults";

/**
 * Shared failure mapping for `app/api/console/*`. Every console response is private
 * and uncacheable; the guard errors keep the codes the rest of the host API uses
 * (`HOST_AUTH_REQUIRED`, `CSRF_REJECTED`) and add `ADMIN_REQUIRED` for an approved non-admin.
 * Mutating routes call `assertStrictOrigin(request)` first thing inside their try block, so a
 * foreign origin is refused before the cookie is even inspected (middleware checks it too).
 */
export function consoleFailure(error: unknown, fallbackMessage: string, fallbackCode: string): NextResponse {
  const headers = privateNoStoreHeaders();
  if (error instanceof CsrfError) return apiError(error.message, "CSRF_REJECTED", 403, headers);
  if (error instanceof AuthenticationError) return apiError(error.message, "HOST_AUTH_REQUIRED", 401, headers);
  if (error instanceof AuthorizationError) return apiError(error.message, "ADMIN_REQUIRED", 403, headers);
  if (error instanceof ConsoleStoreError) return apiError(error.message, error.code, error.status, headers);
  if (error instanceof BoundedJsonBodyError) return apiError(error.message, error.code, error.status, headers);
  return apiError(fallbackMessage, fallbackCode, 500, headers);
}

export function invalidConsoleRequest(message = "요청 형식이 올바르지 않습니다."): NextResponse {
  return apiError(message, "INVALID_REQUEST", 400, privateNoStoreHeaders());
}

/** Catalog view for the console: availability is a boolean per provider, never a key value. */
export function consoleEngineCatalog(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof captionEngineCatalogForClient> {
  return captionEngineCatalogForClient({ hasApiKeys: { gemini: Boolean(env.GEMINI_API_KEY), soniox: Boolean(env.SONIOX_API_KEY) } });
}

/** `null` when the submitted selection is not a catalog entry (the route answers 400 `ENGINE_INVALID`). */
export function normalizeSubmittedEngine(value: unknown): EngineSelection | null {
  try { return normalizeEngineSelection(value) as EngineSelection; }
  catch (error) { if (error instanceof EngineSelectionError) return null; throw error; }
}
