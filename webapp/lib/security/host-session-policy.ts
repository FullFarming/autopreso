// 2026-08-31 fix: Edge와 Node가 같은 계정 허용 목록을 확인하되 비밀번호 해싱 모듈은 Edge로 가져오지 않는다.
export const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u;

export function parseHostUserIds(value: string | undefined): ReadonlySet<string> {
  const userIds = (value ?? "").split(",").map((candidate) => candidate.trim()).filter(Boolean);
  if (userIds.length > 20 || userIds.some((userId) => !HOST_ID_PATTERN.test(userId))) {
    throw new Error("호스트 로그인 아이디 설정이 올바르지 않습니다.");
  }
  return new Set(userIds);
}

// An auth.users uuid — the `profiles.host_id` a non-bootstrap approved profile carries in its
// cookie. Bootstrap admins keep their ADMIN_USER_IDS entry as host_id, so they never match here.
const PROFILE_HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isProfileBackedHostId(userId: string): boolean {
  return PROFILE_HOST_ID_PATTERN.test(userId);
}

export function isCurrentHostSessionUser(userId: string): boolean {
  try {
    const nodeEnvironment = process.env.NODE_ENV?.trim() ?? "development";
    if (process.env.LIVE_ALLOW_WEAK_TEST_LOGIN?.trim() === "true") {
      if (nodeEnvironment !== "development" && nodeEnvironment !== "test") return false;
      const userIds = parseHostUserIds(process.env.LIVE_TEST_LOGIN_ID);
      return userIds.size === 1 && userIds.has(userId);
    }
    return parseHostUserIds(process.env.ADMIN_USER_IDS).has(userId);
  } catch {
    return false;
  }
}
