import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  sanitizeLiveCaptionDisplayLanguage,
  shouldDisplayLiveCaption,
} from "../src/live-caption-display-policy.js";


const mainSource = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../electron/preload.js", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("../public/subtitle-workspace.js", import.meta.url), "utf8");

test("Live Call desktop renders exactly one opposite-language lane for both inputs and both speakers", () => {
  for (const displayLanguage of ["ko", "en"]) {
    for (const sourceLanguage of ["ko", "en"]) {
      for (const isParticipant of [false, true]) {
        const translationLanguage = sourceLanguage === "ko" ? "en" : "ko";
        const captions = [
          { language: sourceLanguage, sourceLanguage, origin: "source", speaker: { isParticipant } },
          { language: translationLanguage, sourceLanguage, speaker: { isParticipant } },
          // Provider echo: selected-language text without a cross-language
          // source identity must never become a second screen line.
          { language: sourceLanguage, sourceLanguage, speaker: { isParticipant } },
        ];
        const displayed = captions.filter((caption) => shouldDisplayLiveCaption(caption, displayLanguage));
        assert.equal(displayed.length, 1, `${displayLanguage}/${sourceLanguage}/${isParticipant}`);
        assert.equal(displayed[0].language, translationLanguage);
        assert.equal(displayed[0].sourceLanguage, sourceLanguage);
        assert.equal(displayed[0].origin, undefined);
      }
    }
  }
});

test("Live Call display rejects source, failed, and same-language events while allowing status-less meeting translations", () => {
  assert.equal(sanitizeLiveCaptionDisplayLanguage("en"), "en");
  assert.equal(sanitizeLiveCaptionDisplayLanguage("ko"), "ko");
  for (const invalid of [undefined, null, "EN", "ja", "", {}, []]) {
    assert.equal(sanitizeLiveCaptionDisplayLanguage(invalid), "ko");
  }
  assert.equal(shouldDisplayLiveCaption({ language: "en", sourceLanguage: "ko", origin: "source" }, "ko"), false);
  assert.equal(shouldDisplayLiveCaption({ language: "en", sourceLanguage: "ko", translationStatus: "failed" }, "ko"), false);
  assert.equal(shouldDisplayLiveCaption({ language: "ko", sourceLanguage: "ko" }, "ko"), false);
  assert.equal(shouldDisplayLiveCaption({ language: "en", sourceLanguage: "ko" }, "ko"), true);
  assert.equal(shouldDisplayLiveCaption({ language: "en", sourceLanguage: "ko" }, "en"), true,
    "the old fixed display-language setting must not override utterance direction");
  assert.equal(shouldDisplayLiveCaption({ language: "ko", sourceLanguage: "en" }, "ko"), true);
  assert.equal(shouldDisplayLiveCaption({ language: "ja", sourceLanguage: "ko" }, "ko"), false);
  assert.equal(shouldDisplayLiveCaption({ language: "ko", sourceLanguage: "ja" }, "ko"), false);
});

function sourceBetween(start, end) {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source start: ${start}`);
  assert.notEqual(endIndex, -1, `missing source end: ${end}`);
  return mainSource.slice(startIndex, endIndex);
}

test("one-button Live Call never opens a login page and requires an invite before Stage", () => {
  const startHandler = sourceBetween(
    'ipcMain.handle("live-call:start"',
    'ipcMain.handle("live-call:save-host-login"',
  );
  assert.doesNotMatch(startHandler, /openLiveWorkspace\(/u);
  const inviteFailure = startHandler.indexOf("if (!invite.ok)");
  const armSession = startHandler.indexOf("liveCallSession =");
  const openStage = startHandler.indexOf("openLiveStageOverlay(");
  assert.ok(inviteFailure >= 0 && inviteFailure < armSession);
  assert.ok(inviteFailure < openStage);
});

test("failed invite creation compensates the already-created session", () => {
  const startHandler = sourceBetween(
    'ipcMain.handle("live-call:start"',
    'ipcMain.handle("live-call:save-host-login"',
  );
  assert.match(startHandler, /if \(!invite\.ok\)[\s\S]*return failPreparedLiveSession\(/u);
  const cleanup = sourceBetween(
    "async function cleanupPreparedLiveSession",
    "const LIVE_DRAFT_LANGUAGES",
  );
  assert.match(cleanup, /method:\s*"DELETE"/u);
  assert.match(cleanup, /encodeURIComponent\(sessionId\)/u);
});

test("desktop host password is encrypted at rest and never returned to a renderer", () => {
  assert.match(mainSource, /\bsafeStorage\b/u);
  assert.match(mainSource, /safeStorage\.encryptString\(/u);
  assert.match(mainSource, /safeStorage\.decryptString\(/u);
  const statusHandler = sourceBetween(
    'ipcMain.handle("live-call:get-host-login-status"',
    'ipcMain.handle("live-call:get-state"',
  );
  assert.doesNotMatch(statusHandler, /return\s*\{[^}]*\b(?:hostPassword|hostPasswordEncrypted)\s*:/u);
});

test("Live Call IPC accepts a bounded cover payload and validates decoded image signatures", () => {
  const sanitizer = sourceBetween(
    "function sanitizeLiveCallDraft",
    "function openLiveStageOverlay",
  );
  assert.match(sanitizer, /typeof source\.title === "string"/u);
  assert.match(sanitizer, /Number\.isInteger\(source\.maxViewers\)/u);
  assert.match(sanitizer, /Array\.isArray\(source\.languages\)/u);
  assert.match(sanitizer, /displayLanguage: sanitizeLiveCaptionDisplayLanguage\(source\.displayLanguage\)/u);
  assert.match(mainSource, /function toLiveCallApiInput/u);
  assert.doesNotMatch(sourceBetween("function toLiveCallApiInput", "async function openLiveStageOverlay"), /displayLanguage/u);
  assert.match(workspaceSource, /MAX_COVER_IMAGE_BYTES = 5 \* 1024 \* 1024/u);
  assert.match(workspaceSource, /new Set\(\["image\/jpeg", "image\/png", "image\/webp"\]\)/u);
  assert.match(workspaceSource, /file\.size <= 0 \|\| file\.size > MAX_COVER_IMAGE_BYTES/u);
  assert.match(workspaceSource, /new Uint8Array\(await file\.arrayBuffer\(\)\)/u);
  assert.match(workspaceSource, /base64: window\.btoa\(binary\)/u);
  assert.match(workspaceSource, /coverImage: liveDraftCoverData/u);
  assert.match(preloadSource, /startLiveCall: \(draft\) => ipcRenderer\.invoke\("live-call:start", draft\)/u);
  assert.match(preloadSource, /startRegisteredLiveCall: \(sessionId, options\).*sessionId, options/u);
  assert.match(mainSource, /MAX_LIVE_COVER_BYTES = 5 \* 1024 \* 1024/u);
  assert.match(mainSource, /function validateLiveCoverImage/u);
  assert.match(mainSource, /size > MAX_LIVE_COVER_BYTES/u);
  assert.match(mainSource, /base64\.length > Math\.ceil\(MAX_LIVE_COVER_BYTES \/ 3\) \* 4 \+ 4/u);
  assert.match(mainSource, /Buffer\.from\(base64, "base64"\)/u);
  assert.match(mainSource, /bytes\.length !== size/u);
  assert.match(mainSource, /matchesLiveCoverMagicBytes\(bytes, contentType\)/u);
  assert.match(mainSource, /0x89, 0x50, 0x4e, 0x47/u);
  assert.match(mainSource, /bytes\[0\] === 0xff && bytes\[1\] === 0xd8/u);
  assert.match(mainSource, /toString\("ascii"\) === "WEBP"/u);
});

test("binary cover upload declares exact length, cookies, origin, and a fixed encoded path", () => {
  const rawApi = sourceBetween(
    "async function liveCallRawApi",
    "function matchesLiveCoverMagicBytes",
  );
  assert.match(rawApi, /credentials: "include"/u);
  assert.match(rawApi, /\borigin\b/u);
  assert.match(rawApi, /["']content-length["']\s*:\s*String\(bytes\.byteLength\)/u);
  const uploader = sourceBetween(
    "async function uploadLiveCover",
    "async function cleanupPreparedLiveSession",
  );
  assert.match(uploader, /`\/api\/live-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/cover`/u);
  assert.doesNotMatch(uploader, /image\.(?:url|path|name)/u);
});

test("Live Call IPC uses exact origin checks for read and mutation channels", () => {
  const handlers = sourceBetween(
    'ipcMain.handle("live-workspace:get-enabled"',
    'ipcMain.handle("subtitle-overlay:get-enabled"',
  );
  for (const channel of [
    "live-workspace:get-enabled",
    "live-call:start",
    "live-call:save-host-login",
    "live-call:get-host-login-status",
    "live-call:get-state",
    "live-call:go-live",
  ]) {
    const start = handlers.indexOf(`ipcMain.handle("${channel}"`);
    assert.notEqual(start, -1, channel);
    const next = handlers.indexOf("ipcMain.handle(", start + 20);
    const block = handlers.slice(start, next < 0 ? undefined : next);
    assert.match(block, /isAllowedOrigin\(event\.sender\.getURL\(\), new Set\(\[localAppOrigin\]\)\)/u, channel);
  }
  assert.match(mainSource, /credentials: "include"/u);
  assert.match(mainSource, /headers: \{ "content-type": "application\/json", origin \}/u);
  assert.match(mainSource, /encodeURIComponent\(sessionData\.id\)/u);
});

test("Live Call failure responses and logs do not expose stored credentials", () => {
  const api = sourceBetween("async function liveCallApi", "const LIVE_DRAFT_LANGUAGES");
  assert.doesNotMatch(api, /console\.(?:log|info|debug|warn)/u);
  assert.doesNotMatch(api, /hostPassword|password/u);
  const startHandler = sourceBetween(
    'ipcMain.handle("live-call:start"',
    'ipcMain.handle("live-call:save-host-login"',
  );
  assert.doesNotMatch(startHandler, /hostPassword/u);
});

// ── Live Call gateway reconnect ────────────────────────────────────────────
// The old close handler retried on a hardcoded `setTimeout(..., 3_000)`: no
// backoff, no attempt ceiling, and the timer id was never stored so
// stopLiveGatewayBridge could not cancel it. Each attempt makes three
// authenticated HTTPS calls, so a dead gateway meant ~60 requests/min forever
// while the host watched a running timer over dead air.

function loadLiveBridgeReconnect(overrides = {}) {
  const timers = [];
  const cleared = [];
  const dialogs = [];
  const logs = [];
  const context = {
    liveGatewayBridge: null,
    liveBridgeReconnectTimer: null,
    liveBridgeReconnectAttempts: 0,
    liveBridgeAlert: null,
    hasNotifiedLiveBridgeFailure: false,
    isQuitting: false,
    liveCallSession: null,
    LIVE_BRIDGE_RECONNECT_BASE_MS: 1_000,
    LIVE_BRIDGE_RECONNECT_MAX_MS: 20_000,
    MAX_LIVE_BRIDGE_RECONNECTS: 8,
    dialog: { showMessageBox: (options) => { dialogs.push(options); return Promise.resolve({}); } },
    showControllerWindow: () => {},
    ensureLiveGatewayBridge: () => Promise.resolve({ ok: true }),
    console: { warn: (m) => logs.push(m), error: (m) => logs.push(m), info: (m) => logs.push(m) },
    setTimeout: (callback, delay) => {
      const token = { callback, delay };
      timers.push(token);
      return token;
    },
    clearTimeout: (token) => cleared.push(token),
    Promise,
    Math,
    ...overrides,
  };
  const api = vm.runInNewContext(
    `${sourceBetween("function setLiveBridgeAlert", "async function ensureLiveGatewayBridge")};
     ({ scheduleLiveGatewayReconnect, clearLiveBridgeReconnect, stopLiveGatewayBridge, liveBridgeStatus, clearLiveBridgeAlert })`,
    context,
  );
  return { ...api, timers, cleared, dialogs, logs, context };
}

test("gateway reconnect backs off exponentially, caps the delay, and disarms at the ceiling", async () => {
  const bridge = loadLiveBridgeReconnect();
  const armedSession = { sessionId: "s1", status: "live" };
  bridge.context.liveCallSession = armedSession;

  const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 20_000, 20_000, 20_000];
  for (const delay of expected) {
    bridge.scheduleLiveGatewayReconnect(armedSession);
    assert.equal(bridge.timers.at(-1).delay, delay);
    // The timer id must be STORED so it can be cancelled.
    assert.equal(bridge.context.liveBridgeReconnectTimer, bridge.timers.at(-1));
    assert.equal(bridge.liveBridgeStatus().state, "reconnecting");
    bridge.timers.at(-1).callback();
    await Promise.resolve();
    assert.equal(bridge.context.liveBridgeReconnectTimer, null);
  }
  assert.equal(bridge.timers.length, 8, "MAX_LIVE_BRIDGE_RECONNECTS caps the attempts");

  // Ceiling reached: no ninth timer, and the host is finally told.
  bridge.scheduleLiveGatewayReconnect(armedSession);
  assert.equal(bridge.timers.length, 8);
  assert.equal(bridge.liveBridgeStatus().state, "failed");
  assert.equal(bridge.liveBridgeStatus().code, "GATEWAY_RECONNECT_EXHAUSTED");
  assert.equal(bridge.dialogs.length, 1);
  assert.equal(bridge.dialogs[0].type, "error");

  // Reporting happens ONCE, not on every subsequent close.
  bridge.scheduleLiveGatewayReconnect(armedSession);
  assert.equal(bridge.dialogs.length, 1);
});

test("gateway reconnect re-arms itself when an attempt never opens a socket", async () => {
  // A token/config fetch failure produces no socket, so there is no `close`
  // event to drive the next retry — the scheduler must re-arm on its own.
  const bridge = loadLiveBridgeReconnect({
    ensureLiveGatewayBridge: () => Promise.resolve({ ok: false, code: "GATEWAY_URL_UNAVAILABLE" }),
  });
  const armedSession = { sessionId: "s1", status: "live" };
  bridge.context.liveCallSession = armedSession;
  bridge.scheduleLiveGatewayReconnect(armedSession);
  bridge.timers.at(-1).callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bridge.timers.length, 2);
  assert.equal(bridge.timers[1].delay, 2_000);
});

test("gateway reconnect never fires for a session that is no longer live, and stop cancels the timer", () => {
  const armedSession = { sessionId: "s1", status: "live" };

  const quitting = loadLiveBridgeReconnect({ isQuitting: true });
  quitting.context.liveCallSession = armedSession;
  quitting.scheduleLiveGatewayReconnect(armedSession);
  assert.equal(quitting.timers.length, 0);

  const stopped = loadLiveBridgeReconnect();
  stopped.context.liveCallSession = armedSession;
  stopped.scheduleLiveGatewayReconnect({ sessionId: "s1", status: "stopped" });
  assert.equal(stopped.timers.length, 0, "a stale session object must not be retried");

  const replaced = loadLiveBridgeReconnect();
  replaced.context.liveCallSession = { sessionId: "s2", status: "live" };
  replaced.scheduleLiveGatewayReconnect(armedSession);
  assert.equal(replaced.timers.length, 0, "a superseded session must not be retried");

  // Ending the call must cancel an armed retry: a pending reconnect used to
  // survive stop/end/quit and reopen the bridge against a dead session.
  const running = loadLiveBridgeReconnect();
  running.context.liveCallSession = armedSession;
  running.scheduleLiveGatewayReconnect(armedSession);
  assert.equal(running.timers.length, 1);
  running.stopLiveGatewayBridge("live call ended");
  assert.deepEqual(running.cleared, [running.timers[0]]);
  assert.equal(running.context.liveBridgeReconnectTimer, null);
  assert.equal(running.context.liveBridgeReconnectAttempts, 0);
});

test("live call state reports gateway health so a dead bridge is not hidden behind a ticking timer", () => {
  assert.match(mainSource, /LIVE_BRIDGE_RECONNECT_BASE_MS = 1_000/u);
  assert.match(mainSource, /LIVE_BRIDGE_RECONNECT_MAX_MS = 20_000/u);
  assert.match(mainSource, /MAX_LIVE_BRIDGE_RECONNECTS = 8/u);
  // The unbounded hardcoded retry is gone.
  assert.doesNotMatch(mainSource, /setTimeout\(\(\) => \{ void ensureLiveGatewayBridge\(\); \}, 3_000\)/u);
  const closeHandler = sourceBetween('socket.on("close"', "return { ok: true, streaming: false }");
  assert.match(closeHandler, /scheduleLiveGatewayReconnect\(armedSession\)/u);
  const getState = sourceBetween('ipcMain.handle("live-call:get-state"', 'ipcMain.handle("live-call:host-speak"');
  assert.match(getState, /bridge: liveBridgeStatus\(\)/u);
  // A live pipeline resets the backoff so a drop hours in gets the full budget.
  const messageHandler = sourceBetween('message.type === "started"', 'message.type === "caption"');
  assert.match(messageHandler, /liveBridgeReconnectAttempts = 0/u);
  assert.match(messageHandler, /clearLiveBridgeAlert\(\)/u);
});

test("active bridge host-speak is single-flight and does not leak listeners across repeated handoffs", async () => {
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sends = [];
    send(payload) { this.sends.push(JSON.parse(payload)); }
  }
  const socket = new FakeSocket();
  const context = {
    liveGatewayBridge: { ready: true, socket },
    hostSpeakInFlight: null,
    WebSocket: { OPEN: 1 },
    JSON,
    setTimeout,
    clearTimeout,
  };
  const api = vm.runInNewContext(
    `${sourceBetween("function hostSpeakViaActiveBridge", "// After the host ends")}; hostSpeakViaActiveBridge`,
    context,
  );
  for (let turn = 0; turn < 12; turn += 1) {
    const first = api();
    const duplicate = api();
    assert.equal(first, duplicate, "rapid duplicate presses share one request");
    assert.equal(socket.sends.at(-1).type, "host-speak");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "host-speak-started" })));
    assert.equal((await first).ok, true);
    await Promise.resolve();
    assert.equal(socket.listenerCount("message"), 0);
    assert.equal(socket.listenerCount("close"), 0);
  }
  assert.equal(socket.sends.length, 12, "no token-mint fallback socket is used for active handoffs");
});

// ── Boot survives a malformed settings.json ────────────────────────────────
// `src/settings-store.js` threw on `{"subtitle": null}`, which rejected
// createApp() and left the user with a dock icon: no window, no dialog.

test("a malformed settings file is quarantined and boot never rejects silently", () => {
  assert.match(mainSource, /settings\.json\.corrupt|\$\{SETTINGS_PATH\}\.corrupt-\$\{Date\.now\(\)\}/u);
  const quarantine = sourceBetween("function quarantineSettingsFile", "async function loadSettingsStoreResiliently");
  assert.match(quarantine, /fs\.renameSync\(SETTINGS_PATH/u);
  assert.match(quarantine, /error\.code === "ENOENT"/u);
  const resilientLoad = sourceBetween("async function loadSettingsStoreResiliently", "async function createApp");
  assert.match(resilientLoad, /try \{[\s\S]*settingsStore\.load\(\)[\s\S]*\} catch/u);
  assert.match(resilientLoad, /quarantineSettingsFile\(\)/u);
  // Re-seed defaults through a fresh store: load() writes defaults when the
  // file is missing.
  assert.match(resilientLoad, /createSettingsStore\(\{ filePath: SETTINGS_PATH \}\)[\s\S]*freshStore\.load\(\)/u);
  assert.match(mainSource, /title: "Settings were reset"/u);
  // Last-resort: every other boot failure gets a dialog instead of dying.
  assert.match(mainSource, /app\.whenReady\(\)\.then\(createApp\)\.catch\(/u);
  assert.match(mainSource, /dialog\.showErrorBox\(\s*\n?\s*"NOVA could not start"/u);
});
