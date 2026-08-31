import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LiveSessionService } from "./service";
import { MemoryLiveSessionStore, SupabaseLiveSessionStore } from "./store";
import { liveSessionRecoveryQuerySchema, restoreLiveSessionInputSchema } from "../security/live-input-validation";

test("recovery pagination accepts only bounded decimal offsets and its declared query fields", () => {
  assert.deepEqual(liveSessionRecoveryQuerySchema.parse({ scope: "mine" }), { scope: "mine", offset: 0 });
  assert.deepEqual(liveSessionRecoveryQuerySchema.parse({ scope: "mine", offset: "100" }), { scope: "mine", offset: 100 });
  for (const offset of ["", "-1", "1.5", "01", "1e2", "1000001", "Infinity", " 100", 100, null]) {
    assert.equal(liveSessionRecoveryQuerySchema.safeParse({ scope: "mine", offset }).success, false);
  }
  assert.equal(liveSessionRecoveryQuerySchema.safeParse({ scope: "mine", owner: "attacker" }).success, false);
  const route = readFileSync(new URL("../../app/api/live-sessions/route.ts", import.meta.url), "utf8");
  assert.match(route, /searchParams\.getAll\(key\)\.length !== 1/u);
  assert.match(route, /sessions: sessions\.slice\(0, 100\)\.map/u);
  assert.match(route, /nextOffset: sessions\.length > 100 \? offset \+ 100 : null/u);
});

test("restoration rejects invalid, overflow and surplus version input", () => {
  assert.deepEqual(restoreLiveSessionInputSchema.parse({ version: 1 }), { version: 1 });
  for (const version of [null, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER, 2_147_483_647]) {
    assert.equal(restoreLiveSessionInputSchema.safeParse({ version }).success, false);
  }
  assert.equal(restoreLiveSessionInputSchema.safeParse({ version: 1, hostId: "attacker" }).success, false);
});

test("saved active sessions survive their six-hour access window and restore without changing their identity", async () => {
  let now = Date.parse("2026-08-31T00:00:00Z");
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  for (const status of ["preparing", "live", "paused"] as const) {
    const created = await service.create("owner", { sessionType: "meeting", languages: ["ko"], title: status, scheduledAt: new Date(now + 60_000).toISOString() });
    const saved = await store.create({ ...created, status });
    assert.deepEqual(await service.restore("owner", saved.id, saved.version), saved);
    now += 7 * 60 * 60_000;
    assert.equal(await store.get(saved.id), null);
    assert.equal(await store.getSnapshot(saved.id, "ko"), null, "expired participant access remains closed");
    assert.ok((await service.listActive("owner")).some((session) => session.id === saved.id));
    assert.deepEqual(await store.getOwned(saved.id, "owner"), saved);
    assert.equal(await store.getOwned(saved.id, "another-owner"), null);
    await assert.rejects(service.restore("another-owner", saved.id, saved.version), /세션을 찾을 수 없습니다/u);
    const restored = await service.restore("owner", saved.id, saved.version);
    assert.deepEqual({ ...restored, expiresAt: saved.expiresAt, version: saved.version }, saved);
    assert.equal(restored.version, saved.version + 1);
    assert.equal(restored.expiresAt, new Date(now + 6 * 60 * 60_000).toISOString());
    await assert.rejects(service.restore("owner", saved.id, saved.version), /다른 변경/u);
    await service.end("owner", saved.id);
    await assert.rejects(service.restore("owner", saved.id, restored.version), /종료된 세션/u);
  }
});

test("Supabase owner reads include expired rows while participant reads retain expiry filtering", async () => {
  const calls: URL[] = [];
  const row = { id: crypto.randomUUID(), host_id: "owner", title: "Saved", scheduled_at: "2026-08-01T00:00:00Z",
    session_type: "meeting", output_mode: "captions", voice_provider: "gemini", status: "paused", languages: ["ko"],
    viewer_count: 0, version: 4, admission_state: "paused", admission_open_until: null, expires_at: "2026-08-01T06:00:00Z" };
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (url) => {
      const parsed = new URL(String(url)); calls.push(parsed);
      return Response.json(parsed.pathname.endsWith("/live_sessions") ? [row] : []);
    });
  const owned = await store.getOwned(row.id, "owner");
  assert.equal(owned?.scheduledAt, row.scheduled_at);
  const ownerQuery = calls.find((url) => url.pathname.endsWith("/live_sessions"));
  assert.equal(ownerQuery?.searchParams.get("host_id"), "eq.owner");
  assert.equal(ownerQuery?.searchParams.has("expires_at"), false);
  calls.length = 0;
  await store.get(row.id);
  assert.ok(calls.find((url) => url.pathname.endsWith("/live_sessions"))?.searchParams.get("expires_at")?.startsWith("gt."));
});

test("restore transport binds owner and expected version and handles an unchanged renewal version", async () => {
  const row = { id: crypto.randomUUID(), host_id: "owner", title: "Saved", scheduled_at: null,
    session_type: "meeting", output_mode: "captions", voice_provider: "gemini", status: "live", languages: ["ko"],
    viewer_count: 0, version: 4, admission_state: "open", admission_open_until: null, expires_at: "2026-09-01T00:00:00Z" };
  let renewals = 0;
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/renew_live_session_access_v1")) {
        renewals += 1;
        assert.deepEqual(JSON.parse(String(init?.body)), { p_session_id: row.id, p_host_id: "owner", p_expected_version: 4 });
        return Response.json(4);
      }
      return Response.json(parsed.pathname.endsWith("/live_sessions") ? [row] : []);
    });
  assert.equal((await store.renewAccessOwned(row.id, "owner", 4))?.version, 4);
  assert.equal(renewals, 1);
});

test("restore route authenticates and bounds version input while host GET uses the owner-only stored view", () => {
  const route = readFileSync(new URL("../../app/api/live-sessions/[id]/restore/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("assertStrictOrigin(request)") < route.indexOf("await requireHost(request)"));
  assert.ok(route.indexOf("await requireHost(request)") < route.indexOf("await readBoundedJsonBody(request)"));
  assert.match(route, /restoreLiveSessionInputSchema\.safeParse/u);
  assert.match(route, /\.restore\(hostId, sessionId, parsed\.data\.version\)/u);
  const getRoute = readFileSync(new URL("../../app/api/live-sessions/[id]/route.ts", import.meta.url), "utf8");
  assert.match(getRoute, /getLiveSessionStore\(\)\.getOwned\(id, hostId\)/u);
});

test("recovery reads one bounded page and keeps older sessions reachable by offset", async () => {
  const base = { host_id: "owner", title: "Saved", scheduled_at: null, session_type: "meeting", output_mode: "captions",
    voice_provider: "gemini", status: "preparing", languages: ["ko"], viewer_count: 0, version: 1,
    admission_state: "uninitialized", admission_open_until: null, expires_at: "2020-01-01T00:00:00Z" };
  const rows = Array.from({ length: 101 }, (_, index) => ({ ...base, id: `session-${index}` }));
  const offsets: number[] = [];
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (url) => {
      const query = new URL(String(url)).searchParams;
      assert.equal(query.get("host_id"), "eq.owner");
      assert.equal(query.has("expires_at"), false);
      assert.equal(query.get("status"), "in.(preparing,live,paused)");
      assert.equal(query.get("limit"), "101");
      assert.equal(query.get("order"), "created_at.desc,id.desc");
      const offset = Number(query.get("offset")); offsets.push(offset);
      return Response.json(rows.slice(offset, offset + Number(query.get("limit"))));
    });
  assert.equal((await store.listOwnedActive("owner")).length, 101);
  assert.deepEqual(offsets, [0], "one list request must issue exactly one database read");
  const secondPage = await store.listOwnedActive("owner", 100);
  assert.equal(secondPage.length, 1);
  assert.equal(secondPage[0]?.id, "session-100");
  assert.deepEqual(offsets, [0, 100]);
});

test("a cancel racing the renewal remains terminal and the renewal is never retried", async () => {
  const row = { id: crypto.randomUUID(), host_id: "owner", title: "Saved", scheduled_at: null,
    session_type: "meeting", output_mode: "captions", voice_provider: "gemini", status: "stopped", languages: ["ko"],
    viewer_count: 0, version: 5, admission_state: "ended", admission_open_until: null, expires_at: "2020-01-01T00:00:00Z" };
  let renewals = 0;
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/renew_live_session_access_v1")) {
        renewals += 1;
        return Response.json({ message: "VERSION_CONFLICT_OR_FORBIDDEN" }, { status: 400 });
      }
      return Response.json(parsed.pathname.endsWith("/live_sessions") ? [row] : []);
    });
  assert.equal(await store.renewAccessOwned(row.id, "owner", 4), null);
  assert.equal(renewals, 1);
});
