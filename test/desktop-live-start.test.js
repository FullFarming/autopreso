import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

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
  assert.match(main, /live-call:start"[\s\S]{0,200}isAllowedOrigin\(event\.sender\.getURL\(\)/u);
  // Missing or rejected host login is explicit and cannot open a login window.
  assert.match(main, /HOST_LOGIN_REQUIRED/u);
  const startFlow = main.slice(
    main.indexOf('ipcMain.handle("live-call:start"'),
    main.indexOf('ipcMain.handle("live-call:save-host-login"'),
  );
  assert.equal(startFlow.includes("openLiveWorkspace"), false);
  assert.ok(startFlow.indexOf("silentHostLogin") < startFlow.indexOf('"/api/live-sessions"'));
  assert.ok(startFlow.indexOf('"/api/live-sessions"') < startFlow.indexOf("uploadLiveCover"));
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
  // Stored desktop host login signs in silently; no login page fallback exists.
  assert.match(main, /function silentHostLogin/u);
  assert.match(main, /live-host-login\.json/u);
  assert.match(main, /mode: 0o600/u);
  assert.match(main, /const login = await silentHostLogin\(liveWorkspaceUrl\)/u);
  // The stored workspace override may only ever point at loopback HTTP.
  assert.match(main, /new URL\(parsed\)\.protocol === "http:"/u);
  // The webapp's createLiveSessionInputSchema is .strict() with a REQUIRED
  // glossaryPack and maxViewers capped at 50 — the desktop draft must match
  // that contract exactly or every Start Live Call 400s.
  assert.match(main, /Math\.min\(50, Math\.max\(2, source\.maxViewers\)\)/u);
  assert.match(main, /glossaryPack: "general_cre"/u);
  assert.match(main, /liveCaptionConfig = createGeminiCaptionConfig\(/u);
  assert.match(main, /glossaryText: liveCaptionConfig\?\.glossary \?\? ""/u);
  assert.doesNotMatch(main, /buildLiveCallGlossary\(savedSettings/u);
});

test("server-rejected host login is distinct from missing credentials and save verifies against the workspace", () => {
  const main = read("electron/main.js");

  // A workspace 401 means the STORED credentials were rejected — the renderer
  // must be able to tell the user to fix them, not to save them again.
  const loginFlow = main.slice(
    main.indexOf("async function silentHostLogin"),
    main.indexOf("function parseLiveWorkspaceUrl"),
  );
  assert.match(loginFlow, /NO_STORED_LOGIN/u);
  assert.match(loginFlow, /HOST_LOGIN_REJECTED/u);

  // live-call:start passes the rejected code through instead of collapsing it
  // back into HOST_LOGIN_REQUIRED.
  const startFlow = main.slice(
    main.indexOf('ipcMain.handle("live-call:start"'),
    main.indexOf('ipcMain.handle("live-call:save-host-login"'),
  );
  assert.match(startFlow, /login\.code === "NO_STORED_LOGIN" \? "HOST_LOGIN_REQUIRED" : login\.code/u);

  // Saving verifies the credentials against the live workspace immediately so
  // the Settings page reports the real outcome instead of a local-only "saved".
  const saveFlow = main.slice(
    main.indexOf('ipcMain.handle("live-call:save-host-login"'),
    main.indexOf('ipcMain.handle("live-call:get-host-login-status"'),
  );
  assert.match(saveFlow, /await silentHostLogin\(liveWorkspaceUrl\)/u);
  assert.match(saveFlow, /verified/u);
  assert.match(saveFlow, /verificationCode/u);
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
    "live-call:save-host-login",
    "live-call:get-host-login-status",
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

test("Host End clears the armed session and Stage only after a successful optimistic request", () => {
  const main = read("electron/main.js");
  const start = main.indexOf('ipcMain.handle("live-call:end"');
  const end = main.indexOf('ipcMain.handle("subtitle-overlay:get-enabled"', start);
  const handler = main.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(handler, /method: "DELETE"/u);
  assert.match(handler, /body: \{ version: endingSession\.version \}/u);
  assert.ok(handler.indexOf("if (!ended.ok) return ended") < handler.indexOf("liveCallSession = null"));
  assert.match(handler, /ended\.data\?\.status !== "stopped"/u);
  assert.match(handler, /stageWindow\.destroy\(\)/u);
  assert.match(handler, /liveCallSession = null/u);

  const preload = read("electron/preload.js");
  assert.match(preload, /endLiveCall: \(\) => ipcRenderer\.invoke\("live-call:end"\)/u);
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
  assert.match(main, /bridge\.isHostAudioBlocked = shouldBlockLiveHostAudioForFloor/u);
  assert.match(main, /webContents\.send\("live-call:floor", message\)/u);
  assert.match(preload, /onLiveCallFloor/u);
  assert.match(preload, /ipcRenderer\.on\("live-call:floor", handler\)/u);
  assert.match(preload, /removeListener\("live-call:floor", handler\)/u);
  assert.match(dashboard, /let isLiveHostAudioBlocked = true/u);
  assert.match(dashboard, /function applyLiveCallFloorGate/u);
  assert.match(dashboard, /onLiveCallFloor\?\.\(applyLiveCallFloorGate\)/u);
  assert.match(dashboard, /if \(isLiveHostAudioBlocked\) return/u);
});

test("participant floor blocks the single Live Call PCM producer before adaptation", () => {
  const main = read("electron/main.js");
  const dashboard = read("public/subtitle-dashboard.js");
  const audioHandler = main.slice(
    main.indexOf('ipcMain.on("live-call:audio-frame"'),
    main.indexOf('ipcMain.handle("live-call:end"'),
  );
  assert.ok(audioHandler.indexOf("if (bridge.isHostAudioBlocked) return") < audioHandler.indexOf("adaptCaptionPcmForGateway"));
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
  assert.match(bridgeCapture, /if \(isLiveHostAudioBlocked\) return/u);
  assert.doesNotMatch(floorGate, /startLocalLiveCallFallback|restoreGatewayCaptionProducer|subtitle:audio/u);
  assert.doesNotMatch(dashboard, /async function startLocalLiveCallFallback|async function restoreGatewayCaptionProducer/u);
  assert.match(dashboard, /stopLiveCallAudioBridge\("live call ended"\)[\s\S]{0,300}isLiveHostAudioBlocked = true/u);
});

test("Live host IPC accepts only source-tagged Caption-only PCM and writes the versioned gateway envelope", () => {
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
  assert.match(handler, /adaptCaptionPcmForGateway/u,
    "the main process keeps the proven 16 kHz/40 ms PCM adapter");
  assert.match(handler, /encodeLiveAudioWireFrame\(packet\.source, pcmFrame\)/u,
    "every gateway PCM frame must carry its validated source tag");
  assert.match(main, /const liveBridgeAudioAdapters = new Map\(\)/u,
    "system and mic carry/resample state must not corrupt one another");
  assert.match(main, /createCaptionPcmResampler\(\)/u,
    "Live and Caption-only must share the same stateful FIR downsampler");
});

test("Live host capture failure stops the bridge and becomes visible instead of running silent", () => {
  const main = read("electron/main.js");
  const preload = read("electron/preload.js");
  const dashboard = read("public/subtitle-dashboard.js");
  const failureHandler = main.slice(
    main.indexOf('ipcMain.handle("live-call:audio-failed"'),
    main.indexOf('ipcMain.on("live-call:audio-frame"'),
  );

  assert.match(dashboard, /return \{ ok: false, error \}/u);
  assert.match(dashboard, /showError\(error\)/u);
  assert.match(dashboard, /setConnectionStatus\(error\.message, "error"\)/u);
  assert.match(dashboard, /reportLiveCallAudioFailure\?\.\(error\.message\)/u);
  assert.match(dashboard, /if \(liveBridgeCapture\?\.failed\) return/u,
    "a rejected permission must not trigger a hidden retry loop every second");
  assert.match(preload, /reportLiveCallAudioFailure: \(detail\) => ipcRenderer\.invoke\("live-call:audio-failed", detail\)/u);
  assert.match(failureHandler, /isAllowedOrigin/u);
  assert.match(failureHandler, /await stopLiveGatewayBridge\("host audio capture failed", \{ terminateRemote: true \}\)/u);
  assert.match(failureHandler, /HOST_AUDIO_CAPTURE_FAILED/u);
  assert.match(failureHandler, /notifyLiveBridgeFailure/u);
});

test("Live Call archive preserves a finalized gateway-canonical local record", () => {
  const main = read("electron/main.js");
  const archive = main.slice(
    main.indexOf("async function archiveLiveCallSession"),
    main.indexOf("function showDashboardWindow"),
  );
  assert.match(archive, /api\/subtitles\/sessions\/live-/u);
  const localCheck = archive.indexOf("payload?.ok === true");
  const remoteTranscript = archive.indexOf("/transcript?language=");
  assert.ok(localCheck >= 0 && remoteTranscript > localCheck,
    "the bilingual local record must win before source-only fallback import");
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

test("desktop go-live refreshes the version and the dashboard bridges host audio into the gateway", () => {
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
  assert.ok(
    goLive.indexOf("requestRendererLiveCaptionPreflight(armedSession)") < goLive.indexOf("/start"),
    "renderer preflight must precede the remote start request",
  );
  assert.match(goLive, /armedSession\.version = current\.data\.version/u);
  // Cloud Run rejects renderer WebSockets by Origin, so the MAIN process owns
  // the gateway host socket via the trusted non-browser path, and the
  // renderer only forwards mic PCM frames over IPC.
  assert.match(main, /ipcMain\.handle\("live-call:bridge-ensure"/u);
  assert.match(main, /ipcMain\.on\("live-call:audio-frame"/u);
  assert.match(main, /"x-realtime-noel-client": "desktop-main"/u);
  assert.match(main, /function ensureLiveGatewayBridge/u);
  assert.match(main, /await stopLiveGatewayBridge\("live call ended", \{ terminateRemote: true \}\)/u);
  assert.match(main, /gatewaySettings: \{/u);
  assert.match(main, /inputSource: "mic"/u);
  assert.match(main, /displayLanguage: sanitizeLiveCaptionDisplayLanguage\(config\.displayLanguage\)/u);
  assert.match(main, /shouldDisplayLiveCaption\(message, armedSession\.displayLanguage\)/u);
  assert.match(main, /body: toLiveCallApiInput\(input\)/u);
  assert.match(main, /start-registered", async \(event, sessionId, options\)/u);
  // Host Speak's short-lived control socket must use the same trusted headers.
  assert.match(main, /new WebSocket\(gatewayUrl, \{ headers: trustedGatewayHeaders\(token\) \}\)/u);

  const preload = read("electron/preload.js");
  assert.match(preload, /ensureLiveCallBridge: \(\) => ipcRenderer\.invoke\("live-call:bridge-ensure"\)/u);
  assert.match(preload, /reconnectLiveCallTranslation: \(\) => ipcRenderer\.invoke\("live-call:translation-reconnect"\)/u);
  assert.match(preload, /onLiveCallPreflight/u);
  assert.match(preload, /completeLiveCallPreflight/u);
  assert.match(preload, /onLiveCallPreflightCancel/u);
  assert.match(preload, /sendLiveCallAudioFrame: \(packet\) => ipcRenderer\.send\("live-call:audio-frame", packet\)/u);

  // The dashboard uses the exact Caption-only capture contract; main adapts it
  // to the legacy gateway wire until the gateway accepts source-tagged packets.
  const dashboard = read("public/subtitle-dashboard.js");
  assert.match(dashboard, /captureSelectedAudio\(state\.settings\)/u);
  assert.match(dashboard, /sendLiveCallAudioFrame\(packet\)/u);
  assert.doesNotMatch(dashboard, /LIVE_BRIDGE_SAMPLE_RATE|resampleLinear/u);
  assert.match(dashboard, /stopLiveCallAudioBridge\("live call ended"\)/u);
  assert.match(dashboard, /syncLiveCallAudioBridge/u);

  // Go-Live failures surface on the controller instead of failing silently.
  const controllerJs = read("public/subtitle-controller.js");
  assert.match(controllerJs, /t\("controller\.goLiveFailedCode", \{ code: result\?\.code \?\? "unknown" \}\)/u);
  assert.match(MESSAGES.en["controller.goLiveFailedCode"], /Go-Live failed \(\{code\}\)/u);
  assert.equal(typeof MESSAGES.ko["controller.goLiveFailedCode"], "string");
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

test("host passwords use Electron safeStorage and plaintext is migrated", () => {
  const main = read("electron/main.js");
  assert.match(main, /safeStorage/u);
  assert.match(main, /safeStorage\.isEncryptionAvailable\(\)/u);
  assert.match(main, /safeStorage\.encryptString\(/u);
  assert.match(main, /safeStorage\.decryptString\(/u);
  assert.match(main, /hostPasswordEncrypted/u);
  assert.match(main, /delete migrated\.hostPassword/u);
  assert.doesNotMatch(main, /JSON\.stringify\(next\)[\s\S]{0,80}hostPassword:/u);
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
