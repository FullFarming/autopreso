import { isKnownInsecureSecret } from "./config";

const MINIMUM_STRONG_PASSWORD_LENGTH = 32;
const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u;

export interface HostLoginConfig {
  isEnabled: boolean;
  password: string;
  userIds: ReadonlySet<string>;
}

function parseUserIds(value: string | undefined): ReadonlySet<string> {
  const userIds = (value ?? "")
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (userIds.length > 20 || userIds.some((userId) => !HOST_ID_PATTERN.test(userId))) {
    throw new Error("호스트 로그인 아이디 설정이 올바르지 않습니다.");
  }
  return new Set(userIds);
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
    const userIds = parseUserIds(environment.LIVE_TEST_LOGIN_ID);
    const password = environment.LIVE_TEST_LOGIN_PASSWORD ?? "";
    if (userIds.size !== 1 || password.length < 1 || password.length > 256) {
      throw new Error("테스트 로그인 아이디와 비밀번호를 환경변수로 설정해야 합니다.");
    }
    return { isEnabled: true, password, userIds };
  }

  const userIds = parseUserIds(environment.ADMIN_USER_IDS);
  const password = environment.ADMIN_PASSWORD?.trim() ?? "";
  if (userIds.size === 0
    || password.length < MINIMUM_STRONG_PASSWORD_LENGTH
    || password.length > 256
    || isKnownInsecureSecret(password)) {
    if (isProduction) throw new Error("강한 호스트 로그인 환경변수 설정이 필요합니다.");
    return { isEnabled: false, password: "", userIds: new Set<string>() };
  }
  return { isEnabled: true, password, userIds };
}
