import assert from "node:assert/strict";
import test from "node:test";

import { SupabaseHostAuthorizer, SupabaseLivePublisher, SupabaseViewerAuthorizer } from "../src/supabase-adapters.js";

const claims = { role: "HOST", sub: "host-1", sessionId: "session-1" };
const settings = {
  sessionId: "session-1",
  version: 7,
  sessionType: "meeting",
  outputMode: "captions_audio",
  maxViewers: 24,
  glossaryPack: "hotel",
  languages: ["ko", "en"],
};

test("new Supabase secret keys use apikey only and take precedence over legacy credentials", async () => {
  const headers = [];
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://dev-ref.supabase.co",
    supabaseApiKey: "sb_secret_primary-never-print",
    supabaseKeyType: "secret",
    serviceRoleKey: "legacy-fallback-never-print",
    async fetchFn(_url, init) {
      headers.push(new Headers(init.headers));
      return Response.json(true);
    },
  });
  assert.equal(await authorizer.authorize(
    { sessionId: "session-1", grantId: "grant-1", userId: "user-1" }, "session-1", "ko",
  ), true);
  assert.equal(headers.length, 1);
  assert.equal(headers.every((value) => value.get("apikey") === "sb_secret_primary-never-print"), true);
  assert.equal(headers.every((value) => value.has("authorization") === false), true);
});

test("legacy service-role credentials temporarily retain Bearer authorization fallback", async () => {
  let headers;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "legacy-service-role",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(_url, init) {
      headers = new Headers(init.headers);
      return Response.json(true);
    },
  });
  await publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "x" });
  assert.equal(headers.get("apikey"), "legacy-service-role");
  assert.equal(headers.get("authorization"), "Bearer legacy-service-role");
});

test("Supabase adapters fail fast when neither server credential is configured", () => {
  assert.throws(
    () => new SupabaseHostAuthorizer({ baseUrl: "https://dev-ref.supabase.co" }),
    /SUPABASE_SERVER_CREDENTIAL_REQUIRED/u,
  );
});

test("host authorization strictly matches the live session configuration and expiry", async () => {
  const seen = [];
  const authorizer = new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "secret",
    async fetchFn(url, init) {
      seen.push({ url, init });
      return new Response(JSON.stringify([{
        id: "session-1", host_id: "host-1", status: "live", version: 7,
        session_type: "meeting", output_mode: "captions_audio", max_viewers: 24, glossary_pack: "hotel",
        mode: "townhall", languages: ["ko", "en"], voice_output_mode: "auto_voice",
      }]), { status: 200 });
    },
  });
  const controller = new AbortController();
  assert.equal(await authorizer.authorize(claims, settings, { signal: controller.signal, requireLive: true }), true);
  assert.match(seen[0].url, /expires_at=gt\./u);
  assert.equal(seen[0].init.signal, controller.signal);
});

test("host lease ignores admission-only version changes but rejects configuration mismatch", async () => {
  let row = {
    id: "session-1", host_id: "host-1", status: "live", version: 8,
    session_type: "meeting", output_mode: "captions_audio", max_viewers: 24, glossary_pack: "hotel",
    mode: "townhall", languages: ["ko", "en"], voice_output_mode: "auto_voice",
  };
  const authorizer = new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() { return new Response(JSON.stringify([row]), { status: 200 }); },
  });
  assert.equal(await authorizer.authorize(claims, settings, { requireLive: true, compareVersion: false }), true);
  row = { ...row, languages: ["ko"] };
  assert.equal(await authorizer.authorize(claims, settings, { requireLive: true, compareVersion: false }), false);
  assert.equal(await authorizer.authorize({ ...claims, sub: "other" }, settings, { requireLive: true, compareVersion: false }), false);
});

test("viewer authorization uses one fail-closed snapshot RPC for grant, session, and language", async () => {
  const calls = [];
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn(url, init) {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), signal: init.signal });
      return Response.json(true);
    },
  });
  const controller = new AbortController();
  assert.equal(await authorizer.authorize(
    { sessionId: "session-1", grantId: "grant-1", userId: "user-1" }, "session-1", "ko", { signal: controller.signal },
  ), true);
  assert.deepEqual(calls, [{
    url: "https://dev-ref.supabase.co/rest/v1/rpc/authorize_live_viewer_topic",
    body: { p_session_id: "session-1", p_grant_id: "grant-1", p_user_id: "user-1", p_language: "ko" },
    signal: controller.signal,
  }]);
  for (const response of [Response.json(false), Response.json([{ allowed: true }]), new Response("", { status: 503 })]) {
    const denied = new SupabaseViewerAuthorizer({
      baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
      async fetchFn() { return response.clone(); },
    });
    assert.equal(await denied.authorize(
      { sessionId: "session-1", grantId: "grant-1", userId: "user-1" }, "session-1", "ko",
    ), false);
  }
});

test("publisher fans out locally and persists only through active-session RPCs", async () => {
  const calls = [];
  const events = [];
  const audio = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { events.push(args); },
    async audioFanout(...args) { audio.push(args); },
    async fetchFn(url, init) {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const caption = { type: "caption", seq: 1, isFinal: true, text: "비공개" };
  await publisher.publish("session-1", "ko", caption);
  await publisher.publish("session-1", "ko", { type: "speaker-legend", speakers: [] });
  await publisher.publishAudio("session-1", "ko", { type: "audio-chunk", seq: 2 }, Buffer.from([1, 2]));

  assert.deepEqual(events.map((entry) => entry[2].type), ["caption", "speaker-legend"]);
  assert.equal(audio.length, 1);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/rest/v1/rpc/persist_live_snapshot_if_active",
    "/rest/v1/rpc/persist_live_utterance_if_active",
    "/rest/v1/rpc/persist_session_speakers_if_active",
  ]);
  assert.equal(calls.some((call) => call.url.includes("/realtime/")), false);
});

test("publisher treats a guarded RPC false result as a stopped session", async () => {
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn() { return new Response("false", { status: 200, headers: { "Content-Type": "application/json" } }); },
  });
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "x" }),
    /SESSION_STOPPED/u,
  );
});
