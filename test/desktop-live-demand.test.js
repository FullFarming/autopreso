import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
import { DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection } from "../packages/caption-core/caption-engine-catalog.js";

const modulePath = "../electron/live-demand-controller.js";
const { createDesktopLiveDemandController } = await import(modulePath);
const authorizerModulePath = "../media-gateway/src/supabase-adapters.js";
/** @type {{ SupabaseHostAuthorizer: new (config: {baseUrl: string, serviceRoleKey: string, fetchFn: () => Promise<Response>}) => {
 * authorize: (claims: object, settings: object, options: object) => Promise<unknown>
 * } }} */
const { SupabaseHostAuthorizer } = await import(authorizerModulePath);

function harness(overrides = {}) {
  let now = 1_000;
  let hasSource = true;
  let active = true;
  let runtime = { enabled: true, state: "sleeping", epoch: 0, hostSourceReady: true, hasDemand: false };
  const calls = [];
  const control = createDesktopLiveDemandController({
    request: async (path, input) => { calls.push({ path, body: input?.body }); return { ok: true, data: runtime }; },
    hasSource: () => hasSource, isActive: () => active, now: () => now,
    createGeneration: (() => { let count = 0; return () => `generation-${++count}`; })(),
    onConnect: async () => { calls.push({ path: "CONNECT" }); },
    onIdle: () => { calls.push({ path: "IDLE" }); },
    onError: (code) => { calls.push({ path: "ERROR", code }); },
    setTimer: () => 1, clearTimer: () => {}, ...overrides,
  });
  return { control, calls, setRuntime: (value) => { runtime = value; },
    setSource: (value) => { hasSource = value; }, setActive: (value) => { active = value; }, advance: (delta) => { now += delta; } };
}

test("desktop waiting uses only web control and never connects without actual source and audience", async () => {
  const h = harness();
  await h.control.refresh();
  assert.equal(h.control.canConnect(), false);
  assert.equal(h.calls.some((call) => call.path === "CONNECT"), false);
  h.setRuntime({ enabled: true, state: "waking", epoch: 1, hostSourceReady: true, hasDemand: true });
  h.advance(5_000);
  await h.control.refresh();
  assert.equal(h.control.canConnect(), true);
  assert.equal(h.calls.filter((call) => call.path === "CONNECT").length, 1);
});

test("desktop source heartbeat is limited to 15s and a revoked source rotates its generation", async () => {
  const h = harness();
  await h.control.refresh();
  h.advance(5_000); await h.control.refresh();
  h.advance(5_000); await h.control.refresh();
  assert.equal(h.calls.filter((call) => call.path === "host-source").length, 1);
  h.setSource(false); h.advance(5_000); await h.control.refresh();
  h.setSource(true); h.advance(5_000); await h.control.refresh();
  const writes = h.calls.filter((call) => call.path === "host-source").map((call) => call.body);
  assert.deepEqual(writes.map((body) => body.sourceReady), [true, false, true]);
  assert.notEqual(writes[0].sourceGeneration, writes[2].sourceGeneration);
});

test("stop during an in-flight source heartbeat releases after that request and never connects", async () => {
  /** @type {() => void} */
  let release = () => { throw new Error("source request did not start"); };
  const calls = [];
  const h = harness({ request: async (path, input) => {
    calls.push(input?.body?.sourceReady);
    if (path === "host-source" && input?.body?.sourceReady === true) await new Promise((resolve) => { release = () => resolve(undefined); });
    return { ok: true, data: { enabled: true, state: "waking", epoch: 1, hostSourceReady: true, hasDemand: true } };
  } });
  const refresh = h.control.refresh();
  await Promise.resolve();
  const stopping = h.control.stop();
  release();
  await Promise.all([refresh, stopping]);
  assert.deepEqual(calls, [true, false]);
  assert.equal(h.calls.some((call) => call.path === "CONNECT"), false);
  assert.equal(h.control.canConnect(), false);
});

test("ambiguous source release discards its generation before the response and preserves the error", async () => {
  let generationCount = 0;
  const createGeneration = () => `generation-${++generationCount}`;
  const requests = [];
  let countAtReleaseRequest = 0;
  const h = harness({ createGeneration, request: async (path, input) => {
    requests.push({ path, body: input?.body });
    if (path === "host-source" && input.body.sourceReady === false) {
      countAtReleaseRequest = generationCount;
      return { ok: false, code: "NETWORK_UNAVAILABLE" };
    }
    return { ok: true, data: { enabled: true, state: "sleeping", epoch: 0, hostSourceReady: true, hasDemand: false } };
  } });
  await h.control.refresh();
  h.setSource(false); h.advance(5_000); await h.control.refresh();
  assert.equal(countAtReleaseRequest, 2, "dispose before awaiting a possibly lost release response");
  assert.equal(h.control.getState().failed, true);
  assert.equal(h.calls.some((call) => call.path === "ERROR" && call.code === "NETWORK_UNAVAILABLE"), true);
  await h.control.stop();
  assert.equal(requests.filter((call) => call.path === "host-source" && !call.body.sourceReady).length, 1);
  const recovered = harness({ createGeneration });
  await recovered.control.refresh();
  const nextReady = recovered.calls.find((call) => call.path === "host-source" && call.body.sourceReady);
  assert.notEqual(nextReady.body.sourceGeneration, requests[0].body.sourceGeneration);
  await recovered.control.stop();
});

test("malformed or failed control responses fail closed and require explicit recovery", async () => {
  const h = harness({ request: async () => ({ ok: false, code: "HOST_LOGIN_REQUIRED" }) });
  await h.control.refresh();
  assert.equal(h.control.canConnect(), false);
  assert.equal(h.control.getState().failed, true);
  assert.equal(h.calls.some((call) => call.path === "ERROR"), true);
});

test("media-idle clears cached wake permission and cannot loop on a renderer ensure poll", async () => {
  const h = harness();
  h.setRuntime({ enabled: true, state: "waking", epoch: 1, hostSourceReady: true, hasDemand: true });
  await h.control.refresh();
  h.control.handleIdle("no_audience");
  assert.equal(h.control.canConnect(), false);
  await h.control.refresh();
  assert.equal(h.calls.filter((call) => call.path === "CONNECT").length, 1);
  h.setRuntime({ enabled: true, state: "sleeping", epoch: 1, hostSourceReady: true, hasDemand: false });
  h.advance(5_000); await h.control.refresh();
  assert.equal(h.calls.filter((call) => call.path === "CONNECT").length, 1);
  h.setRuntime({ enabled: true, state: "waking", epoch: 2, hostSourceReady: true, hasDemand: true });
  h.advance(5_000); await h.control.refresh();
  assert.equal(h.calls.filter((call) => call.path === "CONNECT").length, 2);
});

test("source loss blocks connections even if a stale runtime still claims source readiness", async () => {
  const h = harness();
  h.setRuntime({ enabled: true, state: "active", epoch: 1, hostSourceReady: true, hasDemand: true });
  await h.control.refresh();
  h.setSource(false);
  assert.equal(h.control.canConnect(), false);
  h.advance(5_000); await h.control.refresh();
  assert.equal(h.calls.filter((call) => call.path === "CONNECT").length, 1);
  assert.equal(h.calls.some((call) => call.path === "host-source" && call.body.sourceReady === false), true);
});

test("media startup failure does not auto-retry or hide its error", async () => {
  const h = harness();
  h.control.handleIdle("MEDIA_START_FAILED");
  h.advance(60_000); await h.control.refresh();
  assert.equal(h.control.getState().failed, true);
  assert.equal(h.calls.some((call) => call.path === "runtime" || call.path === "CONNECT"), false);
  assert.equal(h.calls.some((call) => call.path === "ERROR" && call.code === "MEDIA_START_FAILED"), true);
});

test("authoritative ended runtime stops polling and reports a terminal session", async () => {
  const h = harness();
  h.setRuntime({ enabled: true, state: "ended", epoch: 2, hostSourceReady: false, hasDemand: false });
  await h.control.refresh();
  assert.equal(h.control.getState().failed, true);
  assert.equal(h.calls.some((call) => call.path === "ERROR" && call.code === "SESSION_ENDED"), true);
  const requests = h.calls.length;
  h.advance(60_000); await h.control.refresh();
  assert.equal(h.calls.length, requests);
});

const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
function mainSection(start, end) {
  const startIndex = main.indexOf(start);
  const endIndex = main.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  return main.slice(startIndex, endIndex);
}

test("desktop start intent retains activation identity and rejects a demand-to-legacy downgrade", async () => {
  const activationKey = "11111111-1111-4111-8111-111111111111";
  const session = { sessionId: "call-a", baseUrl: "https://example.test", demandEnabled: true };
  let enabled = true;
  const calls = [];
  const intent = vm.runInNewContext(`${mainSection("function readLiveCallModelPreferences", "function sanitizeLiveCallDraft")}
${mainSection("async function requestDesktopLiveStartIntent", "async function startDesktopLiveDemand")}; requestDesktopLiveStartIntent`, {
    createGeminiCaptionConfig, geminiCaptionConfigFingerprint, DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection,
    liveCallSession: session,
    liveCallApi: async (_base, path, input) => {
      calls.push({ path, input });
      return input.method === "GET"
        ? { ok: true, data: { id: "call-a", version: 8, activationKey } }
        : { ok: true, data: { sessionId: "call-a", version: 8, activationKey: "22222222-2222-4222-8222-222222222222", runtime: { enabled } } };
    },
  });
  assert.equal((await intent(session)).ok, true);
  assert.equal(session.activationKey, activationKey);
  assert.equal(calls[1].input.body.demandEnabled, true);
  assert.equal(calls[1].input.body.version, 8);
  enabled = false;
  assert.equal((await intent(session)).code, "MEDIA_DEMAND_DISABLED");
  assert.equal(session.demandEnabled, true);
});

test("desktop main denies token, health and socket work without demand while legacy transport remains available", async () => {
  const calls = [];
  const context = {
    liveCallSession: { status: "preparing", demandEnabled: true },
    liveDemandController: { canConnect: () => false },
    liveGatewayBridge: null,
    fetchGatewayConnection: async () => { calls.push("token"); return { ok: false, code: "EXPECTED_LEGACY_CONNECTION" }; },
    warmLiveGatewayBeforeSocket: () => { calls.push("health"); },
    WebSocket: class { constructor() { calls.push("socket"); } },
  };
  const ensure = vm.runInNewContext(`${mainSection("function readLiveCallModelPreferences", "function sanitizeLiveCallDraft")}
${mainSection("async function ensureLiveGatewayBridgeOnce", "async function ensureLiveGatewayBridgeForStatus")}; ensureLiveGatewayBridgeOnce`, Object.assign(context, { createGeminiCaptionConfig, geminiCaptionConfigFingerprint, DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection }));
  assert.equal((await ensure({ allowPreparing: true })).waiting, true);
  assert.deepEqual(calls, []);
  context.liveCallSession.demandEnabled = false;
  assert.equal((await ensure({ allowPreparing: true })).code, "EXPECTED_LEGACY_CONNECTION");
  assert.deepEqual(calls, ["token"]);
});

test("only validated PCM from the bound dashboard proves source readiness before any gateway exists", () => {
  let handler = (_event, _packet) => { throw new Error("audio handler was not registered"); };
  const dashboard = { getURL: () => "http://localhost:3210" };
  const session = { sessionId: "call-a", status: "preparing", demandEnabled: true };
  vm.runInNewContext(mainSection('ipcMain.on("live-call:audio-frame"', 'ipcMain.handle("live-call:end"'), {
    ipcMain: { on: (_event, listener) => { handler = listener; } },
    isAllowedOrigin: (origin) => origin === "http://localhost:3210",
    localAppOrigin: "http://localhost:3210", dashboardWindow: { isDestroyed: () => false, webContents: dashboard },
    liveCallSession: session, liveGatewayBridge: null, Buffer, ArrayBuffer,
    CAPTION_BRIDGE_PACKET_BYTES: 4_800, Date: { now: () => 55 },
  });
  const packet = { source: "mic", sessionId: "call-a", pcm: Buffer.alloc(4_800), sampleRate: 24_000, frameDurationMs: 100 };
  handler({ sender: { getURL: dashboard.getURL } }, packet);
  assert.equal(session.lastValidatedPcmAt, undefined);
  handler({ sender: dashboard }, { ...packet, sessionId: "other-call" });
  handler({ sender: dashboard }, { ...packet, pcm: Buffer.alloc(1) });
  assert.equal(session.lastValidatedPcmAt, undefined);
  handler({ sender: dashboard }, packet);
  assert.equal(session.lastValidatedPcmAt, 55);
});

test("renderer demand preflight keeps capture independent from gateway readiness and cannot select local AI", () => {
  const source = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
  const sync = source.slice(source.indexOf("async function syncLiveCallAudioBridge()"), source.indexOf("async function startHybridCaptionSession"));
  assert.ok(sync.indexOf("await startLiveCallMicCapture()") < sync.indexOf("await bridge.ensureLiveCallBridge()"));
  assert.match(source, /const startedProducerKind = liveState\.demandEnabled === true \? "gateway" : resolveLiveCallProducerKind\(\)/u);
  assert.match(source, /const recoveredProducerKind = liveState\.demandEnabled === true \? "gateway" : resolveLiveCallProducerKind\(\)/u);
  assert.match(source, /activeCaptionSessionOwner === "live-call" && state\.running && !isLiveParticipantFloorActive\s*&& !isLiveParticipantDemandEnabled/u);
  assert.match(source, /demandEnabled: request\?\.demandEnabled === true/u);
  assert.match(source, /sessionId: activeLiveFloorSessionId,[\s\S]*source: sourceName/u);
  assert.match(main, /armedSession\.demandEnabled === true \? \{ demandEnabled: true \}/u);
});

function mainGatewayHarness() {
  const sockets = [];
  const attempts = [];
  const session = { sessionId: "call-a", status: "live", baseUrl: "https://example.test", version: 1,
    activationVersion: 1, activationKey: "11111111-1111-4111-8111-111111111111", gatewaySettings: { languages: ["en"] } };
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    messages = [];
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.emit("open")); }
    send(value) {
      const message = JSON.parse(value); this.messages.push(message);
      if (message.type === "authenticate") queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "authenticated" }))));
      if (["start", "restart"].includes(message.type)) queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({
        type: message.type === "restart" ? "restarted" : "started", sessionId: "call-a", version: 9,
      }))));
    }
    close() { this.readyState = 3; this.emit("close"); }
  }
  const context = {
    liveCallSession: session, liveGatewayBridge: null, liveDemandController: null, isQuitting: false,
    fetchGatewayConnection: async () => ({ ok: true, gatewayUrl: "wss://example.test/live", token: "fake-token" }),
    remainingLiveGatewayStartBudget: () => 1000,
    liveCallApi: async () => ({ ok: true, data: { id: "call-a", status: "live", version: 9 } }),
    warmLiveGatewayBeforeSocket: async () => {}, trustedGatewayHeaders: () => ({}),
    WebSocket: Socket, createLiveCaptionIpcRelay: () => ({ close() {} }),
    confirmLiveGatewayStarted: async (bridge) => { bridge.ready = true; return { ok: true, streaming: true }; },
    scheduleLiveGatewayReconnect: () => { if (!session.requiresManualGatewayRestart) attempts.push("reconnect"); },
    liveBridgeAudioAdapters: new Map(), clearLiveBridgeCredentialRefresh() {}, clearLiveBridgeReconnect() {},
    setLiveBridgeAlert() {}, LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS: 500, Buffer, setTimeout, clearTimeout, console,
  };
  const ensure = vm.runInNewContext(`${mainSection("function readLiveCallModelPreferences", "function sanitizeLiveCallDraft")}
${mainSection("async function ensureLiveGatewayBridgeOnce", "async function ensureLiveGatewayBridgeForStatus")}; ensureLiveGatewayBridgeOnce`, Object.assign(context, { createGeminiCaptionConfig, geminiCaptionConfigFingerprint, DEFAULT_ENGINE_SELECTION, EngineSelectionError, normalizeEngineSelection }));
  return { sockets, session, context, attempts, ensure };
}

test("desktop manual restart uses its one-shot intent and current version; later automatic connections only start", async () => {
  const h = mainGatewayHarness();
  h.session.manualGatewayRestartPending = true;
  assert.equal((await h.ensure()).ok, true);
  const restart = h.sockets[0].messages.find((message) => message.type === "restart");
  assert.equal(restart?.version, 9);
  assert.equal(restart?.activationKey, undefined);
  assert.equal(h.session.manualGatewayRestartPending, false);
  h.context.liveGatewayBridge = null;
  assert.equal((await h.ensure()).ok, true);
  assert.equal(h.sockets[1].messages.some((message) => message.type === "restart"), false);
  assert.equal(h.sockets[1].messages.some((message) => message.type === "start"), true);
});

test("desktop preparing manual retry preserves the server activation key for readiness validation", async () => {
  const h = mainGatewayHarness();
  h.session.status = "preparing";
  h.session.manualGatewayRestartPending = true;
  h.context.liveCallApi = async () => ({ ok: true, data: { id: "call-a", status: "preparing", version: 9 } });
  assert.equal((await h.ensure({ allowPreparing: true })).ok, true);
  const request = h.sockets[0].messages.find((message) => message.type === "restart");
  assert.equal(request?.activationKey, h.session.activationKey);
  assert.equal(request?.version, 9);
  assert.equal(h.session.manualGatewayRestartPending, false);
});

test("initial desktop activation uses the latest preparing version and the engine STT model without replacing its activation key", async () => {
  const h = mainGatewayHarness();
  h.session.status = "preparing";
  const activationKey = h.session.activationKey;
  h.session.gatewaySettings.captionConfig = createGeminiCaptionConfig({ languages: h.session.gatewaySettings.languages, geminiTranscribeModel: "gemini-3.6-flash" });
  h.context.liveCallApi = async () => ({ ok: true, data: { id: "call-a", status: "preparing", version: 9 } });
  await h.ensure({ allowPreparing: true });
  const request = h.sockets[0].messages.find((message) => message.type === "start");
  const authorizer = new SupabaseHostAuthorizer({ baseUrl: "https://fixture.invalid", serviceRoleKey: "fixture",
    fetchFn: async () => Response.json([{ id: "call-a", host_id: "fixture-host", status: "preparing", version: 9,
      session_type: "meeting", output_mode: "captions", languages: ["en"], pinned_glossary_fingerprint: null,
      event_metadata: { modelPreferences: { engine: DEFAULT_ENGINE_SELECTION } } }]),
  });
  const authorized = await authorizer.authorize({ role: "HOST", sub: "fixture-host", sessionId: "call-a" }, request, { readinessStart: true });
  assert.notEqual(authorized, false, "a refreshed version must reach the real gateway authorization boundary");
  assert.equal(request.version, 9);
  assert.equal(request.activationKey, activationKey);
  assert.equal(request.captionConfig.models.transcription, DEFAULT_ENGINE_SELECTION.stt.model);
  h.sockets[0].close();
});

test("already-live activation retains the original version and key for lost-ACK replay", async () => {
  const h = mainGatewayHarness();
  h.context.liveCallApi = async () => ({ ok: true, data: { id: "call-a", status: "live", version: 2 } });
  const activationKey = h.session.activationKey;
  await h.ensure();
  const request = h.sockets[0].messages.find((message) => message.type === "start");
  assert.equal(request.version, 1);
  assert.equal(request.activationKey, activationKey);
  h.sockets[0].close();
});

test("desktop fatal provider signal marks a manual fence before its close can schedule automatic recovery", async () => {
  const h = mainGatewayHarness();
  await h.ensure();
  h.sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "error", code: "PIPELINE_RESTART_REQUIRED" })));
  h.sockets[0].close();
  assert.equal(h.session.requiresManualGatewayRestart, true);
  assert.deepEqual(h.attempts, []);
});

test("desktop demand manual restart is serialized and retains the intent while no viewer is present", async () => {
  const session = { sessionId: "call-a", status: "live", demandEnabled: true };
  let intents = 0;
  let resets = 0;
  const context = {
    liveCallSession: session, liveTranslationReconnectInFlight: null, liveDemandController: {},
    requestDesktopLiveStartIntent: async () => { intents += 1; return { ok: true }; },
    stopLiveGatewayBridge: async () => {},
    startDesktopLiveDemand: async () => { resets += 1; return { ok: true, waiting: true, streaming: false }; },
  };
  const restart = vm.runInNewContext(`${mainSection("async function restartLiveTranslationBridge", "// Host Speak:")}; restartLiveTranslationBridge`, context);
  const [first, second] = await Promise.all([restart(), restart()]);
  assert.equal(first.waiting, true); assert.equal(second.waiting, true);
  assert.equal(intents, 1); assert.equal(resets, 1);
  assert.equal(session.manualGatewayRestartPending, true);
});

test("desktop manual restart cannot open a different meeting when teardown finishes after a session switch", async () => {
  const firstSession = { sessionId: "call-a", status: "live" };
  let connections = 0;
  const context = {
    liveCallSession: firstSession, liveTranslationReconnectInFlight: null, liveGatewayBridge: null,
    setLiveBridgeAlert() {},
    stopLiveGatewayBridge: async () => { context.liveCallSession = { sessionId: "call-b", status: "live" }; },
    ensureLiveGatewayBridge: async () => { connections += 1; return { ok: true }; },
  };
  const restart = vm.runInNewContext(`${mainSection("async function restartLiveTranslationBridge", "// Host Speak:")}; restartLiveTranslationBridge`, context);
  assert.equal((await restart()).code, "LIVE_CALL_STATE_CHANGED");
  assert.equal(connections, 0);
  assert.equal(firstSession.manualGatewayRestartPending, undefined);
});
