import { LiveSessionError } from './errors';
import type { LiveSessionStore } from './store';
import { getLiveStoreConfig } from './config';
import { supabaseAdminHeaders } from '../security/supabase-server-access';

type RenewalRpc = (name: string, payload: Record<string, string>) => Promise<unknown>;
const callRenewalRpc: RenewalRpc = async (name, payload) => {
  const config = getLiveStoreConfig();
  const response = await fetch(`${config.baseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(5_000),
    headers: { ...supabaseAdminHeaders(config.credential), 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new LiveSessionError('접근 권한을 연장하지 못했습니다.', 'ACCESS_RENEWAL_FAILED', 503);
  return response.json();
};

export async function renewHostSessionAccess(store: LiveSessionStore, sessionId: string, hostId: string) {
  const current = await store.getOwned(sessionId, hostId);
  if (!current || current.hostId !== hostId || !['preparing', 'live', 'paused'].includes(current.status)) {
    throw new LiveSessionError('연장할 수 있는 세션을 찾을 수 없습니다.', 'SESSION_NOT_FOUND', 404);
  }
  const renewed = await store.renewAccessOwned(sessionId, hostId, current.version);
  if (!renewed) throw new LiveSessionError('세션 상태가 변경되었습니다. 다시 확인해 주세요.', 'VERSION_CONFLICT', 409);
  return { expiresAt: renewed.expiresAt, version: renewed.version };
}

export async function renewViewerSessionAccess(
  identity: { sessionId: string; grantId: string; userId: string },
  rpc: RenewalRpc = callRenewalRpc,
  now: number = Date.now(),
): Promise<string> {
  const value = await rpc('renew_live_viewer_access_v1', {
    p_session_id: identity.sessionId, p_grant_id: identity.grantId, p_user_id: identity.userId,
  });
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || Date.parse(value) <= now || Date.parse(value) > now + 6 * 60 * 60_000 + 5_000) {
    throw new LiveSessionError('접근 연장 응답이 올바르지 않습니다.', 'INVALID_STORE_RESPONSE', 503);
  }
  return new Date(value).toISOString();
}
