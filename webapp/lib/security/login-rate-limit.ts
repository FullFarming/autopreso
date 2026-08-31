import { createHash } from "node:crypto";

import { getRequestIp } from "./live-rate-limit";

const DEFAULT_MAX_FAILURES = 4;
const DEFAULT_WINDOW_MILLISECONDS = 15 * 60 * 1_000;
const DEFAULT_MAX_BUCKETS = 4_096;

type HeaderReader = Pick<Headers, "get">;

export interface LoginRateLimitDecision {
  isAllowed: boolean;
  retryAfterSeconds: number;
}

export interface LoginRateLimiter {
  check(headers: HeaderReader, now?: number): LoginRateLimitDecision;
  recordFailure(headers: HeaderReader, now?: number): LoginRateLimitDecision;
  clear(headers: HeaderReader): void;
}

interface LoginRateLimitOptions {
  maxFailures?: number;
  windowMilliseconds?: number;
  maxBuckets?: number;
}

interface FailureBucket {
  failures: number;
  resetAt: number;
}

function clientKey(headers: HeaderReader): string {
  return createHash("sha256").update(getRequestIp({ headers })).digest("hex");
}

function decision(bucket: FailureBucket | undefined, maxFailures: number, now: number): LoginRateLimitDecision {
  if (!bucket || bucket.resetAt <= now || bucket.failures < maxFailures) {
    return { isAllowed: true, retryAfterSeconds: 0 };
  }
  return {
    isAllowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
  };
}

export function createLoginRateLimiter(options: LoginRateLimitOptions = {}): LoginRateLimiter {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMilliseconds = options.windowMilliseconds ?? DEFAULT_WINDOW_MILLISECONDS;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  if (!Number.isSafeInteger(maxFailures) || maxFailures < 1
    || !Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1_000
    || !Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new Error("로그인 rate limit 설정이 올바르지 않습니다.");
  }

  const buckets = new Map<string, FailureBucket>();

  function removeExpired(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  function makeRoom(): void {
    while (buckets.size >= maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      if (typeof oldestKey !== "string") return;
      buckets.delete(oldestKey);
    }
  }

  return {
    check(headers, now = Date.now()) {
      const key = clientKey(headers);
      const bucket = buckets.get(key);
      if (bucket?.resetAt !== undefined && bucket.resetAt <= now) buckets.delete(key);
      return decision(buckets.get(key), maxFailures, now);
    },
    recordFailure(headers, now = Date.now()) {
      removeExpired(now);
      const key = clientKey(headers);
      const current = buckets.get(key);
      const bucket = current
        ? { failures: Math.min(maxFailures, current.failures + 1), resetAt: current.resetAt }
        : { failures: 1, resetAt: now + windowMilliseconds };
      if (!current) makeRoom();
      else buckets.delete(key);
      buckets.set(key, bucket);
      return decision(bucket, maxFailures, now);
    },
    clear(headers) {
      buckets.delete(clientKey(headers));
    },
  };
}

export const loginRateLimiter = createLoginRateLimiter();
