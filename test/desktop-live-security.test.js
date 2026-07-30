import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  sanitizeLiveCaptionDisplayLanguage,
  shouldDisplayLiveCaption,
} from "../src/live-caption-display-policy.js";
import {
  createGeminiCaptionConfig,
  geminiCaptionConfigFingerprint,
} from "../packages/caption-core/index.js";
import { createSubtitleChannelHub } from "../src/subtitle-channels.js";


const mainSource = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../electron/preload.js", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("../public/subtitle-workspace.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../public/subtitle-overlay.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const subtitleRealtimeSource = readFileSync(new URL("../src/subtitle-realtime.js", import.meta.url), "utf8");
const gatewaySource = readFileSync(new URL("../media-gateway/src/gateway-server.js", import.meta.url), "utf8");

test("local provider close and replacement start share one serialized transition", () => {
  assert.match(serverSource, /let subtitleProducerTransitionTail = Promise\.resolve\(\)/u);
  assert.match(serverSource, /queueSubtitleProducerTransition\(\(\) => subtitles\.stop\(orphanedSessionId\)\)/u);
  assert.match(serverSource, /queueSubtitleProducerTransition\(\(\) => subtitles\.start\(/u);
  assert.match(serverSource, /didStartLocalProvider[\s\S]{0,900}queueSubtitleProducerTransition\(\(\) => subtitles\.stop\(requestedSessionId\)\)/u);
});

test("Live Call desktop renders exactly one opposite-language lane for participant speech", () => {
  for (const displayLanguage of ["ko", "en"]) {
    for (const sourceLanguage of ["ko", "en"]) {
      const translationLanguage = sourceLanguage === "ko" ? "en" : "ko";
      const speaker = { isParticipant: true };
      const captions = [
        { language: sourceLanguage, sourceLanguage, origin: "source", speaker, speakerRole: "participant" },
        { language: translationLanguage, sourceLanguage, speaker, speakerRole: "participant" },
        // Provider echo: selected-language text without a cross-language
        // source identity must never become a second screen line.
        { language: sourceLanguage, sourceLanguage, speaker, speakerRole: "participant" },
      ];
      const displayed = captions.filter((caption) => shouldDisplayLiveCaption(caption, displayLanguage));
      assert.equal(displayed.length, 1, `${displayLanguage}/${sourceLanguage}`);
      assert.equal(displayed[0].language, translationLanguage);
      assert.equal(displayed[0].sourceLanguage, sourceLanguage);
      assert.equal(displayed[0].origin, undefined);
    }
  }
});

// The desktop screen is owned by the LOCAL captions-only engine, which hears
// the host microphone directly. The gateway translates the same host audio a
// second time for the web app, and mirroring that copy back onto the overlay
// is what forced every relay/ordering/direction correction layer. Host-origin
// gateway captions therefore never reach the screen; participant speech, which
// the local engine cannot hear, still does.
test("Live Call desktop drops host-origin gateway captions and keeps participant ones", () => {
  const hostCaption = { language: "en", sourceLanguage: "ko", speakerRole: "host", speakerName: "Host" };
  assert.equal(shouldDisplayLiveCaption(hostCaption, "ko"), false);
  // A meeting caption with no floor holder is host speech even without the
  // explicit role field (presentation sessions omit speaker metadata).
  assert.equal(shouldDisplayLiveCaption(
    { language: "en", sourceLanguage: "ko", speaker: null, speakerRole: "host" },
    "ko",
  ), false);
  // Participant speech keeps the existing behavior in every form the pipeline
  // emits it: explicit role, or the nested speaker identity.
  assert.equal(shouldDisplayLiveCaption(
    { language: "en", sourceLanguage: "ko", speakerRole: "participant", speakerName: "김노엘" },
    "ko",
  ), true);
  assert.equal(shouldDisplayLiveCaption(
    { language: "en", sourceLanguage: "ko", speaker: { isParticipant: true } },
    "ko",
  ), true);
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
  assert.match(sanitizer, /Array\.isArray\(subtitleSettings\.translationLanguages\)/u);
  assert.match(sanitizer, /Array\.isArray\(configuredLanguages\)/u);
  assert.match(sanitizer, /displayLanguage: sanitizeLiveCaptionDisplayLanguage\(source\.displayLanguage\)/u);
  assert.match(mainSource, /function toLiveCallApiInput/u);
  assert.doesNotMatch(sourceBetween("function toLiveCallApiInput", "async function openLiveStageOverlay"), /displayLanguage/u);
  assert.match(workspaceSource, /MAX_COVER_IMAGE_BYTES = 20 \* 1024 \* 1024/u);
  assert.match(workspaceSource, /new Set\(\["image\/jpeg", "image\/png", "image\/webp"\]\)/u);
  assert.match(workspaceSource, /file\.size <= 0 \|\| file\.size > MAX_COVER_IMAGE_BYTES/u);
  assert.match(workspaceSource, /new Uint8Array\(await file\.arrayBuffer\(\)\)/u);
  assert.match(workspaceSource, /base64: window\.btoa\(binary\)/u);
  assert.match(workspaceSource, /coverImage: liveDraftCoverData/u);
  assert.match(preloadSource, /startLiveCall: \(draft\) => ipcRenderer\.invoke\("live-call:start", draft\)/u);
  assert.match(preloadSource, /startRegisteredLiveCall: \(sessionId, options\).*sessionId, options/u);
  assert.match(mainSource, /MAX_LIVE_COVER_BYTES = 20 \* 1024 \* 1024/u);
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

test("cover bytes go only to a validated HTTPS Supabase signed URL", () => {
  const signedUpload = sourceBetween(
    "function validateLiveCoverSignedUpload",
    "function matchesLiveCoverMagicBytes",
  );
  assert.match(signedUpload, /protocol !== "https:"/u);
  assert.match(signedUpload, /\\\.supabase\\\.co/u);
  assert.match(signedUpload, /object\/upload\/sign\/live-covers/u);
  assert.match(signedUpload, /sessionId/u);
  assert.match(signedUpload, /objectPath/u);
  const uploader = sourceBetween(
    "async function uploadLiveCover",
    "async function cleanupPreparedLiveSession",
  );
  assert.match(uploader, /`\/api\/live-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/cover`/u);
  assert.match(uploader, /action: "prepare"/u);
  assert.match(uploader, /method: "PUT"/u);
  assert.match(uploader, /credentials: "omit"/u);
  assert.match(uploader, /action: "finalize"/u);
  assert.doesNotMatch(uploader, /credentials: "include"[\s\S]*body: image\.bytes/u);
  assert.doesNotMatch(uploader, /image\.(?:url|path|name)/u);
});

test("signed cover URL validation rejects non-Supabase, cross-session, and query-smuggling targets", () => {
  const source = sourceBetween(
    "function validateLiveCoverSignedUpload",
    "function matchesLiveCoverMagicBytes",
  );
  const validate = vm.runInNewContext(`${source}; validateLiveCoverSignedUpload`, { URL });
  const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
  const objectPath = `${sessionId}/pending/${"a".repeat(32)}.jpg`;
  const value = {
    uploadUrl: `https://project-ref.supabase.co/storage/v1/object/upload/sign/live-covers/${objectPath}?token=signed-token`,
    storageOrigin: "https://project-ref.supabase.co",
    objectPath,
    uploadTicket: "opaque-ticket",
  };
  assert.equal(validate(value, sessionId).ok, true);
  for (const uploadUrl of [
    value.uploadUrl.replace("https:", "http:"),
    value.uploadUrl.replace(".supabase.co", ".supabase.co.example.com"),
    value.uploadUrl.replace("https://", "https://user:password@"),
    value.uploadUrl.replace("?token=", "?extra=1&token="),
    `${value.uploadUrl}#fragment`,
  ]) {
    assert.equal(validate({ ...value, uploadUrl }, sessionId).ok, false, uploadUrl);
  }
  assert.equal(validate({ ...value, storageOrigin: "https://another-project.supabase.co" }, sessionId).ok, false);
  assert.equal(validate(value, "0192d0f4-9f72-7a36-91f5-6a76ef736f42").ok, false);
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
    "live-call:audio-failed",
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

test("Live Call caption IPC targets only the dashboard and the active overlays", () => {
  const relay = sourceBetween("function relayLiveCallFloorToRenderers", "function notifyLiveBridgeFailure");
  // One overlay per targeted display: exactly the selected one normally, every
  // connected screen while the controller's all-displays tick is on.
  assert.match(relay, /\[dashboardWindow, \.\.\.overlayWindows\.values\(\)\]/u);
  assert.doesNotMatch(relay, /BrowserWindow\.getAllWindows\(\)/u);
  assert.doesNotMatch(relay, /controllerWindow/u);
});

test("overlay display IPC is local-only and accepts only a bounded connected display id", () => {
  assert.match(preloadSource, /listOverlayDisplays:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("subtitle-overlay:list-displays"\)/u);
  assert.match(preloadSource, /selectOverlayDisplay:\s*\(displayId\)\s*=>\s*ipcRenderer\.invoke\("subtitle-overlay:select-display", displayId\)/u);
  assert.match(preloadSource, /onOverlayDisplaysChanged:\s*\(listener\)[\s\S]*ipcRenderer\.on\("subtitle-overlay:displays-changed", handler\)[\s\S]*removeListener\("subtitle-overlay:displays-changed", handler\)/u);

  const listHandler = sourceBetween(
    'ipcMain.handle("subtitle-overlay:list-displays"',
    'ipcMain.handle("subtitle-overlay:select-display"',
  );
  const selectHandler = sourceBetween(
    'ipcMain.handle("subtitle-overlay:select-display"',
    'ipcMain.handle("subtitle-overlay:get-enabled"',
  );
  for (const [channel, handler] of [
    ["subtitle-overlay:list-displays", listHandler],
    ["subtitle-overlay:select-display", selectHandler],
  ]) {
    assert.match(handler, /isAllowedOrigin\(event\.sender\.getURL\(\), new Set\(\[localAppOrigin\]\)\)/u, channel);
  }
  assert.match(mainSource, /const MAX_OVERLAY_DISPLAY_ID_LENGTH\s*=\s*\d+/u);
  assert.match(selectHandler, /typeof displayId !== "string"/u);
  assert.match(selectHandler, /displayId\.length\s*>\s*MAX_OVERLAY_DISPLAY_ID_LENGTH/u);
  assert.match(selectHandler, /screen\.getAllDisplays\(\)[\s\S]*find\([\s\S]*=== displayId/u,
    "the main process, not the renderer, must resolve an exact current screen member");
  assert.doesNotMatch(selectHandler, /displayId\.(?:bounds|workArea|url)|\b(?:bounds|workArea|url)\s*=\s*displayId/u);
  assert.doesNotMatch(preloadSource, /selectOverlayDisplay:\s*\([^)]*,/u,
    "the renderer must not supply bounds, URL, or other window configuration");
});

test("Live Call failure responses and logs do not expose stored credentials", () => {
  const api = sourceBetween("async function liveCallApi", "const LIVE_DRAFT_LANGUAGES");
  assert.doesNotMatch(api, /console\.(?:log|info|debug|warn)/u);
  assert.doesNotMatch(api, /hostPassword|\bpassword\s*:/u);
  const startHandler = sourceBetween(
    'ipcMain.handle("live-call:start"',
    'ipcMain.handle("live-call:save-host-login"',
  );
  assert.doesNotMatch(startHandler, /hostPassword/u);
});

test("Live Call preflight preserves the complete 40k glossary for the gateway", async () => {
  const preflight = vm.runInNewContext(
    `${sourceBetween("async function preflightLiveCallCaptionSession", "function requestRendererLiveCaptionPreflight")}; preflightLiveCallCaptionSession`,
    {
      dashboardWindow: {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false },
      },
      validateSubtitleSettings: () => {},
      createGeminiCaptionConfig,
      geminiCaptionConfigFingerprint,
      String,
    },
  );
  const glossary = `${"가".repeat(39_993)}끝 = end`;
  assert.equal(glossary.length, 40_000);
  const armedSession = { gatewaySettings: { existing: true } };
  const result = await preflight({
    load: async () => ({
      subtitle: {
        glossary: `  ${glossary}  `,
        tone: "business",
        translationDomain: "Commercial real estate",
      },
    }),
  }, armedSession);

  assert.equal(result.ok, true);
  assert.equal(armedSession.gatewaySettings.glossaryText, glossary);
  assert.equal(armedSession.gatewaySettings.translationTone, "business");
  assert.equal(armedSession.gatewaySettings.domainText, "Commercial real estate");
  assert.equal(armedSession.gatewaySettings.captionConfig.glossary, glossary);
  assert.match(armedSession.gatewaySettings.captionConfigFingerprint, /^gemini-caption-v1-[a-f0-9]{16}$/u);
  assert.equal(armedSession.gatewaySettings.existing, true);
});

// ── Live Call gateway reconnect ────────────────────────────────────────────
// The old close handler retried on a hardcoded `setTimeout(..., 3_000)`: no
// backoff, no capped slow-retry mode, and the timer id was never stored so
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
    liveBridgeCredentialRefreshTimer: null,
    liveBridgeAudioAdapters: new Map(),
    liveBridgeAlert: null,
    hasNotifiedLiveBridgeFailure: false,
    clearLiveBridgeCredentialRefresh: () => {},
    isQuitting: false,
    liveCallSession: null,
    LIVE_BRIDGE_RECONNECT_BASE_MS: 1_000,
    LIVE_BRIDGE_SLOW_RETRY_MIN_MS: 36_000,
    LIVE_BRIDGE_SLOW_RETRY_JITTER_MS: 6_000,
    LIVE_BRIDGE_SLOW_RETRY_AFTER: 8,
    LIVE_BRIDGE_CREDENTIAL_REFRESH_MAX_MS: 50 * 60 * 1_000,
    LIVE_BRIDGE_CREDENTIAL_REFRESH_SKEW_MS: 60_000,
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
    Math: { min: Math.min, max: Math.max, random: () => 0 },
    ...overrides,
  };
  const api = vm.runInNewContext(
    `${sourceBetween("function setLiveBridgeAlert", "function getLiveBridgeReconnectDelay")}
     ${sourceBetween("function getLiveBridgeReconnectDelay", "async function ensureLiveGatewayBridge")};
     ({ scheduleLiveGatewayReconnect, clearLiveBridgeReconnect, stopLiveGatewayBridge, liveBridgeStatus, clearLiveBridgeAlert })`,
    context,
  );
  return { ...api, timers, cleared, dialogs, logs, context };
}

test("gateway reconnect backs off exponentially and keeps capped retries alive past eight failures", async () => {
  const bridge = loadLiveBridgeReconnect();
  const armedSession = { sessionId: "s1", status: "live" };
  bridge.context.liveCallSession = armedSession;

  const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 36_000, 36_000, 36_000, 36_000, 36_000];
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
  assert.equal(bridge.timers.length, 10, "a two-hour session must never exhaust automatic recovery");
  assert.equal(bridge.liveBridgeStatus().state, "reconnecting");
  assert.equal(bridge.liveBridgeStatus().code, "GATEWAY_RECONNECTING");
  assert.equal(bridge.dialogs.length, 1, "slow retry mode is surfaced once without stopping recovery");
  assert.match(bridge.dialogs[0].message, /automatically|자동/u);
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

test("gateway reconnect stays within thirty token requests in every fifteen-minute window", () => {
  const context = {
    LIVE_BRIDGE_RECONNECT_BASE_MS: 1_000,
    LIVE_BRIDGE_SLOW_RETRY_MIN_MS: 36_000,
    LIVE_BRIDGE_SLOW_RETRY_JITTER_MS: 6_000,
    Math: { min: Math.min, max: Math.max },
    Number,
  };
  const getDelay = vm.runInNewContext(
    `${sourceBetween("function getLiveBridgeReconnectDelay", "function scheduleLiveGatewayReconnect")}; getLiveBridgeReconnectDelay`,
    context,
  );
  assert.equal(getDelay(5, () => 0), 36_000);
  assert.equal(getDelay(5, () => 1), 42_000);
  assert.equal(getDelay(5, () => -1), 36_000, "negative jitter is clamped");
  assert.equal(getDelay(5, () => 2), 42_000, "oversized jitter is clamped");
  const requestTimes = [];
  let elapsed = 0;
  let attempt = 0;
  while (elapsed <= 30 * 60 * 1_000) {
    elapsed += getDelay(attempt, () => 0);
    if (elapsed > 30 * 60 * 1_000) break;
    requestTimes.push(elapsed);
    attempt += 1;
  }
  for (let windowStart = 0; windowStart <= 15 * 60 * 1_000; windowStart += 1_000) {
    const windowEnd = windowStart + 15 * 60 * 1_000;
    const count = requestTimes.filter((time) => time > windowStart && time <= windowEnd).length;
    assert.ok(count <= 30, `rate window ${windowStart}-${windowEnd} scheduled ${count} token requests`);
  }
});

test("gateway recovers on the same session after more than eight transient failures", async () => {
  let attempts = 0;
  const armedSession = { sessionId: "long-outage", status: "live" };
  const bridge = loadLiveBridgeReconnect({
    ensureLiveGatewayBridge: () => {
      attempts += 1;
      return Promise.resolve(attempts >= 11 ? { ok: true } : { ok: false, code: "GATEWAY_UNREACHABLE" });
    },
  });
  bridge.context.liveCallSession = armedSession;
  bridge.scheduleLiveGatewayReconnect(armedSession);
  for (let index = 0; index < 11; index += 1) {
    const timer = bridge.timers[index];
    assert.ok(timer, `missing retry ${index + 1}`);
    timer.callback();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(attempts, 11);
  assert.equal(bridge.timers.length, 11, "a successful restoration stops scheduling another request");
  assert.equal(bridge.context.liveCallSession, armedSession);
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
  assert.match(mainSource, /LIVE_BRIDGE_SLOW_RETRY_MIN_MS = 36_000/u);
  assert.match(mainSource, /LIVE_BRIDGE_SLOW_RETRY_JITTER_MS = 6_000/u);
  assert.match(mainSource, /LIVE_BRIDGE_SLOW_RETRY_AFTER = 8/u);
  assert.doesNotMatch(mainSource, /GATEWAY_RECONNECT_EXHAUSTED/u);
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
  assert.match(messageHandler, /message\.type === "language-status"/u);
  assert.match(messageHandler, /message\.sessionId !== armedSession\.sessionId/u);
  assert.match(messageHandler, /bridge\.languageStatuses\.set\(message\.language, message\.status\)/u);
});

test("controller bridge health projects an explicit metadata allowlist", () => {
  const bridge = loadLiveBridgeReconnect();
  bridge.context.liveGatewayBridge = {
    ready: false,
    floorKnown: true,
    isHostAudioBlocked: false,
  };
  bridge.context.liveBridgeAlert = {
    state: "reconnecting",
    code: "TRANSLATION_RECONNECTING",
    attempts: 4,
    message: "secret transcript https://provider.example/?token=sk-secret",
    detail: "Cushman & Wakefield",
    sourceText: "sensitive source",
    apiKey: "sk-secret",
    gatewayUrl: "wss://provider.example/secret",
  };
  const status = bridge.liveBridgeStatus();
  assert.deepEqual(
    [...Object.keys(status)].sort(),
    ["attempts", "code", "floorKnown", "hostAudioBlocked", "state"].sort(),
  );
  assert.equal(status.state, "reconnecting");
  assert.equal(status.code, "TRANSLATION_RECONNECTING");
  assert.equal(status.attempts, 4);
  assert.equal(status.floorKnown, true);
  assert.equal(status.hostAudioBlocked, false);
  assert.doesNotMatch(JSON.stringify(status), /secret|provider\.example|Cushman|sourceText|apiKey|gatewayUrl/u);

  bridge.context.liveBridgeAlert = null;
  bridge.context.liveGatewayBridge.ready = true;
  bridge.context.liveGatewayBridge.languageStatuses = new Map([["ko", "unavailable"]]);
  assert.equal(bridge.liveBridgeStatus().state, "reconnecting");
  assert.equal(bridge.liveBridgeStatus().code, "TRANSLATION_RECOVERING");
  bridge.context.liveGatewayBridge.languageStatuses.set("ko", "ready");
  assert.equal(bridge.liveBridgeStatus().state, "connected");

  const healthProjection = sourceBetween("function liveBridgeStatus", "function shouldBlockLiveHostAudioForFloor");
  assert.doesNotMatch(healthProjection, /\.\.\.liveBridgeAlert/u);
});

test("only the exact dashboard renderer may request a Live Call translation restart", () => {
  const handler = sourceBetween(
    'ipcMain.handle("live-call:translation-reconnect"',
    'ipcMain.handle("live-call:audio-failed"',
  );
  const originGuard = handler.indexOf("isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))");
  const dashboardGuard = handler.indexOf("event.sender !== dashboardWindow.webContents");
  const restart = handler.indexOf("restartLiveTranslationBridge()");
  assert.ok(originGuard >= 0 && originGuard < dashboardGuard,
    "the exact local origin must be checked before renderer identity");
  assert.ok(dashboardGuard >= 0 && dashboardGuard < restart,
    "controller and overlay renderers must not be able to restart the translation pipeline");
});

test("only the exact dashboard renderer may drive the host audio bridge", () => {
  const handlers = [
    {
      name: "ensure",
      source: sourceBetween('ipcMain.handle("live-call:bridge-ensure"', 'ipcMain.on("live-call:preflight-result"'),
      protectedAction: "ensureLiveGatewayBridge()",
    },
    {
      name: "audio failure",
      source: sourceBetween('ipcMain.handle("live-call:audio-failed"', 'ipcMain.on("live-call:audio-frame"'),
      protectedAction: "liveCallSession",
    },
    {
      name: "audio frame",
      source: sourceBetween('ipcMain.on("live-call:audio-frame"', 'ipcMain.handle("live-call:end"'),
      protectedAction: "liveGatewayBridge",
    },
  ];

  for (const handler of handlers) {
    const originGuard = handler.source.indexOf("isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))");
    const dashboardGuard = handler.source.indexOf("event.sender !== dashboardWindow.webContents");
    const protectedAction = handler.source.indexOf(handler.protectedAction);
    assert.ok(originGuard >= 0 && originGuard < dashboardGuard, `${handler.name} checks origin before renderer identity`);
    assert.ok(dashboardGuard >= 0 && dashboardGuard < protectedAction,
      `${handler.name} rejects controller and overlay senders before touching the host bridge`);
  }
});

test("host gateway credentials rotate at least eight times in a two-hour fake clock without replacing the Live Call session", () => {
  let now = Date.parse("2026-07-26T00:00:00.000Z");
  const timers = [];
  const cleared = [];
  const armedSession = { sessionId: "two-hour-session", status: "live" };
  const context = {
    LIVE_BRIDGE_CREDENTIAL_REFRESH_MAX_MS: 50 * 60 * 1_000,
    LIVE_BRIDGE_CREDENTIAL_REFRESH_SKEW_MS: 60_000,
    liveBridgeCredentialRefreshTimer: null,
    liveGatewayBridge: null,
    liveCallSession: armedSession,
    isQuitting: false,
    Date: { now: () => now, parse: Date.parse },
    setTimeout(callback, delay) {
      const token = { callback, delay };
      timers.push(token);
      return token;
    },
    clearTimeout(token) { cleared.push(token); },
    console: { warn() {}, info() {}, error() {} },
  };
  const api = vm.runInNewContext(
    `${sourceBetween("function getLiveBridgeCredentialRefreshDelay", "function setLiveBridgeAlert")};
     ({ getLiveBridgeCredentialRefreshDelay, scheduleLiveGatewayCredentialRefresh })`,
    context,
  );

  for (let rotation = 0; rotation < 8; rotation += 1) {
    const socket = { closeCalls: [], close(code, reason) { this.closeCalls.push([code, reason]); } };
    const bridge = { socket, ready: true, session: armedSession };
    context.liveGatewayBridge = bridge;
    const expiresAt = new Date(now + 15 * 60 * 1_000).toISOString();
    assert.equal(api.getLiveBridgeCredentialRefreshDelay(expiresAt), 14 * 60 * 1_000);
    api.scheduleLiveGatewayCredentialRefresh(bridge, expiresAt);
    const timer = timers.at(-1);
    assert.equal(timer.delay, 14 * 60 * 1_000);
    now += timer.delay;
    timer.callback();
    assert.equal(bridge.session, armedSession);
    assert.deepEqual(socket.closeCalls, [[4001, "gateway credential refresh"]]);
  }
  assert.ok(now - Date.parse("2026-07-26T00:00:00.000Z") < 2 * 60 * 60 * 1_000);
  assert.equal(context.liveCallSession, armedSession);
});

test("gateway connection consumes token expiry and successful starts arm controlled credential refresh", () => {
  const fetchConnection = sourceBetween("async function fetchGatewayConnection", "function trustedGatewayHeaders");
  assert.match(fetchConnection, /expiresAt:\s*tokenResult\.data\?\.expiresAt/u);
  const bridge = sourceBetween("async function ensureLiveGatewayBridge", "function hostSpeakViaGateway");
  assert.match(bridge, /scheduleLiveGatewayCredentialRefresh\(bridge, connection\.expiresAt\)/u);
  assert.match(bridge, /message\.type === "started" \|\| message\.type === "restarted"/u);
  const stop = sourceBetween("async function stopLiveGatewayBridge", "async function ensureLiveGatewayBridgeOnce");
  assert.match(stop, /clearLiveBridgeCredentialRefresh\(\)/u);
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

// ── Live Call desktop speaking-floor trust boundary ──────────────────────────

test("renderer floor IPC is receive-only and cannot spoof the gateway floor", () => {
  assert.match(preloadSource, /onLiveCallFloor:\s*\(listener\)[\s\S]*ipcRenderer\.on\("live-call:floor", handler\)/u);
  assert.match(preloadSource, /removeListener\("live-call:floor", handler\)/u);
  assert.doesNotMatch(preloadSource, /ipcRenderer\.(?:send|invoke)\("live-call:floor"/u);
  assert.doesNotMatch(preloadSource, /(?:set|send|update)LiveCallFloor/u);
});

test("desktop floor state is accepted only from the active authenticated bridge and exact session", () => {
  const bridge = sourceBetween("async function ensureLiveGatewayBridgeOnce", "async function ensureLiveGatewayBridge()");
  const staleFence = bridge.indexOf("if (liveGatewayBridge !== bridge) return;");
  const parse = bridge.indexOf('JSON.parse(data.toString("utf8"))');
  const floorBranch = bridge.indexOf('message.type === "floor"');
  assert.ok(staleFence >= 0 && staleFence < parse, "stale socket callbacks must be rejected before parsing or mutating floor state");
  assert.ok(parse >= 0 && parse < floorBranch, "only parsed messages from the authenticated gateway handler may reach floor state");
  const floorBlock = bridge.slice(floorBranch, bridge.indexOf('message.type === "error"', floorBranch));
  assert.match(floorBlock, /if \(!bridge\.ready\) return/u);
  assert.match(floorBlock, /message\.sessionId[^\n]*armedSession\.sessionId/u);
  assert.match(floorBlock, /shouldBlockLiveHostAudioForFloor\(message, armedSession\.sessionId\)/u);
  const blockDecision = floorBlock.indexOf("shouldBlockLiveHostAudioForFloor");
  const adapterReset = floorBlock.indexOf("liveBridgeAudioAdapters.clear()");
  const malformedGate = floorBlock.indexOf("if (!bridge.floorKnown)");
  assert.ok(blockDecision >= 0 && blockDecision < adapterReset && adapterReset < malformedGate,
    "participant or malformed floor state must discard pending host PCM before renderer notification");
  assert.match(floorBlock, /if \(!bridge\.floorKnown\) \{[\s\S]*bridge\.lastFloorMessage = \{[\s\S]*sessionId: armedSession\.sessionId[\s\S]*participantId: "unavailable"[\s\S]*relayLiveCallFloorToRenderers\(bridge\.lastFloorMessage\)[\s\S]*return;/u);
  assert.match(floorBlock, /relayLiveCallFloorToRenderers\(message\)/u);
  assert.doesNotMatch(mainSource, /ipcMain\.(?:on|handle)\("live-call:(?:set-|update-)?floor"/u);
});

test("malformed or cross-session floor payloads fail closed", () => {
  const source = sourceBetween(
    "function shouldBlockLiveHostAudioForFloor",
    "function notifyLiveBridgeFailure",
  );
  const shouldBlock = vm.runInNewContext(`${source}; shouldBlockLiveHostAudioForFloor`, { String });
  const sessionId = "session-1";
  assert.equal(shouldBlock({ type: "floor", sessionId, holder: null }, sessionId), false);
  assert.equal(shouldBlock({ type: "floor", sessionId, holder: { participantId: "grant-1", name: "Guest" } }, sessionId), true);
  for (const payload of [
    null,
    {},
    { type: "floor", sessionId: "session-2", holder: null },
    { type: "floor", sessionId },
    { type: "floor", sessionId, holder: false },
    { type: "floor", sessionId, holder: {} },
    { type: "floor", sessionId, holder: { participantId: "", name: "Guest" } },
    { type: "floor", sessionId, holder: { participantId: null } },
  ]) {
    assert.equal(shouldBlock(payload, sessionId), true, JSON.stringify(payload));
  }
});

test("participant floor blocks local host frames before resampling and non-local renderers stay forbidden", () => {
  const handler = sourceBetween(
    'ipcMain.on("live-call:audio-frame"',
    'ipcMain.handle("live-call:end"',
  );
  const originGuard = handler.indexOf("isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))");
  const floorGate = handler.indexOf("bridge.isHostAudioBlocked");
  const resample = handler.indexOf("adaptCaptionPcmForGateway");
  const send = handler.indexOf("bridge.socket.send");
  assert.ok(originGuard >= 0 && originGuard < floorGate, "remote renderers must fail the exact-origin guard first");
  assert.ok(floorGate >= 0 && floorGate < resample, "blocked audio must not enter stateful resampling");
  assert.ok(resample >= 0 && resample < send, "only allowed and validated PCM may reach the gateway socket");
});

test("new, stopped, and disconnected bridges prefer temporary mute over host-audio leakage", () => {
  const ensure = sourceBetween("async function ensureLiveGatewayBridgeOnce", "async function ensureLiveGatewayBridge()");
  assert.match(ensure, /const bridge = \{[^}]*isHostAudioBlocked:\s*true/u);
  const stop = sourceBetween("async function stopLiveGatewayBridge", "function adaptCaptionPcmForGateway");
  assert.match(stop, /liveBridgeAudioAdapters\.clear\(\)/u);
  const closeStart = ensure.indexOf('socket.on("close"');
  assert.notEqual(closeStart, -1);
  const closeBlock = ensure.slice(closeStart);
  assert.match(closeBlock, /liveGatewayBridge\s*=\s*null/u);
  assert.match(closeBlock, /liveBridgeAudioAdapters\.clear\(\)/u);
});

test("gateway start and reattach send a HOST-only authoritative floor snapshot before local audio can unmute", () => {
  const startedMessage = gatewaySource.indexOf('type: message.type === "update" ? "updated" : message.type === "restart" ? "restarted" : "started"');
  const handlerEnd = gatewaySource.indexOf("} catch (error) {", startedMessage);
  assert.ok(startedMessage >= 0 && handlerEnd > startedMessage);
  const completion = gatewaySource.slice(startedMessage, handlerEnd);
  assert.match(completion, /sendJson\(webSocket, createFloorPayload\(\s*claims\.sessionId,\s*floorHolders\.get\(claims\.sessionId\) \?\? null,?\s*\)\)/u);
  assert.doesNotMatch(completion, /broadcastFloor\(/u);
});

// ── Caption stop/clear trust boundary ───────────────────────────────────────

test("authenticated gateway captions must match the active ready bridge session", () => {
  const bridge = sourceBetween("async function ensureLiveGatewayBridgeOnce", "async function ensureLiveGatewayBridge()");
  const captionStart = bridge.indexOf('message.type === "caption"');
  const captionEnd = bridge.indexOf('message.type === "floor"', captionStart);
  assert.ok(captionStart >= 0 && captionEnd > captionStart);
  const captionBranch = bridge.slice(captionStart, captionEnd);
  assert.match(captionBranch, /if \(!bridge\.ready\) return/u);
  assert.match(captionBranch, /message\.sessionId\s*!==\s*armedSession\.sessionId/u);
  const sessionFence = captionBranch.indexOf("message.sessionId");
  const relay = captionBranch.indexOf("bridge.captionRelay.push(message)");
  assert.ok(sessionFence >= 0 && sessionFence < relay,
    "cross-session or pre-start captions must be rejected before entering renderer IPC");
});

test("dashboard rejects queued Live Call caption IPC after stop or session replacement", () => {
  const listenerStart = dashboardSource.indexOf("onLiveCallCaption((caption) =>");
  const listenerEnd = dashboardSource.indexOf("});", listenerStart);
  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart);
  const listener = dashboardSource.slice(listenerStart, listenerEnd);
  assert.match(listener, /activeCaptionSessionOwner\s*!==\s*"live-call"/u);
  assert.match(listener, /state\.running/u);
  assert.match(listener, /caption\.sessionId\s*!==\s*activeLiveFloorSessionId/u);
  const sessionFence = listener.indexOf("caption.sessionId");
  const enqueue = listener.indexOf("enqueueLiveCallCaptionRelay(caption)");
  assert.ok(sessionFence >= 0 && sessionFence < enqueue,
    "a queued IPC callback from the ended session must not repaint a new or idle session");
});

test("local subtitle stop invalidates the producer epoch and clears display before graceful close can emit late captions", () => {
  const stopStart = subtitleRealtimeSource.indexOf("async function stop(sessionId = state.sessionId)");
  const stopEnd = subtitleRealtimeSource.indexOf("\n  function close()", stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  const stop = subtitleRealtimeSource.slice(stopStart, stopEnd);
  const inactive = stop.indexOf("state.active = false");
  const sessionClear = stop.indexOf("state.sessionId = null");
  const idle = stop.indexOf('broadcast?.({ type: "subtitle:status", status: "idle" })');
  const gracefulClose = stop.indexOf("await Promise.all");
  assert.ok(inactive >= 0 && inactive < gracefulClose,
    "late provider callbacks must be rejected before graceful shutdown begins");
  assert.ok(sessionClear >= 0 && sessionClear < gracefulClose,
    "the stopped session identity must be revoked before awaiting external IO");
  assert.ok(idle >= 0 && idle < gracefulClose,
    "trusted local clients must receive the clear boundary without waiting on provider shutdown");
});

test("only the exact active local WebSocket producer can request subtitle stop", () => {
  const stopStart = serverSource.indexOf('message.type === "subtitle:stop"');
  const stopEnd = serverSource.indexOf("\n      }", stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  const stop = serverSource.slice(stopStart, stopEnd);
  assert.match(stop, /typeof message\.sessionId !== "string" \|\| message\.sessionId\.length === 0/u);
  assert.match(stop, /client !== subtitleSessionProducer \|\| message\.sessionId !== subtitleSessionId/u);
  assert.match(stop, /SUBTITLE_SESSION_MISMATCH/u);
});

test("Live Call end clear uses the existing receive-only IPC and carries the exact ending session", () => {
  const endHandler = sourceBetween(
    'ipcMain.handle("live-call:end"',
    'ipcMain.handle("subtitle-overlay:get-enabled"',
  );
  assert.match(endHandler, /relayLiveCallFloorToRenderers\(\{[\s\S]*type:\s*"live-call-ended"[\s\S]*sessionId:\s*endingSession\.sessionId/u);
  assert.match(preloadSource, /onLiveCallFloor:[\s\S]*ipcRenderer\.on\("live-call:floor", handler\)/u);
  assert.doesNotMatch(preloadSource, /ipcRenderer\.(?:send|invoke)\("live-call:floor"/u);
});

test("server-confirmed remote Live Call termination emits the same trusted exact-session clear", () => {
  const bridge = sourceBetween("async function ensureLiveGatewayBridgeOnce", "async function ensureLiveGatewayBridge()");
  const terminalStart = bridge.indexOf('currentStatus === "stopped"');
  const terminalEnd = bridge.indexOf("return { ok: false, code: \"SESSION_ENDED\" };", terminalStart);
  assert.ok(terminalStart >= 0 && terminalEnd > terminalStart);
  const terminal = bridge.slice(terminalStart, terminalEnd);
  assert.match(terminal, /relayLiveCallFloorToRenderers\(\{[\s\S]*type:\s*"live-call-ended"[\s\S]*sessionId:\s*armedSession\.sessionId/u);
});

test("terminal clear handlers reject replay from another Live Call session", () => {
  const dashboardGateStart = dashboardSource.indexOf("function applyLiveCallFloorGate");
  const dashboardGateEnd = dashboardSource.indexOf("\n}", dashboardGateStart);
  assert.ok(dashboardGateStart >= 0 && dashboardGateEnd > dashboardGateStart);
  const dashboardGate = dashboardSource.slice(dashboardGateStart, dashboardGateEnd);
  assert.match(dashboardGate, /floor\?\.type === "live-call-ended"/u);
  assert.match(dashboardGate, /floor\.sessionId === activeLiveFloorSessionId/u);
  assert.match(dashboardGate, /clearActiveSubtitleSurface\(\)/u);

  const overlayBoundaryStart = overlaySource.indexOf("function handleLiveCallFloorBoundary");
  const overlayBoundaryEnd = overlaySource.indexOf("\n}", overlayBoundaryStart);
  assert.ok(overlayBoundaryStart >= 0 && overlayBoundaryEnd > overlayBoundaryStart);
  const overlayBoundary = overlaySource.slice(overlayBoundaryStart, overlayBoundaryEnd);
  assert.match(overlayBoundary, /floor\?\.type === "live-call-ended"/u);
  assert.match(overlayBoundary, /floor\.sessionId !== activeLiveCallSessionId/u);
  assert.match(overlayBoundary, /clearSubtitle\(\)/u);
});

// ── Single-overlay canonical Live Call timeline ─────────────────────────────

test("the selected overlay gets an exact-session bootstrap even before the first Live Call caption", () => {
  let now = 1_000;
  const hub = createSubtitleChannelHub({
    now: () => now += 10,
    maximumSnapshotEventsPerLane: 2,
  });
  hub.setLiveCallSession("old-session");
  hub.ingest({
    type: "subtitle:committed",
    source: "live-call",
    liveSessionId: "old-session",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Must be cleared.",
  });
  hub.ingest({ type: "subtitle:status", status: "idle" });
  hub.setLiveCallSession("current-session");

  const emptyBootstrap = hub.snapshotFor({});
  assert.equal(emptyBootstrap.liveSessionId, "current-session");
  assert.deepEqual(emptyBootstrap.events, []);

  const captionOnly = hub.ingest({
    type: "subtitle:committed",
    source: "microphone",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Caption-only remains independent.",
  });
  assert.equal("displayTimestamp" in captionOnly, false);

  for (const translatedText of ["Current sentence one.", "Current sentence two.", "Current sentence three."]) {
    hub.ingest({
      type: "subtitle:committed",
      source: "live-call",
      liveSessionId: "current-session",
      targetLanguage: "en",
      sourceLanguage: "ko",
      translatedText,
    });
  }

  const snapshot = hub.snapshotFor({});
  assert.equal(snapshot.liveSessionId, "current-session");
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(snapshot.events.map((event) => event.translatedText), [
    "Current sentence two.",
    "Current sentence three.",
  ]);
  assert.equal(snapshot.events.every((event) => event.liveSessionId === "current-session"), true);
  assert.equal(snapshot.events.every((event) => Number.isFinite(event.displayTimestamp)), true);
  assert.equal(snapshot.events[0].seq < snapshot.events[1].seq, true);
  assert.equal(snapshot.events.some((event) => event.source === "microphone"), false);
  assert.equal(snapshot.lanes.some((event) => event.source === "microphone"), true,
    "Caption-only lanes must retain their existing snapshot behavior");
});

test("validated Live Call identity survives server fan-out under a dedicated field", () => {
  const relayStart = serverSource.indexOf('if (message.type === "subtitle:live-call-caption")');
  const relayEnd = serverSource.indexOf('if (message.type === "subtitle:mirror")', relayStart);
  assert.ok(relayStart >= 0 && relayEnd > relayStart);
  const relay = serverSource.slice(relayStart, relayEnd);
  assert.match(relay, /relaySessionId !== liveCallCaptionSessionId/u);
  // The broadcast line is built once (stale finals reuse it for records-only
  // delivery) and must carry the validated id under the dedicated field.
  assert.match(relay, /const line = \{[\s\S]*liveSessionId:\s*relaySessionId[\s\S]*\};[\s\S]*broadcastSubtitleMessage\(line\)/u);
  assert.doesNotMatch(relay, /\bsessionId:\s*relaySessionId/u,
    "the external gateway field must be renamed after exact-session validation");
});

test("overlay snapshot bootstraps one session atomically and live events reject cross-session replay", () => {
  const snapshotStart = overlaySource.indexOf("function replaceLiveCallSubtitleSnapshot");
  const snapshotEnd = overlaySource.indexOf("\nfunction adoptSubtitleStream", snapshotStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
  const snapshot = overlaySource.slice(snapshotStart, snapshotEnd);
  assert.match(snapshot, /new Set\([\s\S]*event\.liveSessionId/u);
  assert.match(snapshot, /snapshotSessionIds\.size !== 1/u);
  assert.match(snapshot, /activeLiveCallSessionId[\s\S]*snapshotSessionId/u);
  assert.match(snapshot, /events\.every\(\(event\) => event\.liveSessionId === snapshotSessionId\)/u,
    "one valid id must not smuggle sessionless events into an accepted snapshot");
  const singleSessionFence = snapshot.indexOf("snapshotSessionIds.size !== 1");
  const activeSessionFence = snapshot.indexOf("activeLiveCallSessionId !== snapshotSessionId");
  const everyEventFence = snapshot.indexOf("events.every");
  const clear = snapshot.indexOf("clearSubtitle()");
  const render = Math.min(
    ...[snapshot.indexOf("renderCommittedSubtitle"), snapshot.indexOf("renderPredictedSubtitle")]
      .filter((index) => index >= 0),
  );
  assert.ok(singleSessionFence >= 0 && activeSessionFence >= 0 && everyEventFence >= 0
    && clear > singleSessionFence && clear > activeSessionFence && clear > everyEventFence && render > clear,
    "a canonical snapshot must replace, not append to, per-window sentence state");

  const messageHandlerStart = overlaySource.indexOf('ws.addEventListener("message"');
  const messageHandlerEnd = overlaySource.indexOf('ws.addEventListener("close"', messageHandlerStart);
  const messageHandler = overlaySource.slice(messageHandlerStart, messageHandlerEnd);
  const snapshotBranchStart = messageHandler.indexOf('message.type === "subtitle:snapshot"');
  const snapshotBranchEnd = messageHandler.indexOf("// The server already filters", snapshotBranchStart);
  const snapshotBranch = messageHandler.slice(snapshotBranchStart, snapshotBranchEnd);
  const snapshotReplace = snapshotBranch.indexOf("replaceLiveCallSubtitleSnapshot(message)");
  const snapshotSequenceMutation = snapshotBranch.indexOf("snapshotSeqFloor =");
  assert.ok(snapshotReplace >= 0 && snapshotReplace < snapshotSequenceMutation,
    "an old-session snapshot must be rejected before it can raise the current sequence floor");
  const sessionFence = messageHandler.indexOf("message.liveSessionId");
  const partialRender = messageHandler.indexOf("renderPredictedSubtitle(message)");
  const committedRender = messageHandler.indexOf("renderCommittedSubtitle(message)");
  assert.match(messageHandler, /message\.source === "live-call"/u);
  assert.match(messageHandler, /activeLiveCallSessionId && message\.liveSessionId !== activeLiveCallSessionId/u);
  assert.match(messageHandler, /!allowsLegacySessionlessLiveCallEvents[\s\S]{0,100}!activeLiveCallSessionId \|\| message\.liveSessionId !== activeLiveCallSessionId/u);
  assert.match(overlaySource, /allowsLegacySessionlessLiveCallEvents = !hasTrustedLiveCallFloorBridge/u,
    "Electron overlays must fail closed while legacy browser-only fixtures remain compatible");
  assert.ok(sessionFence >= 0 && sessionFence < partialRender && sessionFence < committedRender,
    "old-session WebSocket captions must be fenced before either render path");

  const overlayCreation = sourceBetween("function createOverlayWindowForDisplay", "function syncOverlayBounds");
  assert.match(overlayCreation, /webContents\.on\("did-finish-load"[\s\S]*liveGatewayBridge\?\.lastFloorMessage/u);
  assert.match(overlayCreation, /liveGatewayBridge\?\.ready === true/u);
  assert.match(overlayCreation, /floor\.sessionId === liveGatewayBridge\.session\?\.sessionId/u);
  assert.match(overlayCreation, /window\.webContents\.send\("live-call:floor", floor\)/u,
    "a switched or hot-plugged display needs the exact current session before strict caption filtering");
  assert.match(overlayCreation, /isCurrentOverlayWindow\(window, displayId\)/u,
    "a superseded overlay must not replay a current or previous session after display switching");
  assert.match(mainSource, /const overlayWindows = new Map\(\)/u);
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
