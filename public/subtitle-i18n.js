// App-wide UI language. One flat key/value dictionary per language, a pure
// `t()` lookup, and a single declarative DOM pass driven by data-i18n*
// attributes. Nothing here touches the DOM or storage at load time, so the
// module imports cleanly into the node test runner as well as the browser.
//
// Conventions:
//   data-i18n="key"             -> element.textContent
//   data-i18n-aria="key"        -> aria-label
//   data-i18n-title="key"       -> title
//   data-i18n-placeholder="key" -> placeholder
//
// Brand strings (app.name, app.credit) are intentionally identical in every
// language: they are names, not copy.

export const UI_LANGUAGE_STORAGE_KEY = "realtime-noel-ui-language";
export const SUPPORTED_UI_LANGUAGES = ["en", "ko"];
export const DEFAULT_UI_LANGUAGE = "ko";

export const MENU_KEYS = [
  "menu.surfaces",
  "menu.showMainWindow",
  "menu.showCaptionController",
  "menu.hideCaptionController",
  "menu.showSubtitleOverlays",
];

const EN = {
  // ── Brand ───────────────────────────────────────────────────────────────
  "app.name": "NOVA",
  "app.credit": "Realtime by Noel",
  "app.railLabel": "NOVA workspace",
  "app.title": "NOVA",
  "app.controllerTitle": "NOVA Caption Controller",

  // ── Navigation / pages ──────────────────────────────────────────────────
  "nav.captions": "Captions",
  "nav.livecall": "Live Call",
  "nav.records": "Records",
  "nav.settings": "Settings",
  "page.captions.title": "Captions",
  "page.livecall.title": "Live Call",
  "page.records.title": "Records",
  "page.settings.title": "Settings",
  "page.captions.label": "Captions",
  "page.livecall.label": "Live Call",
  "page.records.label": "Records",
  "page.settings.label": "Settings",

  // ── Language + theme switches ───────────────────────────────────────────
  "lang.group": "App language",
  "lang.en": "English",
  "lang.ko": "Korean",
  "theme.group": "Theme",
  "theme.dark": "Dark theme",
  "theme.light": "Light theme",

  // ── Connection / engine status ──────────────────────────────────────────
  "status.connecting": "Connecting",
  "status.captionsReady": "Captions ready",
  "status.disconnected": "Disconnected",
  "status.checkConnection": "Check your connection",
  "status.serviceConnecting": "Connecting to the service",
  "status.hearing": "Listening",
  "status.translating": "Translating",
  "status.reconnecting": "Reconnecting",
  "status.receivingCaptions": "Captions incoming",
  "status.checkingInputs": "Checking input devices",
  "status.inputCheck": "Checking input",
  "status.waitingForCaptions": "Waiting for captions",
  "status.problem": "Something went wrong",
  "status.openInDesktopApp": "Open in the desktop app",
  "status.reopeningLocalServer": "Reopening on the local server",
  "status.openingDesktopApp": "Opening the desktop app",
  "status.realtimeChecking": "Checking live captions",
  "status.realtimeConnected": "Live captions connected",
  "status.realtimeReconnecting": "Live captions reconnecting",
  "status.modelConnection": "Model connection status",
  "status.topicModelStandby": "Gemma: standby",

  // ── Captions page ───────────────────────────────────────────────────────
  "captions.session": "Session",
  "captions.sessionDefault": "System + microphone",
  "cfg.languages": "Subtitle Languages",
  "cfg.languagesLabel": "Subtitle languages",
  "cfg.outputMode": "Output Mode",
  "cfg.glossary": "Glossary",
  "cfg.appearance": "Appearance",
  "cfg.position": "Subtitle Position",
  "cfg.audioInput": "Audio Input",
  "cfg.hostAuthorization": "Live Call Host Authorization",
  "cfg.engineGlossary": "Engine & Glossary",
  "language.searchPlaceholder": "Search a language to add (e.g. Japanese, ja)",
  "language.searchLabel": "Search translation languages",
  "language.noMatch": "No matching language",
  "language.maxSelected": "Up to {max} languages — remove one first",
  "language.minimum": "Select at least 2 languages",
  "language.remove": "Remove {language}",
  "language.positionLabel": "{language} subtitle position",
  "position.top": "Top",
  "position.middle": "Middle",
  "position.bottom": "Bottom",
  "position.groupLabel": "Subtitle position per language",
  "output.kicker": "LOCAL PLAYBACK",
  "output.ptTitle": "PT output",
  "output.systemDefault": "System default output",
  "output.modeLabel": "PT output mode",
  "output.captions": "Captions",
  "output.captionsAudio": "Captions + interpretation audio",
  "output.audio": "Interpretation audio only",
  "output.voiceEngine": "Interpretation voice engine",
  "output.geminiVoice": "Gemini voice",
  "output.openaiRealtime": "OpenAI Realtime",
  "output.openaiUnsupported": "The selected language has no OpenAI Realtime voice, so Gemini voice is used.",
  "output.audioLanguage": "Interpretation voice language",
  "output.audioLanguageLabel": "Interpretation voice language to play",
  "output.volume": "Interpretation volume",
  "output.volumeLabel": "Interpretation playback volume",
  "output.engineNote": "Caption engine",
  "output.engineNoteValue": "Gemini",
  "start.captions": "Start captions",
  "start.captionsAudio": "Start captions + audio",
  "start.audio": "Start interpretation audio",
  "glossary.preset": "Glossary preset",
  "glossary.presetCustom": "Custom",
  "glossary.manage": "Manage Glossaries",
  "glossary.domain": "Translation domain",
  "glossary.domainPlaceholder": "e.g. Commercial real estate — hotel investment, development, asset management",
  "glossary.terms": "Glossary",
  "glossary.termsPlaceholder": "e.g. operator -> 운영사",
  "appearance.opacity": "Background opacity",
  "appearance.opacityLabel": "Subtitle background opacity",
  "appearance.fontSize": "Font size",
  "appearance.fontSizeSlider": "Translation size slider",
  "appearance.fontFamily": "Font family",
  "appearance.edgeOffset": "Edge offset",
  "appearance.edgeOffsetLabel": "Distance from the screen edge (px)",
  "preview.label": "Current subtitle",
  "preview.regionLabel": "Current subtitle",
  "preview.sample": "Translated subtitle",

  // ── Live Call page ──────────────────────────────────────────────────────
  "live.pageLabel": "Live Call scheduling",
  "live.sessionDetails": "Session Details",
  "live.title": "Title",
  "live.titlePlaceholder": "Town Hall Q&A",
  "live.coverRules": "Cover image (optional) · Square · JPEG, PNG, or WebP · Max 5MB",
  "live.coverUpload": "Upload Image",
  "live.coverChoose": "Choose a Live Call cover image",
  "live.coverNone": "No image selected.",
  "live.coverPreparing": "Preparing image…",
  "live.coverInvalidType": "Choose a JPEG, PNG, or WebP image.",
  "live.coverTooLarge": "The cover image must be no larger than 5MB.",
  "live.coverSignatureMismatch": "The selected file does not match its image type.",
  "live.coverFailed": "Could not prepare the cover image.",
  "live.coverSelected": "Selected cover: {name}",
  "live.schedule": "Schedule",
  "live.startDate": "Start date (empty starts now)",
  "live.startTime": "Start time",
  "live.language": "Language",
  "live.access": "Access & Capacity",
  "live.capacity": "Participant capacity (max 50)",
  "live.handoffKicker": "OPTIONAL · LIVE CALL",
  "live.handoffTitle": "Share these captions with guests",
  "live.handoffFlow": "Create session → share QR or code → start Live Call",
  "live.start": "Start Live Call",
  "live.register": "Register for Later",
  "live.idle": "Idle",
  "live.webDashboard": "Web dashboard",
  "live.registered": "Registered Sessions",
  "live.refreshRegistered": "Refresh registered sessions",
  "live.desktopOnly": "Live Call is available in the desktop app only.",
  "live.creating": "Creating the live session…",
  "live.stageUp": "Stage overlay is up — access code {code}. Press Go-Live on the controller to begin.",
  "live.startFailed": "Could not start Live Call. Please try again. (code: {code})",
  "live.startFailedPlain": "Could not start Live Call.",
  "live.hostLoginRejected": "The workspace rejected the saved host ID/password. Update them in Settings to the host account the workspace accepts.",
  "live.hostLoginRequired": "Host authorization is required. Open Settings and save the host authorization.",
  "live.hostVerifiedRetry": "Host sign-in verified — retrying Start Live Call…",
  "live.loadingRegistered": "Loading registered sessions…",
  "live.registeredLoadFailed": "Could not load the registered sessions.",
  "live.registeredEmpty": "No registered sessions yet.",
  "live.registeredStart": "Load and start",
  "live.registeredStartFailed": "Could not start the registered session. (code: {code})",
  "live.registeredNoTitle": "(untitled)",
  "live.registeredStartNow": "Can start now",
  "live.registering": "Registering the session…",
  "live.registered.ok": "Session registered — {title}",
  "live.registerFailed": "Could not register the session. (code: {code})",
  "live.registerFailedPlain": "Could not register the session.",
  "live.err.HTTP_400": "The workspace rejected the session settings — the app and server versions may be out of sync. Update the app and try again.",
  "live.err.LIVE_CALL_DISABLED": "Live Call is turned off in this build.",
  "live.err.LIVE_CALL_ALREADY_ARMED": "A Live Call stage is already open. End it from the controller first.",
  "live.err.LIVE_CALL_START_IN_PROGRESS": "The stage is already being created — one moment.",
  "live.err.NETWORK_UNAVAILABLE": "The workspace could not be reached. Check the network and try again.",
  "live.err.LOGIN_RATE_LIMITED": "The workspace is rate-limiting sign-ins. Wait a minute and try again.",
  "live.err.INVALID_COVER_IMAGE": "The cover image could not be used. Choose a JPEG, PNG, or WebP under 5MB.",
  "live.err.COVER_UPLOAD_FAILED": "The cover image upload failed. Try again or start without a cover.",
  "live.err.INVITE_CREATE_FAILED": "The invite could not be created. Try again.",
  "live.err.STAGE_OPEN_FAILED": "The stage window could not be opened. Try again.",
  "live.err.SESSION_NOT_PREPARING": "That registered session has already started or ended. Refresh the list.",
  "live.err.INVALID_SESSION_ID": "The registered session could not be identified. Refresh the list.",

  // ── Records page ────────────────────────────────────────────────────────
  "records.pageLabel": "Caption records",
  "records.prevPeriod": "Previous period",
  "records.nextPeriod": "Next period",
  "records.today": "Today",
  "records.viewGroup": "View",
  "records.month": "Month",
  "records.week": "Week",
  "records.day": "Day",
  "records.refresh": "Refresh",
  "records.captionSessions": "Caption sessions",
  "records.back": "← Back to list",
  "records.transcript": "Transcript",
  "records.transcriptLabel": "Source transcript",
  "records.summary": "AI summary",
  "records.summaryLabel": "AI summary",
  "records.generateSummary": "Generate AI summary",
  "records.summaryReady": "The AI summary is ready.",
  "records.summaryBadge": "Summary",
  "records.noSummary": "No summary yet.",
  "records.noLines": "This session has no recorded lines.",
  "records.loadFailed": "Could not load the session.",
  "records.summaryFailed": "Could not generate the summary.",
  "records.meetingCount": "{count} meetings",
  "records.lineCount": "{count} lines",
  "records.noTitle": "Untitled",
  "records.continued": "cont.",
  "records.decisions": "Decisions",
  "records.actionItems": "Action items",
  "records.systemAudio": "System audio",
  "records.micAudio": "Microphone audio",
  "records.weekday.0": "Sun",
  "records.weekday.1": "Mon",
  "records.weekday.2": "Tue",
  "records.weekday.3": "Wed",
  "records.weekday.4": "Thu",
  "records.weekday.5": "Fri",
  "records.weekday.6": "Sat",
  "records.monthPeriod": "{month}/{year}",
  "records.dayPeriod": "{month}/{day} {weekday}",
  "records.weekPeriod": "{fromMonth}/{fromDay} – {toMonth}/{toDay}",
  "records.hourMark": "{hour}:00",
  "history.topics": "Topics",
  "history.export": "Excel",
  "history.clear": "Clear records",
  "history.recorderPreparing": "Preparing records",
  "history.committed": "Committed subtitles",
  "history.committedLabel": "Committed subtitles by day",
  "history.empty": "No committed subtitles yet — lines land here as they are confirmed.",
  "history.topicsEmpty": "Topics are organized automatically as the talk progresses.",
  "history.sentenceCount": "{count} sentences",
  "history.unknownDate": "Unknown date",
  "history.recorderOff": "Records off",
  "history.recorderFallback": "Records running on the fallback helper",
  "history.recorderReady": "Records ready",

  // ── Settings page ───────────────────────────────────────────────────────
  "settings.pageLabel": "Application settings",
  "settings.input": "Input",
  "settings.inputSystemMic": "System + microphone",
  "settings.inputSystem": "System audio only",
  "settings.inputMic": "Microphone only",
  "settings.topicModel": "Topic model",
  "settings.topicOllama": "Gemma local via Ollama",
  "settings.topicNone": "No local recording",
  "settings.tone": "Tone",
  "settings.toneNatural": "Natural",
  "settings.toneBusiness": "Business",
  "settings.audioSources": "Audio sources",
  "settings.audioSourcesLabel": "Audio input status",
  "settings.refresh": "Refresh",
  "settings.system": "System",
  "settings.microphone": "Microphone",
  "settings.systemDefault": "System default",
  "settings.drawer": "Settings",
  "settings.drawerAdvanced": "Advanced",
  "settings.openaiKey": "OpenAI API key",
  "settings.openaiKey2": "OpenAI API key 2",
  "settings.geminiKey": "Gemini API key (Live Translate)",
  "settings.geminiKey2": "Gemini API key 2 (Glossary finalizer)",
  "settings.saveKey": "Save key",
  "settings.saveKey2": "Save key 2",
  "settings.settingsFile": "Settings file",
  "settings.export": "Export (JSON)",
  "settings.import": "Import (JSON)",
  "settings.sourceSize": "Source size",
  "settings.sourceSizeSlider": "Source size slider",
  "settings.maxWidth": "Max width",
  "settings.maxLines": "Max subtitle lines",
  "settings.gemmaModel": "Gemma model",
  "settings.ollamaUrl": "Ollama local URL",
  "settings.hostId": "Host ID",
  "settings.hostName": "Display name",
  "settings.hostPassword": "Host password",
  "settings.hostPasswordPlaceholder": "A saved password is never shown",
  "settings.reveal": "Show",
  "settings.hide": "Hide",
  "settings.revealLabel": "Show password",
  "settings.hideLabel": "Hide password",
  "settings.saveHostAuthorization": "Save host authorization",
  "settings.authorizationRequired": "Authorization required",
  "settings.authorized": "Authorized",
  "settings.authorizedVerified": "Authorized — the workspace accepted the sign-in.",
  "settings.savingHostAuthorization": "Saving and verifying host authorization…",
  "settings.hostSaveFailed": "Could not save the host authorization.",
  "settings.hostKeychainUnavailable": "This device cannot encrypt the password (OS keychain unavailable). Unlock it and try again.",
  "settings.hostRejected": "Saved, but the workspace rejected this ID/password. Enter the host account the workspace accepts, then save again.",
  "settings.hostNetworkUnavailable": "Saved, but the workspace could not be reached. Check the network, then save again to re-verify.",
  "settings.hostRateLimited": "Saved, but the workspace is rate-limiting sign-ins. Wait a minute, then save again to re-verify.",
  "settings.hostNoStoredLogin": "Authorization required — enter both the host ID and password.",
  "settings.hostVerifyFailed": "Saved, but the workspace sign-in failed ({code}).",

  // ── Player bar ──────────────────────────────────────────────────────────
  "player.controls": "Caption session controls",
  "player.overlayStatus": "Overlay status",
  "player.overlayActive": "Active",
  "player.overlayInactive": "Not Active",
  "player.restart": "Restart",
  "player.stop": "Stop captions",
  "player.overlayToggle": "Subtitle overlay",
  "player.translateAll": "Translate all selected languages",

  // ── API keys ────────────────────────────────────────────────────────────
  "key.registered": "✓ Registered · stored locally",
  "key.registeredSecondary": "✓ Registered · glossary finalizer and parallel translation",
  "key.unregistered": "Not registered",
  "key.geminiSecondaryHint": "Not registered",
  "key.replaceHint": "Enter a new key to replace the stored one.",
  "key.replaceHintSecondary": "Enter a new secondary key to replace the stored one.",
  "key.enterOpenAI": "Enter the OpenAI API key.",
  "key.enterOpenAISecondary": "Enter OpenAI API key 2.",
  "key.enterGemini": "Enter the Gemini API key.",
  "key.enterGeminiSecondary": "Enter Gemini API key 2.",
  "key.validatingOpenAI": "Validating OpenAI Realtime...",
  "key.validatingGemini": "Validating Gemini...",
  "key.savingGemini": "Saving Gemini key...",
  "key.savingGemini2": "Saving Gemini key 2...",
  "key.openaiSaved": "OpenAI Realtime verified and the API key was saved.",
  "key.openaiSecondarySaved": "OpenAI Realtime verified and API key 2 was saved.",
  "key.geminiSaved": "Gemini API key verified and saved for Live Translate.",
  "key.geminiSecondarySaved": "Gemini API key 2 verified and saved for glossary finalizing.",
  "key.openaiValidateFailed": "Could not verify the OpenAI Realtime connection.",
  "key.geminiValidateFailed": "Could not verify the Gemini API key.",
  "key.geminiRequired": "Gemini API key is required. Enter a key before starting subtitles.",
  "key.openaiVoiceRequired": "An OpenAI API key is required for OpenAI Realtime voice.",
  "key.configuredPlaceholder": "configured (enter to replace)",

  // ── Notices / errors ────────────────────────────────────────────────────
  "notice.settingsSaved": "Settings saved.",
  "notice.inputRestarted": "Restarted the session with the new input.",
  "notice.channelsRebuilt": "Translation channels were rebuilt with the new settings.",
  "notice.presetApplied": "Preset applied: {label}",
  "notice.presetAppliedRebuilt": "Preset applied and translation channels rebuilt: {label}",
  "notice.settingsImported": "Settings imported — glossary, domain, and keys were applied.",
  "notice.audioQueueTrimmed": "Backlogged interpretation audio was cleared; playback resumes from the newest audio.",
  "notice.audioFeedbackWarning": "Interpretation audio may loop back through the system audio input. A microphone-only input with earphones is recommended.",
  "notice.captionEngineRestarted": "Caption engine restarted. The Live Call session remains connected.",
  "notice.partialInputs": "{failures} Started with the available inputs only.",
  "notice.fontSizeSaved": "Subtitle font size saved.",
  "notice.edgeOffsetSaved": "Subtitle edge offset saved.",
  "notice.positionSaved": "Subtitle position saved.",
  "notice.opacitySaved": "Subtitle opacity saved.",
  "notice.languagesSaved": "Subtitle languages saved.",
  "notice.languagesSavedRebuilt": "Subtitle languages changed and translation channels rebuilt.",
  "error.importNotSettingsFile": "That is not a settings file. Choose a JSON file created by Export.",
  "error.importSectionShape": "The subtitle/apiKeys entries of a settings file must be objects. Arrays and strings cannot be imported.",
  "error.saveSettingsFailed": "Failed to save settings.",
  "error.badAudioFrame": "Skipped an invalid interpretation audio frame and kept receiving.",
  "error.noSystemAudioTrack": "There is no system audio track. Check the screen/audio recording permission.",
  "error.captureTimeout": "{source} capture did not respond within {seconds} seconds.",
  "error.audioEngineStart": "{source} audio engine could not start. Press Start again or check the microphone/screen recording permission.",
  "error.audioEngineSuspended": "{source} audio engine is suspended. Press Start again to re-activate audio access.",
  "error.systemAudioDenied": "System audio permission was denied. Allow Realtime Noel under macOS Privacy & Security > Screen & System Audio Recording, then restart the app.",
  "error.systemAudioFailed": "System audio could not start: {reason} Allow Realtime Noel under macOS Privacy & Security > Screen & System Audio Recording, then restart the app. When running in development, the Electron entry needs the same permission.",
  "error.micDenied": "Microphone permission was denied. Allow Realtime Noel under System Settings > Privacy & Security > Microphone, then restart the app.",
  "error.micFailed": "The microphone could not start: {reason} Check the Realtime Noel permission under System Settings > Privacy & Security > Microphone.",
  "error.openSystemSettings": "Open System Settings",
  "error.websocketClosed": "WebSocket is not connected.",

  // ── Audio inspector states ──────────────────────────────────────────────
  "audio.ready": "Ready",
  "audio.off": "Off",
  "audio.muted": "Muted",
  "audio.ended": "Ended",
  "audio.unavailable": "Unavailable",
  "audio.starting": "Starting audio",
  "audio.blocked": "Audio blocked",
  "audio.paused": "Audio paused",
  "audio.signal": "Signal",
  "audio.noSignal": "No signal",
  "audio.outputIsolated": "Output isolated",
  "audio.waiting": "Waiting",
  "audio.systemAudio": "System audio",
  "audio.recoveryContinuing": "Interpretation audio recovered · still receiving",
  "audio.recoveryWaiting": "Interpretation audio recovered · waiting for the next audio",

  // ── Live Call participants ──────────────────────────────────────────────
  "live.participant": "Participant",

  // ── Caption controller ──────────────────────────────────────────────────
  "controller.windowLabel": "Live subtitle controls",
  "controller.move": "Move subtitle controller",
  "controller.captionEngine": "Caption engine",
  "controller.restart": "Restart captions",
  "controller.stop": "Stop captions",
  "controller.goLive": "Go-Live",
  "controller.live": "LIVE",
  "controller.hostSpeak": "Host Speak",
  "controller.end": "End",
  "controller.elapsed": "Live elapsed time",
  "controller.appearance": "Subtitle appearance",
  "controller.fontSize": "Subtitle font size",
  "controller.fontDown": "Decrease subtitle font size",
  "controller.fontUp": "Increase subtitle font size",
  "controller.position": "Subtitle position",
  "controller.positionTop": "Subtitles at the top",
  "controller.positionMiddle": "Subtitles in the middle",
  "controller.positionBottom": "Subtitles at the bottom",
  "controller.opacity": "Subtitle background opacity",
  "controller.gap": "Subtitle edge gap",
  "controller.gapDown": "Move subtitles closer to the edge",
  "controller.gapUp": "Move subtitles away from the edge",
  "controller.voice": "Voice",
  "controller.voiceEngine": "Interpretation voice engine",
  "controller.appControls": "App controls",
  "controller.mainWindow": "Main",
  "controller.hide": "Hide the controller",
  "controller.quit": "Quit",
  "controller.captionsReady": "Captions ready",
  "controller.reclaiming": "Reclaiming the floor…",
  "controller.hasFloor": "Host has the floor — your microphone is live.",
  "controller.reclaimFailed": "Could not reclaim the floor. Try again.",
  "controller.startingLive": "Starting the Live Call…",
  "controller.liveStarted": "LIVE — guests now receive captions.",
  "controller.goLiveFailedCode": "Go-Live failed ({code}). Try again.",
  "controller.goLiveFailed": "Go-Live failed. Try again.",
  "controller.endConfirm": "End this Live Call for every participant? This cannot be undone.",
  "controller.ending": "Ending Live Call…",
  "controller.endFailed": "Live Call could not be ended. Try again.",

  // ── Application menu (main process) ─────────────────────────────────────
  "menu.surfaces": "Surfaces",
  "menu.showMainWindow": "Show Main Window",
  "menu.showCaptionController": "Show Caption Controller",
  "menu.hideCaptionController": "Hide Caption Controller",
  "menu.showSubtitleOverlays": "Show Subtitle Overlays",
};

const KO = {
  // ── Brand ───────────────────────────────────────────────────────────────
  "app.name": "NOVA",
  "app.credit": "Realtime by Noel",
  "app.railLabel": "NOVA 작업 공간",
  "app.title": "NOVA",
  "app.controllerTitle": "NOVA 자막 컨트롤러",

  // ── Navigation / pages ──────────────────────────────────────────────────
  "nav.captions": "자막",
  "nav.livecall": "Live Call",
  "nav.records": "기록",
  "nav.settings": "설정",
  "page.captions.title": "자막",
  "page.livecall.title": "Live Call",
  "page.records.title": "기록",
  "page.settings.title": "설정",
  "page.captions.label": "자막",
  "page.livecall.label": "Live Call",
  "page.records.label": "기록",
  "page.settings.label": "설정",

  // ── Language + theme switches ───────────────────────────────────────────
  "lang.group": "앱 언어",
  "lang.en": "English",
  "lang.ko": "한국어",
  "theme.group": "화면 테마",
  "theme.dark": "다크 테마",
  "theme.light": "라이트 테마",

  // ── Connection / engine status ──────────────────────────────────────────
  "status.connecting": "연결 중",
  "status.captionsReady": "자막 준비됨",
  "status.disconnected": "연결이 끊겼습니다",
  "status.checkConnection": "연결을 확인해주세요",
  "status.serviceConnecting": "서비스 연결 중",
  "status.hearing": "말씀을 듣고 있어요",
  "status.translating": "번역하고 있어요",
  "status.reconnecting": "다시 연결하는 중",
  "status.receivingCaptions": "자막 수신 중",
  "status.checkingInputs": "입력 장치 확인 중",
  "status.inputCheck": "입력 확인 중",
  "status.waitingForCaptions": "자막 대기 중",
  "status.problem": "문제가 발생했습니다",
  "status.openInDesktopApp": "데스크톱 앱에서 열어주세요",
  "status.reopeningLocalServer": "로컬 서버에서 다시 여는 중",
  "status.openingDesktopApp": "데스크톱 앱으로 여는 중",
  "status.realtimeChecking": "실시간 자막 확인 중",
  "status.realtimeConnected": "실시간 자막 연결됨",
  "status.realtimeReconnecting": "실시간 자막 다시 연결 중",
  "status.modelConnection": "모델 연결 상태",
  "status.topicModelStandby": "Gemma: 대기",

  // ── Captions page ───────────────────────────────────────────────────────
  "captions.session": "세션",
  "captions.sessionDefault": "시스템 + 마이크",
  "cfg.languages": "자막 언어",
  "cfg.languagesLabel": "자막 언어",
  "cfg.outputMode": "출력 방식",
  "cfg.glossary": "용어집",
  "cfg.appearance": "표시 설정",
  "cfg.position": "자막 위치",
  "cfg.audioInput": "오디오 입력",
  "cfg.hostAuthorization": "Live Call 호스트 인증",
  "cfg.engineGlossary": "엔진 · 용어집",
  "language.searchPlaceholder": "언어 검색 후 추가 (예: 일본어, Japanese, ja)",
  "language.searchLabel": "번역 언어 검색",
  "language.noMatch": "일치하는 언어가 없습니다",
  "language.maxSelected": "최대 {max}개 언어 — 먼저 하나를 제거하세요",
  "language.minimum": "최소 2개 언어를 선택해야 합니다",
  "language.remove": "{language} 제거",
  "language.positionLabel": "{language} 자막 위치",
  "position.top": "상단",
  "position.middle": "중앙",
  "position.bottom": "하단",
  "position.groupLabel": "언어별 자막 위치",
  "output.kicker": "로컬 재생",
  "output.ptTitle": "PT 출력",
  "output.systemDefault": "시스템 기본 출력",
  "output.modeLabel": "PT 출력 방식",
  "output.captions": "자막",
  "output.captionsAudio": "자막 + 통역 음성",
  "output.audio": "통역 음성만",
  "output.voiceEngine": "통역 음성 엔진",
  "output.geminiVoice": "Gemini 음성",
  "output.openaiRealtime": "OpenAI Realtime",
  "output.openaiUnsupported": "선택한 언어는 OpenAI Realtime 통역 음성을 지원하지 않아 Gemini 음성을 사용합니다.",
  "output.audioLanguage": "통역 음성 언어",
  "output.audioLanguageLabel": "재생할 통역 음성 언어",
  "output.volume": "통역 음량",
  "output.volumeLabel": "통역 음성 재생 음량",
  "output.engineNote": "자막 엔진",
  "output.engineNoteValue": "Gemini 고정",
  "start.captions": "자막 시작",
  "start.captionsAudio": "자막 + 통역 음성 시작",
  "start.audio": "통역 음성만 시작",
  "glossary.preset": "용어집 프리셋",
  "glossary.presetCustom": "직접 입력",
  "glossary.manage": "용어집 관리",
  "glossary.domain": "번역 도메인",
  "glossary.domainPlaceholder": "예) 상업용 부동산 — 호텔 투자·개발·자산관리",
  "glossary.terms": "전문용어집",
  "glossary.termsPlaceholder": "예) operator -> 운영사",
  "appearance.opacity": "배경 투명도",
  "appearance.opacityLabel": "자막 배경 불투명도",
  "appearance.fontSize": "자막 크기",
  "appearance.fontSizeSlider": "번역 자막 크기 슬라이더",
  "appearance.fontFamily": "글꼴",
  "appearance.edgeOffset": "여백",
  "appearance.edgeOffsetLabel": "가장자리에서의 거리(px)",
  "preview.label": "현재 자막",
  "preview.regionLabel": "현재 자막",
  "preview.sample": "번역 자막",

  // ── Live Call page ──────────────────────────────────────────────────────
  "live.pageLabel": "Live Call 예약",
  "live.sessionDetails": "세션 정보",
  "live.title": "제목",
  "live.titlePlaceholder": "타운홀 Q&A",
  "live.coverRules": "커버 이미지 (선택) · 정사각형 · JPEG, PNG, WebP · 최대 5MB",
  "live.coverUpload": "이미지 업로드",
  "live.coverChoose": "Live Call 커버 이미지 선택",
  "live.coverNone": "선택된 이미지 없음",
  "live.coverPreparing": "이미지 준비 중…",
  "live.coverInvalidType": "JPEG, PNG, WebP 이미지를 선택하세요.",
  "live.coverTooLarge": "커버 이미지는 5MB 이하여야 합니다.",
  "live.coverSignatureMismatch": "선택한 파일이 이미지 형식과 일치하지 않습니다.",
  "live.coverFailed": "커버 이미지를 준비하지 못했습니다.",
  "live.coverSelected": "선택한 커버: {name}",
  "live.schedule": "일정",
  "live.startDate": "시작 날짜 (비우면 바로 시작)",
  "live.startTime": "시작 시각",
  "live.language": "언어",
  "live.access": "입장 · 정원",
  "live.capacity": "참가 정원 (최대 50)",
  "live.handoffKicker": "선택 · LIVE CALL",
  "live.handoffTitle": "게스트와 자막 공유",
  "live.handoffFlow": "세션 생성 → QR·코드 공유 → Live Call 시작",
  "live.start": "Live Call 시작",
  "live.register": "나중에 시작하도록 등록",
  "live.idle": "대기 중",
  "live.webDashboard": "웹 대시보드",
  "live.registered": "등록된 세션",
  "live.refreshRegistered": "등록된 세션 새로고침",
  "live.desktopOnly": "Live Call은 데스크톱 앱에서만 사용할 수 있습니다.",
  "live.creating": "라이브 세션을 만드는 중…",
  "live.stageUp": "스테이지가 열렸습니다 — 입장 코드 {code}. 컨트롤러에서 Go-Live를 누르세요.",
  "live.startFailed": "Live Call을 시작하지 못했습니다. 다시 시도하세요. (code: {code})",
  "live.startFailedPlain": "Live Call을 시작하지 못했습니다.",
  "live.hostLoginRejected": "저장된 호스트 ID/비밀번호가 거부되었습니다. 설정에서 워크스페이스가 허용하는 호스트 계정으로 바꿔주세요.",
  "live.hostLoginRequired": "호스트 인증이 필요합니다. 설정에서 호스트 인증을 저장하세요.",
  "live.hostVerifiedRetry": "호스트 로그인이 확인되었습니다 — Live Call 시작을 다시 시도합니다…",
  "live.loadingRegistered": "등록된 세션을 불러오는 중…",
  "live.registeredLoadFailed": "등록된 세션을 불러오지 못했습니다.",
  "live.registeredEmpty": "등록된 세션이 없습니다.",
  "live.registeredStart": "불러와서 시작",
  "live.registeredStartFailed": "등록된 세션을 시작하지 못했습니다. (code: {code})",
  "live.registeredNoTitle": "(제목 없음)",
  "live.registeredStartNow": "바로 시작 가능",
  "live.registering": "세션을 등록하는 중…",
  "live.registered.ok": "세션이 등록되었습니다 — {title}",
  "live.registerFailed": "세션을 등록하지 못했습니다. (code: {code})",
  "live.registerFailedPlain": "세션을 등록하지 못했습니다.",
  "live.err.HTTP_400": "워크스페이스가 세션 설정을 거부했습니다 — 앱과 서버 버전이 다를 수 있습니다. 앱을 업데이트한 뒤 다시 시도하세요.",
  "live.err.LIVE_CALL_DISABLED": "이 빌드에서는 Live Call이 꺼져 있습니다.",
  "live.err.LIVE_CALL_ALREADY_ARMED": "이미 열려 있는 Live Call 스테이지가 있습니다. 컨트롤러에서 먼저 종료하세요.",
  "live.err.LIVE_CALL_START_IN_PROGRESS": "스테이지를 만드는 중입니다 — 잠시만 기다려주세요.",
  "live.err.NETWORK_UNAVAILABLE": "워크스페이스에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도하세요.",
  "live.err.LOGIN_RATE_LIMITED": "워크스페이스가 로그인 요청을 제한하고 있습니다. 잠시 후 다시 시도하세요.",
  "live.err.INVALID_COVER_IMAGE": "커버 이미지를 사용할 수 없습니다. 5MB 이하의 JPEG, PNG, WebP를 선택하세요.",
  "live.err.COVER_UPLOAD_FAILED": "커버 이미지 업로드에 실패했습니다. 다시 시도하거나 커버 없이 시작하세요.",
  "live.err.INVITE_CREATE_FAILED": "초대를 만들지 못했습니다. 다시 시도하세요.",
  "live.err.STAGE_OPEN_FAILED": "스테이지 창을 열지 못했습니다. 다시 시도하세요.",
  "live.err.SESSION_NOT_PREPARING": "그 등록 세션은 이미 시작되었거나 종료되었습니다. 목록을 새로고침하세요.",
  "live.err.INVALID_SESSION_ID": "등록된 세션을 식별할 수 없습니다. 목록을 새로고침하세요.",

  // ── Records page ────────────────────────────────────────────────────────
  "records.pageLabel": "자막 기록",
  "records.prevPeriod": "이전 기간",
  "records.nextPeriod": "다음 기간",
  "records.today": "오늘",
  "records.viewGroup": "보기 단위",
  "records.month": "월",
  "records.week": "주",
  "records.day": "일",
  "records.refresh": "새로고침",
  "records.captionSessions": "자막 세션",
  "records.back": "← 목록으로",
  "records.transcript": "원문",
  "records.transcriptLabel": "원문 기록",
  "records.summary": "AI 요약",
  "records.summaryLabel": "AI 요약",
  "records.generateSummary": "AI 요약 생성",
  "records.summaryReady": "AI 요약이 준비되었습니다.",
  "records.summaryBadge": "요약",
  "records.noSummary": "아직 요약이 없습니다.",
  "records.noLines": "이 세션에는 기록된 라인이 없습니다.",
  "records.loadFailed": "세션을 불러오지 못했습니다.",
  "records.summaryFailed": "요약을 생성하지 못했습니다.",
  "records.meetingCount": "미팅 {count}건",
  "records.lineCount": "{count}줄",
  "records.noTitle": "제목 없음",
  "records.continued": "계속",
  "records.decisions": "결정 사항",
  "records.actionItems": "액션 아이템",
  "records.systemAudio": "시스템 음성",
  "records.micAudio": "마이크 음성",
  "records.weekday.0": "일",
  "records.weekday.1": "월",
  "records.weekday.2": "화",
  "records.weekday.3": "수",
  "records.weekday.4": "목",
  "records.weekday.5": "금",
  "records.weekday.6": "토",
  "records.monthPeriod": "{year}년 {month}월",
  "records.dayPeriod": "{month}월 {day}일 {weekday}",
  "records.weekPeriod": "{fromMonth}월 {fromDay}일 – {toMonth}월 {toDay}일",
  "records.hourMark": "{hour}시",
  "history.topics": "주제",
  "history.export": "Excel",
  "history.clear": "기록 지우기",
  "history.recorderPreparing": "기록 준비 중",
  "history.committed": "확정된 자막",
  "history.committedLabel": "날짜별 확정 자막 기록",
  "history.empty": "아직 확정된 자막이 없습니다 — 문장이 확정되는 대로 여기에 쌓입니다.",
  "history.topicsEmpty": "발표가 진행되면 주제가 자동으로 정리됩니다.",
  "history.sentenceCount": "{count}문장",
  "history.unknownDate": "날짜 미확인",
  "history.recorderOff": "기록 꺼짐",
  "history.recorderFallback": "기록 보조 기능 사용 중",
  "history.recorderReady": "기록 준비됨",

  // ── Settings page ───────────────────────────────────────────────────────
  "settings.pageLabel": "앱 설정",
  "settings.input": "입력",
  "settings.inputSystemMic": "시스템 + 마이크",
  "settings.inputSystem": "시스템 오디오만",
  "settings.inputMic": "마이크만",
  "settings.topicModel": "주제 모델",
  "settings.topicOllama": "Ollama 로컬 Gemma",
  "settings.topicNone": "로컬 기록 없음",
  "settings.tone": "번역 어투",
  "settings.toneNatural": "자연스럽게",
  "settings.toneBusiness": "비즈니스",
  "settings.audioSources": "오디오 소스",
  "settings.audioSourcesLabel": "오디오 입력 상태",
  "settings.refresh": "새로고침",
  "settings.system": "시스템",
  "settings.microphone": "마이크",
  "settings.systemDefault": "시스템 기본",
  "settings.drawer": "설정",
  "settings.drawerAdvanced": "고급",
  "settings.openaiKey": "OpenAI API key",
  "settings.openaiKey2": "OpenAI API key 2",
  "settings.geminiKey": "Gemini API key (Live Translate)",
  "settings.geminiKey2": "Gemini API key 2 (용어집 보정)",
  "settings.saveKey": "키 저장",
  "settings.saveKey2": "키 2 저장",
  "settings.settingsFile": "설정 파일",
  "settings.export": "내보내기 (JSON)",
  "settings.import": "가져오기 (JSON)",
  "settings.sourceSize": "원문 크기",
  "settings.sourceSizeSlider": "원문 크기 슬라이더",
  "settings.maxWidth": "최대 너비",
  "settings.maxLines": "자막 최대 줄 수",
  "settings.gemmaModel": "Gemma 모델",
  "settings.ollamaUrl": "Ollama 로컬 URL",
  "settings.hostId": "호스트 ID",
  "settings.hostName": "표시 이름",
  "settings.hostPassword": "호스트 비밀번호",
  "settings.hostPasswordPlaceholder": "저장된 비밀번호는 표시되지 않습니다",
  "settings.reveal": "표시",
  "settings.hide": "숨김",
  "settings.revealLabel": "비밀번호 표시",
  "settings.hideLabel": "비밀번호 숨김",
  "settings.saveHostAuthorization": "호스트 인증 저장",
  "settings.authorizationRequired": "인증 필요",
  "settings.authorized": "인증됨",
  "settings.authorizedVerified": "인증됨 — 워크스페이스가 로그인을 허용했습니다.",
  "settings.savingHostAuthorization": "호스트 인증을 저장하고 확인하는 중…",
  "settings.hostSaveFailed": "호스트 인증을 저장하지 못했습니다.",
  "settings.hostKeychainUnavailable": "이 기기에서 비밀번호를 암호화할 수 없습니다 (OS 키체인 사용 불가). 키체인을 잠금 해제한 뒤 다시 시도하세요.",
  "settings.hostRejected": "저장했지만 워크스페이스가 이 ID/비밀번호를 거부했습니다. 허용되는 호스트 계정을 입력한 뒤 다시 저장하세요.",
  "settings.hostNetworkUnavailable": "저장했지만 워크스페이스에 연결할 수 없었습니다. 네트워크를 확인한 뒤 다시 저장해 확인하세요.",
  "settings.hostRateLimited": "저장했지만 워크스페이스가 로그인 요청을 제한하고 있습니다. 잠시 후 다시 저장해 확인하세요.",
  "settings.hostNoStoredLogin": "인증 필요 — 호스트 ID와 비밀번호를 모두 입력하세요.",
  "settings.hostVerifyFailed": "저장했지만 워크스페이스 로그인에 실패했습니다 ({code}).",

  // ── Player bar ──────────────────────────────────────────────────────────
  "player.controls": "자막 세션 제어",
  "player.overlayStatus": "오버레이 상태",
  "player.overlayActive": "켜짐",
  "player.overlayInactive": "꺼짐",
  "player.restart": "다시 시작",
  "player.stop": "자막 정지",
  "player.overlayToggle": "자막 오버레이",
  "player.translateAll": "선택한 언어 모두 동시 번역",

  // ── API keys ────────────────────────────────────────────────────────────
  "key.registered": "✓ 등록됨 · 로컬에 저장됨",
  "key.registeredSecondary": "✓ 등록됨 · 완료문장 언어집 보정 및 병렬 번역",
  "key.unregistered": "미등록",
  "key.geminiSecondaryHint": "미등록",
  "key.replaceHint": "새 키를 입력하면 기존 키를 교체할 수 있습니다.",
  "key.replaceHintSecondary": "새 보조 키를 입력하면 기존 키를 교체할 수 있습니다.",
  "key.enterOpenAI": "OpenAI API key를 입력하세요.",
  "key.enterOpenAISecondary": "OpenAI API key 2를 입력하세요.",
  "key.enterGemini": "Gemini API key를 입력하세요.",
  "key.enterGeminiSecondary": "Gemini API key 2를 입력하세요.",
  "key.validatingOpenAI": "OpenAI Realtime 확인 중...",
  "key.validatingGemini": "Gemini 확인 중...",
  "key.savingGemini": "Gemini 키 저장 중...",
  "key.savingGemini2": "Gemini 키 2 저장 중...",
  "key.openaiSaved": "OpenAI Realtime 연결을 확인했고 API key를 저장했습니다.",
  "key.openaiSecondarySaved": "OpenAI Realtime 보조 키를 확인했고 API key 2를 저장했습니다.",
  "key.geminiSaved": "Gemini API key를 확인했고 Live Translate 키로 저장했습니다.",
  "key.geminiSecondarySaved": "Gemini API key 2를 확인했고 용어집 보정용 보조 키로 저장했습니다.",
  "key.openaiValidateFailed": "OpenAI Realtime 연결 확인에 실패했습니다.",
  "key.geminiValidateFailed": "Gemini API key 확인에 실패했습니다.",
  "key.geminiRequired": "Gemini API key가 필요합니다. 자막을 시작하기 전에 키를 입력하세요.",
  "key.openaiVoiceRequired": "OpenAI Realtime 음성을 사용하려면 OpenAI API key가 필요합니다.",
  "key.configuredPlaceholder": "등록됨 (새로 입력하면 교체)",

  // ── Notices / errors ────────────────────────────────────────────────────
  "notice.settingsSaved": "설정을 저장했습니다.",
  "notice.inputRestarted": "입력을 바꿔 세션을 다시 시작했습니다.",
  "notice.channelsRebuilt": "번역 채널을 새 설정으로 다시 구성했습니다.",
  "notice.presetApplied": "프리셋 적용: {label}",
  "notice.presetAppliedRebuilt": "프리셋 적용 + 번역 채널 재구성: {label}",
  "notice.settingsImported": "설정 파일을 가져왔습니다. 용어집·도메인·키가 적용되었습니다.",
  "notice.audioQueueTrimmed": "밀린 통역 음성을 정리하고 최신 음성부터 계속 재생합니다.",
  "notice.audioFeedbackWarning": "통역 음성이 시스템 오디오 입력으로 다시 들어갈 수 있습니다. 마이크 전용 입력과 이어폰을 권장합니다.",
  "notice.captionEngineRestarted": "자막 엔진을 다시 시작했습니다. Live Call 세션은 계속 연결되어 있습니다.",
  "notice.partialInputs": "{failures} 가능한 입력만으로 시작했습니다.",
  "notice.fontSizeSaved": "자막 글자 크기를 저장했습니다.",
  "notice.edgeOffsetSaved": "자막 여백을 저장했습니다.",
  "notice.positionSaved": "자막 위치를 저장했습니다.",
  "notice.opacitySaved": "자막 투명도를 저장했습니다.",
  "notice.languagesSaved": "자막 언어를 저장했습니다.",
  "notice.languagesSavedRebuilt": "자막 언어를 바꾸고 번역 채널을 다시 구성했습니다.",
  "error.importNotSettingsFile": "설정 파일 형식이 아닙니다. 내보내기로 만든 JSON을 선택하세요.",
  "error.importSectionShape": "설정 파일의 subtitle/apiKeys 항목은 객체여야 합니다. 배열이나 문자열은 가져올 수 없습니다.",
  "error.saveSettingsFailed": "설정을 저장하지 못했습니다.",
  "error.badAudioFrame": "올바르지 않은 통역 음성 프레임을 건너뛰고 계속 수신합니다.",
  "error.noSystemAudioTrack": "시스템 오디오 트랙이 없습니다. 화면/오디오 녹화 권한을 확인하세요.",
  "error.captureTimeout": "{source} 캡처가 {seconds}초 안에 응답하지 않았습니다.",
  "error.audioEngineStart": "{source} 오디오 엔진을 시작할 수 없습니다. Start를 다시 누르거나 마이크/화면 녹화 권한을 확인하세요.",
  "error.audioEngineSuspended": "{source} 오디오 엔진이 일시정지 상태입니다. Start를 다시 눌러 오디오 사용 권한을 다시 활성화하세요.",
  "error.systemAudioDenied": "시스템 오디오 권한이 거부되었습니다. macOS Privacy & Security에서 Realtime Noel의 Screen & System Audio Recording 권한을 허용한 뒤 앱을 재시작하세요.",
  "error.systemAudioFailed": "시스템 오디오를 시작하지 못했습니다: {reason} macOS Privacy & Security에서 Realtime Noel의 Screen & System Audio Recording 권한을 허용한 뒤 앱을 재시작하세요. 개발 실행 중이면 Electron 항목도 같은 권한이 필요합니다.",
  "error.micDenied": "마이크 권한이 거부되었습니다. 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 Realtime Noel을 허용한 뒤 앱을 재시작하세요.",
  "error.micFailed": "마이크를 시작하지 못했습니다: {reason} 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 Realtime Noel 권한을 확인하세요.",
  "error.openSystemSettings": "시스템 설정 열기",
  "error.websocketClosed": "WebSocket이 연결되지 않았습니다.",

  // ── Audio inspector states ──────────────────────────────────────────────
  "audio.ready": "준비됨",
  "audio.off": "꺼짐",
  "audio.muted": "음소거됨",
  "audio.ended": "종료됨",
  "audio.unavailable": "사용 불가",
  "audio.starting": "오디오 시작 중",
  "audio.blocked": "오디오 차단됨",
  "audio.paused": "오디오 일시정지",
  "audio.signal": "신호 있음",
  "audio.noSignal": "신호 없음",
  "audio.outputIsolated": "출력 분리됨",
  "audio.waiting": "대기 중",
  "audio.systemAudio": "시스템 오디오",
  "audio.recoveryContinuing": "통역 음성 자동 복구 · 계속 수신 중",
  "audio.recoveryWaiting": "통역 음성 자동 복구 · 다음 음성 대기",

  // ── Live Call participants ──────────────────────────────────────────────
  "live.participant": "참가자",

  // ── Caption controller ──────────────────────────────────────────────────
  "controller.windowLabel": "라이브 자막 제어",
  "controller.move": "자막 컨트롤러 이동",
  "controller.captionEngine": "자막 엔진",
  "controller.restart": "자막 다시 시작",
  "controller.stop": "자막 정지",
  "controller.goLive": "Go-Live",
  "controller.live": "LIVE",
  "controller.hostSpeak": "호스트 발언",
  "controller.end": "종료",
  "controller.elapsed": "라이브 경과 시간",
  "controller.appearance": "자막 표시",
  "controller.fontSize": "자막 글자 크기",
  "controller.fontDown": "자막 글자 크기 줄이기",
  "controller.fontUp": "자막 글자 크기 키우기",
  "controller.position": "자막 위치",
  "controller.positionTop": "자막 상단",
  "controller.positionMiddle": "자막 중앙",
  "controller.positionBottom": "자막 하단",
  "controller.opacity": "자막 배경 불투명도",
  "controller.gap": "자막 가장자리 여백",
  "controller.gapDown": "자막을 가장자리에 가깝게",
  "controller.gapUp": "자막을 가장자리에서 멀게",
  "controller.voice": "음성",
  "controller.voiceEngine": "통역 음성 엔진",
  "controller.appControls": "앱 제어",
  "controller.mainWindow": "메인",
  "controller.hide": "컨트롤러 숨기기",
  "controller.quit": "종료",
  "controller.captionsReady": "자막 준비됨",
  "controller.reclaiming": "발언권을 회수하는 중…",
  "controller.hasFloor": "호스트가 발언권을 가졌습니다 — 마이크가 열려 있습니다.",
  "controller.reclaimFailed": "발언권을 회수하지 못했습니다. 다시 시도하세요.",
  "controller.startingLive": "Live Call을 시작하는 중…",
  "controller.liveStarted": "LIVE — 게스트에게 자막이 전달됩니다.",
  "controller.goLiveFailedCode": "Go-Live 실패 ({code}). 다시 시도하세요.",
  "controller.goLiveFailed": "Go-Live 실패. 다시 시도하세요.",
  "controller.endConfirm": "모든 참가자의 Live Call을 종료할까요? 되돌릴 수 없습니다.",
  "controller.ending": "Live Call 종료 중…",
  "controller.endFailed": "Live Call을 종료하지 못했습니다. 다시 시도하세요.",

  // ── Application menu (main process) ─────────────────────────────────────
  "menu.surfaces": "창",
  "menu.showMainWindow": "메인 창 보기",
  "menu.showCaptionController": "자막 컨트롤러 보기",
  "menu.hideCaptionController": "자막 컨트롤러 숨기기",
  "menu.showSubtitleOverlays": "자막 오버레이 보기",
};

export const MESSAGES = { en: EN, ko: KO };

let activeLanguage = DEFAULT_UI_LANGUAGE;
const listeners = new Set();

export function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const base = value.trim().toLowerCase().split(/[-_]/u)[0];
  return SUPPORTED_UI_LANGUAGES.includes(base) ? base : null;
}

export function getLanguage() {
  return activeLanguage;
}

function interpolate(template, values) {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}

export function t(key, values) {
  const table = MESSAGES[activeLanguage] ?? MESSAGES[DEFAULT_UI_LANGUAGE];
  const template = table[key] ?? MESSAGES[DEFAULT_UI_LANGUAGE][key];
  if (typeof template !== "string") return key;
  return interpolate(template, values);
}

export function hasKey(key) {
  return typeof MESSAGES[DEFAULT_UI_LANGUAGE][key] === "string";
}

export function subscribe(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setLanguage(value) {
  const next = normalizeLanguage(value);
  if (!next || next === activeLanguage) return activeLanguage;
  activeLanguage = next;
  for (const listener of [...listeners]) {
    try { listener(next); } catch { /* a broken listener never blocks the switch */ }
  }
  return activeLanguage;
}

// ── Persistence ───────────────────────────────────────────────────────────
// Storage is passed in so this stays testable; browsers call it with
// localStorage (which can throw in private/hardened modes).

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredLanguage(storage = defaultStorage()) {
  try {
    return normalizeLanguage(storage?.getItem?.(UI_LANGUAGE_STORAGE_KEY)) ?? DEFAULT_UI_LANGUAGE;
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

export function persistLanguage(value, storage = defaultStorage()) {
  const next = normalizeLanguage(value);
  if (!next) return null;
  try {
    storage?.setItem?.(UI_LANGUAGE_STORAGE_KEY, next);
  } catch {
    // Storage is optional; the in-memory choice still applies for this session.
  }
  return next;
}

// Restore + apply in one call, used by every page on boot.
export function initLanguage(storage = defaultStorage()) {
  const stored = readStoredLanguage(storage);
  activeLanguage = stored;
  return stored;
}

// Persisted switch: store the choice, then notify every subscriber.
export function changeLanguage(value, storage = defaultStorage()) {
  const next = normalizeLanguage(value);
  if (!next) return activeLanguage;
  persistLanguage(next, storage);
  if (next === activeLanguage) return activeLanguage;
  return setLanguage(next);
}

// ── Declarative DOM pass ──────────────────────────────────────────────────

const ATTRIBUTE_BINDINGS = [
  ["[data-i18n-aria]", "i18nAria", "aria-label"],
  ["[data-i18n-title]", "i18nTitle", "title"],
  ["[data-i18n-placeholder]", "i18nPlaceholder", "placeholder"],
];

export function applyTranslations(root) {
  if (!root?.querySelectorAll) return;
  for (const element of root.querySelectorAll("[data-i18n]")) {
    const key = element.dataset?.i18n;
    if (key && hasKey(key)) element.textContent = t(key);
  }
  for (const [selector, datasetKey, attribute] of ATTRIBUTE_BINDINGS) {
    for (const element of root.querySelectorAll(selector)) {
      const key = element.dataset?.[datasetKey];
      if (key && hasKey(key)) element.setAttribute(attribute, t(key));
    }
  }
}

// `lang` on <html> must track the choice so the platform picks the right
// font/hyphenation rules; callers pass the document explicitly.
export function applyDocumentLanguage(documentRef) {
  if (!documentRef?.documentElement) return;
  documentRef.documentElement.lang = activeLanguage;
  documentRef.documentElement.dataset.uiLang = activeLanguage;
}
