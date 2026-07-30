import { getSupabaseServerAccess, type SupabaseAdminCredential } from "../security/supabase-server-access";
import { LiveSecurityConfigurationError } from "../security/config";

export interface LiveStoreConfig {
  baseUrl: string;
  credential: SupabaseAdminCredential;
}

export interface MeetingSummaryConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMilliseconds: number;
}

const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 4_000;
const DEFAULT_SUMMARY_TIMEOUT_MILLISECONDS = 45_000;

export function getLiveStoreConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LiveStoreConfig {
  const { url, credential } = getSupabaseServerAccess(environment);
  return {
    baseUrl: url,
    credential,
  };
}

export function getMeetingSummaryConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MeetingSummaryConfig {
  const apiKey = environment.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) throw new LiveSecurityConfigurationError("OPENAI_API_KEY가 설정되지 않았습니다.");
  return {
    apiKey,
    model: environment.OPENAI_SUMMARY_MODEL?.trim() || "gpt-5.6-luna",
    maxOutputTokens: readBoundedPositiveInteger(
      "OPENAI_SUMMARY_MAX_OUTPUT_TOKENS",
      environment.OPENAI_SUMMARY_MAX_OUTPUT_TOKENS,
      DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
      512,
      8_000,
    ),
    timeoutMilliseconds: readBoundedPositiveInteger(
      "OPENAI_SUMMARY_TIMEOUT_MILLISECONDS",
      environment.OPENAI_SUMMARY_TIMEOUT_MILLISECONDS,
      DEFAULT_SUMMARY_TIMEOUT_MILLISECONDS,
      5_000,
      120_000,
    ),
  };
}

function readBoundedPositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new LiveSecurityConfigurationError(`${name} 값은 ${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return parsed;
}
