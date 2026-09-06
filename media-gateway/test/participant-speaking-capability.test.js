import assert from "node:assert/strict";
import test from "node:test";

import { SupabaseViewerAuthorizer } from "../src/supabase-adapters.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const GRANT_ID = "00000000-0000-4000-8000-000000000002";

test("participant speaking authorization uses the exact service-only grant fence RPC", async () => {
  const requests = [];
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    async fetchFn(url, init) {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return Response.json(true);
    },
  });

  const authorized = await authorizer.authorizeSpeaking({
    role: "VIEWER",
    sessionId: SESSION_ID,
    grantId: GRANT_ID,
    userId: "participant-user-1",
  }, SESSION_ID);

  assert.equal(authorized, true);
  assert.equal(new URL(requests[0].url).pathname, "/rest/v1/rpc/authorize_live_participant_speaking_v1");
  assert.deepEqual(requests[0].body, {
    p_session_id: SESSION_ID,
    p_grant_id: GRANT_ID,
    p_user_id: "participant-user-1",
  });
  assert.equal(requests[0].init.headers.get("apikey"), "server-secret");
  assert.equal(requests[0].init.headers.get("authorization"), "Bearer server-secret");
});

test("participant speaking authorization fails closed before IO for a cross-session or malformed grant", async () => {
  let requests = 0;
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    async fetchFn() { requests += 1; return Response.json(true); },
  });
  assert.equal(await authorizer.authorizeSpeaking({
    role: "VIEWER",
    sessionId: SESSION_ID,
    grantId: GRANT_ID,
    userId: "participant-user-1",
  }, "00000000-0000-4000-8000-000000000003"), false);
  assert.equal(await authorizer.authorizeSpeaking({
    role: "VIEWER",
    sessionId: SESSION_ID,
    grantId: "not-a-uuid",
    userId: "participant-user-1",
  }, SESSION_ID), false);
  assert.equal(requests, 0);
});

test("participant speaking authorization rejects a malformed RPC response", async () => {
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    async fetchFn() { return Response.json({ authorized: true }); },
  });
  await assert.rejects(authorizer.authorizeSpeaking({
    role: "VIEWER",
    sessionId: SESSION_ID,
    grantId: GRANT_ID,
    userId: "participant-user-1",
  }, SESSION_ID), /INVALID_PARTICIPANT_SPEAKING_AUTHORIZATION_RESPONSE/u);
});
