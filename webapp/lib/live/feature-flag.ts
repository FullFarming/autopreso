/** Live Call feature flag (contract C9). Default true; disabled only when
 *  NEXT_PUBLIC_LIVE_CALL_ENABLED is explicitly "false". Base caption
 *  functionality is unaffected by this flag. */
export function isLiveCallEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.NEXT_PUBLIC_LIVE_CALL_ENABLED?.trim().toLowerCase() !== "false";
}

/** Build-time inlined variant for client components ("use client" files
 *  cannot read arbitrary process.env keys at runtime). */
export const LIVE_CALL_ENABLED = process.env.NEXT_PUBLIC_LIVE_CALL_ENABLED?.trim().toLowerCase() !== "false";
