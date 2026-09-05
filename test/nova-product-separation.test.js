import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";

async function startIsolatedServer() {
  let whiteboardStarts = 0;
  const instance = await startServer({
    host: "127.0.0.1", port: 0,
    createTranscription: () => {
      whiteboardStarts += 1;
      return { ready: async () => {}, close() {}, stop() {}, sendAudio() {} };
    },
    createSubtitleRealtimeManager: () => ({ close() {}, start() {}, stop() {}, sendAudio() {} }),
  });
  return { ...instance, whiteboardStarts };
}

test("NOVA routes expose only caption product assets and reject canvas APIs", async () => {
  const server = await startIsolatedServer();
  try {
    for (const route of ["/", "/index.html", "/subtitle", "/subtitle.html"]) {
      const response = await fetch(server.url + route);
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), /subtitle-dashboard\.js/u, route);
    }
    for (const asset of ["app.js", "style.css", "starter-elements.js", "meeting-coach-prep.html", "live-interpreter.html", "icons/README.md"]) {
      assert.equal((await fetch(`${server.url}/${asset}`)).status, 404, asset);
    }
    for (const asset of ["subtitle-dashboard.js", "controller-appearance.js", "subtitle-audio-capture.js", "icons/radio.svg"]) {
      assert.equal((await fetch(`${server.url}/${asset}`)).status, 200, asset);
    }
    for (const route of ["/api/preso/start", "/api/preso/back-to-staging", "/api/session/reset"]) {
      const response = await fetch(server.url + route, {
        method: "POST", headers: { origin: server.url, "content-type": "application/json" }, body: "{}",
      });
      assert.equal(response.status, 404, route);
    }
    assert.equal(server.whiteboardStarts, 0);
    assert.equal("state" in server, false);
  } finally { await new Promise((resolve) => server.httpServer.close(resolve)); }
});

test("NOVA websocket has no canvas session events or canvas audio pipeline", async () => {
  const server = await startIsolatedServer();
  const socket = new WebSocket(server.url.replace("http:", "ws:") + "/ws", { headers: { Origin: server.url } });
  const events = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  try {
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "whiteboard:user-elements", elements: [] }));
    socket.send(JSON.stringify({ type: "audio:start", sessionId: "canvas" }));
    socket.send(JSON.stringify({ type: "audio", audio: "AAAA", sessionId: "canvas" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(events.some((event) => ["agent:status", "mode", "warmup", "cost", "whiteboard:update"].includes(event.type)), false);
    assert.equal(events.some((event) => event.type === "subtitle:history"), true);
    assert.equal(server.whiteboardStarts, 0);
  } finally {
    socket.terminate();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
});
