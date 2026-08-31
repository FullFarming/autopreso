import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldConnectGatewayForSessionStatus,
  shouldWarmGatewayForEvent,
  transitionGatewayConnectionState,
  type GatewayConnectionEvent,
  type GatewayConnectionState,
} from "./gateway-connection-state";

test("host start is the only event that enters warming or authorizes a health warmup", () => {
  const hostStart: GatewayConnectionEvent = { type: "host-start" };
  assert.equal(shouldWarmGatewayForEvent(hostStart), true);
  assert.equal(transitionGatewayConnectionState("idle", hostStart), "warming");
  assert.equal(transitionGatewayConnectionState("warming", { type: "warmup-complete" }), "connecting");
  assert.equal(transitionGatewayConnectionState("connecting", { type: "socket-opened", sessionStatus: "live" }), "connected");

  for (const event of [
    { type: "status-opened" },
    { type: "viewer-session", status: "live" },
    { type: "socket-closed", sessionStatus: "live" },
    { type: "recoverable-error" },
  ] as const) {
    assert.equal(shouldWarmGatewayForEvent(event), false, event.type);
  }
  assert.equal(transitionGatewayConnectionState("idle", { type: "status-opened" }), "idle");
  assert.equal(transitionGatewayConnectionState("idle", { type: "viewer-session", status: "live" }), "connecting");
});

test("viewer sockets are limited to live and paused truth and terminal states never reconnect", () => {
  assert.equal(shouldConnectGatewayForSessionStatus("preparing"), false);
  assert.equal(shouldConnectGatewayForSessionStatus("live"), true);
  assert.equal(shouldConnectGatewayForSessionStatus("paused"), true);
  assert.equal(shouldConnectGatewayForSessionStatus("stopped"), false);
  assert.equal(shouldConnectGatewayForSessionStatus("failed"), false);

  assert.equal(transitionGatewayConnectionState("connected", { type: "viewer-session", status: "paused" }), "paused");
  assert.equal(transitionGatewayConnectionState("paused", { type: "socket-closed", sessionStatus: "paused" }), "reconnecting");
  assert.equal(transitionGatewayConnectionState("reconnecting", { type: "socket-opened", sessionStatus: "paused" }), "paused");
  assert.equal(transitionGatewayConnectionState("connected", { type: "viewer-session", status: "stopped" }), "ended");
  assert.equal(transitionGatewayConnectionState("ended", { type: "socket-closed", sessionStatus: "live" }), "ended");
  assert.equal(transitionGatewayConnectionState("failed", { type: "viewer-session", status: "live" }), "failed");
});

test("recoverable error keeps an explicit retry path distinct from terminal failure", () => {
  assert.equal(transitionGatewayConnectionState("connecting", { type: "recoverable-error" }), "error");
  assert.equal(transitionGatewayConnectionState("error", { type: "retry" }), "reconnecting");
  assert.equal(transitionGatewayConnectionState("connected", { type: "terminal-failure" }), "failed");
  assert.equal(transitionGatewayConnectionState("failed", { type: "retry" }), "failed");
  assert.equal(transitionGatewayConnectionState("failed", { type: "reset" }), "idle");
});

test("the lifecycle exports only the approved closed state set", () => {
  const states: GatewayConnectionState[] = [
    "idle", "warming", "connecting", "connected", "reconnecting",
    "paused", "error", "ended", "failed",
  ];
  assert.equal(new Set(states).size, 9);
});
