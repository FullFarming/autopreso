import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ENGINE_SELECTION } from "../../../packages/caption-core/caption-engine-catalog.js";
import { ConsoleStoreError, SupabaseConsoleStore, __setConsoleStoreForTests, getConsoleStore } from "./console-store";

const ADMIN = "00000000-0000-4000-8000-000000000011";
const TARGET = "00000000-0000-4000-8000-000000000022";
const SESSION = "00000000-0000-4000-8000-000000000033";
const access = () => ({ url: "https://project.supabase.test", credential: { key: "fixture-secret", kind: "secret" as const } });

function storeWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const store = new SupabaseConsoleStore({
    fetchFn: async (input, init) => { calls.push({ url: String(input), init: init ?? {} }); return handler(String(input), init ?? {}); },
    getServerAccess: access,
  });
  return { store, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const body = (call: { init: RequestInit }) => JSON.parse(String(call.init.body));

test("listProfiles posts { p_status, p_limit, p_before } with the secret credential and maps snake_case rows", async () => {
  const { store, calls } = storeWith(() => json([{
    id: TARGET, email: "b@x.io", display_name: "Bee", status: "pending", role: "host", host_id: TARGET,
    created_at: "2026-09-02T00:00:00+00:00", last_login_at: null, approved_at: null,
  }]));
  const rows = await store.listProfiles({ status: "pending", limit: 20, before: "2026-09-03T00:00:00.000Z" });
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/list_profiles_admin_v2");
  assert.deepEqual(body(calls[0]), { p_status: "pending", p_limit: 20, p_before: "2026-09-03T00:00:00.000Z" });
  assert.equal(new Headers(calls[0].init.headers).get("apikey"), "fixture-secret");
  assert.deepEqual(rows, [{
    id: TARGET, email: "b@x.io", displayName: "Bee", status: "pending", role: "host", hostId: TARGET,
    createdAt: "2026-09-02T00:00:00+00:00", lastLoginAt: null, approvedAt: null, voiceProvider: "soniox", voiceProviderRevision: "1",
  }]);
  const all = storeWith(() => json([]));
  assert.deepEqual(await all.store.listProfiles({}), []);
  assert.deepEqual(body(all.calls[0]), { p_status: null, p_limit: 50, p_before: null });
});

test("countPending returns the scalar and rejects non-integers", async () => {
  assert.equal(await storeWith(() => json(3)).store.countPending(), 3);
  await assert.rejects(storeWith(() => json("many")).store.countPending(), (e: ConsoleStoreError) => e.code === "CONSOLE_ROW_INVALID" && e.status === 502);
});

test("setProfileStatus posts actor/profile/status/reason and maps SQL guard tokens to typed errors", async () => {
  const { store, calls } = storeWith(() => json([{ id: TARGET, status: "approved", role: "host" }]));
  assert.deepEqual(await store.setProfileStatus({ actorId: ADMIN, profileId: TARGET, status: "approved" }), { id: TARGET, status: "approved", role: "host" });
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/set_profile_status_v1");
  assert.deepEqual(body(calls[0]), { p_actor_id: ADMIN, p_profile_id: TARGET, p_status: "approved", p_reason: null });
  // PostgREST surfaces `raise exception 'LAST_ADMIN_PROTECTED' using errcode = '42501'` as HTTP 403 with the token in `message`.
  await assert.rejects(
    storeWith(() => json({ message: "LAST_ADMIN_PROTECTED", code: "42501", details: null, hint: null }, 403)).store.setProfileStatus({ actorId: ADMIN, profileId: TARGET, status: "disabled", reason: "bye" }),
    (e: ConsoleStoreError) => e instanceof ConsoleStoreError && e.code === "LAST_ADMIN_PROTECTED" && e.status === 409,
  );
  const cases: Array<[string, string, number]> = [
    ["ACTOR_NOT_ADMIN", "42501", 403], ["SELF_CHANGE_FORBIDDEN", "42501", 403], ["INVALID_TRANSITION", "22023", 409],
    ["PROFILE_NOT_FOUND", "P0002", 404], ["INVALID_ROLE", "22023", 400], ["ENGINE_INVALID", "22023", 400],
  ];
  for (const [token, sqlstate, status] of cases) {
    await assert.rejects(
      storeWith(() => json({ message: token, code: sqlstate }, 400)).store.setProfileRole({ actorId: ADMIN, profileId: TARGET, role: "admin" }),
      (e: ConsoleStoreError) => e.code === token && e.status === status,
      token,
    );
  }
});

test("setProfileRole posts p_role and maps the returned row", async () => {
  const { store, calls } = storeWith(() => json([{ id: TARGET, status: "approved", role: "admin" }]));
  assert.deepEqual(await store.setProfileRole({ actorId: ADMIN, profileId: TARGET, role: "admin" }), { id: TARGET, status: "approved", role: "admin" });
  assert.deepEqual(body(calls[0]), { p_actor_id: ADMIN, p_profile_id: TARGET, p_role: "admin" });
});

test("listSessions posts { p_since, p_limit } and maps aggregates, coercing bigint counts", async () => {
  const { store, calls } = storeWith(() => json([{
    id: SESSION, title: null, host_id: "noel", host_email: "a@x.io", mode: "meeting", status: "ended", languages: ["ko", "en"],
    created_at: "2026-09-01T00:00:00+00:00", ended_at: "2026-09-01T01:00:00+00:00", utterance_count: "12", participant_count: 3, summary_status: "succeeded",
  }]));
  const rows = await store.listSessions({ since: "2026-08-27T00:00:00.000Z", limit: 200 });
  assert.deepEqual(body(calls[0]), { p_since: "2026-08-27T00:00:00.000Z", p_limit: 200 });
  assert.deepEqual(rows, [{
    id: SESSION, title: null, hostId: "noel", hostEmail: "a@x.io", mode: "meeting", status: "ended", languages: ["ko", "en"],
    createdAt: "2026-09-01T00:00:00+00:00", endedAt: "2026-09-01T01:00:00+00:00", utteranceCount: 12, participantCount: 3, summaryStatus: "succeeded",
  }]);
  const all = storeWith(() => json([]));
  await all.store.listSessions({});
  assert.deepEqual(body(all.calls[0]), { p_since: null, p_limit: 100 });
});

test("readSettings maps a fresh project (engine null, no updater) and a configured one", async () => {
  const fresh = await storeWith(() => json([{ legacy_password_login_enabled: true, engine: null, engine_updated_at: null, engine_updated_by_email: null }])).store.readSettings();
  assert.deepEqual(fresh, { legacyPasswordLoginEnabled: true, engine: null, engineUpdatedAt: null, engineUpdatedByEmail: null });
  const set = await storeWith(() => json([{ legacy_password_login_enabled: false, engine: DEFAULT_ENGINE_SELECTION, engine_updated_at: "2026-09-03T00:00:00+00:00", engine_updated_by_email: "a@x.io" }])).store.readSettings();
  assert.deepEqual(set, { legacyPasswordLoginEnabled: false, engine: DEFAULT_ENGINE_SELECTION, engineUpdatedAt: "2026-09-03T00:00:00+00:00", engineUpdatedByEmail: "a@x.io" });
  await assert.rejects(storeWith(() => json([])).store.readSettings(), (e: ConsoleStoreError) => e.code === "CONSOLE_ROW_INVALID" && e.status === 502);
});

test("setLegacyPasswordLogin posts p_enabled and requires a true ack", async () => {
  const { store, calls } = storeWith(() => json(true));
  await store.setLegacyPasswordLogin({ actorId: ADMIN, enabled: false });
  assert.deepEqual(body(calls[0]), { p_actor_id: ADMIN, p_enabled: false });
  await assert.rejects(storeWith(() => json(false)).store.setLegacyPasswordLogin({ actorId: ADMIN, enabled: true }), (e: ConsoleStoreError) => e.code === "CONSOLE_WRITE_FAILED" && e.status === 503);
});

test("unknown RPC failures and network errors map to 503 CONSOLE_STORE_UNAVAILABLE without leaking the body", async () => {
  await assert.rejects(storeWith(() => json({ message: "boom secret", code: "PGRST202" }, 404)).store.countPending(), (e: ConsoleStoreError) => e.code === "CONSOLE_STORE_UNAVAILABLE" && e.status === 503 && !e.message.includes("boom"));
  await assert.rejects(storeWith(() => { throw new TypeError("fetch failed"); }).store.countPending(), (e: ConsoleStoreError) => e.code === "CONSOLE_STORE_UNAVAILABLE" && e.status === 503);
});

test("getConsoleStore returns one module singleton and the test seam swaps it", () => {
  const fake = storeWith(() => json([])).store;
  try {
    __setConsoleStoreForTests(fake);
    assert.equal(getConsoleStore(), fake);
  } finally {
    __setConsoleStoreForTests(null);
  }
  const real = getConsoleStore();
  assert.ok(real instanceof SupabaseConsoleStore);
  assert.notEqual(real, fake);
  assert.equal(getConsoleStore(), real);
});

test("listActiveSessionsForHost posts { p_host_id } to list_live_session_ids_for_host_admin_v1 and maps id/status/languages", async () => {
  const { store, calls } = storeWith(() => json([
    { id: SESSION, status: "live", languages: ["ko", "en"] },
    { id: TARGET, status: "preparing", languages: ["ja"] },
  ]));
  assert.deepEqual(await store.listActiveSessionsForHost(TARGET), [
    { id: SESSION, status: "live", languages: ["ko", "en"] },
    { id: TARGET, status: "preparing", languages: ["ja"] },
  ]);
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/list_live_session_ids_for_host_admin_v1");
  assert.deepEqual(body(calls[0]), { p_host_id: TARGET });
  assert.deepEqual(await storeWith(() => json([])).store.listActiveSessionsForHost("noel"), []);
  await assert.rejects(storeWith(() => json([{ id: "not-a-uuid", status: "live", languages: [] }])).store.listActiveSessionsForHost(TARGET), (e: ConsoleStoreError) => e.code === "CONSOLE_ROW_INVALID" && e.status === 502);
  await assert.rejects(storeWith(() => json({ id: SESSION })).store.listActiveSessionsForHost(TARGET), (e: ConsoleStoreError) => e.code === "CONSOLE_ROW_INVALID");
});

test("setSessionEngineAsAdmin normalizes the engine, posts actor/session/engine/revision to the v2 RPC, maps the row, and returns null for no match", async () => {
  const engine = { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" }, translation: { provider: "soniox", model: "stt-rt-v5" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } };
  const { store, calls } = storeWith(() => json([{ id: SESSION, status: "live", version: 4 }]));
  assert.deepEqual(await store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine, assignmentRevision: "7" }), { id: SESSION, status: "live", version: 4 });
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/set_live_session_engine_admin_v2");
  assert.deepEqual(body(calls[0]), { p_actor_id: ADMIN, p_session_id: SESSION, p_engine: engine, p_assignment_revision: "7" });
  // without a revision the stored one is left alone (null, not undefined - PostgREST needs the key)
  const bare = storeWith(() => json([{ id: SESSION, status: "live", version: 5 }]));
  await bare.store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine });
  assert.deepEqual(body(bare.calls[0]), { p_actor_id: ADMIN, p_session_id: SESSION, p_engine: engine, p_assignment_revision: null });
  // a malformed revision is refused locally, before any request
  const badRevision = storeWith(() => json([]));
  await assert.rejects(badRevision.store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine, assignmentRevision: "0x1" }), (e: ConsoleStoreError) => e.code === "ASSIGNMENT_REVISION_INVALID" && e.status === 400);
  assert.equal(badRevision.calls.length, 0);
  await assert.rejects(
    storeWith(() => json({ message: "ASSIGNMENT_REVISION_INVALID", code: "22023" }, 400)).store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine: DEFAULT_ENGINE_SELECTION }),
    (e: ConsoleStoreError) => e.code === "ASSIGNMENT_REVISION_INVALID" && e.status === 400,
  );
  // the RPC returns no row for stopped / archived / unknown sessions: not an error
  assert.equal(await storeWith(() => json([])).store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine: DEFAULT_ENGINE_SELECTION }), null);
  // a non-catalog engine is refused locally without a request
  const invalid = storeWith(() => json([]));
  await assert.rejects(
    invalid.store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine: { stt: { provider: "gemini", model: "nope" } } as never }),
    (e: ConsoleStoreError) => e.code === "ENGINE_INVALID" && e.status === 400,
  );
  assert.equal(invalid.calls.length, 0);
  // SQL guard tokens surface as typed errors
  await assert.rejects(
    storeWith(() => json({ message: "ENGINE_INVALID", code: "22023" }, 400)).store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine: DEFAULT_ENGINE_SELECTION }),
    (e: ConsoleStoreError) => e.code === "ENGINE_INVALID" && e.status === 400,
  );
  await assert.rejects(
    storeWith(() => json({ message: "ACTOR_NOT_ADMIN", code: "42501" }, 403)).store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine: DEFAULT_ENGINE_SELECTION }),
    (e: ConsoleStoreError) => e.code === "ACTOR_NOT_ADMIN" && e.status === 403,
  );
  // malformed rows (two rows, non-integer version) are a 502
  await assert.rejects(storeWith(() => json([{ id: SESSION, status: "live", version: 4 }, { id: TARGET, status: "live", version: 1 }])).store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine: DEFAULT_ENGINE_SELECTION }), (e: ConsoleStoreError) => e.code === "CONSOLE_ROW_INVALID");
  await assert.rejects(storeWith(() => json([{ id: SESSION, status: "live", version: "4" }])).store.setSessionEngineAsAdmin({ actorId: ADMIN, sessionId: SESSION, engine: DEFAULT_ENGINE_SELECTION }), (e: ConsoleStoreError) => e.code === "CONSOLE_ROW_INVALID");
});

test("recordEngineDeploy posts the deploy counters next to the engine and the target user as p_payload and requires a true ack", async () => {
  const { store, calls } = storeWith(() => json(true));
  await store.recordEngineDeploy({ actorId: ADMIN, engine: DEFAULT_ENGINE_SELECTION, summary: { switched: 2, queued: 1, failed: 3 }, target: { profileId: TARGET, hostId: "noel", voiceProvider: "gemini", revision: "3" } });
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/record_console_deploy_v1");
  assert.deepEqual(body(calls[0]), { p_actor_id: ADMIN, p_payload: {
    engine: DEFAULT_ENGINE_SELECTION, sessionsSwitched: 2, sessionsFailed: 3, sessionsQueued: 1,
    targetProfileId: TARGET, targetHostId: "noel", provider: "gemini", revision: "3",
  } });
  await assert.rejects(storeWith(() => json(false)).store.recordEngineDeploy({ actorId: ADMIN, engine: DEFAULT_ENGINE_SELECTION, summary: { switched: 0, queued: 0, failed: 0 }, target: { profileId: TARGET, hostId: "noel", voiceProvider: "soniox", revision: "1" } }), (e: ConsoleStoreError) => e.code === "CONSOLE_WRITE_FAILED" && e.status === 503);
});

test("setProfileVoiceProvider posts to the v2 RPC and maps the profile identity next to the assignment", async () => {
  const { store, calls } = storeWith(() => json([{ id: TARGET, status: "approved", role: "host", host_id: "noel", provider: "gemini", revision: 3 }]));
  assert.deepEqual(await store.setProfileVoiceProvider({ actorId: ADMIN, profileId: TARGET, provider: "gemini" }), {
    id: TARGET, status: "approved", role: "host", hostId: "noel", provider: "gemini", revision: "3",
  });
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/set_profile_voice_provider_v2");
  assert.deepEqual(body(calls[0]), { p_actor_id: ADMIN, p_profile_id: TARGET, p_provider: "gemini" });
  for (const row of [
    { id: TARGET, status: "approved", role: "host", provider: "gemini", revision: 3 },
    { id: TARGET, status: "approved", role: "host", host_id: "noel", provider: "whisper", revision: 3 },
    { id: TARGET, status: "approved", role: "host", host_id: "noel", provider: "gemini", revision: "abc" },
    { id: TARGET, status: "unknown", role: "host", host_id: "noel", provider: "gemini", revision: 3 },
  ]) {
    await assert.rejects(storeWith(() => json([row])).store.setProfileVoiceProvider({ actorId: ADMIN, profileId: TARGET, provider: "gemini" }), (e: ConsoleStoreError) => e.code === "CONSOLE_ROW_INVALID", JSON.stringify(row));
  }
  await assert.rejects(storeWith(() => json([])).store.setProfileVoiceProvider({ actorId: ADMIN, profileId: TARGET, provider: "gemini" }), (e: ConsoleStoreError) => e.code === "CONSOLE_ROW_INVALID");
  await assert.rejects(
    storeWith(() => json({ message: "VOICE_PROVIDER_INVALID", code: "22023" }, 400)).store.setProfileVoiceProvider({ actorId: ADMIN, profileId: TARGET, provider: "gemini" }),
    (e: ConsoleStoreError) => e.code === "VOICE_PROVIDER_INVALID" && e.status === 400,
  );
});
