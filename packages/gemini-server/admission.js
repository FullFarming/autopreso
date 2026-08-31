import { isPlainObject, validateSessionId } from "./policy.js";

export const DEFAULT_GEMINI_LIMITS = Object.freeze({
  globalOutstanding: 8, sessionOutstanding: 2,
  globalRequestsPerMinute: 120, sessionRequestsPerMinute: 30,
  maximumTrackedSessions: 10_000,
});
const RATE_WINDOW_MILLISECONDS = 60_000;

export function createGeminiAdmissionController({ limits = DEFAULT_GEMINI_LIMITS, now }) {
  const normalizedLimits = validateGeminiLimits(limits);
  let globalOutstanding = 0;
  const sessionOutstanding = new Map();
  let globalRateWindow = { startedAt: now(), requests: 0 };
  const sessionRateWindows = new Map();

  function prepareRateBudget(sessionId) {
    const currentTime = now();
    const hasGlobalWindowExpired = currentTime - globalRateWindow.startedAt >= RATE_WINDOW_MILLISECONDS;
    const globalWindow = hasGlobalWindowExpired ? { startedAt: currentTime, requests: 0 } : globalRateWindow;
    if (hasGlobalWindowExpired) {
      for (const [trackedSessionId, window] of sessionRateWindows) {
        if (currentTime - window.startedAt >= RATE_WINDOW_MILLISECONDS) sessionRateWindows.delete(trackedSessionId);
      }
    }
    const priorSessionWindow = sessionRateWindows.get(sessionId);
    const sessionWindow = !priorSessionWindow
      || currentTime - priorSessionWindow.startedAt >= RATE_WINDOW_MILLISECONDS
      ? { startedAt: currentTime, requests: 0 }
      : priorSessionWindow;
    if (globalWindow.requests >= normalizedLimits.globalRequestsPerMinute) throw new Error("GEMINI_GLOBAL_RATE_LIMITED");
    if (sessionWindow.requests >= normalizedLimits.sessionRequestsPerMinute) throw new Error("GEMINI_SESSION_RATE_LIMITED");
    if (!priorSessionWindow && sessionRateWindows.size >= normalizedLimits.maximumTrackedSessions) {
      throw new Error("GEMINI_SESSION_RATE_STATE_EXHAUSTED");
    }
    return { globalWindow, sessionWindow };
  }

  return Object.freeze({
    acquire(sessionId) {
      validateSessionId(sessionId);
      if (globalOutstanding >= normalizedLimits.globalOutstanding) throw new Error("GEMINI_GLOBAL_BUDGET_EXHAUSTED");
      const currentSessionOutstanding = sessionOutstanding.get(sessionId) ?? 0;
      if (currentSessionOutstanding >= normalizedLimits.sessionOutstanding) throw new Error("GEMINI_SESSION_BUDGET_EXHAUSTED");
      const rateBudget = prepareRateBudget(sessionId);
      globalOutstanding += 1;
      sessionOutstanding.set(sessionId, currentSessionOutstanding + 1);
      globalRateWindow = { ...rateBudget.globalWindow, requests: rateBudget.globalWindow.requests + 1 };
      sessionRateWindows.set(sessionId, { ...rateBudget.sessionWindow, requests: rateBudget.sessionWindow.requests + 1 });
    },
    release(sessionId) {
      globalOutstanding -= 1;
      const next = (sessionOutstanding.get(sessionId) ?? 1) - 1;
      if (next === 0) sessionOutstanding.delete(sessionId);
      else sessionOutstanding.set(sessionId, next);
    },
    releaseSession(sessionId) {
      validateSessionId(sessionId);
      const window = sessionRateWindows.get(sessionId);
      // 2026-08-31 fix: reconnecting is not a fresh paid request allowance.
      // Keep the bounded rate history until its original window expires.
      if (window && now() - window.startedAt >= RATE_WINDOW_MILLISECONDS) sessionRateWindows.delete(sessionId);
    },
  });
}

export function validateGeminiLimits(value) {
  if (!isPlainObject(value)) throw new Error("INVALID_GEMINI_SERVER_LIMITS");
  const normalized = { ...DEFAULT_GEMINI_LIMITS, ...value };
  const allowedKeys = new Set(Object.keys(DEFAULT_GEMINI_LIMITS));
  if (Object.keys(value).some((key) => !allowedKeys.has(key))
    || !Number.isSafeInteger(normalized.globalOutstanding) || normalized.globalOutstanding < 1 || normalized.globalOutstanding > 100
    || !Number.isSafeInteger(normalized.sessionOutstanding) || normalized.sessionOutstanding < 1 || normalized.sessionOutstanding > normalized.globalOutstanding
    || !Number.isSafeInteger(normalized.globalRequestsPerMinute) || normalized.globalRequestsPerMinute < 1 || normalized.globalRequestsPerMinute > 10_000
    || !Number.isSafeInteger(normalized.sessionRequestsPerMinute) || normalized.sessionRequestsPerMinute < 1 || normalized.sessionRequestsPerMinute > normalized.globalRequestsPerMinute
    || !Number.isSafeInteger(normalized.maximumTrackedSessions) || normalized.maximumTrackedSessions < 1 || normalized.maximumTrackedSessions > 100_000) {
    throw new Error("INVALID_GEMINI_SERVER_LIMITS");
  }
  return normalized;
}
