import assert from "node:assert/strict";
import test from "node:test";

import type { LiveSessionStore } from "./store";
import {
  getServerLiveGatewayHealthUrl,
  LIVE_GATEWAY_PREWARM_LATE_GRACE_MILLISECONDS,
  LIVE_GATEWAY_PREWARM_LEAD_MILLISECONDS,
  prewarmScheduledLiveGateway,
} from "./gateway-prewarm";

function storeWithSchedule(result: boolean, observe?: (startAt: string, endAt: string) => void): LiveSessionStore {
  return {
    async hasPreparingScheduledBetween(startAt: string, endAt: string) {
      observe?.(startAt, endAt);
      return result;
    },
  } as LiveSessionStore;
}

test("scheduled gateway cron warms only when a preparing call is within T-60", async () => {
  const now = Date.parse("2026-08-29T00:00:00.000Z");
  let requestCount = 0;
  let observedWindow: [string, string] | null = null;
  const idle = await prewarmScheduledLiveGateway({
    store: storeWithSchedule(false),
    gatewayUrl: "wss://gateway.example.run.app/live",
    now: () => now,
    request: async () => {
      requestCount += 1;
      return new Response(null, { status: 200 });
    },
  });
  assert.deepEqual(idle, { warmed: false, status: null });
  assert.equal(requestCount, 0);

  const warmed = await prewarmScheduledLiveGateway({
    store: storeWithSchedule(true, (startAt, endAt) => { observedWindow = [startAt, endAt]; }),
    gatewayUrl: "wss://gateway.example.run.app/live",
    now: () => now,
    request: async (input, init) => {
      requestCount += 1;
      assert.equal(String(input), "https://gateway.example.run.app/health");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(warmed, { warmed: true, status: 204 });
  assert.equal(requestCount, 1);
  assert.deepEqual(observedWindow, [
    new Date(now - LIVE_GATEWAY_PREWARM_LATE_GRACE_MILLISECONDS).toISOString(),
    new Date(now + LIVE_GATEWAY_PREWARM_LEAD_MILLISECONDS).toISOString(),
  ]);
});

test("server gateway health URL is strict HTTPS without credentials, ports, query, or fragments", () => {
  assert.equal(getServerLiveGatewayHealthUrl("wss://gateway.example.run.app/live"), "https://gateway.example.run.app/health");
  for (const value of [
    "ws://gateway.example.run.app/live",
    "wss://gateway.example.run.app:8443/live",
    "wss://user@gateway.example.run.app/live",
    "wss://gateway.example.run.app/live?x=1",
    "wss://gateway.example.run.app/live#x",
    "wss://gateway.example.run.app/other",
  ]) assert.throws(() => getServerLiveGatewayHealthUrl(value), /INVALID_LIVE_GATEWAY_URL/u);
});


test("scheduled gateway cron fails closed when Cloud Run is not healthy", async () => {
  await assert.rejects(
    () => prewarmScheduledLiveGateway({
      store: storeWithSchedule(true),
      gatewayUrl: "wss://gateway.example.run.app/live",
      request: async () => new Response(null, { status: 503 }),
    }),
    /LIVE_GATEWAY_PREWARM_UNHEALTHY/u,
  );
});
