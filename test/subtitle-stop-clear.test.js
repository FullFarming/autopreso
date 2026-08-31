import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";

const PROJECT_ROOT = path.join(import.meta.dirname, "..");

function waitForMessage(socket, predicate, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(message);
    };
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (predicate(message)) finish(null, message);
    };
    const onClose = () => finish(new Error("WebSocket closed before the expected message."));
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the expected message.")), timeoutMs);
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

async function openSocket(url) {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
    headers: { Origin: url },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function wait(milliseconds = 25) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function createSubtitleManagerHarness({ failStart = false } = {}) {
  const starts = [];
  const stops = [];
  const audio = [];
  const inputSignals = [];
  let broadcast = (_message) => {};
  return {
    starts,
    stops,
    audio,
    inputSignals,
    emit(message) { broadcast(message); },
    factory(options) {
      broadcast = options.broadcast;
      return {
        async start(args) {
          starts.push(args);
          if (failStart) throw new Error("LOCAL_PROVIDER_START_FAILED");
        },
        async stop(sessionId) { stops.push(sessionId); },
        sendAudio(packet) { audio.push(packet); },
        async restartChannels() {},
        noteInputSignal(signal) { inputSignals.push(signal); },
        close() {},
      };
    },
  };
}

test("Live Call hybrid audio accepts local PCM without a Gateway floor", async () => {
  const harness = createSubtitleManagerHarness();
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleRealtimeManager: (options) => harness.factory(options),
  });
  const producer = await openSocket(url);
  try {
    const started = waitForMessage(producer, (message) => (
      message.type === "subtitle:started" && message.captionProducer === "hybrid"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "hybrid",
      sessionId: "bounded-audio",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "call-bounded-audio" },
    }));
    await started;
    const sendAudio = (source, audio) => producer.send(JSON.stringify({
      type: "subtitle:audio",
      sessionId: "bounded-audio",
      source,
      audio,
    }));
    sendAudio("mic", "AAAA");
    sendAudio("participant", Buffer.alloc(4_800).toString("base64"));
    const exactFrame = Buffer.alloc(4_800, 7).toString("base64");
    for (let frame = 0; frame < 21; frame += 1) sendAudio("mic", exactFrame);
    await wait(30);
    assert.equal(harness.audio.length, 20, "the 21st immediate 100 ms frame exceeds the two-second burst budget");
    assert.ok(harness.audio.every((packet) => packet.audio === exactFrame && packet.source === "mic"));
  } finally {
    producer.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("Live Call keeps local Caption Only independent from Gateway floor routing", async () => {
  const harness = createSubtitleManagerHarness();
  const { httpServer, url, applyLiveCallFloorSnapshot } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
    createSubtitleRealtimeManager: (options) => harness.factory(options),
  });
  const sockets = [];
  try {
    const producer = await openSocket(url);
    sockets.push(producer);

    const hybridStarted = waitForMessage(
      producer,
      (message) => message.type === "subtitle:started" && message.captionProducer === "hybrid",
    );
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "hybrid",
      sessionId: "live-hybrid",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "call-hybrid" },
    }));
    await hybridStarted;
    assert.equal(harness.starts.length, 1, "the local realtime provider starts once for the initial local half");

    const localReconfigured = waitForMessage(
      producer,
      (message) => message.type === "subtitle:started" && message.captionProducer === "local",
    );
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "local",
      sessionId: "live-hybrid",
      settings: { inputMode: "mic", translationProvider: "gemini", fontSize: 32 },
      meeting: { kind: "live-call", liveSessionId: "call-hybrid" },
    }));
    await localReconfigured;
    assert.equal(harness.starts.length, 2, "same-session local start keeps the settings reconfigure contract");

    const observed = [];
    producer.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const beforeFloorCaption = waitForMessage(producer,
      (message) => message.type === "subtitle:committed" && message.translatedText === "floor 확인 전 로컬 자막");
    harness.emit({
      type: "subtitle:committed",
      source: "mic",
      targetLanguage: "ko",
      translatedText: "floor 확인 전 로컬 자막",
    });
    await beforeFloorCaption;
    assert.equal(observed.some((message) => message.translatedText === "floor 확인 전 로컬 자막"), true,
      `local Caption Only output must not depend on a Gateway floor ACK: ${JSON.stringify(observed)}`);

    assert.deepEqual(applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "call-hybrid",
      floorRevision: 1,
      holder: null,
    }), {
      ok: true,
      mode: "host",
      liveSessionId: "call-hybrid",
      floorRevision: 1,
      holder: null,
    });
    const hostFloor = waitForMessage(
      producer,
      (message) => message.type === "subtitle:live-call-floor-applied" && message.floorRevision === 1,
    );
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-hybrid",
      liveSessionId: "call-hybrid",
      floorRevision: 1,
      holder: null,
    }));
    assert.equal((await hostFloor).mode, "host");

    const localCaption = waitForMessage(
      producer,
      (message) => message.type === "subtitle:committed" && message.translatedText === "호스트 로컬 자막",
    );
    harness.emit({
      type: "subtitle:partial",
      source: "mic",
      targetLanguage: "ko",
      sourceLanguage: "en",
      sourceText: "Host local",
      translatedText: "호스트 로컬",
    });
    harness.emit({
      type: "subtitle:committed",
      source: "mic",
      targetLanguage: "ko",
      sourceLanguage: "en",
      sourceText: "Host local caption",
      translatedText: "호스트 로컬 자막",
    });
    await localCaption;
    const localConnecting = waitForMessage(
      producer,
      (message) => message.type === "subtitle:status" && message.status === "connecting",
    );
    harness.emit({ type: "subtitle:status", source: "mic", status: "connecting" });
    await localConnecting;
    const lateViewer = new WebSocket(`${url.replace("http:", "ws:")}/ws`, { headers: { Origin: url } });
    sockets.push(lateViewer);
    const liveSnapshot = waitForMessage(lateViewer, (message) => message.type === "subtitle:snapshot");
    await new Promise((resolve, reject) => {
      lateViewer.once("open", resolve);
      lateViewer.once("error", reject);
    });
    assert.equal((await liveSnapshot).liveSessionId, "call-hybrid",
      "local reconnect health must not erase the canonical Live Call snapshot identity");

    producer.send(JSON.stringify({
      type: "subtitle:audio",
      sessionId: "live-hybrid",
      source: "mic",
      audio: Buffer.alloc(4_800, 1).toString("base64"),
    }));
    producer.send(JSON.stringify({
      type: "subtitle:input-status",
      sessionId: "live-hybrid",
      source: "mic",
      status: "signal",
      level: 0.8,
    }));
    await wait();
    assert.equal(harness.audio.length, 1, "host PCM reaches the local provider");
    assert.equal(harness.inputSignals.length, 1, "the local manager owns the host-side stall watchdog");

    applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "call-hybrid",
      floorRevision: 2,
      holder: { participantId: "viewer-1" },
    });
    const participantFloor = waitForMessage(
      producer,
      (message) => message.type === "subtitle:live-call-floor-applied" && message.floorRevision === 2,
    );
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-hybrid",
      liveSessionId: "call-hybrid",
      floorRevision: 2,
      holder: { participantId: "viewer-1" },
    }));
    assert.equal((await participantFloor).mode, "participant");

    harness.emit({
      type: "subtitle:committed",
      source: "mic",
      targetLanguage: "ko",
      translatedText: "늦게 도착한 호스트 로컬 자막",
    });
    harness.emit({ type: "subtitle:status", source: "mic", status: "reconnecting" });
    producer.send(JSON.stringify({
      type: "subtitle:audio",
      sessionId: "live-hybrid",
      source: "mic",
      audio: Buffer.alloc(4_800, 2).toString("base64"),
    }));
    producer.send(JSON.stringify({
      type: "subtitle:input-status",
      sessionId: "live-hybrid",
      source: "mic",
      status: "signal",
      level: 0.8,
    }));
    await wait();
    assert.equal(observed.some((message) => message.translatedText === "늦게 도착한 호스트 로컬 자막"), true,
      "participant floor is presentation routing and must not stop the local provider");
    assert.equal(observed.some((message) => message.type === "subtitle:status" && message.status === "reconnecting"), true,
      "local provider health remains observable while participant presentation is active");
    assert.equal(harness.audio.length, 2, "participant floor does not stop local Caption Only PCM");
    assert.equal(harness.inputSignals.length, 2, "participant floor does not disable the local watchdog");

    const participantCaption = waitForMessage(
      producer,
      (message) => message.type === "subtitle:committed" && message.translatedText === "참가자 게이트웨이 자막",
    );
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-hybrid",
      partial: false,
      targetLanguage: "ko",
      speaker: "Participant",
      speakerRole: "participant",
      translatedText: "참가자 게이트웨이 자막",
    }));
    await participantCaption;

    applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "call-hybrid",
      floorRevision: 3,
      holder: null,
    });
    const hostReturn = waitForMessage(
      producer,
      (message) => message.type === "subtitle:live-call-floor-applied" && message.floorRevision === 3,
    );
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-hybrid",
      liveSessionId: "call-hybrid",
      floorRevision: 3,
      holder: null,
    }));
    assert.equal((await hostReturn).mode, "host");
    producer.send(JSON.stringify({
      type: "subtitle:audio",
      sessionId: "live-hybrid",
      source: "mic",
      audio: Buffer.alloc(4_800, 3).toString("base64"),
    }));
    await wait();
    assert.equal(harness.audio.length, 3, "host floor acknowledgement does not recreate or restart the local provider");

    applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "call-hybrid",
      floorRevision: 4,
      holder: { participantId: "viewer-1" },
    });
    const participantStopFloor = waitForMessage(
      producer,
      (message) => message.type === "subtitle:live-call-floor-applied" && message.floorRevision === 4,
    );
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-hybrid",
      liveSessionId: "call-hybrid",
      floorRevision: 4,
      holder: { participantId: "viewer-1" },
    }));
    await participantStopFloor;
    const stopped = waitForMessage(
      producer,
      (message) => message.type === "subtitle:stopped" && message.sessionId === "live-hybrid",
    );
    producer.send(JSON.stringify({ type: "subtitle:stop", sessionId: "live-hybrid" }));
    await stopped;
    assert.deepEqual(harness.stops, ["live-hybrid"], "one stop closes the local provider once");

    const relayRejected = waitForMessage(
      producer,
      (message) => message.code === "LIVE_CALL_CAPTION_PRODUCER_MISMATCH",
    );
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-hybrid",
      partial: false,
      targetLanguage: "ko",
      translatedText: "종료 후 자막",
    }));
    await relayRejected;
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("subtitle:stopped is emitted only after provider release and permits the next start", async () => {
  const stopGate = deferred();
  const starts = [];
  const stops = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleRealtimeManager: () => ({
      async start(args) { starts.push(args); },
      async stop(sessionId) {
        stops.push(sessionId);
        await stopGate.promise;
      },
      sendAudio() {},
      async restartChannels() {},
      noteInputSignal() {},
      close() {},
    }),
  });
  const producer = await openSocket(url);
  try {
    const firstStarted = waitForMessage(producer, (message) => (
      message.type === "subtitle:started" && message.sessionId === "handoff-old"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "hybrid",
      sessionId: "handoff-old",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "handoff-call" },
    }));
    await firstStarted;

    const messages = [];
    producer.on("message", (raw) => messages.push(JSON.parse(raw.toString("utf8"))));
    const stopped = waitForMessage(producer, (message) => (
      message.type === "subtitle:stopped" && message.sessionId === "handoff-old"
    ));
    producer.send(JSON.stringify({ type: "subtitle:stop", sessionId: "handoff-old" }));
    await wait();
    assert.equal(messages.some((message) => message.type === "subtitle:stopped"), false);
    assert.deepEqual(stops, ["handoff-old"]);

    stopGate.resolve();
    await stopped;
    const nextStarted = waitForMessage(producer, (message) => (
      message.type === "subtitle:started" && message.sessionId === "handoff-new"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:start",
      sessionId: "handoff-new",
      settings: {},
    }));
    await nextStarted;
    assert.deepEqual(starts.map((entry) => entry.sessionId), ["handoff-old", "handoff-new"]);
  } finally {
    stopGate.resolve();
    producer.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("configured Live Call producer capability protects hybrid control and participant ingress", async () => {
  const harness = createSubtitleManagerHarness();
  const producerCapability = "test-live-call-producer-capability-32";
  const { httpServer, url, applyLiveCallFloorSnapshot } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    liveCallProducerCapability: producerCapability,
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleRealtimeManager: (options) => harness.factory(options),
  });
  const producer = await openSocket(url);
  try {
    const preflightDenied = waitForMessage(producer, (message) => (
      message.type === "subtitle:preflight-failed" && message.requestId === "capability-preflight-denied"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:preflight",
      requestId: "capability-preflight-denied",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "capability-call" },
    }));
    await preflightDenied;
    const preflightReady = waitForMessage(producer, (message) => (
      message.type === "subtitle:preflight-ready" && message.requestId === "capability-preflight-ready"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:preflight",
      requestId: "capability-preflight-ready",
      producerCapability,
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "capability-call" },
    }));
    await preflightReady;

    const denied = waitForMessage(producer, (message) => (
      message.type === "subtitle:error" && message.code === "SUBTITLE_START_FAILED"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "hybrid",
      sessionId: "capability-live",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "capability-call" },
    }));
    await denied;
    assert.equal(harness.starts.length, 0);

    const started = waitForMessage(producer, (message) => (
      message.type === "subtitle:started" && message.sessionId === "capability-live"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "hybrid",
      producerCapability,
      sessionId: "capability-live",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "capability-call" },
    }));
    await started;

    applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "capability-call",
      floorRevision: 1,
      holder: { participantId: "participant-capability" },
    });
    const floorDenied = waitForMessage(producer, (message) => (
      message.type === "subtitle:error" && message.code === "LIVE_CALL_PRODUCER_CAPABILITY_INVALID"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      producerCapability: `${producerCapability}-wrong`,
      sessionId: "capability-live",
      liveSessionId: "capability-call",
      floorRevision: 1,
      holder: { participantId: "participant-capability" },
    }));
    await floorDenied;

    const ingressDenied = waitForMessage(producer, (message) => (
      message.type === "subtitle:error" && message.code === "LIVE_CALL_PRODUCER_CAPABILITY_INVALID"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      producerCapability: "wrong-equal-length-capability-value",
      sessionId: "capability-call",
      partial: false,
      targetLanguage: "ko",
      translatedText: "보이면 안 되는 참가자 자막",
    }));
    await ingressDenied;

    const accepted = waitForMessage(producer, (message) => (
      message.type === "subtitle:committed" && message.translatedText === "검증된 참가자 자막"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      producerCapability,
      sessionId: "capability-call",
      partial: false,
      targetLanguage: "ko",
      speaker: "Participant",
      speakerRole: "participant",
      translatedText: "검증된 참가자 자막",
    }));
    await accepted;
  } finally {
    producer.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("renderer floor claims stay validated without gating the local provider", async () => {
  const harness = createSubtitleManagerHarness();
  const { httpServer, url, applyLiveCallFloorSnapshot } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleRealtimeManager: (options) => harness.factory(options),
  });
  const producer = await openSocket(url);
  try {
    const started = waitForMessage(
      producer,
      (message) => message.type === "subtitle:started" && message.captionProducer === "hybrid",
    );
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "hybrid",
      sessionId: "live-floor-fence",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "call-floor-fence" },
    }));
    await started;
    applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "call-floor-fence",
      floorRevision: 5,
      holder: { participantId: "viewer-5" },
    });
    const participantAck = waitForMessage(producer, (message) => (
      message.type === "subtitle:live-call-floor-applied" && message.floorRevision === 5
    ));
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-floor-fence",
      liveSessionId: "call-floor-fence",
      floorRevision: 5,
      holder: { participantId: "viewer-5" },
    }));
    await participantAck;

    assert.deepEqual(applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "different-call",
      floorRevision: 6,
      holder: null,
    }), {
      ok: false,
      mode: "participant",
      liveSessionId: "call-floor-fence",
      floorRevision: 5,
      holder: { participantId: "viewer-5" },
    }, "an in-process stale session cannot replace the active authoritative floor");

    const forgedHostError = waitForMessage(
      producer,
      (message) => message.code === "LIVE_CALL_FLOOR_AUTHORITY_MISMATCH",
    );
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-floor-fence",
      liveSessionId: "call-floor-fence",
      floorRevision: 500,
      holder: null,
    }));
    await forgedHostError;

    producer.send(JSON.stringify({
      type: "subtitle:audio",
      sessionId: "live-floor-fence",
      source: "mic",
      audio: Buffer.alloc(4_800, 4).toString("base64"),
    }));
    harness.emit({
      type: "subtitle:committed",
      source: "mic",
      targetLanguage: "ko",
      translatedText: "위조된 host floor 뒤 로컬 자막",
    });
    await wait();
    assert.equal(harness.audio.length, 1, "local PCM continues independently of a forged floor claim");

    const malformedError = waitForMessage(producer, (message) => message.code === "LIVE_CALL_FLOOR_INVALID");
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-floor-fence",
      liveSessionId: "call-floor-fence",
      floorRevision: 501,
      holder: {},
    }));
    await malformedError;

    const observed = [];
    producer.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    harness.emit({
      type: "subtitle:committed",
      source: "mic",
      targetLanguage: "ko",
      translatedText: "열리면 안 되는 로컬 자막",
    });
    await wait();
    assert.equal(observed.some((message) => message.translatedText === "열리면 안 되는 로컬 자막"), true);

    applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "call-floor-fence",
      floorRevision: 7,
      holder: null,
    });
    const hugeRevisionError = waitForMessage(producer, (message) => (
      message.code === "LIVE_CALL_FLOOR_AUTHORITY_MISMATCH"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-floor-fence",
      liveSessionId: "call-floor-fence",
      floorRevision: Number.MAX_SAFE_INTEGER,
      holder: null,
    }));
    await hugeRevisionError;
    const hostAck = waitForMessage(producer, (message) => (
      message.type === "subtitle:live-call-floor-applied" && message.floorRevision === 7
    ));
    producer.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-floor-fence",
      liveSessionId: "call-floor-fence",
      floorRevision: 7,
      holder: null,
    }));
    assert.equal((await hostAck).mode, "host");
    producer.send(JSON.stringify({
      type: "subtitle:audio",
      sessionId: "live-floor-fence",
      source: "mic",
      audio: Buffer.alloc(4_800, 5).toString("base64"),
    }));
    await wait();
    assert.equal(harness.audio.length, 2, "valid floor acknowledgement leaves the existing local provider running");
  } finally {
    producer.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("a failed local half of Live Call compensates both provider and gateway relay ownership", async () => {
  const harness = createSubtitleManagerHarness({ failStart: true });
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleRealtimeManager: (options) => harness.factory(options),
  });
  const sockets = [];
  try {
    const producer = await openSocket(url);
    sockets.push(producer);
    const gatewayStarted = waitForMessage(producer, (message) => (
      message.type === "subtitle:started" && message.captionProducer === "gateway"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "live-start-fails",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "call-start-fails" },
    }));
    await gatewayStarted;

    const failed = waitForMessage(producer, (message) => message.code === "SUBTITLE_START_FAILED");
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "local",
      sessionId: "live-start-fails",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "call-start-fails" },
    }));
    await failed;
    assert.deepEqual(harness.stops, ["live-start-fails"], "a partial local open is explicitly compensated");

    const rejected = waitForMessage(producer, (message) => message.code === "LIVE_CALL_CAPTION_PRODUCER_MISMATCH");
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-start-fails",
      partial: false,
      targetLanguage: "ko",
      translatedText: "orphan relay",
    }));
    await rejected;

    const replacement = await openSocket(url);
    sockets.push(replacement);
    const replacementStarted = waitForMessage(replacement, (message) => (
      message.type === "subtitle:started" && message.captionProducer === "gateway"
    ));
    replacement.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "replacement",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "call-start-fails" },
    }));
    await replacementStarted;
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("closing a hybrid Live Call owner releases both the local provider and relay for recovery", async () => {
  const harness = createSubtitleManagerHarness();
  const { httpServer, url, applyLiveCallFloorSnapshot } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleRealtimeManager: (options) => harness.factory(options),
  });
  const sockets = [];
  try {
    applyLiveCallFloorSnapshot({
      type: "floor",
      sessionId: "call-recover",
      floorRevision: 1,
      holder: { participantId: "viewer-recover" },
    });
    const first = await openSocket(url);
    sockets.push(first);
    const started = waitForMessage(first, (message) => (
      message.type === "subtitle:started" && message.captionProducer === "hybrid"
    ));
    first.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "hybrid",
      sessionId: "live-recover",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "call-recover" },
    }));
    await started;
    first.close();
    for (let attempt = 0; attempt < 20 && harness.stops.length === 0; attempt += 1) await wait(10);
    assert.deepEqual(harness.stops, ["live-recover"]);

    const replacement = await openSocket(url);
    sockets.push(replacement);
    const replacementStarted = waitForMessage(replacement, (message) => (
      message.type === "subtitle:started" && message.captionProducer === "hybrid"
    ));
    replacement.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "hybrid",
      sessionId: "live-recover",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "call-recover" },
    }));
    await replacementStarted;
    const recoveredFloor = waitForMessage(replacement, (message) => (
      message.type === "subtitle:live-call-floor-applied" && message.floorRevision === 1
    ));
    replacement.send(JSON.stringify({
      type: "subtitle:live-call-floor",
      sessionId: "live-recover",
      liveSessionId: "call-recover",
      floorRevision: 1,
      holder: { participantId: "viewer-recover" },
    }));
    assert.equal((await recoveredFloor).mode, "participant",
      "Main authority must survive renderer socket replacement");
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("keyed Live Call source staging evicts the oldest entry at its explicit memory cap", async () => {
  const transcriptsDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-source-cap-"));
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    log: { warn() {} },
    transcriptsDir,
    transcriptPersistDelayMs: 1_000,
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
  });
  const producer = await openSocket(url);
  try {
    const started = waitForMessage(producer, (message) => (
      message.type === "subtitle:started" && message.captionProducer === "gateway"
    ));
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "bounded-keyed-sources",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "call-bounded-sources" },
    }));
    await started;

    for (let index = 0; index <= 500; index += 1) {
      producer.send(JSON.stringify({
        type: "subtitle:live-call-caption",
        sessionId: "call-bounded-sources",
        recordOnly: true,
        partial: false,
        targetLanguage: "ko",
        utteranceKey: `source-${index}`,
        translatedText: `원문 ${index}`,
      }));
    }

    let detail = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(new URL("/api/subtitles/sessions/bounded-keyed-sources", url));
      const body = await response.json();
      if (body.ok && body.data?.lines?.length >= 1) {
        detail = body.data;
        break;
      }
      await wait(10);
    }
    assert.ok(detail, "the oldest keyed source was not evicted into the transcript");
    assert.equal(detail.lines[0].sourceText, "원문 0");
    assert.equal(detail.lines.length, 1, "only the oldest overflow is evicted before session stop");
    const stopped = waitForMessage(producer, (message) => message.type === "subtitle:sessions");
    producer.send(JSON.stringify({ type: "subtitle:stop", sessionId: "bounded-keyed-sources" }));
    await stopped;
  } finally {
    producer.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
    await fs.rm(transcriptsDir, { recursive: true, force: true });
  }
});

test("participant Live Call captions normalize and bound display and record text", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
  });
  const producer = await openSocket(url);
  try {
    const started = waitForMessage(producer, (message) => message.type === "subtitle:started");
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "bounded-live-caption",
      settings: {},
      meeting: { kind: "live-call", liveSessionId: "call-bounded-live-caption" },
    }));
    await started;

    const committedPromise = waitForMessage(
      producer,
      (message) => message.type === "subtitle:committed" && message.liveSessionId === "call-bounded-live-caption",
    );
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-bounded-live-caption",
      partial: false,
      targetLanguage: "ko",
      sourceLanguage: "en",
      speaker: "Participant",
      speakerRole: "participant",
      translatedText: ` e\u0301\u0000   ${"번".repeat(2_100)}`,
      sourceText: ` source\u0007   ${"x".repeat(2_100)}`,
    }));
    const committed = await committedPromise;
    assert.equal(committed.translatedText.length, 2_000);
    assert.equal(committed.sourceText.length, 2_000);
    assert.match(committed.translatedText, /^é /u);
    assert.equal(/[\u0000-\u001f\u007f]/u.test(committed.translatedText), false);
    assert.equal(/[\u0000-\u001f\u007f]/u.test(committed.sourceText), false);
  } finally {
    producer.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("an accepted gateway-caption stop broadcasts idle and removes the late-join subtitle snapshot", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });
  const sockets = [];
  try {
    const producer = await openSocket(url);
    sockets.push(producer);

    const started = waitForMessage(producer, (message) => message.type === "subtitle:started");
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "live-stop-clear",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "call-stop-clear" },
    }));
    await started;

    const committed = waitForMessage(producer, (message) => message.type === "subtitle:committed");
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-stop-clear",
      partial: false,
      targetLanguage: "ko",
      sourceLanguage: "en",
      speaker: "Host",
      speakerRole: "host",
      translatedText: "종료 전에 보이는 마지막 자막",
    }));
    await committed;

    const idle = waitForMessage(
      producer,
      (message) => message.type === "subtitle:status" && message.status === "idle",
    );
    producer.send(JSON.stringify({ type: "subtitle:stop", sessionId: "live-stop-clear" }));
    await idle;

    const lateViewer = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
      headers: { Origin: url },
    });
    sockets.push(lateViewer);
    const snapshotPromise = waitForMessage(lateViewer, (message) => message.type === "subtitle:snapshot");
    await new Promise((resolve, reject) => {
      lateViewer.once("open", resolve);
      lateViewer.once("error", reject);
    });
    const snapshot = await snapshotPromise;
    assert.deepEqual(snapshot.lanes, []);
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("live-call captions clear after the caption-only silence window", async () => {
  // Parity with captions-only: the local engine broadcasts subtitle:clear
  // after SILENCE_CLEAR_MS of no new content, but the gateway emits no such
  // event — so the relay must synthesize it, or live-call captions linger on
  // the overlay 5x longer than caption-only ones.
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    liveCallSilenceClearMilliseconds: 150,
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });
  const sockets = [];
  try {
    const producer = await openSocket(url);
    sockets.push(producer);

    const started = waitForMessage(producer, (message) => message.type === "subtitle:started");
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "live-silence-clear",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "call-silence-clear" },
    }));
    await started;

    const committed = waitForMessage(producer, (message) => message.type === "subtitle:committed");
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-silence-clear",
      partial: false,
      targetLanguage: "ko",
      sourceLanguage: "en",
      speaker: "Host",
      speakerRole: "host",
      translatedText: "침묵 후 사라져야 하는 자막",
    }));
    await committed;

    // No further captions arrive: the relay must end the subtitle exactly the
    // way the captions-only engine does.
    const cleared = await waitForMessage(
      producer,
      (message) => message.type === "subtitle:clear" && message.source === "live-call",
      1_500,
    );
    assert.equal(cleared.targetLanguage, "ko");
    assert.equal(cleared.reason, "silence");
    assert.equal(cleared.liveSessionId, "call-silence-clear");

    // A late viewer must not resurrect the cleared lane from the snapshot.
    const lateViewer = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
      headers: { Origin: url },
    });
    sockets.push(lateViewer);
    const snapshotPromise = waitForMessage(lateViewer, (message) => message.type === "subtitle:snapshot");
    await new Promise((resolve, reject) => {
      lateViewer.once("open", resolve);
      lateViewer.once("error", reject);
    });
    const snapshot = await snapshotPromise;
    assert.deepEqual(snapshot.lanes, []);
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("live-call sentence retention matches captions-only", async () => {
  // Two halves of the same behavior:
  //  1. A completed sentence lingers while the next grows, then rolls off
  //     after SUBTITLE_PREVIOUS_SENTENCE_LINGER_MS — the overlay must arm that
  //     trim for Live Call too, not only for captions-only.
  //  2. After the speaker stops, the last sentence stays readable for that
  //     same linger on top of the 3s silence threshold.
  const [overlay, server] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "public/subtitle-overlay.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "src/server.js"), "utf8"),
  ]);

  const commitStart = overlay.indexOf("function renderCommittedSubtitle");
  const commitEnd = overlay.indexOf("function renderPredictedSubtitle", commitStart);
  assert.ok(commitStart >= 0 && commitEnd > commitStart);
  const commit = overlay.slice(commitStart, commitEnd);
  assert.match(commit, /armPreviousSentenceTrim\(lane, finalParts\.length\)/u);
  assert.doesNotMatch(commit, /if \(lane\.isLiveCall\) \{[\s\S]*?lane\.trimTimer = null;/u,
    "Live Call must not opt out of the previous-sentence linger");

  // The silence window carries the reading time, not just the silence
  // threshold: a bare 3s cleared the last sentence the instant speech stopped.
  assert.match(server, /liveCallSilenceClearMilliseconds[\s\S]{0,200}:\s*6_000/u);
});

test("only out-of-order live-call finals are records-only; in-order finals keep building the display", async () => {
  // Caption-only parity. The overlay's rolling 2-3 line stream is built from
  // COMMITTED lines plus the live partial tail, so in-order finals must keep
  // displaying — suppressing all of them leaves a single partial that gets
  // replaced wholesale and never accumulates. What breaks live-call is order:
  // the gateway's polish pass delays a final past newer partials, and painting
  // that rewinds the lane to an older sentence.
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    liveCallSilenceClearMilliseconds: 60_000,
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });
  const sockets = [];
  try {
    const producer = await openSocket(url);
    sockets.push(producer);

    const started = waitForMessage(producer, (message) => message.type === "subtitle:started");
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "live-stale-final",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "call-stale-final" },
    }));
    await started;

    const sendCaption = (payload) => producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-stale-final",
      targetLanguage: "en",
      sourceLanguage: "ko",
      speaker: "Host",
      speakerRole: "host",
      ...payload,
    }));

    // Sentence 7 partial paints the lane, then the speaker moves on and
    // sentence 8's partial paints newer content.
    const partialSeen = waitForMessage(producer, (message) => message.type === "subtitle:partial"
      && message.translatedText === "newer partial content");
    sendCaption({ partial: true, sourceSeq: 7, translatedText: "older partial content" });
    sendCaption({ partial: true, sourceSeq: 8, translatedText: "newer partial content" });
    await partialSeen;

    // Sentence 7's polished final arrives late, after sentence 8 painted: it
    // must reach history but never rewind the display.
    const staleHistorySeen = waitForMessage(producer, (message) => message.type === "subtitle:history"
      && JSON.stringify(message).includes("from the start fragment"));
    let staleCommittedSeen = false;
    const committedListener = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (message.type === "subtitle:committed" && message.translatedText === "from the start fragment") {
        staleCommittedSeen = true;
      }
    };
    producer.on("message", committedListener);
    sendCaption({ partial: false, sourceSeq: 7, translatedText: "from the start fragment", sourceText: "원문 7" });
    await staleHistorySeen;

    // The in-order final for the sentence currently on screen DOES display —
    // it is what the overlay's accumulated committed text is made of.
    const currentCommitted = waitForMessage(producer, (message) => message.type === "subtitle:committed"
      && message.translatedText === "current sentence final");
    sendCaption({ partial: false, sourceSeq: 8, translatedText: "current sentence final", sourceText: "원문 8" });
    await currentCommitted;

    // A final for a sentence that never painted (short utterance committing
    // without a partial) also displays.
    const unseenCommitted = waitForMessage(producer, (message) => message.type === "subtitle:committed"
      && message.translatedText === "never painted sentence");
    sendCaption({ partial: false, sourceSeq: 9, translatedText: "never painted sentence", sourceText: "원문 9" });
    await unseenCommitted;
    producer.off("message", committedListener);
    assert.equal(staleCommittedSeen, false,
      "an out-of-order final must not rewind the display to an older sentence");
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("desktop terminal paths clear caption text and speaker state without treating reconnect as an end", async () => {
  const [dashboard, overlay, main] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "public/subtitle-dashboard.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "public/subtitle-overlay.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "electron/main.js"), "utf8"),
  ]);

  assert.match(dashboard, /function clearActiveSubtitleSurface\(\)/u);
  assert.match(dashboard, /message\.status === "idle"[\s\S]{0,220}clearActiveSubtitleSurface\(\)/u);
  assert.match(dashboard, /async function stopSubtitles\(\)[\s\S]{0,260}clearActiveSubtitleSurface\(\)/u);
  assert.match(dashboard, /floor\?\.type === "live-call-ended"[\s\S]{0,260}clearActiveSubtitleSurface\(\)/u);

  const reconnectStart = dashboard.indexOf("async function reconnectLiveCallTranslation()");
  const reconnectEnd = dashboard.indexOf("function stopLocalStreams()", reconnectStart);
  assert.ok(reconnectStart >= 0 && reconnectEnd > reconnectStart);
  assert.doesNotMatch(dashboard.slice(reconnectStart, reconnectEnd), /clearActiveSubtitleSurface\(\)/u);

  assert.match(overlay, /floor\?\.type === "live-call-ended"[\s\S]{0,360}clearSubtitle\(\)/u);
  assert.match(main, /currentStatus === "stopped"[\s\S]{0,460}type: "live-call-ended"[\s\S]{0,120}sessionId: armedSession\.sessionId/u);
  assert.match(main, /liveCallSession = null;[\s\S]{0,260}type: "live-call-ended"[\s\S]{0,120}sessionId: endingSession\.sessionId/u);
});


test("desktop logout gate refuses preflight and start without opening a subtitle provider", async () => {
  const harness = createSubtitleManagerHarness();
  const server = await startServer({
    host: "127.0.0.1", port: 0, env: {}, canStartSubtitleSession: () => false,
    createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
    createSubtitleRealtimeManager: (options) => harness.factory(options),
  });
  const socket = await openSocket(server.url);
  try {
    for (const [type, reply] of [["subtitle:preflight", "subtitle:preflight-failed"], ["subtitle:start", "subtitle:error"]]) {
      const response = waitForMessage(socket, (message) => message.type === reply);
      socket.send(JSON.stringify({ type, requestId: "logged-out", sessionId: "blocked", settings: {} }));
      assert.equal((await response).message, "HOST_LOGIN_REQUIRED");
    }
    assert.equal(harness.starts.length, 0);
    assert.equal(server.hasActiveSubtitleSession(), false);
  } finally {
    socket.close();
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
});

test("rejecting a start while logout checks an active producer does not clear its current session", async () => {
  let canStart = true;
  const startBarrier = deferred();
  const entered = deferred();
  const harness = createSubtitleManagerHarness();
  const server = await startServer({
    host: "127.0.0.1", port: 0, env: {}, canStartSubtitleSession: () => canStart,
    createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
    createSubtitleRealtimeManager: (options) => ({ ...harness.factory(options), start: async () => { entered.resolve(); await startBarrier.promise; } }),
  });
  const socket = await openSocket(server.url);
  try {
    const started = waitForMessage(socket, (message) => message.type === "subtitle:started");
    socket.send(JSON.stringify({ type: "subtitle:start", sessionId: "existing", settings: {} }));
    await entered.promise;
    assert.equal(server.hasActiveSubtitleSession(), true, "pending provider start blocks logout");
    startBarrier.resolve();
    await started;
    canStart = false;
    const denied = waitForMessage(socket, (message) => message.type === "subtitle:error");
    socket.send(JSON.stringify({ type: "subtitle:start", sessionId: "existing", settings: {} }));
    assert.equal((await denied).message, "HOST_LOGIN_REQUIRED");
    assert.equal(server.hasActiveSubtitleSession(), true);
    assert.equal(harness.stops.length, 0);
    const stopped = waitForMessage(socket, (message) => message.type === "subtitle:stopped");
    socket.send(JSON.stringify({ type: "subtitle:stop", sessionId: "existing" }));
    await stopped;
    assert.equal(server.hasActiveSubtitleSession(), false);
  } finally {
    startBarrier.resolve();
    socket.close();
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
});
