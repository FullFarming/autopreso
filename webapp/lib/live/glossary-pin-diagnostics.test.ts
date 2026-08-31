import assert from "node:assert/strict";
import test from "node:test";

import { LiveSessionError, toLiveFailure } from "./errors";
import { LiveSessionService } from "./service";
import { MemoryLiveSessionStore, SupabaseLiveSessionStore } from "./store";

const credentials = { key: `sb_secret_${"t".repeat(24)}`, kind: "secret" as const };
const privateFixture = "private-host@example.test SECRET_FIXTURE https://private.invalid/session";

test("undefined SQL function blocks glossary pinning after one RPC and logs only bounded diagnostic metadata", async (context) => {
  const log: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => { log.push(values); });
  const sessionId = crypto.randomUUID();
  let requests = 0;
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", credentials, (async () => {
    requests += 1;
    return Response.json({ code: "42883", message: `function pg_catalog.coalesce(text, unknown) does not exist ${privateFixture}`, details: privateFixture, hint: privateFixture }, { status: 404 });
  }) as typeof fetch);
  await assert.rejects(
    store.replaceGlossaryPinsOwned(sessionId, privateFixture, 1, [{ sourceKind: "builtin", sourceId: "common_business" }]),
    (error: unknown) => error instanceof LiveSessionError && toLiveFailure(error).body.code === "LIVE_STORE_UNAVAILABLE" && error.status === 503 && !error.message.includes(privateFixture),
  );
  assert.equal(requests, 1, "a failed pin must not retry or continue without the selected glossary");
  assert.deepEqual(log, [["live glossary store request failed", { operation: "replace", status: 404, code: "42883" }]]);
  assert.ok(!JSON.stringify(log).includes(sessionId));
});

test("untrusted database messages and unknown diagnostic codes are never copied to logs or responses", async (context) => {
  const log: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => { log.push(values); });
  for (const body of [
    { code: privateFixture, message: privateFixture, details: privateFixture },
    { code: { nested: privateFixture }, message: privateFixture },
    null,
  ]) {
    const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", credentials, (async () => Response.json(body, { status: 500 })) as typeof fetch);
    await assert.rejects(store.replaceGlossaryPinsOwned(crypto.randomUUID(), "host", 1, [{ sourceKind: "builtin", sourceId: "ai_ax" }]), (error: unknown) => {
      assert.deepEqual(toLiveFailure(error), { status: 503, body: { ok: false, error: "세션 용어집 저장소에 연결하지 못했습니다.", code: "LIVE_STORE_UNAVAILABLE" } });
      return true;
    });
  }
  assert.equal(log.length, 3);
  assert.ok(log.every((entry) => JSON.stringify(entry) === JSON.stringify(["live glossary store request failed", { operation: "replace", status: 500, code: "UNCLASSIFIED" }])));
});

test("pinned glossary reads retain their owner guard and diagnose the same deployed SQL failure without disclosing content", async (context) => {
  const log: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => { log.push(values); });
  const session = await new LiveSessionService(new MemoryLiveSessionStore()).create("owner", { sessionType: "meeting", languages: ["ko", "en"] });
  let requests = 0;
  class OwnedSessionStore extends SupabaseLiveSessionStore {
    override async get() { return session; }
  }
  const store = new OwnedSessionStore("https://dev-ref.supabase.co", credentials, (async () => {
    requests += 1;
    return Response.json({ code: "42883", message: privateFixture, details: privateFixture }, { status: 404 });
  }) as typeof fetch);
  await assert.rejects(store.getGlossaryPinsOwned(session.id, "other-host"), (error: unknown) => error instanceof LiveSessionError && error.code === "SESSION_NOT_FOUND");
  assert.equal(requests, 0);
  assert.equal(log.length, 0);
  await assert.rejects(store.getGlossaryPinsOwned(session.id, "owner"), (error: unknown) => error instanceof LiveSessionError && error.code === "LIVE_STORE_UNAVAILABLE");
  assert.equal(requests, 1);
  assert.deepEqual(log, [["live glossary store request failed", { operation: "read", status: 404, code: "42883" }]]);
});

test("expected version, active-session and ownership denials retain their public mappings without reporting raw database exceptions", async (context) => {
  const log: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => { log.push(values); });
  for (const [message, code, status] of [
    ["LIVE_SESSION_VERSION_CONFLICT", "VERSION_CONFLICT", 409],
    ["ACTIVE_SESSION_GLOSSARY_IMMUTABLE", "ACTIVE_SESSION_GLOSSARY_IMMUTABLE", 409],
    ["LIVE_SESSION_NOT_FOUND", "SESSION_NOT_FOUND", 404],
    ["ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND", "ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND", 404],
  ] as const) {
    const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", credentials, (async () => Response.json({ code: "P0001", message, details: privateFixture }, { status: 400 })) as typeof fetch);
    await assert.rejects(store.replaceGlossaryPinsOwned(crypto.randomUUID(), "host", 1, [{ sourceKind: "builtin", sourceId: "ai_ax" }]), (error: unknown) => error instanceof LiveSessionError && error.code === code && error.status === status);
  }
  assert.deepEqual(log, []);
});
