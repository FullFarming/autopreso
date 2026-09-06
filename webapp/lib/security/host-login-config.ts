import { isKnownInsecureSecret } from "./config";
import { assertValidHostPasswordHash } from "./host-password";
import { parseHostUserIds } from "./host-session-policy";

// This service has no second authentication factor, so the production secret
// stays independently rate-limited. 2026-08-22 owner decision: the minimum
// length is 10 (single-operator deployment), lowered from the 16-char
// baseline the hardening pass originally proposed.
const MINIMUM_PASSWORD_LENGTH = 10;

export interface HostLoginConfig {
  isEnabled: boolean;
  password: string;
  passwordHash?: string;
  userIds: ReadonlySet<string>;
}

export function readHostLoginConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HostLoginConfig {
  const nodeEnvironment = environment.NODE_ENV?.trim() ?? "development";
  const isProduction = nodeEnvironment === "production";
  const allowsWeakTestLogin = environment.LIVE_ALLOW_WEAK_TEST_LOGIN?.trim() === "true";

  if (allowsWeakTestLogin) {
    if (isProduction || (nodeEnvironment !== "development" && nodeEnvironment !== "test")) {
      throw new Error("약한 테스트 로그인은 development/test 환경에서만 허용됩니다.");
    }
    const userIds = parseHostUserIds(environment.LIVE_TEST_LOGIN_ID);
    const password = environment.LIVE_TEST_LOGIN_PASSWORD ?? "";
    if (userIds.size !== 1 || password.length < 1 || password.length > 256) {
      throw new Error("테스트 로그인 아이디와 비밀번호를 환경변수로 설정해야 합니다.");
    }
    return { isEnabled: true, password, userIds };
  }

  const userIds = parseHostUserIds(environment.ADMIN_USER_IDS);
  const passwordHash = environment.ADMIN_PASSWORD_HASH;
  if (passwordHash !== undefined) {
    assertValidHostPasswordHash(passwordHash);
    if (userIds.size === 0) {
      if (isProduction) throw new Error("강한 호스트 로그인 환경변수 설정이 필요합니다.");
      return { isEnabled: false, password: "", userIds: new Set<string>() };
    }
    return { isEnabled: true, password: "", passwordHash, userIds };
  }
  const password = environment.ADMIN_PASSWORD?.trim() ?? "";
  if (userIds.size === 0
    || password.length < MINIMUM_PASSWORD_LENGTH
    || password.length > 256
    || isKnownInsecureSecret(password)) {
    if (isProduction) throw new Error("강한 호스트 로그인 환경변수 설정이 필요합니다.");
    return { isEnabled: false, password: "", userIds: new Set<string>() };
  }
  return { isEnabled: true, password, userIds };
}
