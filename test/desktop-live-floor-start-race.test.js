import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createCaptionPcmResampler } from "../src/caption-pcm-resampler.js";
import { encodeLiveAudioWireFrame } from "../src/live-audio-wire.js";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
import { DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection } from "../packages/caption-core/caption-engine-catalog.js";

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
function section(start, end) {
  const from = main.indexOf(start), to = main.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return main.slice(from, to);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function harness() {
  const sockets = [], floors = [], authority = [], audioHandlers = [];
  /** @type {(value: {ok: boolean, data?: {id: string, status: string, version: number}}) => void} */
  let finishVerification = () => { throw new Error("verification did not start"); };
  const verification = new Promise(resolve => { finishVerification = resolve; });
  let reads = 0;
  const session = { sessionId: "synthetic-call", status: "preparing", baseUrl: "https://example.test", version: 1,
    activationVersion: 1, activationKey: "11111111-1111-4111-8111-111111111111", gatewaySettings: { languages: ["en", "ko"] } };
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    constructor() { super(); sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.emit("close"); }
  }
  const dashboard = { getURL: () => "http://localhost:3210/subtitle.html", send() {}, isDestroyed: () => false };
  const context = vm.createContext({
    liveCallSession: session, liveGatewayBridge: null, liveDemandController: null, isQuitting: false,
    fetchGatewayConnection: async () => ({ ok: true, gatewayUrl: "wss://example.test/live", token: ["synthetic", "token"].join("-") }),
    remainingLiveGatewayStartBudget: () => 1000,
    liveCallApi: async () => ++reads === 1 ? { ok: true, data: { id: session.sessionId, status: "preparing", version: 1 } } : verification,
    warmLiveGatewayBeforeSocket: async () => {}, trustedGatewayHeaders: () => ({}),
    WebSocket: Socket, createLiveCaptionIpcRelay: () => ({ close() {}, push() {} }),
    scheduleLiveGatewayReconnect() {}, clearLiveBridgeAlert() {}, scheduleLiveGatewayCredentialRefresh() {},
    liveBridgeAudioAdapters: new Map(), clearLiveBridgeCredentialRefresh() {}, clearLiveBridgeReconnect() {},
    setLiveBridgeAlert() {}, liveBridgeReconnectAttempts: 0,
    LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS: 1000, CAPTION_BRIDGE_PACKET_BYTES: 4800, LIVE_BRIDGE_FRAME_BYTES: 1280, LIVE_BRIDGE_SOCKET_BUFFER_LIMIT: 1_000_000,
    Buffer, ArrayBuffer, setTimeout, clearTimeout, console: { warn() {}, info() {} },
    server: { applyLiveCallFloorSnapshot: snapshot => {
      authority.push(snapshot);
      return snapshot ? { ok: true, liveSessionId: snapshot.sessionId, floorRevision: snapshot.floorRevision,
        mode: snapshot.holder === null ? "host" : "participant", holder: snapshot.holder } : { ok: false, mode: "blocked" };
    } },
    relayLiveCallFloorToRenderers: snapshot => floors.push(snapshot),
    dashboardWindow: { isDestroyed: () => false, webContents: dashboard, hide() {} }, stageWindow: null,
    isAllowedOrigin: () => true, localAppOrigin: "http://localhost:3210",
    createCaptionPcmResampler, encodeLiveAudioWireFrame,
    createGeminiCaptionConfig, geminiCaptionConfigFingerprint, DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection,
    ipcMain: { on: (_name, callback) => audioHandlers.push(callback) },
  });
  vm.runInContext(`${section("function readLiveCallModelPreferences", "function sanitizeLiveCallDraft")}\n${section("function sanitizeLiveCallFloorSnapshot", "function liveBridgeStatus")}\n${section("function shouldBlockLiveHostAudioForFloor", "function relayLiveCallFloorToRenderers")}\n${section("function adaptCaptionPcmForGateway", "async function ensureLiveGatewayBridgeOnce")}\n${section("async function ensureLiveGatewayBridgeOnce", "async function ensureLiveGatewayBridgeForStatus")}\n${section('  ipcMain.on("live-call:audio-frame"', '  ipcMain.handle("live-call:end"')}\nglobalThis.ensure = ensureLiveGatewayBridgeOnce;`, context);
  const ready = context.ensure({ allowPreparing: true });
  await tick();
  const socket = sockets[0];
  const message = value => socket.emit("message", Buffer.from(JSON.stringify(value)));
  const floor = (revision = 0, holder = null, sessionId = session.sessionId) => message({ type: "floor", sessionId, floorRevision: revision, holder });
  const start = () => {
    message({ type: "authenticated" });
    message({ type: "started", sessionId: session.sessionId, version: 2 });
  };
  const verify = (status = "live") => finishVerification({ ok: true, data: { id: session.sessionId, status, version: 2 } });
  const sendAudio = (sessionId = session.sessionId) => audioHandlers[0]({ sender: dashboard }, { sessionId, source: "mic", sampleRate: 24000, frameDurationMs: 100, pcm: Buffer.alloc(4800, 1) });
  return { context, ready, socket, session, message, floor, start, verify, floors, authority, sendAudio,
    forwarded: () => socket.sent.filter(Buffer.isBuffer).length };
}

test("started then floor before the authoritative GET resolves eventually enables actual host PCM", async () => {
  const h = await harness();
  h.start(); h.floor(); h.sendAudio();
  assert.equal(h.context.liveGatewayBridge.ready, false);
  assert.equal(h.forwarded(), 0);
  assert.equal(h.authority.length, 0, "pending verification cannot grant local audio authority");
  h.verify(); assert.equal((await h.ready).ok, true); await tick();
  assert.equal(h.context.liveGatewayBridge.floorKnown, true);
  assert.equal(h.context.liveGatewayBridge.isHostAudioBlocked, false);
  h.sendAudio(); assert.ok(h.forwarded() > 0);
  assert.equal(h.floors.length, 1);
  h.socket.close();
});

test("only the newest pending floor revision applies and a participant holder keeps host PCM blocked", async () => {
  const h = await harness(); h.start();
  h.floor(1); h.floor(3, { participantId: "synthetic-viewer" }); h.floor(2);
  h.verify(); await h.ready; await tick();
  assert.equal(h.context.liveGatewayBridge.floorRevision, 3);
  assert.equal(h.context.liveGatewayBridge.isHostAudioBlocked, true);
  h.sendAudio(); assert.equal(h.forwarded(), 0);
  assert.equal(h.floors.length, 1);
  h.socket.close();
});

test("pre-start, wrong-session and malformed floors cannot be buffered as host authorization", async () => {
  const h = await harness(); h.floor(99); h.start(); h.floor(2, null, "other-call");
  h.message({ type: "floor", sessionId: h.session.sessionId, floorRevision: 4 });
  h.verify(); await h.ready; await tick();
  assert.equal(h.context.liveGatewayBridge.floorKnown, false);
  h.sendAudio(); assert.equal(h.forwarded(), 0);
  assert.equal(h.authority.length, 0);
  h.socket.close();
});

test("failed verification discards the pending floor without granting audio authority", async () => {
  const h = await harness(); h.start(); h.floor(); h.verify("preparing");
  assert.equal((await h.ready).ok, false); await tick();
  assert.equal(h.authority.length, 0);
  h.sendAudio(); assert.equal(h.forwarded(), 0);
});

test("a closed or replaced bridge cannot apply its pending floor after a late verification", async () => {
  const h = await harness(); h.start(); h.floor(); h.socket.close();
  h.context.liveGatewayBridge = { ready: false, floorKnown: false, isHostAudioBlocked: true };
  h.verify(); assert.equal((await h.ready).ok, false); await tick();
  assert.equal(h.authority.length, 0);
  assert.equal(h.context.liveGatewayBridge.floorKnown, false);
});


test("non-demand host PCM is bound to the current session and exact bridge ownership", async () => {
  const h = await harness(); h.start(); h.floor(); h.verify(); await h.ready; await tick();
  h.sendAudio("old-synthetic-call"); assert.equal(h.forwarded(), 0);
  h.sendAudio(); assert.ok(h.forwarded() > 0);
  const forwarded = h.forwarded();
  h.context.liveCallSession = { ...h.session };
  h.sendAudio(); assert.equal(h.forwarded(), forwarded);
  h.socket.close();
});
