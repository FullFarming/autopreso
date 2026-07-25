import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

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

test("cover upload validates bounded image bytes and uses a raw request body", () => {
  const main = read("electron/main.js");
  assert.match(main, /MAX_LIVE_COVER_BYTES = 5 \* 1024 \* 1024/u);
  assert.match(main, /image\/jpeg/u);
  assert.match(main, /image\/png/u);
  assert.match(main, /image\/webp/u);
  assert.match(main, /function validateLiveCoverImage/u);
  assert.match(main, /function matchesLiveCoverMagicBytes/u);
  assert.match(main, /body: bytes/u);
  assert.match(main, /"content-type": contentType/u);
  assert.match(main, /"content-length": String\(bytes\.byteLength\)/u);
  assert.doesNotMatch(main, /JSON\.stringify\(bytes\)/u);
});

test("controller Host Speak reclaims the floor through a short-lived gateway connection", () => {
  const main = read("electron/main.js");
  assert.match(main, /ipcMain\.handle\("live-call:host-speak"/u);
  assert.match(main, /function hostSpeakViaGateway/u);
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

test("controller can be moved by pointer drag and recovered from the application menu", () => {
  const main = read("electron/main.js");
  assert.match(main, /ipcMain\.on\("subtitle-controller:move-by"/u);
  assert.match(main, /function installApplicationMenu/u);
  assert.match(main, /Show Caption Controller/u);
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
  assert.match(goLive, /armedSession\.version = current\.data\.version/u);
  // Cloud Run rejects renderer WebSockets by Origin, so the MAIN process owns
  // the gateway host socket via the trusted non-browser path, and the
  // renderer only forwards mic PCM frames over IPC.
  assert.match(main, /ipcMain\.handle\("live-call:bridge-ensure"/u);
  assert.match(main, /ipcMain\.on\("live-call:audio-frame"/u);
  assert.match(main, /"x-realtime-noel-client": "desktop-main"/u);
  assert.match(main, /function ensureLiveGatewayBridge/u);
  assert.match(main, /stopLiveGatewayBridge\("live call ended"\)/u);
  assert.match(main, /gatewaySettings: \{/u);
  assert.match(main, /inputSource: "mic"/u);
  // Host Speak's short-lived control socket must use the same trusted headers.
  assert.match(main, /new WebSocket\(gatewayUrl, \{ headers: trustedGatewayHeaders\(token\) \}\)/u);

  const preload = read("electron/preload.js");
  assert.match(preload, /ensureLiveCallBridge: \(\) => ipcRenderer\.invoke\("live-call:bridge-ensure"\)/u);
  assert.match(preload, /sendLiveCallAudioFrame: \(frame\) => ipcRenderer\.send\("live-call:audio-frame", frame\)/u);

  // The dashboard captures 16 kHz mono and forwards 40ms PCM16 frames.
  const dashboard = read("public/subtitle-dashboard.js");
  assert.match(dashboard, /LIVE_BRIDGE_SAMPLE_RATE = 16_000/u);
  assert.match(dashboard, /sendLiveCallAudioFrame\(frame\.buffer\)/u);
  assert.match(dashboard, /stopLiveCallAudioBridge\("live call ended"\)/u);
  assert.match(dashboard, /syncLiveCallAudioBridge/u);

  // Go-Live failures surface on the controller instead of failing silently.
  const controllerJs = read("public/subtitle-controller.js");
  assert.match(controllerJs, /Go-Live failed \(\$\{result\?\.code \?\? "unknown"\}\)/u);
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
