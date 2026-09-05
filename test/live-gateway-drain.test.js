import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { requestLiveGatewayDrain } from "../src/live-gateway-drain.js";

function socketFixture() {
  const sent = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, sent, send: (data) => sent.push(JSON.parse(data)) });
  return socket;
}

test("drain waits for the matching session acknowledgement and removes listeners", async () => {
  const socket = socketFixture();
  const pending = requestLiveGatewayDrain(socket, "meeting", 100);
  socket.emit("message", Buffer.from('{"type":"drained","sessionId":"other"}'));
  socket.emit("message", Buffer.from('{"type":"stopped","sessionId":"meeting"}'));
  assert.equal(socket.listenerCount("message"), 1);
  socket.emit("message", Buffer.from('{"type":"drained","sessionId":"meeting"}'));
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(socket.sent, [{ type: "drain", sessionId: "meeting" }]);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});

test("timeout, provider error and closed socket never count as durable drain", async () => {
  const socket = socketFixture();
  assert.deepEqual(await requestLiveGatewayDrain(socket, "meeting", 5), { ok: false, code: "MEDIA_DRAIN_TIMEOUT" });
  const pending = requestLiveGatewayDrain(socket, "meeting", 100);
  socket.emit("message", Buffer.from('{"type":"error","code":"SOURCE_TRANSCRIPT_FAILED"}'));
  assert.deepEqual(await pending, { ok: false, code: "MEDIA_DRAIN_FAILED" });
  const closed = requestLiveGatewayDrain(socket, "meeting", 100);
  socket.emit("close");
  assert.deepEqual(await closed, { ok: false, code: "MEDIA_DRAIN_FAILED" });
  assert.equal(socket.listenerCount("message"), 0);
});

test("native end awaits durable drain before terminal API and aborts on failure", () => {
  const source = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
  const end = source.slice(source.indexOf('ipcMain.handle("live-call:end"'), source.indexOf('ipcMain.handle("subtitle-overlay:list-displays"'));
  const drain = end.indexOf("await drainLiveGatewayBridge(endingSession)");
  assert.ok(drain > 0 && drain < end.indexOf('method: "DELETE"'));
  assert.match(end, /if \(!drained\.ok\)[\s\S]*return drained/u);
});
