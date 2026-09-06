import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { STALE_GRACE_MS, assertHostApproved, createProfileStatusCache } from "./profile-status-cache";
import { AuthenticationError } from "./live-auth";
import type { ProfileRecord } from "./profile-store";

const row = (status: ProfileRecord["status"]): ProfileRecord => ({ id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", displayName: null, status, role: "host", hostId: "h1" });

test("status is cached for 60 s per host id and refetched afterwards", async () => {
  let now = 0; let reads = 0;
  const cache = createProfileStatusCache({ read: async () => { reads++; return row("approved"); }, now: () => now });
  await cache.get("h1"); await cache.get("h1");
  assert.equal(reads, 1);
  now = 60_001; await cache.get("h1");
  assert.equal(reads, 2);
  cache.invalidate("h1"); await cache.get("h1");
  assert.equal(reads, 3);
});

test("a missing profile row is cached as null (legacy password host) and store failures fall open only for legacy rows", async () => {
  const cache = createProfileStatusCache({ read: async () => null });
  assert.equal(await cache.get("noel"), null);
  assert.deepEqual(await assertHostApproved("noel", cache), { role: "legacy" });
});

test("assertHostApproved rejects pending, rejected, and disabled profiles with AuthenticationError", async () => {
  for (const status of ["pending", "rejected", "disabled"] as const) {
    const cache = createProfileStatusCache({ read: async () => row(status) });
    await assert.rejects(assertHostApproved("h1", cache), AuthenticationError);
  }
  const ok = createProfileStatusCache({ read: async () => ({ ...row("approved"), role: "admin" }) });
  assert.deepEqual(await assertHostApproved("h1", ok), { role: "admin" });
});

test("a store outage serves the last-known status for up to 10 min after the TTL and rejects afterwards", async () => {
  let fail = false; let now = 0; let reads = 0;
  const cache = createProfileStatusCache({ read: async () => { reads++; if (fail) throw new Error("down"); return row("approved"); }, now: () => now });
  await cache.get("h1"); fail = true;
  // Inside the TTL nothing is read at all.
  now = 59_999; assert.deepEqual(await assertHostApproved("h1", cache), { role: "host" }); assert.equal(reads, 1);
  // Past the TTL every call retries the store and, while it is down, serves the last-known answer.
  now = 120_000; assert.deepEqual(await assertHostApproved("h1", cache), { role: "host" }); assert.equal(reads, 2);
  now = 60_000 + STALE_GRACE_MS; assert.deepEqual(await assertHostApproved("h1", cache), { role: "host" }); assert.equal(reads, 3);
  // The grace window is bounded: 10 min past expiry the stale approval is gone.
  now = 60_000 + STALE_GRACE_MS + 1;
  await assert.rejects(assertHostApproved("h1", cache), AuthenticationError);
  // Recovery re-reads and re-arms the entry.
  fail = false; assert.deepEqual(await assertHostApproved("h1", cache), { role: "host" });
});

test("no stale approval survives beyond the grace window and a stale non-approved status never becomes approval", async () => {
  assert.equal(STALE_GRACE_MS, 10 * 60_000);
  let now = 0; let fail = false;
  const pending = createProfileStatusCache({ read: async () => { if (fail) throw new Error("down"); return row("pending"); }, now: () => now });
  await pending.get("h1"); fail = true; now = 120_000;
  await assert.rejects(assertHostApproved("h1", pending), AuthenticationError);
  // A host never seen before the outage has nothing to fall back on.
  const cold = createProfileStatusCache({ read: async () => { throw new Error("down"); } });
  await assert.rejects(assertHostApproved("noel", cold), AuthenticationError);
  await assert.rejects(cold.get("noel"), AuthenticationError);
});

test("lastKnown reports the cached status inside the grace window without touching the store", async () => {
  let now = 0; let reads = 0;
  const cache = createProfileStatusCache({ read: async () => { reads++; return { ...row("approved"), role: "admin" }; }, now: () => now });
  assert.equal(cache.lastKnown("h1"), undefined);
  await cache.get("h1");
  now = 60_000 + STALE_GRACE_MS; assert.deepEqual(cache.lastKnown("h1"), { status: "approved", role: "admin" });
  now = 60_000 + STALE_GRACE_MS + 1; assert.equal(cache.lastKnown("h1"), undefined);
  assert.equal(reads, 1);
  cache.invalidate("h1"); now = 0; assert.equal(cache.lastKnown("h1"), undefined);
});

test("managed-caption key issuance stays DB-authoritative: the broker re-reads the session RPCs, which require an approved profile", () => {
  // The cache leniency above may extend a *cookie* for 10 min during an outage; it must never be
  // able to mint paid provider keys. Every broker action goes back to Supabase, and the RPCs it
  // calls join `profiles.status = 'approved'` themselves - the cache is not on that path at all.
  const broker = readFileSync(new URL("../captions/broker.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("../captions/store.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../../supabase/migrations/202609050002_managed_caption_sessions.sql", import.meta.url), "utf8");
  assert.doesNotMatch(broker, /profile-status-cache|assertHostApproved|profileStatusCache/u);
  assert.doesNotMatch(store, /profile-status-cache|assertHostApproved|profileStatusCache/u);
  assert.match(broker, /async start\([\s\S]*?await this\.dependencies\.sessions\.create\(/u);
  assert.match(broker, /private async assertActive\(claims: Claims\)[\s\S]*?await this\.dependencies\.sessions\.read\(claims\.sessionId, claims\.hostId\)/u);
  for (const action of ["credentials", "translate", "renew"]) {
    assert.match(broker, new RegExp(`async ${action}\\([\\s\\S]*?await this\\.assertActive\\(claims\\)`, "u"), action);
  }
  assert.match(store, /this\.rpc\("create_managed_caption_session_v1"/u);
  assert.match(store, /this\.rpc\("read_managed_caption_session_v1"/u);
  assert.match(store, /this\.rpc\("renew_managed_caption_session_v1"/u);
  for (const fn of ["create_managed_caption_session_v1", "read_managed_caption_session_v1", "renew_managed_caption_session_v1"]) {
    const body = migration.slice(migration.indexOf(`function public.${fn}(`));
    const end = body.search(/\$\$;/u);
    assert.match(body.slice(0, end), /p\.status\s*=\s*'approved'/u, fn);
  }
});

test("a profile-backed host id whose profile row is gone is rejected, while a legacy password host id still falls through", async () => {
  const cache = createProfileStatusCache({ read: async () => null });
  await assert.rejects(assertHostApproved("00000000-0000-4000-8000-000000000011", cache), AuthenticationError);
  assert.deepEqual(await assertHostApproved("noel", cache), { role: "legacy" });
});
