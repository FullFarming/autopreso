import { Buffer } from "node:buffer";

import { LiveSecurityConfigurationError } from "./config";

export type SupabaseAdminCredential = Readonly<{
  key: string;
  kind: "secret" | "legacy-service-role";
}>;

export interface SupabaseServerAccess {
  url: string;
  credential: SupabaseAdminCredential;
}

type Environment = Readonly<Record<string, string | undefined>>;

const NEW_SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9._-]{16,}$/u;
const NEW_PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9._-]{16,}$/u;

export function getSupabaseServerAccess(environment: Environment = process.env): SupabaseServerAccess {
  const url = getValidatedSupabaseUrl(environment);
  const secretKey = environment.SUPABASE_SECRET_KEY?.trim() ?? "";
  const legacyServiceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

  if (secretKey) {
    if (!NEW_SECRET_KEY_PATTERN.test(secretKey)) {
      throw new LiveSecurityConfigurationError("SUPABASE_SECRET_KEY 형식이 올바르지 않습니다.");
    }
    return { url, credential: { key: secretKey, kind: "secret" } };
  }

  if (!legacyServiceRoleKey) {
    throw new LiveSecurityConfigurationError("Supabase 서버 전용 Secret Key가 필요합니다.");
  }
  if (NEW_SECRET_KEY_PATTERN.test(legacyServiceRoleKey)) {
    throw new LiveSecurityConfigurationError("새 Supabase Secret Key는 SUPABASE_SECRET_KEY에 설정해야 합니다.");
  }
  if (getLegacyJwtRole(legacyServiceRoleKey) !== "service_role") {
    throw new LiveSecurityConfigurationError("Legacy Supabase service_role key 형식이 올바르지 않습니다.");
  }
  return { url, credential: { key: legacyServiceRoleKey, kind: "legacy-service-role" } };
}

export function getSupabasePublicAccess(environment: Environment = process.env): { url: string; publishableKey: string } {
  const serverAccess = getSupabaseServerAccess(environment);
  const publishableKey = (
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? environment.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? ""
  ).trim();
  if (!publishableKey || publishableKey === serverAccess.credential.key) {
    throw new LiveSecurityConfigurationError("Supabase 공개 Publishable Key가 필요합니다.");
  }
  if (!NEW_PUBLISHABLE_KEY_PATTERN.test(publishableKey) && getLegacyJwtRole(publishableKey) !== "anon") {
    throw new LiveSecurityConfigurationError("Supabase 공개 Publishable Key 형식이 올바르지 않습니다.");
  }
  return { url: serverAccess.url, publishableKey };
}

export function supabaseAdminHeaders(credential: SupabaseAdminCredential): Record<string, string> {
  const headers: Record<string, string> = { apikey: credential.key };
  if (credential.kind === "legacy-service-role") {
    headers.Authorization = `Bearer ${credential.key}`;
  }
  return headers;
}

function getValidatedSupabaseUrl(environment: Environment): string {
  if (environment.LIVE_EXTERNAL_ENV?.trim() !== "development") {
    throw new LiveSecurityConfigurationError("개발 외부 서비스 연결에는 LIVE_EXTERNAL_ENV=development가 필요합니다.");
  }
  const allowedProjectRef = environment.LIVE_ALLOWED_SUPABASE_REF?.trim() ?? "";
  if (!/^[a-z0-9-]+$/u.test(allowedProjectRef)) {
    throw new LiveSecurityConfigurationError("허용된 Supabase 개발 프로젝트가 필요합니다.");
  }

  const serverUrl = environment.SUPABASE_URL?.trim() ?? "";
  const publicUrl = environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!serverUrl && !publicUrl) {
    throw new LiveSecurityConfigurationError("Supabase 프로젝트 URL이 필요합니다.");
  }
  const parsedServerUrl = serverUrl ? parseProjectUrl(serverUrl, allowedProjectRef) : null;
  const parsedPublicUrl = publicUrl ? parseProjectUrl(publicUrl, allowedProjectRef) : null;
  if (parsedServerUrl && parsedPublicUrl && parsedServerUrl !== parsedPublicUrl) {
    throw new LiveSecurityConfigurationError("서버와 공개 Supabase 프로젝트 URL이 일치해야 합니다.");
  }
  const resolvedUrl = parsedServerUrl ?? parsedPublicUrl;
  if (!resolvedUrl) throw new LiveSecurityConfigurationError("Supabase 프로젝트 URL이 필요합니다.");
  return resolvedUrl;
}

function parseProjectUrl(value: string, allowedProjectRef: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:"
      || parsed.hostname !== `${allowedProjectRef}.supabase.co`
      || parsed.username
      || parsed.password
      || parsed.port
      || (parsed.pathname !== "/" && parsed.pathname !== "")
      || parsed.search
      || parsed.hash) {
      throw new Error("invalid Supabase project URL");
    }
    return parsed.origin;
  } catch {
    throw new LiveSecurityConfigurationError("Supabase 프로젝트 URL이 허용된 개발 프로젝트와 일치하지 않습니다.");
  }
}

function getLegacyJwtRole(value: string): string | null {
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment))) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || !("role" in payload)) return null;
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}
