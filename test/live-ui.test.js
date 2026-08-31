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
    read("webapp/app/admin/page.tsx"),
    read("webapp/components/live/LiveHostDashboard.tsx"),
  ]);

  assert.match(page, /LiveHostDashboard/);
  assert.doesNotMatch(page, /MeetingMode/);
  assert.match(dashboard, /presentation/);
  assert.match(dashboard, /meeting/);
  assert.doesNotMatch(dashboard, /townhall/i);
  assert.match(dashboard, /<LanguagePicker[^>]*maxSelection=\{3\}/);
});

test("host setup keeps canonical output modes and secondary settings disclosed", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /title: "발표", stateLabel: "1인 발표"/);
  assert.match(dashboard, /title: "회의", stateLabel: "발표자 구분"/);
  assert.doesNotMatch(dashboard, /guest chooses to play it/);
  assert.match(dashboard, /<LanguagePicker label=\{t\("세션 언어"\)\}/);
  assert.match(dashboard, /<details className="live-setup-advanced">/);
  assert.match(dashboard, /<summary>\{t\("고급 설정"\)\}<\/summary>/);
  assert.match(dashboard, /<strong>\{t\("스테이지 커버"\)\}<\/strong>/);
  assert.match(dashboard, /value: "captions"/);
  // Translated-audio delivery is hidden at this stage: only captions cross to
  // participants, get recorded on the host, and flow in real time. The contract
  // and pipeline still accept the audio modes -- this is a hidden option, not a
  // removed capability.
  assert.doesNotMatch(dashboard, /value: "captions_audio"/);
  assert.doesNotMatch(dashboard, /value: "audio"/);
  assert.match(dashboard, /useState<LiveOutputMode>\("captions"\)/);
  assert.doesNotMatch(dashboard, /translated audio/iu);
});

test("live UI keeps host Gemini settings while participants remain captions-only", async () => {
  const [dashboard, viewer, viewerSurface, extensionHtml, extensionJs] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/quality/ViewerLiveSurface.tsx"),
    read("chrome-extension/sidepanel.html"),
    read("chrome-extension/sidepanel.js"),
  ]);

  assert.match(dashboard, /빠른 실시간 자막/);
  assert.match(dashboard, /status: "1인 발표"/);
  assert.doesNotMatch(dashboard, /translated audio|Gemini fixed|Long uninterrupted speech may add delay/iu);
  assert.match(dashboard, /GEMINI_VOICE_PROVIDER = "gemini" as const/);
  assert.doesNotMatch(dashboard, /Translated audio engine|OpenAI Realtime|isOpenAIVoiceLanguageSupported|setVoiceProvider/);
  assert.match(viewer, /ViewerReadingFeed/);
  assert.doesNotMatch(viewer, /LanguageSelector/);
  assert.match(viewerSurface, /TranslationLaneTabs/);
  assert.doesNotMatch(viewer, /Translated audio|Audio On|Audio Off|isInterpretationAudioEnabled/);
  assert.match(extensionHtml, /id="viewer-output-state"/);
  assert.match(extensionJs, /빠른 실시간 자막/);
  assert.match(extensionJs, /안정적인 AI 음성/);
  assert.match(extensionJs, /화자 구분 · 발화 종료 후 출력/);
});

test("host capacity and glossary controls expose product constraints", async () => {
  const [dashboard, glossaryChecklist] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/glossary/GlossarySessionChecklist.tsx"),
  ]);

  assert.match(dashboard, /type="range" min=\{1\} max=\{200\}/);
  assert.match(dashboard, /최대 참여자 · 1명에서 200명까지/);
  assert.match(dashboard, /general_cre/);
  assert.match(glossaryChecklist, /호텔/);
  assert.match(glossaryChecklist, /F&B/);
  assert.match(dashboard, /disabled=\{sessionType !== "meeting"\}/);
  assert.match(dashboard, /미팅 세션에서만 켤 수 있어요/);
  assert.match(glossaryChecklist, /필요한 분야를 함께 선택하세요/);
  assert.match(dashboard, /참여자 발언/);
});

test("host sends canonical session settings through REST and gateway", async () => {
  const [dashboard, audioClient] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/live-audio-client.ts"),
  ]);

  const createSessionBody = dashboard.match(/body: JSON\.stringify\(\{[\s\S]*?participantSpeakingEnabled,\s*\}\)/u)?.[0] ?? "";
  for (const setting of ["title", "scheduledAt", "sessionType", "languages", "outputMode", "voiceProvider", "maxViewers", "glossaryPack"]) {
    assert.match(createSessionBody, new RegExp(`\\b${setting}\\b`, "u"));
  }
  assert.match(dashboard, /sessionType: previousSession\.sessionType/);
  assert.match(dashboard, /outputMode: previousSession\.outputMode/);
  assert.doesNotMatch(dashboard, /voiceProvider: previousSession\.voiceProvider/);
  assert.match(dashboard, /voiceProvider: GEMINI_VOICE_PROVIDER/);
  assert.match(dashboard, /maxViewers: previousSession\.maxViewers/);
  assert.match(dashboard, /glossaryPack: previousSession\.glossaryPack/);
  assert.match(dashboard, /version: restoredSession\.version/);
  assert.match(dashboard, /version: session\.version/);
  assert.match(audioClient, /sessionType: LiveSessionType/);
  assert.match(audioClient, /outputMode: LiveOutputMode/);
  assert.match(audioClient, /maxViewers: number/);
  assert.match(audioClient, /glossaryPack: GlossaryPack/);
  const createSessionBlock = dashboard.match(/const createSession = useCallback[\s\S]*?const stopBroadcast/u)?.[0] ?? "";
  assert.match(createSessionBlock, /body: JSON\.stringify\(\{[\s\S]*?participantSpeakingEnabled,\s*\}\)/u);
  assert.doesNotMatch(createSessionBlock, /JSON\.stringify\([\s\S]*inputSource/u,
    "capture-only inputSource must not be sent to the strict persisted-session API");
});

test("host gateway keeps legacy activation immutable and uses fresh settings for demand wakes", async () => {
  const audioClient = await read("webapp/components/live/live-audio-client.ts");

  assert.match(audioClient, /interface AudioClientOptions\s*\{[\s\S]*?version:\s*number;/u);
  assert.match(audioClient, /interface LiveAudioSettings\s*\{[\s\S]*?version:\s*number;/u);
  assert.match(audioClient, /let currentSettings: LiveAudioSettings = \{\s*version: options\.version,/u);
  assert.match(audioClient, /type: isManualRestart \? "restart" : "start",\s*sessionId: options\.sessionId,\s*version: isManualRestart \|\| demandEnabled \|\| activationKey === null \? settings\.version : activationVersion,/u);
  assert.match(audioClient, /hasReadinessActivation \? \{ activationKey \} : \{\}/u);
  assert.match(audioClient, /hasReadinessActivation = activationKey !== null && \(!isManualRestart \|\| settings\.sessionStatus === "preparing"\)/u);
  assert.match(audioClient, /type: "update",\s*sessionId: options\.sessionId,\s*version: settings\.version,/u);
  assert.match(audioClient, /currentSettings = \{\s*version: settings\.version,/u);
  assert.match(audioClient, /openSocket\(options, credentials, currentSettings, activationVersion, activationKey/u);
  assert.match(audioClient, /const activationVersion = options\.version/u);
  assert.match(audioClient, /Number\.isSafeInteger\(version\)/u);
});

test("host exposes caption health while the participant surface stays captions-only", async () => {
  const [dashboard, viewer, panel] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/LiveViewer.tsx"),
    read("chrome-extension/sidepanel.html"),
  ]);

  assert.doesNotMatch(dashboard, /음역 ·/);
  assert.match(dashboard, /HostAiHealthDisclosure/u);
  assert.match(dashboard, /원문 자막/u);
  assert.match(dashboard, /주제 분류/u);
  assert.doesNotMatch(dashboard, /Analyzing voice|Voice ready|Audio ·/u);
  assert.match(viewer, /CaptionEntry/);
  assert.doesNotMatch(viewer, /getSpeakerVoiceStatus|Audio ·|Translated audio/);
  assert.match(panel, /자막 모드에서는 AI 합성 음성을 사용하지 않습니다/);
  assert.match(panel, /Meeting의 AI 합성 통역 음성/);
});

test("viewer and Chrome derive output display from canonical outputMode", async () => {
  const [viewer, viewerContract, panel, panelScript] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/viewer-controller-contract.ts"),
    read("chrome-extension/sidepanel.html"),
    read("chrome-extension/sidepanel.js"),
  ]);

  assert.match(viewerContract, /value\.session\.outputMode/);
  assert.match(viewerContract, /outputMode: snapshot\.session\.outputMode/);
  assert.match(viewer, /realtime-noel-viewer-state/);
  assert.match(panel, /viewer-output-state/);
  assert.match(panelScript, /realtime-noel-viewer-state/);
  assert.match(panelScript, /outputMode === "audio"/);
  assert.match(panelScript, /outputMode === "captions_audio"/);
});

test("viewer uses one gateway socket for captions and control events with demand fencing", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");

  assert.doesNotMatch(viewer, /RealtimeChannel|channelRef|\.channel\(|realtime\.setAuth/);
  assert.match(viewer, /event\.type === "live-event"/);
  assert.match(viewer, /parseBroadcastEvent\(event\.payload \?\? event\.event\)/);
  assert.match(viewer, /hasConnected/);
  assert.match(viewer, /snapshot\?language=/);
  assert.match(viewer, /type: "subscribe",\s*sessionId: currentViewer\.session\.id,[\s\S]{0,200}language: nextLanguage,[\s\S]{0,200}lastSeq: getLastSeq\(nextLanguage\)/);
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

test("host pause and resume retain the gateway client instead of terminal stop", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");
  const pauseBlock = dashboard.match(/const pauseSession = useCallback[\s\S]*?const resumeSession/u)?.[0] ?? "";
  const resumeBlock = dashboard.match(/const resumeSession = useCallback[\s\S]*?\/\*\* Host session recovery/u)?.[0] ?? "";
  assert.doesNotMatch(pauseBlock, /stopBroadcast/u);
  assert.match(pauseBlock, /\/pause/u);
  assert.match(pauseBlock, /await client\.pause\(\)/u);
  assert.equal(pauseBlock.indexOf("await client.pause()") < pauseBlock.indexOf("/pause"), true);
  assert.match(pauseBlock, /didPauseMedia[\s\S]*await client\.resume\(\)/u);
  assert.match(resumeBlock, /\/resume/u);
  assert.match(resumeBlock, /audioClientRef\.current\.resume\(\)/u);
  assert.doesNotMatch(resumeBlock, /stopBroadcast/u);
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

test("gateway language status listener is persistent before start and cleaned up exactly once", async () => {
  const [dashboard, audioClient] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/live-audio-client.ts"),
  ]);

  assert.match(audioClient, /await authenticated;\s*detachPersistentListeners = attachPersistentListeners\(socket\);\s*const started/s);
  assert.match(audioClient, /const socketListenerDisposers = new WeakMap<WebSocket, \(\) => void>\(\)/);
  assert.match(audioClient, /candidate\.removeEventListener\("message", handleMessage\);\s*candidate\.removeEventListener\("close", handleClose\);\s*socketListenerDisposers\.delete\(candidate\)/s);
  assert.match(audioClient, /detachPreviousListeners\?\.\(\);\s*if \(previous && previous\.readyState !== WebSocket\.CLOSING/s);
  assert.doesNotMatch(audioClient, /attachedSockets/);
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

test("desktop rail launches Meeting Prep, Live Coach, and Live Interpreter independently", async () => {
  const [html, dashboard] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle-dashboard.js"),
  ]);

  assert.match(html, /id="open-meeting-prep"[^>]*data-i18n-aria="nav\.meetingPrep"[\s\S]{0,500}<span data-i18n="nav\.meetingPrep"/u);
  assert.match(html, /id="open-live-coach"[^>]*data-i18n-aria="nav\.liveCoach"[\s\S]{0,500}<span data-i18n="nav\.liveCoach"/u);
  assert.match(html, /id="open-live-interpreter"[^>]*data-i18n-aria="nav\.liveInterpreter"[\s\S]{0,500}<span data-i18n="nav\.liveInterpreter"/u);
  assert.doesNotMatch(html, /id="open-(?:meeting-prep|live-coach|live-interpreter)"[^>]*data-workspace-nav=/u,
    "desktop launchers must not be mistaken for in-dashboard page navigation");
  assert.match(dashboard, /initializeMeetingCoachLaunch/);
  assert.match(dashboard, /methodName: "meetingCoachOpenPrep"/);
  assert.match(dashboard, /methodName: "meetingCoachOpenLiveWindows"/);
  assert.match(dashboard, /initializeLiveInterpreterLaunch/);
  assert.match(dashboard, /methodName: "openLiveInterpreter"/);
  assert.match(dashboard, /button\.setAttribute\("aria-busy", "true"\)/);
  assert.match(dashboard, /button\.removeAttribute\("aria-busy"\)/);
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

test("viewer routes preserve reusable QR fragments while correcting iPhone and iPad surfaces", async () => {
  const [viewer, routing, routingTest, admissionLink] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/viewer-surface-routing.ts"),
    read("webapp/components/live/viewer-surface-routing.test.ts"),
    read("webapp/components/live/admission-link.ts"),
  ]);

  assert.match(routing, /pathname === "\/m\/watch" && isIpadUserAgent/u);
  assert.match(routing, /pathname === "\/watch" && \/\\b\(\?:iPhone\|iPod\)\\b\//u);
  assert.match(routing, /`\$\{target\}\$\{search\}\$\{hash\}`/u);
  assert.match(routingTest, /opaque%2Btoken%3D/u);
  const redirectIndex = viewer.indexOf("window.location.replace(buildViewerSurfaceUrl");
  const readIndex = viewer.indexOf("const admissionLink = parseAdmissionLinkHash(window.location.hash)");
  assert.ok(redirectIndex >= 0 && readIndex > redirectIndex,
    "surface correction must run before the reusable QR fragment is read");
  assert.match(viewer, /if \(getViewerSurfaceRedirect\([\s\S]*?\)\) return;[\s\S]*?parseAdmissionLinkHash\(window\.location\.hash\)/u);
  assert.match(admissionLink, /canonicalHash: `#invite=\$\{inviteToken\}`/u);
  assert.match(admissionLink, /canonicalHash: `#code=\$\{accessCode\}`/u);
  assert.match(viewer, /window\.location\.search\}\$\{admissionLink\.canonicalHash\}/u);
});

test("mobile viewer reconnects once on foreground and keeps full caption history accessible", async () => {
  const [viewer, recovery, viewport, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/foreground-recovery.ts"),
    read("webapp/components/live/translation/TranslationViewport.tsx"),
    read("webapp/components/live/translation/translation.module.css"),
  ]);

  assert.match(recovery, /if \(state\.inFlight\) return state\.inFlight/u);
  assert.match(viewer, /document\.addEventListener\("visibilitychange"/u);
  assert.match(viewer, /window\.addEventListener\("pageshow"/u);
  assert.match(viewer, /window\.addEventListener\("online"/u);
  assert.match(viewer, /disconnectGateway\(\);[\s\S]*?const recoveryGeneration = gatewayConnectionGenerationRef\.current/u);
  assert.match(viewer, /expectedConnectionGeneration !== gatewayConnectionGenerationRef\.current\) return/u);
  assert.match(viewport, /Children\.count\(children\)/u, "the complete transcript must remain in the DOM");
  assert.match(viewport, /className=\{styles\.feed\}/u);
  assert.match(css, /\.selectLabel select[\s\S]*?min-height:\s*44px/u);
  assert.match(css, /:focus-visible[\s\S]*?outline:\s*2px solid var\(--nova-system-default\)/u);
});

test("speaker captions never identify a speaker by color alone", async () => {
  const component = await read("webapp/components/live/SpeakerCaption.tsx");
  const css = await read("webapp/app/globals.css");

  assert.match(component, /speaker\.name\?\.trim\(\)/);
  assert.doesNotMatch(component, /speaker\.name\?\.trim\(\) \|\| speaker\.label/);
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
  assert.match(dashboard, /<LanguagePicker[^>]*maxSelection=\{3\}/);
  assert.match(viewer, /languageLabel/);
  assert.match(css, /--nova-font: "Pretendard"/);
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

  assert.match(css, /--nova-web-background:\s*#15151a/i);
  assert.match(css, /--nova-web-text:\s*#ffffff/i);
  assert.match(css, /--nova-web-action:\s*#0071e3/i);
  assert.match(css, /--canvas:\s*var\(--nova-web-background\)/i);
  assert.match(css, /--nova-font:\s*"Pretendard"/);
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

test("participant viewer removes PiP media playback and keeps QR entry minimal", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");

  assert.doesNotMatch(viewer, /captureStream|requestPictureInPicture|documentPictureInPicture|createPortal/);
  assert.match(viewer, /live-join-wordmark/);
});

test("Meeting participant surface omits AI audio playback while Chrome keeps its disclosure", async () => {
  const [viewer, panel] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("chrome-extension/sidepanel.html"),
  ]);

  assert.doesNotMatch(viewer, /Translated audio|isInterpretationAudioEnabled|enableInterpretationAudio/);
  assert.match(panel, /AI 합성 통역 음성/);
});

test("participant viewer contains no interpretation WebAudio queue", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");

  assert.doesNotMatch(viewer, /AudioContext|decodeAudioChunk|projectedQueueDuration|playbackRate/u);
  assert.doesNotMatch(viewer, /scheduledSourcesRef|audioPendingSocketRef|restartQueue|clearInterpretationAudio/u);
});

test("gateway close reconciles authoritative status before reconnecting without clearing the selected language", async () => {
  const [viewer, lifecycle] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/viewer-gateway-lifecycle.ts"),
  ]);

  assert.match(viewer, /resolveViewerGatewayStatus\(currentViewer, generation\)[\s\S]{0,300}decision === "reconnect"[\s\S]{0,200}scheduleReconnect\(\)/);
  assert.match(viewer, /decision === "wait"[\s\S]{0,160}waitForAuthoritativeStatus\(\)/);
  assert.match(lifecycle, /status === "live" \|\| status === "paused"[\s\S]{0,100}return "reconnect"/);
  assert.match(lifecycle, /return "wait"/,
    "status failures and non-live states must wait for the Vercel poll rather than wake Cloud Run");
  assert.doesNotMatch(viewer, /audio-control|minimumAudioSeqRef|lastAudioSeqRef/);
  assert.match(viewer, /statusLabel=\{sessionStatus === "live" \? undefined : t\(lifecycleLabel\)\}/);
});

test("viewer keeps one seq-keyed shared caption entry from partial through final", async () => {
  const [viewer, entry, captionFeed, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/translation/CaptionEntry.tsx"),
    read("webapp/lib/live/caption-feed.ts"),
    read("webapp/app/globals.css"),
  ]);

  // 2026-07-26 fix: Timeline identity and ordering are shared by snapshot,
  // WebSocket, host, and participant events, so the merge contract belongs in
  // the feed module rather than as a private Viewer implementation detail.
  assert.match(captionFeed, /export function mergeCaptionTimeline/);
  assert.match(viewer, /mergeLanguageCaptionCache/);
  assert.match(viewer, /const displayCaptions = useMemo\(\(\) => captions\.filter\(isDisplayableCaption\), \[captions\]\)/);
  assert.match(viewer, /key=\{`\$\{caption\.language\}-\$\{caption\.seq\}`\}/);
  assert.doesNotMatch(viewer, /key=\{`final-|key=\{`partial-|live-caption-current/u);
  // Target histories remain language-bound while native speech is retained.
  assert.match(
    captionFeed,
    /caption\.origin === "source" \|\| caption\.translationStatus === "verbatim"/u,
  );
  assert.match(captionFeed, /incoming\.filter\(\(event\) => event\.language === language\)/u);
  assert.doesNotMatch(viewer, /const finalCaptions|const partialCaptions/u);
  assert.match(viewer, /<CaptionEntry/u);
  assert.match(viewer, /event\.seq <= getLastSeq\(event\.language\)/);
  assert.match(viewer, /mergeLanguageCaptionCache\(captionsByLanguageRef.current, event.language, \[event\]\);\s*replaceCaptionCache\(nextCache\)/u);
  assert.match(viewer, /setCaptionSnapshot\(snapshot\)/);
  assert.match(viewer, /finalAnnouncement=\{latestFinal\?\.text\}/);
  assert.match(entry, /data-caption-state=\{state\}/);
  assert.doesNotMatch(entry, /인식 중/);
  assert.doesNotMatch(css, /\.live-caption-card\.is-active\s*\{[^}]*transform:/su);
});

test("the live UI consumes the lossless language cache and append-only partial tail", async () => {
  const [viewer, feed, captionFeed, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/MeetingTurnFeed.tsx"),
    read("webapp/lib/live/caption-feed.ts"),
    read("webapp/app/globals.css"),
  ]);

  // 2026-07-27 fix: These checks bind the tested 12,000-event data contract to
  // the actual screen path. A green cache-only test is insufficient if the
  // language selector clears that cache or the feed remounts partial text.
  assert.match(captionFeed, /const COMMITTED_CAPTION_LIMIT = 12_000/u);
  assert.doesNotMatch(captionFeed, /CAPTION_WINDOW_SIZE|slice\(-200\)/u);
  assert.match(viewer, /const captionsByLanguageRef = useRef<Record<string, CaptionEvent\[\]>>\(\{\}\)/u);
  assert.match(viewer, /const selectedLaneInputs = useMemo<CaptionLaneInput\[\]>\(/u);
  assert.match(viewer, /const events = captionsByLanguage\[selectedLane.language\] \?\? \[\]/u);
  assert.match(viewer, /\[captionsByLanguage, selectedLane\]/u);
  assert.match(viewer, /captionsByLanguageRef.current = nextCache;\s*setCaptionsByLanguage\(nextCache\)/u);
  assert.doesNotMatch(viewer, /setCaptions\(/u);
  assert.match(viewer, /mergeLanguageCaptionCache\(captionsByLanguageRef\.current, event\.language, \[event\]\)/u);
  assert.match(feed, /key=\{`caption-\$\{caption\.seq\}`\}/u);
  assert.match(feed, /caption\.isFinal \? "" : "is-pending"/u);
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

test("host creates mobile fragment-only invite links and exposes access plus live inspector status", async () => {
  const [dashboard, hostSurface] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/host-surface.ts"),
  ]);

  assert.match(dashboard, /fetch\(`\/api\/live-sessions\/\$\{session\.id\}\/invites`/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ action: "create" \}\)/);
  assert.match(dashboard, /\/m\/watch#invite=\$\{encodeURIComponent\(inviteResult\.inviteToken\)\}/);
  assert.doesNotMatch(dashboard, /\/m\/watch\?invite=/);
  assert.match(dashboard, /shareHostInvitation\(mode, buildHostInviteShareText\(\{/u);
  assert.match(dashboard, /url: currentInvite\.url,[\s\S]{0,120}admissionCode: currentInvite\.admissionCode/u);
  assert.match(hostSurface, /input\.url,[\s\S]{0,120}`인증 코드: \$\{input\.admissionCode\}`/u);
  assert.match(dashboard, /링크·인증코드 복사/);
  assert.match(dashboard, /이메일로 초대/);
  assert.match(dashboard, /mailto:/);
  assert.match(dashboard, /참여자 QR/);
  assert.match(dashboard, /6자리 인증 코드/);
  assert.match(dashboard, /currentInvite\.admissionCode/);
  assert.match(dashboard, /입장 유효 시간:/);
  assert.match(dashboard, /t\("참여자 · \{present\}\/\{total\}", \{ present: participants\.filter\(\(participant\) => participant\.isPresent\)\.length, total: participants\.length \}\)/);
  assert.match(dashboard, /참여자 입장/);
  const liveSurface = await read("webapp/components/live/quality/HostLiveSurface.tsx");
  assert.match(liveSurface, /className="live-host-current-status"[^>]*role="status"/);
});

test("every host invite path adopts the returned optimistic session version before Start Live", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /interface InviteResult \{[\s\S]*version: number;/);
  assert.equal((dashboard.match(/readResponse<InviteResult>/g) ?? []).length, 3);
  assert.equal((dashboard.match(/version: inviteResult\.version/g) ?? []).length, 3);
  assert.equal((dashboard.match(/admissionOpenUntil: inviteResult\.admissionOpenUntil/g) ?? []).length, 3);
  assert.match(dashboard, /body: JSON\.stringify\(\{ action: "read-if-open" \}\)/);
  assert.match(dashboard, /setSession\(\(current\) => current\?\.id === next\.id[\s\S]{0,180}version: inviteResult\.version/);
  assert.match(dashboard, /body: JSON\.stringify\(\{ version: session\.version \}\)/);
});

test("host renders an offline QR invitation with accessible fallback", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");

  assert.match(dashboard, /import QRCode from "qrcode"/);
  assert.match(dashboard, /QRCode\.toDataURL\(value/);
  assert.match(dashboard, /errorCorrectionLevel: "M"/);
  assert.match(dashboard, /alt=\{t\("NOVA 참여자 초대 QR 코드"\)\}/);
  assert.match(dashboard, /QR 코드를 만들지 못했습니다\. 초대 링크를 복사해 주세요\./);
  assert.match(dashboard, /<InviteQrCode value=\{currentInvite\.url\} \/>/);
});

test("approved mobile live design supports email identity and QR or access-code entry", async () => {
  const [viewer, dashboard, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, />\{t\("이메일"\)\}</);
  assert.match(viewer, /<summary>\{t\("선택 정보"\)\}<\/summary>/);
  assert.match(viewer, />\{t\("회사"\)\}</);
  assert.match(viewer, />\{t\("부서"\)\}</);
  assert.match(viewer, />\{t\("직급"\)\}</);
  assert.match(viewer, />\{t\("6자리 인증 코드"\)\}</);
  assert.match(viewer, /"라이브 참여"/);
  assert.match(viewer, /id="live-access-code" name="accessCode"/);
  assert.doesNotMatch(viewer, /내 언어로 함께 듣기/);
  // The control now discloses a slider rather than incrementing, so the label
  // names the thing it adjusts instead of promising a direction.
  assert.match(viewer, />\{t\("자막 글자 크기"\)\}</);
  assert.doesNotMatch(viewer, /<LanguageSelector/);
  assert.match(viewer, /<ViewerLiveSurface/);
  assert.match(viewer, /<ControlDrawer/);
  assert.match(viewer, />\{t\("세션 나가기"\)\}</);
  assert.match(viewer, /\/leave`/);
  assert.doesNotMatch(viewer, /🎙/u);
  assert.doesNotMatch(viewer, /live-join-methods|Invite link/u);
  assert.match(dashboard, /세션 제목/);
  assert.match(dashboard, /날짜/);
  assert.match(dashboard, /시작 시간/);
  assert.match(dashboard, /title,\s*scheduledAt/);
  assert.match(dashboard, />\s*\{t\("라이브 시작"\)\}\s*</);
  assert.match(dashboard, /createScheduledGatewayStartTransport/);
  assert.match(dashboard, /transport\.prepare\(activeSession\.id, activeSession\.version\)/);
  assert.match(dashboard, /connectBroadcastWithRecovery\(transportSession, activation, isManualRestart \? "restart" : "start"\)/);
  assert.match(dashboard, /mergePolledHostSession\(current, authoritative\)/);
  assert.doesNotMatch(dashboard, /setSession\(transportSession\)/);
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

test("participant speaking controls are capability-gated while demo stays captions-only", async () => {
  const [viewer, demo, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/app/m/watch/demo/page.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, /TranslationViewport/u);
  assert.match(viewer, /viewer\.session\.participantSpeakingEnabled === true/u);
  assert.match(viewer, /prepareSpeakCapture/u);
  assert.match(viewer, /canUseSpeakingFloor/u);
  const participantButton = await read("webapp/components/live/ParticipantSpeakButton.tsx");
  assert.match(viewer, /canUseSpeakingFloor && <ParticipantSpeakButton state=\{speakState\}/u);
  assert.match(participantButton, /aria-pressed=\{state !== "idle"\}/u);
  assert.match(demo, /ViewerReadingFeed/u);
  assert.doesNotMatch(demo, /SpeakControl|floorHolder|getUserMedia|prepareSpeakCapture/u);
  assert.match(demo, /실제 마이크는 사용하지 않아요/u);
  assert.match(css, /\.live-viewer-stage > \[data-translation-state\] \{ min-height: 70vh;/u);
});

test("meeting captions keep one seq-keyed speaker article through partial and final", async () => {
  const [feed, css] = await Promise.all([
    read("webapp/components/live/MeetingTurnFeed.tsx"),
    read("webapp/app/globals.css"),
  ]);

  // Caption text lives only in the main record: the in-progress utterance is
  // the newest speaker-attributed paragraph, with no duplicate media surface.
  assert.match(feed, /key=\{`caption-\$\{caption\.seq\}`\}/);
  assert.match(feed, /turn\.captions\.map/);
  assert.doesNotMatch(feed, /livePartial|pendingText/u);
  assert.doesNotMatch(feed, /live-now-text/);
  assert.match(feed, /turns\.map/);
  assert.match(feed, /floorHolder[\s\S]{0,400}is speaking/);
  // Scroll durability: content growth of any kind (partials, new paragraphs,
  // Aa text-size reflow) re-pins the newest line into view, while captions-only
  // mobile spacing keeps the record's tail above the safe area.
  assert.match(feed, /new ResizeObserver/);
  assert.match(feed, /live-turn-scroll-content/);
  assert.match(css, /\.live-turn-scroll\s*\{[^}]*padding-bottom:\s*calc\(24px \+ env\(safe-area-inset-bottom\)\)/s);
  assert.doesNotMatch(css, /\.live-speak-(?:bar|button)/u);
  assert.doesNotMatch(css, /@keyframes live-turn-in|animation:\s*live-turn-in/u);
  // Reference-app reading treatment: only the two most recently completed
  // sentences render at full strength; older sentences dim.
  assert.match(feed, /globalIndex >= turnOffsets\.total - 2/);
  assert.match(css, /\.live-turn-card p \.live-turn-text\s*\{[^}]*opacity:\s*\.42/s);
  assert.match(css, /\.live-turn-card p \.live-turn-text\.is-recent\s*\{[^}]*opacity:\s*1/s);
});

test("caption language stays direct while secondary controls live in the drawer", async () => {
  const [viewer, demo, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/app/m/watch/demo/page.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.doesNotMatch(viewer, /Audio On|Audio Off|isInterpretationAudioEnabled/u);
  assert.doesNotMatch(demo, /Audio On|Audio Off/u);

  const viewerSurface = await read("webapp/components/live/quality/ViewerLiveSurface.tsx");
  assert.match(viewerSurface, /<TranslationLaneTabs/u);
  assert.match(demo, /<TranslationLaneTabs/u);
  assert.doesNotMatch(viewer, /<LanguageSelector/u);
  assert.equal((viewerSurface.match(/<TranslationLaneTabs/gu) ?? []).length, 1);
  assert.match(viewer, /buildTranslationLanes/u);
  assert.match(viewer, /projectCaptionLane/u);

  assert.match(viewer, /<ControlDrawer triggerLabel=\{t\("더보기"\)\} title=\{t\("세션 제어"\)\}>/u);
  assert.match(demo, /<ControlDrawer triggerLabel=\{t\("더보기"\)\} title=\{t\("미리보기 제어"\)\}>/u);
  assert.match(demo, /ariaLabel=\{t\("자막 언어"\)\}/u);
  assert.match(viewer, /type="range"/u);
  assert.match(viewer, /setCaptionScale\(Number\(event\.currentTarget\.value\)\)/u);
  assert.doesNotMatch(viewer, /captionTextSize/u);
  assert.match(css, /\.live-viewer-text-scale input \{ min-height: 44px;/u);
});

test("the in-progress sentence finalizes in the same keyed paragraph node", async () => {
  const feed = await read("webapp/components/live/MeetingTurnFeed.tsx");

  // The partial used to render as its own <article class="live-turn-card is-live">
  // BELOW the record. When it finalized it vanished from there and reappended to
  // the paragraph above, so the reader watched text get written separately and
  // then jump into the record — the reported "따로 적혔다가 다시 기록에 붙여지는"
  // behaviour. A live transcript must only ever grow at its tail.
  assert.match(feed, /key=\{`caption-\$\{caption\.seq\}`\}/u);
  assert.match(feed, /caption\.isFinal \? "" : "is-pending"/u);
  assert.match(feed, /data-caption-state=\{hasPartial \? "updating" : "final"\}/u);
  assert.doesNotMatch(feed, /pendingText|livePartialBelongsToLastTurn/u);
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

  // The in-progress paragraph stays in the same canonical record.
  assert.match(feed, /className=\{`live-turn-card \$\{hasPartial \? "is-live" : ""\}`\}/u);
});

test("meeting timestamps use a deterministic fixed KST clock", async () => {
  const [feed, minutes] = await Promise.all([
    read("webapp/components/live/MeetingTurnFeed.tsx"),
    read("webapp/components/live/meeting-minutes-model.ts"),
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
  const [viewer, minutes, css, viewerSurface, viewerLane] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/MeetingMinutes.tsx"),
    read("webapp/app/globals.css"),
    read("webapp/components/live/quality/ViewerLiveSurface.tsx"),
    read("webapp/components/live/quality/ViewerTopicLane.tsx"),
  ]);

  assert.match(viewer, /\{isSessionEnded \? \([\s\S]*\) : sessionStatus === "preparing" \? \([\s\S]*<ViewerLiveSurface/u);
  assert.match(viewer, /sessionStatus === "live"[\s\S]{0,100}\? "실시간"[\s\S]{0,100}sessionStatus === "paused" \? "호스트가 일시 정지함" : "라이브를 사용할 수 없음"/);
  assert.match(viewer, /className="live-session-ended-screen" role="status"[\s\S]{0,160}<strong>\{t\("라이브 세션이 종료되었습니다"\)\}<\/strong>/u);
  assert.doesNotMatch(viewer, /live-session-ended-banner/);
  const endedRecordStart = viewer.indexOf("{isSessionEnded ? (");
  const endedRecordEnd = viewer.indexOf(') : sessionStatus === "preparing"', endedRecordStart);
  const endedRecordSource = viewer.slice(endedRecordStart, endedRecordEnd);
  assert.doesNotMatch(endedRecordSource + minutes, />Live session ended<|>The meeting has ended<|The host ended the call\. Your meeting record is below\./);
  assert.match(minutes, /role="tablist" aria-label=\{t\("회의 기록"\)\}/);
  assert.match(minutes, /aria-controls="live-minutes-panel-summary"/);
  assert.match(minutes, /aria-controls="live-minutes-panel-transcript"/);
  assert.match(minutes, /activeTab === "summary" \? \(/);
  assert.doesNotMatch(minutes, /hidden=\{/);
  assert.doesNotMatch(minutes, /fetch\(/);
  assert.match(viewerLane, /const viewportState = sessionStatus === "paused" \? "paused" : sessionStatus === "live" \? "live" : "disconnected"/u);
  assert.match(viewerLane, /<TranslationViewport state=\{viewportState\}/u);
  assert.match(viewerSurface, /<TranslationLaneTabs/u);
  assert.match(viewer, /function isRecordingStatusEvent/);
  assert.match(viewer, /event\.type === "recording-status"[\s\S]{0,220}실시간 자막/u);
  assert.doesNotMatch(viewer, /setError\(event\.message\)/u);
  assert.doesNotMatch(viewer, /live-viewer-footer/u,
    "secondary live metadata belongs in the drawer, not a competing footer row");
  assert.match(css, /\.live-viewer-shell\.is-compact \.live-minutes\s*\{[^}]*scrollbar-color:\s*var\(--nova-hairline-strong\) var\(--nova-web-background\)[^}]*scrollbar-width:\s*thin/s,
    "a long ended record must not expose the browser's light scrollbar gutter");
  assert.match(css, /\.live-viewer-shell\.is-compact \.live-minutes::\-webkit-scrollbar-track\s*\{[^}]*background:\s*var\(--nova-web-background\)/s);
  assert.doesNotMatch(css, /\.live-viewer-shell\.is-compact \.live-minutes\s*\{[^}]*scrollbar-width:\s*none/s,
    "the ended transcript must retain a visible scroll affordance");
});

test("ended minutes keep one accessible loading state across polling gaps and stop with retry", async () => {
  const [viewer, minutes, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/MeetingMinutes.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, /type SummaryPollingState/u);
  assert.doesNotMatch(viewer, /type MinutesPollingState/u);
  assert.match(viewer, /setMinutesPollingState\("polling"\)/u);
  assert.match(viewer, /setMinutesPollingState\("exhausted"\)/u);
  assert.match(viewer, /isLoading=\{isMinutesLoading \|\| minutesPollingState === "polling"\}/u);
  assert.match(viewer, /<ParticipantMeetingMinutes/u);
  assert.match(minutes, /<RecapStatePanel isBusy=\{isSummaryPolling\}>/u);
  assert.match(minutes, /role="status" aria-live="polite"/u);
  assert.match(minutes, /className="live-minutes-loading-dots"/u);
  assert.match(minutes, /formatElapsedTime/u);
  assert.doesNotMatch(minutes, /ETA|remaining|about \d/u);
  assert.match(minutes, /회의 요약 생성이 예상보다 오래 걸리고 있습니다\./u);
  assert.match(minutes, /"다시 시도"/u);
  assert.match(css, /\.live-minutes-elapsed \{[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.match(css, /@keyframes live-minutes-dot/u);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.live-minutes-loading-dots i[\s\S]*animation: none/u);
});

test("host and shared viewer minutes expose the same automatic summary states without regeneration UI", async () => {
  const [dashboard, hostSummaryLifecycle, viewer, minutes] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/useHostSummaryLifecycle.ts"),
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/MeetingMinutes.tsx"),
  ]);

  assert.match(hostSummaryLifecycle, /startSummaryPollLoop/u);
  assert.match(hostSummaryLifecycle, /method: "GET"[\s\S]{0,120}cache: "no-store"/u);
  assert.match(dashboard, /<MeetingMinutes/u);
  assert.match(dashboard, /minutesPollingState=\{hostSummaryPollingState\}/u);
  assert.match(dashboard, /minutesPollingStartedAt=\{hostSummaryPollingStartedAt\}/u);
  assert.match(hostSummaryLifecycle, /summaryFailureCode !== "SUMMARY_GENERATION_RETRYABLE_FAILED"/u);
  assert.doesNotMatch(dashboard, /Create summary again|Create AI summary|generateSummaries/u);

  assert.match(viewer, /startSummaryPollLoop/u);
  const summaryPolling = await read("webapp/components/live/meeting-summary-polling.ts");
  assert.match(summaryPolling, /type SummaryPollingState = "idle" \| "polling" \| "exhausted" \| "failed"/u);
  assert.match(summaryPolling, /getSummaryPollDelayMilliseconds/u);
  assert.match(summaryPolling, /onError/u);
});

test("approved Stage keeps prelive access, live translations, and a clean completion state", async () => {
  const [stage, css] = await Promise.all([
    read("webapp/components/live/LiveStageView.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(stage, /className="live-stage-grid"[\s\S]*className="live-stage-session"[\s\S]*className="live-stage-access"/);
  assert.match(stage, /participants\.slice\(0, 5\)/);
  assert.match(stage, /overflowCount > 0[\s\S]*>\+\{overflowCount\}</);
  assert.match(stage, /isCountingDown \? \([\s\S]*className="live-stage-ring"/);
  assert.doesNotMatch(stage, /className="live-stage-ring"[\s\S]{0,220}Waiting for host/);
  assert.match(stage, /function StageLoader/);
  assert.match(stage, /coverState === "loading"/);
  assert.match(stage, /className="live-stage-manual-url"/);
  assert.match(stage, /new URL\("\/watch", window\.location\.origin\)/);
  assert.doesNotMatch(stage, /live-stage-manual-url[\s\S]{0,180}invite\.url/u,
    "the manual URL must never disclose the opaque QR invite token");
  assert.match(stage, /\{isPrelive && currentInvite && \(/u);
  assert.match(stage, /<TranslationViewport[\s\S]*recentSpeeches\.map[\s\S]*<CaptionEntry/u);
  assert.match(stage, /className="live-stage-complete"/u);
  assert.doesNotMatch(stage, /is-faded-out|aria-hidden=\{!isPrelive\}/u);
  assert.match(css, /\.live-stage-frame \{[^}]*aspect-ratio: 16 \/ 9/s);
  assert.match(css, /\.live-stage-grid \{[^}]*grid-template-columns:/s);
  assert.match(css, /\.live-stage-cover \{[^}]*object-fit: cover[^}]*object-position: center/s);
  assert.match(css, /\.live-stage-loader i \{[^}]*animation: live-stage-load/s);
  assert.match(css, /\.live-stage-translation \{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
  assert.match(css, /\.live-stage-complete \{[^}]*place-content:\s*center/s);
  assert.doesNotMatch(css, /\.live-stage-access\.is-faded-out/u);
});

test("meeting minutes group by participant identity while preserving the display label", async () => {
  const minutes = await read("webapp/components/live/meeting-minutes-model.ts");
  const start = minutes.indexOf("export function groupTranscript");
  const end = minutes.indexOf("\n\nexport function formatMinuteTime", start);
  assert.ok(start >= 0 && end > start, "groupTranscript must remain independently testable");
  const runnableSource = minutes.slice(start, end)
    .replace(
      "export function groupTranscript(entries: TranscriptEntry[]): TranscriptTurn[]",
      "function groupTranscript(entries)",
    )
    .replace("const turns: TranscriptTurn[] = []", "const turns = []");
  const groupTranscript = new Function(`${runnableSource}; return groupTranscript;`)();
  const turns = groupTranscript([
    { seq: 1, participantId: "participant-a", speaker: "Alex", text: "one", emittedAt: "2026-07-26T01:00:00Z" },
    { seq: 2, participantId: "participant-a", speaker: "Alex rejoined", text: "two", emittedAt: "2026-07-26T01:00:01Z" },
    { seq: 3, participantId: "participant-b", speaker: "Alex", text: "three", emittedAt: "2026-07-26T01:00:02Z" },
    { seq: 4, speaker: "Host", text: "four", emittedAt: "2026-07-26T01:00:03Z" },
    { seq: 5, speaker: "Host", text: "five", emittedAt: "2026-07-26T01:00:04Z" },
  ]);

  assert.deepEqual(turns.map((turn) => ({ speaker: turn.speaker, text: turn.texts.join(" ") })), [
    { speaker: "Alex", text: "one two" },
    { speaker: "Alex", text: "three" },
    { speaker: "Host", text: "four five" },
  ]);
});

test("live meeting turns use speaker IDs rather than colliding display labels", async () => {
  const feed = await read("webapp/components/live/MeetingTurnFeed.tsx");
  const start = feed.indexOf("export function groupCaptionsIntoTurns");
  const end = feed.indexOf("\n\n/** True", start);
  assert.ok(start >= 0 && end > start, "groupCaptionsIntoTurns must remain independently testable");
  const runnableSource = feed.slice(start, end)
    .replace(
      "export function groupCaptionsIntoTurns(captions: CaptionEvent[]): MeetingTurn[]",
      "function groupCaptionsIntoTurns(captions)",
    )
    .replace("const turns: MeetingTurn[] = []", "const turns = []");
  const groupCaptionsIntoTurns = new Function(
    "speakerMetaLine",
    "resolveSpeakerColor",
    `${runnableSource}; return groupCaptionsIntoTurns;`,
  )((speaker) => speaker?.label ?? "Host", () => "#000");
  const captions = [
    { seq: 1, isFinal: true, text: "one", emittedAt: "2026-07-26T01:00:00Z", speaker: { speakerId: "a", label: "Alex" } },
    { seq: 2, isFinal: true, text: "two", emittedAt: "2026-07-26T01:00:01Z", speaker: { speakerId: "a", label: "Alex rejoined" } },
    { seq: 3, isFinal: true, text: "three", emittedAt: "2026-07-26T01:00:02Z", speaker: { speakerId: "b", label: "Alex" } },
    { seq: 4, isFinal: true, text: "four", emittedAt: "2026-07-26T01:00:03Z" },
    { seq: 5, isFinal: true, text: "five", emittedAt: "2026-07-26T01:00:04Z" },
  ];
  const turns = groupCaptionsIntoTurns(captions);

  assert.deepEqual(turns.map((turn) => ({
    identity: turn.speakerIdentity,
    label: turn.speakerLabel,
    text: turn.captions.map((caption) => caption.text).join(" "),
  })), [
    { identity: "a", label: "Alex", text: "one two" },
    { identity: "b", label: "Alex", text: "three" },
    { identity: "host", label: "Host", text: "four five" },
  ]);
});

test("production meeting feed accumulates canonical seq captions by consecutive speaker", async () => {
  const feed = await read("webapp/components/live/MeetingTurnFeed.tsx");
  const start = feed.indexOf("export function groupCaptionsIntoTurns");
  const end = feed.indexOf("/** True when two separate groupings", start);
  assert.ok(start >= 0 && end > start);
  const runnableSource = feed.slice(start, end)
    .replace(
      "export function groupCaptionsIntoTurns(captions: CaptionEvent[]): MeetingTurn[]",
      "function groupCaptionsIntoTurns(captions)",
    )
    .replace("const turns: MeetingTurn[] = []", "const turns = []");
  const groupCaptionsIntoTurns = new Function(
    "speakerMetaLine",
    "resolveSpeakerColor",
    `${runnableSource}; return groupCaptionsIntoTurns;`,
  )((speaker) => speaker?.label ?? "Host", () => "#000");
  const speaker = (speakerId, label) => ({ speakerId, label });
  const captions = [
    { seq: 1, isFinal: true, text: "Host sentence one.", emittedAt: "2026-07-26T01:00:00Z", speaker: null },
    { seq: 2, isFinal: true, text: "Host sentence two.", emittedAt: "2026-07-26T01:00:01Z", speaker: null },
    { seq: 3, isFinal: false, text: "Participant frag", emittedAt: "2026-07-26T01:00:02Z", speaker: speaker("p1", "Participant") },
    { seq: 3, isFinal: true, text: "Participant sentence.", emittedAt: "2026-07-26T01:00:03Z", speaker: speaker("p1", "Participant") },
    { seq: 4, isFinal: true, text: "Participant sentence two.", emittedAt: "2026-07-26T01:00:04Z", speaker: speaker("p1", "Participant") },
    { seq: 5, isFinal: true, text: "Host returns.", emittedAt: "2026-07-26T01:00:05Z", speaker: null },
  ];

  assert.deepEqual(groupCaptionsIntoTurns(captions).map((turn) => ({
    speaker: turn.speakerIdentity,
    captions: turn.captions,
  })), [
    { speaker: "host", captions: [
      { seq: 1, text: "Host sentence one.", isFinal: true },
      { seq: 2, text: "Host sentence two.", isFinal: true },
    ] },
    { speaker: "p1", captions: [
      { seq: 3, text: "Participant sentence.", isFinal: true },
      { seq: 4, text: "Participant sentence two.", isFinal: true },
    ] },
    { speaker: "host", captions: [{ seq: 5, text: "Host returns.", isFinal: true }] },
  ]);
});

test("participant topic surfaces use approved Korean copy without emoji", async () => {
  const sources = await Promise.all([
    "LiveHostDashboard.tsx",
    "LiveViewer.tsx",
    "MeetingTurnFeed.tsx",
    "SpeakerCaption.tsx",
    "MeetingMinutes.tsx",
    "MeetingSummaryCard.tsx",
    "ViewerReadingFeed.tsx",
    "ParticipantMeetingMinutes.tsx",
    "ViewerRecapRequest.tsx",
    "connection-resilience.ts",
    "live-audio-client.ts",
  ].map((name) => read(`webapp/components/live/${name}`)));
  sources.push(await read("webapp/app/m/watch/demo/page.tsx"));
  sources.push(await read("webapp/components/live/viewer-controller-contract.ts"));
  const source = sources.join("\n");
  const approvedKoreanMessages = [
    "올바른 이메일 주소를 입력해 주세요.",
    "회사명은 100자 이하로 입력해 주세요.",
    "부서는 80자 이하로 입력해 주세요.",
    "직급은 100자 이하로 입력해 주세요.",
    "호스트가 공유한 6자리 인증코드를 입력해 주세요.",
    "참여자 연결이 설정되지 않았습니다.",
    "QR 초대가 유효하지 않거나 만료되었습니다.",
    "라이브콜에 참여할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    "참여 인원이 가득 찼습니다.",
    "참여가 마감되었거나 QR 초대가 만료되었습니다.",
    "라이브콜에 참여할 수 없습니다. 입력 정보를 확인해 주세요.",
    "원문",
    "번역 중",
    "AI 요약",
    "발언 원문 펼치기",
    "요약·원문 받기",
    "마케팅 수신 동의는 포함되지 않아요.",
  ];
  for (const message of approvedKoreanMessages) {
    assert.match(source, new RegExp(message, "u"));
  }

  assert.doesNotMatch(source, /[\u{1F300}-\u{1FAFF}]/u);
});

test("approved live layouts keep mobile context and translation-first host structure", async () => {
  const [viewer, demo, dashboard, css] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/app/m/watch/demo/page.tsx"),
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/app/globals.css"),
  ]);

  assert.match(viewer, /ViewerSessionContext title=\{viewer\.session\.title\} scheduledAt=\{viewer\.session\.scheduledAt\}/);
  assert.match(demo, /2026년 2분기 실적 발표/);
  assert.match(demo, /2026-08-31T13:30:00\+09:00/);
  assert.match(demo, /buildTranslationLanes\(null, \["ko", "en"\]\)/u);
  assert.match(demo, /projectCaptionLane\(inputs, selectedLane\)/u);
  assert.match(demo, /previewState === "empty"/u);
  assert.match(demo, /previewState === "degraded"/u);
  assert.match(css, /\.live-viewer-shell\.is-compact \.live-viewer-toolbar \{[^}]*flex-wrap: nowrap/s);
  assert.match(css, /\.live-viewer-restoring\s*\{[^}]*min-height:\s*100dvh/s);
  assert.doesNotMatch(css, /\.live-speak-(?:bar|button)/u);
  assert.match(dashboard, /className="live-host-rail"/);
  const hostLiveSurface = await read("webapp/components/live/quality/HostLiveSurface.tsx");
  assert.match(hostLiveSurface, /className="live-host-translation-composition"/);
  assert.match(hostLiveSurface, /className="live-host-inspector"/);
  assert.doesNotMatch(dashboard, /className="live-setup-mobile-access"/);
  assert.match(dashboard, /"세션 만들기"/);
  assert.match(dashboard, /placeholder="YYYY-MM-DD"/);
  assert.match(dashboard, /placeholder="HH:MM"/);
  assert.doesNotMatch(dashboard, /type="date"/);
  assert.doesNotMatch(dashboard, /type="time"/);
});

test("viewer schedule formatting is deterministic across browser engines and hydration", async () => {
  const viewer = await read("webapp/components/live/LiveViewer.tsx");
  const functionMatch = viewer.match(/export function formatSessionSchedule\(scheduledAt: string \| null, systemLanguage: SystemLanguage = "ko"\): string \{\n([\s\S]*?)\n\}/u);

  assert.ok(functionMatch, "formatSessionSchedule must remain independently testable");
  assert.doesNotMatch(functionMatch[0], /toLocaleString|toLocaleDateString|toLocaleTimeString|Intl\./);
  const scheduleMessages = {
    ko: { "지금 시작": "지금 시작" },
    en: { "지금 시작": "Starting now" },
    ja: { "지금 시작": "まもなく開始" },
  };
  const formatSystemText = (messages, language, key) => {
    assert.equal(messages, scheduleMessages);
    assert.equal(key, "지금 시작");
    return messages[language][key];
  };
  const evaluateSchedule = new Function("scheduledAt", "systemLanguage = 'ko'", "formatSystemText", "viewerMessages", functionMatch[1]);
  const formatSessionSchedule = (scheduledAt, language) => evaluateSchedule(scheduledAt, language, formatSystemText, scheduleMessages);

  assert.equal(formatSessionSchedule(null), "지금 시작");
  assert.equal(formatSessionSchedule("invalid"), "지금 시작");
  assert.equal(formatSessionSchedule("2026-07-23T05:00:00.000Z"), "7월 23일 · 14:00");
  assert.equal(formatSessionSchedule("2026-07-23T14:00:00+09:00"), "7월 23일 · 14:00");
  assert.equal(formatSessionSchedule("2026-07-23T15:00:00.000Z"), "7월 24일 · 00:00");
  assert.equal(formatSessionSchedule("2026-07-24T03:05:00.000Z"), "7월 24일 · 12:05");
  assert.equal(formatSessionSchedule("2026-07-23T15:00:00.000Z", "en"), "7/24 · 00:00 KST");
  assert.equal(formatSessionSchedule("2026-07-23T15:00:00.000Z", "ja"), "7月24日 · 00:00");
  for (const language of ["ko", "en", "ja"]) {
    assert.equal(formatSessionSchedule(null, language), scheduleMessages[language]["지금 시작"]);
    assert.equal(formatSessionSchedule("invalid", language), scheduleMessages[language]["지금 시작"]);
  }
});

test("login surface localizes NOVA system labels while preserving credential field contracts", async () => {
  const [login, controls] = await Promise.all([
    read("webapp/app/(login)/login/page.tsx"),
    read("webapp/components/ui/FormControls.tsx"),
  ]);

  assert.doesNotMatch(login, /라이브 콜을 시작하고 운영합니다/);
  assert.doesNotMatch(login, /id="login-name"|name="name"/);
  assert.match(login, /id="login-id" name="id" label=\{t\("아이디"\)\} type="text" autoComplete="username"/);
  assert.match(login, /id="login-password" name="password" label=\{t\("비밀번호"\)\} type="password" autoComplete="current-password"/);
  assert.match(login, /<FormButton\b[\s\S]*?\{t\(submitting \? "로그인 중…" : "로그인"\)\}[\s\S]*?<\/FormButton>/u);
  assert.match(login, /<FormError>\{t\(error\)\}<\/FormError>/u);
  assert.match(controls, /role="alert"/u);
  assert.match(login, /관리자 로그인/);
  assert.match(login, /href="\/watch">\{t\("참가자로 입장"\)\}/);
  assert.doesNotMatch(login, /label="Display name"|label="Password"|>Sign in|Internal access only/);
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

test("host polls session state without overlapping requests or overwriting edit fields", async () => {
  const dashboard = await read("webapp/components/live/LiveHostDashboard.tsx");
  const hostSurface = await read("webapp/components/live/host-surface.ts");

  assert.match(dashboard, /window\.setInterval\([^,]+, 5_000\)/s);
  assert.match(dashboard, /isRequestPending/);
  assert.match(dashboard, /new AbortController\(\)/);
  assert.match(dashboard, /window\.clearInterval\(timer\)/);
  assert.match(dashboard, /requestController\?\.abort\(\)/);
  assert.match(dashboard, /method: "GET"/);
  assert.match(dashboard, /mergePolledHostSession\(current, latest\)/);
  assert.match(hostSurface, /if \(!current \|\| current\.id !== latest\.id\) return current;/u,
    "a late response from another session must not overwrite the active session");
  assert.match(hostSurface, /\.\.\.latest,[\s\S]{0,120}languages: \[\.\.\.latest\.languages\]/u,
    "polling must merge the latest server settings and clone its language list");
  assert.match(hostSurface, /version: latest\.version/);
  assert.match(dashboard, /GatewayConnectionStatus state=\{hostConnectionState\}/u);
  assert.match(dashboard, /\{t\("\{count\}명 참여", \{ count: session\.viewerCount \}\)\} · \{t\(formatSessionStatus\(session\.status\)\)\}/u);
  assert.doesNotMatch(dashboard, /setSession\(latest\)/);
});

test("viewer requires email and derives invite versus code entry from the URL", async () => {
  const [viewer, viewerContract, consentFields, admissionLink] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/viewer-controller-contract.ts"),
    read("webapp/components/live/consent/ParticipantConsentFields.tsx"),
    read("webapp/components/live/admission-link.ts"),
  ]);

  assert.match(viewer, /window\.location\.hash/);
  assert.match(admissionLink, /inviteTokenPattern\.test\(inviteToken\)/);
  assert.match(viewer, /history\.replaceState\(null, "", `\$\{window\.location\.pathname\}\$\{window\.location\.search\}\$\{admissionLink\.canonicalHash\}`\)/);
  assert.match(viewer, /normalizeEmail\(email\)/);
  assert.match(viewerContract, /\.normalize\("NFC"\)\.trim\(\)/);
  assert.match(viewer, /accessCode: normalizedAdmissionCode/);
  assert.match(viewer, /email: normalizedEmail/);
  assert.match(viewer, /company: normalizedCompany/);
  assert.match(viewer, /department: normalizedDepartment/);
  assert.match(viewer, /jobTitle: normalizedJobTitle/);
  assert.match(viewer, /inviteToken: pendingInviteToken/);
  assert.match(viewer, /id="live-email" name="email"/);
  assert.match(viewer, /id="live-company" name="company"/);
  assert.match(viewer, /id="live-department"/);
  assert.match(viewer, /id="live-job-title"/);
  assert.match(viewer, /id="live-access-code" name="accessCode"/);
  assert.match(viewer, />\{t\("이메일"\)\}</);
  assert.match(viewer, /const hasValidProfile = \/\^\\S\+@\\S\+\\\.\\S\+\$\/u\.test\(normalizeEmail\(email\)\)/);
  assert.doesNotMatch(viewer, /hasValidProfile[\s\S]{0,180}normalizeProfileField\(department\)/u);
  assert.match(viewer, /const isInviteJoin = Boolean\(pendingInviteToken\)/);
  assert.doesNotMatch(viewer, /joinMethod|live-join-methods/u);
  assert.match(viewer, /<summary>\{t\("선택 정보"\)\}<\/summary>/);
  assert.doesNotMatch(viewer, /id="live-department"[\s\S]{0,350}required/u);
  assert.doesNotMatch(viewer, /id="live-job-title"[\s\S]{0,350}required/u);
  assert.match(viewer, /setEmail\(result\.self\.email\)/u);
  assert.match(viewer, /setSummaryDeliveryConsent\(result\.self\.summaryConsent\)/u);
  assert.match(consentFields, /name="privacyConsent"[^>]*required/u);
  assert.match(consentFields, /name="summaryDeliveryConsent"/u);
  assert.match(consentFields, /name="marketingConsent"/u);
  assert.match(viewer, /id="live-display-name" name="displayName"[\s\S]{0,450}required/u);
  assert.match(viewer, /displayName: normalizedDisplayName/u);
  assert.match(viewer, /라이브 참여/);
  assert.match(viewerContract, /CAPACITY_REACHED/);
  assert.match(viewerContract, /INVITE_EXPIRED/);
  assert.match(viewer, /autoComplete="one-time-code"/);
  assert.match(viewer, /replace\(\/\\D\/gu, ""\)\.slice\(0, 6\)/);
  assert.doesNotMatch(viewer, /realtime-noel-viewer-join/);
  assert.doesNotMatch(viewer, /window\.addEventListener\("message"/);
  assert.doesNotMatch(viewerContract, /viewerToken/u);
  const parentMessage = viewer.match(/window\.parent\.postMessage\(\{[\s\S]*?\}, "\*"\)/u)?.[0] ?? "";
  assert.match(parentMessage, /sessionType[\s\S]*outputMode/u);
  assert.doesNotMatch(parentMessage, /email|displayName|company|department|jobTitle|token|ticket/iu);
});

test("viewer refresh restores from cookie-only non-sensitive context without redeeming again", async () => {
  const [viewer, recovery, recoveryHook] = await Promise.all([
    read("webapp/components/live/LiveViewer.tsx"),
    read("webapp/components/live/viewer-session-recovery.ts"),
    read("webapp/components/live/useViewerRecovery.ts"),
  ]);

  assert.match(recoveryHook, /viewerRestorePromiseRef/u,
    "StrictMode must share one in-flight restoration and caption subscription");
  assert.match(viewer, /fetch\(\s*`\/api\/live-sessions\/\$\{stored\.sessionId\}\/viewer-session`,\s*\{ method: "GET", cache: "no-store" \}/u);
  assert.match(viewer, /if \(!isViewerJoinData\(result\)\)/u);
  assert.match(viewer, /if \(result\.session\.id !== stored\.sessionId\)/u);
  assert.match(viewer, /if \(isRestoringViewer\)[\s\S]*라이브 세션으로 돌아가는 중입니다/u,
    "the join form must not flash while cookie restoration is unresolved");
  assert.match(viewer, /persistSession: false/u);
  assert.doesNotMatch(recovery, /email|viewerToken|viewerGatewayTicket|ticket|company|department|jobTitle|summaryConsent/u);
  assert.doesNotMatch(viewer, /localStorage\.(?:setItem|getItem)\([^\n]*(?:email|displayName|company|department|jobTitle|token|ticket)/iu);
  assert.doesNotMatch(viewer, /sessionStorage/iu);
  assert.doesNotMatch(viewer, /interface ViewerState[\s\S]{0,160}accessToken:/u);
});

test("host keeps translations primary and displays host-only participant identity plus consent", async () => {
  const [dashboard, hostClient, css, liveSurface] = await Promise.all([
    read("webapp/components/live/LiveHostDashboard.tsx"),
    read("webapp/components/live/live-audio-client.ts"),
    read("webapp/app/globals.css"),
    read("webapp/components/live/quality/HostLiveSurface.tsx"),
  ]);

  assert.match(dashboard, /\/participants`/);
  assert.match(dashboard, /Promise\.all/);
  assert.match(liveSurface, /<TranslationViewport/);
  assert.match(liveSurface, /<CaptionEntry/);
  assert.doesNotMatch(dashboard, /<LanguageSelector/);
  assert.match(liveSurface, /<HostAiHealthDisclosure rows=\{aiHealthRows\}/u);
  assert.match(liveSurface, /<TranslationToolbar/);
  assert.match(dashboard, /t\("참여자 · \{present\}\/\{total\}", \{ present: participants\.filter\(\(participant\) => participant\.isPresent\)\.length, total: participants\.length \}\)/);
  assert.match(dashboard, /resolveHostParticipantPresentation\(participant\)/);
  assert.match(dashboard, />\{t\("부서"\)\}</);
  assert.match(dashboard, />\{t\("직급"\)\}</);
  assert.match(dashboard, />\{t\("요약 이메일"\)\}</);
  assert.match(dashboard, /presentation\.hasSummaryConsent/);
  assert.match(liveSurface, /자막 일시 정지/);
  assert.match(liveSurface, /자막 계속/);
  assert.match(dashboard, />\{t\("자막 다시 시작"\)\}</);
  assert.match(liveSurface, />\{t\("세션 종료…"\)\}</);
  assert.match(hostClient, /type: "restart"/);
  assert.match(hostClient, /waitForStartedMessage\(socket, 5_000, "restarted"\)/);
  assert.match(css, /\.live-host-translation-primary\s*\{[^}]*min-height:\s*60vh/s);
  assert.match(css, /\.live-participant-list/);
  assert.match(css, /\.live-participant-row/);
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

test("desktop local output is captions-only with no translated-audio playback lane", async () => {
  const [html, css, dashboard] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle.css"),
    read("public/subtitle-dashboard.js"),
  ]);

  assert.match(html, /<input name="outputMode" type="hidden" value="captions"\s*\/?>/);
  assert.doesNotMatch(html, /pt-output-group|pt-playback-options|audioLanguage|audioVolume|voiceProvider/);
  assert.doesNotMatch(html, /자막 엔진은 Gemini 고정이며/);
  assert.doesNotMatch(html, /pt-voice-method-help/);
  assert.match(html, /data-i18n="output\.engineNote"[\s\S]{0,80}data-i18n="output\.engineNoteValue"/);
  assertLocalized("output.engineNote", { ko: /자막 엔진/ });
  assertLocalized("output.engineNoteValue", { ko: /Gemini 고정/ });
  assert.doesNotMatch(html, /pt-output-routing-help/);
  assert.doesNotMatch(css, /\.pt-output-group|\.pt-playback-options/);
  assert.match(dashboard, /outputMode: "captions"/);
  assert.doesNotMatch(dashboard, /OPENAI_REALTIME_TRANSLATION_LANGUAGES/);
  assert.doesNotMatch(dashboard, /openAIInput\.disabled|selectedVoiceProvider/);
  assert.doesNotMatch(dashboard, /subtitle-audio-player|subtitle:translated-audio|subtitle:audio-control/);
  assert.doesNotMatch(dashboard, /form\.elements\.(?:audioLanguage|audioVolume|voiceProvider)|\b(?:audioLanguage|audioVolume|voiceProvider)\s*:|start\.audio/);
  assert.match(dashboard, /RETIRED_SUBTITLE_SETTING_KEYS/);
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
  assert.doesNotMatch(html, /name="liveDisplayLanguage"/);
  assert.doesNotMatch(html, /data-i18n="live\.captionLanguagePolicy"/);
  assert.match(html, /id="live-draft-languages"[^>]*aria-live="polite"/);
  assert.match(html, /id="live-host-login-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /id="open-meeting-mode"|name="liveHostWorkspaceUrl"|Open Live Call/);
  assert.match(css, /\.live-draft-cover-status\.is-error/);

  assert.doesNotMatch(workspace, /liveDraftAccess|liveHostWorkspaceUrl|openLiveWorkspace/);
  assert.match(workspace, /const MAX_COVER_IMAGE_BYTES = 20 \* 1024 \* 1024/);
  assert.match(workspace, /new Set\(\["image\/jpeg", "image\/png", "image\/webp"\]\)/);
  assert.match(workspace, /await file\.arrayBuffer\(\)/);
  assert.match(workspace, /function hasValidCoverImageSignature\(bytes, contentType\)/);
  assert.match(workspace, /if \(!hasValidCoverImageSignature\(bytes, file\.type\)\)/);
  assert.match(workspace, /contentType: file\.type/);
  assert.match(workspace, /size: file\.size/);
  assert.match(workspace, /base64: window\.btoa\(binary\)/);
  assert.match(workspace, /coverImage: liveDraftCoverData/);
  assert.match(html, /최대 20MB/);
  assertLocalized("live.coverTooLarge", { en: /20MB/, ko: /20MB/ });
  assertLocalized("live.err.COVER_UPLOAD_NETWORK_FAILED", { en: /network connection/, ko: /네트워크 연결/ });
  assertLocalized("live.err.COVER_UPLOAD_RATE_LIMITED", { en: /Too many cover uploads/, ko: /요청이 너무 많습니다/ });
  assertLocalized("live.err.COVER_FINALIZE_CONFLICT", { en: /Another cover was saved first/, ko: /다른 커버가 먼저 저장/ });
  assert.doesNotMatch(workspace, /liveDisplayLanguage|displayLanguage/u);
  assert.match(workspace, /startRegisteredLiveCall\(sessionId\)/);
  assert.match(workspace, /result\?\.code === "HOST_LOGIN_REQUIRED"/);
  assert.match(workspace, /t\("live\.hostLoginRequired"\)/);
  assertLocalized("live.hostLoginRequired", { en: /Open Settings and sign in/ });
  assert.doesNotMatch(workspace, /Sign in once in the Live workspace window|login page|login screen/i);
});

test("desktop account controls use the shared web sign-in and preserve explicit live start", async () => {
  const workspace = await read("public/subtitle-workspace.js");
  assert.match(workspace, /HOST_LOGIN_REJECTED/);
  assert.match(workspace, /t\("live\.hostLoginRejected"\)/);
  assertLocalized("live.hostLoginRejected", { en: /Open Settings and sign in again/ });
  assert.match(workspace, /await bridge\.getHostSession\(\)/);
  assert.match(workspace, /await bridge\.openHostLogin\(\)/);
  assert.match(workspace, /await bridge\.logoutHostSession\(\)/);
  assert.match(workspace, /settings\.hostSessionUnavailable/);
  assert.match(workspace, /LIVE_SESSION_ACTIVE/);
  assert.doesNotMatch(workspace, /saveLiveHostLogin|liveHostPassword|pendingLiveCallRetry|startLiveCallButton\?\.click\(\)/);
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
  const controllerBody = html.slice(
    html.indexOf('<div class="controller-body">'),
    html.indexOf("</div>\n    </main>"),
  );
  assert.match(controllerBody, /id="controller-live-call"/u,
    "Live Call controls must stay inside the same controller row as Caption Only controls");
  const controllerBodyRule = css.match(/\.subtitle-controller-body \.controller-body\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(controllerBodyRule, /flex-direction:\s*row;/u);
  assert.match(controllerBodyRule, /flex-wrap:\s*nowrap;/u,
    "revealing Live Call controls must widen the pill instead of creating a second row");
  const compactControllerStart = css.indexOf("@media (max-width: 1500px)");
  const compactController = css.slice(
    compactControllerStart,
    css.indexOf("@media (max-width: 820px)", compactControllerStart),
  );
  assert.notEqual(compactController, "",
    "the initial 1152px Electron viewport needs a compact one-row controller contract");
  assert.match(compactController, /\.caption-controller-window\s*\{[^}]*gap:\s*6px;[^}]*padding:\s*6px 8px;/su);
  assert.match(compactController, /\.controller-body\s*\{[^}]*gap:\s*4px;/su);
  assert.match(compactController, /\.mp-brand\s*\{[^}]*flex-basis:\s*124px;/su);
  assert.match(compactController, /\.controller-opacity input\s*\{[^}]*width:\s*58px;/su);
  assert.match(compactController, /\.controller-display-select\s*\{[^}]*width:\s*132px;/su);
  assert.match(compactController, /\.controller-tick > span:last-child\s*\{[^}]*position:\s*absolute;[^}]*clip-path:\s*inset\(50%\);/su,
    "All screens keeps its accessible name without spending visible row width");
  assert.match(css, /\.subtitle-controller-body \.controller-button,[\s\S]{0,180}min-height:\s*24px;/u,
    "compact controls must preserve a 24px minimum hit height");
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
  assert.match(main, /armedSession\.liveStartedAt = typeof currentSession\.data\.startedAt === "string"/);
  assert.match(controllerJs, /state\.liveStartedAt/);
});

test("floating controller announces operator-only translation health without overlay error copy", async () => {
  const [html, controllerJs, css, overlay] = await Promise.all([
    read("public/subtitle-controller.html"),
    read("public/subtitle-controller.js"),
    read("public/subtitle.css"),
    read("public/subtitle-overlay.js"),
  ]);

  assert.match(html, /id="controller-live-call-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u);
  assert.match(html, /id="controller-health-detail"[^>]*aria-hidden="true"/u,
    "the one-second elapsed counter must not cause repeated screen-reader announcements");
  assert.match(controllerJs, /function syncLiveBridgeStatus\(state\)/u);
  assert.match(controllerJs, /TRANSLATION_EVENT_STALE_MS = 5_000/u);
  assert.match(controllerJs, /message\.type === "subtitle:input-status"/u);
  assert.match(controllerJs, /message\.type === "subtitle:partial" \|\| message\.type === "subtitle:committed"/u);
  assert.match(controllerJs, /translationHealth\.socketState !== "open"/u);
  assert.match(controllerJs, /\["connecting", "reconnecting"\]\.includes\(translationHealth\.bridgeState\)/u);
  assert.match(controllerJs, /now - translationHealth\.lastEventAt > TRANSLATION_EVENT_STALE_MS/u);
  assert.match(controllerJs, /window\.setInterval\(\(\) => renderTranslationHealth\(\), 1_000\)/u);
  assert.match(controllerJs, /if \(isLiveActionStatusLocked\) return/u,
    "polling must not overwrite an in-progress Go-Live, Host Speak, or End status");
  assert.match(controllerJs, /goLiveButton\.setAttribute\("aria-busy", "true"\)/u);
  assert.match(controllerJs, /goLiveButton\.removeAttribute\("aria-busy"\)/u);
  assertLocalized("controller.health.healthy", { en: /^Translation healthy$/, ko: /^번역 정상$/ });
  assertLocalized("controller.health.waiting", { en: /^Translation waiting$/, ko: /^번역 대기$/ });
  assertLocalized("controller.health.recovering", { en: /^Recovering translation$/, ko: /^복구 중$/ });
  assertLocalized("controller.health.disconnected", { en: /^Translation disconnected$/, ko: /^연결 끊김$/ });
  assert.match(css, /\.mp-status\[data-connection-state="healthy"\][^}]*var\(--nova-status-ok\)/u);
  assert.match(css, /\.mp-status\[data-connection-state="disconnected"\][^}]*var\(--nova-status-error\)/u);
  assert.match(css, /\.mp-status-detail[^}]*font-variant-numeric: tabular-nums/u);
  assert.doesNotMatch(overlay, /controller\.health|Translation healthy|번역 정상|자막 다시 시작/u,
    "operational health belongs to the controller, never the audience overlay");
  assert.match(css, /transition: color var\(--nova-dur-rapid\) var\(--nova-ease-out\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*--nova-dur-rapid: 1ms/u);
});

test("controller health distinguishes healthy, waiting, stale recovery, and disconnection", async () => {
  const controllerJs = await read("public/subtitle-controller.js");
  const healthStateSource = controllerJs.slice(
    controllerJs.indexOf("function translationHealthState"),
    controllerJs.indexOf("function translationHealthDetail"),
  );
  const evaluate = new Function(
    "translationHealth",
    "now",
    "TRANSLATION_EVENT_STALE_MS",
    "TRANSLATION_ACTIVE_CAPTION_MS",
    `${healthStateSource}; return translationHealthState(now);`,
  );
  const now = 20_000;
  const base = {
    socketState: "open",
    bridgeState: "connected",
    lastEventAt: now - 1_000,
    lastCaptionAt: now - 1_000,
    signalSinceAt: now - 2_000,
    lastInputStatus: "signal",
    pipelineStatus: "listening",
  };

  assert.equal(evaluate(base, now, 5_000, 3_000), "healthy");
  assert.equal(evaluate({ ...base, lastCaptionAt: null, signalSinceAt: now - 1_000 }, now, 5_000, 3_000), "waiting",
    "the first signal gets a grace window instead of an immediate failure");
  assert.equal(evaluate({ ...base, lastCaptionAt: null, signalSinceAt: now - 3_001 }, now, 5_000, 3_000), "recovering",
    "continuous signal without any translated output becomes a recovery state");
  assert.equal(evaluate({ ...base, lastCaptionAt: now - 3_001, signalSinceAt: now - 5_000 }, now, 5_000, 3_000), "recovering",
    "a prior caption cannot mask a later output stall during continuous speech");
  assert.equal(evaluate({ ...base, lastInputStatus: "silent" }, now, 5_000, 3_000), "waiting");
  assert.equal(evaluate({ ...base, lastEventAt: now - 5_001 }, now, 5_000, 3_000), "recovering");
  assert.equal(evaluate({ ...base, bridgeState: "reconnecting" }, now, 5_000, 3_000), "recovering");
  assert.equal(evaluate({ ...base, socketState: "closed" }, now, 5_000, 3_000), "disconnected");
  assert.equal(evaluate({ ...base, bridgeState: "failed" }, now, 5_000, 3_000), "disconnected");
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

test("desktop floating controller cannot switch the fixed Gemini provider", async () => {
  const [html, js] = await Promise.all([
    read("public/subtitle-controller.html"),
    read("public/subtitle-controller.js"),
  ]);

  assert.doesNotMatch(html, /controller-voice-provider|data-controller-voice-provider|통역 음성 엔진/);
  assert.doesNotMatch(js, /command: "voice-provider"|data-controller-voice-provider/);
});

test("participant floor silently gates every Electron host-audio path until Host Speak reclaims it", async () => {
  const [main, dashboard, controllerHtml, controllerJs, overlayHtml] = await Promise.all([
    read("electron/main.js"),
    read("public/subtitle-dashboard.js"),
    read("public/subtitle-controller.html"),
    read("public/subtitle-controller.js"),
    read("public/subtitle-overlay.html"),
  ]);

  const floorHandler = main.slice(
    main.indexOf('message.type === "floor"'),
    main.indexOf('message.type === "error"'),
  );
  const floorRendererRelay = main.slice(
    main.indexOf("function relayLiveCallFloorToRenderers"),
    main.indexOf("// The controller polls live-call:get-state"),
  );
  const gatewayAudioPath = main.slice(
    main.indexOf('ipcMain.on("live-call:audio-frame"'),
    main.indexOf('ipcMain.handle("live-call:end"'),
  );
  const liveBridgeCapture = dashboard.slice(
    dashboard.indexOf("async function startLiveCallMicCapture"),
    dashboard.indexOf("function requestLocalSubtitlePreflight"),
  );
  const floorGate = dashboard.slice(
    dashboard.indexOf("function applyLiveCallFloorGate"),
    dashboard.indexOf("function stopLiveCallAudioBridge"),
  );

  // A participant floor is an audio boundary, not merely an overlay repaint:
  // main must close the gateway path before relaying the event to renderers.
  assert.match(floorHandler, /shouldBlockLiveHostAudioForFloor/u);
  assert.match(floorHandler, /isHostAudioBlocked/u);
  assert.ok(
    floorHandler.search(/isHostAudioBlocked/u) < floorHandler.indexOf("relayLiveCallFloorToRenderers"),
    "the host gate must close before any renderer can process the participant floor",
  );
  assert.match(floorRendererRelay, /\[dashboardWindow,\s*\.\.\.overlayWindows\.values\(\)\]/u);
  assert.match(floorRendererRelay, /webContents\.send\("live-call:floor", message\)/u);
  assert.doesNotMatch(floorRendererRelay, /controllerWindow/u);
  // The gateway half is host PCM, and a participant floor closes it before any
  // resampling. The local caption TEXT is never forwarded — the gateway
  // translates the same audio itself for the web app.
  assert.match(gatewayAudioPath, /if \(!bridge\.floorKnown \|\| bridge\.isHostAudioBlocked\) return;/u);
  assert.ok(
    gatewayAudioPath.indexOf("bridge.isHostAudioBlocked") < gatewayAudioPath.indexOf("adaptCaptionPcmForGateway"),
    "a blocked host must not reach the resampler at all",
  );
  assert.doesNotMatch(main, /type: "host-caption"|relayLiveCallHostCaption|onLiveCallLocalCaption/u);

  // The renderer has one Live Call capture path. The floor signal gates it
  // before IPC, and cannot start a second local subtitle producer.
  assert.match(dashboard, /onLiveCallFloor/u);
  assert.match(dashboard, /applyLiveCallFloorGate/u);
  // One capture, two sinks: the local server keeps the screen captions alive
  // through a participant turn while main gates the gateway half.
  assert.match(dashboard, /forwardLiveCallHostAudioPacket/u);
  assert.match(dashboard, /type: "subtitle:audio"/u);
  assert.match(dashboard, /sendLiveCallAudioFrame/u);
  assert.doesNotMatch(floorGate, /startLocalLiveCallFallback|restoreGatewayCaptionProducer|requestSubtitleStart|subtitle:audio/u);
  assert.doesNotMatch(dashboard, /async function startLocalLiveCallFallback|async function restoreGatewayCaptionProducer/u);

  // No new floor UI competes with captions. The existing explicit Host Speak
  // button remains the sole host override and the overlay stays caption-only.
  assert.match(controllerHtml, /id="controller-host-speak"/u);
  assert.match(controllerJs, /window\.realtimeNoelDesktop\.hostSpeak\(\)/u);
  assert.doesNotMatch(controllerHtml, /participant-floor|floor-warning|floor-modal/u);
  assert.doesNotMatch(overlayHtml, /button|participant-floor|floor-warning/u);
});

test("explicit caption stop and Live Call end clear every visible subtitle surface without erasing records", async () => {
  const [main, dashboard, overlay, server] = await Promise.all([
    read("electron/main.js"),
    read("public/subtitle-dashboard.js"),
    read("public/subtitle-overlay.js"),
    read("src/server.js"),
  ]);

  const stopSubtitles = dashboard.slice(
    dashboard.indexOf("async function stopSubtitles"),
    dashboard.indexOf("// Rebuild the running session's translation channels"),
  );
  const clearActiveSurface = dashboard.slice(
    dashboard.indexOf("function clearActiveSubtitleSurface"),
    dashboard.indexOf("async function reconnectLiveCallTranslation"),
  );
  const liveFloorListener = dashboard.slice(
    dashboard.indexOf("function applyLiveCallFloorGate"),
    dashboard.indexOf("function stopLiveCallAudioBridge"),
  );
  const rendererRelay = main.slice(
    main.indexOf("function relayLiveCallFloorToRenderers"),
    main.indexOf("// The controller polls live-call:get-state"),
  );
  const endLiveCall = main.slice(
    main.indexOf('ipcMain.handle("live-call:end"'),
    main.indexOf('ipcMain.handle("subtitle-overlay:get-enabled"'),
  );
  const serverStop = server.slice(
    server.indexOf('if (message.type === "subtitle:stop")'),
    server.indexOf("await transcriptRecordTail"),
  );
  const overlayTerminalListener = overlay.slice(
    overlay.indexOf("function handleLiveCallFloorBoundary"),
    overlay.indexOf("// Re-render every lane in a zone"),
  );
  const clearOverlay = overlay.slice(
    overlay.indexOf("function clearSubtitle()"),
    overlay.indexOf("function clearSubtitleLane"),
  );
  const clearSpeakerMetadata = overlay.slice(
    overlay.indexOf("function clearLiveLaneRuntime"),
    overlay.indexOf("// When the spoken (source) language switches"),
  );

  // Stop is a visible terminal boundary, regardless of whether the server is
  // available to echo an idle status. It clears both committed and partial
  // preview text but deliberately leaves the Records model untouched.
  assert.match(stopSubtitles, /clearActiveSubtitleSurface\(\)/u);
  assert.match(clearActiveSurface, /previewStatusTimer/u);
  assert.match(clearActiveSurface, /translation-line[^\n]*\.textContent = ""/u);
  assert.match(clearActiveSurface, /source-line[^\n]*\.textContent = ""/u);
  assert.match(clearActiveSurface, /classList\.remove\("partial"\)/u);
  assert.doesNotMatch(clearActiveSurface, /state\.history|renderHistory|sessionRecords/u);

  // Gateway-backed Live Calls keep the local realtime manager cold, so the
  // accepted stop itself must still publish the same idle boundary used by
  // Caption-only. That gives every overlay one shared terminal clear path.
  assert.match(serverStop, /broadcastSubtitleMessage\(\{\s*type: "subtitle:status",\s*status: "idle"/u);
  assert.match(dashboard, /message\.type === "subtitle:status"[\s\S]{0,800}message\.status === "idle"[\s\S]{0,200}clearActiveSubtitleSurface\(\)/u);

  // Live End cannot wait for the dashboard's polling interval. Main sends an
  // exact-session terminal signal through the existing floor channel; the
  // dashboard stops its caption session and the overlay clears immediately.
  assert.match(endLiveCall, /type: "live-call-ended"/u);
  assert.match(endLiveCall, /relayLiveCallFloorToRenderers/u);
  assert.match(rendererRelay, /webContents\.send\("live-call:floor", message\)/u);
  assert.match(liveFloorListener, /floor\?\.type === "live-call-ended"/u);
  assert.match(liveFloorListener, /floor\.sessionId/u);
  assert.match(liveFloorListener, /activeLiveFloorSessionId/u);
  assert.match(liveFloorListener, /stopSubtitles\(\)/u);
  assert.match(overlayTerminalListener, /floor\?\.type === "live-call-ended"/u);
  assert.match(overlayTerminalListener, /floor\.sessionId !== activeLiveCallSessionId/u);
  assert.match(overlayTerminalListener, /clearSubtitle\(\)/u);

  // A full overlay clear also clears the Live speaker row; hiding text alone
  // would leave stale accessibility/metadata state behind.
  assert.match(clearOverlay, /clearLiveLaneRuntime\(lane\)/u);
  assert.match(clearSpeakerMetadata, /speakerLabel\.hidden = true/u);
  assert.match(clearSpeakerMetadata, /speakerLabel\.textContent = ""/u);

  // Reconnect is not termination. Existing captions stay visible while the
  // transport recovers instead of flashing an empty overlay.
  const reconnect = dashboard.slice(
    dashboard.indexOf("async function recoverLiveCaptionSocket"),
    dashboard.indexOf("function requestSubtitleStart"),
  );
  assert.doesNotMatch(reconnect, /clearActiveSubtitleSurface|live-call-ended|stopSubtitles/u);
});

test("the selected desktop overlay recovers Live Call captions from one canonical visible timeline", async () => {
  const [main, overlay, channels, css] = await Promise.all([
    read("electron/main.js"),
    read("public/subtitle-overlay.js"),
    read("src/subtitle-channels.js"),
    read("public/subtitle.css"),
  ]);

  const gatewayCaptionHandler = main.slice(
    main.indexOf("bridge.captionRelay = createLiveCaptionIpcRelay"),
    main.indexOf('socket.on("open"'),
  );
  const snapshotHandler = overlay.slice(
    overlay.indexOf('if (message.type === "subtitle:snapshot")'),
    overlay.indexOf("// The server already filters subscribed channels"),
  );

  // Gateway captions enter the dashboard once and then the local subtitle hub
  // fans out one ordered stream. The selected overlay never gets a second raw
  // Gateway path that could disagree with the web transcript.
  assert.match(gatewayCaptionHandler, /dashboardWindow\.webContents\.send\("live-call:caption", caption\)/u);
  assert.doesNotMatch(gatewayCaptionHandler, /overlayWindows|eachOverlayWindow/u);

  // A connected overlay retains a short roll-up (N + N+1). Therefore a newly
  // selected or recovered display cannot receive only the latest event (N+1):
  // the snapshot must carry the same bounded, seq-ordered visible Live Call
  // timeline and the renderer must replace its Live model from that snapshot.
  assert.match(channels, /LIVE_CALL_DISPLAY_HISTORY_LIMIT/u);
  assert.match(channels, /liveCallDisplayTimeline/u);
  assert.match(channels, /source === "live-call"/u);
  assert.match(channels, /sort\(\(left, right\) => left\.seq - right\.seq\)/u);
  assert.match(snapshotHandler, /replaceLiveCallSubtitleSnapshot\(message\)/u);

  // Live Call direction time is stamped once in the canonical hub so selecting
  // another display cannot re-evaluate the same language switch differently.
  // Caption-only keeps its existing local timing fallback and visual behaviour.
  assert.match(channels, /now = Date\.now/u);
  assert.match(channels, /displayTimestamp: now\(\)/u);
  const directionGate = overlay.slice(
    overlay.indexOf("function acceptDirection"),
    overlay.indexOf("// ── Live Call speaker identity"),
  );
  assert.match(directionGate, /message\.source === "live-call"/u);
  assert.match(directionGate, /message\.displayTimestamp/u);
  assert.match(directionGate, /Date\.now\(\)/u);

  // This is a state-consistency fix only. The overlay remains caption-only and
  // Caption-only keeps its existing line budget and styling path.
  assert.match(overlay, /lane\.isLiveCall \? Math\.min\(3, Math\.max\(2, sharedLimit\)\) : sharedLimit/u);
  assert.match(overlay, /setProperty\("--subtitle-max-width", `\$\{settings\.maxWidth\}px`\)/u);
  assert.match(css, /\.subtitle-box\s*\{[^}]*88vw/su);
});

test("floating controller selects one connected caption display with an accessible live dropdown", async () => {
  const [html, controller, css, preload, main, relay] = await Promise.all([
    read("public/subtitle-controller.html"),
    read("public/subtitle-controller.js"),
    read("public/subtitle.css"),
    read("electron/preload.js"),
    read("electron/main.js"),
    read("src/live-caption-ipc-relay.js"),
  ]);

  const windowCluster = html.slice(
    html.indexOf('class="controller-cluster mp-window"'),
    html.indexOf("</div>\n      </div>\n    </main>"),
  );
  const quitIndex = windowCluster.indexOf('id="controller-quit"');
  const selectIndex = windowCluster.indexOf('id="controller-display"');
  assert.ok(quitIndex >= 0 && selectIndex > quitIndex, "display selector must be the rightmost controller control");
  assert.match(windowCluster, /<label[^>]*for="controller-display"[^>]*class="sr-only"/u);
  assert.match(windowCluster, /<select id="controller-display"[^>]*aria-label=/u);
  assert.doesNotMatch(windowCluster, /emoji|gradient|style=/iu);
  assertLocalized("controller.displaySelect", { en: /Caption display/, ko: /자막 표시 화면/ });
  assertLocalized("controller.displayLoading", { en: /Checking displays/, ko: /화면 확인 중/ });
  assertLocalized("controller.displayUnavailable", { en: /No display available/, ko: /사용 가능한 화면 없음/ });
  assertLocalized("controller.primaryDisplay", { en: /^Main$/, ko: /^메인$/ });

  assert.match(preload, /listOverlayDisplays: \(\) => ipcRenderer\.invoke\("subtitle-overlay:list-displays"\)/u);
  assert.match(preload, /selectOverlayDisplay: \(displayId\) => ipcRenderer\.invoke\("subtitle-overlay:select-display", displayId\)/u);
  assert.match(preload, /onOverlayDisplaysChanged/u);
  assert.match(preload, /return \(\) => ipcRenderer\.removeListener\("subtitle-overlay:displays-changed", handler\)/u);

  assert.match(controller, /const displaySelect = document\.getElementById\("controller-display"\)/u);
  assert.match(controller, /window\.realtimeNoelDesktop\.listOverlayDisplays\(\)/u);
  assert.match(controller, /window\.realtimeNoelDesktop\.selectOverlayDisplay\(display\.id\)/u);
  assert.match(controller, /window\.realtimeNoelDesktop\.onOverlayDisplaysChanged/u);
  assert.match(controller, /option\.textContent = display\.label/u);
  assert.match(controller, /displaySelect\.value = String\(state\.selectedDisplayId\)/u);
  assert.match(controller, /displaySelect\.disabled =/u);
  const displayController = controller.slice(
    controller.indexOf("// ── Caption display selection"),
    controller.indexOf('document.getElementById("controller-font-down")'),
  );
  assert.doesNotMatch(displayController, /innerHTML/u);

  // Main owns bounds. The renderer sends only the opaque display id and never
  // receives or echoes coordinates/URLs through the selection call.
  const selectionCall = controller.slice(
    controller.indexOf('displaySelect.addEventListener("change"'),
    controller.indexOf("// ── VU meter"),
  );
  assert.doesNotMatch(selectionCall, /bounds|workArea|url|loadURL/iu);

  assert.match(css, /\.controller-display-select\s*\{[^}]*border-radius:\s*var\(--nova-r-pill\)/su);
  assert.match(css, /\.controller-display-select:focus-visible\s*\{[^}]*2px solid var\(--nova-blue\)/su);
  assert.match(css, /\.sr-only\s*\{/u);

  // Selection is persisted and controller placement is the opposite screen;
  // one connected display remains a valid selectable state where both coexist.
  assert.match(main, /overlayDisplayId/u);
  assert.match(main, /controllerWindow/u);
  assert.match(main, /selectedDisplayId/u);
  assert.match(main, /resolveControllerDisplay/u);
  assert.match(relay, /return connected\.find\([^\n]+\) \?\? overlayDisplay \?\? primary/u);

  // The existing ResizeObserver fit-size path remains active, so a longer
  // monitor label widens the pill/window instead of clipping or adding a row.
  assert.match(controller, /new ResizeObserver\(requestFit\)\.observe\(consoleRoot\)/u);
  assert.match(controller, /fitControllerHeight\(height, width\)/u);
  assert.match(css, /\.caption-controller-window \{[^}]*width: max-content/u);
  assert.match(css, /\.caption-controller-window \{[^}]*max-width: none/u);
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
  assert.match(feed, /captionIndex >= recentFromIndex/u);
  // The card now takes only primitives and identity-stable objects — no
  // callback prop at all — which is the strongest possible form of the
  // stability the fold's useCallback used to provide.
  assert.doesNotMatch(feed, /onToggle/u);
  assert.match(feed, /const MeetingTurnCard = memo\(function MeetingTurnCard\(\{ turn, recentFromIndex \}/u);
  assert.match(feed, /turn\.captions\.some\(\(caption\) => !caption\.isFinal\)/u);
  assert.doesNotMatch(feed, /pendingText|livePartial/u);
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

test("streaming meeting captions do not replay entry animations", async () => {
  const css = await read("webapp/app/globals.css");

  assert.doesNotMatch(css, /@keyframes live-turn-in|animation:\s*live-turn-in/u);
  assert.doesNotMatch(css, /@keyframes live-overlay-in|live-speaker-change-overlay/u);

  // will-change measured no benefit here (959 vs 960 frames over 8s, worse p95)
  // and hundreds of permanently promoted cards is a compositor-memory leak, so
  // the feed must not declare it.
  const feedCss = css.slice(css.indexOf("/* Earnings-call style meeting feed */"), css.indexOf("/* Speaking-floor bar */"));
  assert.doesNotMatch(feedCss, /will-change/u);

  // Streaming caption text can update many times a second. Animating its
  // contrast on every partial/final transition makes the words look unstable
  // and compounds compositor work over a two-hour session.
  assert.match(css, /\.live-turn-card p \.live-turn-text \{ opacity: \.42; transition: none; \}/u);
});


test("controller distinguishes an armed waiting room from active live media", async () => {
  const source = await read("public/subtitle-controller.js");
  const assignment = source.match(/goLiveButton.dataset.i18n = ([^;]+);/u)?.[1];
  assert.ok(assignment);
  const label = new Function("state", `return (${assignment});`);
  assert.equal(label({ live: true, mediaWaiting: true }), "controller.waitingForParticipants");
  assert.equal(label({ live: true, mediaWaiting: false }), "controller.live");
  assert.equal(label({ live: false, mediaWaiting: true }), "controller.goLive");
  assertLocalized("controller.waitingForParticipants", { en: /^Waiting for participants$/, ko: /^참여자를 기다리고 있어요$/ });
});
