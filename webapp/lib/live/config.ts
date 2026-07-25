import { getSupabaseServerAccess, type SupabaseAdminCredential } from "../security/supabase-server-access";
import { LiveSecurityConfigurationError } from "../security/config";

export interface LiveStoreConfig {
  baseUrl: string;
  credential: SupabaseAdminCredential;
}

export interface MeetingSummaryConfig {
  apiKey: string;
  model: string;
}

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
  };
}
