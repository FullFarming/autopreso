import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError, AuthorizationError } from "./live-auth";
import { __setProfileReaderForTests } from "./profile-status-cache";
import type { ProfileRecord, ProfileRole, ProfileStatus } from "./profile-store";
import { isAdminRequest, requireAdmin, requireAdminFromCookieValue } from "./require-admin";
import { SESSION_COOKIE, createSessionToken } from "../session";

const ADMIN_UUID = "00000000-0000-4000-8000-000000000011";
const HOST_UUID = "00000000-0000-4000-8000-000000000022";
const profile = (hostId: string, status: ProfileStatus, role: ProfileRole): ProfileRecord => ({ id: hostId === "noel" ? ADMIN_UUID : hostId, email: `${role}@x.io`, displayName: null, status, role, hostId });
const request = (token: string | undefined) => ({ cookies: { get: (name: string) => (name === SESSION_COOKIE && token ? { name, value: token } : undefined) } }) as never;

async function withProfiles(rows: Record<string, ProfileRecord>, run: () => Promise<void>) {
  const previousAdmins = process.env.ADMIN_USER_IDS;
  process.env.ADMIN_USER_IDS = "noel";
  __setProfileReaderForTests(async (hostId) => rows[hostId] ?? null);
  try { await run(); } finally {
    __setProfileReaderForTests(null);
    if (previousAdmins === undefined) delete process.env.ADMIN_USER_IDS; else process.env.ADMIN_USER_IDS = previousAdmins;
  }
}

test("an approved admin passes and receives the host id and full profile", async () => {
  await withProfiles({ [ADMIN_UUID]: profile(ADMIN_UUID, "approved", "admin") }, async () => {
    const actor = await requireAdmin(request(await createSessionToken(ADMIN_UUID)));
    assert.deepEqual(actor, { hostId: ADMIN_UUID, profile: profile(ADMIN_UUID, "approved", "admin") });
  });
});

test("a bootstrap admin whose profile carries the legacy host id passes through its ADMIN_USER_IDS cookie", async () => {
  await withProfiles({ noel: profile("noel", "approved", "admin") }, async () => {
    const actor = await requireAdmin(request(await createSessionToken("noel")));
    assert.equal(actor.hostId, "noel");
    assert.equal(actor.profile.id, ADMIN_UUID);
  });
});

test("an approved host (role host) is rejected with AuthorizationError", async () => {
  await withProfiles({ [HOST_UUID]: profile(HOST_UUID, "approved", "host") }, async () => {
    await assert.rejects(requireAdmin(request(await createSessionToken(HOST_UUID))), AuthorizationError);
  });
});

test("a legacy password host with no profile row is rejected with AuthorizationError, not AuthenticationError", async () => {
  await withProfiles({}, async () => {
    await assert.rejects(requireAdmin(request(await createSessionToken("noel"))), (error: unknown) => error instanceof AuthorizationError && !(error instanceof AuthenticationError));
  });
});

test("a pending or disabled admin never reaches the console", async () => {
  for (const status of ["pending", "disabled", "rejected"] as const) {
    await withProfiles({ [ADMIN_UUID]: profile(ADMIN_UUID, status, "admin") }, async () => {
      await assert.rejects(requireAdmin(request(await createSessionToken(ADMIN_UUID))), (error: unknown) => error instanceof AuthenticationError || error instanceof AuthorizationError);
    });
  }
});

test("no cookie or a forged cookie is AuthenticationError", async () => {
  await withProfiles({ [ADMIN_UUID]: profile(ADMIN_UUID, "approved", "admin") }, async () => {
    await assert.rejects(requireAdmin(request(undefined)), AuthenticationError);
    await assert.rejects(requireAdmin(request("bm9lbHwx.deadbeef")), AuthenticationError);
  });
});

test("requireAdminFromCookieValue applies the same gate to a raw cookie value for server layouts", async () => {
  await withProfiles({ [ADMIN_UUID]: profile(ADMIN_UUID, "approved", "admin"), [HOST_UUID]: profile(HOST_UUID, "approved", "host") }, async () => {
    const actor = await requireAdminFromCookieValue(await createSessionToken(ADMIN_UUID));
    assert.equal(actor.profile.role, "admin");
    await assert.rejects(requireAdminFromCookieValue(await createSessionToken(HOST_UUID)), AuthorizationError);
    await assert.rejects(requireAdminFromCookieValue(undefined), AuthenticationError);
  });
});

test("isAdminRequest never throws: true only for an approved admin, false for hosts, pending admins, legacy hosts, and no cookie", async () => {
  await withProfiles({ [ADMIN_UUID]: profile(ADMIN_UUID, "approved", "admin"), [HOST_UUID]: profile(HOST_UUID, "approved", "host") }, async () => {
    assert.equal(await isAdminRequest(request(await createSessionToken(ADMIN_UUID))), true);
    assert.equal(await isAdminRequest(request(await createSessionToken(HOST_UUID))), false);
    assert.equal(await isAdminRequest(request(await createSessionToken("noel"))), false, "a legacy password host has no profile row");
    assert.equal(await isAdminRequest(request(undefined)), false);
    assert.equal(await isAdminRequest(request("forged.token")), false);
  });
  await withProfiles({ [ADMIN_UUID]: profile(ADMIN_UUID, "pending", "admin") }, async () => {
    assert.equal(await isAdminRequest(request(await createSessionToken(ADMIN_UUID))), false);
  });
});
