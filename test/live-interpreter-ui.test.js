import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  INTERPRETER_MAX_PCM_BYTES,
  INTERPRETER_MAX_QUEUE_SECONDS,
  createInterpreterAudioRouter,
  decodeInterpreterPcm16,
} from "../public/live-interpreter-audio.js";
import { LIVE_INTERPRETER_LANGUAGE_OPTIONS } from "../public/subtitle-language-catalog.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Live Interpreter is a separate desktop surface with two explicit meeting modes", async () => {
  const html = await read("public/live-interpreter.html");

  assert.match(html, /<title>Live Interpreter \| NOVA<\/title>/u);
  assert.match(html, /id="mode-online"[^>]*aria-controls="online-panel"/u);
  assert.match(html, /id="mode-in-person"[^>]*aria-controls="in-person-panel"/u);
  assert.match(html, /id="online-panel"/u);
  assert.match(html, /id="in-person-panel"[^>]*hidden/u);
  assert.match(html, /상대방→나/u);
  assert.match(html, /나→상대방/u);
  assert.match(html, /내가 말하기→상대 언어/u);
  assert.match(html, /상대방 말하기→내 언어/u);
  assert.doesNotMatch(html, /subtitle|live call|coach/iu);
});

test("screen exposes 13 target languages, lane devices, transport, preflight, and latency", async () => {
  const [html, script] = await Promise.all([
    read("public/live-interpreter.html"),
    read("public/live-interpreter.js"),
  ]);

  assert.equal(LIVE_INTERPRETER_LANGUAGE_OPTIONS.length, 13);
  assert.deepEqual(
    LIVE_INTERPRETER_LANGUAGE_OPTIONS.map(({ code }) => code),
    ["es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it", "en"],
  );
  assert.match(script, /const TARGET_LANGUAGES = LIVE_INTERPRETER_LANGUAGE_OPTIONS/u);
  for (const id of [
    "user-language", "other-language", "online-system-input", "online-mic-input",
    "online-local-output", "online-virtual-output", "in-person-mic-input",
    "preflight-button", "start-button", "stop-button", "latency-value",
  ]) assert.match(html, new RegExp(`id="${id}"`, "u"), `missing ${id}`);
  assert.match(script, /enumerateDevices\(\)/u);
  assert.match(script, /getLiveInterpreterDevicePreflight/u);
  assert.match(script, /microphone:\s*\{[\s\S]*?available:[\s\S]*?deviceId:[\s\S]*?label:/u);
  assert.match(script, /systemAudio:[\s\S]*?method:\s*"display-capture"/u);
  assert.match(script, /virtualOutput:[\s\S]*?available:[\s\S]*?deviceId:[\s\S]*?label:/u);
  assert.match(html, /id="virtual-mic-confirmed"[^>]*type="checkbox"/u);
  assert.match(script, /startLiveInterpreter/u);
  assert.match(script, /stopLiveInterpreter/u);
  assert.match(script, /reconnectLiveInterpreter/u);
});

test("transcript log is accessible, safe, bounded, and follows newest content", async () => {
  const [html, script, shared] = await Promise.all([
    read("public/live-interpreter.html"),
    read("public/live-interpreter.js"),
    read("public/nova-transcript.js"),
  ]);

  assert.match(html, /id="transcript-log"[^>]*role="log"[^>]*aria-live="polite"/u);
  assert.match(html, /id="jump-to-latest"/u);
  assert.match(html, /id="connection-status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(html, /aria-pressed="false"/u);
  assert.match(script, /textContent\s*=/u);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/u);
  assert.match(script, /from "\/nova-transcript\.js"/u);
  assert.match(script, /createNovaTranscriptRenderer\(/u);
  assert.match(script, /transcriptRenderer\.moveToLatest\(\)/u);
  assert.match(shared, /MAX_TRANSCRIPT_ROWS\s*=\s*200/u);
  assert.match(shared, /scrollHeight\s*-\s*element\.clientHeight\s*-\s*element\.scrollTop/u);
});

test("Live Interpreter promotes each lane partial into its first committed row", async () => {
  const script = await read("public/live-interpreter.js");

  assert.match(script, /activeTranscriptRowIds/u);
  assert.match(script, /committedTranscriptRowIds/u);
  assert.match(script, /adaptInterpreterTranscript/u);
  assert.match(script, /activeTranscriptRowIds\.delete\(laneName\)/u);
  assert.doesNotMatch(script, /document\.createElement\("article"\)[\s\S]*?transcript-entry/u);
});

test("Live Interpreter lane promotion reuses one row per turn without collapsing later turns", async () => {
  const script = await read("public/live-interpreter.js");
  const start = script.indexOf("function transcriptId");
  const end = script.indexOf("function formatTime");
  assert.ok(start >= 0 && end > start);
  const updates = [];
  const context = {
    LANE_CODES: Object.freeze({ inbound: "INBOUND" }),
    state: {
      activeTranscriptRowIds: new Map(),
      committedTranscriptRowIds: new Map(),
      nextTranscriptSequence: 0,
    },
    transcriptRenderer: { update(entry) { updates.push(entry); } },
    formatTime() { return "09:30"; },
    Map,
    Object,
    String,
  };
  vm.runInNewContext(`${script.slice(start, end)}\nthis.helpers = { upsertPartialTranscript, upsertCommittedTranscript };`, context);

  context.helpers.upsertPartialTranscript({ lane: "INBOUND", inputTranscript: "Hel" });
  context.helpers.upsertPartialTranscript({ lane: "INBOUND", inputTranscript: "Hello" });
  context.helpers.upsertCommittedTranscript({ id: "record-1", lane: "INBOUND", sourceText: "Hello" });
  context.helpers.upsertCommittedTranscript({ id: "record-1", lane: "INBOUND", sourceText: "Hello" });
  context.helpers.upsertPartialTranscript({ lane: "INBOUND", inputTranscript: "Next" });
  context.helpers.upsertCommittedTranscript({ id: "record-2", lane: "INBOUND", sourceText: "Next" });

  assert.deepEqual(
    updates.map(({ id, status }) => [id, status]),
    [
      ["live-inbound-1", "partial"],
      ["live-inbound-1", "partial"],
      ["live-inbound-1", "final"],
      ["live-inbound-1", "final"],
      ["live-inbound-2", "partial"],
      ["live-inbound-2", "final"],
    ],
  );
});

test("audio router bounds PCM, requires an explicit output sink, and gates the matching input", async () => {
  const audioSource = await read("public/live-interpreter-audio.js");
  assert.equal(INTERPRETER_MAX_QUEUE_SECONDS, 4);
  assert.equal(INTERPRETER_MAX_PCM_BYTES, 256 * 1024);
  assert.match(audioSource, /typeof audio\.setSinkId !== "function"/u);
  assert.match(audioSource, /throw new Error\("선택한 출력 장치로 연결할 수 없습니다\."\)/u);
  assert.match(audioSource, /onPlaybackGate\(lane, active\)/u);
  assert.match(audioSource, /gate\(laneName, state, true\)/u);
  assert.match(audioSource, /gate\(laneName, state, false\)/u);
  assert.doesNotMatch(audioSource, /localStorage|indexedDB|sessionStorage/u);

  assert.throws(() => decodeInterpreterPcm16(new Uint8Array(3)), /PCM 길이/u);
  assert.throws(
    () => decodeInterpreterPcm16(new Uint8Array(INTERPRETER_MAX_PCM_BYTES + 2)),
    /PCM 크기/u,
  );

  const router = createInterpreterAudioRouter({
    createAudioContext: () => ({
      createMediaStreamDestination: () => ({ stream: {} }),
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
      createBuffer() { throw new Error("should not schedule before routing"); },
      createBufferSource() { throw new Error("should not schedule before routing"); },
      currentTime: 0,
      resume: async () => {},
      close: async () => {},
    }),
    createAudioElement: () => ({ play: async () => {}, pause() {} }),
  });
  await assert.rejects(() => router.configureLane("inbound", "device-id"), /출력 장치/u);
  assert.equal(router.enqueue("inbound", new Uint8Array([0, 0]), 24_000), false);

  let ended = () => {};
  const gates = [];
  const routed = createInterpreterAudioRouter({
    createAudioContext: () => ({
      createMediaStreamDestination: () => ({ stream: {} }),
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
      createBuffer: () => ({ duration: 0.1, getChannelData: () => new Float32Array(1) }),
      createBufferSource: () => ({
        addEventListener(_event, listener) { ended = listener; },
        connect() {}, disconnect() {}, start() {}, stop() {},
      }),
      currentTime: 0,
      resume: async () => {},
      close: async () => {},
    }),
    createAudioElement: () => ({
      play: async () => {}, pause() {}, setSinkId: async () => {},
    }),
    onPlaybackGate: (lane, active) => gates.push([lane, active]),
  });
  await routed.configureLane("inbound", "speaker-id");
  assert.equal(routed.enqueue("inbound", new Uint8Array([1, 0]), 24_000), true);
  assert.deepEqual(gates, [["inbound", true]]);
  ended();
  assert.deepEqual(gates, [["inbound", true], ["inbound", false]]);
});

test("snapshot envelopes and keyed lanes normalize without losing lane identity", async () => {
  const script = await read("public/live-interpreter.js");
  const start = script.indexOf("function unwrapSnapshot");
  const end = script.indexOf("function bindEvents", start);
  assert.ok(start >= 0 && end > start);
  const helpers = vm.runInNewContext(
    `${script.slice(start, end)}; ({ unwrapSnapshot, interpreterLaneEntries })`,
  );
  const snapshot = { state: "RUNNING" };
  assert.deepEqual(helpers.unwrapSnapshot({ ok: true, data: snapshot }), snapshot);
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.interpreterLaneEntries({ INBOUND: { state: "ACTIVE" }, OUTBOUND: { state: "ERROR" } }))),
    [
      { lane: "INBOUND", state: "ACTIVE" },
      { lane: "OUTBOUND", state: "ERROR" },
    ],
  );
});

test("NOVA visual constraints include Pretendard, token-only component colors, focus, and reduced motion", async () => {
  const [html, core, css] = await Promise.all([
    read("public/live-interpreter.html"),
    read("public/nova-core.css"),
    read("public/live-interpreter.css"),
  ]);

  assert.ok(html.indexOf('/nova-core.css') < html.indexOf('/live-interpreter.css'));
  assert.equal((core.match(/@font-face/gu) ?? []).length, 3);
  for (const weight of ["400", "500", "600"]) assert.match(core, new RegExp(`font-weight: ${weight}`, "u"));
  assert.doesNotMatch(core, /https?:\/\//u);
  for (const contract of ["nova-button", "nova-field", "nova-status-chip", "nova-segmented"]) {
    assert.match(core, new RegExp(`\\.${contract}\\b`, "u"));
  }
  assert.match(core, /min-height:\s*44px/u);
  assert.match(core, /\.nova-segmented > button\s*\{\s*min-height:\s*44px/u);
  assert.match(core, /:focus-visible/u);
  assert.match(core, /2px solid var\(--nova-system-default\)/u);
  assert.match(core, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(css, /background(?:-image)?:\s*linear-gradient/iu);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu);
});

test("setup stage exposes language and device preflight before execution", async () => {
  const [html, script] = await Promise.all([
    read("public/live-interpreter.html"),
    read("public/live-interpreter.js"),
  ]);
  assert.match(html, /id="preflight-checklist"[^>]*aria-label="실행 전 점검"/u);
  for (const check of ["languages", "microphone", "system", "blackhole"]) {
    assert.match(html, new RegExp(`data-preflight-check="${check}"[\\s\\S]*?data-preflight-status="${check}"`, "u"));
  }
  assert.match(html, /id="recovery-bar"[^>]*role="alert"[^>]*hidden/u);
  assert.match(html, /id="recovery-action"/u);
  assert.match(script, /updatePreflightCheck\("languages"/u);
  assert.match(script, /updatePreflightCheck\("microphone"/u);
  assert.match(script, /updatePreflightCheck\("system"/u);
  assert.match(script, /updatePreflightCheck\("blackhole"/u);
});

test("running session becomes a transcript-first Live Dock with a one-line settings summary", async () => {
  const [html, css, script] = await Promise.all([
    read("public/live-interpreter.html"),
    read("public/live-interpreter.css"),
    read("public/live-interpreter.js"),
  ]);
  assert.match(html, /id="live-settings-summary"[^>]*hidden/u);
  assert.ok(html.indexOf('class="transcript-column"') < html.indexOf('class="control-column"'));
  assert.match(css, /\.workspace\s*\{[^}]*grid-template-areas:\s*"preview settings"/u);
  assert.match(css, /\.interpreter-shell\.is-live \.workspace\s*\{\s*grid-template-columns:\s*minmax\(0, 66%\) minmax\(300px, 34%\)/u);
  assert.match(css, /\.interpreter-shell\.is-live \.config-strip\s*\{\s*display:\s*none/u);
  assert.match(css, /\.interpreter-shell\.is-live \.live-settings-summary\s*\{\s*display:\s*flex/u);
  assert.match(script, /classList\.toggle\("is-live", running\)/u);
  assert.match(script, /renderLiveSettingsSummary\(\)/u);
});

test("preflight and runtime failures map to immediate recovery actions", async () => {
  const script = await read("public/live-interpreter.js");
  const start = script.indexOf("const RECOVERY_PRESENTATION");
  const end = script.indexOf("function showRecovery", start);
  assert.ok(start >= 0 && end > start);
  const classifyRecovery = vm.runInNewContext(
    `${script.slice(start, end)}; classifyRecovery`,
  );
  assert.equal(classifyRecovery("MICROPHONE_PERMISSION_DENIED"), "permission");
  assert.equal(classifyRecovery("BLACKHOLE_NOT_FOUND"), "blackhole");
  assert.equal(classifyRecovery("AUDIO_DEVICE_MISSING"), "devices");
  assert.equal(classifyRecovery("SOCKET_RECONNECT_REQUIRED"), "reconnect");
  assert.equal(classifyRecovery("UNKNOWN_PROVIDER_FAILURE"), "reconnect");
  assert.match(script, /openScreenRecordingSettings/u);
  assert.match(script, /refreshDevices/u);
  assert.match(script, /reconnectLiveInterpreter/u);
});

test("online BlackHole failure stays closed with setup guidance while face-to-face stays independent", async () => {
  const script = await read("public/live-interpreter.js");

  assert.match(script, /온라인 통역에는 BlackHole 2ch가 필요합니다/u);
  assert.match(script, /Teams\/Zoom 마이크로 선택/u);
  assert.match(script, /설치 후 다시 검사/u);
  assert.match(script, /state\.mode !== "ONLINE" \|\| blackHole/u);
  assert.match(script, /state\.mode === "ONLINE" && !local\.hasBlackHole/u);
  assert.match(script, /state\.mode !== "ONLINE" \? "해당 없음"/u);
  assert.match(script, /mode === "IN_PERSON" && state\.recovery\.kind === "blackhole"[\s\S]*?clearRecovery\(\)/u);
});

test("dashboard reveals a keyboard launch entry only after the desktop feature gate passes", async () => {
  const [html, dashboard, css] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle-dashboard.js"),
    read("public/subtitle.css"),
  ]);
  assert.match(html, /<button id="open-live-interpreter"[^>]*type="button"[^>]*hidden/u);
  assert.match(html, /<span data-i18n="nav\.liveInterpreter">라이브 통역<\/span>/u);
  assert.doesNotMatch(html, /data-workspace-page="live-interpreter"|href="#live-interpreter/u);
  assert.match(css, /\.subtitle-app-rail nav button\s*\{[\s\S]*?min-height:\s*44px/u);

  const start = dashboard.indexOf("async function initializeDesktopLaunch");
  const end = dashboard.indexOf("// Live Call feature flag", start);
  assert.ok(start >= 0 && end > start);
  const button = {
    disabled: false,
    hidden: true,
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute() {},
    removeAttribute() {},
  };
  let opens = 0;
  const sandbox = {
    document: { getElementById: () => button },
    window: {
      realtimeNoelDesktop: {
        getLiveInterpreterEnabled: async () => ({ ok: true, data: true }),
        openLiveInterpreter: async () => { opens += 1; return { ok: true }; },
      },
    },
  };
  const initialize = vm.runInNewContext(`${dashboard.slice(start, end)}; initializeLiveInterpreterLaunch`, sandbox);
  await initialize();
  assert.equal(button.hidden, false);
  await button.listeners.get("click")();
  assert.equal(opens, 1);

  const disabledButton = { ...button, hidden: true, listeners: new Map() };
  sandbox.document.getElementById = () => disabledButton;
  sandbox.window.realtimeNoelDesktop.getLiveInterpreterEnabled = async () => ({ ok: true, data: false });
  await initialize();
  assert.equal(disabledButton.hidden, true);
  assert.equal(disabledButton.listeners.size, 0);
});

test("compact desktop layout keeps both language selects readable at 880px", async () => {
  const css = await read("public/live-interpreter.css");
  const compactLayout = css.match(/@media \(max-width: 1040px\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
  assert.match(
    compactLayout,
    /\.config-strip\s*\{\s*grid-template-columns:\s*minmax\(128px, 1fr\) 44px minmax\(128px, 1fr\) auto;/u,
  );
  assert.match(compactLayout, /\.segmented-control\s*\{\s*grid-column:\s*1 \/ -1;/u);
  assert.doesNotMatch(compactLayout, /grid-template-columns:\s*1fr 1fr 44px 1fr/u);
});

test("minimum 420px dock stacks safely and keeps the live transcript at 66 percent", async () => {
  const css = await read("public/live-interpreter.css");
  const start = css.indexOf("@media (max-width: 720px)");
  const end = css.indexOf("@media (hover: hover)", start);
  assert.ok(start >= 0 && end > start);
  const dockLayout = css.slice(start, end);

  assert.match(dockLayout, /\.workspace\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?grid-template-areas:\s*"preview" "settings";[\s\S]*?grid-template-rows:\s*minmax\(180px, 60%\) minmax\(0, 40%\)/u);
  assert.match(dockLayout, /\.config-strip\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 44px minmax\(0, 1fr\)/u);
  assert.match(dockLayout, /\.interpreter-shell\.is-live \.workspace\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?grid-template-rows:\s*minmax\(0, 66%\) minmax\(150px, 34%\)/u);
  assert.match(dockLayout, /\.control-column\s*\{[^}]*overflow:\s*auto;/u);
  assert.match(dockLayout, /\.mode-panel\s*\{[^}]*flex:\s*0 0 auto;[^}]*overflow:\s*visible;/u);
  assert.doesNotMatch(dockLayout, /minmax\((?:560|640)px/u);
});

test("setup controls use flat SEED list rows instead of nested cards", async () => {
  const css = await read("public/live-interpreter.css");
  assert.match(css, /\.lane-card\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-bottom:\s*1px solid var\(--nova-surface-hairline\);[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/u);
  assert.doesNotMatch(css, /\.lane-card\s*\{[^}]*background:\s*var\(--nova-surface-layered\)/u);
});

test("grouped dashboard rail uses semantic NOVA tokens and accessible interaction geometry", async () => {
  const css = await read("public/subtitle.css");
  assert.match(css, /\.rail-nav-section\s*\{[\s\S]*?gap:\s*var\(--nova-gap-4\)/u);
  assert.match(css, /\.rail-nav-section-label\s*\{[\s\S]*?color:\s*var\(--nova-text-disabled\)[\s\S]*?font-size:\s*var\(--nova-t8\)/u);
  assert.match(css, /\.rail-nav-icon\s*\{[\s\S]*?width:\s*20px;[\s\S]*?color:\s*currentColor/u);
  assert.match(css, /\.rail-nav-section a,[\s\S]*?\.rail-nav-section button\s*\{[\s\S]*?min-height:\s*44px/u);
  assert.match(css, /\.rail-nav-section a:focus-visible,[\s\S]*?outline:\s*2px solid var\(--nova-blue\)/u);
  assert.doesNotMatch(css, /\.subtitle-app-rail nav button\s*\{[^}]*min-height:\s*36px/u);
});

test("records filters and coaching history use NOVA semantics with 44px fields", async () => {
  const css = await read("public/subtitle.css");
  for (const className of [
    "records-filter-bar", "records-filter-field", "records-filter-search", "records-filter-selects",
    "session-detail-coach", "session-coach-group", "session-coach-list", "session-coach-entry", "session-coach-empty",
  ]) assert.match(css, new RegExp(`\\.${className}\\b`, "u"), `missing ${className}`);
  assert.match(css, /\.records-filter-field input,[\s\S]*?\.records-filter-field select\s*\{[\s\S]*?min-height:\s*44px/u);
  assert.match(css, /\.records-filter-field input:focus-visible,[\s\S]*?outline:\s*2px solid var\(--nova-blue\)/u);
  assert.match(css, /\.session-coach-group\.is-used\s*\{\s*border-left-color:\s*var\(--nova-status-ok\)/u);
  assert.match(css, /\.session-coach-group\.is-unused\s*\{\s*border-left-color:\s*var\(--nova-yellow\)/u);
  assert.doesNotMatch(css.slice(css.indexOf(".records-filter-bar"), css.indexOf(".records-cal-toolbar")), /#[0-9a-f]{3,8}\b/iu);
});

test("online capture opens under user activation before the remote interpreter starts", async () => {
  const script = await read("public/live-interpreter.js");
  const start = script.indexOf("async function startSession()");
  const end = script.indexOf("async function stopSession()", start);
  const startSession = script.slice(start, end);
  const systemCapture = startSession.indexOf('openCapture("system"');
  const microphoneCapture = startSession.indexOf('openCapture("mic"');
  const remoteStart = startSession.indexOf("bridge.startLiveInterpreter");
  const runningGate = startSession.indexOf("state.isRunning = true");
  assert.ok(systemCapture >= 0 && microphoneCapture >= 0);
  assert.ok(systemCapture < remoteStart, "system capture must retain the launch click before remote socket startup");
  assert.ok(microphoneCapture < remoteStart, "microphone capture must settle before remote socket startup");
  assert.ok(remoteStart < runningGate, "captured PCM must remain gated until remote startup succeeds");
  assert.match(startSession, /Promise\.allSettled\(\[[\s\S]*?openCapture\("system"[\s\S]*?openCapture\("mic"/u);
  assert.match(startSession, /catch \(error\) \{[\s\S]*?await stopAllCaptures\(\);[\s\S]*?await audioRouter\.close\(\);/u);
});

test("backend lane states always render as Korean labels with semantic tones", async () => {
  const script = await read("public/live-interpreter.js");
  const start = script.indexOf("const LANE_STATE_PRESENTATION");
  const end = script.indexOf("function applySnapshot", start);
  assert.ok(start >= 0 && end > start);
  const presentLaneState = vm.runInNewContext(
    `${script.slice(start, end)}; presentLaneState`,
  );
  assert.deepEqual(JSON.parse(JSON.stringify([
    presentLaneState("ACTIVE"),
    presentLaneState("CONNECTING"),
    presentLaneState("CLOSING"),
    presentLaneState("CLOSED"),
    presentLaneState("IDLE"),
    presentLaneState("ERROR"),
    presentLaneState("INTERNAL_UNKNOWN"),
  ])), [
    { label: "연결됨", tone: "ok" },
    { label: "연결 중", tone: "warn" },
    { label: "종료 중", tone: "warn" },
    { label: "대기", tone: "neutral" },
    { label: "대기", tone: "neutral" },
    { label: "오류", tone: "error" },
    { label: "대기", tone: "neutral" },
  ]);
});
