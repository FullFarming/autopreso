import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("production replay wiring forwards the abort options to Supabase", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /replayUtterances:\s*\(sessionId, language, afterSeq, limit, options\)[\s\S]*?fetchUtterancesAfter\(sessionId, language, afterSeq, limit, options\)/u);
});

test("utterance replay forwards and observes its abort signal", async () => {
  const abortController = new AbortController();
  let observedSignal;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(_url, init) {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const replay = publisher.fetchUtterancesAfter("session-1", "ko", 0, 200, { signal: abortController.signal });
  const reason = new Error("REPLAY_ABORTED");
  abortController.abort(reason);
  await assert.rejects(replay, /REPLAY_ABORTED/u);
  assert.equal(observedSignal, abortController.signal);
});

test("atomic final timeout fails closed and latches the lane without retry", async () => {
  const delivered = [];
  const mirrored = [];
  const observedSignals = [];
  let snapshotAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    snapshotGuardTimeoutMilliseconds: 5,
    async eventFanout(_sessionId, _language, event) { delivered.push(event); },
    async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        snapshotAttempts += 1;
        observedSignals.push(init.signal);
        if (snapshotAttempts === 1) return new Promise(() => {});
      }
      return Response.json(true);
    },
  });

  await assert.rejects(
    publisher.publish(
      "session-1",
      "ko",
      { type: "caption", seq: 1, isFinal: true, text: "시간 초과" },
      { onLiveEvent: async (event) => mirrored.push(event) },
    ),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  assert.equal(observedSignals[0]?.aborted, true);
  assert.deepEqual(delivered, []);
  assert.deepEqual(mirrored, []);

  await assert.rejects(
    publisher.publish(
      "session-1",
      "ko",
      { type: "caption", seq: 2, isFinal: true, text: "다음 문장" },
      { onLiveEvent: async (event) => mirrored.push(event) },
    ),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(snapshotAttempts, 1, "an ambiguous commit must never be retried automatically");
  assert.deepEqual(delivered, []);
  assert.deepEqual(mirrored, []);
});

test("locked lane reconciliation distinguishes committed and rolled-back ambiguous finals", async () => {
  for (const scenario of [
    { label: "committed", reconciledSeq: 1, nextSeq: 2 },
    { label: "rolled back", reconciledSeq: 0, nextSeq: 1 },
  ]) {
    const durableSequences = [];
    const reconciliationBodies = [];
    let shouldFailFirstFinal = true;
    const publisher = new SupabaseLivePublisher({
      baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
      async eventFanout() {}, async audioFanout() {},
      async fetchFn(url, init) {
        if (String(url).includes("persist_live_final_caption_if_active")) {
          const body = JSON.parse(String(init.body));
          durableSequences.push(body.p_seq);
          if (shouldFailFirstFinal) {
            shouldFailFirstFinal = false;
            return new Response("", { status: 503 });
          }
          return Response.json(true);
        }
        if (String(url).includes("reconcile_live_caption_lane")) {
          reconciliationBodies.push(JSON.parse(String(init.body)));
          return Response.json({ max_seq: scenario.reconciledSeq });
        }
        throw new Error("UNEXPECTED_REQUEST");
      },
    });

    await assert.rejects(
      publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
      /DURABLE_CAPTION_PERSIST_FAILED/u,
      scenario.label,
    );
    assert.equal(await publisher.reconcileCaptionLane("session-1", "ko"), scenario.reconciledSeq);
    assert.deepEqual(reconciliationBodies, [{ p_session_id: "session-1", p_language: "ko" }]);

    await publisher.publish(
      "session-1",
      "ko",
      { type: "caption", seq: scenario.nextSeq, isFinal: true, text: "after recovery" },
    );
    assert.deepEqual(durableSequences, [1, scenario.nextSeq]);
  }
});

test("failed or malformed lane reconciliation keeps the durable lane latched", async () => {
  for (const reconciliationResponse of [
    new Response("", { status: 503 }),
    Response.json({ max_seq: -1 }),
    Response.json({ max_seq: Number.MAX_SAFE_INTEGER + 1 }),
    Response.json({ max_seq: "1" }),
    Response.json([{ max_seq: 1 }]),
    Response.json({}),
  ]) {
    let durableAttempts = 0;
    const publisher = new SupabaseLivePublisher({
      baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
      async eventFanout() {}, async audioFanout() {},
      async fetchFn(url) {
        if (String(url).includes("persist_live_final_caption_if_active")) {
          durableAttempts += 1;
          return new Response("", { status: 503 });
        }
        if (String(url).includes("reconcile_live_caption_lane")) return reconciliationResponse;
        throw new Error("UNEXPECTED_REQUEST");
      },
    });

    await assert.rejects(
      publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
      /DURABLE_CAPTION_PERSIST_FAILED/u,
    );
    await assert.rejects(
      publisher.reconcileCaptionLane("session-1", "ko"),
      /DURABLE_CAPTION_RECONCILIATION_FAILED/u,
    );
    await assert.rejects(
      publisher.publish("session-1", "ko", { type: "caption", seq: 2, isFinal: true, text: "still blocked" }),
      /DURABLE_CAPTION_LANE_FAILED/u,
    );
    assert.equal(durableAttempts, 1, "reconciliation failure must not reopen the lane");
  }
});

test("an ordinary max-sequence read cannot clear an ambiguous durable lane", async () => {
  let durableAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        durableAttempts += 1;
        return new Response("", { status: 503 });
      }
      if (String(url).includes("/rest/v1/live_utterances?")) return Response.json([]);
      throw new Error("UNEXPECTED_REQUEST");
    },
  });

  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  assert.deepEqual(await publisher.fetchLastUtteranceSeqs("session-1", ["ko"]), { ko: 0 });
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 2, isFinal: true, text: "still blocked" }),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(durableAttempts, 1);
});

test("a hung locked reconciliation times out without reopening the durable lane", async () => {
  let reconciliationSignal;
  let durableAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    reconciliationTimeoutMilliseconds: 5,
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        durableAttempts += 1;
        return new Response("", { status: 503 });
      }
      if (String(url).includes("reconcile_live_caption_lane")) {
        reconciliationSignal = init.signal;
        return new Promise(() => {});
      }
      throw new Error("UNEXPECTED_REQUEST");
    },
  });

  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  await assert.rejects(
    publisher.reconcileCaptionLane("session-1", "ko"),
    /DURABLE_CAPTION_RECONCILIATION_FAILED/u,
  );
  assert.equal(reconciliationSignal?.aborted, true);
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 2, isFinal: true, text: "still blocked" }),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(durableAttempts, 1);
});

test("caller abort stops locked reconciliation promptly and leaves the lane latched", async () => {
  const caller = new AbortController();
  let reconciliationSignal;
  let durableAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        durableAttempts += 1;
        return new Response("", { status: 503 });
      }
      if (String(url).includes("reconcile_live_caption_lane")) {
        reconciliationSignal = init.signal;
        return new Promise(() => {});
      }
      throw new Error("UNEXPECTED_REQUEST");
    },
  });

  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "ambiguous" }),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  const reconciliation = publisher.reconcileCaptionLane("session-1", "ko", { signal: caller.signal });
  caller.abort(new Error("CALLER_ABORTED"));
  await assert.rejects(
    Promise.race([
      reconciliation,
      new Promise((_, reject) => setTimeout(() => reject(new Error("ABORT_WAS_NOT_PROMPT")), 100)),
    ]),
    /DURABLE_CAPTION_RECONCILIATION_FAILED/u,
  );
  assert.equal(reconciliationSignal?.aborted, true);
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 2, isFinal: true, text: "still blocked" }),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(durableAttempts, 1);
});

test("snapshot guard timeout configuration is bounded and fail-closed", () => {
  const makePublisher = (snapshotGuardTimeoutMilliseconds) => new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    snapshotGuardTimeoutMilliseconds,
    async eventFanout() {}, async audioFanout() {}, async fetchFn() { return Response.json(true); },
  });
  for (const invalid of [0, -1, 1.5, Number.NaN, 60_001]) {
    assert.throws(() => makePublisher(invalid), /INVALID_SNAPSHOT_GUARD_TIMEOUT/u);
  }
  assert.doesNotThrow(() => makePublisher(undefined));
  assert.doesNotThrow(() => makePublisher(60_000));
});

test("lane reconciliation timeout is capped at five seconds", () => {
  const makePublisher = (reconciliationTimeoutMilliseconds) => new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    reconciliationTimeoutMilliseconds,
    async eventFanout() {}, async audioFanout() {}, async fetchFn() { return Response.json(true); },
  });
  for (const invalid of [0, -1, 1.5, Number.NaN, 5_001]) {
    assert.throws(() => makePublisher(invalid), /INVALID_RECONCILIATION_TIMEOUT/u);
  }
  assert.doesNotThrow(() => makePublisher(undefined));
  assert.doesNotThrow(() => makePublisher(5_000));
});

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
    translationStatus: "translated",
  };
  await publisher.publish("session-1", "ko", caption);
  await publisher.publish("session-1", "ko", { type: "speaker-legend", speakers: [] });
  await publisher.publishAudio("session-1", "ko", { type: "audio-chunk", seq: 2 }, Buffer.from([1, 2]));

  assert.deepEqual(events.map((entry) => entry[2].type), ["caption", "speaker-legend"]);
  assert.equal(audio.length, 1);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/rest/v1/rpc/persist_live_final_caption_if_active",
    "/rest/v1/rpc/persist_session_speakers_if_active",
  ]);
  assert.equal(calls.some((call) => call.url.includes("/realtime/")), false);
  assert.equal(calls[0].body.p_participant_id, "grant-1");
  assert.equal(calls[0].body.p_source_started_at, "2026-07-23T00:00:00.000Z");
  // The original must be persisted alongside the translation, otherwise the
  // viewer's 원문보기 disclosure has nothing to reveal after a reconnect.
  assert.equal(calls[0].body.p_source_text, "private");
  assert.equal(calls[0].body.p_source_language, "en");
  assert.equal(calls[0].body.p_translation_status, "translated");
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
    origin: "source", utteranceKey: "session-1:input:1",
    speaker: null, sourceText: null, sourceLanguage: "ko",
    sourceEndedAt: "2026-07-23T00:00:04.000Z", emittedAt: "2026-07-23T00:00:04.100Z",
  });
  const combined = calls.find((call) => call.url.includes("persist_live_final_caption_if_active"));
  assert.equal(combined.body.p_source_text, null);
  assert.equal(combined.body.p_source_language, "ko");
  assert.equal(combined.body.p_origin, "source");
  assert.equal(combined.body.p_utterance_key, "session-1:input:1");
  assert.equal(combined.body.p_translation_status, "verbatim");
  assert.equal(combined.body.p_event.origin, "source");
  assert.equal(combined.body.p_event.utteranceKey, "session-1:input:1");
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

test("a transient snapshot guard failure fails closed before caption broadcast", async () => {
  const fanned = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { fanned.push(args); },
    async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) return new Response("", { status: 503 });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await assert.rejects(
    publisher.publish("session-1", "ko", { type: "caption", seq: 1, isFinal: true, text: "차단" }),
    /DURABLE_CAPTION_PERSIST_FAILED/u,
  );
  assert.equal(fanned.length, 0, "an unverified final must not reach a viewer");
});

test("final fanout waits for the atomic durable commit", async () => {
  const delivered = [];
  let releasePersistence;
  const persistenceGate = new Promise((resolve) => { releasePersistence = resolve; });
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(_sessionId, _language, event) { delivered.push(event); },
    async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) await persistenceGate;
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const publishing = publisher.publish("session-1", "ko", {
    type: "caption", seq: 1, isFinal: true, text: "즉시 표시",
    sourceEndedAt: "2026-07-23T00:00:04.000Z", emittedAt: "2026-07-23T00:00:04.100Z",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [], "a final must remain invisible until both records commit");
  releasePersistence();
  await publishing;
  assert.equal(delivered[0]?.text, "즉시 표시");
});

test("a stopped snapshot guard blocks viewer and host live delivery", async () => {
  const delivered = [];
  const mirrored = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(_sessionId, _language, event) { delivered.push(event); },
    async audioFanout() {},
    async fetchFn(url) {
      const value = String(url).includes("persist_live_final_caption_if_active") ? false : true;
      return Response.json(value);
    },
  });
  await assert.rejects(
    publisher.publish(
      "session-1",
      "ko",
      { type: "caption", seq: 1, isFinal: true, text: "중단" },
      { onLiveEvent: async (event) => mirrored.push(event) },
    ),
    /SESSION_STOPPED/u,
  );
  assert.deepEqual(delivered, []);
  assert.deepEqual(mirrored, []);
});

test("an atomic utterance failure blocks delivery and every later final on that lane", async () => {
  const fanned = [];
  let durableAttempts = 0;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout(...args) { fanned.push(args); },
    async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        durableAttempts += 1;
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

  await assert.rejects(publisher.publish("session-1", "ko", caption), /DURABLE_CAPTION_PERSIST_FAILED/u);
  await assert.rejects(
    publisher.publish("session-1", "ko", { ...caption, seq: 13, text: "다음 문장" }),
    /DURABLE_CAPTION_LANE_FAILED/u,
  );
  assert.equal(durableAttempts, 1, "recording errors must not be hidden by an automatic retry");
  assert.deepEqual(fanned, []);
});

test("a combined RPC false result is treated only as a stopped session", async () => {
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() { throw new Error("must not fan out"); },
    async audioFanout() {},
    async fetchFn() { return Response.json(false); },
  });
  await assert.rejects(
    publisher.publish("session-1", "en", { type: "caption", seq: 13, isFinal: true, text: "stopped" }),
    /SESSION_STOPPED/u,
  );
});

test("a genuine snapshot RPC decline still stops emission as SESSION_STOPPED", async () => {
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co", serviceRoleKey: "secret",
    async eventFanout() {}, async audioFanout() {},
    async fetchFn(url) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
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
        { seq: 3, participant_id: "participant-1", speaker_label: "participant:participant-1", speaker_name: "김노엘", text: "셋", source_text: "three", source_language: "en", translation_status: "failed", source_ended_at: "2026-07-23T00:00:03Z", emitted_at: "2026-07-23T00:00:03.100Z" },
        { seq: 4, speaker_label: null, speaker_name: null, text: "원문", source_text: null, source_language: "ko", origin: "source", utterance_key: "session-1:input:4", source_ended_at: "2026-07-23T00:00:04Z", emitted_at: "2026-07-23T00:00:04.100Z" },
        // A row predating the provenance columns: replay must still work and
        // simply offer no original to disclose.
        { seq: 5, speaker_label: null, speaker_name: null, text: "다섯", source_ended_at: "2026-07-23T00:00:05Z", emitted_at: "2026-07-23T00:00:05.100Z" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const events = await publisher.fetchUtterancesAfter("session-1", "ko", 2);
  assert.equal(seen.searchParams.get("seq"), "gt.2");
  assert.equal(seen.searchParams.get("order"), "seq.asc");
  assert.equal(seen.searchParams.get("limit"), "200");
  assert.deepEqual(events.map((event) => [event.type, event.seq, event.text, event.isFinal]), [
    ["caption", 3, "셋", true],
    ["caption", 4, "원문", true],
    ["caption", 5, "다섯", true],
  ]);
  // The full SpeakerAssignment shape: the webapp viewer validates every field
  // and silently drops replayed captions whose speaker is partial.
  assert.deepEqual(events[0].speaker, {
    speakerId: "participant:participant-1",
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
    events.map((event) => [event.sourceText, event.sourceLanguage, event.translationStatus, event.origin, event.utteranceKey]),
    [["three", "en", "failed", undefined, undefined], [null, "ko", "verbatim", "source", "session-1:input:4"], [null, null, "verbatim", undefined, undefined]],
  );
  assert.match(seen.searchParams.get("select"), /participant_id/u);
  assert.match(seen.searchParams.get("select"), /translation_status/u);
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
  const utteranceCall = rpcBodies.find((call) => call.url.includes("persist_live_final_caption_if_active"));
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
  const call = rpcBodies.find((entry) => entry.url.includes("persist_live_final_caption_if_active"));
  assert.equal(call.body.p_participant_id, "p-77");
  assert.equal(call.body.p_speaker_name, "김참가");
  assert.equal(call.body.p_speaker_label, "participant:p-77");
});
