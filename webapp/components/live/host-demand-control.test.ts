import assert from "node:assert/strict";
import test from "node:test";
import { canConnectHostMedia, createHostDemandControl, type HostMediaRuntime } from "./host-demand-control";

const sessionId = "11111111-1111-4111-8111-111111111111";
const success = () => Response.json({ ok: true, data: {} });
const microtasks = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

test("host source release is serialized behind its pending ready heartbeat and reacquisition rotates its generation", async () => {
  const requests: Array<{ sourceGeneration: string; sourceReady: boolean }> = [];
  let completeFirst: (response: Response) => void = () => { throw new Error("first request has not started"); };
  const firstResponse = new Promise<Response>((resolve) => { completeFirst = resolve; });
  const control = createHostDemandControl(sessionId, async (url, init) => {
    assert.equal(String(url), `/api/live-sessions/${sessionId}/host-source`);
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal instanceof AbortSignal);
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1 ? firstResponse : success();
  });
  const ready = control.setSourceReady(true);
  const released = control.setSourceReady(false);
  await microtasks();
  assert.equal(requests.length, 1, "release must not overtake a ready request still in flight");
  completeFirst(success());
  await Promise.all([ready, released]);
  assert.deepEqual(requests.map(({ sourceReady }) => sourceReady), [true, false]);
  assert.equal(requests[0].sourceGeneration, requests[1].sourceGeneration);
  await control.setSourceReady(true);
  assert.notEqual(requests[2].sourceGeneration, requests[0].sourceGeneration);
  await control.setSourceReady(true);
  assert.equal(requests.length, 3, "an immediate duplicate heartbeat must not write again");
});

test("failed source heartbeat rejects its caller while allowing the queued release to reach the server", async () => {
  const values: boolean[] = [];
  const control = createHostDemandControl(sessionId, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { sourceReady: boolean };
    values.push(body.sourceReady);
    return body.sourceReady ? Response.json({ ok: false, error: "unavailable" }, { status: 503 }) : success();
  });
  const failed = assert.rejects(control.setSourceReady(true), /확인하지 못/u);
  const released = control.setSourceReady(false);
  await Promise.all([failed, released]);
  assert.deepEqual(values, [true, false]);
});

test("an ambiguous source release remains an error but the next capture never reuses its tombstoned generation", async () => {
  const requests: Array<{ sourceGeneration: string; sourceReady: boolean }> = [];
  const control = createHostDemandControl(sessionId, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { sourceGeneration: string; sourceReady: boolean };
    requests.push(body);
    if (!body.sourceReady) throw new Error("release response lost after commit");
    return success();
  });
  await control.setSourceReady(true);
  await assert.rejects(control.setSourceReady(false), /response lost/);
  await control.setSourceReady(true);
  assert.deepEqual(requests.map(({ sourceReady }) => sourceReady), [true, false, true]);
  assert.equal(requests[0].sourceGeneration, requests[1].sourceGeneration);
  assert.notEqual(requests[0].sourceGeneration, requests[2].sourceGeneration);
});

test("runtime reads reject malformed or denied responses instead of falling back to an active connection", async () => {
  for (const response of [
    Response.json({ ok: false, data: { enabled: false } }, { status: 403 }),
    Response.json({ enabled: false }), Response.json({ ok: true, data: null }),
    Response.json({ ok: true, data: { enabled: true, state: "active", hasDemand: true } }),
    Response.json({ ok: true, data: { enabled: true, state: "active", hasDemand: "true", hostSourceReady: true } }),
    Response.json({ ok: true, data: { enabled: true, state: "unknown", hasDemand: true, hostSourceReady: true } }),
    new Response("not JSON"),
  ]) {
    const control = createHostDemandControl(sessionId, async () => response);
    await assert.rejects(control.read());
  }
  const control = createHostDemandControl(sessionId, async (_url, init) => {
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ ok: true, data: { enabled: false } });
  });
  assert.deepEqual(await control.read(), { enabled: false });
});

test("enabled host media requires both source readiness and participant demand in an allowed runtime state", () => {
  for (const state of ["sleeping", "waking", "active", "draining", "failed", "ended"] as const) {
    for (const hostSourceReady of [true, false]) for (const hasDemand of [true, false]) {
      const runtime: HostMediaRuntime = { enabled: true, state, hostSourceReady, hasDemand };
      assert.equal(canConnectHostMedia(runtime), hostSourceReady && hasDemand && (state === "waking" || state === "active"));
    }
  }
  assert.equal(canConnectHostMedia({ enabled: true }), false);
  assert.equal(canConnectHostMedia({ enabled: false }), true);
});

test("only explicit retry resets failed media using the fresh authoritative session version", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const control = createHostDemandControl(sessionId, async (url, init) => {
    calls.push({ url: String(url), body: init?.body as string | undefined });
    if (String(url).endsWith("/start")) return Response.json({ ok: true,
      data: { sessionId, version: 12, runtime: { enabled: true } } });
    return Response.json({ ok: true, data: { id: sessionId, status: "live", version: 12 } });
  });
  assert.equal(calls.length, 0);
  await control.retryStart();
  assert.deepEqual(calls.map(({ url }) => url), [`/api/live-sessions/${sessionId}`, `/api/live-sessions/${sessionId}/start`]);
  assert.deepEqual(JSON.parse(calls[1].body!), { version: 12, demandEnabled: true });
});

test("a denied explicit retry never falls through to a gateway connection", async () => {
  const control = createHostDemandControl(sessionId, async () => Response.json({ ok: false }, { status: 403 }));
  await assert.rejects(control.retryStart());
});
