import { getSupabaseServerAccess, type SupabaseAdminCredential } from "../security/supabase-server-access";

export interface LiveStoreConfig {
  baseUrl: string;
  credential: SupabaseAdminCredential;
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
