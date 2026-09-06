import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renewHostSessionAccess, renewViewerSessionAccess } from './access-renewal';
import { MemoryLiveSessionStore } from './store';
import { LiveSessionService } from './service';
import { isViewerSnapshotPath } from '../security/csrf';

test('host renews before expiry while other hosts and stopped sessions remain denied', async () => {
  let now = Date.parse('2026-09-05T00:00:00Z');
  const store = new MemoryLiveSessionStore(() => now);
  const session = await new LiveSessionService(store, () => now).create('owner', { sessionType: 'meeting', languages: ['ko','en','ja'] });
  const initial = await renewHostSessionAccess(store, session.id, 'owner');
  assert.equal(initial.version, session.version);
  now = Date.parse(session.expiresAt) - 10 * 60_000;
  const renewed = await renewHostSessionAccess(store, session.id, 'owner');
  assert.equal(renewed.version, session.version + 1);
  assert.equal(Date.parse(renewed.expiresAt), now + 6 * 60 * 60_000);
  await assert.rejects(renewHostSessionAccess(store, session.id, 'other'), /찾을 수 없습니다/);
  await store.create({ ...session, status: 'stopped' });
  await assert.rejects(renewHostSessionAccess(store, session.id, 'owner'), /찾을 수 없습니다/);
});

test('viewer renewal sends only signed identity and rejects unbounded or malformed database output', async () => {
  const now = Date.parse('2026-09-05T00:00:00Z');
  const identity = { sessionId: 'session', grantId: 'grant', userId: 'viewer' };
  const deadline = new Date(now + 3_600_000).toISOString();
  const result = await renewViewerSessionAccess(identity, async (name, payload) => {
    assert.equal(name, 'renew_live_viewer_access_v1');
    assert.deepEqual(payload, { p_session_id: 'session', p_grant_id: 'grant', p_user_id: 'viewer' });
    return deadline;
  }, now);
  assert.equal(result, deadline);
  for (const invalid of [null, {}, 'bad', new Date(now).toISOString(), new Date(now + 7 * 3_600_000).toISOString()]) {
    await assert.rejects(renewViewerSessionAccess(identity, async () => invalid, now), /올바르지 않습니다/);
  }
});

test('renewal route checks origin before identity, binds session and bounds signed cookie', () => {
  const route = readFileSync(new URL('../../app/api/live-sessions/[id]/access/route.ts', import.meta.url), 'utf8');
  assert.ok(route.indexOf('assertStrictOrigin(request)') < route.indexOf('await requireHost(request)'));
  assert.match(route, /claims\.sessionId !== sessionId/);
  assert.match(route, /createViewerGrantToken\([\s\S]*Math\.min\(Date\.parse\(expiresAt\)/);
  assert.match(route, /httpOnly: true, secure: isProductionRuntime\(\), sameSite: 'lax'/);
});

test('heartbeat is independent of media and cancels in-flight renewal on session exit', () => {
  const hook = readFileSync(new URL('./use-access-renewal.ts', import.meta.url), 'utf8');
  assert.match(hook, /void renew\(\)/);
  assert.match(hook, /5 \* 60_000/);
  assert.match(hook, /controller\.abort\(\)/);
  assert.match(hook, /callbacks\.current\.onError/);
  assert.doesNotMatch(hook, /setSessionStatus|terminate|viewerCount|microphone/);
});

test('viewer renewal reaches its signed-grant handler without a host cookie', () => {
  const path = '/api/live-sessions/00000000-0000-4000-8000-000000000001/access';
  assert.equal(isViewerSnapshotPath(path, 'POST'), true);
  assert.equal(isViewerSnapshotPath(path, 'GET'), false);
});
