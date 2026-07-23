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
    () => ({ status: 200, body: JSON.stringify({ ok: true, displayName: "김노엘" }) }),
    () => ({ status: 200, body: "true" }),
  ]);
  const controller = new SupabaseFloorController({
    baseUrl: "https://example.supabase.co",
    supabaseApiKey: "secret-key",
    supabaseKeyType: "secret",
    fetchFn,
  });

  const taken = await controller.take("session-1", "grant-1");
  assert.deepEqual(taken, { ok: true, displayName: "김노엘" });
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

test("publisher persists final captions as utterances without failing the pipeline", async () => {
  const rpcCalls = [];
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://example.supabase.co",
    supabaseApiKey: "secret-key",
    supabaseKeyType: "secret",
    eventFanout: async () => {},
    audioFanout: async () => {},
    async fetchFn(url, init) {
      rpcCalls.push({ url, init });
      if (url.endsWith("/rest/v1/rpc/persist_live_utterance_if_active")) {
        // Cap reached: RPC declines, publish must still succeed.
        return new Response("false", { status: 200, headers: { "Content-Type": "application/json" } });
      }
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

  const utteranceCall = rpcCalls.find((call) => call.url.endsWith("/rest/v1/rpc/persist_live_utterance_if_active"));
  assert.ok(utteranceCall, "utterance RPC should be called for final captions");
  const payload = JSON.parse(utteranceCall.init.body);
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
