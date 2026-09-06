import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ProfileStoreError, SupabaseProfileStore } from "./profile-store";

const access = () => ({ url: "https://project.supabase.test", credential: { key: "fixture-secret", kind: "secret" as const } });
const publicAccess = () => ({ url: "https://project.supabase.test", publishableKey: "fixture-publishable" });

function storeWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const store = new SupabaseProfileStore({
    fetchFn: async (input, init) => { calls.push({ url: String(input), init: init ?? {} }); return handler(String(input), init ?? {}); },
    getServerAccess: access, getPublicAccess: publicAccess,
  });
  return { store, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("verifyAccessToken calls /auth/v1/user with the publishable apikey and the user's bearer token, never the secret", async () => {
  const { store, calls } = storeWith(() => json({ id: "00000000-0000-4000-8000-000000000011", email: "A@Example.com", email_confirmed_at: "2026-09-01T00:00:00Z", user_metadata: { full_name: "Noel Kim" } }));
  const user = await store.verifyAccessToken("fixture-access-token");
  assert.deepEqual(user, { id: "00000000-0000-4000-8000-000000000011", email: "a@example.com", emailConfirmed: true, displayName: "Noel Kim" });
  assert.equal(calls[0].url, "https://project.supabase.test/auth/v1/user");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("apikey"), "fixture-publishable");
  assert.equal(headers.get("authorization"), "Bearer fixture-access-token");
  assert.equal(JSON.stringify(calls).includes("fixture-secret"), false);
});

test("verifyAccessToken rejects 401, missing email, and unconfirmed email with typed errors", async () => {
  // Uses the 20-char fixture string: shorter tokens are rejected before any fetch.
  await assert.rejects(storeWith(() => json({ message: "invalid" }, 401)).store.verifyAccessToken("fixture-access-token"), (e: ProfileStoreError) => e.code === "AUTH_TOKEN_INVALID" && e.status === 401);
  await assert.rejects(storeWith(() => json({ id: "00000000-0000-4000-8000-000000000011" })).store.verifyAccessToken("fixture-access-token"), (e: ProfileStoreError) => e.code === "AUTH_EMAIL_MISSING");
  const unconfirmed = await storeWith(() => json({ id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", email_confirmed_at: null })).store.verifyAccessToken("fixture-access-token");
  assert.equal(unconfirmed.emailConfirmed, false);
});

test("verifyAccessToken rejects malformed tokens before contacting the auth service", async () => {
  const { store, calls } = storeWith(() => json({ id: "00000000-0000-4000-8000-000000000011", email: "a@b.io" }));
  await assert.rejects(store.verifyAccessToken("x"), (e: ProfileStoreError) => e.code === "AUTH_TOKEN_INVALID" && e.status === 401);
  assert.equal(calls.length, 0);
});

test("upsertOnLogin posts the RPC with the secret credential and maps the row", async () => {
  const { store, calls } = storeWith(() => json([{ id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", display_name: null, status: "approved", role: "admin", host_id: "noel", created: true }]));
  const profile = await store.upsertOnLogin({ user: { id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", emailConfirmed: true, displayName: null }, bootstrap: true, legacyHostId: "noel" });
  assert.deepEqual(profile, { id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", displayName: null, status: "approved", role: "admin", hostId: "noel", created: true });
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/upsert_profile_on_login_v1");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { p_user_id: "00000000-0000-4000-8000-000000000011", p_email: "a@b.io", p_display_name: null, p_bootstrap: true, p_legacy_host_id: "noel" });
  assert.equal(new Headers(calls[0].init.headers).get("apikey"), "fixture-secret");
});

test("readByHostId returns null on empty result and issue/consume desktop codes hash the raw code", async () => {
  const empty = storeWith(() => json([]));
  assert.equal(await empty.store.readByHostId("nobody"), null);
  let issued: Record<string, unknown> = {};
  const issuing = storeWith((url, init) => { if (url.endsWith("issue_desktop_login_code_v1")) { issued = JSON.parse(String(init.body)); return json(true); } return json([]); });
  const code = await issuing.store.issueDesktopCode({ profileId: "00000000-0000-4000-8000-000000000011", state: "s".repeat(43), expiresAt: new Date("2026-09-02T00:01:00Z") });
  assert.match(code, /^[0-9a-f]{64}$/u);
  assert.equal(issued.p_code_hash, `\\x${createHash("sha256").update(Buffer.from(code, "hex")).digest("hex")}`);
  assert.equal(issued.p_expires_at, "2026-09-02T00:01:00.000Z");
  const consuming = storeWith((url, init) => { assert.equal(JSON.parse(String(init.body)).p_state, "s".repeat(43)); return json([{ profile_id: "00000000-0000-4000-8000-000000000011", host_id: "noel", status: "approved" }]); });
  assert.deepEqual(await consuming.store.consumeDesktopCode({ code, state: "s".repeat(43) }), { profileId: "00000000-0000-4000-8000-000000000011", hostId: "noel", status: "approved" });
  assert.equal(await storeWith(() => json([])).store.consumeDesktopCode({ code, state: "s".repeat(43) }), null);
  await assert.rejects(storeWith(() => json([])).store.consumeDesktopCode({ code: "zz", state: "s".repeat(43) }), (e: ProfileStoreError) => e.code === "DESKTOP_CODE_INVALID");
});

test("RPC failures map to a 503 store error without leaking the body", async () => {
  await assert.rejects(storeWith(() => json({ message: "boom secret" }, 500)).store.readByHostId("noel"), (e: ProfileStoreError) => e.code === "PROFILE_STORE_UNAVAILABLE" && e.status === 503 && !e.message.includes("boom"));
});

test("legacy admin provisioning requires configured identity and never revives a disabled profile", async () => {
  const { store, calls } = storeWith(() => json([]));
  await assert.rejects(store.ensureLegacyAdmin({ hostId: "noel", bootstrapEmail: "" }), /ADMIN_BOOTSTRAP_EMAILS/u);
  assert.equal(calls.length, 0);
  const disabled = storeWith(() => json([{ id: "00000000-0000-4000-8000-000000000011", email: "admin@example.test", host_id: "noel", role: "admin", status: "disabled" }]));
  await assert.rejects(disabled.store.ensureLegacyAdmin({ hostId:"noel", bootstrapEmail:"admin@example.test" }), (e: ProfileStoreError) => e.code === "ADMIN_PROFILE_DISABLED");
  assert.equal(disabled.calls.length, 1);
});

test("verified legacy bootstrap links configured Auth identity without setting password or sending mail", async () => {
  const id = "00000000-0000-4000-8000-000000000011";
  const { store, calls } = storeWith((url, init) => {
    if (url.includes("read_profile")) return json([]);
    if (url.includes("/admin/users")) return json({ users:[{id,email:"admin@example.test"}] });
    const body = JSON.parse(String(init.body));
    assert.equal(body.p_bootstrap, true); assert.equal(body.p_legacy_host_id, "noel");
    return json([{id,email:"admin@example.test",host_id:"noel",role:"admin",status:"approved"}]);
  });
  assert.equal((await store.ensureLegacyAdmin({hostId:"noel",bootstrapEmail:"admin@example.test"})).role,"admin");
  assert.equal(calls.length,3);
});
