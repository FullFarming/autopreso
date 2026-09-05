import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import { MESSAGES } from "../public/subtitle-i18n.js";

const rootDir = path.join(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(rootDir, relative), "utf8");

test("one-button Live Call start is fail-closed and opens Stage only after auth, create, cover, and invite", () => {
  const main = read("electron/main.js");

  // Session + invite are created via net.fetch with the default-session host
  // cookies; the CSRF middleware requires a matching Origin header.
  assert.match(main, /ipcMain\.handle\("live-call:start"/u);
  assert.match(main, /ipcMain\.handle\("live-call:go-live"/u);
  assert.match(main, /ipcMain\.handle\("live-call:get-state"/u);
  assert.match(main, /net\.fetch\(/u);
  assert.match(main, /credentials: "include"/u);
  assert.match(main, /headers: \{ "content-type": "application\/json", origin \}/u);
  // Renderer origin is verified before any privileged call.
  assert.match(main, /live-call:start"[\s\S]{0,400}isAllowedOrigin\(event\.sender\.getURL\(\)/u);
  // Missing or rejected host login is explicit and cannot open a login window.
  assert.match(main, /HOST_LOGIN_REQUIRED/u);
  const startFlow = main.slice(
    main.indexOf('ipcMain.handle("live-call:start"'),
    main.indexOf('ipcMain.handle("glossary-presets:list"'),
  );
  assert.equal(startFlow.includes("openLiveWorkspace"), false);
  assert.ok(startFlow.indexOf("ensureDesktopHostSession") < startFlow.indexOf('"/api/live-sessions"'));
  assert.ok(startFlow.indexOf('"/api/live-sessions"') < startFlow.indexOf("uploadLiveCover"));
  assert.ok(startFlow.indexOf('"/api/live-sessions"') < startFlow.indexOf("pinLiveCallGlossaries"));
  assert.ok(startFlow.indexOf("pinLiveCallGlossaries") < startFlow.indexOf("uploadLiveCover"));
  assert.ok(startFlow.indexOf("uploadLiveCover") < startFlow.indexOf("/invites"));
  assert.ok(startFlow.indexOf("/invites") < startFlow.indexOf("openLiveStageOverlay"));
  assert.ok(startFlow.indexOf("openLiveStageOverlay") < startFlow.indexOf("liveCallSession ="));
  assert.match(startFlow, /if \(!invite\.ok\)[\s\S]*failPreparedLiveSession/u);
  assert.match(startFlow, /if \(!coverUpload\.ok\)[\s\S]*failPreparedLiveSession/u);
  assert.match(startFlow, /LIVE_CALL_START_IN_PROGRESS/u);
  assert.match(startFlow, /if \(liveCallSession\) return \{ ok: false, code: "LIVE_CALL_ALREADY_ARMED" \}/u);
  assert.match(startFlow, /isLiveCallStarting = true/u);
  assert.match(startFlow, /finally \{[\s\S]*isLiveCallStarting = false/u);
  assert.doesNotMatch(main, /ipcMain\.handle\("live-workspace:open"/u);
  // The stage overlay is a hardened frameless window on the stage route.
  assert.match(main, /function openLiveStageOverlay/u);
  assert.match(main, /frame: false/u);
  assert.match(main, /openLiveStageOverlay\([\s\S]{0,2400}contextIsolation: true/u);
  assert.match(main, /adoptStageWindow\(window, origin, stagePath\)/u);
  assert.match(main, /\/stage\/\$\{encodeURIComponent\(sessionId\)\}/u);
  // Draft input is sanitized before it reaches the API.
  assert.match(main, /function sanitizeLiveCallDraft/u);
  // Privileged actions reuse a verified cookie session without submitting credentials.
  assert.match(main, /function ensureDesktopHostSession/u);
  assert.doesNotMatch(main, /silentHostLogin|hostPassword|safeStorage/u);
  assert.match(main, /const login = await ensureDesktopHostSession\(liveWorkspaceUrl\)/u);
  // The stored workspace override may only ever point at loopback HTTP.
  assert.match(main, /new URL\(parsed\)\.protocol === "http:"/u);
  // The webapp's createLiveSessionInputSchema is .strict() with a REQUIRED
  // glossaryPack and maxViewers capped at 200 — the desktop draft must match
  // that contract exactly or every Start Live Call 400s.
  assert.match(main, /Math\.min\(200, Math\.max\(2, source\.maxViewers\)\)/u);
  assert.match(main, /glossaryPack: "general_cre"/u);
  assert.match(main, /glossaries:\s*sanitizeLiveCallGlossaries\(source\.glossaries \?\? subtitleSettings\.glossaries\)/u);
  assert.match(main, /body: \{ expectedVersion: sessionData\.version, glossaries \}/u);
  assert.match(main, /sourceKind:\s*"builtin"[\s\S]*sourceKind:\s*"host"/u);
  assert.match(main, /liveCaptionConfig = createGeminiCaptionConfig\(/u);
  assert.match(main, /glossaryText: liveCaptionConfig\?\.glossary \?\? ""/u);
  assert.doesNotMatch(main, /buildLiveCallGlossary\(savedSettings/u);
});

test("session failures remain explicit and actions never replay credential login", () => {
  const main = read("electron/main.js");
  const wrapper = main.slice(main.indexOf("async function liveCallApiWithHostSession"), main.indexOf("function sanitizeLiveCallDraft"));
  assert.match(wrapper, /ensureDesktopHostSession/u);
  assert.doesNotMatch(wrapper, /silentHostLogin|retry|\/api\/login/u);
  assert.match(main, /if \(!login.ok\) \{\s*return login;/u);
  assert.doesNotMatch(read("electron/preload.js"), /saveLiveHostLogin|getLiveHostLoginStatus/u);
});

test("Stage remains hidden until its exact session path finishes loading", () => {
  const main = read("electron/main.js");
  const stage = main.slice(
    main.indexOf("async function openLiveStageOverlay"),
    main.indexOf("// Live Call feature flag"),
  );
  assert.match(stage, /show: false/u);
  assert.ok(stage.indexOf("await window.loadURL") < stage.indexOf("adoptStageWindow"));
  assert.match(stage, /isExactLiveStageUrl/u);
  assert.match(stage, /window\.webContents\.getURL\(\)/u);
  assert.match(stage, /throw new Error\("STAGE_OPEN_FAILED"\)/u);
  const adoption = main.slice(
    main.indexOf("function adoptStageWindow"),
    main.indexOf("function openAllowedExternal"),
  );
  assert.match(adoption, /isExactLiveStageUrl/u);
  assert.match(adoption, /target\.origin !== allowedOrigin/u);
  assert.doesNotMatch(adoption, /isAllowedLiveNavigation\(targetUrl/u);
});

test("every Live state IPC checks the exact local renderer origin", () => {
  const main = read("electron/main.js");
  for (const channel of [
    "live-workspace:get-enabled",
    "live-call:start",
    "host-session:get",
    "host-session:open-login",
    "host-session:logout",
    "live-call:get-state",
    "live-call:go-live",
    "live-call:host-speak",
    "live-call:audio-failed",
    "live-call:end",
  ]) {
    const start = main.indexOf(`ipcMain.handle("${channel}"`);
    const end = main.indexOf("\n  ipcMain.handle(", start + 1);
    const handler = main.slice(start, end === -1 ? undefined : end);
    assert.notEqual(start, -1, `missing ${channel}`);
    assert.match(handler, /isAllowedOrigin\(event\.sender\.getURL\(\), new Set\(\[localAppOrigin\]\)\)/u);
  }
});

test("Host End clears the armed session and Stage only after a terminal optimistic result", () => {
  const main = read("electron/main.js");
  const start = main.indexOf('ipcMain.handle("live-call:end"');
  const end = main.indexOf('ipcMain.handle("subtitle-overlay:get-enabled"', start);
  const handler = main.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(handler, /method: "DELETE"/u);
  assert.match(handler, /body: \{ version: endingSession\.version \}/u);
  assert.match(handler, /reconcileLiveCallEnd\(endingSession, ended\)/u);
  assert.ok(handler.indexOf("if (!reconciliation.terminal)") < handler.indexOf("liveCallSession = null"));
  assert.match(handler, /stageWindow\.destroy\(\)/u);
  assert.match(handler, /liveCallSession = null/u);

  const preload = read("electron/preload.js");
  assert.match(preload, /endLiveCall: \(\) => ipcRenderer\.invoke\("live-call:end"\)/u);
});

test("ambiguous Host End reconciles terminal state without stopping an authoritatively live session", async () => {
  const main = read("electron/main.js");
  const helperStart = main.indexOf("async function reconcileLiveCallEnd");
  const helperEnd = main.indexOf("function validateLiveCoverSignedUpload", helperStart);
  assert.notEqual(helperStart, -1);
  assert.ok(helperEnd > helperStart);

  const responses = [];
  const context = {
    encodeURIComponent,
    liveCallApi: async () => responses.shift(),
  };
  const reconcile = vm.runInNewContext(
    `${main.slice(helperStart, helperEnd)}; reconcileLiveCallEnd`,
    context,
  );
  const session = { baseUrl: "https://workspace.example.com/", sessionId: "session-1", status: "ending", version: 7 };

  responses.push({ ok: true, data: { id: "session-1", status: "stopped", version: 8 } });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await reconcile(session, { ok: false, code: "NETWORK_UNAVAILABLE" }))),
    { terminal: true, status: "stopped" },
  );

  responses.push({ ok: true, data: { id: "session-1", status: "live", version: 9 } });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await reconcile(session, { ok: true, data: null }))),
    { terminal: false, result: { ok: false, code: "INVALID_END_RESPONSE" }, status: "live" },
  );
  assert.equal(session.version, 9);

  responses.push({ ok: true, data: { id: "different-session", status: "stopped" } });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await reconcile(session, { ok: false, code: "HTTP_502" }))),
    { terminal: false, result: { ok: false, code: "HTTP_502" }, status: null },
  );

  const handlerStart = main.indexOf('ipcMain.handle("live-call:end"');
  const handlerEnd = main.indexOf('ipcMain.handle("subtitle-overlay:list-displays"', handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);
  assert.ok(handler.indexOf('endingSession.status = "ending"') < handler.indexOf("clearLiveBridgeReconnect()"));
  assert.ok(handler.indexOf("clearLiveBridgeReconnect()") < handler.indexOf('method: "DELETE"'));
  assert.match(handler, /if \(!reconciliation\.terminal\)[\s\S]*endingSession\.status = reconciliation\.status \?\? previousStatus/u);
  assert.match(handler, /endingSession\.status === "live" && !liveGatewayBridge[\s\S]*scheduleLiveGatewayReconnect\(endingSession\)/u);
  assert.ok(
    handler.indexOf("if (liveCallSession !== endingSession)") < handler.indexOf("liveCallSession = null"),
    "a replacement session must never be disarmed by stale reconciliation",
  );
});

test("cover upload validates 20 MiB locally and bypasses Vercel with a signed Supabase PUT", () => {
  const main = read("electron/main.js");
  assert.match(main, /MAX_LIVE_COVER_BYTES = 20 \* 1024 \* 1024/u);
  assert.match(main, /image\/jpeg/u);
  assert.match(main, /image\/png/u);
  assert.match(main, /image\/webp/u);
  assert.match(main, /function validateLiveCoverImage/u);
  assert.match(main, /function matchesLiveCoverMagicBytes/u);
  assert.match(main, /function validateLiveCoverSignedUpload/u);
  assert.match(main, /protocol !== "https:"/u);
  assert.match(main, /\\\.supabase\\\.co/u);
  assert.match(main, /method: "PUT"/u);
  assert.match(main, /credentials: "omit"/u);
  assert.match(main, /action: "prepare"/u);
  assert.match(main, /action: "finalize"/u);
  assert.doesNotMatch(main, /async function liveCallRawApi/u);
  assert.doesNotMatch(main, /JSON\.stringify\(bytes\)/u);
});

test("controller Host Speak reuses the running bridge before opening a fallback connection", () => {
  const main = read("electron/main.js");
  assert.match(main, /ipcMain\.handle\("live-call:host-speak"/u);
  assert.match(main, /function hostSpeakViaGateway/u);
  assert.match(main, /function hostSpeakViaActiveBridge/u);
  assert.match(main, /const activeBridgeResult = await hostSpeakViaActiveBridge\(\)/u);
  assert.match(main, /if \(activeBridgeResult\) return activeBridgeResult/u);
  assert.match(main, /"host-speak-started"/u);
  assert.match(main, /\/api\/live-config/u);
  // Arms via the workspace even without captions running: the controller is
  // summoned when the stage opens so Go-Live/Host Speak are reachable.
  assert.match(main, /function showControllerWindow/u);
  assert.match(main, /showControllerWindow\(\);/u);

  const preload = read("electron/preload.js");
  assert.match(preload, /hostSpeak: \(\) => ipcRenderer\.invoke\("live-call:host-speak"\)/u);

  const controllerHtml = read("public/subtitle-controller.html");
  assert.match(controllerHtml, /id="controller-host-speak"/u);
  const controllerJs = read("public/subtitle-controller.js");
  assert.match(controllerJs, /hostSpeak\(\)/u);
  assert.match(controllerJs, /hostSpeakButton\.hidden = !state\.live/u);
});

test("gateway floor changes clear every Electron caption surface before the next speaker", () => {
  const main = read("electron/main.js");
  const preload = read("electron/preload.js");
  const dashboard = read("public/subtitle-dashboard.js");

  assert.match(main, /message\.type === "floor"/u);
  assert.match(main, /function shouldBlockLiveHostAudioForFloor/u);
  assert.match(main, /floorKnown: false/u);
  assert.match(main, /isHostAudioBlocked: true/u);
  assert.match(main, /const shouldBlockHostAudio = shouldBlockLiveHostAudioForFloor/u);
  assert.match(main, /liveBridgeAudioAdapters\.clear\(\);\s*\}\s*bridge\.isHostAudioBlocked = shouldBlockHostAudio/u);
  assert.match(main, /webContents\.send\("live-call:floor", message\)/u);
  assert.match(preload, /onLiveCallFloor/u);
  assert.match(preload, /ipcRenderer\.on\("live-call:floor", handler\)/u);
  assert.match(preload, /removeListener\("live-call:floor", handler\)/u);
  // The renderer tracks the floor to decide which captions are VISIBLE, not to
  // gate audio: the local engine keeps producing through a participant turn and
  // main alone decides whether host PCM reaches the gateway.
  assert.match(dashboard, /let isLiveParticipantFloorActive = false/u);
  assert.match(dashboard, /function applyLiveCallFloorGate/u);
  assert.match(dashboard, /onLiveCallFloor\?\.\(applyLiveCallFloorGate\)/u);
  assert.match(dashboard, /isLiveParticipantFloorActive = Boolean\(activeLiveParticipantId\)/u);
});

test("Live state exposes only the exact bounded floor snapshot needed after renderer recovery", () => {
  const main = read("electron/main.js");
  const helperStart = main.indexOf("function sanitizeLiveCallFloorSnapshot");
  const helperEnd = main.indexOf("function shouldBlockLiveHostAudioForFloor", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const sanitize = vm.runInNewContext(
    `${main.slice(helperStart, helperEnd)}; sanitizeLiveCallFloorSnapshot`,
  );
  const sessionId = "session-1";

  assert.deepEqual(
    JSON.parse(JSON.stringify(sanitize({
      type: "floor",
      sessionId,
      floorRevision: 7,
      holder: {
        participantId: "participant-1",
        name: "Private Name",
        department: "Private Department",
      },
      transcript: "must not cross IPC",
      token: "must-not-cross-ipc",
    }, sessionId))),
    { type: "floor", sessionId, floorRevision: 7, holder: { participantId: "participant-1" } },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(sanitize({ type: "floor", sessionId, floorRevision: 8, holder: null }, sessionId))),
    { type: "floor", sessionId, floorRevision: 8, holder: null },
  );
  for (const payload of [
    null,
    { type: "floor", sessionId: "stale-session", holder: null },
    { type: "floor", sessionId, holder: null },
    { type: "floor", sessionId, floorRevision: -1, holder: null },
    { type: "floor", sessionId, holder: {} },
    { type: "floor", sessionId, holder: { participantId: "" } },
    { type: "floor", sessionId, holder: { participantId: "p".repeat(129) } },
  ]) {
    assert.equal(sanitize(payload, sessionId), null);
  }

  const getState = main.slice(
    main.indexOf('ipcMain.handle("live-call:get-state"'),
    main.indexOf('ipcMain.handle("live-call:host-speak"'),
  );
  assert.match(getState, /floorSnapshot:[\s\S]{0,200}liveGatewayBridge\?\.ready === true/u);
  assert.match(getState, /floorSnapshot:[\s\S]{0,300}liveGatewayBridge\.floorKnown === true/u);
  assert.match(getState, /floorSnapshot:[\s\S]{0,400}sanitizeLiveCallFloorSnapshot\(/u);
  assert.match(getState, /liveGatewayBridge\.lastFloorMessage/u);
  assert.match(getState, /liveCallSession\.sessionId/u);
});

test("authenticated gateway floor reaches the in-process server before any renderer relay", () => {
  const main = read("electron/main.js");
  const floorBranch = main.slice(
    main.indexOf('message.type === "floor"'),
    main.indexOf('message.type === "error"', main.indexOf('message.type === "floor"')),
  );
  const sanitizeFloor = floorBranch.indexOf("sanitizeLiveCallFloorSnapshot(message, armedSession.sessionId)");
  const applyFloor = floorBranch.indexOf("applyAuthoritativeLiveCallFloorSnapshot(floorSnapshot)");
  const relayFloor = floorBranch.lastIndexOf("relayLiveCallFloorToRenderers(floorSnapshot)");
  assert.ok(sanitizeFloor >= 0 && sanitizeFloor < applyFloor);
  assert.ok(applyFloor < relayFloor, "server authority must change before renderer notification");
  assert.match(floorBranch, /applyAuthoritativeLiveCallFloorSnapshot\(null\)[\s\S]{0,500}relayLiveCallFloorToRenderers\(bridge\.lastFloorMessage\)/u);
  assert.match(floorBranch, /expectedAuthorityMode = floorSnapshot\.holder === null \? "host" : "participant"/u);
  assert.match(floorBranch, /authorityResult\?\.ok !== true[\s\S]{0,500}bridge\.isHostAudioBlocked = true/u);
  assert.match(floorBranch, /authorityResult\.liveSessionId !== armedSession\.sessionId/u);
  assert.match(floorBranch, /authorityResult\.floorRevision !== floorSnapshot\.floorRevision/u);
  assert.match(floorBranch, /authorityResult\.mode !== expectedAuthorityMode/u);
  assert.match(floorBranch, /authorityResult\?\.holder\?\.participantId === floorSnapshot\.holder\.participantId/u);
  const authorityHelper = main.slice(
    main.indexOf("function applyAuthoritativeLiveCallFloorSnapshot"),
    main.indexOf("function liveBridgeStatus"),
  );
  assert.match(authorityHelper, /typeof server === "undefined"/u);
  assert.match(authorityHelper, /server\.applyLiveCallFloorSnapshot\(snapshot\)/u);
  assert.match(authorityHelper, /return \{ ok: false, mode: "blocked", liveSessionId: "", holder: null \}/u);

  const stopBridge = main.slice(
    main.indexOf("async function stopLiveGatewayBridge"),
    main.indexOf("async function ensureLiveGatewayBridge", main.indexOf("async function stopLiveGatewayBridge")),
  );
  assert.ok(
    stopBridge.indexOf("applyAuthoritativeLiveCallFloorSnapshot(null)") < stopBridge.indexOf("if (!bridge) return"),
    "teardown must block local authority even when the gateway bridge is already absent",
  );
  assert.ok(
    stopBridge.indexOf("liveBridgeAudioAdapters.clear()") >= 0
      && stopBridge.indexOf("liveBridgeAudioAdapters.clear()") < stopBridge.indexOf("bridge.socket.close"),
    "explicit stop must discard resampler tails before closing the socket",
  );

  const socketClose = main.slice(
    main.indexOf('socket.on("close"'),
    main.indexOf("const readinessTimer", main.indexOf('socket.on("close"')),
  );
  assert.match(socketClose, /bridge\.isHostAudioBlocked = true[\s\S]*liveGatewayBridge = null/u,
    "socket loss must close gateway audio before reconnect begins");

  const sessionEnded = main.slice(
    main.indexOf('currentStatus === "stopped"'),
    main.indexOf('if (liveCallSession !== armedSession', main.indexOf('currentStatus === "stopped"')),
  );
  assert.ok(
    sessionEnded.indexOf("applyAuthoritativeLiveCallFloorSnapshot(null)")
      < sessionEnded.indexOf("relayLiveCallFloorToRenderers"),
    "remote termination must block local output before the terminal renderer event",
  );

  const endHandler = main.slice(
    main.indexOf('ipcMain.handle("live-call:end"'),
    main.indexOf('ipcMain.handle("subtitle-overlay:get-enabled"'),
  );
  assert.ok(
    endHandler.indexOf("applyAuthoritativeLiveCallFloorSnapshot(null)")
      < endHandler.indexOf("relayLiveCallFloorToRenderers"),
    "operator End must block local output before the terminal renderer event",
  );
});

test("participant floor blocks Gateway host PCM before adaptation without stopping local captions", () => {
  const main = read("electron/main.js");
  const dashboard = read("public/subtitle-dashboard.js");
  const audioHandler = main.slice(
    main.indexOf('ipcMain.on("live-call:audio-frame"'),
    main.indexOf('ipcMain.handle("live-call:end"'),
  );
  assert.match(main, /ipcMain\.on\("live-call:audio-frame"/u);
  assert.ok(audioHandler.indexOf("if (!bridge.floorKnown || bridge.isHostAudioBlocked) return")
    < audioHandler.indexOf("adaptCaptionPcmForGateway"));
  assert.match(main, /message\.holder !== null/u);
  assert.match(main, /message\.sessionId !== sessionId/u);

  const bridgeCapture = dashboard.slice(
    dashboard.indexOf("async function startLiveCallMicCapture"),
    dashboard.indexOf("function requestLocalSubtitlePreflight"),
  );
  const floorGate = dashboard.slice(
    dashboard.indexOf("function applyLiveCallFloorGate"),
    dashboard.indexOf("function stopLiveCallAudioBridge"),
  );
  // The renderer keeps capturing through a participant turn; main is the sole
  // authority on whether those packets reach the gateway.
  assert.match(bridgeCapture, /forwardLiveCallHostAudioPacket/u);
  assert.doesNotMatch(floorGate, /startLocalLiveCallFallback|restoreGatewayCaptionProducer|subtitle:audio/u);
  assert.doesNotMatch(dashboard, /async function startLocalLiveCallFallback|async function restoreGatewayCaptionProducer/u);
  assert.match(dashboard, /stopLiveCallAudioBridge\("live call ended"\)[\s\S]{0,300}isLiveParticipantFloorActive = false/u);
});

test("Main sends bounded host PCM to Gateway and never relays local caption text", () => {
  const main = read("electron/main.js");
  const preload = read("electron/preload.js");
  const handler = main.slice(
    main.indexOf('ipcMain.on("live-call:audio-frame"'),
    main.indexOf('ipcMain.handle("live-call:end"'),
  );

  assert.match(preload, /sendLiveCallAudioFrame: \(packet\) => ipcRenderer\.send\("live-call:audio-frame", packet\)/u);
  assert.match(handler, /packet\?\.source === "system" \|\| packet\?\.source === "mic"/u);
  assert.match(handler, /packet\.sampleRate !== 24_000/u);
  assert.match(handler, /packet\.frameDurationMs !== 100/u);
  assert.match(handler, /bytes\.length !== CAPTION_BRIDGE_PACKET_BYTES/u);
  assert.match(handler, /bridge\.socket\.bufferedAmount > LIVE_BRIDGE_SOCKET_BUFFER_LIMIT/u);
  assert.match(handler, /adaptCaptionPcmForGateway/u);
  assert.match(handler, /encodeLiveAudioWireFrame\(packet\.source, pcmFrame\)/u);
  assert.match(main, /const liveBridgeAudioAdapters = new Map\(\)/u);
  assert.match(main, /createCaptionPcmResampler\(\)/u);
  assert.doesNotMatch(main, /onLiveCallLocalCaption|relayLiveCallHostCaption|type: "host-caption"|host-caption-accepted|host-caption-rejected/u);
});

test("Gateway disconnect clears only Gateway audio authority and leaves local Caption Only running", () => {
  const main = read("electron/main.js");
  const closeHandler = main.slice(
    main.indexOf('socket.on("close"'),
    main.indexOf("const readinessTimer", main.indexOf('socket.on("close"')),
  );
  assert.match(closeHandler, /bridge\.isHostAudioBlocked = true/u);
  assert.match(closeHandler, /bridge\.floorKnown = false/u);
  assert.match(closeHandler, /liveBridgeAudioAdapters\.clear\(\)/u);
  assert.doesNotMatch(closeHandler, /applyAuthoritativeLiveCallFloorSnapshot\(null\)|relayLiveCallFloorToRenderers|live-call:audio-failed|HOST_AUDIO_CAPTURE_FAILED/u);
});

test("Live Call archive refreshes canonical remote data before any same-owner cached read", () => {
  const main = read("electron/main.js");
  const archive = main.slice(main.indexOf("async function archiveLiveCallSession"), main.indexOf("function showDashboardWindow"));
  const remoteRefresh = archive.indexOf("await liveCallArchive.refresh(");
  const cachedRead = archive.indexOf("cached?.ok === true");
  assert.ok(remoteRefresh >= 0 && cachedRead > remoteRefresh,
    "an existing local record cannot bypass a fresh canonical remote read");
  assert.match(archive, /cached\.data\.meta\.ownerHostId === auth\.data\.userId/u);
  assert.doesNotMatch(archive, /sourceText: utterance\.text|summarizeSession|attempt < 3/u);
  const coordinator = read("src/live-call-archive.js");
  assert.match(coordinator, /const sourceText = text\(item\.effectiveText/u);
  assert.match(coordinator, /sourceText: "", sourceLanguage: "", translatedText:/u);
});

test("controller can be moved by pointer drag and recovered from the application menu", () => {
  const main = read("electron/main.js");
  assert.match(main, /ipcMain\.on\("subtitle-controller:move-by"/u);
  assert.match(main, /function installApplicationMenu/u);
  // The label is translated; the menu references the key, the copy lives in the
  // shared dictionary (both languages are covered by test/ui-i18n.test.js).
  assert.match(main, /translate\("menu\.showCaptionController"\)/u);
  assert.match(MESSAGES.en["menu.showCaptionController"], /Show Caption Controller/u);
  assert.match(main, /Menu\.setApplicationMenu/u);

  const preload = read("electron/preload.js");
  assert.match(preload, /moveControllerBy: \(deltaX, deltaY\) => ipcRenderer\.send\("subtitle-controller:move-by", deltaX, deltaY\)/u);

  const controllerJs = read("public/subtitle-controller.js");
  assert.match(controllerJs, /moveControllerBy\(deltaX, deltaY\)/u);
  assert.match(controllerJs, /setPointerCapture/u);
  const css = read("public/subtitle.css");
  assert.match(css, /\.controller-drag \{[^}]*-webkit-app-region: no-drag/su);
});

function mountGoLiveController() {
  const controller = read("public/subtitle-controller.js");
  const declarations = controller.slice(controller.indexOf("  let isEndingLiveCall = false;"), controller.indexOf('  // Elapsed "now playing" timer'));
  const sync = controller.slice(controller.indexOf("  const syncLiveCall = async () => {"), controller.indexOf('  hostSpeakButton?.addEventListener("click"'));
  const listener = controller.slice(controller.indexOf('  goLiveButton.addEventListener("click", async () => {'), controller.indexOf('  endLiveCallButton.addEventListener("click", async () => {'));
  assert.ok(declarations && sync && listener);
  /** @type {Map<string, () => Promise<void>>} */
  const handlers = new Map();
  /** @type {Map<string, string>} */
  const attributes = new Map();
  const button = {
    disabled: false, dataset: {}, textContent: "", classList: { toggle() {} },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(name, callback) { handlers.set(name, callback); },
  };
  const liveState = { armed: true, live: false, mediaWaiting: false, scheduledAt: "2099-01-01T00:00:00Z" };
  /** @type {Array<{resolve: (value: {ok: boolean, code?: string}) => void, reject: (error: Error) => void}>} */
  const pending = [];
  /** @type {string[]} */
  const statuses = [];
  let requests = 0;
  const offlineStop = { hidden: false };
  const webOutputStatus = { textContent: "" };
  const context = {
    document: { getElementById(id) {
      if (id === "controller-stop") return offlineStop;
      if (id === "controller-web-output-status") return webOutputStatus;
      throw new Error(`Unexpected controller node: ${id}`);
    } },
    isLiveActionStatusLocked: false, goLiveButton: button,
    liveCallGroup: { hidden: false }, hostSpeakButton: { hidden: true }, endLiveCallButton: { disabled: false },
    translationHealth: {}, setLiveElapsed() {}, stopLiveElapsed() {}, syncLiveBridgeStatus() {},
    setControllerStatus(key) { statuses.push(key); }, setControllerText(text) { statuses.push(text); },
    t: (key) => key,
    window: { realtimeNoelDesktop: {
      getLiveCallState: async () => liveState,
      goLiveCall: () => { requests += 1; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    } },
  };
  const api = vm.runInNewContext(`${declarations}\n${sync}\n${listener}\n({ syncLiveCall });`, context);
  const click = handlers.get("click");
  assert.ok(click);
  return { click, poll: api.syncLiveCall, button, attributes, liveState, statuses, offlineStop, webOutputStatus,
    requests: () => requests,
    resolve: (result) => { const request = pending.shift(); assert.ok(request); request.resolve(result); },
    reject: () => { const request = pending.shift(); assert.ok(request); request.reject(new Error("mock IPC unavailable")); },
  };
}

test("Go Live remains single flight through polling and double clicks before a future scheduled time", async () => {
  const h = mountGoLiveController();
  const first = h.click();
  assert.equal(h.requests(), 1, "a future schedule does not delay the manual request");
  assert.equal(h.button.disabled, true);
  assert.equal(h.attributes.get("aria-busy"), "true");
  await h.poll();
  assert.equal(h.button.disabled, true, "a preparing status poll must not unlock a pending action");
  assert.equal(h.offlineStop.hidden, true, "the offline stop action is hidden while a Live Call is armed");
  assert.equal(h.webOutputStatus.textContent, "준비 중");
  await h.click();
  assert.equal(h.requests(), 1, "a repeated callback must not dispatch another IPC request");
  h.liveState.live = true;
  h.resolve({ ok: true });
  await first;
  await h.poll();
  assert.equal(h.button.disabled, true, "the authoritative live state keeps Go Live disabled");
  assert.equal(h.webOutputStatus.textContent, "진행 중");
  assert.equal(h.attributes.has("aria-busy"), false);
  assert.ok(h.statuses.includes("controller.liveStarted"));
  h.liveState.live = false;
  await h.poll();
  assert.equal(h.button.disabled, false);
  const next = h.click();
  assert.equal(h.requests(), 2, "success releases the lock for a subsequent prepared call");
  h.resolve({ ok: true });
  await next;
});

test("Go Live false responses and rejected IPC calls release the lock for explicit retry only", async () => {
  for (const failure of ["response", "rejection"]) {
    const h = mountGoLiveController();
    const first = h.click();
    await h.poll();
    assert.equal(h.button.disabled, true);
    if (failure === "response") h.resolve({ ok: false, code: "LIVE_READINESS_NOT_CONFIRMED" });
    else h.reject();
    await first;
    await h.poll();
    assert.equal(h.requests(), 1, "failure and polling never retry Go Live automatically");
    assert.equal(h.button.disabled, false);
    assert.equal(h.attributes.has("aria-busy"), false);
    assert.ok(h.statuses.includes(failure === "response" ? "controller.goLiveFailedCode" : "controller.goLiveFailed"));
    const retry = h.click();
    assert.equal(h.requests(), 2);
    await h.poll();
    assert.equal(h.button.disabled, true);
    h.liveState.live = true;
    h.resolve({ ok: true });
    await retry;
    await h.poll();
    assert.equal(h.button.disabled, true);
    assert.equal(h.attributes.has("aria-busy"), false);
  }
});

test("desktop go-live refreshes the version and streams host PCM to the gateway", () => {
  const main = read("electron/main.js");
  // Stale invite-time versions must never silently kill Go-Live.
  const goLive = main.slice(
    main.indexOf('ipcMain.handle("live-call:go-live"'),
    main.indexOf('ipcMain.handle("live-call:end"'),
  );
  assert.match(goLive, /method: "GET"/u);
  assert.match(goLive, /preflightLiveCallCaptionSession\(settingsStore, armedSession\)/u,
    "local settings and renderer readiness must pass before the paid remote session starts");
  assert.match(goLive, /requestRendererLiveCaptionPreflight\(armedSession\)/u,
    "the dashboard must prove audio capture and local relay readiness before the paid remote session starts");
  assert.ok(
    goLive.indexOf("requestRendererLiveCaptionPreflight(armedSession)") < goLive.indexOf("preflightLiveCallCaptionSession(settingsStore, armedSession)"),
    "renderer preflight must persist the current form before main reloads caption settings",
  );
  assert.doesNotMatch(goLive, /\/api\/live-sessions\/\$\{encodeURIComponent\(armedSession\.sessionId\)\}\/start/u,
    "desktop must not transition the database live before gateway readiness");
  assert.doesNotMatch(goLive, /scheduledAt/u,
    "the host's Go-Live is immediate: the scheduled time is display-only and must never gate the start");
  assert.match(goLive, /armedSession\.activationKey \?\?= randomUUID\(\)/u);
  assert.match(goLive, /armedSession\.activationVersion \?\?= armedSession\.version/u);
  assert.match(goLive, /await startPreparedLiveGatewayWithRetry\(armedSession\)/u);
  assert.ok(
    goLive.indexOf("requestRendererLiveCaptionPreflight(armedSession)")
      < goLive.indexOf("startPreparedLiveGatewayWithRetry(armedSession)"),
    "renderer preflight must precede the paid gateway pipeline",
  );
  assert.match(goLive, /armedSession\.version = current\.data\.version/u);
  // Cloud Run rejects renderer WebSockets by Origin, so Main owns the trusted
  // Gateway socket. Caption Only remains local while bounded PCM independently
  // supplies the Gateway's host/web record.
  assert.match(main, /ipcMain\.handle\("live-call:bridge-ensure"/u);
  assert.match(main, /ipcMain\.on\("live-call:audio-frame"/u);
  assert.doesNotMatch(main, /onLiveCallLocalCaption|type: "host-caption"/u);
  assert.match(main, /"x-realtime-noel-client": "desktop-main"/u);
  assert.match(main, /function ensureLiveGatewayBridge/u);
  assert.match(main, /await stopLiveGatewayBridge\("live call ended", \{ terminateRemote: true \}\)/u);
  assert.match(main, /gatewaySettings: \{/u);
  assert.match(main, /inputSource: "mic"/u);
  assert.match(main, /displayLanguage: sanitizeLiveCaptionDisplayLanguage\(config\.displayLanguage\)/u);
  assert.match(main, /shouldDisplayLiveCaption\(message, armedSession\.displayLanguage, "gateway"\)/u);
  assert.match(main, /body: toLiveCallApiInput\(input\)/u);
  assert.match(main, /start-registered", async \(event, sessionId, options\)/u);
  // The webapp /start route, the gateway host lease, and this intent all have
  // no scheduled-time gate — a registered future session starts the moment the
  // host asks. Keep the start intent free of any scheduledAt comparison.
  const startIntent = main.slice(
    main.indexOf("async function requestDesktopLiveStartIntent"),
    main.indexOf("async function startDesktopLiveDemand"),
  );
  assert.ok(startIntent.length > 0, "requestDesktopLiveStartIntent must exist ahead of startDesktopLiveDemand");
  assert.doesNotMatch(startIntent, /scheduledAt/u,
    "the desktop start intent must POST /start immediately, never waiting on the scheduled time");
  // Host Speak's short-lived control socket must use the same trusted headers.
  assert.match(main, /new WebSocket\(gateway\.socketUrl, \{ headers: trustedGatewayHeaders\(token\) \}\)/u);

  const preload = read("electron/preload.js");
  assert.match(preload, /ensureLiveCallBridge: \(\) => ipcRenderer\.invoke\("live-call:bridge-ensure"\)/u);
  assert.match(preload, /reconnectLiveCallTranslation: \(\) => ipcRenderer\.invoke\("live-call:translation-reconnect"\)/u);
  assert.match(preload, /onLiveCallPreflight/u);
  assert.match(preload, /completeLiveCallPreflight/u);
  assert.match(preload, /onLiveCallPreflightCancel/u);
  assert.match(preload, /sendLiveCallAudioFrame: \(packet\) => ipcRenderer\.send\("live-call:audio-frame", packet\)/u);

  // Dual path from ONE capture: the dashboard uses the exact Caption-only
  // capture contract and fans the same packets to both halves — `subtitle:audio`
  // to the local server (screen captions) and `sendLiveCallAudioFrame` to main
  // (gateway → web app captions and records). Resampling to the gateway's
  // 16 kHz / 40 ms frames belongs to main, not the renderer.
  const dashboard = read("public/subtitle-dashboard.js");
  assert.match(dashboard, /captureSelectedAudio\(state\.settings\)/u);
  assert.match(dashboard, /type: "subtitle:audio"/u);
  assert.match(dashboard, /sendLiveCallAudioFrame/u);
  assert.doesNotMatch(dashboard, /LIVE_BRIDGE_SAMPLE_RATE|resampleLinear/u);
  assert.match(dashboard, /stopLiveCallAudioBridge\("live call ended"\)/u);
  assert.match(dashboard, /syncLiveCallAudioBridge/u);

  // Go-Live failures surface on the controller instead of failing silently.
  const controllerJs = read("public/subtitle-controller.js");
  assert.match(controllerJs, /t\("controller\.goLiveFailedCode", \{ code: result\?\.code \?\? "unknown" \}\)/u);
  assert.match(MESSAGES.en["controller.goLiveFailedCode"], /Go-Live failed \(\{code\}\)/u);
  assert.equal(typeof MESSAGES.ko["controller.goLiveFailedCode"], "string");
});

test("desktop readiness is bounded and becomes live only after gateway ACK plus authoritative read", () => {
  const main = read("electron/main.js");
  assert.match(main, /const LIVE_GATEWAY_START_RETRY_DELAYS_MS = Object\.freeze\(\[[\s\S]*0,[\s\S]*2_000,[\s\S]*5_000,[\s\S]*10_000,[\s\S]*LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS,[\s\S]*\]\)/u);
  assert.match(main, /const LIVE_GATEWAY_START_DEADLINE_MS = 30_000/u);
  const initialStart = main.slice(
    main.indexOf("async function startPreparedLiveGatewayWithRetry"),
    main.indexOf("async function restartLiveTranslationBridge"),
  );
  assert.match(initialStart, /armedSession\.status !== "preparing"/u);
  assert.match(initialStart, /Date\.now\(\) - startedAt >= LIVE_GATEWAY_START_DEADLINE_MS/u);
  assert.match(initialStart, /await ensurePreparedLiveGatewayBridge\(deadlineAt\)/u);
  assert.match(initialStart, /stopLiveGatewayBridge\("initial gateway attempt failed"/u);
  const connectionFetch = main.slice(
    main.indexOf("function remainingLiveGatewayStartBudget"),
    main.indexOf("function trustedGatewayHeaders"),
  );
  assert.match(connectionFetch, /deadlineAt - Date\.now\(\)/u);
  assert.match(connectionFetch, /timeoutMilliseconds/u,
    "workspace token and config reads must share the same 30-second start deadline");

  const bridgeStart = main.slice(
    main.indexOf("async function ensureLiveGatewayBridgeOnce"),
    main.indexOf("async function restartLiveTranslationBridge"),
  );
  assert.match(bridgeStart, /activationKey: armedSession\.activationKey/u);
  assert.match(bridgeStart, /version: isManualRestart \? armedSession\.version : armedSession\.activationVersion/u);
  assert.match(bridgeStart, /hasReadinessActivation \? \{ activationKey: armedSession\.activationKey \} : \{\}/u);
  assert.match(bridgeStart, /hasReadinessActivation = !isManualRestart \|\| currentStatus === "preparing"/u);
  assert.match(bridgeStart, /await confirmLiveGatewayStarted\(bridge, message\)/u);
  assert.match(bridgeStart, /currentSession\.data\?\.status !== "live"|currentSession\.data\?\.status/u);
  const readinessConfirmation = main.slice(
    main.indexOf("async function confirmLiveGatewayStarted"),
    main.indexOf("async function ensureLiveGatewayBridgeOnce"),
  );
  assert.match(readinessConfirmation, /currentSession\.data\?\.status !== "live"/u);
  assert.ok(
    bridgeStart.indexOf("await confirmLiveGatewayStarted(bridge, message)") >= 0,
    "started ACK must be checked against the authoritative session before desktop presents live",
  );
  assert.ok(
    readinessConfirmation.indexOf("bridge.ready = true")
      < readinessConfirmation.indexOf('armedSession.status = "live"'),
    "the bridge must be ready before the armed session becomes live",
  );
  const stateProjection = main.slice(
    main.indexOf('ipcMain.handle("live-call:get-state"'),
    main.indexOf('ipcMain.handle("live-call:host-speak"'),
  );
  assert.doesNotMatch(stateProjection, /activationKey|activationVersion/u);
  assert.doesNotMatch(main, /console\.(?:info|warn|error|log)\([^\n]*activationKey/u);
});

test("desktop readiness confirmation fails closed for early or mismatched gateway ACKs", async () => {
  const main = read("electron/main.js");
  const source = main.slice(
    main.indexOf("async function confirmLiveGatewayStarted"),
    main.indexOf("async function ensureLiveGatewayBridgeOnce"),
  );
  const armedSession = {
    sessionId: "session-1",
    baseUrl: "https://workspace.example/",
    status: "preparing",
    version: 7,
  };
  const bridge = { session: armedSession, ready: false, expiresAt: "2026-08-16T01:00:00.000Z" };
  const context = {
    liveGatewayBridge: bridge,
    liveCallSession: armedSession,
    isQuitting: false,
    encodeURIComponent,
    Number,
    Date,
    liveBridgeReconnectAttempts: 3,
    clearLiveBridgeAlert() {},
    scheduleLiveGatewayCredentialRefresh() {},
    console: { info() {} },
    liveCallApi: async () => ({
      ok: true,
      data: { id: "session-1", status: "preparing", version: 7 },
    }),
  };
  const confirm = vm.runInNewContext(`${source}; confirmLiveGatewayStarted`, context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(await confirm(bridge, { type: "started", sessionId: "session-1", version: 8 }))),
    { ok: false, code: "LIVE_READINESS_NOT_CONFIRMED" },
  );
  assert.equal(bridge.ready, false);
  assert.equal(armedSession.status, "preparing");

  context.liveCallApi = async () => ({
    ok: true,
    data: { id: "session-1", status: "live", version: 9 },
  });
  assert.equal((await confirm(bridge, { type: "started", sessionId: "session-1", version: 8 })).ok, false);
  assert.equal(bridge.ready, false);
  assert.equal(armedSession.status, "preparing");

  context.liveCallApi = async () => ({
    ok: true,
    data: {
      id: "session-1",
      status: "live",
      version: 8,
      startedAt: "2026-08-16T00:00:00.000Z",
    },
  });
  assert.equal((await confirm(bridge, { type: "started", sessionId: "session-1", version: 8 })).ok, true);
  assert.equal(bridge.ready, true);
  assert.equal(armedSession.status, "live");
  assert.equal(armedSession.version, 8);
  assert.equal(armedSession.liveStartedAt, "2026-08-16T00:00:00.000Z");
});

test("the first live gateway socket gets one same-origin HTTPS health warmup without exposing connection data", async () => {
  const main = read("electron/main.js");
  const warmupStart = main.indexOf("function resolveLiveGatewayEndpoints");
  const warmupEnd = main.indexOf("async function preflightLiveCallCaptionSession", warmupStart);
  assert.notEqual(warmupStart, -1);
  assert.ok(warmupEnd > warmupStart);

  const fetches = [];
  const timeoutDelays = [];
  const timers = [];
  const clearedTimers = [];
  const logs = [];
  const context = {
    AbortController,
    activeSession: { status: "live" },
    clearTimeout(timer) { clearedTimers.push(timer); },
    console: {
      info(value) { logs.push(value); },
      warn(value) { logs.push(value); },
    },
    isQuitting: false,
    net: {
      async fetch(url, options) {
        fetches.push({ url, options });
        if (url.includes("hanging-gateway")) {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        throw new Error("secret-provider-detail");
      },
    },
    URL,
    setTimeout(callback, delay) {
      timeoutDelays.push(delay);
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
  };
  context.liveCallSession = context.activeSession;
  vm.runInNewContext(
    `const LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS = 20_000;\n${main.slice(warmupStart, warmupEnd)}\n`
      + "globalThis.warmLiveGatewayBeforeSocket = warmLiveGatewayBeforeSocket;",
    context,
  );

  await context.warmLiveGatewayBeforeSocket(
    context.activeSession,
    "wss://gateway.example.com:443/live",
  );
  await context.warmLiveGatewayBeforeSocket(
    context.activeSession,
    "wss://gateway.example.com/live",
  );

  assert.equal(fetches.length, 1, "a failed best-effort warmup must not retry for the same live session");
  assert.equal(fetches[0].url, "https://gateway.example.com/health");
  assert.equal(fetches[0].options.method, "GET");
  assert.equal(fetches[0].options.credentials, "omit");
  assert.equal(fetches[0].options.cache, "no-store");
  assert.equal(fetches[0].options.redirect, "manual");
  assert.equal(fetches[0].options.signal instanceof AbortSignal, true);
  assert.deepEqual(timeoutDelays, [20_000]);
  assert.equal(clearedTimers.length, 1);
  assert.deepEqual(logs, []);

  const hangingSession = { status: "live" };
  context.liveCallSession = hangingSession;
  const hangingWarmup = context.warmLiveGatewayBeforeSocket(
    hangingSession,
    "wss://hanging-gateway.example.com/live",
  );
  let duplicateSettled = false;
  const duplicateWarmup = context.warmLiveGatewayBeforeSocket(
    hangingSession,
    "wss://hanging-gateway.example.com/live",
  ).then(() => { duplicateSettled = true; });
  await Promise.resolve();
  assert.equal(fetches.length, 2);
  assert.equal(duplicateSettled, false, "concurrent socket paths must await the same in-flight warmup");
  timers.at(-1).callback();
  await Promise.all([hangingWarmup, duplicateWarmup]);
  assert.equal(fetches[1].options.signal.aborted, true, "the shared boundary must abort physical health work");
  await context.warmLiveGatewayBeforeSocket(hangingSession, "wss://hanging-gateway.example.com/live");
  assert.equal(fetches.length, 2, "a timed-out warmup remains exact-once for the live session");
  assert.equal(clearedTimers.length, 2);

  const stoppedSession = { status: "stopped" };
  context.liveCallSession = stoppedSession;
  await context.warmLiveGatewayBeforeSocket(stoppedSession, "wss://gateway.example.com/live");
  await context.warmLiveGatewayBeforeSocket(stoppedSession, "https://gateway.example.com/live");
  assert.equal(fetches.length, 2, "non-live and non-WSS inputs must never warm the gateway");

  const bridgeStart = main.indexOf("async function ensureLiveGatewayBridgeOnce");
  const bridgeEnd = main.indexOf("async function ensureLiveGatewayBridge()", bridgeStart);
  const bridge = main.slice(bridgeStart, bridgeEnd);
  assert.ok(
    bridge.indexOf("await warmLiveGatewayBeforeSocket(armedSession, connection.gatewayUrl)")
      < bridge.indexOf("new WebSocket(connection.gatewayUrl"),
    "health warmup must settle before the first host WebSocket is opened",
  );
});

test("gateway credentials reject every noncanonical WSS live endpoint before outbound dispatch", async () => {
  const main = read("electron/main.js");
  const boundaryStart = main.indexOf("function resolveLiveGatewayEndpoints");
  const boundaryEnd = main.indexOf("async function preflightLiveCallCaptionSession", boundaryStart);
  assert.notEqual(boundaryStart, -1);
  assert.ok(boundaryEnd > boundaryStart);
  const fetches = [];
  const context = {
    AbortController,
    clearTimeout() {},
    isQuitting: false,
    net: { async fetch(url, options) { fetches.push({ url, options }); return { ok: true }; } },
    setTimeout() { return { unref() {} }; },
    URL,
  };
  vm.runInNewContext(
    `const LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS = 20_000;\n${main.slice(boundaryStart, boundaryEnd)}\n`
      + "globalThis.resolveLiveGatewayEndpoints = resolveLiveGatewayEndpoints;"
      + "globalThis.warmLiveGatewayBeforeSocket = warmLiveGatewayBeforeSocket;",
    context,
  );

  for (const value of [
    "ws://gateway.example.com/live",
    "wss://@gateway.example.com/live",
    "wss://user:password@gateway.example.com/live",
    "wss://gateway.example.com/",
    "wss://gateway.example.com/live/",
    "wss://gateway.example.com/socket",
    "wss://gateway.example.com/live?token=secret",
    "wss://gateway.example.com/live#private",
    "wss://gateway.example.com:8443/live",
    "not-a-url",
  ]) {
    assert.equal(context.resolveLiveGatewayEndpoints(value), null, value);
    const session = { status: "live" };
    context.liveCallSession = session;
    await context.warmLiveGatewayBeforeSocket(session, value);
  }
  assert.equal(fetches.length, 0, "hostile gateway URLs must trigger no health request");
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.resolveLiveGatewayEndpoints("wss://gateway.example.com:443/live"))),
    {
      socketUrl: "wss://gateway.example.com/live",
      healthUrl: "https://gateway.example.com/health",
    },
  );

  const connection = main.slice(
    main.indexOf("async function fetchGatewayConnection"),
    main.indexOf("function trustedGatewayHeaders"),
  );
  assert.match(connection, /resolveLiveGatewayEndpoints\(gatewayUrl\)/u);
  assert.match(connection, /gatewayUrl: gateway\.socketUrl/u);
  const fallback = main.slice(
    main.indexOf("async function hostSpeakViaGateway"),
    main.indexOf("function hostSpeakViaActiveBridge"),
  );
  assert.ok(fallback.indexOf("resolveLiveGatewayEndpoints(gatewayUrl)") < fallback.indexOf("trustedGatewayHeaders(token)"));
  assert.match(fallback, /new WebSocket\(gateway\.socketUrl/u);
  assert.doesNotMatch(fallback, /new WebSocket\(gatewayUrl/u);

  const socketAttempts = [];
  let warmupAttempts = 0;
  const fallbackApi = vm.runInNewContext(
    `${main.slice(boundaryStart, main.indexOf("async function fetchGatewayConnection", boundaryStart))}\n${fallback}; hostSpeakViaGateway`,
    {
      isQuitting: false,
      liveCallSession: { status: "live" },
      trustedGatewayHeaders: () => { throw new Error("credentials must not be constructed"); },
      warmLiveGatewayBeforeSocket: async () => { warmupAttempts += 1; },
      WebSocket: class { constructor(url) { socketAttempts.push(url); } },
      URL,
    },
  );
  const invalidSession = { status: "live" };
  assert.deepEqual(
    JSON.parse(JSON.stringify(await fallbackApi(
      invalidSession,
      "wss://gateway.example.com:8443/live",
      "must-not-dispatch",
    ))),
    { ok: false, code: "GATEWAY_URL_UNAVAILABLE" },
  );
  assert.equal(warmupAttempts, 0);
  assert.deepEqual(socketAttempts, []);
});

test("desktop gateway control sockets share one measurable twenty-second cold-start boundary", () => {
  const main = read("electron/main.js");
  assert.match(main, /const LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS = 20_000/u);
  assert.equal(main.match(/\b20_000\b/gu)?.length, 1, "the cold-start boundary must have one numeric source");

  const fallbackStart = main.indexOf("async function hostSpeakViaGateway");
  const fallbackEnd = main.indexOf("function hostSpeakViaActiveBridge", fallbackStart);
  const fallback = main.slice(fallbackStart, fallbackEnd);
  assert.match(fallback, /setTimeout\([\s\S]*LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS/u);
  assert.doesNotMatch(fallback, /10_000/u);

  const activeStart = fallbackEnd;
  const activeEnd = main.indexOf("async function archiveLiveCallSession", activeStart);
  const active = main.slice(activeStart, activeEnd);
  assert.match(active, /setTimeout\([\s\S]*LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS/u);
  assert.doesNotMatch(active, /3_000/u);

  const translationReconnectStart = main.indexOf("async function restartLiveTranslationBridge");
  const translationReconnectEnd = main.indexOf("function hostSpeakViaGateway", translationReconnectStart);
  assert.match(
    main.slice(translationReconnectStart, translationReconnectEnd),
    /setTimeout\([\s\S]*LIVE_GATEWAY_SOCKET_OPEN_TIMEOUT_MS/u,
  );

  assert.match(fallback, /async function hostSpeakViaGateway\(armedSession, gatewayUrl, token\)/u);
  assert.ok(
    fallback.indexOf("await warmLiveGatewayBeforeSocket(armedSession, gateway.socketUrl)")
      < fallback.indexOf("new WebSocket(gateway.socketUrl"),
    "the fallback control socket must not race ahead of the shared warmup",
  );

  const reconnectStart = main.indexOf("function scheduleLiveGatewayReconnect");
  const reconnectEnd = main.indexOf("async function fetchGatewayConnection", reconnectStart);
  assert.match(
    main.slice(reconnectStart, reconnectEnd),
    /liveCallSession !== armedSession \|\| armedSession\.status !== "live"/u,
  );
});

test("go-live leaves only the controller and overlays on screen; End brings the dashboard back", () => {
  const main = read("electron/main.js");
  const goLive = main.slice(
    main.indexOf('ipcMain.handle("live-call:go-live"'),
    main.indexOf('ipcMain.handle("live-call:bridge-ensure"'),
  );
  // The QR stage closes AND the main dashboard window steps aside — the host
  // keeps only the floating controller + subtitle overlays once live.
  assert.match(goLive, /stageWindow\.destroy\(\)/u);
  assert.match(goLive, /dashboardWindow\.hide\(\)/u);
  // Hiding must not throttle the renderer that runs the mic audio bridge.
  const dashboardCreate = main.slice(
    main.indexOf("async function createDashboardWindow"),
    main.indexOf("function resolveLiveWorkspaceUrl"),
  );
  assert.match(dashboardCreate, /backgroundThrottling: false/u);
  // Ending the call from the controller restores the dashboard (records,
  // summary, settings) — but never during app quit.
  const endHandler = main.slice(
    main.indexOf('ipcMain.handle("live-call:end"'),
    main.indexOf('ipcMain.handle("subtitle-overlay:get-enabled"'),
  );
  assert.match(endHandler, /restoreDashboardAfterLiveCall\(\)/u);
  assert.match(main, /function restoreDashboardAfterLiveCall\(\) \{[\s\S]{0,400}isQuitting/u);
});

test("legacy credential files are neither decrypted nor rewritten by authentication", () => {
  const main = read("electron/main.js");
  assert.doesNotMatch(main, /safeStorage|hostPassword|saveLiveHostConfig|readLiveHostCredentials|silentHostLogin/u);
  const reader = main.slice(main.indexOf("function readDevelopmentWorkspaceUrl"), main.indexOf("async function ensureDesktopHostSession"));
  assert.match(reader, /fs.readFileSync/u);
  assert.doesNotMatch(reader, /write|decrypt|fetch|unlink/u);
});

test("packaged builds ignore saved development URLs without reading legacy profiles", () => {
  const main = read("electron/main.js");
  const resolver = main.slice(main.indexOf("function resolveLiveWorkspaceUrl"), main.indexOf("async function ensureDesktopHostSession"));
  const parser = main.slice(main.indexOf("function parseLiveWorkspaceUrl"), main.indexOf("// ── One-button Live Call"));
  let reads = 0;
  let workspaceUrl = "http://127.0.0.1:3000/";
  const resolve = vm.runInNewContext(`${resolver}\n${parser}\nresolveLiveWorkspaceUrl`, {
    DEFAULT_LIVE_WORKSPACE_URL: "https://default.example/", URL, Set, JSON,
    fs: { readFileSync() { reads++; return JSON.stringify({ workspaceUrl }); } },
    app: { getPath: () => "/virtual" }, path: { join: (...parts) => parts.join("/") },
  });
  assert.equal(resolve({}, true), "https://default.example/");
  assert.equal(reads, 0);
  assert.equal(resolve({}, false), workspaceUrl);
  workspaceUrl = "https://untrusted.example/";
  assert.equal(resolve({}, false), "https://default.example/");
  assert.throws(() => resolve({ REALTIME_NOEL_LIVE_URL: "http://127.0.0.1:3000/" }, true), /development/u);
});

test("preload exposes only the direct Live Call flow and the controller exposes Go-Live", () => {
  const preload = read("electron/preload.js");
  assert.doesNotMatch(preload, /openLiveWorkspace|live-workspace:open/u);
  assert.match(preload, /startLiveCall: \(draft\) => ipcRenderer\.invoke\("live-call:start", draft\)/u);
  assert.match(preload, /getLiveCallState: \(\) => ipcRenderer\.invoke\("live-call:get-state"\)/u);
  assert.match(preload, /goLiveCall: \(\) => ipcRenderer\.invoke\("live-call:go-live"\)/u);

  const controllerHtml = read("public/subtitle-controller.html");
  const controllerJs = read("public/subtitle-controller.js");
  assert.match(controllerHtml, /id="controller-go-live"[^>]*>Go-Live</u);
  assert.match(controllerJs, /getLiveCallState/u);
  assert.match(controllerJs, /goLiveCall\(\)/u);

  const workspace = read("public/subtitle-workspace.js");
  assert.match(workspace, /bridge\.startLiveCall\(draft\)/u);
  assert.match(workspace, /HOST_LOGIN_REQUIRED/u);
});
