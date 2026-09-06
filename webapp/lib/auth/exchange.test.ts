import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopCallbackUrl, exchangeSupabaseLogin } from "./exchange";
import type { ProfileRecord, VerifiedAuthUser } from "./profile-store";

const user: VerifiedAuthUser = { id: "00000000-0000-4000-8000-000000000011", email: "noel@example.com", emailConfirmed: true, displayName: "Noel" };
const profile = (over: Partial<ProfileRecord>): ProfileRecord & { created: boolean } => ({ id: user.id, email: user.email, displayName: "Noel", status: "approved", role: "admin", hostId: "noel", created: false, ...over });
const bootstrap = { emails: new Set(["noel@example.com"]), legacyHostId: "noel" };
const state = "A".repeat(43);

function deps(status: ProfileRecord["status"], record: { upsert?: unknown; issued?: unknown } = {}) {
  return {
    bootstrap,
    store: {
      verifyAccessToken: async () => user,
      upsertOnLogin: async (input: unknown) => { record.upsert = input; return profile({ status }); },
      issueDesktopCode: async (input: unknown) => { record.issued = input; return "c".repeat(64); },
    },
  };
}

test("approved web login yields /admin and passes bootstrap flags derived from the email", async () => {
  const record: { upsert?: unknown } = {};
  const outcome = await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, deps("approved", record));
  assert.equal(outcome.kind, "approved"); if (outcome.kind !== "approved") return;
  assert.equal(outcome.next, "/admin"); assert.equal(outcome.desktopCode, undefined);
  assert.deepEqual(record.upsert, { user, bootstrap: true, legacyHostId: "noel" });
});

test("non-bootstrap emails are never bootstrapped", async () => {
  const record: { upsert?: unknown } = {};
  await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, { ...deps("pending", record), store: { ...deps("pending", record).store, verifyAccessToken: async () => ({ ...user, email: "guest@example.com" }) } });
  assert.deepEqual(record.upsert, { user: { ...user, email: "guest@example.com" }, bootstrap: false, legacyHostId: "noel" });
});

test("pending → /pending, rejected/disabled → forbidden, unconfirmed email → forbidden before any upsert", async () => {
  assert.deepEqual(await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, deps("pending")), { kind: "pending", email: user.email, next: "/pending" });
  assert.deepEqual(await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, deps("rejected")), { kind: "forbidden", code: "PROFILE_REJECTED", email: user.email });
  assert.deepEqual(await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, deps("disabled")), { kind: "forbidden", code: "PROFILE_DISABLED", email: user.email });
  const record: { upsert?: unknown } = {};
  const d = deps("approved", record);
  const outcome = await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, { ...d, store: { ...d.store, verifyAccessToken: async () => ({ ...user, emailConfirmed: false }) } });
  assert.equal(outcome.kind, "forbidden"); assert.equal(record.upsert, undefined);
});

test("desktop login issues a 60 s one-shot code and returns the nova:// callback without a cookie decision", async () => {
  const record: { issued?: { profileId: string; state: string; expiresAt: Date } } = {};
  const now = Date.parse("2026-09-02T00:00:00Z");
  const outcome = await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "desktop", state, now: () => now }, deps("approved", record));
  assert.equal(outcome.kind, "approved"); if (outcome.kind !== "approved") return;
  assert.equal(outcome.desktopCode, "c".repeat(64));
  assert.equal(outcome.next, `nova://auth/callback?code=${"c".repeat(64)}&state=${state}`);
  assert.deepEqual(record.issued, { profileId: user.id, state, expiresAt: new Date(now + 60_000) });
});

test("desktop login without a valid state is rejected before verification", async () => {
  let verified = false;
  const d = deps("approved"); d.store.verifyAccessToken = async () => { verified = true; return user; };
  await assert.rejects(exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "desktop", state: "short" }, d), /DESKTOP_STATE_INVALID/u);
  assert.equal(verified, false);
  assert.equal(buildDesktopCallbackUrl("ab", state), `nova://auth/callback?code=ab&state=${state}`);
});
