import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { DEFAULT_ENGINE_SELECTION, GEMINI_ENGINE_SELECTION } from "../packages/caption-core/caption-engine-catalog.js";

for (const scenario of ["assigned", "missing", "unavailable"]) {
  test(`caption start honors server assignment: ${scenario}`, { timeout: 5_000 }, async () => {
    const starts = [];
    const instance = await startServer({
      host: "127.0.0.1", port: 0,
      ...(scenario === "missing" ? {} : { resolveCaptionEngine: async () => {
        if (scenario === "unavailable") throw new Error("offline");
        return DEFAULT_ENGINE_SELECTION;
      } }),
      createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
      createSubtitleRealtimeManager: () => ({
        start: async (value) => { starts.push(value); }, stop: async () => {}, close() {}, sendAudio() {},
      }),
    });
    const socket = new WebSocket(instance.url.replace("http:", "ws:") + "/ws", { headers: { Origin: instance.url } });
    try {
      await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      const response = new Promise((resolve) => socket.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type === "subtitle:started" || event.type === "subtitle:error") resolve(event);
      }));
      socket.send(JSON.stringify({ type: "subtitle:start", sessionId: "assignment-fixture", settings: { engine: GEMINI_ENGINE_SELECTION } }));
      const result = await response;
      if (scenario === "assigned") {
        assert.equal(result.type, "subtitle:started");
        assert.equal(starts.length, 1);
        assert.deepEqual(starts[0].settings.engine, DEFAULT_ENGINE_SELECTION);
      } else {
        assert.equal(result.type, "subtitle:error");
        assert.equal(starts.length, 0);
      }
    } finally {
      socket.terminate();
      await new Promise((resolve) => instance.httpServer.close(resolve));
    }
  });
}

for (const scenario of ['managed', 'stopped-during-issue', 'provider-start-failed']) {
  test(`managed caption assignment lifecycle: ${scenario}`, { timeout: 5_000 }, async () => {
    const starts = [];
    const revoked = [];
    let issue = () => {};
    let requested;
    const requestedPromise = new Promise((resolve) => { requested = resolve; });
    const managedSession = { ticket: 'opaque-runtime-only', sessionId: 'managed-id', engine: DEFAULT_ENGINE_SELECTION };
    const instance = await startServer({
      host: '127.0.0.1', port: 0,
      startCaptionSession: async (languages) => {
        assert.deepEqual(languages, ['ko', 'en', 'ja']);
        requested?.();
        if (scenario === 'stopped-during-issue') await new Promise((resolve) => { issue = () => resolve(undefined); });
        return managedSession;
      },
      stopCaptionSession: async (session) => { revoked.push(session.sessionId); },
      createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
      createSubtitleRealtimeManager: () => ({
        start: async (value) => { if (scenario === 'provider-start-failed') throw new Error('PROVIDER_UNAVAILABLE'); starts.push(value); },
        stop: async () => {}, close() {}, sendAudio() {},
      }),
    });
    const socket = new WebSocket(instance.url.replace('http:', 'ws:') + '/ws', { headers: { Origin: instance.url } });
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const outcome = new Promise((resolve) => socket.on('message', (raw) => {
        const event = JSON.parse(String(raw));
        if (['subtitle:started', 'subtitle:stopped', 'subtitle:error'].includes(event.type)) resolve(event);
      }));
      socket.send(JSON.stringify({ type: 'subtitle:start', sessionId: 'managed-start', settings: { engine: GEMINI_ENGINE_SELECTION, translationLanguages: ['ko', 'en', 'ja'] } }));
      await requestedPromise;
      if (scenario === 'stopped-during-issue') {
        socket.send(JSON.stringify({ type: 'subtitle:stop', sessionId: 'managed-start' }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        issue?.();
      }
      const result = await outcome;
      if (scenario === 'managed') {
        assert.equal(result.type, 'subtitle:started');
        assert.equal(starts.length, 1);
        assert.deepEqual(starts[0].settings.engine, DEFAULT_ENGINE_SELECTION);
        assert.equal(starts[0].managedSession.ticket, managedSession.ticket);
      } else {
        assert.notEqual(result.type, 'subtitle:started');
        assert.equal(starts.length, 0);
        assert.deepEqual(revoked, ['managed-id']);
      }
    } finally {
      issue?.();
      socket.terminate();
      await new Promise((resolve) => instance.httpServer.close(resolve));
    }
  });
}

test('dashboard configuration displays authenticated assignment rather than saved engine', async () => {
  const instance = await startServer({
    host: '127.0.0.1', port: 0,
    resolveCaptionEngine: async () => GEMINI_ENGINE_SELECTION,
    createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
  });
  try {
    const response = await fetch(`${instance.url}/api/config`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.settings.subtitle.engine, GEMINI_ENGINE_SELECTION);
  } finally { await new Promise((resolve) => instance.httpServer.close(resolve)); }
});
