import assert from "node:assert/strict";
import test from "node:test";

import {
  SupabaseFloorController,
  SupabaseHostAuthorizer,
  SupabaseLivePublisher,
  SupabaseViewerAuthorizer,
} from "../src/supabase-adapters.js";

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

test("a JWT-shaped SUPABASE_SECRET_KEY is treated as legacy and keeps Bearer authorization", async () => {
  // Production regression 2026-07-24: the secret slot held a legacy
  // service_role JWT; sending it as apikey-only downgraded every query to
  // anon and RLS silently emptied all reads (SESSION_REVOKED for hosts,
  // GRANT_REVOKED for viewers, lost utterances).
  const jwtKey = "eyJhbGciOiJIUzI1NiJ9.legacy-jwt-body.signature";
  let headers;
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://dev-ref.supabase.co",
    supabaseApiKey: jwtKey,
    supabaseKeyType: "secret",
    async fetchFn(_url, init) {
      headers = new Headers(init.headers);
      return Response.json(true);
    },
  });
  assert.equal(await authorizer.authorize(
    { sessionId: "session-1", grantId: "grant-1", userId: "user-1" }, "session-1", "ko",
  ), true);
  assert.equal(headers.get("apikey"), jwtKey);
  assert.equal(headers.get("authorization"), `Bearer ${jwtKey}`);
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
  const caption = {
    type: "caption",
    seq: 1,
    isFinal: true,
    text: "비공개",
    speaker: { speakerId: "participant:grant-1", label: "Noel Kim" },
    sourceStartedAt: "2026-07-23T00:00:00.000Z",
    sourceEndedAt: "2026-07-23T00:00:04.000Z",
    emittedAt: "2026-07-23T00:00:04.100Z",
    sourceText: "private",
    sourceLanguage: "en",
  };
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
  assert.equal(calls[1].body.p_participant_id, "grant-1");
  assert.equal(calls[1].body.p_source_started_at, "2026-07-23T00:00:00.000Z");
  // The original must be persisted alongside the translation, otherwise the
  // viewer's 원문보기 disclosure has nothing to reveal after a reconnect.
  assert.equal(calls[1].body.p_source_text, "private");
  assert.equal(calls[1].body.p_source_language, "en");
});

test("a source-lane caption persists with no duplicated original", async () => {
  const calls = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await publisher.publish("session-1", "ko", {
    type: "caption", seq: 1, isFinal: true, text: "안녕하세요",
    speaker: null, sourceText: null, sourceLanguage: "ko",
    sourceEndedAt: "2026-07-23T00:00:04.000Z", emittedAt: "2026-07-23T00:00:04.100Z",
  });
  const utterance = calls.find((call) => call.url.includes("persist_live_utterance_if_active"));
  assert.equal(utterance.body.p_source_text, null);
  assert.equal(utterance.body.p_source_language, "ko");
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

test("host lease stays valid while the database session is paused", async () => {
  const makeAuthorizer = (status) => new SupabaseHostAuthorizer({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() {
      return new Response(JSON.stringify([{
        id: "session-1", host_id: "host-1", status, version: 7,
        session_type: "meeting", output_mode: "captions_audio", max_viewers: 24, glossary_pack: "hotel",
        languages: ["ko", "en"],
      }]), { status: 200 });
    },
  });
  assert.equal(await makeAuthorizer("paused").authorize(claims, settings, { requireLive: true }), true);
  assert.equal(await makeAuthorizer("stopped").authorize(claims, settings, { requireLive: true }), false);
});

test("a transient snapshot persist failure does not drop the caption broadcast", async () => {
  const fanned = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { fanned.push(args); },
    async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_snapshot_if_active")) return new Response("", { status: 503 });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "생존" });
  assert.equal(fanned.length, 1, "caption must still fan out after a transient snapshot failure");
});

test("an utterance recording failure remains non-fatal and emits an observable recording error", async () => {
  const fanned = [];
  let utterancePersistAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { fanned.push(args); },
    async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_utterance_if_active")) {
        utterancePersistAttempts += 1;
        return new Response("", { status: 503 });
      }
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const caption = {
    type: "caption",
    seq: 12,
    isFinal: true,
    text: "화면에는 계속 표시",
    sourceEndedAt: "2026-07-24T00:00:04.000Z",
    emittedAt: "2026-07-24T00:00:04.100Z",
  };

  await assert.doesNotReject(publisher.publish("session-1", "ko", caption));
  assert.equal(utterancePersistAttempts, 1, "recording errors must not be hidden by an automatic retry");
  assert.deepEqual(fanned.map((entry) => entry[2]), [
    caption,
    {
      type: "recording-status",
      sessionId: "session-1",
      language: "ko",
      status: "error",
      code: "UTTERANCE_PERSIST_FAILED",
      seq: 12,
      message: "자막은 계속 표시되지만 기록 저장에 실패했습니다.",
    },
  ]);
});

test("an utterance RPC false result is reported as a recording error without ending captions", async () => {
  const fanned = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { fanned.push(args[2]); },
    async audioFanout() {},
    async fetchFn(url) {
      const value = String(url).includes("persist_live_utterance_if_active") ? false : true;
      return Response.json(value);
    },
  });
  await publisher.publish("session-1", "en", {
    type: "caption", seq: 13, isFinal: true, text: "still live",
  });
  assert.deepEqual(fanned.map((event) => [event.type, event.code ?? null]), [
    ["caption", null],
    ["recording-status", "UTTERANCE_PERSIST_FAILED"],
  ]);
});

test("a genuine snapshot RPC decline still stops emission as SESSION_STOPPED", async () => {
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_snapshot_if_active")) {
        return new Response("false", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "중단" }),
    /SESSION_STOPPED/u,
  );
});

test("publisher seeds per-language caption sequences from the persisted max seq", async () => {
  const requested = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      requested.push(new URL(url));
      const language = new URL(url).searchParams.get("language");
      const body = language === "eq.ko" ? JSON.stringify([{ seq: 41 }]) : JSON.stringify([]);
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.deepEqual(await publisher.fetchLastUtteranceSeqs("session-1", ["ko", "en"]), { ko: 41, en: 0 });
  assert.equal(requested.every((url) => url.pathname === "/rest/v1/live_utterances"), true);
  assert.deepEqual(requested.map((url) => [url.searchParams.get("order"), url.searchParams.get("limit")]), [
    ["seq.desc", "1"],
    ["seq.desc", "1"],
  ]);
});

test("publisher maps persisted utterances to replayable caption events in ascending seq order", async () => {
  let seen;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      seen = new URL(url);
      return new Response(JSON.stringify([
        { seq: 3, speaker_label: "speaker-1", speaker_name: "김노엘", text: "셋", source_text: "three", source_language: "en", source_ended_at: "2026-07-23T00:00:03Z", emitted_at: "2026-07-23T00:00:03.100Z" },
        // A row predating the provenance columns: replay must still work and
        // simply offer no original to disclose.
        { seq: 4, speaker_label: null, speaker_name: null, text: "넷", source_ended_at: "2026-07-23T00:00:04Z", emitted_at: "2026-07-23T00:00:04.100Z" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const events = await publisher.fetchUtterancesAfter("session-1", "ko", 2);
  assert.equal(seen.searchParams.get("seq"), "gt.2");
  assert.equal(seen.searchParams.get("order"), "seq.asc");
  assert.equal(seen.searchParams.get("limit"), "200");
  assert.deepEqual(events.map((event) => [event.type, event.seq, event.text, event.isFinal]), [
    ["caption", 3, "셋", true],
    ["caption", 4, "넷", true],
  ]);
  // The full SpeakerAssignment shape: the webapp viewer validates every field
  // and silently drops replayed captions whose speaker is partial.
  assert.deepEqual(events[0].speaker, {
    speakerId: "speaker-1",
    label: "김노엘",
    name: "김노엘",
    colorToken: "speaker-teal",
    voiceName: null,
    voiceStatus: "disabled",
    lastSeenAt: "2026-07-23T00:00:03.100Z",
  });
  assert.equal(events[1].speaker, null);
  assert.equal(seen.searchParams.get("select")?.includes("source_text,source_language"), true);
  assert.deepEqual(
    events.map((event) => [event.sourceText, event.sourceLanguage, event.translationStatus]),
    [["three", "en", "translated"], [null, null, "verbatim"]],
  );
});

test("floor controller resolves participant identity for floor broadcasts and degrades to null", async () => {
  const controller = new SupabaseFloorController({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn(url) {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/rest/v1/live_participants");
      assert.equal(parsed.searchParams.get("id"), "eq.participant-1");
      return Response.json([{ display_name: "김노엘", department: "전략기획실", job_title: "PM" }]);
    },
  });
  assert.deepEqual(await controller.getParticipant("session-1", "participant-1"), {
    name: "김노엘",
    department: "전략기획실",
    jobTitle: "PM",
  });

  const failing = new SupabaseFloorController({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async fetchFn() { throw new Error("network"); },
  });
  assert.equal(await failing.getParticipant("session-1", "participant-1"), null);
});

test("floor controller returns the stable participant id used by meeting records", async () => {
  const controller = new SupabaseFloorController({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "secret",
    async fetchFn() {
      return Response.json({
        ok: true,
        displayName: "Noel Kim",
        participantId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      });
    },
  });
  assert.deepEqual(await controller.take("session-1", "grant-1"), {
    ok: true,
    displayName: "Noel Kim",
    participantId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
  });
});

test("null-speaker meeting finals persist and their replay passes the viewer contract", async () => {
  const rpcBodies = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("/rpc/")) {
        rpcBodies.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([
        { seq: 7, speaker_label: "participant:p1", speaker_name: "김참가", text: "발언 기록", source_ended_at: "2026-07-24T00:00:07Z", emitted_at: "2026-07-24T00:00:07.100Z" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  // Live-translate meeting finals carry speaker:null unless the floor is held.
  await publisher.publish("session-1", "en", {
    type: "caption", seq: 6, sessionId: "session-1", language: "en",
    speaker: null, text: "Hello everyone.", isFinal: true,
    sourceEndedAt: "2026-07-24T00:00:06Z", emittedAt: "2026-07-24T00:00:06.100Z",
  });
  const utteranceCall = rpcBodies.find((call) => call.url.includes("persist_live_utterance_if_active"));
  assert.equal(utteranceCall.body.p_text, "Hello everyone.");
  assert.equal(utteranceCall.body.p_speaker_label, null);
  assert.equal(utteranceCall.body.p_speaker_name, null);

  // Replayed rows must survive the webapp's isSpeaker/isCaptionEvent gate.
  const [replayed] = await publisher.fetchUtterancesAfter("session-1", "en", 6);
  const viewerAccepts = (value) => value.type === "caption"
    && Number.isSafeInteger(value.seq)
    && typeof value.sessionId === "string"
    && typeof value.language === "string"
    && (value.speaker === null || (
      typeof value.speaker.speakerId === "string"
      && typeof value.speaker.label === "string"
      && typeof value.speaker.colorToken === "string"
      && (typeof value.speaker.voiceName === "string" || value.speaker.voiceName === null)
      && typeof value.speaker.lastSeenAt === "string"))
    && typeof value.text === "string"
    && typeof value.isFinal === "boolean"
    && typeof value.sourceEndedAt === "string"
    && typeof value.emittedAt === "string";
  assert.equal(viewerAccepts(replayed), true, `viewer would drop replayed caption: ${JSON.stringify(replayed)}`);
});

test("participant floor captions persist with participant_id and display name", async () => {
  const rpcBodies = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("/rpc/")) rpcBodies.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await publisher.publish("session-1", "en", {
    type: "caption", seq: 9, sessionId: "session-1", language: "en",
    speaker: { speakerId: "participant:p-77", label: "김참가", name: "김참가", colorToken: "speaker-teal", voiceName: null, voiceStatus: "disabled", lastSeenAt: "2026-07-24T00:00:09Z" },
    text: "Participant speech.", isFinal: true,
    sourceEndedAt: "2026-07-24T00:00:09Z", emittedAt: "2026-07-24T00:00:09.100Z",
  });
  const call = rpcBodies.find((entry) => entry.url.includes("persist_live_utterance_if_active"));
  assert.equal(call.body.p_participant_id, "p-77");
  assert.equal(call.body.p_speaker_name, "김참가");
  assert.equal(call.body.p_speaker_label, "participant:p-77");
});
