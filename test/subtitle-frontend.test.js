import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { MESSAGES } from "../public/subtitle-i18n.js";

// UI copy lives in the i18n dictionary now: surfaces carry the KEY and the copy
// must resolve in both languages (test/ui-i18n.test.js proves key parity).
/** @param {string} key @param {{ en?: RegExp, ko?: RegExp }} [patterns] */
function assertLocalized(key, patterns = {}) {
  assert.equal(typeof MESSAGES.en[key], "string", `missing en copy for ${key}`);
  assert.equal(typeof MESSAGES.ko[key], "string", `missing ko copy for ${key}`);
  if (patterns.en) assert.match(MESSAGES.en[key], patterns.en);
  if (patterns.ko) assert.match(MESSAGES.ko[key], patterns.ko);
}

const rootDir = path.join(import.meta.dirname, "..");

function extractFunctionBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.ok(signatureIndex >= 0, `${signature} must exist`);
  const openingBraceIndex = source.indexOf("{", signatureIndex);
  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBraceIndex + 1, index);
  }
  assert.fail(`${signature} must have a closing brace`);
}

// There used to be a root-vs-public sync test here, plus three more like it in
// other files. The root-level subtitle-* duplicates they policed have been
// deleted: nothing referenced them, src/server.js serves public/ only, and npm
// `files` / electron-builder `build.files` ship public/ only -- so editing a root
// copy changed nothing in the running app while looking like real work. public/
// is now the single copy, and there is nothing left to keep in sync.

test("subtitle dashboard exposes main controls, Gemma recording, and settings drawer", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const workspaceJs = readFileSync(path.join(rootDir, "public", "subtitle-workspace.js"), "utf8");
  const controllerHtml = readFileSync(path.join(rootDir, "public", "subtitle-controller.html"), "utf8");
  const controllerJs = readFileSync(path.join(rootDir, "public", "subtitle-controller.js"), "utf8");

  assert.match(html, /<title>NOVA<\/title>/);
  assert.match(html, /value="system_mic"/);
  assert.match(html, /name="openaiKey"/);
  assert.match(html, /name="openaiSecondaryKey"/);
  assert.match(html, /value="system"/);
  assert.match(html, /value="mic"/);
  // Language selection has a single source of truth: the translation-language
  // pills. The legacy Language A / Language B selects were removed.
  assert.doesNotMatch(html, /name="languageA"/);
  assert.doesNotMatch(html, /name="languageB"/);
  assert.match(html, /name="translationLanguages"/);
  assert.match(html, /class="lang-pill"/);
  assert.match(html, /id="language-targets-label"/);
  // Search-and-tag language picker: selected languages are removable chips;
  // new ones are added via type-ahead search, not a full checkbox list.
  assert.match(js, /language-search-input/);
  assert.match(js, /language-suggestions/);
  assert.match(js, /language-chip-remove/);
  assert.match(js, /t\("language\.searchPlaceholder"\)/);
  assertLocalized("language.searchPlaceholder", { ko: /언어 검색/ });
  // Source ("원문") display was removed — no toggle, always translation-only.
  assert.doesNotMatch(html, /name="showSourceText"/);
  assert.doesNotMatch(html, /원문 같이 표시/);
  assert.match(html, /name="translateAllLanguages"/);
  assert.match(js, /showSourceText: false/);
  assert.match(js, /translateAllLanguages: false/);
  assert.match(js, /translationLanguages: \["en", "ko"\]/);
  assert.match(js, /form\.elements\.translateAllLanguages/);
  assert.match(js, /readTranslationLanguagesFromForm/);
  // Japanese is a first-class target language (KO↔JA F&B leasing meetings),
  // selectable as one of the subtitle-language pills.
  assert.match(html, /name="translationLanguages" type="checkbox" value="ja"/);
  // languagePair is derived from the selected target languages (the model
  // auto-detects the spoken source), not from removed A/B selects.
  assert.match(js, /deriveLanguagePairFromTargets/);
  assert.match(html, /value="ollama" data-i18n="settings\.topicOllama"/);
  assertLocalized("settings.topicOllama", { en: /Gemma local via Ollama/ });
  assert.match(html, /name="recordProvider"/);
  // Translation tone (register) selector — natural vs business.
  assert.match(html, /name="tone"/);
  assert.match(html, /value="natural"/);
  assert.match(html, /value="business"/);
  assert.match(js, /form\.elements\.tone/);
  // Domain glossary drives terminology-correct translation polish.
  assert.match(html, /name="glossary"/);
  assert.match(js, /form\.elements\.glossary/);
  // The session domain is its own setting (separate from the glossary).
  assert.match(html, /name="translationDomain"/);
  assert.match(js, /form\.elements\.translationDomain/);
  // Engine/domain/glossary are advanced settings: they live INSIDE the
  // settings drawer, not on the main session panel.
  const drawerIndex = html.indexOf('<details class="settings-drawer">');
  assert.ok(drawerIndex > 0, "settings drawer must exist");
  assert.ok(html.indexOf('name="translationProvider"') > drawerIndex, "engine select belongs in the settings drawer");
  assert.ok(html.indexOf('name="translationDomain"') > drawerIndex, "domain belongs in the settings drawer");
  assert.ok(html.indexOf('name="glossary"') > drawerIndex, "glossary belongs in the settings drawer");
  // Un-cleared translation history exports to Excel (CSV download).
  assert.match(html, /id="export-history"/);
  assert.match(js, /export-history/);
  assert.match(js, /history\/export\.csv/);
  // The legacy client-signed QR pairing path is retired. Viewer admission now
  // uses the server-HMAC six-digit Live flow, so no pairing secret or key-sync
  // endpoint may remain in the desktop bundle.
  assert.doesNotMatch(html, /id="pair-generate"|id="pair-qr"|qrcode|supabase/i);
  assert.doesNotMatch(js, /PAIR_SECRET|signPairToken|\/api\/pair-keys|subtitle:mirror/);
  // The desktop creates Live Call directly. It must never expose a web-login
  // launcher, and every session always creates both admission methods.
  assert.doesNotMatch(html, /id="open-meeting-mode"|data-open-live-workspace|name="liveHostWorkspaceUrl"|>Open Live Call</);
  // The explanatory QR/code paragraph was deleted with the rest of the
  // descriptive prose; both admission methods are still always created.
  assert.doesNotMatch(html, /QR and a 6-digit access code are always created together|live-draft-access-note/);
  assert.doesNotMatch(html, /name="liveDraftAccess"|QR 무코드 \+ 코드 링크|코드 필수/);
  assert.match(workspaceJs, /coverImage: liveDraftCoverData/);
  assert.match(workspaceJs, /contentType: file\.type/);
  assert.match(workspaceJs, /base64: window\.btoa\(binary\)/);
  assert.match(workspaceJs, /t\("live\.hostLoginRequired"\)/);
  assertLocalized("live.hostLoginRequired", { en: /Open Settings and save the host authorization/ });
  assert.doesNotMatch(workspaceJs, /Sign in once in the Live workspace window|login page|login screen/i);
  assert.match(html, /id="pt-voice-method-title"/);
  assert.match(html, /data-i18n="output\.geminiVoice"/);
  assertLocalized("output.geminiVoice", { ko: /Gemini 음성/ });
  assert.match(html, /OpenAI Realtime/);
  // The Gemini-fixed explanation sentence was deleted; the fact remains as a
  // compact label + value note.
  assert.doesNotMatch(html, /자막 엔진은 Gemini 고정이며|pt-voice-method-help/);
  assert.doesNotMatch(html, /name="voiceEngine"/);
  // Built-in industry glossary presets: one click fills glossary + domain +
  // language pair for a prepared meeting type.
  assert.match(html, /name="glossaryPreset"/);
  assert.match(js, /glossary-presets/);
  assert.match(js, /applyGlossaryPreset/);
  // Subtitle settings travel as JSON; API keys remain on the device that stores them.
  assert.match(html, /id="export-settings"/);
  assert.match(html, /id="import-settings"/);
  assert.match(html, /id="import-settings-file"/);
  assert.match(js, /settings\/export/);
  assert.match(js, /importSettingsFromFile/);
  // Fine-grained vertical placement: distance from the anchored edge in px,
  // alongside the top/middle/bottom presets.
  assert.match(html, /name="verticalOffset"/);
  assert.match(js, /verticalOffset/);
  // Per-language subtitle placement on the main panel: each selected language
  // gets its own top/middle/bottom segmented control, plus the shared offset.
  // The old single global position-button row was removed.
  assert.doesNotMatch(html, /id="position-quick"/);
  assert.match(html, /id="subtitle-placement"/);
  assert.match(html, /class="placement-row" data-lang="en"/);
  assert.match(html, /class="placement-row" data-lang="ko"/);
  assert.match(html, /class="placement-row" data-lang="ja"/);
  assert.match(html, /name="pos-en"/);
  assert.match(html, /name="pos-ko"/);
  assert.match(html, /name="pos-ja"/);
  assert.match(js, /syncPlacementRows/);
  assert.match(js, /readSubtitlePositionsFromForm/);
  // Microphone list reliability: refresh when devices change, and unlock
  // device labels (empty before the first permission grant) via a temporary
  // stream so the dropdown shows real microphone names.
  assert.match(js, /addEventListener\("devicechange", hydrateMicrophones\)/);
  assert.match(js, /unlockMicrophoneLabels/);
  // Mid-session language/engine change rebuilds the translation channels in
  // place (re-send subtitle:start with the same sessionId) so stale channels
  // don't keep translating the old configuration.
  assert.match(js, /reconfigureRunningSession/);
  assert.match(js, /CHANNEL_REBUILD_CONTROLS/);
  assert.match(js, /type: "subtitle:start", sessionId: state\.sessionId/);
  // Captions stay on Gemini. OpenAI is exposed only as an audio provider.
  assert.match(html, /name="translationProvider"/);
  assert.match(html, /value="gemini"/);
  assert.doesNotMatch(html, /<select name="translationProvider">/);
  assert.match(html, /data-i18n="output\.engineNote"/);
  assertLocalized("output.engineNote", { ko: /자막 엔진/ });
  assertLocalized("output.engineNoteValue", { ko: /Gemini 고정/ });
  assert.match(js, /translationProvider: "gemini"/);
  // Gemini API key entry with its own save button and status badge.
  assert.match(html, /<details class="settings-drawer">\s*<summary data-i18n="settings\.drawerAdvanced">/);
  assert.doesNotMatch(html, /<details class="settings-drawer"[^>]*\sopen(?:\s|>)/);
  assert.match(html, /name="geminiKey"/);
  assert.match(html, /id="save-gemini-key"/);
  assert.match(html, /id="gemini-key-status"/);
  assert.match(js, /hasGeminiKey/);
  assert.match(js, /apiKeys: \{ gemini: geminiKey \}/);
  assert.match(js, /validateGeminiKey/);
  assert.match(js, /\/api\/subtitles\/gemini\/validate/);
  // Second Gemini project key: committed-line glossary finalizer first,
  // parallel Live translation second. Own field, save button, status badge,
  // and wiring.
  assert.match(html, /name="geminiSecondaryKey"/);
  assert.match(html, /id="save-gemini-secondary-key"/);
  assert.match(html, /id="gemini-secondary-key-status"/);
  assert.match(js, /hasGeminiSecondaryKey/);
  assert.match(js, /apiKeys: \{ geminiSecondary: geminiSecondaryKey \}/);
  assert.match(js, /saveGeminiSecondaryKey/);
  assert.match(js, /hasOpenAISecondaryKey/);
  assert.match(js, /apiKeysPatch\.openaiSecondary = openaiSecondaryKeyInput\.value\.trim\(\)/);
  assert.match(js, /saveOpenAISecondaryKey/);
  assert.match(js, /apiKeys: \{ openaiSecondary: openaiSecondaryKey \}/);
  assert.match(js, /AUDIO_PROCESSOR_BUFFER_SIZE = 1024/);
  // Key registration must be explicit for BOTH providers: a clear
  // registered/unregistered badge, not a vague placeholder.
  assert.match(js, /"key\.registered" : "key\.unregistered"/);
  assertLocalized("key.registered", { ko: /✓ 등록됨/ });
  assertLocalized("key.unregistered", { ko: /미등록/ });
  assert.match(html, /name="ollamaModel"/);
  assert.match(html, /name="ollamaBaseURL"/);
  assert.match(html, /name="maxSubtitleLines"/);
  assert.match(html, /id="topic-list"/);
  assert.match(html, /id="translation-log"/);
  assert.match(html, /class="translation-log"/);
  assert.match(html, /id="clear-history"/);
  assert.match(html, /id="realtime-api-status"/);
  assert.match(html, /id="audio-inspector"/);
  assert.match(html, /id="overlay-enabled"/);
  assert.match(html, /name="overlayEnabled"/);
  assert.match(html, /data-i18n="player\.overlayToggle"/);
  assertLocalized("player.overlayToggle", { en: /Subtitle overlay/ });
  assert.match(html, /id="refresh-audio-devices"/);
  assert.match(html, /id="system-audio-meter"/);
  assert.match(html, /id="mic-audio-meter"/);
  assert.match(html, /실시간 자막 확인 중/);
  // The drawer summary must not repeat the page title two lines above it.
  assert.match(html, /<summary data-i18n="settings\.drawerAdvanced">/);
  assertLocalized("settings.drawerAdvanced", { en: /Advanced/, ko: /고급/ });
  assert.match(html, /데스크톱 앱으로 여는 중/);
  assert.doesNotMatch(html, /Run always-on-top live subtitles/);
  assert.doesNotMatch(html, /Only translated subtitles are shown/);
  assert.match(html, /id="save-openai-key"/);
  assert.match(html, /id="openai-key-status"/);
  assert.match(html, /id="save-openai-secondary-key"/);
  assert.match(html, /id="openai-secondary-key-status"/);
  assert.match(html, /id="file-protocol-warning"/);
  assert.match(html, /href="subtitle\.css"/);
  assert.match(html, /src="subtitle-dashboard\.js"/);
  assert.match(html, /name="translationFontSize"/);
  assert.match(html, /name="sourceFontSize"/);
  assert.match(html, /name="translationFontSizeRange"/);
  assert.doesNotMatch(html, /id="caption-player-controller"/);
  assert.match(controllerHtml, /id="caption-player-controller"|class="caption-player-controller/);
  assert.doesNotMatch(html, /class="preview-visualizer"/);
  assert.match(controllerHtml, /id="controller-drag"/);
  assert.match(controllerHtml, /class="controller-body"/);
  assert.match(controllerHtml, /id="controller-restart"/);
  assert.match(controllerHtml, /id="controller-stop"/);
  assert.match(controllerHtml, /id="controller-font-down"/);
  assert.match(controllerHtml, /id="controller-font-up"/);
  // Desktop app controls: raise the main window, hide the floating console,
  // quit the app directly.
  assert.match(controllerHtml, /id="controller-main-window"[^>]*data-i18n="controller\.mainWindow"/);
  assertLocalized("controller.mainWindow", { en: /Main/ });
  assert.match(controllerHtml, /id="controller-hide"/);
  assert.match(controllerHtml, /id="controller-quit"/);
  assert.match(controllerJs, /showMainWindow/);
  assert.match(controllerJs, /setControllerVisible/);
  assert.match(controllerJs, /quitApp/);
  // Main sits in the App-controls cluster, before Hide and Quit so the
  // destructive control stays pinned at the far edge.
  const windowCluster = controllerHtml.slice(controllerHtml.indexOf('data-i18n-aria="controller.appControls"'));
  assert.ok(
    windowCluster.indexOf('id="controller-main-window"') < windowCluster.indexOf('id="controller-hide"')
      && windowCluster.indexOf('id="controller-hide"') < windowCluster.indexOf('id="controller-quit"'),
    "App controls order is Main -> Hide -> Quit",
  );
  // Outside Electron every desktop-only control is hidden, Main included.
  assert.match(controllerJs, /if \(mainWindowButton\) mainWindowButton\.hidden = true;/);
  assert.doesNotMatch(controllerHtml, /id="controller-language-preset"/);
  assert.doesNotMatch(controllerHtml, /<select/);
  // The floating controller no longer carries a language preset row — languages
  // are chosen ahead of time in the workspace. The only .controller-language-set
  // left is the audio voice-provider group.
  assert.doesNotMatch(controllerHtml, /data-controller-languages=/);
  assert.match(controllerHtml, /class="controller-language-set"[^>]*aria-label="통역 음성 엔진"/);
  // Vertical-gap stepper lives beside the opacity control.
  assert.match(controllerHtml, /id="controller-gap-down"/);
  assert.match(controllerHtml, /id="controller-gap-up"/);
  assert.match(controllerHtml, /id="controller-gap-value"/);
  assert.match(controllerHtml, /id="controller-opacity"/);
  assert.match(controllerHtml, /id="controller-opacity-value"/);
  assert.match(controllerHtml, /data-controller-position="top-center"/);
  assert.match(controllerHtml, /data-controller-position="middle-center"/);
  assert.match(controllerHtml, /data-controller-position="bottom-center"/);
  assert.match(html, /id="opacity-value"/);
  assert.match(html, /subtitle-dashboard\.js/);
  assert.match(controllerHtml, /subtitle-controller\.js/);
  assert.match(js, /type: "subtitle:start"/);
  assert.match(js, /type: "subtitle:audio"/);
  assert.match(js, /syncCaptionPlayerController/);
  assert.match(js, /initCaptionControllerDrag/);
  assert.match(js, /CONTROLLER_POSITION_STORAGE_KEY/);
  assert.match(js, /localStorage\.setItem\(CONTROLLER_POSITION_STORAGE_KEY/);
  assert.match(js, /localStorage\.getItem\(CONTROLLER_POSITION_STORAGE_KEY/);
  assert.match(js, /controllerDragHandle\.addEventListener\("pointerdown"/);
  assert.match(js, /adjustControllerFontSize/);
  assert.match(js, /setControllerSubtitlePosition/);
  assert.match(js, /persistControllerSubtitleSettings/);
  assert.match(js, /const isVisible = state\.running && state\.settings\.outputMode !== "audio"/);
  assert.match(js, /captionPlayerController\.hidden = !isVisible/);
  assert.match(js, /controllerRestartButton\?\.addEventListener\("click", restartSubtitles\)/);
  assert.match(js, /controllerStopButton\?\.addEventListener\("click", stopSubtitles\)/);
  assert.match(js, /controllerLanguagePreset\?\.addEventListener\("change", \(\) => applyControllerLanguagePreset\(\)\)/);
  assert.match(js, /controllerOpacity\?\.addEventListener\("input", \(\) => previewControllerOpacity\(\)\)/);
  assert.match(js, /controllerOpacity\?\.addEventListener\("change", \(\) => persistControllerOpacity\(\)\)/);
  assert.match(js, /window\.addEventListener\("pointermove", moveDrag\)/);
  assert.match(js, /window\.addEventListener\("pointerup", stopDrag\)/);
  assert.match(js, /applyControllerLanguagePreset/);
  assert.match(js, /previewControllerOpacity/);
  assert.match(js, /persistControllerOpacity/);
  assert.match(js, /syncControllerOpacity/);
  assert.match(js, /handleSubtitleControllerCommand/);
  assert.match(js, /setControllerWindowVisible\(state\.running && !isAudioOnly\)/);
  assert.match(js, /setControllerWindowVisible\(false\)/);
  assert.match(controllerJs, /type: "subtitle:control"/);
  assert.doesNotMatch(controllerJs, /data-controller-languages/);
  assert.match(controllerJs, /command: "restart"/);
  assert.match(controllerJs, /command: "stop"/);
  assert.match(controllerJs, /command: "offset"/);
  assert.match(controllerJs, /command: "opacity"/);
  assert.match(js, /getOverlayEnabled/);
  assert.match(js, /setOverlayEnabled/);
  assert.match(js, /overlayEnabled: true/);
  assert.match(js, /subtitle:history/);
  assert.match(js, /historyDays/);
  assert.match(js, /\/api\/subtitles\/history/);
  assert.match(js, /\/api\/subtitles\/history\/clear/);
  assert.match(js, /displayMode: "translation_only"/);
  assert.match(js, /maxSubtitleLines: 2/);
  assert.match(js, /ollamaModel: "gemma3n:e2b"/);
  assert.match(js, /OpenAI Realtime: ready/);
  assert.match(js, /t\("status\.realtimeConnected"\)/);
  assertLocalized("status.realtimeConnected", { ko: /실시간 자막 연결됨/ });
  assert.match(js, /t\("history\.recorderFallback"\)/);
  assertLocalized("history.recorderFallback", { ko: /기록 보조 기능 사용 중/ });
  // 2026-07-25 Spotify-shelf round: bare "기록 없음" empty boxes were replaced
  // with warm guidance copy.
  assert.match(js, /t\("history\.empty"\)/);
  assertLocalized("history.empty", { ko: /아직 확정된 자막이 없습니다/ });
  assert.doesNotMatch(js, /"기록 없음"/);
  assert.match(js, /t\("history\.unknownDate"\)/);
  assertLocalized("history.unknownDate", { ko: /날짜 미확인/ });
  assert.match(js, /LOCAL_SERVER_DASHBOARD_URL = "http:\/\/127\.0\.0\.1:3210\/subtitle\.html"/);
  assert.match(js, /location\.protocol === "file:"/);
  assert.match(js, /showFileProtocolWarning/);
  assert.match(js, /apiKeysPatch\.openai = openaiKeyInput\.value\.trim\(\)/);
  assert.match(js, /apiKeysPatch\.gemini = geminiKeyInput\.value\.trim\(\)/);
  assert.match(js, /saveOpenAIKey/);
  assert.match(js, /validateOpenAIKey/);
  assert.match(js, /\/api\/subtitles\/openai\/validate/);
  assert.match(js, /t\("key\.validatingOpenAI"\)/);
  assertLocalized("key.validatingOpenAI", { en: /Validating OpenAI Realtime/ });
  assert.match(js, /apiKeys: \{ openai: openaiKey \}/);
  assert.match(js, /renderKeyStatus/);
  assert.match(js, /t\("key\.openaiSaved"\)/);
  assertLocalized("key.openaiSaved", { ko: /OpenAI Realtime 연결을 확인했고 API key를 저장했습니다/ });
  assert.match(js, /source: capture\.source/);
  assert.match(js, /label: getAudioTrackLabel/);
  assert.match(js, /startAudioLevelMeter/);
  assert.match(js, /ensureAudioContextRunning/);
  assert.match(js, /await context\.resume\(\)/);
  assert.match(js, /watchAudioTrackState/);
  assert.match(js, /setAudioSourceStatus/);
  assert.match(js, /INPUT_SILENCE_WARNING_MS/);
  assert.match(js, /subtitle:input-status/);
  assert.match(js, /broadcastInputStatus/);
  assert.match(js, /message\.type === "subtitle:partial"[\s\S]{0,180}setPreviewText/);
  assert.match(js, /micDeviceId/);
  assert.match(js, /replaceChildren\(new Option\(t\("settings\.systemDefault"\), ""\)\)/);
  assertLocalized("settings.systemDefault", { en: /System default/ });
  assert.match(js, /getDisplayMedia/);
  assert.match(js, /getUserMedia/);
  // A persisted mic deviceId can go stale (unplugged/renumbered device). The
  // capture must fall back to the system default mic instead of failing the
  // whole mic input on OverconstrainedError.
  assert.match(js, /captureMicrophoneAudio[\s\S]*?deviceId: \{ exact: micSelect\.value \}[\s\S]*?catch[\s\S]*?getUserMedia/);
  // Mic failure guidance must point at the actual macOS panel (Microphone),
  // which is separate from Screen & System Audio Recording.
  assert.match(js, /t\("error\.micDenied"\)/);
  assert.match(MESSAGES.ko["error.micDenied"], /개인정보 보호 및 보안.*마이크/);
  assert.match(MESSAGES.en["error.micDenied"], /Privacy & Security > Microphone/);
  // The bundle name macOS shows in Privacy & Security must stay literal in
  // both languages, so the instruction matches what the user sees.
  assert.match(MESSAGES.en["error.micDenied"], /NOVA/);
  assert.match(MESSAGES.ko["error.micDenied"], /NOVA/);
  assert.match(js, /CAPTURE_TIMEOUT_MS = 8000/);
  assert.match(js, /Promise\.allSettled\(tasks\)/);
  assert.match(js, /withMediaCaptureTimeout/);
  assert.match(js, /stopMediaStream\(stream\)/);
  assert.match(js, /echoCancellation: true/);
  assert.match(js, /noiseSuppression: true/);
  assert.match(js, /autoGainControl: true/);
  // System/loopback audio must be requested as a plain `audio: true` signal.
  // Electron defers loopback routing to the main process, so passing a
  // device-style audio constraints object (echoCancellation,
  // suppressLocalAudioPlayback, ...) makes getDisplayMedia throw "Invalid
  // capture constraints". video:true is still required.
  assert.match(js, /getDisplayMedia\(\{[\s\S]*?video: true,[\s\S]*?audio: true,[\s\S]*?\}\)/);
  assert.doesNotMatch(js, /suppressLocalAudioPlayback/);
  assert.match(js, /createGain/);
  assert.match(js, /mute\.gain\.value = 0/);
  assert.match(js, /formatCaptureFailure/);
  assert.match(js, /t\("error\.systemAudioDenied"\)/);
  assert.match(js, /t\("error\.systemAudioFailed", \{ reason \}\)/);
  assert.match(MESSAGES.ko["error.systemAudioDenied"], /NOVA의 Screen & System Audio Recording 권한/);
  assert.match(MESSAGES.ko["error.systemAudioFailed"], /개발 실행 중이면 Electron 항목도 같은 권한이 필요합니다/);
  assert.match(MESSAGES.en["error.systemAudioFailed"], /Screen & System Audio Recording/);
  assert.match(js, /t\("notice\.partialInputs", \{ failures/);
  assertLocalized("notice.partialInputs", { ko: /가능한 입력만으로 시작했습니다/ });
  // Every live status line resolves through the dictionary in both languages.
  /** @type {[string, RegExp][]} */
  const statusKeys = [
    ["status.serviceConnecting", /서비스 연결 중/],
    ["status.captionsReady", /자막 준비됨/],
    ["status.hearing", /말씀을 듣고 있어요/],
    ["status.translating", /번역하고 있어요/],
    ["status.reconnecting", /다시 연결하는 중/],
    ["status.realtimeReconnecting", /실시간 자막 다시 연결 중/],
  ];
  for (const [key, korean] of statusKeys) {
    assert.match(js, new RegExp(`t\\("${key.replace(".", "\\.")}"\\)`));
    assertLocalized(key, { ko: korean });
  }
  assert.match(js, /void stopSubtitles\(\)/);
  assert.match(js, /t\("notice\.settingsSaved"\)/);
  assertLocalized("notice.settingsSaved", { ko: /설정을 저장했습니다/ });
  assert.match(js, /window\.location\.href = "\/api\/settings\/export"/);
  assert.doesNotMatch(js, /includeKeys/);
  // The "keys stay on this device" blurb was explanatory prose and was deleted;
  // the behaviour it described is asserted where it lives (settings-store keeps
  // API keys out of the export payload).
  assert.doesNotMatch(html, /자막 설정만 포함 — API 키는 이 기기에 유지됩니다/);
  assert.match(html, /id="export-settings"[\s\S]{0,200}id="import-settings"/);
});

test("desktop language picker exposes the approved multilingual set and caps simultaneous output at three", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  assert.match(js, /const MAX_SELECTED_LANGUAGES = 3/);
  assert.match(js, /fetch\("\/api\/subtitle-languages"\)/);
  assert.match(js, /subtitleLanguageRegistry = body\.languages/);
  // The static hint text was removed in the 2026-07-25 declutter; the 3-language
  // cap is enforced in JS and surfaced via the validation flash instead.
  assert.match(js, /t\("language\.minimum"\)/);
  assertLocalized("language.minimum", { ko: /최소 2개 언어를 선택해야 합니다/ });
  assert.match(js, /renderPlacementRows/);
  assert.doesNotMatch(html + js, /Realtime_Noel|AutoPreso|Auto Preso/);
});

test("desktop settings stay closed until the native summary is activated and non-caption chrome uses Pretendard", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");

  assert.match(html, /<details class="settings-drawer">\s*<summary data-i18n="settings\.drawerAdvanced">/);
  assert.doesNotMatch(html, /<details class="settings-drawer"[^>]*\sopen(?:\s|>)/);
  assert.match(css, /--ui-font-family:\s*"Pretendard"/);
  for (const match of css.matchAll(/\.subtitle-hero h1\s*\{([^}]*)\}/gs)) {
    assert.match(match[1], /font-family:\s*var\(--ui-font-family\)/);
    assert.doesNotMatch(match[1], /var\(--subtitle-font-family\)/);
  }
  assert.match(css, /\.pt-output-heading h2\s*\{[^}]*font-family:\s*var\(--ui-font-family\)/s);
  assert.doesNotMatch(css, /\.controller-group\s*\{[^}]*border-left:/s);
  assert.doesNotMatch(css, /radial-gradient/);
});

test("desktop dashboard explains the optional Live handoff without a web launcher", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  const workspaceJs = readFileSync(path.join(rootDir, "public", "subtitle-workspace.js"), "utf8");

  assert.match(html, /class="live-handoff"/);
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /data-i18n="live\.handoffKicker"/);
  assertLocalized("live.handoffKicker", { en: /OPTIONAL · LIVE CALL/ });
  // 2026-07-25 design review: the static Presentation/Meeting mode list was
  // decorative noise and was removed from the workspace.
  assert.doesNotMatch(html, /live-handoff-modes/);
  assert.doesNotMatch(html, /Optional translated audio/);
  assert.doesNotMatch(html, /Townhall/);
  assert.match(html, /data-i18n="live\.handoffFlow"/);
  assertLocalized("live.handoffFlow", { en: /Create session → share QR or code → start Live Call/ });
  assert.match(html, /id="live-workspace-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="live-draft-cover-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /QR and a 6-digit access code are always created together/);
  assert.doesNotMatch(html, /id="open-meeting-mode"|data-open-live-workspace|>Open Live Call</);
  assert.match(css, /\.live-handoff\s*\{/);
  assert.match(workspaceJs, /await bridge\.startLiveCall\(draft\)/);
  assert.match(workspaceJs, /result\?\.code === "HOST_LOGIN_REQUIRED"/);
  assert.match(workspaceJs, /coverImage: liveDraftCoverData/);
});

test("subtitle dashboard captures audio before opening realtime subtitle sessions", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const captureIndex = js.indexOf("captures = await captureSelectedAudio(state.settings)");
  const startIndex = js.indexOf('type: "subtitle:start"');

  assert.ok(captureIndex > 0, "dashboard should capture selected audio before starting subtitles");
  assert.ok(startIndex > captureIndex, "subtitle:start should be sent only after local capture succeeds");
  assert.match(js, /t\("status\.inputCheck"\)/);
  assertLocalized("status.inputCheck", { ko: /입력 확인 중/ });
  assert.match(js, /state\.streams = captures\.map/);
});

test("the interpreted-audio output mode survives settings persistence, and the retired mixed mode is gone", async () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  // Two output modes remain: captions, or interpreted audio. The mixed mode is
  // retired -- rejected by validateSubtitleSettings and migrated on read.
  assert.match(html, /<input name="outputMode" type="radio" value="captions"/);
  assert.match(html, /<input name="outputMode" type="radio" value="audio"/);
  assert.doesNotMatch(html, /value="captions_audio"/);

  const selectedOutputMode = new Function(
    "form",
    extractFunctionBody(js, "function selectedOutputMode()"),
  );
  const form = {
    querySelector: () => ({ value: "audio" }),
    elements: {
      inputMode: { value: "system_mic" },
      micDeviceId: { value: "" },
      translationProvider: { value: "gemini" },
      audioLanguage: { value: "en" },
      audioVolume: { value: "0.8" },
      fontFamily: { value: "Arial" },
      translationFontSize: { value: "38" },
      sourceFontSize: { value: "36" },
      position: { value: "bottom-center" },
      maxWidth: { value: "1500" },
      opacity: { value: "0.9" },
      maxSubtitleLines: { value: "3" },
      overlayEnabled: { checked: true },
      recordProvider: { value: "gemma" },
      ollamaBaseURL: { value: "http://127.0.0.1:11434" },
      ollamaModel: { value: "gemma3n:e2b" },
      tone: { value: "natural" },
      glossary: { value: "" },
      translationDomain: { value: "" },
      verticalOffset: { value: "24" },
    },
  };
  assert.equal(selectedOutputMode(form), "audio");

  const readSettingsFromForm = new Function(
    "form",
    "state",
    "DEFAULT_SUBTITLE",
    "readNumber",
    "readTranslationLanguagesFromForm",
    "readSubtitlePositionsFromForm",
    "deriveLanguagePairFromTargets",
    "selectedOutputMode",
    "selectedVoiceProvider",
    extractFunctionBody(js, "function readSettingsFromForm()"),
  );
  const settings = readSettingsFromForm(
    form,
    { settings: {} },
    {
      translationFontSize: 38,
      audioVolume: 0.8,
      fontFamily: "Arial",
      maxWidth: 1500,
      opacity: 0.9,
      maxSubtitleLines: 3,
      ollamaBaseURL: "http://127.0.0.1:11434",
      ollamaModel: "gemma3n:e2b",
      tone: "natural",
      verticalOffset: 24,
    },
    (value, fallback) => Number(value) || fallback,
    () => ["en", "ko"],
    () => ({ en: "bottom-center", ko: "bottom-center" }),
    () => ({ a: "en", b: "ko" }),
    () => selectedOutputMode(form),
    () => "gemini",
  );
  assert.equal(settings.outputMode, "audio");

  /** @type {{ url: string, options: { method: string, body: string } } | null} */
  let request = null;
  const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
  const saveSettings = new AsyncFunction(
    "patch",
    "fetch",
    "state",
    "updateOpenAIKeyPlaceholder",
    "updateOpenAISecondaryKeyPlaceholder",
    "updateOpenAIKeyStatus",
    "updateOpenAISecondaryKeyStatus",
    "updateGeminiKeyStatus",
    "updateGeminiSecondaryKeyStatus",
    extractFunctionBody(js, "async function saveSettings(patch)"),
  );
  await saveSettings(
    { subtitle: settings },
    async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true }) };
    },
    {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
  );
  assert.ok(request, "saving settings must issue an HTTP request");
  assert.equal(request.url, "/api/settings");
  assert.equal(request.options.method, "PUT");
  assert.equal(JSON.parse(request.options.body).subtitle.outputMode, "audio");

  const previewPanel = { hidden: false };
  const runtimeState = { running: true, settings: { outputMode: "audio" } };
  const syncRuntimeOutputVisibility = new Function(
    "state",
    "previewPanel",
    "syncCaptionPlayerController",
    "setControllerWindowVisible",
    extractFunctionBody(js, "function syncRuntimeOutputVisibility()"),
  );
  syncRuntimeOutputVisibility(runtimeState, previewPanel, () => {}, async () => {});
  assert.equal(previewPanel.hidden, true, "audio-only mode hides the subtitle preview");
  // Switching back to captions restores it. This pair used to be
  // audio -> captions_audio, which only made sense while one mode emitted both;
  // captions is now the only mode that produces something to preview.
  runtimeState.settings.outputMode = "captions";
  syncRuntimeOutputVisibility(runtimeState, previewPanel, () => {}, async () => {});
  assert.equal(previewPanel.hidden, false, "captions mode shows the subtitle preview while running");
});

test("subtitle dashboard cannot hang forever while checking audio inputs", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const selectedAudioStart = js.indexOf("async function captureSelectedAudio");
  const systemCaptureIndex = js.indexOf("captureAudioSource(\"system\"", selectedAudioStart);
  const micCaptureIndex = js.indexOf("captureAudioSource(\"mic\"", selectedAudioStart);
  const allSettledIndex = js.indexOf("Promise.allSettled(tasks)", selectedAudioStart);

  assert.ok(systemCaptureIndex > selectedAudioStart, "system audio should be scheduled as a capture task");
  assert.ok(micCaptureIndex > selectedAudioStart, "microphone audio should be scheduled as a capture task");
  assert.ok(allSettledIndex > systemCaptureIndex, "capture tasks should be awaited together");
  assert.ok(allSettledIndex > micCaptureIndex, "mic capture should not wait behind a hung system capture");
  const captureSelectedAudio = js.slice(selectedAudioStart, js.indexOf("async function captureAudioSource", selectedAudioStart));
  assert.equal(
    (captureSelectedAudio.match(/captureAudioSource\("mic"/g) ?? []).length,
    1,
    "system_mic must not schedule duplicate microphone capture streams",
  );
  assert.match(js, /reject\(new Error\(t\("error\.captureTimeout", \{ source: sourceName/);
  assertLocalized("error.captureTimeout", { ko: /\{source\} 캡처가 \{seconds\}초/ });
  assert.match(js, /if \(timedOut \|\| settled\) \{\s*stopMediaStream\(stream\);/);
});

test("subtitle dashboard actively starts Web Audio and reports blocked tracks", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const streamerStart = js.indexOf("async function createAudioStreamer");
  const contextIndex = js.indexOf('const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" })', streamerStart);
  const resumeIndex = js.indexOf("await ensureAudioContextRunning(context, sourceName)", streamerStart);
  const watchIndex = js.indexOf("watchAudioTrackState(media, sourceName)", streamerStart);
  const processIndex = js.indexOf("processor.onaudioprocess", streamerStart);

  assert.ok(contextIndex > streamerStart, "streamer should create an AudioContext");
  assert.ok(resumeIndex > contextIndex, "streamer should resume AudioContext before wiring nodes");
  assert.ok(watchIndex > resumeIndex, "streamer should attach track diagnostics");
  assert.ok(processIndex > watchIndex, "diagnostics should be ready before audio processing starts");
  assert.match(js, /context\.state !== "running"/);
  assert.match(js, /t\("audio\.blocked"\)/);
  assertLocalized("audio.blocked", { en: /Audio blocked/ });
  assert.match(js, /track\.addEventListener\?\.\("mute"/);
  assert.match(js, /track\.addEventListener\?\.\("ended"/);
});

test("subtitle dashboard requests native interactive 24 kHz capture with stateful resampling fallback", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const streamerStart = js.indexOf("async function createAudioStreamer");
  const streamerEnd = js.indexOf("async function ensureAudioContextRunning", streamerStart);
  const streamerSource = js.slice(streamerStart, streamerEnd);

  assert.match(streamerSource, /new AudioContext\(\{ sampleRate: SAMPLE_RATE, latencyHint: "interactive" \}\)/);
  assert.match(streamerSource, /context\.sampleRate === SAMPLE_RATE/);
  assert.match(streamerSource, /\? \{ samples: input, carry: new Float32Array\(0\) \}/);
  assert.match(streamerSource, /: resample\(input, context\.sampleRate, SAMPLE_RATE, carry\);/);
});

test("subtitle dashboard aggregates resampled input into exact 100 ms Live API frames", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const streamerStart = js.indexOf("async function createAudioStreamer");
  const streamerEnd = js.indexOf("async function ensureAudioContextRunning", streamerStart);
  const streamerSource = js.slice(streamerStart, streamerEnd);

  assert.match(js, /const SAMPLE_RATE = 24000;/);
  assert.match(js, /const LIVE_AUDIO_CHUNK_DURATION_MS = 100;/);
  assert.match(js, /const LIVE_AUDIO_CHUNK_SAMPLES = SAMPLE_RATE \* LIVE_AUDIO_CHUNK_DURATION_MS \/ 1_000;/);
  assert.equal(2_400 / 24_000 * 1_000, 100);
  assert.match(streamerSource, /let pendingSamples = new Float32Array\(0\);/);
  assert.match(streamerSource, /availableSamples\.set\(pendingSamples\);/);
  assert.match(streamerSource, /availableSamples\.set\(resampled\.samples, pendingSamples\.length\);/);
  assert.match(streamerSource, /while \(availableSamples\.length - offset >= LIVE_AUDIO_CHUNK_SAMPLES\)/);
  assert.match(streamerSource, /availableSamples\.subarray\(offset, offset \+ LIVE_AUDIO_CHUNK_SAMPLES\)/);
  assert.match(streamerSource, /offset \+= LIVE_AUDIO_CHUNK_SAMPLES;/);
  assert.match(streamerSource, /pendingSamples = availableSamples\.slice\(offset\);/);
  assert.match(streamerSource, /close: async \(\) => \{[\s\S]*?pendingSamples = new Float32Array\(0\);/);
});

test("translated playback isolates system loopback without suppressing microphone input", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const streamerStart = js.indexOf("async function startSubtitles");
  const streamerEnd = js.indexOf("async function stopSubtitles", streamerStart);
  const streamerSource = js.slice(streamerStart, streamerEnd);
  const meterStart = js.indexOf("function startAudioLevelMeter");
  const meterEnd = js.indexOf("function broadcastInputStatus", meterStart);
  const meterSource = js.slice(meterStart, meterEnd);

  assert.match(
    streamerSource,
    /shouldGateTranslatedAudioInput\([\s\S]*?state\.settings\.outputMode,[\s\S]*?subtitleAudioPlayer\.isInputSuppressionActive\(\),[\s\S]*?capture\.source,[\s\S]*?\)\) return;/,
  );
  assert.match(
    meterSource,
    /shouldGateTranslatedAudioInput\([\s\S]*?state\.settings\.outputMode,[\s\S]*?subtitleAudioPlayer\.isInputSuppressionActive\(\),[\s\S]*?sourceName,[\s\S]*?\);/,
  );
  assert.match(meterSource, /isFeedbackSuppressed \? t\("audio\.outputIsolated"\) : hasSignal \? t\("audio\.signal"\) : t\("audio\.noSignal"\)/);
  assertLocalized("audio.outputIsolated", { en: /Output isolated/ });
  assert.doesNotMatch(
    streamerSource,
    /shouldGateTranslatedAudioInput\(state\.settings\.outputMode, subtitleAudioPlayer\.isInputSuppressionActive\(\)\)\) return;/,
  );
});

test("subtitle dashboard renders grouped translation history without flat-only records", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");

  assert.match(html, /id="translation-log" class="translation-log"/);
  assert.match(js, /normalizeHistoryDays\(snapshot\)/);
  assert.match(js, /Array\.isArray\(snapshot\.historyDays\)/);
  assert.match(js, /groupRecordsByDay\(Array\.isArray\(snapshot\.records\)/);
  assert.match(js, /document\.createElement\("details"\)/);
  assert.match(js, /document\.createElement\("summary"\)/);
  assert.match(js, /translation-day-count/);
  assert.match(js, /recordText\.textContent = record\.translatedText \|\| ""/);
  assert.doesNotMatch(js, /translationLog\.replaceChildren\(\.\.\.state\.history\.records\.slice\(0, 12\)\.map/);
  assert.match(js, /dedupeFinalHistoryRecords/);
  assert.match(js, /record\.isFinal === false/);
  assert.match(js, /message\.type === "subtitle:partial"[\s\S]{0,180}setPreviewText\(message\.translatedText, message\.sourceText, true\)/);
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
  assert.match(css, /\.translation-day/);
  assert.match(css, /\.translation-day summary/);
  assert.match(css, /\.translation-record-list/);
});

test("subtitle dashboard exposes source labels and level meter styles", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");

  assert.match(html, /class="subtitle-app-shell"/);
  assert.match(html, /class="subtitle-app-rail"/);
  assert.match(html, /<img src="icons\/radio\.svg" alt="" aria-hidden="true" \/><span data-i18n="nav\.captions">/);
  assertLocalized("nav.captions", { en: /Captions/ });
  assert.match(html, /<img src="icons\/file-text\.svg" alt="" aria-hidden="true" \/><span data-i18n="nav\.records">/);
  assertLocalized("nav.records", { en: /Records/ });
  assert.match(html, /<img src="icons\/users\.svg" alt="" aria-hidden="true" \/><span data-i18n="nav\.livecall">/);
  assertLocalized("nav.livecall", { en: /Live Call/ });
  assert.match(html, /<img src="icons\/settings\.svg" alt="" aria-hidden="true" \/><span data-i18n="nav\.settings">/);
  assertLocalized("nav.settings", { en: /Settings/ });
  assert.match(html, /id="caption-workspace" class="subtitle-dashboard"/);
  assert.doesNotMatch(html, /data-open-live-workspace|id="open-meeting-mode"|>Open Live Call</);
  assert.doesNotMatch(html, /QR and a 6-digit access code are always created together/);
  assert.match(html, /id="start-subtitles"/);
  assert.match(html, /id="stop-subtitles"/);
  assert.match(html, /id="subtitle-preview"/);
  assert.match(html, /id="translation-log-panel"/);
  assert.match(js, /const primaryNavigationLinks = \[\.\.\.document\.querySelectorAll\("\.subtitle-app-rail nav a\[href\^='#'\]"\)\]/);
  assert.match(js, /if \(target === settingsDrawer\) settingsDrawer\.open = true/);
  assert.match(js, /navigationLink\.classList\.toggle\("is-current", isCurrent\)/);
  assert.match(js, /target\.scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
  assert.match(js, /window\.addEventListener\("hashchange"/);
  assert.match(css, /\.audio-inspector/);
  assert.match(css, /\.audio-meter-row/);
  assert.match(css, /\.audio-meter-fill/);
  assert.match(css, /\.overlay-toggle/);
  assert.match(css, /\.caption-player-controller/);
  assert.match(css, /Electron host dashboard/);
  assert.match(css, /\.subtitle-app-shell[\s\S]*?grid-template-columns: 220px minmax\(0, 1fr\)/);
  assert.match(css, /\.subtitle-app-rail nav img[\s\S]*?width: 20px[\s\S]*?filter: invert\(1\)[\s\S]*?opacity: 0\.52/);
  // The two-column track this used to pin was dead: .workspace-shell on the same
  // element sets display:block and wins. Both are gone.
  assert.doesNotMatch(css, /minmax\(400px, 430px\)/u);
  assert.doesNotMatch(css, /#ff6a2a|#6ee7b7|#151311|#1d1915|#26211c/i);
  for (const iconName of ["radio", "file-text", "users", "settings"]) {
    const icon = readFileSync(path.join(rootDir, "public", "icons", `${iconName}.svg`), "utf8");
    assert.match(icon, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(icon, /viewBox="0 0 24 24"/);
  }
  const iconLicense = readFileSync(path.join(rootDir, "public", "icons", "README.md"), "utf8");
  assert.match(iconLicense, /official Feather repository/);
  assert.match(iconLicense, /MIT License/);
  assert.match(css, /\.caption-player-controller[\s\S]*?position: fixed/);
  assert.match(css, /\.caption-player-controller[\s\S]*?border-radius: 8px/);
  assert.match(css, /\.caption-player-controller[\s\S]*?display: grid/);
  assert.match(css, /\.controller-drag/);
  assert.match(css, /\.controller-drag[\s\S]*?touch-action: none/);
  assert.match(css, /\.controller-body/);
  assert.match(css, /\.controller-language-set/);
  assert.match(css, /\.controller-lang-option/);
  assert.match(css, /\.controller-opacity/);
  assert.match(css, /\.subtitle-dashboard-body[\s\S]*?background: #f5f5f7/);
  assert.match(css, /\.controller-chip\.active/);
  assert.match(css, /background: var\(--cw-blue\)/);
});

test("subtitle overlay defaults to the observed two-line rolling-caption layout", () => {
  const html = readFileSync(path.join(rootDir, "public", "subtitle-overlay.html"), "utf8");
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  const js = readFileSync(path.join(rootDir, "public", "subtitle-overlay.js"), "utf8");

  assert.match(html, /<title>NOVA Subtitle Overlay<\/title>/);
  // Per-language lanes: three position zones; each language renders its own box.
  assert.match(html, /data-zone="top-center"/);
  assert.match(html, /data-zone="middle-center"/);
  assert.match(html, /data-zone="bottom-center"/);
  assert.match(js, /fontFamily: "Arial, Helvetica, sans-serif"/);
  assert.match(js, /displayMode: "translation_only"/);
  assert.match(js, /showSourceText: false/);
  assert.match(js, /maxSubtitleLines: 2/);
  assert.match(js, /lastSubtitleAt/);
  // Double-click the overlay = restart the subtitle session (stall recovery);
  // hover makes the Electron click-through window interactive over the box.
  assert.match(js, /dblclick/);
  assert.match(js, /"subtitle:control"/);
  assert.match(js, /setOverlayInteractive/);
  // Pipeline status badge: reconnecting / recovering / degraded are visible.
  assert.match(js, /subtitle-status-indicator/);
  // Overlay is for subtitles only. Operational status belongs in the
  // dashboard, so these strings must never appear over the presentation.
  assert.doesNotMatch(js, /API 연결 중/);
  assert.doesNotMatch(js, /자막 대기 중/);
  assert.doesNotMatch(js, /준비됨/);
  assert.doesNotMatch(js, /음성 감지/);
  assert.doesNotMatch(js, /번역 중/);
  assert.doesNotMatch(js, /연결 복구 중/);
  assert.doesNotMatch(js, /renderStatus/);
  // A subtitle remains readable through a silence gap (generous idle linger) and
  // is replaced when new speech arrives.
  assert.match(js, /SUBTITLE_FINAL_LINGER_MS = 20000/);
  assert.match(js, /SUBTITLE_PREVIOUS_SENTENCE_LINGER_MS = 3000/);
  assert.match(js, /SUBTITLE_LIVE_STALE_MS = 15000/);
  assert.match(js, /INPUT_ACTIVE_GRACE_MS = 1600/);
  assert.match(js, /LIVE_SUBTITLE_RECHECK_MS = 500/);
  assert.match(js, /subtitleLingerMs/);
  assert.match(js, /lane\.timer/);
  assert.match(js, /message\.type === "subtitle:partial" && !isAudioOnlyOutput\(\)\) renderPredictedSubtitle\(message\)/);
  assert.match(js, /message\.type === "subtitle:committed" && !isAudioOnlyOutput\(\)\) renderCommittedSubtitle\(message\)/);
  assert.doesNotMatch(js, /subtitle:partial"\) renderSubtitle/);
  assert.match(js, /PREDICTED_SUBTITLE_MIN_CHARS = 4/);
  assert.match(js, /GEMINI_PREDICTED_SUBTITLE_MIN_CHARS = 10/);
  assert.match(js, /shouldRenderPredictedSubtitle/);
  assert.match(js, /message\.translationProvider === "gemini"/);
  assert.match(js, /renderCommittedSubtitle/);
  // The queue can retain one extra line internally while the product default
  // mirrors the 5fps reference: two visible lines with only the live tail changing.
  assert.match(js, /MAX_SUBTITLE_QUEUE_LINES = 3/);
  // One independent lane per target language, positioned per language.
  assert.match(js, /const lanes = new Map/);
  assert.match(js, /ensureLane/);
  assert.match(js, /positionForLanguage/);
  assert.match(js, /subtitlePositions/);
  // Each lane lingers after its last line, then clears.
  assert.match(js, /armLinger/);
  assert.match(js, /armLinger\(lane, "final"\)/);
  assert.match(js, /armLinger\(lane, "live"\)/);
  assert.match(js, /armPreviousSentenceTrim/);
  assert.match(js, /lane\.trimTimer/);
  // Movie-style wrapping: each sentence flows and wraps at the box's real
  // max-width — NO fixed-character pre-wrap (that caused premature mid-sentence
  // breaks). The live partial stays provisional; committed text is solid.
  assert.match(js, /splitSubtitleDisplayParts/);
  assert.doesNotMatch(js, /splitSubtitleCueLines/);
  assert.doesNotMatch(js, /SUBTITLE_CHARS_PER_LINE/);
  // Append-only word rendering (broadcast-caption stability): already-shown words
  // keep their DOM node; only new trailing words are appended, so text never
  // reflows/jitters as each token streams in.
  assert.match(js, /reconcileWords/);
  assert.match(js, /tokenizeWords/);
  assert.match(js, /flow\.appendChild\(span\)/);
  assert.match(js, /subtitle-word/);
  assert.match(js, /subtitle-flow/);
  // YouTube-style smooth roll-up: the flow is translated up by its overflow.
  assert.match(js, /updateRollUp/);
  assert.match(js, /scrollHeight/);
  assert.match(js, /translateY/);
  // The box fills to max-width then wraps, capping visible height to the line
  // budget and bottom-anchoring so the newest line is always kept on screen.
  assert.match(css, /justify-content: flex-end/);
  assert.match(css, /max-height: calc\(var\(--subtitle-line-clamp/);
  assert.match(css, /white-space: normal/);
  // Subtitle height is user-adjustable: the visible line budget follows the
  // maxSubtitleLines setting (up to a cap), driving the CSS height clamp.
  assert.match(js, /function maxSubtitleLines/);
  assert.match(js, /MAX_SUBTITLE_LINES_CAP = 8/);
  assert.match(js, /const base = maxSubtitleLines\(\)/);
  // Anti-overlap: when 2+ languages share a zone (e.g. EN+KO both at the
  // bottom) each lane auto-shrinks its visible line count and the zone reflows,
  // so the stacked boxes stay compact and never overlap or run off-screen.
  assert.match(js, /visibleLineLimitFor/);
  assert.match(js, /reflowZone/);
  assert.match(js, /setProperty\("--subtitle-line-clamp"/);
  // Source ("원문") display was removed entirely — subtitles are always
  // translation-only, so the source can never render beside the translation.
  assert.doesNotMatch(js, /laneOwnsSourceLine/);
  assert.match(js, /lane\.source\.hidden = true/);
  // When the spoken source language switches, the lane translating INTO that
  // language is stale and is cleared so it doesn't sit beside the new
  // translation (the "영어 원문과 한글 병기" overlap).
  assert.match(js, /clearStaleReverseLane/);
  // Duplicate-line guard: a sentence re-emitted with only a trailing
  // punctuation/space difference must not render twice.
  assert.match(js, /normalizeForDedup/);
  assert.match(js, /stripSubtitlePrefix/);
  assert.doesNotMatch(js, /LANGUAGE_LABELS/);
  assert.doesNotMatch(js, /targetLanguage\.toUpperCase\(\)/);
  assert.match(js, /lane\.predicted/);
  assert.match(js, /splitSubtitleSentences/);
  // Fine-grained vertical placement flows to the overlay as a CSS variable.
  assert.match(js, /--subtitle-vertical-offset/);
  assert.match(css, /var\(--subtitle-vertical-offset/);
  assert.match(js, /subtitle:input-status/);
  assert.match(js, /handleInputStatus\(message\)/);
  assert.match(js, /message\.status === "signal"/);
  assert.match(js, /message\.status === "hearing"/);
  assert.match(js, /isInputActive\(\)/);
  assert.doesNotMatch(js, /입력 신호 없음/);
  assert.match(js, /message\.status === "idle"/);
  assert.match(js, /message\.type === "subtitle:clear"\) clearSubtitleLane\(message\.targetLanguage\)/);
  assert.match(js, /clearSubtitleLane/);
  assert.match(js, /clearSubtitle/);
  assert.match(js, /setTimeout\(connect, 1500\)/);
  assert.match(css, /--translation-font-size: 38px/);
  assert.match(css, /--source-font-size: 36px/);
  assert.match(css, /--subtitle-max-width: 1500px/);
  assert.match(css, /--subtitle-line-clamp: 3/);
  assert.match(css, /max-width: min\(var\(--subtitle-max-width\), 88vw\)/);
  assert.match(css, /text-wrap: pretty/);
  assert.match(css, /word-break: keep-all/);
  assert.match(css, /display: flex/);
  assert.match(css, /flex-direction: column/);
  assert.match(css, /\.subtitle-word\.committed/);
  assert.match(css, /\.subtitle-word\.partial/);
  // Newly appended words fade in (opacity only — never a layout shift, which
  // would fight the roll-up overflow math) and the animation is disabled under
  // reduced-motion.
  assert.match(css, /@keyframes subtitle-word-in/);
  assert.match(css, /\.subtitle-word \{[\s\S]*?animation: subtitle-word-in/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*?\.subtitle-word \{[^}]*animation: none/);
  assert.match(css, /\.subtitle-flow/);
  assert.match(css, /transition: transform 0\.32s/);
  assert.match(css, /transition: background 160ms ease/);
  assert.match(css, /rgba\(206, 211, 219, 0\.95\)/);
  assert.match(css, /translation-only \.source-line/);
  assert.match(css, /--cw-indigo: #0c0a09/);
  assert.match(css, /--cw-grey: #4e4e4e/);
  assert.match(css, /--cw-blue: #0a84ff/);
  assert.match(css, /rgb\(from var\(--cw-indigo\) r g b \/ var\(--subtitle-opacity\)\)/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /position-bottom-center/);
  assert.doesNotMatch(css, /opacity: var\(--subtitle-opacity\)/);
});

test("subtitle styles use the editorial palette and carry no legacy brand colors", () => {
  const css = readFileSync(path.join(rootDir, "public", "subtitle.css"), "utf8");
  // De-branding guarantee: the retired Cushman brand hexes must never reappear.
  for (const banned of ["#1D1740", "#E4002B", "#0093AD", "#8E1000"]) {
    assert.ok(!css.includes(banned), `legacy brand color ${banned} must be removed`);
  }
  // Editorial tokens present: ink, off-white canvas, iOS record red.
  assert.match(css, /--cw-indigo: #0c0a09/);
  assert.match(css, /--cw-grey-12: #f5f5f5/);
  assert.match(css, /--cw-red: #FF453A/);
  // Liquid-glass panels intentionally use translucent rgba fills.
  assert.match(css, /backdrop-filter: blur/);
});

test("electron main creates always-on-top click-through overlay", () => {
  const source = readFileSync(path.join(rootDir, "electron", "main.js"), "utf8");
  const packageJson = readFileSync(path.join(rootDir, "package.json"), "utf8");
  const launcher = readFileSync(path.join(rootDir, "scripts", "start-desktop.js"), "utf8");
  const preload = readFileSync(path.join(rootDir, "electron", "preload.js"), "utf8");

  assert.match(source, /transparent: true/);
  assert.match(source, /frame: false/);
  assert.match(source, /alwaysOnTop: true/);
  assert.match(source, /setIgnoreMouseEvents\(true/);
  assert.match(source, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true, skipTransformProcessType: true \}\)/);
  // Content protection excludes the overlay from screen capture, which on macOS
  // makes the overlay unreliable above fullscreen/presentation surfaces. The
  // product goal is "always visible until the user turns it off", not capture
  // exclusion, so it must NOT be set.
  assert.doesNotMatch(source, /setContentProtection/);
  // The overlay must float above fullscreen apps and other always-on-top
  // windows: highest standard level plus a relative bump.
  assert.match(source, /OVERLAY_TOP_LEVEL = "screen-saver"/);
  assert.match(source, /setAlwaysOnTop\(true, OVERLAY_TOP_LEVEL, 1\)/);
  // Re-assert the level on the macOS events that drop a window's level
  // (another app going fullscreen, app activation) instead of relying solely
  // on the 1s polling watchdog.
  assert.match(source, /browser-window-focus/);
  assert.match(source, /did-become-active/);
  // Multi-display: one overlay window per connected display, reconciled when
  // displays are added/removed, so extended screens also show subtitles.
  assert.match(source, /screen\.getAllDisplays\(\)/);
  assert.match(source, /overlayWindows/);
  assert.match(source, /display-added/);
  assert.match(source, /display-removed/);
  assert.match(source, /showInactive/);
  assert.match(source, /moveTop\(\)/);
  // The modern Electron 42 loopback audio path (callback audio: "loopback")
  // depends on the MacCatap CoreAudio-tap feature, so it must NOT be disabled.
  assert.doesNotMatch(source, /disable-features.*MacCatapLoopbackAudioForScreenShare/);
  // System audio capture must check the macOS screen-recording permission so
  // failures are diagnosable instead of surfacing as an empty audio stream.
  assert.match(source, /getMediaAccessStatus/);
  // Microphone is a SEPARATE macOS TCC panel from Screen & System Audio
  // Recording. Electron never shows the mic prompt unless the app explicitly
  // asks; without it getUserMedia can return a SILENT stream with no error.
  assert.match(source, /getMediaAccessStatus\("microphone"\)/);
  assert.match(source, /askForMediaAccess\("microphone"\)/);
  // electron-builder signs with hardened runtime; without the audio-input
  // entitlement macOS blocks the microphone at the process level — no prompt,
  // no TCC entry, getUserMedia silently returns nothing. The entitlements file
  // must be wired into the mac build and grant audio input alongside the
  // defaults Electron needs (JIT etc.).
  const entitlements = readFileSync(path.join(rootDir, "build", "entitlements.mac.plist"), "utf8");
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(packageJson, /"entitlements": "build\/entitlements\.mac\.plist"/);
  assert.match(packageJson, /"entitlementsInherit": "build\/entitlements\.mac\.plist"/);
  assert.match(source, /maintainOverlayWindow/);
  assert.match(source, /isQuitting/);
  assert.match(source, /subtitle-overlay:get-enabled/);
  assert.match(source, /subtitle-overlay:set-enabled/);
  assert.match(source, /destroyOverlayWindow/);
  assert.match(source, /app\.quit\(\)/);
  assert.match(source, /requestSingleInstanceLock/);
  assert.match(source, /second-instance/);
  assert.match(source, /PREFERRED_PORT = 3210/);
  assert.match(source, /title: "NOVA Subtitles"/);
  assert.match(source, /title: "NOVA Subtitle Overlay"/);
  assert.match(source, /title: "NOVA Subtitle Controller"/);
  assert.match(source, /createControllerWindow/);
  assert.match(source, /subtitle-controller\.html/);
  assert.match(source, /subtitle-controller:set-visible/);
  assert.match(source, /controllerWindow\.showInactive\(\)/);
  assert.match(preload, /setControllerVisible/);
  assert.match(source, /EADDRINUSE/);
  assert.match(source, /desktopCapturer\.getSources/);
  assert.match(source, /audio: "loopback"/);
  assert.match(source, /useSystemPicker: false/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /setPermissionCheckHandler/);
  assert.match(source, /ALLOWED_RENDERER_PERMISSIONS/);
  assert.match(source, /display-capture/);
  assert.match(source, /DESKTOP_SOURCE_TIMEOUT_MS = 7_000/);
  assert.match(source, /getDesktopSourcesWithTimeout/);
  assert.match(source, /callback\(\{\}\)/);
  assert.match(source, /overlayEnabled = settings\.subtitle\?\.overlayEnabled !== false/);
  assert.match(source, /settingsStore\.save\(\{ subtitle: \{ overlayEnabled \} \}\)/);
  assert.match(packageJson, /"desktop": "node \.\/scripts\/start-desktop\.js"/);
  // Windows portable must never trigger a UAC/admin prompt.
  assert.match(packageJson, /"requestedExecutionLevel": "asInvoker"/);
  // window.open from the dashboard (e.g. meeting mode) must open the system
  // browser, not an Electron child window.
  assert.match(source, /setWindowOpenHandler/);
  assert.match(source, /shell\.openExternal/);
  assert.match(launcher, /stopExistingDesktop/);
  assert.match(launcher, /pgrep/);
  assert.match(launcher, /spawn\(path\.join\(rootDir, "node_modules", "\.bin", "electron"\)/);
});

test("live-call captions keep the screen policy: translation-only display, identity badge, source recorded", () => {
  const dashboard = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  // Screen captions render only the translated direction; the source lane
  // finals travel record-only so the session record keeps the 원문.
  assert.match(dashboard, /caption\.origin === "source"/);
  assert.match(dashboard, /recordOnly: true/);
  assert.match(dashboard, /speakerDepartment/);
  assert.doesNotMatch(dashboard, /\$\{caption\.speaker[^}]*\}:/, "no Name: text prefix in relayed captions");

  const overlay = readFileSync(path.join(rootDir, "public", "subtitle-overlay.js"), "utf8");
  assert.match(overlay, /live-call-speaker-badge/);
  assert.match(overlay, /showLiveCallSpeakerBadge\(message, lane\)/);

  const server = readFileSync(path.join(rootDir, "src", "server.js"), "utf8");
  assert.match(server, /liveCallSpeaker/);
  assert.match(server, /message\.recordOnly === true/);
  assert.match(server, /sourceText: translatedText/);
});

// ── Settings import must reject non-object sections ────────────────────────
// `typeof [] === "object"` and `[]` is truthy, so importing `{"subtitle": []}`
// used to sail through to the settings store, where the array shape survived
// the deep merge and JSON.stringify then dropped every string key — the file
// kept `"subtitle": []` and every later save silently no-opped while the UI
// reported success. Unrecoverable without hand-deleting settings.json.

test("settings import rejects array and primitive subtitle/apiKeys sections", () => {
  const js = readFileSync(path.join(rootDir, "public", "subtitle-dashboard.js"), "utf8");
  const isPlainSettingsSection = new Function("value", extractFunctionBody(js, "function isPlainSettingsSection"));
  assert.equal(isPlainSettingsSection({}), true);
  assert.equal(isPlainSettingsSection({ glossary: "a" }), true);
  for (const bad of [[], ["en"], null, undefined, "boom", 5, true, 0, ""]) {
    assert.equal(isPlainSettingsSection(bad), false, JSON.stringify(bad) ?? "undefined");
  }

  const importer = extractFunctionBody(js, "async function importSettingsFromFile");
  // The old truthy+typeof pair is gone from the import path.
  assert.doesNotMatch(importer, /typeof parsed\.subtitle === "object"/u);
  assert.doesNotMatch(importer, /typeof parsed\.apiKeys === "object"/u);
  // Both sections are shape-checked, and a bad shape aborts instead of saving.
  assert.match(importer, /!isPlainSettingsSection\(parsed\.subtitle\)/u);
  assert.match(importer, /!isPlainSettingsSection\(parsed\.apiKeys\)/u);
  assert.match(importer, /if \(isPlainSettingsSection\(parsed\.subtitle\)\) patch\.subtitle = parsed\.subtitle;/u);
  assert.match(importer, /if \(isPlainSettingsSection\(parsed\.apiKeys\)\) patch\.apiKeys = parsed\.apiKeys;/u);
  const throwIndex = importer.indexOf('t("error.importSectionShape")');
  assertLocalized("error.importSectionShape", { ko: /항목은 객체여야 합니다/ });
  const saveIndex = importer.indexOf("await saveSettings(patch)");
  assert.ok(throwIndex >= 0 && throwIndex < saveIndex, "the shape check must run before the save");
});
