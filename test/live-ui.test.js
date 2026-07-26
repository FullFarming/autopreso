import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MESSAGES } from "../public/subtitle-i18n.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// UI copy moved into the i18n dictionary: a surface now carries the KEY, and the
// text has to resolve in both supported languages.
/** @param {string} key @param {{ en?: RegExp, ko?: RegExp }} [patterns] */
function assertLocalized(key, { en, ko } = {}) {
  assert.equal(typeof MESSAGES.en[key], "string", `missing en copy for ${key}`);
  assert.equal(typeof MESSAGES.ko[key], "string", `missing ko copy for ${key}`);
  if (en) assert.match(MESSAGES.en[key], en);
  if (ko) assert.match(MESSAGES.ko[key], ko);
}

test("host page exposes Presentation and Meeting without legacy Townhall or PTT UI", async () => {
  const [page, dashboard] = await Promise.all([
    read("webapp/app/page.tsx"),
    read("webapp/components/live/LiveHostDashboard.tsx"),
  ]);

  assert.match(page, /LiveHostDashboard/);
  assert.doesNotMatch(page, /MeetingMode/);
  assert.match(dashboard, /presentation/);
  assert.match(dashboard, /meeting/);
  assert.doesNotMatch(dashboard, /townhall/i);
  assert.match(dashboard, /languages\.length >= 3/);
});

test("host wizard offers canonical output modes and Meeting audio consent", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /translated audio/);
  assert.match(dashboard, /guest chooses to play it/);
  assert.match(dashboard, /SESSION_LANGUAGE_HELP\[sessionType\]/);
  assert.match(dashboard, /presentation: "English is the default translation language/);
  assert.match(dashboard, /meeting: "Meeting provides speaker-aware captions/);
  assert.match(dashboard, /value: "captions"/);
  // Translated-audio delivery is hidden at this stage: only captions cross to
  // participants, get recorded on the host, and flow in real time. The contract
  // and pipeline still accept the audio modes -- this is a hidden option, not a
  // removed capability.
  assert.doesNotMatch(dashboard, /value: "captions_audio"/);
  assert.doesNotMatch(dashboard, /value: "audio"/);
  assert.match(dashboard, /useState<LiveOutputMode>\("captions"\)/);
  assert.match(dashboard, /Speaker-aware translated audio/);
});

test("live UI separates fixed Gemini captions from a real Presentation audio provider toggle", async () => {
  const [dashboard, viewer, extensionHtml, extensionJs] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/LiveViewer.tsx"),
    read("chrome-extension/sidepanel.html"),
    read("chrome-extension/sidepanel.js"),
  ]);

  assert.match(dashboard, /Fast live captions/);
  assert.match(dashboard, /OpenAI Realtime audio/);
  assert.match(dashboard, /Optimized for one presenter/);
  assert.match(dashboard, /Speaker-aware translated audio/);
  assert.match(dashboard, /Long uninterrupted speech may add delay/);
  assert.match(dashboard, /role="radiogroup" aria-label="Translated audio engine"/);
  assert.match(dashboard, /Gemini audio/);
  assert.match(dashboard, /OpenAI Realtime/);
  assert.match(dashboard, /Caption engine/);
  assert.match(dashboard, /Gemini fixed/);
  assert.match(dashboard, /disabled=\{sessionType === "meeting" \|\| !isOpenAIVoiceLanguageSupported\}/);
  assert.match(dashboard, /Meeting uses Gemini audio to keep one stable voice for each speaker/);
  assert.match(viewer, /live-viewer-delivery-method/);
  assert.match(viewer, /Current delivery/);
  assert.match(extensionHtml, /id="viewer-output-state"/);
  assert.match(extensionJs, /빠른 실시간 자막/);
  assert.match(extensionJs, /안정적인 AI 음성/);
  assert.match(extensionJs, /화자 구분 · 발화 종료 후 출력/);
});

test("host capacity and glossary controls expose product constraints", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /type="range" min=\{1\} max=\{50\}/);
  assert.match(dashboard, /Limit entry from 1 to 50 guests/);
  assert.match(dashboard, /general_cre/);
  assert.match(dashboard, /Hotel/);
  assert.match(dashboard, /F&B/);
  assert.match(dashboard, /disabled=\{sessionType === "presentation"\}/);
  assert.match(dashboard, /presentation streaming model does not support glossary instructions/);
  assert.match(dashboard, /Apply base phrases and the selected industry glossary/);
  assert.match(dashboard, /Not applied · Meeting only/);
});

test("host sends canonical session settings through REST and gateway", async () => {
  const [dashboard, audioClient] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/live-audio-client.ts"),
  ]);

  assert.match(dashboard, /body: JSON\.stringify\(\{ title, scheduledAt: currentSchedule\.scheduledAt, sessionType, languages, outputMode, voiceProvider, maxViewers, glossaryPack \}\)/);
  assert.match(dashboard, /sessionType: previousSession\.sessionType/);
  assert.match(dashboard, /outputMode: previousSession\.outputMode/);
  assert.match(dashboard, /voiceProvider: previousSession\.voiceProvider/);
  assert.match(dashboard, /maxViewers: previousSession\.maxViewers/);
  assert.match(dashboard, /glossaryPack: previousSession\.glossaryPack/);
  assert.match(dashboard, /version: restoredSession\.version/);
  assert.match(dashboard, /version: session\.version/);
  assert.match(audioClient, /sessionType: LiveSessionType/);
  assert.match(audioClient, /outputMode: LiveOutputMode/);
  assert.match(audioClient, /maxViewers: number/);
  assert.match(audioClient, /glossaryPack: GlossaryPack/);
  const createSessionBlock = dashboard.match(/const createSession = useCallback[\s\S]*?const stopBroadcast/u)?.[0] ?? "";
  assert.match(createSessionBlock, /JSON\.stringify\(\{ title, scheduledAt: currentSchedule\.scheduledAt, sessionType, languages, outputMode, voiceProvider, maxViewers, glossaryPack \}\)/);
  assert.doesNotMatch(createSessionBlock, /JSON\.stringify\([\s\S]*inputSource/u,
    "capture-only inputSource must not be sent to the strict persisted-session API");
});

test("host gateway contract sends the optimistic session version on start, update, and reconnect", async () => {
  const audioClient = await read("webapp/components/live/live-audio-client.ts");

  assert.match(audioClient, /interface AudioClientOptions\s*\{[\s\S]*?version:\s*number;/u);
  assert.match(audioClient, /interface LiveAudioSettings\s*\{[\s\S]*?version:\s*number;/u);
  assert.match(audioClient, /let currentSettings: LiveAudioSettings = \{\s*version: options\.version,/u);
  assert.match(audioClient, /type: "start",\s*sessionId: options\.sessionId,\s*version: settings\.version,/u);
  assert.match(audioClient, /type: "update",\s*sessionId: options\.sessionId,\s*version: settings\.version,/u);
  assert.match(audioClient, /currentSettings = \{\s*version: settings\.version,/u);
  assert.match(audioClient, /openSocket\(options, credentials, currentSettings/u);
  assert.match(audioClient, /Number\.isSafeInteger\(version\)/u);
});

test("speaker legend and viewer surfaces expose non-color voice state and audio provenance", async () => {
  const [dashboard, viewer, panel] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/LiveViewer.tsx"),
    read("chrome-extension/sidepanel.html"),
  ]);

  assert.doesNotMatch(dashboard, /음역 ·/);
  assert.match(dashboard, /Analyzing voice/);
  assert.match(dashboard, /Voice ready/);
  assert.match(dashboard, /Unavailable/);
  assert.match(viewer, /getSpeakerVoiceStatus/);
  assert.match(viewer, /Audio ·/);
  assert.match(viewer, /Translated audio/);
  assert.match(panel, /자막 모드에서는 AI 합성 음성을 사용하지 않습니다/);
  assert.match(panel, /Meeting의 AI 합성 통역 음성/);
});

test("viewer and Chrome derive output display from canonical outputMode", async () => {
  const [viewer, panel, panelScript] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("chrome-extension/sidepanel.html"),
    read("chrome-extension/sidepanel.js"),
  ]);

  assert.match(viewer, /isLiveOutputMode/);
  assert.match(viewer, /outputMode: snapshot\.session\.outputMode/);
  assert.match(viewer, /realtime-noel-viewer-state/);
  assert.match(panel, /viewer-output-state/);
  assert.match(panelScript, /realtime-noel-viewer-state/);
  assert.match(panelScript, /outputMode === "audio"/);
  assert.match(panelScript, /outputMode === "captions_audio"/);
});

test("viewer uses one gateway socket for captions, control events, and interpretation audio", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");

  assert.doesNotMatch(viewer, /RealtimeChannel|channelRef|\.channel\(|realtime\.setAuth/);
  assert.match(viewer, /event\.type === "live-event"/);
  assert.match(viewer, /parseBroadcastEvent\(event\.payload \?\? event\.event\)/);
  assert.match(viewer, /hasConnected/);
  assert.match(viewer, /snapshot\?language=/);
  assert.match(viewer, /type: "subscribe",\s*sessionId: currentViewer\.session\.id,\s*language: nextLanguage,\s*lastSeq: getLastSeq\(nextLanguage\)/);
});

test("host hot-swap compensates the API version and fails closed when restoration fails", async () => {
  const [dashboard, audioClient] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/live-audio-client.ts"),
  ]);

  assert.match(dashboard, /version:\s*next\.version/);
  assert.match(dashboard, /sessionType:\s*previousSession\.sessionType/);
  assert.match(dashboard, /await stopBroadcast\(\)/);
  assert.match(dashboard, /Settings could not be restored, so broadcasting stopped/);
  assert.match(audioClient, /onLanguageStatus/);
  assert.doesNotMatch(dashboard, /session \? "Ready"/);
});

test("host fail-close keeps the restored DB version when gateway compensation cannot resync", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /let restoredSession: LiveSession \| null = null/);
  assert.match(dashboard, /restoredSession = await readResponse<LiveSession>/);
  assert.match(dashboard, /const failedSession = restoredSession \?\? next/);
  assert.match(dashboard, /setSession\(failedSession\)/);
  assert.match(dashboard, /setSessionType\(failedSession\.sessionType\)/);
  assert.match(dashboard, /setLanguages\(\[\.\.\.failedSession\.languages\]\)/);
  assert.match(dashboard, /version: restoredSession\.version/);
});

test("gateway language status listener is persistent before start and dashboard never blankets ready", async () => {
  const [dashboard, audioClient] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/live-audio-client.ts"),
  ]);

  assert.match(audioClient, /await authenticated;\s*attachPersistentListeners\(socket\);\s*const started/s);
  assert.match(audioClient, /attachedSockets\.has\(candidate\)/);
  assert.doesNotMatch(dashboard, /languageStatusMap\([^\n]+,\s*"ready"\)/);
  assert.match(dashboard, /onLanguageStatus/);
});

test("host and viewer share bounded jittered reconnect policy and preserve proactive refresh", async () => {
  const [policy, hostClient, viewer] = await Promise.all([
    read("webapp/components/live/connection-resilience.ts"),
    read("webapp/components/live/live-audio-client.ts"),
    read("webapp/components/live/LiveViewer.tsx"),
  ]);

  assert.match(policy, /RECONNECT_BASE_MILLISECONDS = 500/);
  assert.match(policy, /RECONNECT_MAX_MILLISECONDS = 30_000/);
  assert.match(policy, /Math\.random/);
  assert.match(hostClient, /getReconnectDelayMilliseconds/);
  assert.match(viewer, /getReconnectDelayMilliseconds/);
  assert.match(hostClient, /50 \* 60 \* 1_000/);
  assert.match(hostClient, /credentials\.expiresAt/);
  assert.match(hostClient, /Math\.min\(50 \* 60 \* 1_000/);
  assert.match(viewer, /50 \* 60 \* 1_000/);
  assert.doesNotMatch(hostClient, /reconnectTimer = window\.setTimeout\([^\n]+, 1_000\)/);
  assert.doesNotMatch(viewer, /audioReconnectTimerRef\.current = window\.setTimeout\([^\n]+, 1_000\)/);
});

test("host credentials fail closed before expiry can create a proactive reconnect loop", async () => {
  const hostClient = await read("webapp/components/live/live-audio-client.ts");

  assert.match(hostClient, /function getGatewayCredentialRefreshDelay/);
  assert.match(hostClient, /Number\.isFinite\(expiresAtMilliseconds\)/);
  assert.match(hostClient, /expiresAtMilliseconds - nowMilliseconds <= 60_000/);
  assert.match(hostClient, /getGatewayCredentialRefreshDelay\(options\.credentials\)/);
  assert.match(hostClient, /getGatewayCredentialRefreshDelay\(credentials\)/);
  assert.doesNotMatch(hostClient, /Number\.isFinite\(expiresAtMilliseconds\)[\s\S]{0,200}\? Math\.max\(RECONNECT_BASE_MILLISECONDS/);
});

test("desktop subtitle workspace starts Live Call without a web workspace launcher", async () => {
  const [html, script, workspace] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle-dashboard.js"),
    read("public/subtitle-workspace.js"),
  ]);
  assert.match(html, /id="schedule-live-call"[^>]*data-i18n="live\.start"/);
  assertLocalized("live.start", { en: /Start Live Call/ });
  assert.doesNotMatch(html, /id="open-meeting-mode"|data-open-live-workspace|>Open Live Call</);
  assert.doesNotMatch(script, /open-meeting-mode|data-open-live-workspace|openLiveWorkspace|realtime-noel-web\.vercel\.app/);
  assert.match(workspace, /await bridge\.startLiveCall\(draft\)/);
  assert.match(workspace, /coverImage: liveDraftCoverData/);
});

test("desktop and mobile watch routes share the same viewer component", async () => {
  const [desktop, mobile] = await Promise.all([
    read("webapp/app/watch/page.tsx"),
    read("webapp/app/m/watch/page.tsx"),
  ]);

  assert.match(desktop, /LiveViewer/);
  assert.match(desktop, /compact=\{false\}/);
  assert.match(mobile, /LiveViewer/);
  assert.match(mobile, /compact/);
});

test("viewer routes preserve QR fragments while correcting iPhone and iPad surfaces", async () => {
  const [viewer, routing, routingTest] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/viewer-surface-routing.ts"),
    read("webapp/components/live/viewer-surface-routing.test.ts"),
  ]);

  assert.match(routing, /pathname === "\/m\/watch" && isIpadUserAgent/u);
  assert.match(routing, /pathname === "\/watch" && \/\\b\(\?:iPhone\|iPod\)\\b\//u);
  assert.match(routing, /`\$\{target\}\$\{search\}\$\{hash\}`/u);
  assert.match(routingTest, /opaque%2Btoken%3D/u);
  const redirectIndex = viewer.indexOf("window.location.replace(buildViewerSurfaceUrl");
  const consumeIndex = viewer.indexOf("const inviteToken = takeInviteTokenFromHash()");
  assert.ok(redirectIndex >= 0 && consumeIndex > redirectIndex,
    "surface correction must run before the QR fragment is consumed");
  assert.match(viewer, /if \(getViewerSurfaceRedirect\([\s\S]*?\)\) return;[\s\S]*?takeInviteTokenFromHash\(\)/u);
});

test("mobile viewer reconnects once on foreground and keeps full history accessible", async () => {
  const [viewer, recovery, feed, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/foreground-recovery.ts"),
    read("webapp/components/live/MeetingTurnFeed.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(recovery, /if \(state\.inFlight\) return state\.inFlight/u);
  assert.match(viewer, /document\.addEventListener\("visibilitychange"/u);
  assert.match(viewer, /window\.addEventListener\("pageshow"/u);
  assert.match(viewer, /window\.addEventListener\("online"/u);
  assert.match(viewer, /disconnectGateway\(\);[\s\S]*?const recoveryGeneration = audioConnectionGenerationRef\.current/u);
  assert.match(viewer, /expectedConnectionGeneration !== audioConnectionGenerationRef\.current\) return/u);
  assert.match(feed, /turns\.map\(/u, "the complete transcript must remain in the DOM");
  assert.match(css, /content-visibility: auto/u);
  assert.match(css, /contain-intrinsic-size: auto 96px/u);
  assert.match(css, /\.live-viewer-shell\.is-compact \.live-language-switch button \{ min-width: 44px; min-height: 44px;/u);
  assert.match(css, /\.live-viewer-shell\.is-compact \.live-language-switch button:focus-visible[\s\S]*?outline: 2px solid var\(--nova-blue\)/u);
});

test("speaker captions never identify a speaker by color alone", async () => {
  const component = await read("webapp/components/live/SpeakerCaption.tsx");
  const css = await read("webapp/app/globals.css");

  assert.match(component, /speaker\.label/);
  assert.match(component, /aria-label/);
  assert.match(component, /live-speaker-dot/);
  assert.match(component, /live-speaker-line/);
  assert.doesNotMatch(component, /borderLeftColor/);
  assert.doesNotMatch(css, /\.live-caption-card\s*\{[^}]*border-left:/s);
});

test("host, viewer, and Chrome expose the same approved language set with three-output selection", async () => {
  const [dashboard, viewer, panel, css, extensionCss, languageRegistry] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/LiveViewer.tsx"),
    read("chrome-extension/sidepanel.html"),
    read("webapp/app/globals.css"),
    read("chrome-extension/sidepanel.css"),
    read("webapp/lib/languageDetect.ts"),
  ]);
  const codes = ["en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt", "fr", "de", "ru", "hi", "id", "vi", "it"];

  for (const code of codes) {
    assert.match(languageRegistry, new RegExp(`"${code}"`));
    assert.match(panel, new RegExp(`value="${code}"`));
  }
  assert.match(dashboard, /LANGUAGE_CODES\.map/);
  assert.match(dashboard, /LANGUAGE_LABELS/);
  assert.match(dashboard, /languages\.length >= 3/);
  assert.match(viewer, /languageLabel/);
  assert.match(css, /--font-sans: "Pretendard"/);
  assert.match(extensionCss, /font-family: "Pretendard"/);
});

test("owned user-visible surfaces carry the current product name", async () => {
  const paths = [
    "public/index.html", "public/app.js", "public/starter-elements.js",
    "public/subtitle.html", "public/subtitle-controller.html", "public/subtitle-overlay.html",
    "public/subtitle-dashboard.js", "electron/main.js", "webapp/components/usePipOverlay.ts",
    "chrome-extension/manifest.json", "chrome-extension/sidepanel.html",
  ];
  const sources = await Promise.all(paths.map(read));
  const joined = sources.join("\n");
  // The desktop subtitle product is NOVA. The whiteboard pages (index.html /
  // app.js) are a separate product and keep their own name, and the webapp is a
  // separately deployed guest surface -- neither is renamed here.
  assert.match(joined, /NOVA/);
  assert.doesNotMatch(joined, /Realtime_Noel|AutoPreso|Auto Preso/);
});

test("web chrome uses a restrained flat canvas and Pretendard without decorative orb gradients", async () => {
  const css = await read("webapp/app/globals.css");

  assert.match(css, /--canvas:\s*#f5f5f7/i);
  assert.match(css, /--font-sans:\s*"Pretendard"/);
  assert.match(css, /\.lg-bg\s*\{[^}]*background:\s*var\(--canvas\)/s);
  assert.doesNotMatch(css, /radial-gradient|lg-bg-drift/);
  assert.doesNotMatch(css, /\.glass(?:-strong|-pill)?\s*\{[^}]*backdrop-filter:/s);
  assert.doesNotMatch(css, /\.live-caption-card\s*\{[^}]*border-left:/s);
});

test("Chrome extension is MV3, narrow-permission, and packaged-code only", async () => {
  const [rawManifest, panel, panelScript] = await Promise.all([
    read("chrome-extension/manifest.json"),
    read("chrome-extension/sidepanel.html"),
    read("chrome-extension/sidepanel.js"),
  ]);
  const manifest = JSON.parse(rawManifest);

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://realtime-noel-web.vercel.app/*"]);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.doesNotMatch(panel, /<script[^>]+src=["']https?:\/\//i);
  assert.doesNotMatch(panelScript, /searchParams\.set\(["']code["']/, "admission code must not enter URL logs");
  assert.match(panelScript, /postMessage/);
});

test("Chrome 114 uses a muted canvas video PiP fallback and QR entry stays minimal", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");

  assert.match(viewer, /captureStream/);
  assert.match(viewer, /requestPictureInPicture/);
  assert.match(viewer, /video\.muted = true/);
  assert.match(viewer, /live-join-wordmark/);
});

test("Meeting audio surfaces disclose AI synthetic interpretation before user-gesture playback", async () => {
  const [viewer, panel] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("chrome-extension/sidepanel.html"),
  ]);

  assert.match(viewer, /Translated audio/);
  assert.match(viewer, /aria-pressed=\{isInterpretationAudioEnabled\}/);
  assert.match(viewer, /aria-label=\{isInterpretationAudioEnabled \? "Translated audio is on" : "Turn translated audio on"\}/);
  assert.match(panel, /AI 합성 통역 음성/);
});

test("interpretation WebAudio queue keeps long speech and restarts only its bounded playback queue", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");

  assert.match(viewer, /projectedQueueDuration = queueAhead \+ buffer\.duration \/ playbackRate/);
  assert.doesNotMatch(viewer, /projectedQueueDuration > 3/);
  assert.match(viewer, /MAX_INTERPRETATION_QUEUE_SECONDS\s*=\s*30/);
  assert.match(viewer, /MAX_INTERPRETATION_PLAYBACK_RATE\s*=\s*1\.6/);
  assert.match(viewer, /getAdaptiveInterpretationPlaybackRate/);
  assert.match(viewer, /source\.playbackRate\.value = playbackRate/);
  assert.match(viewer, /buffer\.duration \/ playbackRate/);
  assert.match(viewer, /MAX_INTERPRETATION_QUEUE_BYTES/);
  assert.match(viewer, /restartQueue/);
  assert.match(viewer, /scheduledSourcesRef/);
  assert.match(viewer, /audioPendingSocketRef/);
  assert.match(viewer, /pendingSocket\?\.close/);
  assert.match(viewer, /source\.stop\(\)/);
  assert.match(viewer, /audioConnectionGenerationRef\.current \+= 1/);
  assert.match(viewer, /window\.clearTimeout\(audioReconnectTimerRef\.current\)/);
  assert.match(viewer, /window\.clearTimeout\(audioProactiveTimerRef\.current\)/);
  assert.match(viewer, /clearInterpretationAudio\(\)/);
});

test("gateway slow-consumer close automatically reconnects without clearing the selected language", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");

  assert.match(viewer, /if \(event\.code === 4408 \|\| event\.reason\.includes\("SLOW_CONSUMER"\)\) \{[\s\S]{0,500}restartInterpretationAudio\(\)[\s\S]{0,500}scheduleReconnect\(\)/);
  assert.doesNotMatch(viewer, /합성 통역 음성이 3초 이상 지연/);
  assert.match(viewer, /Audio restored/);
  assert.match(viewer, /event\.type === "audio-control"/);
  assert.match(viewer, /minimumAudioSeqRef\.current = Math\.max\(minimumAudioSeqRef\.current, event\.seq\)/);
  assert.match(viewer, /event\.header\.seq <= minimumAudioSeqRef\.current \|\| event\.header\.seq <= lastAudioSeqRef\.current/);
  assert.match(viewer, /className="live-connection-state" role="status" aria-live="polite"/);
});

test("viewer keeps one stable partial row and archives only final captions after the snapshot floor", async () => {
  const [viewer, speaker, captionFeed] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/SpeakerCaption.tsx"),
    read("webapp/lib/live/caption-feed.ts"),
  ]);

  // 2026-07-26 fix: Timeline identity and ordering are shared by snapshot,
  // WebSocket, host, and participant events, so the merge contract belongs in
  // the feed module rather than as a private Viewer implementation detail.
  assert.match(captionFeed, /export function mergeCaptionTimeline/);
  assert.match(viewer, /mergeLanguageCaptionCache/);
  assert.match(viewer, /key=\{`final-\$\{caption\.seq\}`\}/);
  assert.match(viewer, /key=\{`partial-\$\{captionLaneKey\(caption\)\}`\}/);
  // Finals and partials are split out of displayCaptions, not the raw record.
  // Web history shows source speech in its own selected language lane and hides
  // only failed translations.
  assert.match(viewer, /const displayCaptions = useMemo\(\(\) => captions\.filter\(isDisplayableCaption\), \[captions\]\)/);
  assert.match(captionFeed, /if \(caption\.origin === "source"\) return true/u);
  assert.match(captionFeed, /incoming\.filter\(\(event\) => event\.language === language\)/u);
  assert.match(viewer, /const finalCaptions = displayCaptions\.filter\(\(caption\) => caption\.isFinal\)/);
  assert.match(viewer, /const partialCaptions = displayCaptions\.filter\(\(caption\) => !caption\.isFinal\)/);
  assert.match(viewer, /<MeetingTurnFeed captions=\{displayCaptions\}/);
  assert.match(viewer, /event\.seq <= getLastSeq\(event\.language\)/);
  assert.match(viewer, /if \(event\.language === languageRef\.current\) setCaptions/u);
  assert.match(viewer, /setCaptionSnapshot\(snapshot\)/);
  assert.match(viewer, /aria-relevant="additions"/);
  assert.match(viewer, /aria-live="off"/);
  assert.match(speaker, />Listening</);
  assert.doesNotMatch(speaker, /인식 중/);
});

test("the live UI consumes the lossless language cache and append-only partial tail", async () => {
  const [viewer, feed, captionFeed, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/MeetingTurnFeed.tsx"),
    read("webapp/lib/live/caption-feed.ts"),
    read("webapp/app/globals.css"),
  ]);

  // 2026-07-26 fix: These checks bind the tested 5,000-event data contract to
  // the actual screen path. A green cache-only test is insufficient if the
  // language selector clears that cache or the feed remounts partial text.
  assert.match(captionFeed, /const COMMITTED_CAPTION_LIMIT = 5_000/u);
  assert.doesNotMatch(captionFeed, /CAPTION_WINDOW_SIZE|slice\(-200\)/u);
  assert.match(viewer, /const captionsByLanguageRef = useRef<Record<string, CaptionEvent\[\]>>\(\{\}\)/u);
  assert.match(viewer, /setCaptions\(getCachedLanguageCaptions\(captionsByLanguageRef\.current, nextLanguage\)\)/u);
  assert.match(viewer, /mergeLanguageCaptionCache\(captionsByLanguageRef\.current, event\.language, \[event\]\)/u);
  assert.match(feed, /pendingText=\{livePartialBelongsToLastTurn/u);
  assert.match(feed, /className="live-turn-text is-recent is-pending" data-caption-state="updating"/u);
  assert.doesNotMatch(feed, /live-turn-card\.is-collapsed|collapsedTurnKeys/u);

  // DESIGN.md §8.2: pending text keeps its layout and uses the semantic system
  // blue dashed underline rather than introducing a new colour or spinner.
  assert.match(css, /\.live-turn-card p \.live-turn-text\.is-pending\s*\{[^}]*text-decoration:\s*underline dashed var\(--nova-blue\) 1px;[^}]*text-underline-offset:\s*\.2em;/su);
});

test("desktop Live workspace exposes only the local Start action", async () => {
  const [html, script, workspace] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle-dashboard.js"),
    read("public/subtitle-workspace.js"),
  ]);

  assert.match(html, /id="schedule-live-call"[^>]*data-i18n="live\.start"/);
  assertLocalized("live.start", { en: /Start Live Call/ });
  assert.doesNotMatch(html, /id="open-meeting-mode"|data-open-live-workspace|>Open Live Call</);
  assert.doesNotMatch(script, /openLiveWorkspace|window\.open\("https:\/\/realtime-noel-web\.vercel\.app\//);
  assert.match(workspace, /t\("live\.stageUp", \{ code: result\.admissionCode/);
  assertLocalized("live.stageUp", { en: /access code \{code\}/, ko: /입장 코드 \{code\}/ });
  assert.match(workspace, /result\?\.code === "HOST_LOGIN_REQUIRED"/);
});

test("host creates mobile fragment-only invite links and exposes QR, persistent code, viewers, and status", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /fetch\(`\/api\/live-sessions\/\$\{session\.id\}\/invites`/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ action: "create" \}\)/);
  assert.match(dashboard, /\/m\/watch#invite=\$\{encodeURIComponent\(inviteResult\.inviteToken\)\}/);
  assert.doesNotMatch(dashboard, /\/m\/watch\?invite=/);
  assert.match(dashboard, /navigator\.clipboard\.writeText\(invite\.url\)/);
  assert.match(dashboard, /Copy link/);
  assert.match(dashboard, /Invite by email/);
  assert.match(dashboard, /mailto:/);
  assert.match(dashboard, /Guest QR/);
  assert.match(dashboard, /6-digit access code/);
  assert.match(dashboard, /invite\.admissionCode/);
  assert.match(dashboard, /Valid until the host ends this session/);
  assert.match(dashboard, /Guests/);
  assert.match(dashboard, /Guest access/);
  assert.match(dashboard, /Status/);
});

test("every host invite path adopts the returned optimistic session version before Start Live", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /interface InviteResult \{[\s\S]*version: number;/);
  assert.equal((dashboard.match(/readResponse<InviteResult>/g) ?? []).length, 4);
  assert.equal((dashboard.match(/version: inviteResult\.version/g) ?? []).length, 4);
  assert.equal((dashboard.match(/admissionOpenUntil: inviteResult\.expiresAt/g) ?? []).length, 4);
  assert.match(dashboard, /setSession\(\(current\) => current\?\.id === next\.id[\s\S]{0,180}version: inviteResult\.version/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ version: session\.version \}\)/);
});

test("host renders an offline QR invitation with accessible fallback", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /import QRCode from "qrcode"/);
  assert.match(dashboard, /QRCode\.toDataURL\(value/);
  assert.match(dashboard, /errorCorrectionLevel: "M"/);
  assert.match(dashboard, /alt="NOVA guest invite QR code"/);
  assert.match(dashboard, /The QR code could not be created\. Copy the invite link instead\./);
  assert.match(dashboard, /<InviteQrCode value=\{invite\.url\} \/>/);
});

test("approved mobile live design supports profile identity and QR or access-code entry", async () => {
  const [viewer, dashboard, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, />Your name</);
  assert.match(viewer, />Department</);
  assert.match(viewer, />Job title</);
  assert.match(viewer, />6-digit access code</);
  assert.match(viewer, /"Join live"/);
  assert.match(viewer, /id="live-admission-code"/);
  assert.doesNotMatch(viewer, /내 언어로 함께 듣기/);
  // The control now discloses a slider rather than incrementing, so the label
  // names the thing it adjusts instead of promising a direction.
  assert.match(viewer, /aria-label="Caption text size"/);
  assert.match(viewer, />\s*Aa\s*</);
  assert.match(viewer, /aria-label="Leave meeting"/);
  assert.match(viewer, />Leave</);
  assert.match(viewer, /\/leave`/);
  assert.doesNotMatch(viewer, /🎙/u);
  assert.match(dashboard, /Session title/);
  assert.match(dashboard, /Date/);
  assert.match(dashboard, /Start time/);
  assert.match(dashboard, /title,\s*scheduledAt/);
  assert.match(dashboard, /"Start Live"/);
  assert.match(dashboard, /\/start`/);
  assert.match(dashboard, /const startedSession = session\.status === "live"/);
  assert.match(dashboard, /setSession\(startedSession\)/);
  // Caption text size is a continuous scale on a CSS custom property, applied on
  // BOTH routes. The old `.is-text-large`/`.is-text-largest` classes had CSS only
  // under `.is-compact`, so the control did nothing on desktop /watch.
  assert.match(css, /\.live-turn-card p \{[^}]*var\(--live-caption-scale, 1\)/s);
  assert.match(css, /\.live-viewer-shell\.is-compact \.live-turn-card p \{[^}]*var\(--live-caption-scale, 1\)/s);
  // Match the old SELECTOR shape, not prose — the replacement comment mentions
  // the retired class names by design.
  assert.doesNotMatch(css, /is-compact\.is-text-/);
});

test("join canvas keeps readable dark contrast on desktop and mobile viewports", async () => {
  const [viewer, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, /<main className=\{`live-viewer-shell is-join \$\{compact \? "is-compact" : ""\}`\}>/);
  assert.match(css, /\.live-viewer-shell\.is-join\s*\{[^}]*box-sizing:\s*border-box[^}]*width:\s*100%[^}]*min-height:\s*100dvh[^}]*background:\s*var\(--dark\)[^}]*color:\s*var\(--brand-white\)/s);
  assert.match(css, /\.live-viewer-shell\.is-join \.live-join-card > \.live-join-lede,\s*\.live-viewer-shell\.is-join \.live-join-card > \.live-join-mic-note,\s*\.live-viewer-shell\.is-join \.live-join-card label\s*\{[^}]*color:\s*var\(--brand-grey-25\)/s);
  assert.doesNotMatch(css, /\.live-viewer-shell\.is-join\s*\{[^}]*background:\s*var\(--canvas\)/s);
});

test("participant Speak is a copy-free full-width bar button that records in place", async () => {
  const [viewer, demo, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/app/m/watch/demo/page.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, /function SpeakControlIcon/);
  assert.match(viewer, /className="live-speak-microphone"/);
  assert.match(viewer, /className="live-speak-button-waves"/);
  // The mic button fills the whole bottom bar as one press target (no helper
  // copy). Speaking animates only the button — never a full-screen overlay —
  // so the caption feed stays visible; tapping while speaking stops the turn.
  assert.doesNotMatch(viewer, /live-floor-indicator/);
  assert.doesNotMatch(viewer, /live-speak-modal/);
  assert.match(viewer, /onClick=\{\(\) => void \(speakState === "speaking" \? endSpeaking\(true\) : toggleSpeak\(\)\)\}/);
  assert.match(viewer, /if \(speakStateRef\.current !== "idle"\) return;/);
  assert.match(viewer, /if \(speakStateRef\.current !== "starting"\) \{[\s\S]{0,260}type: "speak-end"/);
  assert.match(viewer, /prepareSpeakCapture\(\)/);
  assert.match(viewer, /captureError instanceof SpeakCaptureError[\s\S]{0,100}captureError\.message/);
  assert.match(demo, /<SpeakControlIcon state="speaking" \/>/);
  assert.match(demo, /className="live-speak-button is-speaking"/);
  assert.doesNotMatch(demo, />Speak</);
  assert.match(css, /\.live-speak-button\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
  assert.match(css, /\.live-speak-button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--brand-blue\)/s);
  assert.match(css, /\.live-speak-bar \.live-speak-button\s*\{[^}]*width:\s*100%/s);
  assert.doesNotMatch(css, /\.live-speak-modal/);
  assert.match(css, /\.live-speak-button\.is-speaking\s*\{[^}]*animation:\s*live-speak-recording/s);
});

test("meeting captions keep a speaker-attributed live sheet and append final turns", async () => {
  const [feed, css] = await Promise.all([
    read("webapp/components/live/MeetingTurnFeed.tsx"),
    read("webapp/app/globals.css"),
  ]);

  // Caption text lives ONLY in the main record: the in-progress utterance is
  // the newest speaker-attributed paragraph, and the mic-button sheet is a
  // floor indicator with no caption text (no duplication).
  assert.match(feed, /className="live-turn-card is-live" data-caption-state="updating"/);
  assert.match(feed, /speakerMetaLine\(livePartial\.speaker\)/);
  assert.doesNotMatch(feed, /live-now-text/);
  assert.match(feed, /turns\.map/);
  assert.match(feed, /floorHolder[\s\S]{0,400}is speaking/);
  // Scroll durability: content growth of ANY kind (partials, new paragraphs,
  // Aa text-size reflow) re-pins the newest line into view, and the sticky
  // Speak bar never hides the record's tail.
  assert.match(feed, /new ResizeObserver/);
  assert.match(feed, /live-turn-scroll-content/);
  assert.match(css, /\.live-turn-scroll\s*\{[^}]*padding-bottom:\s*calc\(84px \+ env\(safe-area-inset-bottom\)\)/s);
  assert.match(css, /@keyframes live-turn-in/);
  // Reference-app reading treatment: only the two most recently completed
  // sentences render at full strength; older sentences dim.
  assert.match(feed, /globalIndex >= turnOffsets\.total - 2/);
  assert.match(css, /\.live-turn-card p \.live-turn-text\s*\{[^}]*opacity:\s*\.42/s);
  assert.match(css, /\.live-turn-card p \.live-turn-text\.is-recent\s*\{[^}]*opacity:\s*1/s);
});

test("caption controls sit below the title and no audio control is surfaced", async () => {
  const [viewer, demo, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/app/m/watch/demo/page.tsx"),
    read("webapp/app/globals.css"),
  ]);

  // Live Call is caption-first, so the translated-audio toggle is gated to
  // audio-only sessions, where it is the entire product. A caption session never
  // shows it; an `outputMode: "audio"` session still must, or it is unusable.
  assert.match(viewer, /\{outputMode === "audio" && \(/u);
  const audioGate = viewer.indexOf('{outputMode === "audio" && (');
  const audioLabel = viewer.indexOf('{isInterpretationAudioEnabled ? "Audio On" : "Audio Off"}');
  assert.ok(audioGate >= 0 && audioLabel > audioGate, "the audio toggle must be behind the audio-only gate");
  assert.doesNotMatch(demo, /Audio On|Audio Off/u);

  for (const source of [viewer, demo]) {
    // Order: title (ViewerSessionContext) THEN the controls THEN the stage, so
    // the controls sit immediately above where captions begin.
    const title = source.indexOf("<ViewerSessionContext");
    const controls = source.indexOf('className="live-caption-controls"');
    assert.ok(title >= 0 && controls > title, "caption controls must render below the session title");
    // They must no longer live in the top toolbar.
    const toolbarEnd = source.indexOf("</header>");
    assert.ok(controls > toolbarEnd, "caption controls must be outside the top toolbar");
    assert.match(source, /className="live-language-switch"/u);
  }

  // Text size is an icon that discloses a slider, not a 3-step cycle.
  assert.match(viewer, /aria-expanded=\{isTextSizeOpen\}\s+aria-controls="live-caption-scale"/u);
  assert.match(viewer, /type="range"/u);
  assert.match(viewer, /setCaptionScale\(Number\(event\.target\.value\)\)/u);
  assert.doesNotMatch(viewer, /captionTextSize/u);
  assert.match(css, /\.live-text-size-slider\.is-open \{ display: inline-flex/u);
});

test("the in-progress sentence extends the current paragraph instead of standing alone", async () => {
  const feed = await read("webapp/components/live/MeetingTurnFeed.tsx");

  // The partial used to render as its own <article class="live-turn-card is-live">
  // BELOW the record. When it finalized it vanished from there and reappended to
  // the paragraph above, so the reader watched text get written separately and
  // then jump into the record — the reported "따로 적혔다가 다시 기록에 붙여지는"
  // behaviour. A live transcript must only ever grow at its tail.
  assert.match(feed, /pendingText/u, "the live text must be handed to the current paragraph");
  // Same speaker -> the partial is the tail of that speaker's existing paragraph.
  assert.match(feed, /livePartialBelongsToLastTurn|belongsToLastTurn/u);
  // A partial from a DIFFERENT speaker still opens its own paragraph, which is
  // correct: that is a new turn, not a continuation.
  assert.match(feed, /<article className="live-turn-card is-live"/u);
});

test("the LIVE feed never folds a speaker paragraph", async () => {
  const [feed, css] = await Promise.all([
    read("webapp/components/live/MeetingTurnFeed.tsx"),
    read("webapp/app/globals.css"),
  ]);

  // Folding was removed from the live feed on 2026-07-26. While a paragraph
  // could collapse, a speaker who said one more sentence made the feed bundle
  // and then visibly drop text — a live transcript that rewrites itself under
  // the reader. The live feed is now append-only: every sentence stays exactly
  // where it appeared. Grouping-and-folding belongs in the RECORDS view
  // (MeetingMinutes), where the transcript is static and summaries can expand
  // to the full original.
  assert.doesNotMatch(feed, /live-turn-toggle/u);
  assert.doesNotMatch(feed, /aria-expanded/u);
  assert.doesNotMatch(feed, /collapsedTurnKeys|toggleTurnCollapsed|isCollapsed/u);
  assert.doesNotMatch(feed, /live-turn-count|live-turn-chevron/u);
  assert.doesNotMatch(css, /\.live-turn-card\.is-collapsed/u);

  // The paragraph body and its speaker header stay — only the control is gone,
  // and the header must no longer be a button.
  assert.match(feed, /<p className="live-turn-body">/u);
  assert.match(feed, /<strong>\{turn\.speakerLabel\}<\/strong>/u);

  // The in-progress paragraph is still rendered inside the record.
  const liveCard = feed.match(/<article className="live-turn-card is-live"[\s\S]*?<\/article>/u);
  assert.ok(liveCard, "the live partial card must remain present");
});

test("meeting timestamps use a deterministic fixed KST clock", async () => {
  const [feed, minutes] = await Promise.all([
    read("webapp/components/live/MeetingTurnFeed.tsx"),
    read("webapp/components/live/MeetingMinutes.tsx"),
  ]);
  const turnMatch = feed.match(/export function formatTurnTime\(iso: string\): string \{\n([\s\S]*?)\n\}/u);
  const minuteMatch = minutes.match(/export function formatMinuteTime\(iso: string\): string \{\n([\s\S]*?)\n\}/u);

  assert.ok(turnMatch, "formatTurnTime must remain independently testable");
  assert.ok(minuteMatch, "formatMinuteTime must remain independently testable");
  assert.doesNotMatch(turnMatch[1], /toLocale|Intl/u);
  assert.doesNotMatch(minuteMatch[1], /toLocale|Intl/u);

  const formatTurnTime = new Function("iso", turnMatch[1]);
  const formatMinuteTime = new Function("iso", minuteMatch[1]);

  assert.equal(formatTurnTime("2026-07-23T05:00:09.000Z"), "14:00:09");
  assert.equal(formatTurnTime("2026-07-23T14:00:09+09:00"), "14:00:09");
  assert.equal(formatTurnTime("2026-07-23T15:05:07.000Z"), "00:05:07");
  assert.equal(formatTurnTime("not-a-date"), "");
  assert.equal(formatMinuteTime("2026-07-23T05:00:09.000Z"), "14:00");
  assert.equal(formatMinuteTime("2026-07-23T14:00:09+09:00"), "14:00");
  assert.equal(formatMinuteTime("2026-07-23T15:05:07.000Z"), "00:05");
  assert.equal(formatMinuteTime("not-a-date"), "");
});

test("viewer lifecycle never combines waiting and live, and announces the host-ended record", async () => {
  const [viewer, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, /sessionStatus=\{sessionStatus\}/);
  assert.match(viewer, /sessionStatus === "live"[\s\S]{0,100}\? "Live now"[\s\S]{0,100}sessionStatus === "paused" \? "Paused by host" : "Live unavailable"/);
  assert.match(viewer, /className="live-session-ended-banner" role="status" aria-live="assertive"/);
  assert.match(viewer, />Live session ended</);
  assert.match(viewer, />The host ended the call\. Your meeting record is below\.</);
  assert.match(viewer, /function isRecordingStatusEvent/);
  assert.match(viewer, /event\.type === "recording-status"[\s\S]{0,120}setError\(event\.message\)/);
  assert.match(css, /\.live-viewer-shell\.is-compact\s*\{[^}]*grid-template-rows:/s);
  assert.match(css, /\.live-viewer-shell\.is-compact \.live-viewer-footer\s*\{[^}]*min-height:\s*0/s);
});

test("live web surfaces use English copy without emoji", async () => {
  const sources = await Promise.all([
    "LiveHostDashboard.tsx",
    "LiveViewer.tsx",
    "MeetingTurnFeed.tsx",
    "SpeakerCaption.tsx",
    "MeetingMinutes.tsx",
    "MeetingSummaryCard.tsx",
    "connection-resilience.ts",
    "live-audio-client.ts",
  ].map((name) => read(`webapp/components/live/${name}`)));
  sources.push(await read("webapp/app/m/watch/demo/page.tsx"));
  const source = sources.join("\n");

  assert.doesNotMatch(source, /["'`][^"'`\n]*[가-힣][^"'`\n]*["'`]/u);
  assert.doesNotMatch(source, /[\u{1F300}-\u{1FAFF}]/u);
});

test("approved live layouts keep mobile context and desktop rail structure", async () => {
  const [viewer, demo, dashboard, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/app/m/watch/demo/page.tsx"),
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, /ViewerSessionContext title=\{viewer\.session\.title\} scheduledAt=\{viewer\.session\.scheduledAt\}/);
  assert.match(demo, /Q2 2026 Earnings Call/);
  assert.match(demo, /2026-07-23T14:00:00\+09:00/);
  assert.match(css, /\.live-viewer-shell\.is-compact \.live-viewer-toolbar \{[^}]*flex-wrap: nowrap/s);
  assert.match(css, /\.live-viewer-stage:has\(\.live-now-sheet\) \+ \.live-speak-bar/);
  assert.match(dashboard, /className="live-host-rail"/);
  assert.match(dashboard, /className="live-setup-mobile-access"/);
  assert.match(dashboard, /"Create Session"/);
  assert.match(dashboard, /placeholder="YYYY-MM-DD"/);
  assert.match(dashboard, /placeholder="HH:MM"/);
  assert.doesNotMatch(dashboard, /type="date"/);
  assert.doesNotMatch(dashboard, /type="time"/);
});

test("viewer schedule formatting is deterministic across browser engines and hydration", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");
  const functionMatch = viewer.match(/export function formatSessionSchedule\(scheduledAt: string \| null\): string \{\n([\s\S]*?)\n\}/u);

  assert.ok(functionMatch, "formatSessionSchedule must remain independently testable");
  assert.doesNotMatch(functionMatch[0], /toLocaleString|toLocaleDateString|toLocaleTimeString|Intl\./);
  const formatSessionSchedule = new Function("scheduledAt", functionMatch[1]);

  assert.equal(formatSessionSchedule(null), "Live now");
  assert.equal(formatSessionSchedule("invalid"), "Live now");
  assert.equal(formatSessionSchedule("2026-07-23T05:00:00.000Z"), "Jul 23 · 2:00 PM");
  assert.equal(formatSessionSchedule("2026-07-23T14:00:00+09:00"), "Jul 23 · 2:00 PM");
  assert.equal(formatSessionSchedule("2026-07-23T15:00:00.000Z"), "Jul 24 · 12:00 AM");
  assert.equal(formatSessionSchedule("2026-07-24T03:05:00.000Z"), "Jul 24 · 12:05 PM");
});

test("login surface is English-only", async () => {
  const login = await read("webapp/app/(login)/login/page.tsx");

  assert.match(login, /Live translated captions for your team/);
  assert.match(login, />Display name</);
  assert.match(login, />User ID</);
  assert.match(login, />Password</);
  assert.match(login, /"Sign in"/);
  assert.match(login, /Internal access only/);
  assert.doesNotMatch(login, /["'`][^"'`\n]*[가-힣][^"'`\n]*["'`]/u);
});

test("host preserves an opened admission window when invite-link creation fails", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /setAdmission\(\{ code: result\.code, openUntil \}\)[\s\S]{0,1400}catch \(inviteError\)/);
  assert.match(dashboard, /The guest window opened, but its QR invite could not be created\./);
  assert.match(dashboard, /setInvite\(null\)/);
});

test("legacy host admission helper can close without exposing a code control", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /body: JSON\.stringify\(\{ action: "open", version: session\.version \}\)/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ action: "close", version: session\.version \}\)/);
  assert.match(dashboard, /version: result\.version/);
  assert.match(dashboard, /setAdmission\(null\)/);
  assert.match(dashboard, /setInvite\(null\)/);
  assert.match(dashboard, /admissionOpenUntil: null/);
  assert.match(dashboard, /Guest entry is closed\. The live session is still running\./);
  assert.doesNotMatch(dashboard, />공유 인증번호</);
});

test("host polls viewer count and status without overlapping or overwriting edits", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /window\.setInterval\([^,]+, 5_000\)/s);
  assert.match(dashboard, /isRequestPending/);
  assert.match(dashboard, /new AbortController\(\)/);
  assert.match(dashboard, /window\.clearInterval\(timer\)/);
  assert.match(dashboard, /requestController\?\.abort\(\)/);
  assert.match(dashboard, /method: "GET"/);
  assert.match(dashboard, /viewerCount: latest\.viewerCount, status: latest\.status/);
  assert.match(dashboard, /`\$\{session\.viewerCount\} joined · \$\{formatSessionStatus\(session\.status\)\}`/);
  assert.doesNotMatch(dashboard, /setSession\(latest\)/);
});

test("viewer requires identity fields and accepts exactly one opaque invite or 6-digit access code", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");

  assert.match(viewer, /window\.location\.hash/);
  assert.match(viewer, /inviteTokenPattern/);
  assert.match(viewer, /history\.replaceState\(null, "", `\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)/);
  assert.match(viewer, /normalizeDisplayName\(displayName\)/);
  assert.match(viewer, /\.normalize\("NFC"\)\.trim\(\)/);
  assert.match(viewer, /admissionCode: normalizedAdmissionCode/);
  assert.match(viewer, /department: normalizedDepartment/);
  assert.match(viewer, /jobTitle: normalizedJobTitle/);
  assert.match(viewer, /inviteToken: pendingInviteToken/);
  assert.match(viewer, /id="live-display-name"/);
  assert.match(viewer, /id="live-department"/);
  assert.match(viewer, /id="live-job-title"/);
  assert.match(viewer, /id="live-admission-code"/);
  assert.match(viewer, /Your name/);
  assert.match(viewer, /Join live/);
  assert.match(viewer, /CAPACITY_REACHED/);
  assert.match(viewer, /INVITE_EXPIRED/);
  assert.match(viewer, /autoComplete="one-time-code"/);
  assert.match(viewer, /replace\(\/\\D\/gu, ""\)\.slice\(0, 6\)/);
  assert.doesNotMatch(viewer, /realtime-noel-viewer-join/);
  assert.doesNotMatch(viewer, /window\.addEventListener\("message"/);
});

test("host keeps captions primary and displays participant identity plus speaking activity", async () => {
  const [dashboard, hostClient, css] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/live-audio-client.ts"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(dashboard, /\/participants`/);
  assert.match(dashboard, /Promise\.all/);
  assert.match(dashboard, />Live captions</);
  assert.match(dashboard, />Participants and speaking activity</);
  assert.match(dashboard, />Department</);
  assert.match(dashboard, />Job title</);
  assert.match(dashboard, /utteranceCount/);
  assert.match(dashboard, /speakingSeconds/);
  assert.match(dashboard, /Pause captions/);
  assert.match(dashboard, /Resume captions/);
  assert.match(dashboard, />Restart caption engine</);
  assert.match(dashboard, />End session</);
  assert.match(hostClient, /type: "restart"/);
  assert.match(hostClient, /waitForMessage\(socket, "restarted"\)/);
  assert.match(css, /\.live-host-caption-stage/);
  assert.match(css, /\.live-participant-table/);
});

test("Chrome viewer passes the required normalized display name without credentials", async () => {
  const [panel, panelScript] = await Promise.all([
    read("chrome-extension/sidepanel.html"),
    read("chrome-extension/sidepanel.js"),
  ]);

  assert.match(panel, /id="display-name"[^>]*name="displayName"[^>]*required/);
  assert.doesNotMatch(panel, /type="password"/);
  assert.match(panelScript, /displayNameInput\.value\.normalize\("NFC"\)\.trim\(\)/);
  assert.match(panelScript, /displayName,/);
  assert.match(panel, /아이디와 비밀번호 없이 이름과 인증번호로 참여합니다/);
});

test("desktop local PT output separates fixed Gemini captions from conditional audio providers", async () => {
  const [html, css, dashboard] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle.css"),
    read("public/subtitle-dashboard.js"),
  ]);

  assert.match(html, /class="pt-output-group"/);
  assert.match(html, /name="outputMode"[^>]+value="captions"[^>]+checked/);
  assert.doesNotMatch(html, /name="outputMode"[^>]+value="audio"/);
  assert.match(html, /aria-labelledby="pt-output-title" hidden/);
  // The desktop PT output is captions OR interpreted audio; the mixed mode is
  // retired. (The Live Call session mode in webapp/ still has its own values,
  // constrained by an applied Supabase CHECK -- a separate change.)
  assert.doesNotMatch(html, /value="captions_audio"/);
  assert.match(html, /name="audioLanguage"/);
  assert.match(html, /name="audioVolume"[^>]+type="range"/);
  assert.match(html, /name="voiceProvider"[^>]+value="gemini"[^>]+checked/);
  assert.match(html, /name="voiceProvider"[^>]+value="openai"/);
  assert.match(html, /OpenAI Realtime/);
  // 2026-07-25 declutter, extended by the NOVA i18n pass: every explanatory
  // helper sentence is gone. The Gemini-fixed fact survives as a compact note
  // (label + value), not as a sentence.
  assert.doesNotMatch(html, /자막 엔진은 Gemini 고정이며/);
  assert.doesNotMatch(html, /pt-voice-method-help/);
  assert.match(html, /data-i18n="output\.engineNote"[\s\S]{0,80}data-i18n="output\.engineNoteValue"/);
  assertLocalized("output.engineNote", { ko: /자막 엔진/ });
  assertLocalized("output.engineNoteValue", { ko: /Gemini 고정/ });
  assert.match(html, /data-i18n="output\.systemDefault"/);
  assertLocalized("output.systemDefault", { ko: /시스템 기본 출력/ });
  assert.doesNotMatch(html, /pt-output-routing-help/);
  assert.match(css, /\.pt-output-group/);
  assert.match(css, /\.pt-output-options/);
  assert.match(dashboard, /outputMode: "captions"/);
  assert.match(dashboard, /audioLanguage: "en"/);
  assert.match(dashboard, /audioVolume: 0\.8/);
  assert.match(dashboard, /voiceProvider: "gemini"/);
  assert.match(dashboard, /OPENAI_REALTIME_TRANSLATION_LANGUAGES/);
  assert.match(dashboard, /openAIInput\.disabled = !isOpenAISupported/);
  assert.match(dashboard, /createSubtitleAudioPlayer/);
  assert.match(dashboard, /subtitle:translated-audio/);
  assert.match(dashboard, /subtitle:audio-control/);
  assert.match(dashboard, /message\.targetLanguage !== state\.settings\.audioLanguage/);
  assert.match(dashboard, /state\.settings\.voiceProvider === "openai"/);
  assert.match(dashboard, /Gemini Live:[\s\S]*OpenAI voice/);
  assert.match(dashboard, /"start\.audio"/);
  assertLocalized("start.audio", { ko: /통역 음성만 시작/ });
});

test("desktop Live Call draft always issues QR and code, validates local cover data, and keeps authorization inline", async () => {
  const [html, css, workspace] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle.css"),
    read("public/subtitle-workspace.js"),
  ]);

  assert.doesNotMatch(html, /name="liveDraftAccess"/);
  assert.doesNotMatch(html, /QR 무코드 \+ 코드 링크|코드 필수/);
  // The explanatory QR/code paragraph was deleted (no descriptive prose); the QR
  // + code contract is asserted where it is implemented instead.
  assert.doesNotMatch(html, /QR and a 6-digit access code are always created together|live-draft-access-note/);
  assert.match(workspace, /t\("live\.stageUp", \{ code: result\.admissionCode/);
  assert.match(html, /id="live-draft-cover-rules"/);
  assert.match(html, /id="live-draft-cover-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /name="liveDisplayLanguage"[^>]*value="ko"[^>]*checked/);
  assert.match(html, /name="liveDisplayLanguage"[^>]*value="en"/);
  assert.match(html, /id="live-display-language-help"[^>]*data-i18n="live\.displayLanguageHelp"/);
  assert.match(html, /id="live-host-login-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /id="open-meeting-mode"|name="liveHostWorkspaceUrl"|Open Live Call/);
  assert.match(css, /\.live-draft-cover-status\.is-error/);

  assert.doesNotMatch(workspace, /liveDraftAccess|liveHostWorkspaceUrl|openLiveWorkspace/);
  assert.match(workspace, /const MAX_COVER_IMAGE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(workspace, /new Set\(\["image\/jpeg", "image\/png", "image\/webp"\]\)/);
  assert.match(workspace, /await file\.arrayBuffer\(\)/);
  assert.match(workspace, /function hasValidCoverImageSignature\(bytes, contentType\)/);
  assert.match(workspace, /if \(!hasValidCoverImageSignature\(bytes, file\.type\)\)/);
  assert.match(workspace, /contentType: file\.type/);
  assert.match(workspace, /size: file\.size/);
  assert.match(workspace, /base64: window\.btoa\(binary\)/);
  assert.match(workspace, /coverImage: liveDraftCoverData/);
  assert.match(workspace, /DRAFT_FIELDS = \[[^\]]*"liveDisplayLanguage"/);
  assert.match(workspace, /displayLanguage: liveDisplayLanguage\(\)/);
  assert.match(workspace, /startRegisteredLiveCall\(sessionId, \{ displayLanguage: liveDisplayLanguage\(\) \}\)/);
  assert.match(workspace, /result\?\.code === "HOST_LOGIN_REQUIRED"/);
  assert.match(workspace, /t\("live\.hostLoginRequired"\)/);
  assertLocalized("live.hostLoginRequired", { en: /Open Settings and save the host authorization/ });
  assert.doesNotMatch(workspace, /Sign in once in the Live workspace window|login page|login screen/i);
});

test("host authorization save reports the workspace verification outcome instead of a local-only saved state", async () => {
  const workspace = await read("public/subtitle-workspace.js");

  // Start Live Call distinguishes "nothing saved" from "workspace rejected the
  // saved credentials" so re-saving the same values is never prescribed as the fix.
  assert.match(workspace, /HOST_LOGIN_REJECTED/);
  assert.match(workspace, /t\("live\.hostLoginRejected"\)/);
  assertLocalized("live.hostLoginRejected", { en: /rejected the saved host ID\/password/ });

  // Saving verifies against the workspace and surfaces the real outcome.
  assert.match(workspace, /result\.verified/);
  assert.match(workspace, /HOST_LOGIN_VERIFICATION_KEYS/);
  assert.match(workspace, /NETWORK_UNAVAILABLE/);
  assert.match(workspace, /LOGIN_RATE_LIMITED/);
  assert.match(workspace, /HOST_CREDENTIAL_ENCRYPTION_UNAVAILABLE/);

});

test("viewer captions label the host as Host and participants by their identity", async () => {
  const speakerCaption = await read("webapp/components/live/SpeakerCaption.tsx");
  // Non-participant (diarized host-side) speakers read as "Host"; captions
  // attributed via the speaking floor keep name · department · job title.
  assert.match(speakerCaption, /startsWith\("participant:"\)/);
  assert.match(speakerCaption, /return "Host"/);
  assert.doesNotMatch(speakerCaption, /"Presenter"/);

  const viewer = await read("webapp/components/live/LiveViewer.tsx");
  assert.doesNotMatch(viewer, /\?\? "Presenter"/);
});

test("Stage authorization failure returns the host to Electron Settings", async () => {
  const stage = await read("webapp/components/live/LiveStageView.tsx");

  assert.match(stage, /opened directly by Electron[\s\S]{0,80}as a full-screen Stage overlay/);
  assert.match(stage, /Host authorization is required for this Stage overlay\./);
  assert.match(stage, /Return to NOVA Settings, save Host Authorization, then start Live Call again\./);
  assert.doesNotMatch(stage, /Sign in as the host on this browser|separate named window|host dashboard/);
});

test("armed controller can explicitly end Live Call without coupling caption controls", async () => {
  const [controllerHtml, controllerJs] = await Promise.all([
    read("public/subtitle-controller.html"),
    read("public/subtitle-controller.js"),
  ]);

  assert.match(controllerHtml, /id="controller-go-live"[\s\S]{0,900}id="controller-end-live-call"/);
  assert.match(controllerHtml, /id="controller-live-call-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(controllerJs, /window\.confirm\(t\("controller\.endConfirm"\)\)/);
  assertLocalized("controller.endConfirm", { en: /End this Live Call for every participant\? This cannot be undone\./ });
  assert.match(controllerJs, /await window\.realtimeNoelDesktop\.endLiveCall\(\)/);
  assert.match(controllerJs, /liveCallGroup\.hidden = true[\s\S]{0,160}await syncLiveCall\(\)/);
  assert.match(controllerJs, /setControllerStatus\("controller\.endFailed"\)/);
  assertLocalized("controller.endFailed", { en: /Live Call could not be ended\. Try again\./ });
  assert.match(controllerJs, /endLiveCallButton\.disabled = false/);
  assert.match(controllerJs, /controller-restart"\)\?\.addEventListener\("click", \(\) => sendControl\(\{ command: "restart" \}\)\)/);
  assert.match(controllerJs, /controller-stop"\)\?\.addEventListener\("click", \(\) => sendControl\(\{ command: "stop" \}\)\)/);
  assert.doesNotMatch(controllerJs, /sendControl\(\{ command: "(?:restart|stop)" \}\)[\s\S]{0,120}endLiveCall/);
});

test("controller is a one-row mini-player: brand/drag zone, transport, adjust, window clusters", async () => {
  const [html, css, main] = await Promise.all([
    read("public/subtitle-controller.html"),
    read("public/subtitle.css"),
    read("electron/main.js"),
  ]);
  // Brand zone doubles as the drag handle and shows the status line + VU bar.
  assert.match(html, /id="controller-drag"[^>]*class="controller-drag mp-brand"/);
  assert.match(html, /id="controller-live-call-status"[^>]*class="mp-status"[^>]*role="status"/);
  assert.match(html, /id="controller-vu-fill"/);
  // Transport: Restart/Stop icons + big Go-Live + elapsed timer readout.
  assert.match(html, /mp-transport"[^>]*data-i18n-aria="controller\.captionEngine"[\s\S]{0,1200}controller-restart/);
  assertLocalized("controller.captionEngine", { en: /Caption engine/ });
  assert.match(html, /id="controller-go-live"[^>]*>Go-Live</);
  assert.match(html, /id="controller-elapsed"/);
  // Adjust + window clusters exist; language preset row stays gone.
  assert.match(html, /mp-adjust"[^>]*data-i18n-aria="controller\.appearance"/);
  assert.match(html, /mp-window"[^>]*data-i18n-aria="controller\.appControls"[\s\S]{0,900}controller-quit/);
  assertLocalized("controller.appearance", { en: /Subtitle appearance/ });
  assertLocalized("controller.appControls", { en: /App controls/ });
  assert.doesNotMatch(html, /data-controller-languages=/);
  assert.match(css, /\.subtitle-controller-body \.controller-cluster \{/);
  assert.match(css, /@keyframes mp-live-pulse/);
  // Mini-player bar: initial window height well under the old 248px; the
  // fit-height IPC then hugs the real content height.
  const heightMatch = main.match(/const height = (\d+);(?=[\s\S]{0,900}controllerWindow = new BrowserWindow)/u);
  assert.ok(heightMatch, "controller window height constant not found");
  assert.ok(Number(heightMatch[1]) <= 120, `controller window height ${heightMatch[1]} should be ≤ 120`);
});

test("controller window hugs its content and shows live signal + elapsed time", async () => {
  const [controllerJs, main, preload, css] = await Promise.all([
    read("public/subtitle-controller.js"),
    read("electron/main.js"),
    read("electron/preload.js"),
    read("public/subtitle.css"),
  ]);
  // Fit-height: renderer measures, main clamps and resizes — no empty band.
  assert.match(controllerJs, /fitControllerHeight/);
  assert.match(preload, /fitControllerHeight: \(height, width\) => ipcRenderer\.send\("subtitle-controller:fit-height", height, width\)/);
  assert.match(main, /ipcMain\.on\("subtitle-controller:fit-height"/);
  assert.match(main, /Math\.min\(240, Math\.max\(64, height\)\)/);
  // The console hugs its content WIDTH too. A fixed width left slack that the
  // right-hand cluster was pushed across, so the clusters no longer pin apart.
  assert.match(css, /\.caption-controller-window \{[^}]*width: max-content/u);
  assert.match(css, /\.subtitle-controller-body \.mp-window \{[^}]*margin-left: 0/u);
  assert.match(main, /Math\.max\(CONTROLLER_MIN_WIDTH, requestedWidth\)/);
  // Width changes must not drag the console sideways.
  assert.match(main, /currentWidth - clampedWidth\) \/ 2/);
  // VU meter rides the existing subtitle:input-status broadcast (no new wire).
  assert.match(controllerJs, /subtitle:input-status/);
  assert.match(controllerJs, /updateVuMeter/);
  // Elapsed timer starts from the go-live stamp exposed by get-state.
  assert.match(main, /liveStartedAt: liveCallSession\.liveStartedAt \?\? null/);
  assert.match(main, /armedSession\.liveStartedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(controllerJs, /state\.liveStartedAt/);
});

test("subtitle vertical-gap control is wired controller → server → dashboard", async () => {
  const [controllerJs, serverJs, dashboardJs] = await Promise.all([
    read("public/subtitle-controller.js"),
    read("src/server.js"),
    read("public/subtitle-dashboard.js"),
  ]);
  assert.match(controllerJs, /command: "offset", delta: -8/);
  assert.match(controllerJs, /command: "offset", delta: 8/);
  // Server allowlists the new command so it broadcasts to overlay + dashboard.
  assert.match(serverJs, /"stop", "restart", "font", "offset", "position", "languages", "opacity"/);
  // Dashboard applies it against the persisted verticalOffset setting.
  assert.match(dashboardJs, /message\.command === "offset"/);
  assert.match(dashboardJs, /function adjustControllerVerticalOffset\(delta\)/);
  assert.match(dashboardJs, /form\.elements\.verticalOffset/);
});

test("desktop floating controller exposes audio provider only for audio output", async () => {
  const [html, js] = await Promise.all([
    read("public/subtitle-controller.html"),
    read("public/subtitle-controller.js"),
  ]);

  assert.match(html, /id="controller-voice-provider"[^>]+hidden/);
  assert.match(html, /role="radiogroup"[^>]+aria-label="통역 음성 엔진"/);
  assert.match(html, /data-controller-voice-provider="gemini"/);
  assert.match(html, /data-controller-voice-provider="openai"/);
  assert.match(js, /settings\.outputMode === "captions"/);
  assert.match(js, /command: "voice-provider"/);
  assert.match(js, /ariaChecked/);
});

// ---- Meeting feed rendering cost over a multi-hour call (2026-07-25) ----
// Measured on /m/watch/demo with 306 turns / 1206 sentences streaming a partial
// at 20 Hz: per-update React work fell from p50 13.5ms / p95 16.7ms to
// p50 2.8ms / p95 7.9ms, turn bodies rendered per 10s from 146,656 to 20, long
// tasks from 10 (630ms, 130ms TBT) to 0, and dropped frames from 10 to 0.

test("meeting turn cards are memoised on identity-stable turns", async () => {
  const feed = await read("webapp/components/live/MeetingTurnFeed.tsx");

  // A turn card must be its own memo() component. Rendering the paragraphs
  // inline made every streaming partial re-render the whole record.
  assert.match(feed, /const MeetingTurnCard = memo\(function MeetingTurnCard/u);
  assert.match(feed, /<MeetingTurnCard key=\{turn\.key\}/u);

  // memo is worthless unless the props are identity-stable, and
  // groupCaptionsIntoTurns allocates fresh objects on every call. The
  // reconciliation pass that reuses unchanged turns is what makes it work.
  assert.match(feed, /function useStableTurns/u);
  assert.match(feed, /isSameTurn\(previous, turn\) \? previous : turn/u);
  assert.match(feed, /const turns = useStableTurns\(captions\)/u);
  // Reuse must be keyed, not index-aligned: the caption model is trimmed from
  // the front, which shifts every position but no key.
  assert.match(feed, /previousByKey\.get\(turn\.key\)/u);

  // The global "last two sentences" boundary must be resolved to a per-turn
  // index in the parent; passing the global counters into each card would
  // change a prop on all of them and defeat the memo.
  assert.match(feed, /recentFromIndex=\{turnRecentFrom\[turnIndex\]\}/u);
  assert.match(feed, /textIndex >= recentFromIndex/u);
  // The card now takes only primitives and identity-stable objects — no
  // callback prop at all — which is the strongest possible form of the
  // stability the fold's useCallback used to provide.
  assert.doesNotMatch(feed, /onToggle/u);
  // pendingText is a string, so the card still takes only primitives and
  // identity-stable objects — no callback prop — and memo can bail out on every
  // paragraph except the newest one.
  assert.match(feed, /const MeetingTurnCard = memo\(function MeetingTurnCard\(\{ turn, recentFromIndex, pendingText = "" \}/u);

  // Scanning back for the in-progress line beats filtering thousands of
  // captions on every streaming update.
  assert.doesNotMatch(feed, /captions\.filter/u);
  assert.match(feed, /for \(let index = captions\.length - 1; index >= 0; index -= 1\)/u);
});

test("scroll pinning keeps its forced layout off the per-caption path", async () => {
  const feed = await read("webapp/components/live/MeetingTurnFeed.tsx");

  // Reading scrollHeight back is a forced synchronous layout wherever the DOM
  // is still dirty (measured ~0.5ms per read from a post-commit effect on a
  // 306-card record). The ResizeObserver runs after layout, so it is the only
  // caller allowed on the streaming path; the pin effect must therefore depend
  // on the pin flag alone and NOT on caption text or turn count.
  const pinEffect = feed.match(/useEffect\(\(\) => \{\s*if \(isPinnedToLatest\) pinToLatest\(\);\s*\}, \[([^\]]*)\]\)/u);
  assert.ok(pinEffect, "the re-pin effect must stay independently checkable");
  assert.doesNotMatch(pinEffect[1], /livePartial|turns\.length|captions/u);

  // Redundant writes are skipped: a scrollTop write at the live edge only buys
  // a scroll event and that handler's own three layout reads.
  assert.match(feed, /if \(feed\.scrollHeight - feed\.scrollTop - feed\.clientHeight < 1\) return;/u);

  // The 48px live-edge threshold and the tap-driven jump stay immediate.
  assert.match(feed, /distanceFromBottom < 48/u);
  assert.match(feed, /const scrollToLatest = useCallback[\s\S]{0,240}feed\.scrollTop = feed\.scrollHeight/u);
});

test("meeting feed animations are compositor-only and respect reduced motion", async () => {
  const css = await read("webapp/app/globals.css");

  // Nothing in the feed may animate a layout property; height/top/margin/width
  // in a keyframe block would relayout the whole record every frame.
  for (const name of ["live-turn-in", "live-audio-bar", "live-overlay-in"]) {
    const block = css.match(new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n?\\}\\s*\\n`, "u"));
    assert.ok(block, `@keyframes ${name} must stay present`);
    assert.doesNotMatch(block[0], /(?:^|[;{\s])(?:height|width|top|left|bottom|right|margin|padding|font-size)\s*:/u);
    assert.match(block[0], /transform|opacity/u);
  }

  // Reduced motion has to cover the paragraph entry animation, not only the
  // fold chevron: the entry animation is the one that fires on every new turn.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.live-turn-card \{[\s\S]*?\n\}/u);
  assert.ok(reduced, "the feed needs a reduced-motion block");
  assert.match(reduced[0], /\.live-turn-card \{ animation: none; \}/u);

  // will-change measured no benefit here (959 vs 960 frames over 8s, worse p95)
  // and hundreds of permanently promoted cards is a compositor-memory leak, so
  // the feed must not declare it.
  const feedCss = css.slice(css.indexOf("/* Earnings-call style meeting feed */"), css.indexOf("/* Speaking-floor bar */"));
  assert.doesNotMatch(feedCss, /will-change/u);
});
