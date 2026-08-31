import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { AUDIO_CONFIG } from "../src/config.js";
import { createGatewayServer } from "../src/gateway-server.js";
import { LiveMediaPipeline } from "../src/live-media-pipeline.js";
import { resolvePipelineInitialSequences } from "../src/server.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const GRANT_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER_ID = "33333333-3333-4333-8333-333333333333";

function signToken(secret, claims) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function hostToken(secret, sessionId = SESSION_ID) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return signToken(secret, {
    role: "HOST", sub: "host-1", sessionId, aud: "media-gateway",
    iat: nowSeconds, exp: nowSeconds + 900,
  });
}

function viewerToken(secret) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return signToken(secret, {
    role: "VIEWER",
    sub: VIEWER_ID,
    grantId: GRANT_ID,
    sessionId: SESSION_ID,
    aud: "live-gateway-viewer",
    jti: "44444444-4444-4444-8444-444444444444",
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

function nextJson(webSocket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { webSocket.off("message", onMessage); webSocket.off("close", onClose); };
    const onClose = () => { cleanup(); reject(new Error("SOCKET_CLOSED_BEFORE_EXPECTED_MESSAGE")); };
    const onMessage = (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    webSocket.on("message", onMessage);
    webSocket.once("close", onClose);
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("CONDITION_TIMEOUT");
}

function pipelineDependencies() {
  return {
    dependencies: {
      speechToText: {
        async open() {
          return { async sendAudio() {}, async close() {}, async getFinalWords() { return []; } };
        },
      },
      textTranslate: {
        async translate({ language }) {
          return language === "ko" ? "저장 실패 자막" : "A caption that cannot persist";
        },
      },
      publisher: {
        async persistAuthoritativeSource() {
          return {
            sourceUtteranceId: "00000000-0000-4000-8000-000000000001",
            sourceSeq: 1,
            idempotent: false,
          };
        },
        async publish(_sessionId, _language, event) {
          if (event.type === "caption") throw new Error("DURABLE_CAPTION_PERSIST_FAILED");
        },
        async markLive() {},
      },
    },
  };
}

test("a pipeline reports concurrent durable caption failures exactly once", async () => {
  const state = pipelineDependencies();
  const fatalErrors = [];
  const pipeline = new LiveMediaPipeline({
    sessionId: "fatal-once",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko", "en"],
    dependencies: state.dependencies,
    onFatalError: (error) => fatalErrors.push(error),
  });
  await pipeline.start();

  await pipeline.acceptFinalUtterance({
    speakerLabel: "1",
    text: "저장 실패 자막",
    sourceLanguage: "ko",
    sourceEndedAt: "2026-08-27T00:00:00.000Z",
  });

  assert.equal(fatalErrors.length, 1);
  assert.equal(fatalErrors[0].message, "DURABLE_CAPTION_PERSIST_FAILED");
  await pipeline.close();
});

async function createFailureHarness(context, { rejectRestart = false, rejectClose = false, failInitialStart = false } = {}) {
  const pipelines = [];
  let allowRestart = !rejectRestart;
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret",
    hostAuthorizer: { async authorize(_claims, settings) { return settings.type !== "restart" || allowRestart; } },
    viewerAuthorizer: { async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    async pipelineFactory(settings, previous, _onHostEvent, options) {
      const pipeline = {
        settings, previous, options, frames: [], closed: 0, paused: 0,
        async start() { if (failInitialStart && pipelines[0] === this) throw new Error("PROVIDER_START_FAILED"); }, async tick() {}, async endAudioStream() {},
        async acceptAudio(frame) { this.frames.push(frame[0]); },
        async pause() { this.paused += 1; },
        async close() { this.closed += 1; if (rejectClose) throw new Error("PROVIDER_CLOSE_FAILED"); },
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(() => gateway.close());
  const port = gateway.server.address().port;
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live`);
    context.after(() => socket.terminate());
    await once(socket, "open");
    const received = nextJson(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: hostToken("gateway-secret") }));
    assert.equal((await received).type, "authenticated");
    return socket;
  }
  async function command(socket, type = "start") {
    const received = nextJson(socket, (message) => message.type === "error" || message.type === (type === "restart" ? "restarted" : type === "update" ? "updated" : "started"));
    socket.send(JSON.stringify({ type, sessionId: SESSION_ID, version: 1,
      sessionType: "meeting", outputMode: "captions", languages: ["ko", "en"] }));
    return received;
  }
  const host = await connect();
  assert.equal((await command(host)).type, failInitialStart ? "error" : "started");
  return { gateway, pipelines, host, connect, command, allowRestart() { allowRestart = true; } };
}

for (const code of ["DURABLE_CAPTION_PERSIST_FAILED", "AUTHORITATIVE_SOURCE_PERSIST_FAILED", "TRANSLATION_LANGUAGE_DRIFT"]) {
  test(`${code} closes the paid pipeline once and blocks automatic reconnect without a new factory`, async (context) => {
    const { pipelines, host, connect, command } = await createFailureHarness(context);
    const failure = nextJson(host, (message) => message.type === "error");
    const closed = once(host, "close");
    pipelines[0].options.onFatalError(new Error(code));
    pipelines[0].options.onFatalError(new Error(code));
    assert.equal((await failure).code, "PIPELINE_RESTART_REQUIRED");
    await closed;
    await waitFor(() => pipelines[0].closed === 1);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reconnect = await connect();
      assert.equal((await command(reconnect)).code, "PIPELINE_RESTART_REQUIRED");
      reconnect.close();
    }
    assert.equal(pipelines.length, 1, "reconnect cannot reset a paid recovery budget");
    assert.equal(pipelines[0].closed, 1);
    assert.deepEqual(pipelines[0].frames, []);
  });
}

test("ordinary detach cleanup failure also prevents a new paid pipeline", async (context) => {
  const { pipelines, host, connect, command } = await createFailureHarness(context, { rejectClose: true });
  const response = nextJson(host, (message) => message.type === "error");
  host.send(JSON.stringify({ type: "detach" }));
  assert.equal((await response).code, "PIPELINE_CLEANUP_FAILED");
  const reconnect = await connect();
  assert.equal((await command(reconnect)).code, "PIPELINE_CLEANUP_FAILED");
  assert.equal((await command(reconnect, "restart")).code, "PIPELINE_CLEANUP_FAILED");
  assert.equal(pipelines.length, 1);
});

test("a replacement closes its new candidate if the old paid provider cannot be released", async (context) => {
  const { pipelines, host, connect, command } = await createFailureHarness(context, { rejectClose: true });
  assert.equal((await command(host, "restart")).code, "PIPELINE_CLEANUP_FAILED");
  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[1].closed, 1, "a prepared replacement cannot keep running after old cleanup fails");
  const reconnect = await connect();
  assert.equal((await command(reconnect)).code, "PIPELINE_CLEANUP_FAILED");
  assert.equal(pipelines.length, 2);
});

test("resume acknowledges only after provider readiness and a failed resume requires manual restart", async (context) => {
  const { pipelines, host, connect, command } = await createFailureHarness(context);
  let resolveResume;
  let entered = false;
  const resumeGate = new Promise((resolve) => { resolveResume = resolve; });
  pipelines[0].resume = async () => { entered = true; await resumeGate; throw new Error("STT_RESUME_FAILED"); };
  const messages = [];
  host.on("message", (data) => messages.push(JSON.parse(data.toString())));
  host.send(JSON.stringify({ type: "resume" }));
  await waitFor(() => entered);
  assert.equal(messages.some((message) => message.type === "resumed"), false);
  const closed = once(host, "close");
  resolveResume();
  await closed;
  assert.equal(messages.some((message) => message.type === "resumed"), false);
  assert.equal(messages.some((message) => message.code === "PIPELINE_RESTART_REQUIRED"), true);
  const reconnect = await connect();
  assert.equal((await command(reconnect)).code, "PIPELINE_RESTART_REQUIRED");
  assert.equal(pipelines.length, 1);
});

test("initial provider startup failure cannot be retried by automatic start messages", async (context) => {
  const { pipelines, host, connect, command } = await createFailureHarness(context, { failInitialStart: true });
  assert.equal(pipelines[0].closed, 1);
  assert.equal((await command(host)).code, "PIPELINE_RESTART_REQUIRED");
  host.close();
  const reconnect = await connect();
  assert.equal((await command(reconnect)).code, "PIPELINE_RESTART_REQUIRED");
  assert.equal(pipelines.length, 1);
  assert.equal((await command(reconnect, "restart")).type, "restarted");
  assert.equal(pipelines.length, 2);
});

test("only an authorized explicit restart clears the failure tombstone and reconciles persisted sequences", async (context) => {
  const { pipelines, host, connect, command, allowRestart } = await createFailureHarness(context, { rejectRestart: true });
  const closed = once(host, "close");
  pipelines[0].options.onFatalError(new Error("DURABLE_CAPTION_PERSIST_FAILED"));
  await closed;
  await waitFor(() => pipelines[0].closed === 1);
  const reconnect = await connect();
  assert.equal((await command(reconnect, "update")).code, "PIPELINE_RESTART_REQUIRED");
  assert.equal((await command(reconnect, "restart")).code, "SESSION_REVOKED");
  assert.equal(pipelines.length, 1);
  allowRestart();
  assert.equal((await command(reconnect, "restart")).type, "restarted");
  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[1].options.recoveryReason, "durable-caption");
  assert.equal(pipelines[1].options.requireDurableSeed, true);
  assert.equal(pipelines[0].closed, 1);
});

test("failed provider cleanup keeps explicit restart blocked instead of overlapping paid resources", async (context) => {
  const { pipelines, host, connect, command } = await createFailureHarness(context, { rejectClose: true });
  const closed = once(host, "close");
  pipelines[0].options.onFatalError(new Error("DURABLE_CAPTION_PERSIST_FAILED"));
  await closed;
  await waitFor(() => pipelines[0].closed >= 1);
  const reconnect = await connect();
  assert.equal((await command(reconnect, "restart")).code, "PIPELINE_CLEANUP_FAILED");
  assert.equal(pipelines.length, 1);
});

test("durable recovery seeds only from reconciled persisted maxima", async () => {
  const message = { sessionId: SESSION_ID, languages: ["ko", "en"] };
  const previousPipeline = { lastSequences: { ko: 9, en: 10 } };
  const reconciled = [];
  const publisher = {
    async fetchLastUtteranceSeqs() { return { ko: 7, en: 3 }; },
    async reconcileCaptionLane(sessionId, language) {
      reconciled.push([sessionId, language]);
      return language === "ko" ? 7 : 3;
    },
  };

  assert.deepEqual(await resolvePipelineInitialSequences({
    publisher, message, previousPipeline, recoveryReason: "durable-caption",
  }), { ko: 7, en: 3 });
  assert.deepEqual(reconciled, [[SESSION_ID, "ko"], [SESSION_ID, "en"]]);
  assert.deepEqual(await resolvePipelineInitialSequences({
    publisher, message, previousPipeline,
  }), { ko: 9, en: 10 });
});

test("a pipeline seed resets the authoritative-source latch only after reconciliation succeeds", async () => {
  const message = { sessionId: SESSION_ID, languages: ["ko", "en"] };
  const resets = [];
  const publisher = {
    async fetchLastUtteranceSeqs() { return { ko: 7, en: 3 }; },
    async reconcileCaptionLane(_sessionId, language) { return language === "ko" ? 7 : 3; },
    resetAuthoritativeSourceLane(sessionId) { resets.push(sessionId); },
  };

  await resolvePipelineInitialSequences({
    publisher, message, recoveryReason: "durable-caption",
  });
  assert.deepEqual(resets, [SESSION_ID]);

  await resolvePipelineInitialSequences({ publisher, message });
  assert.deepEqual(resets, [SESSION_ID, SESSION_ID]);

  const failingResets = [];
  await assert.rejects(
    resolvePipelineInitialSequences({
      publisher: {
        async reconcileCaptionLane() { throw new Error("REQUEST_TIMEOUT"); },
        resetAuthoritativeSourceLane(sessionId) { failingResets.push(sessionId); },
      },
      message,
      recoveryReason: "durable-caption",
    }),
    /DURABLE_CAPTION_RECOVERY_SEED_FAILED/,
  );
  assert.deepEqual(failingResets, []);
});

test("durable recovery fails closed when persisted maxima cannot be reconciled", async () => {
  await assert.rejects(
    resolvePipelineInitialSequences({
      publisher: { async reconcileCaptionLane() { throw new Error("REQUEST_TIMEOUT"); } },
      message: { sessionId: SESSION_ID, languages: ["ko", "en"] },
      previousPipeline: { lastSequences: { ko: 9, en: 10 } },
      recoveryReason: "durable-caption",
    }),
    /DURABLE_CAPTION_RECOVERY_SEED_FAILED/,
  );
  await assert.rejects(
    resolvePipelineInitialSequences({
      publisher: { async reconcileCaptionLane(_sessionId, language) { return language === "ko" ? 4 : undefined; } },
      message: { sessionId: SESSION_ID, languages: ["ko", "en"] },
      previousPipeline: { lastSequences: { ko: 9, en: 10 } },
      recoveryReason: "durable-caption",
    }),
    /DURABLE_CAPTION_RECOVERY_SEED_INVALID/,
  );

  const abortController = new AbortController();
  const hungReconciliation = resolvePipelineInitialSequences({
    publisher: {
      async reconcileCaptionLane(_sessionId, _language, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
    message: { sessionId: SESSION_ID, languages: ["ko", "en"] },
    recoveryReason: "durable-caption",
    signal: abortController.signal,
  });
  abortController.abort(new Error("SESSION_ENDED"));
  await assert.rejects(hungReconciliation, /DURABLE_CAPTION_RECOVERY_SEED_FAILED/);
});
