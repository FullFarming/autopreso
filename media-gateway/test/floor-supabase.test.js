import assert from "node:assert/strict";
import test from "node:test";

import { SupabaseFloorController, SupabaseLivePublisher } from "../src/supabase-adapters.js";

function makeFetch(responses) {
  const calls = [];
  return {
    calls,
    async fetchFn(url, init) {
      calls.push({ url, init });
      const responder = responses.shift() ?? (() => ({ status: 200, body: "true" }));
      const { status, body } = responder({ url, init });
      return new Response(body, { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

test("floor controller takes and releases the floor through guarded RPCs", async () => {
  const { calls, fetchFn } = makeFetch([
    () => ({ status: 200, body: JSON.stringify({ ok: true, displayName: "김노엘", participantId: "participant-1" }) }),
    () => ({ status: 200, body: "true" }),
  ]);
  const controller = new SupabaseFloorController({
    baseUrl: "https://example.supabase.co",
    supabaseApiKey: "secret-key",
    supabaseKeyType: "secret",
    fetchFn,
  });

  const taken = await controller.take("session-1", "grant-1");
  assert.deepEqual(taken, { ok: true, displayName: "김노엘", participantId: "participant-1" });
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/take_live_floor$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_session_id: "session-1", p_grant_id: "grant-1" });

  const released = await controller.release("session-1", "grant-1");
  assert.equal(released, true);
  assert.match(calls[1].url, /\/rest\/v1\/rpc\/release_live_floor$/);

  // A network failure degrades to a denial instead of throwing.
  const failing = new SupabaseFloorController({
    baseUrl: "https://example.supabase.co",
    supabaseApiKey: "secret-key",
    supabaseKeyType: "secret",
    fetchFn: async () => { throw new Error("network"); },
  });
  assert.deepEqual(await failing.take("session-1", "grant-1"), { ok: false, code: "FLOOR_DENIED" });
  assert.equal(await failing.release("session-1", "grant-1"), false);
});

test("publisher persists each final through the atomic durable RPC", async () => {
  const rpcCalls = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://example.supabase.co",
    supabaseApiKey: "secret-key",
    supabaseKeyType: "secret",
    eventFanout: async () => {},
    audioFanout: async () => {},
    async fetchFn(url, init) {
      rpcCalls.push({ url, init });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await publisher.publish("session-1", "ko", {
    type: "caption",
    seq: 7,
    sessionId: "session-1",
    language: "ko",
    speaker: { speakerId: "speaker-1", label: "김노엘", colorToken: "speaker-blue", voiceName: null, voiceStatus: "disabled", lastSeenAt: "2026-07-23T00:00:00Z" },
    text: "안녕하세요",
    isFinal: true,
    sourceEndedAt: "2026-07-23T00:00:00Z",
    emittedAt: "2026-07-23T00:00:01Z",
  });

  const utteranceCall = rpcCalls.find((call) => call.url.endsWith("/rest/v1/rpc/persist_live_final_caption_if_active"));
  assert.ok(utteranceCall, "atomic durable RPC should be called for final captions");
  const payload = JSON.parse(utteranceCall.init.body);
  assert.equal(payload.p_event.seq, 7);
  assert.equal(payload.p_seq, 7);
  assert.equal(payload.p_text, "안녕하세요");
  assert.equal(payload.p_speaker_label, "speaker-1");
  assert.equal(payload.p_speaker_name, "김노엘");

  // Partial captions are not persisted.
  const before = rpcCalls.length;
  await publisher.publish("session-1", "ko", {
    type: "caption", seq: 8, sessionId: "session-1", language: "ko", speaker: null,
    text: "부분", isFinal: false, sourceEndedAt: "2026-07-23T00:00:02Z", emittedAt: "2026-07-23T00:00:02Z",
  });
  assert.equal(rpcCalls.length, before);
});

// 2026-09-06 incident: every Live Call since the authoritative-source link shipped recorded
// source rows but ZERO captions. The pipeline puts `authoritativeSourceId` and `sourceSequence`
// on the caption event for the host/viewer wire, and the adapter forwarded them inside
// `p_event`. The snapshot validator (persist_live_snapshot_if_active_20260725) rejects any
// top-level key outside its allowlist and returns false — silently, as a 200 — so the atomic
// final never stored. The link itself travels as `p_authoritative_source_id`; the durable
// event must not repeat it.
test("durable final events carry the authoritative link only as p_authoritative_source_id, never as event keys", async () => {
  const rpcCalls = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://example.supabase.co",
    supabaseApiKey: "secret-key",
    supabaseKeyType: "secret",
    eventFanout: async () => {},
    audioFanout: async () => {},
    async fetchFn(url, init) {
      rpcCalls.push({ url, init });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const sourceId = "3fa6cc83-17f3-43a9-ab63-6191ebb46a70";
  await publisher.publish("session-1", "en", {
    type: "caption", seq: 1, sessionId: "session-1", language: "en",
    speaker: { speakerId: "speaker-1", label: "Speaker 1", colorToken: "speaker-teal", voiceName: null, voiceStatus: "disabled", lastSeenAt: "2026-09-06T06:00:24.000Z" },
    text: "Can you hear what I am saying?", isFinal: true,
    sourceText: "지금 얘기하는 게 잘 들리나요?", sourceLanguage: "ko", translationStatus: "translated",
    authoritativeSourceId: sourceId, sourceSequence: 1, utteranceKey: "stt-v1:abc",
    sourceStartedAt: "2026-09-06T06:00:16.410Z", sourceEndedAt: "2026-09-06T06:00:24.210Z", emittedAt: "2026-09-06T06:00:24.500Z",
  });
  const call = rpcCalls.find((entry) => entry.url.endsWith("/rest/v1/rpc/persist_live_final_caption_if_active"));
  assert.ok(call, "final persisted through the atomic RPC");
  const payload = JSON.parse(call.init.body);
  assert.equal(payload.p_authoritative_source_id, sourceId);
  assert.equal(payload.p_utterance_key, "stt-v1:abc");
  assert.equal(Object.hasOwn(payload.p_event, "authoritativeSourceId"), false, "link is a column, not an event key");
  assert.equal(Object.hasOwn(payload.p_event, "sourceSequence"), false, "sourceSequence is derivable from the linked source row");
  // The wire event handed to viewers keeps both keys (LiveViewer's source ledger reads them).
  assert.equal(payload.p_event.utteranceKey, "stt-v1:abc");
});
