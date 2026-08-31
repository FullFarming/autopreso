export type HostSessionSyncResult = { kind: "authenticated" | "signed-out" | "unavailable" };
type HostSession = { userId: string; expiresAt: string };
type SessionFetch = (url: string, options: RequestInit) => Promise<Response>;
const CHECK_INTERVAL_MS = 5 * 60_000;
const REFRESH_WINDOW_MS = 7 * 86_400_000;

function parseSession(value: unknown, now: number): HostSession | null {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("data" in value)) return null;
  const data = value.data;
  if (!data || typeof data !== "object" || !("userId" in data) || !("expiresAt" in data)
    || typeof data.userId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u.test(data.userId)
    || typeof data.expiresAt !== "string" || !(Date.parse(data.expiresAt) > now)) return null;
  return { userId: data.userId, expiresAt: data.expiresAt };
}

async function serializeSessionChange<T>(operation: () => Promise<T>): Promise<T> {
  // 2026-08-31 fix: 같은 브라우저의 다른 탭도 refresh 응답 뒤에 logout 쿠키를 지운다.
  // Web Locks 미지원 환경에서는 아래 클라이언트의 단일 실행이 현재 페이지를 보호한다.
  if (typeof navigator !== "undefined" && navigator.locks) return await navigator.locks.request("nova-host-session", operation);
  return await operation();
}

export function createHostSessionClient(fetchSession: SessionFetch = (url, options) => fetch(url, options), now: () => number = Date.now) {
  let pendingCheck: Promise<HostSessionSyncResult> | null = null;
  let pendingLogout: Promise<void> | null = null;
  let hasSignedOut = false;
  let checkedAt: number | null = null;
  let unextendableExpiry: string | null = null;

  const request = (url: string, method: "GET" | "POST") => fetchSession(url, {
    method, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
  });

  async function check(): Promise<HostSessionSyncResult> {
    if (hasSignedOut) return { kind: "signed-out" };
    try {
      const response = await request("/api/auth/session", "GET");
      if (response.status === 401) return { kind: "signed-out" };
      if (!response.ok) return { kind: "unavailable" };
      const value: unknown = await response.json();
      const session = parseSession(value, now());
      if (!session) return { kind: "unavailable" };
      if (hasSignedOut) return { kind: "signed-out" };
      if (Date.parse(session.expiresAt) - now() <= REFRESH_WINDOW_MS && unextendableExpiry !== session.expiresAt) {
        const renewed = await request("/api/auth/session", "POST");
        if (renewed.status === 401) return { kind: "signed-out" };
        if (!renewed.ok) return { kind: "unavailable" };
        const renewedValue: unknown = await renewed.json();
        const next = parseSession(renewedValue, now());
        if (!next || next.userId !== session.userId) return { kind: "unavailable" };
        if (next.expiresAt === session.expiresAt) unextendableExpiry = next.expiresAt;
      }
      if (hasSignedOut) return { kind: "signed-out" };
      checkedAt = now();
      return { kind: "authenticated" };
    } catch {
      return { kind: hasSignedOut ? "signed-out" : "unavailable" };
    }
  }

  function synchronize(): Promise<HostSessionSyncResult> {
    if (hasSignedOut) return Promise.resolve({ kind: "signed-out" });
    if (pendingCheck) return pendingCheck;
    if (checkedAt !== null && now() - checkedAt < CHECK_INTERVAL_MS) return Promise.resolve({ kind: "authenticated" });
    pendingCheck = serializeSessionChange(check).finally(() => { pendingCheck = null; });
    return pendingCheck;
  }

  function logout(): Promise<void> {
    if (pendingLogout) return pendingLogout;
    hasSignedOut = true;
    checkedAt = null;
    pendingLogout = (async () => {
      // Abort만으로는 이미 도착 중인 Set-Cookie를 취소할 수 없어 응답 완료를 기다린다.
      await pendingCheck;
      await serializeSessionChange(async () => {
        const response = await request("/api/logout", "POST");
        if (!response.ok) throw new Error("HOST_LOGOUT_UNAVAILABLE");
      });
    })().finally(() => { pendingLogout = null; });
    return pendingLogout;
  }

  return { synchronize, logout };
}

const hostSessionClient = createHostSessionClient();
export const synchronizeHostSession = hostSessionClient.synchronize;
export const logoutHostSession = hostSessionClient.logout;
