const SESSION_CACHE_MS = 60_000;
const FAILURE_COOLDOWN_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RENEW_WITHIN_MS = 7 * 86_400_000;

/** @typedef {"admin" | "host" | "legacy"} HostSessionRole */
/**
 * `role` is always present on a result this module produces; it stays optional
 * in the type because callers only ever read it as `data?.role === "admin"` and
 * older fixtures describe sessions without one.
 * @typedef {{ ok: boolean, data?: { userId: string, expiresAt: string, role?: HostSessionRole }, code?: string, retryAfterSeconds?: number }} HostSessionResult
 */

const HOST_SESSION_ROLES = new Set(["admin", "host", "legacy"]);

/**
 * `/api/auth/session` reports the profile role; anything unknown collapses to
 * `legacy` so a future role name can never unlock an admin-only surface here.
 * @returns {HostSessionRole}
 */
function readHostSessionRole(value) {
  return typeof value === "string" && HOST_SESSION_ROLES.has(value) ? /** @type {HostSessionRole} */ (value) : "legacy";
}

export function classifyDesktopLoginNavigation(value, baseUrl) {
  try {
    const target = new URL(value);
    const origin = new URL(baseUrl).origin;
    if (target.origin !== origin || target.username || target.password) return "blocked";
    if (target.pathname === "/login") return "login";
    if (target.pathname === "/admin" || target.pathname === "/admin/") return "authenticated";
  } catch { /* Untrusted navigation is denied. */ }
  return "blocked";
}

/** @param {{ baseUrl: string, fetcher: (url: string, options: RequestInit) => Promise<Response>, now?: () => number }} options */
export function createDesktopHostSession({ baseUrl, fetcher, now = Date.now }) {
  const origin = new URL(baseUrl).origin;
  /** @type {HostSessionResult | null} */
  let cached = null;
  let cacheUntil = 0;
  let retryAt = 0;
  let generation = 0;
  let unextendableSession = "";
  let isLoggingOut = false;
  /** @type {Promise<HostSessionResult> | null} */
  let pending = null;
  /** @type {Promise<HostSessionResult> | null} */
  let pendingLogout = null;

  /** @returns {Promise<HostSessionResult>} */
  async function request(pathname, method) {
    try {
      const response = await fetcher(new URL(pathname, origin).href, {
        method,
        credentials: "include",
        redirect: "error",
        headers: { origin, "content-type": "application/json", "cache-control": "no-store" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 429) {
        const value = response.headers.get("retry-after");
        const seconds = value && /^\d+$/u.test(value) ? Number(value)
          : value ? Math.ceil((Date.parse(value) - now()) / 1000) : Number(payload?.retryAfterSeconds);
        const retryAfterSeconds = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 60;
        retryAt = now() + retryAfterSeconds * 1000;
        return { ok: false, code: "RATE_LIMITED", retryAfterSeconds };
      }
      if (response.status === 401) return { ok: false, code: "HOST_LOGIN_REQUIRED" };
      if (!response.ok || payload?.ok !== true) {
        const code = typeof payload?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(payload.code)
          ? payload.code : `HTTP_${response.status}`;
        return { ok: false, code };
      }
      if (pathname === "/api/logout") return { ok: true };
      const data = payload.data;
      if (typeof data?.userId !== "string" || !data.userId.trim() || data.userId.length > 200
        || /[\u0000-\u001f\u007f]/u.test(data.userId)
        || typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt))
        || Date.parse(data.expiresAt) <= now()) return { ok: false, code: "INVALID_SESSION_RESPONSE" };
      return { ok: true, data: { userId: data.userId, expiresAt: data.expiresAt, role: readHostSessionRole(data.role) } };
    } catch {
      return { ok: false, code: "NETWORK_UNAVAILABLE" };
    }
  }

  /** @param {{ force?: boolean, refresh?: boolean }} [options] @returns {Promise<HostSessionResult>} */
  function ensureSession({ force = false, refresh = true } = {}) {
    if (isLoggingOut) return Promise.resolve({ ok: false, code: "HOST_LOGOUT_IN_PROGRESS" });
    if (retryAt > now()) return Promise.resolve({ ok: false, code: "RATE_LIMITED", retryAfterSeconds: Math.ceil((retryAt - now()) / 1000) });
    if (pending) return pending;
    if (!force && cached && now() < cacheUntil) return Promise.resolve(cached);
    const startedGeneration = generation;
    pending = (async () => {
      let result = await request("/api/auth/session", "GET");
      if (startedGeneration !== generation) return { ok: false, code: "HOST_LOGIN_REQUIRED" };
      if (refresh && result.ok && Date.parse(result.data.expiresAt) - now() <= RENEW_WITHIN_MS) {
        const sessionKey = JSON.stringify([result.data.userId, result.data.expiresAt]);
        if (sessionKey !== unextendableSession) {
          const previousExpiry = result.data.expiresAt;
          result = await request("/api/auth/session", "POST");
          if (result.ok && result.data.expiresAt === previousExpiry) unextendableSession = sessionKey;
        }
      }
      if (startedGeneration !== generation) return { ok: false, code: "HOST_LOGIN_REQUIRED" };
      cached = result;
      cacheUntil = now() + (result.ok ? Math.min(SESSION_CACHE_MS, Date.parse(result.data.expiresAt) - now()) : FAILURE_COOLDOWN_MS);
      return result;
    })().finally(() => { pending = null; });
    return pending;
  }

  function invalidate() {
    generation++;
    cached = null;
    cacheUntil = 0;
    unextendableSession = "";
  }

  /** @returns {Promise<HostSessionResult>} */
  function logout() {
    if (pendingLogout) return pendingLogout;
    isLoggingOut = true;
    invalidate();
    pendingLogout = (async () => {
      // 2026-08-31 fix: A refresh may set cookies when its response arrives.
      // Finish it before logout, while refusing every new session check.
      if (pending) await pending;
      const result = await request("/api/logout", "POST");
      invalidate();
      return result;
    })().finally(() => { isLoggingOut = false; pendingLogout = null; });
    return pendingLogout;
  }

  return {
    ensureSession,
    invalidate,
    logout,
    getSnapshot: () => cached ?? { ok: false, code: "HOST_LOGIN_REQUIRED" },
  };
}
