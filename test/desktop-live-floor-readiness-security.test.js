import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createCaptionPcmResampler } from "../src/caption-pcm-resampler.js";
import { encodeLiveAudioWireFrame } from "../src/live-audio-wire.js";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
import { DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection } from "../packages/caption-core/caption-engine-catalog.js";

const localServer = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
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
  const authoritySource = localServer.slice(localServer.indexOf('  let authoritativeLiveCallSessionId = "";'), localServer.indexOf('  // Silence-clear parity'));
  const localAuthority = vm.runInNewContext(`let liveCallCaptionSessionId = "";
${authoritySource}
applyLiveCallFloorSnapshot`);
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
      return localAuthority(snapshot);
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
  const sendAudio = (patch = {}) => audioHandlers[0]({ sender: dashboard }, { sessionId: session.sessionId, source: "mic", sampleRate: 24000, frameDurationMs: 100, pcm: Buffer.alloc(4800, 1), ...patch });
  return { context, ready, socket, session, message, floor, start, verify, floors, authority, sendAudio,
    reads: () => reads,
    forwarded: () => socket.sent.filter(Buffer.isBuffer).length };
}

test("equal-revision conflicting pending holders cannot unmute host audio", async () => {
  const h = await harness(); h.start();
  try {
    h.floor(7, { participantId: "participant-a", name: "private-profile" });
    h.floor(7, null);
    h.verify(); await h.ready; await tick();
    h.sendAudio();
    assert.equal(h.forwarded(), 0);
    assert.equal(h.context.liveGatewayBridge.isHostAudioBlocked, true);
    assert.equal(h.floors.some(floor => floor.holder === null), false);
  } finally { h.socket.close(); }
});

test("invalid same-session pending floor cannot retain an earlier host grant", async () => {
  const h = await harness(); h.start();
  try {
    h.floor(3);
    h.message({ type: "floor", sessionId: h.session.sessionId, floorRevision: 4, holder: {} });
    h.floor(2);
    h.verify(); await h.ready; await tick(); h.sendAudio();
    assert.equal(h.forwarded(), 0);
    assert.equal(h.context.liveGatewayBridge.floorKnown, false);
  } finally { h.socket.close(); }
});

test("valid participant assignment survives cross-session noise and exposes no profile fields", async () => {
  const h = await harness(); h.start();
  try {
    h.floor(4, { participantId: "participant-a", email: "private@example.test", name: "Private" });
    h.floor(900, null, "another-call");
    h.verify(); await h.ready; await tick(); h.sendAudio();
    assert.equal(h.forwarded(), 0);
    assert.equal(h.context.liveGatewayBridge.floorRevision, 4);
    assert.deepEqual(JSON.parse(JSON.stringify(h.floors.at(-1))), { type: "floor", sessionId: h.session.sessionId, floorRevision: 4, holder: { participantId: "participant-a" } });
  } finally { h.socket.close(); }
});

test("invalid started identity cannot make a pre-ready host floor authoritative", async () => {
  const h = await harness();
  h.message({ type: "authenticated" });
  h.message({ type: "started", sessionId: "another-call", version: 2 }); h.floor(50);
  await tick();
  assert.equal((await h.ready).ok, false);
  h.sendAudio(); assert.equal(h.forwarded(), 0); assert.equal(h.authority.length, 0);
});

test("pending PCM is discarded and a participant grant during verification never flushes old audio", async () => {
  const h = await harness(); h.start();
  try {
    h.floor(1); for (let i = 0; i < 25; i++) h.sendAudio();
    h.floor(2, { participantId: "participant-a" });
    h.verify(); await h.ready; await tick();
    assert.equal(h.forwarded(), 0);
    assert.equal(h.context.liveBridgeAudioAdapters.size, 0, "unapproved PCM is never buffered for replay");
    h.floor(3); await tick();
    assert.equal(h.forwarded(), 0, "granting host authority does not replay earlier input");
    h.sendAudio(); assert.ok(h.forwarded() > 0);
  } finally { h.socket.close(); }
});

test("closing verification cannot replay pending authority into a replacement bridge", async () => {
  const h = await harness(); h.start(); h.floor(6);
  h.socket.close();
  const replacement = { ready: true, floorKnown: false, isHostAudioBlocked: true, session: h.session };
  h.context.liveGatewayBridge = replacement;
  h.verify(); await h.ready; await tick();
  assert.equal(h.context.liveGatewayBridge, replacement);
  assert.equal(replacement.floorKnown, false); assert.equal(replacement.isHostAudioBlocked, true);
  assert.equal(h.authority.length, 0); assert.equal(h.floors.length, 0);
});

test("a legacy bridge cannot forward stale PCM from another meeting", async () => {
  const h = await harness(); h.start(); h.floor(1); h.verify(); await h.ready; await tick();
  try {
    for (const sessionId of ["previous-meeting", "", null, undefined]) h.sendAudio({ sessionId });
    assert.equal(h.forwarded(), 0, "an old renderer IPC packet cannot use the new meeting's host floor");
    h.sendAudio(); assert.ok(h.forwarded() > 0);
  } finally { h.socket.close(); }
});

test("a different in-memory meeting generation cannot reuse a ready bridge audio gate", async () => {
  const h = await harness(); h.start(); h.floor(1); h.verify(); await h.ready; await tick();
  try {
    h.context.liveCallSession = { ...h.session };
    h.sendAudio(); assert.equal(h.forwarded(), 0);
  } finally { h.socket.close(); }
});

test("duplicate started acknowledgements cannot multiply verification or pending floor state", async () => {
  const h = await harness(); h.start();
  try {
    for (let index = 0; index < 20; index++) {
      h.message({ type: "started", sessionId: h.session.sessionId, version: 2 });
      h.floor(index, { participantId: "participant-a", email: "private@example.test" });
    }
    assert.equal(h.reads(), 2, "one initial read and one authoritative verification only");
    assert.doesNotMatch(JSON.stringify(h.context.liveGatewayBridge.pendingFloor), /private|email/u);
    h.verify(); await h.ready; await tick();
    assert.equal(h.floors.length, 1); assert.equal(h.floors[0].floorRevision, 19);
    h.sendAudio(); assert.equal(h.forwarded(), 0);
  } finally { h.socket.close(); }
});

test("a new host floor never replays the prior floor's residual PCM or resampler history", async () => {
  const h = await harness(); h.start(); h.floor(1); h.verify(); await h.ready; await tick();
  try {
    const oldAudio = Buffer.alloc(4800);
    for (let index = 0; index < oldAudio.length; index += 2) oldAudio.writeInt16LE(8000, index);
    h.sendAudio({ pcm: oldAudio });
    assert.equal(h.forwarded(), 2, "100 ms input leaves 20 ms after two 40 ms wire frames");
    h.floor(2, { participantId: "participant-a" });
    h.floor(3);
    const before = h.forwarded();
    h.sendAudio({ pcm: Buffer.alloc(4800) });
    const freshFrames = h.socket.sent.filter(Buffer.isBuffer).slice(before);
    assert.equal(freshFrames.length, 2, "the new host turn begins with a fresh frame accumulator");
    for (const frame of freshFrames) {
      assert.equal(frame.subarray(4).some(byte => byte !== 0), false, "prior-floor samples must not appear in new silence");
    }
  } finally { h.socket.close(); }
});

test("an idempotent host floor acknowledgement preserves the current audio frame clock", async () => {
  const h = await harness(); h.start(); h.floor(1); h.verify(); await h.ready; await tick();
  try {
    h.sendAudio({ pcm: Buffer.alloc(4800) });
    const adapter = h.context.liveBridgeAudioAdapters.get("mic");
    h.floor(1);
    assert.equal(h.context.liveBridgeAudioAdapters.get("mic"), adapter);
    h.sendAudio({ pcm: Buffer.alloc(4800) });
    assert.equal(h.forwarded(), 5, "same-floor ACK must not drop the valid 20 ms remainder");
  } finally { h.socket.close(); }
});
