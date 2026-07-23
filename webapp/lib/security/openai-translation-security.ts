import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { LIVE_ADMISSION_PEPPER } from "./config";
import { opaqueIdentifier } from "./hmac";
import { SupabaseLiveAdmissionStore } from "./live-admission-store";
import type { RateLimitStore } from "./live-rate-limit";

const MAX_API_KEY_CHARS = 8_192;
const MAX_REQUEST_BODY_BYTES = 1_024;
const MAX_REQUESTS = 12;
const WINDOW_MILLISECONDS = 60_000;
const MAX_BUCKETS = 4_096;

type HeaderReader = Pick<Headers, "get">;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface OpenAiTranslationRateLimitDecision {
  isAllowed: boolean;
  retryAfterSeconds: number;
}

export class OpenAiTranslationConfigurationError extends Error {}
export class OpenAiTranslationRequestTooLargeError extends Error {}

export function getOpenAiApiKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment.OPENAI_API_KEY?.trim() ?? "";
  if (!value || value.length > MAX_API_KEY_CHARS || /[\x00-\x20\x7f]/u.test(value)) {
    throw new OpenAiTranslationConfigurationError("OPENAI_API_KEY is not safely configured");
  }
  return value;
}

// 2026-07-22 security: Next imports route modules while producing a build, so
// production configuration is validated when the runtime module loads but not
// during Next's build analysis. Every request validates again for testability.
if (process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
  getOpenAiApiKey();
}

export async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_REQUEST_BODY_BYTES)) {
    throw new OpenAiTranslationRequestTooLargeError("OpenAI token request body is too large");
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new OpenAiTranslationRequestTooLargeError("OpenAI token request body is too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error: unknown) {
    if (error instanceof OpenAiTranslationRequestTooLargeError) throw error;
    return null;
  } finally {
    reader.releaseLock();
  }
}

function normalizedClientIp(headers: HeaderReader): string {
  const raw = headers.get("x-vercel-forwarded-for")
    ?? headers.get("x-forwarded-for")
    ?? headers.get("x-real-ip")
    ?? "";
  const candidate = raw.length <= 512 ? raw.split(",", 1)[0].trim() : "";
  return isIP(candidate) ? candidate : "unknown";
}

function clientKey(headers: HeaderReader): string {
  return createHash("sha256").update(normalizedClientIp(headers)).digest("hex");
}

export function createOpenAiTranslationRateLimiter() {
  const buckets = new Map<string, RateLimitBucket>();

  return {
    consume(headers: HeaderReader, now = Date.now()): OpenAiTranslationRateLimitDecision {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      const key = clientKey(headers);
      const current = buckets.get(key);
      if (current && current.count >= MAX_REQUESTS) {
        return {
          isAllowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
        };
      }
      if (!current) {
        while (buckets.size >= MAX_BUCKETS) {
          const oldestKey = buckets.keys().next().value;
          if (typeof oldestKey !== "string") break;
          buckets.delete(oldestKey);
        }
      } else {
        buckets.delete(key);
      }
      buckets.set(key, current
        ? { count: current.count + 1, resetAt: current.resetAt }
        : { count: 1, resetAt: now + WINDOW_MILLISECONDS });
      return { isAllowed: true, retryAfterSeconds: 0 };
    },
  };
}

export const openAiTranslationRateLimiter = createOpenAiTranslationRateLimiter();

export async function consumeOpenAiTranslationRateLimit(
  headers: HeaderReader,
  dependencies: {
    environment?: Readonly<Record<string, string | undefined>>;
    store?: RateLimitStore;
  } = {},
): Promise<OpenAiTranslationRateLimitDecision> {
  const environment = dependencies.environment ?? process.env;
  if (environment.NODE_ENV !== "production") return openAiTranslationRateLimiter.consume(headers);

  const store = dependencies.store ?? new SupabaseLiveAdmissionStore();
  const keyHash = await opaqueIdentifier(
    LIVE_ADMISSION_PEPPER,
    "openai-translation-token-ip",
    normalizedClientIp(headers),
  );
  const isAllowed = await store.consumeRateLimit({
    scope: "openai-translation-token-ip",
    keyHash,
    limit: MAX_REQUESTS,
    windowSeconds: WINDOW_MILLISECONDS / 1_000,
  });
  return { isAllowed, retryAfterSeconds: isAllowed ? 0 : WINDOW_MILLISECONDS / 1_000 };
}
