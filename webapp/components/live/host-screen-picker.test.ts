import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadHostScreenSessions } from "./host-screen-sessions";

const firstId = "12345678-1234-4234-8234-123456789001";
const secondId = "12345678-1234-4234-8234-123456789002";
const session = (id: string, status = "live") => ({ id, title: "진행 중인 세션", status });
const page = (sessions: unknown[], nextOffset: number | null) => Response.json({ ok: true, data: { sessions, nextOffset } });

test("loads every owned page using GET and excludes terminal sessions", async () => {
  const requests: string[] = [];
  const result = await loadHostScreenSessions(async (url, options) => {
    requests.push(String(url));
    assert.equal(options?.method, "GET");
    assert.equal(options?.cache, "no-store");
    return requests.length === 1
      ? page([session(firstId), session(secondId, "stopped")], 100)
      : page([session(firstId), session(secondId, "paused")], null);
  }, new AbortController().signal);
  assert.deepEqual(requests, ["/api/live-sessions?scope=mine", "/api/live-sessions?scope=mine&offset=100"]);
  assert.deepEqual(result.map(({ id }) => id), [firstId, secondId]);
});

test("empty sessions remain empty and preparing sessions are selectable", async () => {
  assert.deepEqual(await loadHostScreenSessions(async () => page([], null), new AbortController().signal), []);
  assert.equal((await loadHostScreenSessions(async () => page([session(firstId, "preparing")], null), new AbortController().signal))[0].status, "preparing");
});

test("authentication and next-page failures are explicit, without returning partial results", async () => {
  await assert.rejects(loadHostScreenSessions(async () => Response.json({ ok: false }, { status: 401 }), new AbortController().signal), /다시 로그인/);
  let calls = 0;
  await assert.rejects(loadHostScreenSessions(async () => ++calls === 1 ? page([session(firstId)], 100) : new Response(null, { status: 503 }), new AbortController().signal), /불러오지 못/);
});

test("invalid identifiers and non-advancing pages fail closed", async () => {
  await assert.rejects(loadHostScreenSessions(async () => page([session("../admin")], null), new AbortController().signal));
  await assert.rejects(loadHostScreenSessions(async () => page([], 0), new AbortController().signal));
});

test("network and malformed JSON errors provide Korean recovery messages", async () => {
  await assert.rejects(loadHostScreenSessions(async () => { throw new TypeError("Failed to fetch"); }, new AbortController().signal), /불러오지 못/);
  await assert.rejects(loadHostScreenSessions(async () => new Response("broken"), new AbortController().signal), /확인할 수 없/);
});

test("aborted discovery stops before another page fetch", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(loadHostScreenSessions(async () => {
    calls += 1;
    controller.abort();
    return page([session(firstId)], 100);
  }, controller.signal));
  assert.equal(calls, 1);
});

test("companion route uses stage links without audio, creation, or invite mutations", () => {
  const component = readFileSync(new URL("./HostScreenPicker.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../app/host-screen/page.tsx", import.meta.url), "utf8");
  assert.match(route, /HostScreenPicker/);
  assert.match(component, /href=\{`\/stage\/\$\{session.id\}`\}/);
  assert.doesNotMatch(component, /LiveHostDashboard|live-audio-client|getUserMedia|gateway-token|WebSocket|method:\s*["']POST/);
  assert.match(component, /controller.abort\(\)/);
  assert.match(component, /role="alert"/);
});
