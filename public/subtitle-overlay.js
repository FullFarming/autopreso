const DEFAULT_SUBTITLE = {
  fontFamily: "Arial, Helvetica, sans-serif",
  translationFontSize: 38,
  sourceFontSize: 36,
  displayMode: "translation_only",
  showSourceText: false,
  position: "bottom-center",
  // Per-language overlay position; falls back to `position` when a language is
  // unset. Lets English sit at the bottom while Japanese sits at the top, etc.
  subtitlePositions: {},
  maxWidth: 1500,
  opacity: 0.92,
  maxSubtitleLines: 2,
  verticalOffset: 48,
  outputMode: "captions",
};

// Movie-style expiry: live hypotheses stay visible while translation is in
// progress. The 3s/5s policy starts only after a sentence has committed.
// A subtitle should REMAIN readable through a silence gap and only be replaced
// when new speech actually arrives (new content in the lane, or a reverse-lane
// switch). So the idle linger is generous — it only clears after a long, genuine
// pause; continuous speech replaces it well before these fire.
const SUBTITLE_FINAL_LINGER_MS = 20000;
const SUBTITLE_PREVIOUS_SENTENCE_LINGER_MS = 3000;
const SUBTITLE_LIVE_STALE_MS = 15000;
const INPUT_ACTIVE_GRACE_MS = 1600;
const LIVE_SUBTITLE_RECHECK_MS = 500;
// Retain one spare roll-up line internally while the visible product default
// stays at two lines. The user can raise the cap up to MAX_SUBTITLE_LINES_CAP.
const MAX_SUBTITLE_QUEUE_LINES = 3;
const MAX_SUBTITLE_LINES_CAP = 8;

// The visible line budget = the user's maxSubtitleLines setting, clamped. This
// is the on-screen subtitle height control (CSS caps height to this many lines).
function maxSubtitleLines() {
  const n = Number(settings.maxSubtitleLines);
  return Math.min(MAX_SUBTITLE_LINES_CAP, Math.max(1, Number.isFinite(n) ? Math.round(n) : MAX_SUBTITLE_QUEUE_LINES));
}
const PREDICTED_SUBTITLE_MIN_CHARS = 4;
// Lowered 2026-06-21 (with the robust transcript merge): show the first Gemini
// translation sooner instead of waiting for a long accumulation.
const GEMINI_PREDICTED_SUBTITLE_MIN_CHARS = 10;

// Per-viewer channel: `?lang=ja` (comma list allowed, e.g. `?lang=en,ja`)
// subscribes this overlay to only those language lanes — the server filters
// the stream per client and answers with a snapshot of the current live lanes
// so a late-joining viewer paints immediately. No parameter = legacy behavior
// (every configured language renders).
const channelLanguages = (new URLSearchParams(location.search).get("lang") || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

function isChannelLanguage(targetLanguage) {
  return channelLanguages.length === 0 || channelLanguages.includes(String(targetLanguage || "").toLowerCase());
}

function isAudioOnlyOutput() {
  return settings.outputMode === "audio";
}

const overlay = document.getElementById("subtitle-overlay");
const zones = {
  "top-center": overlay.querySelector('[data-zone="top-center"]'),
  "middle-center": overlay.querySelector('[data-zone="middle-center"]'),
  "bottom-center": overlay.querySelector('[data-zone="bottom-center"]'),
};
let settings = { ...DEFAULT_SUBTITLE };
let lastSubtitleAt = 0;
let inputActiveUntil = 0;

// Direction (= spoken language) tracking. With one translation channel per target
// language, a language switch makes the OLD direction's channel emit a few more
// translation-latency "tail" partials AFTER the new direction has already taken
// over. Each render clears the reverse lane, so those tails ping-pong the two
// lanes — the user sees "한국어·영어가 동시에 뜨고 섞임". We drop a tail: a message
// whose source is the direction we JUST switched away from, arriving within this
// window of the switch. A genuine switch (a source different from the previous, or
// one arriving after the window) is always accepted.
const SUBTITLE_DIRECTION_TAIL_MS = 1200;
let activeSourceLanguage = null;
let previousSourceLanguage = null;
let lastDirectionSwitchAt = 0;
// Sentence-level lock: once a direction is showing a sentence, a switch to the other
// direction is deferred until that sentence ENDS (terminal punctuation / a commit) or
// the active direction goes idle for SUBTITLE_DIRECTION_TAIL_MS (the speaker paused = a
// sentence boundary). This stops an in-progress subtitle from being converted to the
// other language mid-sentence ("문장이 끝나기 전에 한글→영어로 바뀌면 안 됨").
let activeDirectionLastAt = 0;
let activeDirectionSentenceClosed = true;
const SENTENCE_END_RE = /[.!?。！？…]["'”’)\]]*\s*$/;

// One lane per target language: its own box, its own committed-line queue, and
// its own linger timer so each language appears and clears independently.
const lanes = new Map();
let snapshotSeqFloor = -1;

function subtitleLingerMs(mode = "final") {
  if (mode === "live") return SUBTITLE_LIVE_STALE_MS;
  return SUBTITLE_FINAL_LINGER_MS;
}

function markInputActive() {
  inputActiveUntil = Date.now() + INPUT_ACTIVE_GRACE_MS;
}

function isInputActive() {
  return Date.now() < inputActiveUntil;
}

function handleInputStatus(message) {
  if (message.status === "signal") markInputActive();
}

// Live socket reference for overlay-initiated controls (double-click restart).
let activeSocket = null;

connect();
initOverlayRestartControls();

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  activeSocket = ws;
  ws.addEventListener("open", () => {
    if (channelLanguages.length) ws.send(JSON.stringify({ type: "subtitle:subscribe", languages: channelLanguages }));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "settings" && message.settings?.subtitle) applySettings(message.settings.subtitle);
    if (message.type === "subtitle:snapshot") {
      if (isAudioOnlyOutput()) {
        clearSubtitle();
        return;
      }
      if (Number.isSafeInteger(message.seq)) snapshotSeqFloor = Math.max(snapshotSeqFloor, message.seq);
      for (const line of Array.isArray(message.lanes) ? message.lanes : []) {
        if (!isChannelLanguage(line.targetLanguage)) continue;
        if (line.type === "subtitle:committed") renderCommittedSubtitle(line, true);
        else renderPredictedSubtitle(line, true);
      }
      return;
    }
    // The server already filters subscribed channels; this client-side gate
    // covers the un-subscribed race right after connect.
    if (message.targetLanguage && !isChannelLanguage(message.targetLanguage)) return;
    if (message.type === "subtitle:clear") clearSubtitleLane(message.targetLanguage);
    if (message.type === "subtitle:partial" && !isAudioOnlyOutput()) renderPredictedSubtitle(message);
    if (message.type === "subtitle:committed" && !isAudioOnlyOutput()) renderCommittedSubtitle(message);
    if (message.type === "subtitle:input-status") {
      handleInputStatus(message);
      return;
    }
    if (message.type === "subtitle:status") {
      updateStatusIndicator(message.status);
      if (message.status === "hearing") markInputActive();
      if (message.status === "idle") clearSubtitle();
      return;
    }
  });
  ws.addEventListener("close", () => {
    clearSubtitle();
    setTimeout(connect, 1500);
  });
  ws.addEventListener("error", () => {
    clearSubtitle();
  });
}

// ---- Double-click-to-restart ----------------------------------------------
// When subtitles stall (backed-up queue, frozen session, rough language
// switching), the fastest recovery is a session restart — double-clicking the
// subtitle itself triggers the same "restart" control the floating controller
// sends; the dashboard performs the actual stop/start.
//
// The desktop overlay window is click-through (setIgnoreMouseEvents with
// forward: true), so the page only ever receives mouse MOVE events. While the
// cursor hovers a visible subtitle box we ask the main process to make the
// window interactive (clicks land on the page); leaving the box restores
// click-through so presentations underneath stay fully usable. In a plain
// browser tab (OBS/web viewers) the dblclick works natively.
let overlayPointerInteractive = false;
const RESTART_TOAST_MS = 2500;
let restartToastElement = null;
let restartToastTimer = null;

function initOverlayRestartControls() {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("mousemove", (event) => {
    const over = Boolean(subtitleBoxUnderPoint(event.clientX, event.clientY));
    if (over === overlayPointerInteractive) return;
    overlayPointerInteractive = over;
    for (const lane of lanes.values()) lane.box.classList?.toggle?.("interactive", over);
    void window.realtimeNoelDesktop?.setOverlayInteractive?.(over);
  });
  window.addEventListener("dblclick", () => requestSubtitleRestart());
}

function subtitleBoxUnderPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const lane of lanes.values()) {
    if (lane.box.hidden || typeof lane.box.getBoundingClientRect !== "function") continue;
    const rect = lane.box.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return lane.box;
  }
  return null;
}

function requestSubtitleRestart() {
  if (activeSocket && activeSocket.readyState === 1) {
    activeSocket.send(JSON.stringify({ type: "subtitle:control", command: "restart" }));
    showRestartToast("자막 세션을 다시 시작합니다…");
  } else {
    showRestartToast("서버 연결을 기다리는 중입니다…");
  }
}

function showRestartToast(text) {
  if (!overlay || typeof document.createElement !== "function") return;
  if (!restartToastElement) {
    restartToastElement = document.createElement("div");
    restartToastElement.className = "subtitle-restart-toast";
    overlay.append(restartToastElement);
  }
  restartToastElement.textContent = text;
  restartToastElement.hidden = false;
  if (restartToastTimer) clearTimeout(restartToastTimer);
  restartToastTimer = setTimeout(() => {
    restartToastTimer = null;
    if (restartToastElement) restartToastElement.hidden = true;
  }, RESTART_TOAST_MS);
}
// ---- Pipeline status indicator ---------------------------------------------
// Small badge so a viewer can tell "stalled" apart from "quiet": shown while
// the pipeline is reconnecting / auto-recovering / shedding audio under
// network backpressure; hidden the moment it is healthy again.
const STATUS_INDICATOR_LABELS = {
  reconnecting: "자막 재연결 중…",
  recovering: "자막 복구 중…",
  degraded: "네트워크 지연 — 실시간 유지 중",
};
const STATUS_INDICATOR_MAX_MS = 15000;
let statusIndicatorElement = null;
let statusIndicatorTimer = null;

function updateStatusIndicator(status) {
  const label = STATUS_INDICATOR_LABELS[status];
  if (!label) {
    // Any non-problem status (listening/api_ready/idle/hearing…) clears it.
    if (statusIndicatorElement) statusIndicatorElement.hidden = true;
    if (statusIndicatorTimer) { clearTimeout(statusIndicatorTimer); statusIndicatorTimer = null; }
    return;
  }
  if (!overlay || typeof document.createElement !== "function") return;
  if (!statusIndicatorElement) {
    statusIndicatorElement = document.createElement("div");
    statusIndicatorElement.className = "subtitle-status-indicator";
    overlay.append(statusIndicatorElement);
  }
  statusIndicatorElement.textContent = label;
  statusIndicatorElement.hidden = false;
  // Never let a stale badge stick around if the healthy status got lost.
  if (statusIndicatorTimer) clearTimeout(statusIndicatorTimer);
  statusIndicatorTimer = setTimeout(() => {
    statusIndicatorTimer = null;
    if (statusIndicatorElement) statusIndicatorElement.hidden = true;
  }, STATUS_INDICATOR_MAX_MS);
}
// ---------------------------------------------------------------------------

function laneKey(targetLanguage) {
  return String(targetLanguage || "target");
}

function positionForLanguage(targetLanguage) {
  const perLanguage = settings.subtitlePositions?.[laneKey(targetLanguage)];
  const position = perLanguage || settings.position || "bottom-center";
  return zones[position] ? position : "bottom-center";
}

function ensureLane(targetLanguage) {
  const key = laneKey(targetLanguage);
  let lane = lanes.get(key);
  if (!lane) {
    const box = document.createElement("div");
    box.className = "subtitle-box";
    box.hidden = true;
    const source = document.createElement("div");
    source.className = "source-line";
    const translation = document.createElement("div");
    translation.className = "translation-line";
    // Inner wrapping word container. Words are appended incrementally (never
    // wholesale-replaced) so already-shown words keep their DOM node and layout —
    // broadcast-caption stability: text doesn't reflow/jump as each new word
    // streams in. The outer .translation-line bottom-anchors + clips this flow so
    // the newest line stays visible and older lines roll off the top.
    const flow = document.createElement("div");
    flow.className = "subtitle-flow";
    translation.append(flow);
    box.append(source, translation);
    lane = { key, box, source, translation, flow, lines: [], predicted: "", predictedState: "partial", sourceLines: [], timer: null, trimTimer: null, position: null, partial: false, lastSeq: -1, lastEventType: "", lastEventText: "", lastCommittedText: "" };
    lanes.set(key, lane);
  }
  const position = positionForLanguage(targetLanguage);
  if (lane.position !== position) {
    const previous = lane.position;
    zones[position].append(lane.box);
    lane.position = position;
    // Membership of both the old and new zone changed, so their crowding (and
    // thus each lane's line budget) needs recomputing.
    if (previous) reflowZone(previous);
  }
  return lane;
}

// How many languages are ASSIGNED to a zone — derived from the configured
// translation languages + their positions, NOT from whichever lane happens to
// have text at this instant. Using a stable count is critical: a content-based
// count flips 2↔1 as each language's subtitle appears and clears, which made
// every box's line budget (and height) oscillate — the "깜빡깜빡 줄었다 늘었다"
// flicker. This only changes when the language config changes.
function languagesAssignedToZone(position) {
  const configuredAll = Array.isArray(settings.translationLanguages) && settings.translationLanguages.length
    ? settings.translationLanguages
    : null;
  // A single-language channel only ever renders its own lanes, so crowding is
  // computed from the subscribed subset — a lone lane keeps the full budget.
  const configured = configuredAll && channelLanguages.length
    ? configuredAll.filter((language) => isChannelLanguage(language))
    : configuredAll;
  if (configured) {
    let count = 0;
    for (const language of configured) {
      if (positionForLanguage(language) === position) count += 1;
    }
    return Math.max(1, count);
  }
  // Before settings arrive, fall back to existing lanes at the position
  // (still stable — lanes persist once created, regardless of current text).
  let count = 0;
  for (const lane of lanes.values()) {
    if (lane.position === position) count += 1;
  }
  return Math.max(1, count);
}

// A lone language keeps the full line budget; when languages share a zone each
// shrinks so the stacked boxes stay compact and never collide. The budget is
// stable per language config, so it never flickers as subtitles come and go.
function visibleLineLimitFor(lane) {
  const base = maxSubtitleLines();
  const sharing = languagesAssignedToZone(lane.position);
  if (sharing <= 1) return base;
  return Math.max(1, Math.ceil(base / sharing));
}

// Re-render every lane in a zone so their line budgets reflect current crowding.
function reflowZone(position) {
  for (const lane of lanes.values()) {
    if (lane.position === position) renderLane(lane);
  }
}

function clearSubtitle() {
    // A full clear / session reset starts a fresh direction history.
    activeSourceLanguage = null;
    previousSourceLanguage = null;
    lastDirectionSwitchAt = 0;
    activeDirectionLastAt = 0;
    activeDirectionSentenceClosed = true;
    for (const lane of lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
      if (lane.trimTimer) clearTimeout(lane.trimTimer);
      lane.timer = null;
      lane.trimTimer = null;
    lane.lines = [];
    lane.predicted = "";
      lane.predictedState = "partial";
    lane.sourceLines = [];
      lane.partial = false;
      renderLane(lane);
  }
}

function clearSubtitleLane(targetLanguage) {
  const lane = lanes.get(laneKey(targetLanguage));
  if (!lane) return;
  if (lane.timer) clearTimeout(lane.timer);
  if (lane.trimTimer) clearTimeout(lane.trimTimer);
  lane.timer = null;
  lane.trimTimer = null;
  lane.lines = [];
  lane.predicted = "";
  lane.predictedState = "partial";
  lane.sourceLines = [];
  lane.partial = false;
  reflowZone(lane.position);
}

// When the spoken (source) language switches, the lane that translates INTO
// that language is now showing the reverse direction and is stale — e.g. after
// "Korean→English" the EN lane holds English, then the speaker switches to
// English (source=en) and the KO lane shows Korean; without this the old
// English would linger beside the new Korean ("영어 원문과 한글 병기"). Clearing
// the lane keyed by the new source language removes that overlap.
function clearStaleReverseLane(message) {
  const sourceLanguage = message.sourceLanguage;
  if (!sourceLanguage) return;
  if (laneKey(sourceLanguage) === laneKey(message.targetLanguage)) return;
  if (lanes.has(laneKey(sourceLanguage))) clearSubtitleLane(sourceLanguage);
}

// Decide whether an incoming subtitle's direction should drive the display, or be
// dropped as the just-superseded direction's latency tail (see SUBTITLE_DIRECTION_TAIL_MS).
function acceptDirection(message) {
  const src = message.sourceLanguage;
  if (!src) return true;                       // no direction info → never gate
  const now = Date.now();
  const text = String(message.translatedText ?? "");
  const closesSentence = message.type === "subtitle:committed" || SENTENCE_END_RE.test(text.trim());
  if (activeSourceLanguage === null) {
    activeSourceLanguage = src; lastDirectionSwitchAt = now;
    activeDirectionLastAt = now; activeDirectionSentenceClosed = closesSentence;
    return true;
  }
  if (src === activeSourceLanguage) {
    // Continuation of the active direction — track whether its sentence is open/closed.
    activeDirectionLastAt = now;
    activeDirectionSentenceClosed = closesSentence;
    return true;
  }
  // A different source than the active direction. If it matches the direction we
  // JUST switched away from and lands within the tail window, it's the old channel's
  // trailing translation — drop it so it can't wipe/ping-pong the new lane.
  if (src === previousSourceLanguage && (now - lastDirectionSwitchAt) < SUBTITLE_DIRECTION_TAIL_MS) return false;
  // SENTENCE LOCK: hold the switch until the active direction's current sentence has
  // ended (terminal punctuation / commit) or it has gone idle (a pause = sentence
  // boundary). Until then the in-progress subtitle keeps its language.
  if (!activeDirectionSentenceClosed && (now - activeDirectionLastAt) < SUBTITLE_DIRECTION_TAIL_MS) return false;
  // The active sentence is finished — accept the switch.
  previousSourceLanguage = activeSourceLanguage;
  activeSourceLanguage = src;
  lastDirectionSwitchAt = now;
  activeDirectionLastAt = now;
  activeDirectionSentenceClosed = closesSentence;
  return true;
}

// ── Live Call speaker identity badge ────────────────────────────────────────
// Participant (Speak) captions arrive with structured identity instead of a
// "Name:" text prefix; a pill above the caption zone shows who is talking
// (이름 · 부서 · 직급) and fades once their lines stop.
let liveCallSpeakerBadge = null;
let liveCallSpeakerBadgeTimer = null;
function showLiveCallSpeakerBadge(message, lane) {
  const speaker = message.liveCallSpeaker;
  const name = String(speaker?.name ?? "").trim();
  if (!name) return;
  const text = [name, String(speaker?.department ?? "").trim(), String(speaker?.jobTitle ?? "").trim()]
    .filter(Boolean)
    .join(" · ");
  if (!liveCallSpeakerBadge) {
    liveCallSpeakerBadge = document.createElement("div");
    liveCallSpeakerBadge.className = "live-call-speaker-badge";
    liveCallSpeakerBadge.style.cssText = [
      "align-self: center",
      "margin: 0 auto 10px",
      "padding: 7px 16px",
      "border-radius: 9999px",
      "background: rgba(16, 17, 22, 0.86)",
      "box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.16) inset",
      "color: #FFFFFF",
      "font-size: 0.42em",
      "font-weight: 600",
      "line-height: 1.2",
      "letter-spacing: 0.01em",
      "max-width: 82%",
      "overflow: hidden",
      "text-overflow: ellipsis",
      "white-space: nowrap",
      "pointer-events: none",
      "width: fit-content",
    ].join(";");
  }
  liveCallSpeakerBadge.textContent = text;
  const zone = zones[lane.position] ?? zones["bottom-center"];
  if (liveCallSpeakerBadge.parentElement !== zone) zone?.prepend(liveCallSpeakerBadge);
  liveCallSpeakerBadge.hidden = false;
  if (liveCallSpeakerBadgeTimer !== null) clearTimeout(liveCallSpeakerBadgeTimer);
  liveCallSpeakerBadgeTimer = setTimeout(() => {
    if (liveCallSpeakerBadge) liveCallSpeakerBadge.hidden = true;
  }, 5_000);
}

function renderCommittedSubtitle(message, fromSnapshot = false) {
  if (isAudioOnlyOutput()) return;
  const lane = ensureLane(message.targetLanguage);
  if (!acceptLaneEvent(lane, message, fromSnapshot)) return;
  if (!acceptDirection(message)) return;
  if (message.liveCallSpeaker) showLiveCallSpeakerBadge(message, lane);
  clearStaleReverseLane(message);
  const parts = splitSubtitleDisplayParts(message.translatedText);
  const finalParts = parts.length > 0 ? parts : [stripSubtitlePrefix(message.translatedText)].filter(Boolean);
  if (finalParts.length === 0) return;
  const hadCommittedLines = lane.lines.length > 0;
  lane.predicted = "";
  for (const part of finalParts) {
    const prev = lane.lines[lane.lines.length - 1];
    // Dedup by NORMALIZED text so a sentence re-emitted with only a trailing
    // punctuation/space difference ("…있으니까" vs "…있으니까.") is not stacked
    // as a second identical line.
    if (!prev || normalizeForDedup(prev) !== normalizeForDedup(part)) lane.lines.push(part);
  }
  lane.lines = lane.lines.slice(-maxSubtitleLines());
  lane.partial = false;
  if (hadCommittedLines && lane.lines.length > finalParts.length) armPreviousSentenceTrim(lane, finalParts.length);
  reflowZone(lane.position);
  armLinger(lane, "final");
}

function renderPredictedSubtitle(message, fromSnapshot = false) {
  if (isAudioOnlyOutput()) return;
  if (!shouldRenderPredictedSubtitle(message)) return;
  const lane = ensureLane(message.targetLanguage);
  if (!acceptLaneEvent(lane, message, fromSnapshot)) return;
  if (!acceptDirection(message)) return;
  // A new live hypothesis for direction X→Y means the speaker is currently
  // speaking X, so the reverse Y→X lane is stale and must clear NOW — not wait
  // for the next COMMITTED line. Without this, when the speaker switches
  // languages the previous direction's subtitle lingers beside the new one
  // ("양방향 자막이 동시에 떠 있음"), and with a per-language zone layout the two
  // sit in different zones so neither replaces the other.
  clearStaleReverseLane(message);
  if (message.liveCallSpeaker) showLiveCallSpeakerBadge(message, lane);
  lane.predicted = stripSubtitlePrefix(message.translatedText);
  lane.predictedState = "partial";
  lane.partial = true;
  reflowZone(lane.position);
  armLinger(lane, "live");
}

function armLinger(lane, mode = "final") {
  lastSubtitleAt = Date.now();
  if (lane.timer) clearTimeout(lane.timer);
  lane.timer = setTimeout(() => {
    // A live hypothesis stays alive only by RECEIVING new content: every
    // partial/commit re-arms this timer, so an actively-updating lane never
    // expires. Once updates stop for the full live window the lane clears —
    // even while system audio keeps the global input "active". The old global
    // isInputActive() re-arm kept a stale lane on screen forever whenever audio
    // never paused ("영어 자막이 무한정 떠 있음").
      lane.timer = null;
      if (lane.trimTimer) clearTimeout(lane.trimTimer);
      lane.trimTimer = null;
    lane.lines = [];
    lane.predicted = "";
      lane.predictedState = "partial";
    lane.sourceLines = [];
    lane.partial = false;
    // The zone just got less crowded — let any remaining lane reclaim lines.
    reflowZone(lane.position);
  }, subtitleLingerMs(mode));
}

function armPreviousSentenceTrim(lane, keepCount) {
  if (lane.trimTimer) clearTimeout(lane.trimTimer);
  lane.trimTimer = setTimeout(() => {
    lane.trimTimer = null;
    lane.lines = lane.lines.slice(-keepCount);
    reflowZone(lane.position);
  }, SUBTITLE_PREVIOUS_SENTENCE_LINGER_MS);
}


// Normalize for duplicate detection: collapse whitespace, drop trailing
// punctuation, lowercase — so "Hello there." and "hello there" (or a re-emitted
// Korean sentence with/without its period) count as the same line.
function normalizeForDedup(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/[.!?。！？…\s]+$/u, "")
    .trim()
    .toLowerCase();
}

function normalizeEventText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function acceptLaneEvent(lane, message, fromSnapshot) {
  const seq = Number.isSafeInteger(message.seq) ? message.seq : null;
  const eventText = normalizeEventText(message.translatedText);
  const committedText = normalizeForDedup(message.translatedText);
  if (!eventText) return false;
  if (!fromSnapshot && seq !== null && (seq <= snapshotSeqFloor || seq <= lane.lastSeq)) return false;
  if (lane.lastEventType === message.type && lane.lastEventText === eventText) return false;
  if (message.type === "subtitle:committed" && lane.lastCommittedText === committedText) return false;
  if (seq !== null) lane.lastSeq = Math.max(lane.lastSeq, seq);
  lane.lastEventType = message.type;
  lane.lastEventText = eventText;
  if (message.type === "subtitle:committed") lane.lastCommittedText = committedText;
  return true;
}

function renderLane(lane) {
  const predictedState = lane.predictedState || "partial";
  const committedNorm = new Set(lane.lines.map(normalizeForDedup));
  const predictedParts = splitSubtitleDisplayParts(lane.predicted)
    .filter((text) => !committedNorm.has(normalizeForDedup(text)));
  // One continuous WORD stream (committed lines first, then the live predicted
  // tail) — NO forced sentence line breaks; text flows and wraps naturally like
  // YouTube live captions. Rendering words (not whole blocks) keeps already-shown
  // text perfectly still while new words append.
  const tokens = [];
  for (const text of lane.lines) {
    for (const word of tokenizeWords(text)) tokens.push({ word, state: "committed" });
  }
  for (const text of predictedParts) {
    for (const word of tokenizeWords(text)) tokens.push({ word, state: predictedState });
  }
  const limit = visibleLineLimitFor(lane);
  // Match the box's visual line-clamp to its line budget (max lines on screen).
  lane.box.style.setProperty("--subtitle-line-clamp", String(limit));
  reconcileWords(lane, tokens);
  // Translation-only: the source ("원문") line was removed — only the translated
  // subtitle is ever rendered, so the source can never appear alongside it.
  lane.source.textContent = "";
  lane.source.hidden = true;
  // Reveal the box BEFORE measuring roll-up — a hidden box has zero layout
  // metrics, so updateRollUp must run while it's visible to compute the overflow.
  lane.box.hidden = tokens.length === 0;
  lane.box.classList.toggle("partial", tokens.some((entry) => entry.state === "partial"));
  // Reset the roll-up to the top ONLY when this is a fresh subtitle generation:
  // the lane went empty, or the leading word changed (a new utterance replaced the
  // old text). Within one growing/revising generation the head word is stable, so
  // updateRollUp stays monotonic and never bounces the block back down.
  const headWord = tokens.length ? tokens[0].word : null;
  if (tokens.length === 0 || headWord !== lane.rollHeadWord) lane.rollOffset = 0;
  lane.rollHeadWord = headWord;
  updateRollUp(lane);
}

function tokenizeWords(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean);
}

// Append-only reconciliation: keep the DOM node of every token (word or
// sentence break) that is unchanged from the previous render, then append only
// the new trailing tokens. The browser never re-lays-out stable text, so
// already-shown words don't move as new ones stream in (broadcast stability),
// and sentence breaks are inserted as <br> so a finished sentence starts fresh.
function reconcileWords(lane, tokens) {
  const flow = lane.flow;
  if (!flow) return;
  const existing = flow.childNodes;
  let i = 0;
  while (i < tokens.length && i < existing.length
    && existing[i]._word === tokens[i].word) {
    if (existing[i]._state !== tokens[i].state) {
      existing[i].className = `subtitle-word ${tokens[i].state}`;
      existing[i]._state = tokens[i].state;
    }
    i += 1;
  }
  // If the new hypothesis is just a SHORTER but NON-EMPTY prefix of what's already
  // shown (Gemini momentarily backtracking), keep the existing trailing words in
  // place. Removing them now only to re-append them on the next (longer) partial
  // makes the tail blink off and back on — the "깜빡거림" the user sees. A genuine
  // divergence (a word that actually differs, handled below) still replaces the
  // tail. CRITICAL: require i > 0 so an EMPTY token list (a lane CLEAR / direction
  // switch) still falls through and removes every node — otherwise the stale text
  // is retained in the DOM and re-appears when the lane is reused ("이전 영어로 점프").
  if (i > 0 && i === tokens.length && i < flow.childNodes.length) return;
  // Drop any trailing tokens that changed (e.g. a revised partial), keeping the
  // common prefix in place.
  while (flow.childNodes.length > i) flow.removeChild(flow.lastChild);
  for (; i < tokens.length; i += 1) {
    const span = document.createElement("span");
    span.className = `subtitle-word ${tokens[i].state}`;
    span.textContent = `${tokens[i].word} `;
    span._word = tokens[i].word;
    span._state = tokens[i].state;
    flow.appendChild(span);
  }
}

// YouTube-style smooth roll-up: .translation-line is a fixed-height window of the
// last N lines; the word flow is top-anchored and translated UP by exactly its
// overflow so the NEWEST text sits on the bottom line. A CSS transition on the
// transform makes older lines glide up smoothly as new lines arrive, instead of
// jumping. Browser-only (needs real layout metrics); the test DOM stub skips.
function updateRollUp(lane) {
  const flow = lane.flow;
  const view = lane.translation;
  if (!flow || !view) return;
  if (typeof view.clientHeight !== "number" || typeof flow.scrollHeight !== "number") return;
  const overflow = Math.max(0, flow.scrollHeight - view.clientHeight);
  // MONOTONIC roll-up: once the block has rolled up, it never comes back down within
  // the same subtitle. A revised partial that briefly shrinks the text (Gemini
  // backtracking, a word un-wrapping) would otherwise lower the offset and the whole
  // block would glide DOWN, then UP again on the next word — the "내려왔다 올라갔다"
  // jitter. We keep the max offset reached and let new words fill the lower line into
  // any leftover space instead. renderLane resets lane.rollOffset on a fresh generation.
  const prev = typeof lane.rollOffset === "number" ? lane.rollOffset : 0;
  const next = Math.max(prev, overflow);
  lane.rollOffset = next;
  flow.style.transform = `translateY(${-next}px)`;
}

function stripSubtitlePrefix(value) {
  return String(value ?? "")
    .replace(/^(translatedText|translation|sourceText|source|번역|원문|en|eng|english|ko|kor|korean|ja|jp|jpn|japanese)\s*[:：]\s*/i, "")
    .trim();
}

function shouldRenderPredictedSubtitle(message) {
  const text = String(message.translatedText ?? "").trim();
  const minChars = message.translationProvider === "gemini"
    ? GEMINI_PREDICTED_SUBTITLE_MIN_CHARS
    : PREDICTED_SUBTITLE_MIN_CHARS;
  if (text.length < minChars) return false;
  if (/[.!?。！？…]\s*$/.test(text)) return true;
  const parts = splitSubtitleSentences(text);
  return parts.length > 1 || text.length >= PREDICTED_SUBTITLE_MIN_CHARS;
}

// One display part per SENTENCE. We deliberately do NOT pre-wrap into
// fixed-width chunks — the browser wraps each sentence by the box's real
// max-width (movie-subtitle style: fill the line, then wrap), and CSS caps the
// visible height. Fixed-character wrapping produced premature mid-sentence
// breaks that jumped as live text streamed in.
function splitSubtitleDisplayParts(text) {
  const sentenceParts = splitSubtitleSentences(text).map(stripSubtitlePrefix).filter(Boolean);
  return sentenceParts.length > 0 ? sentenceParts : [stripSubtitlePrefix(text)].filter(Boolean);
}

function splitSubtitleSentences(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized.match(/[^.!?。！？…]+[.!?。！？…]+|[^.!?。！？…]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [normalized];
}

function applySettings(next = {}) {
  settings = { ...DEFAULT_SUBTITLE, ...next, subtitlePositions: { ...(next.subtitlePositions ?? {}) } };
  if (isAudioOnlyOutput()) clearSubtitle();
  document.documentElement.style.setProperty("--subtitle-font-family", settings.fontFamily);
  document.documentElement.style.setProperty("--translation-font-size", `${settings.translationFontSize}px`);
  document.documentElement.style.setProperty("--source-font-size", `${settings.sourceFontSize}px`);
  document.documentElement.style.setProperty("--subtitle-max-width", `${settings.maxWidth}px`);
  document.documentElement.style.setProperty("--subtitle-opacity", String(settings.opacity));
  document.documentElement.style.setProperty("--subtitle-line-clamp", String(settings.maxSubtitleLines));
  document.documentElement.style.setProperty("--subtitle-vertical-offset", `${settings.verticalOffset ?? 48}px`);
  // Source ("원문") display was removed — subtitles are always translation-only.
  settings.showSourceText = false;
  // Re-home each existing lane to its (possibly changed) per-language position.
  for (const [key, lane] of lanes) {
    const position = positionForLanguage(key);
    if (lane.position !== position) {
      zones[position].append(lane.box);
      lane.position = position;
    }
    lane.source.hidden = true;
  }
  // Crowding may have changed (languages moved between zones) — recompute each
  // zone's line budgets so shared zones stay overlap-free.
  for (const position of Object.keys(zones)) reflowZone(position);
}
