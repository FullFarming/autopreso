import assert from "node:assert/strict";
import test from "node:test";
import { assertHostApproved, createProfileStatusCache } from "./profile-status-cache";
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

test("a store outage does not lock out a host whose last known status was approved", async () => {
  let fail = false; let now = 0;
  const cache = createProfileStatusCache({ read: async () => { if (fail) throw new Error("down"); return row("approved"); }, now: () => now });
  await cache.get("h1"); fail = true; now = 120_000;
  assert.deepEqual(await assertHostApproved("h1", cache), { role: "host" });
});

test("a profile-backed host id whose profile row is gone is rejected, while a legacy password host id still falls through", async () => {
  const cache = createProfileStatusCache({ read: async () => null });
  await assert.rejects(assertHostApproved("00000000-0000-4000-8000-000000000011", cache), AuthenticationError);
  assert.deepEqual(await assertHostApproved("noel", cache), { role: "legacy" });
});
