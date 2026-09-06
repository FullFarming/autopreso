const MINIMUM_PRODUCTION_SECRET_LENGTH = 32;
const KNOWN_INSECURE_SECRET_VALUES = new Set([
  "changeme",
  "change-me",
  "placeholder",
  "your-secret-here",
]);

export function isKnownInsecureSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("replace-with-")
    || normalized.includes("change-before-production")
    || KNOWN_INSECURE_SECRET_VALUES.has(normalized);
}

function readRequiredProductionSecret(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (process.env.NODE_ENV !== "production") return value;
  if (!value || value.length < MINIMUM_PRODUCTION_SECRET_LENGTH || isKnownInsecureSecret(value)) {
    throw new Error(`${name} must be configured with a non-placeholder secret of at least ${MINIMUM_PRODUCTION_SECRET_LENGTH} characters`);
  }
  return value;
}

function parseOrigin(value: string): string {
  const parsed = new URL(value);
  const hasRootPath = parsed.pathname === "/" || (parsed.protocol === "chrome-extension:" && parsed.pathname === "");
  if (!hasRootPath || parsed.search || parsed.hash) {
    throw new Error(`Origin must not include a path: ${value}`);
  }
  if (parsed.protocol === "chrome-extension:") {
    if (!/^[a-p]{32}$/u.test(parsed.host)) throw new Error(`Chrome extension origin is invalid: ${value}`);
    return `chrome-extension://${parsed.host}`;
  }
  return parsed.origin;
}

export const LIVE_ADMISSION_PEPPER =
  readRequiredProductionSecret("LIVE_ADMISSION_PEPPER") ?? "local-live-admission-pepper-change-before-production";
export const LIVE_VIEWER_TOKEN_SECRET =
  readRequiredProductionSecret("LIVE_VIEWER_TOKEN_SECRET") ?? "local-live-viewer-token-secret-change-before-production";
export const LIVE_GATEWAY_TOKEN_SECRET =
  readRequiredProductionSecret("LIVE_GATEWAY_TOKEN_SECRET") ?? "local-live-gateway-token-secret-change-before-production";

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

// Existing host and pairing modules retain local-only defaults. Importing this
// module from middleware guarantees those defaults can never reach production.
readRequiredProductionSecret("SESSION_SECRET");
readRequiredProductionSecret("PAIR_SECRET");

// 2026-08-31 fix: 해시만 설정한 운영 환경도 로그인 설정과 같은 우선순위로 검증한다.
// This module runs in Edge middleware, so it must not import the Node scrypt helper.
if (process.env.NODE_ENV === "production") {
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
  if (adminPasswordHash !== undefined) {
    if (adminPasswordHash.length !== 171 || !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/u.test(adminPasswordHash)) {
      throw new Error("ADMIN_PASSWORD_HASH must contain a valid scrypt-v1 password hash");
    }
  } else {
    const adminPassword = process.env.ADMIN_PASSWORD?.trim() ?? "";
    if (adminPassword.length < 10 || adminPassword.length > 256 || isKnownInsecureSecret(adminPassword)) {
      throw new Error("ADMIN_PASSWORD must be configured with a non-placeholder password of 10 to 256 characters");
    }
  }
}

// 2026-07-19 security: mutating requests are fail-closed in production. Local
// development keeps explicit loopback origins so Host header spoofing cannot
// silently expand the allowlist.
export function getAllowedOrigins(): ReadonlySet<string> {
  const configured = [process.env.ALLOWED_ORIGINS, process.env.CHROME_EXTENSION_ORIGIN]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map(parseOrigin);

  if (configured.length === 0 && process.env.NODE_ENV === "production") {
    return new Set<string>();
  }
  return new Set(configured.length > 0 ? configured : ["http://localhost:3000", "http://127.0.0.1:3000"]);
}

export function getSupabaseServerConfig(environment: Readonly<Record<string, string | undefined>> = process.env): {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
} {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anonKey = environment.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !anonKey || !serviceRoleKey) {
    throw new LiveSecurityConfigurationError("Supabase 서버 인증 설정이 필요합니다.");
  }
  const parsedUrl = parseSupabaseProjectUrl(url, environment);
  if (parsedUrl.projectRef === null) {
    if (environment.LIVE_EXTERNAL_ENV?.trim() !== "development") {
      throw new LiveSecurityConfigurationError("로컬 Supabase 연결에는 LIVE_EXTERNAL_ENV=development가 필요합니다.");
    }
  } else {
    assertDevelopmentSupabaseProject(parsedUrl.projectRef, environment);
  }
  if (serviceRoleKey === anonKey) {
    throw new LiveSecurityConfigurationError("Supabase service role key와 anon key는 서로 달라야 합니다.");
  }
  return { url: parsedUrl.url, anonKey, serviceRoleKey };
}

export class LiveSecurityConfigurationError extends Error {}

function parseSupabaseProjectUrl(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): { url: string; projectRef: string | null } {
  try {
    const parsed = new URL(value);
    const hasRootPath = parsed.pathname === "/" || parsed.pathname === "";
    const isExactLocal = parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      && parsed.port === "54321"
      && !parsed.username
      && !parsed.password
      && hasRootPath
      && !parsed.search
      && !parsed.hash;
    if (isExactLocal
      && environment.NODE_ENV !== "production"
      && environment.LIVE_ALLOW_LOCAL_SUPABASE?.trim() === "true") {
      return { url: parsed.origin, projectRef: null };
    }
    const hostnameMatch = /^([a-z0-9-]+)\.supabase\.co$/u.exec(parsed.hostname);
    if (parsed.protocol !== "https:" || !hostnameMatch || parsed.port || !hasRootPath || parsed.search || parsed.hash) {
      throw new Error("invalid Supabase project URL");
    }
    return { url: parsed.origin, projectRef: hostnameMatch[1] };
  } catch {
    throw new LiveSecurityConfigurationError("Supabase 프로젝트 URL이 올바르지 않습니다.");
  }
}

function assertDevelopmentSupabaseProject(
  projectRef: string,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (environment.NODE_ENV === "production") return;
  if (environment.LIVE_EXTERNAL_ENV?.trim() !== "development") {
    throw new LiveSecurityConfigurationError("개발 외부 서비스 연결에는 LIVE_EXTERNAL_ENV=development가 필요합니다.");
  }
  const allowedProjectRef = environment.LIVE_ALLOWED_SUPABASE_REF?.trim() ?? "";
  if (!allowedProjectRef || projectRef !== allowedProjectRef) {
    throw new LiveSecurityConfigurationError("허용된 Supabase 개발 프로젝트와 일치하지 않습니다.");
  }
}
