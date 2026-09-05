// @ts-nocheck - drives public/subtitle-overlay.js against a minimal DOM stub.
// The overlay is plain browser ES module code with no test seams, so we give it
// just enough of `document`/`window`/`WebSocket` to run its real lane logic and
// then assert on the resulting DOM. This guards the two display bugs:
//   1) the reverse-direction lane must clear when a NEW live (partial) line for
//      the opposite direction arrives (양방향 자막 동시 표시 방지)
//   2) a live lane that stops updating must expire even while global audio input
//      stays "active" (영어 자막 무한 표시 방지)
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const OVERLAY_URL = pathToFileURL(
  path.join(import.meta.dirname, "..", "public", "subtitle-overlay.js"),
).href;

// Fake layout metrics for the roll-up test: each rendered word span is one
// "line" tall, the visible window holds 3.
const FAKE_LINE_PX = 20;
const FAKE_VIEW_PX = 60;

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(name) { this._set.add(name); }
  toggle(name, force) {
    const on = force ?? !this._set.has(name);
    if (on) this._set.add(name); else this._set.delete(name);
    return on;
  }
  contains(name) { return this._set.has(name); }
}

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this._className = "";
    this.hidden = false;
    this.children = [];
    this.parentNode = null;
    this._text = "";
    this.dataset = {};
    this.classList = new FakeClassList();
    // Plain object so code can assign `style.transform = ...` and the test can
    // read it back; setProperty is used for CSS custom properties.
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      transform: "",
    };
  }
  // Minimal layout metrics so updateRollUp (browser-only) can run under the stub:
  // a word flow is FAKE_LINE_PX tall per child word, and a translation-line window
  // clamps to FAKE_VIEW_PX. This lets us drive overflow up and down deterministically.
  get scrollHeight() { return this.children.length * FAKE_LINE_PX; }
  get clientHeight() { return FAKE_VIEW_PX; }
  set className(v) { this._className = String(v ?? ""); }
  get className() { return this._className; }
  _classes() { return this._className.split(/\s+/).filter(Boolean); }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) {
        const siblings = node.parentNode.children;
        const idx = siblings.indexOf(node);
        if (idx >= 0) siblings.splice(idx, 1);
      }
      node.parentNode = this;
      this.children.push(node);
    }
    this._text = "";
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  appendChild(node) { this.append(node); return node; }
  removeChild(node) {
    const idx = this.children.indexOf(node);
    if (idx >= 0) this.children.splice(idx, 1);
    node.parentNode = null;
    return node;
  }
  get childNodes() { return this.children; }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  matchesSelector(sel) {
    const dataZone = sel.match(/^\[data-zone="(.+)"\]$/);
    if (dataZone) return this.dataset.zone === dataZone[1];
    if (sel.startsWith(".")) return this._classes().includes(sel.slice(1));
    return false;
  }
  querySelector(sel) {
    for (const child of this.children) {
      if (child.matchesSelector(sel)) return child;
      const nested = child.querySelector(sel);
      if (nested) return nested;
    }
    return null;
  }
}

function installDom({ withDesktopFloor = false } = {}) {
  const overlay = new FakeElement("main");
  overlay.dataset.id = "subtitle-overlay";
  for (const zone of ["top-center", "middle-center", "bottom-center"]) {
    const el = new FakeElement("div");
    el.dataset.zone = zone;
    el.className = `subtitle-zone position-${zone}`;
    overlay.append(el);
  }
  const documentElement = new FakeElement("html");
  let fakeWs = null;
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      this._handlers = {};
      fakeWs = this;
      sockets.push(this);
    }
    addEventListener(type, cb) { this._handlers[type] = cb; }
    send() {}
    close() {}
    disconnect() { this._handlers.close?.(); }
    fail() { this._handlers.error?.(); }
    recv(message) { this._handlers.message?.({ data: JSON.stringify(message) }); }
    open() { this._handlers.open?.(); }
  }
  const doc = {
    documentElement,
    getElementById: (id) => (id === "subtitle-overlay" ? overlay : null),
    createElement: (tag) => new FakeElement(tag),
  };
  globalThis.document = doc;
  globalThis.window = globalThis;
  delete globalThis.realtimeNoelDesktop;
  let floorListener = null;
  if (withDesktopFloor) {
    globalThis.realtimeNoelDesktop = {
      onLiveCallFloor(listener) {
        floorListener = listener;
        return () => { floorListener = null; };
      },
    };
  }
  globalThis.location = { protocol: "http:", host: "localhost:3210" };
  globalThis.WebSocket = FakeWebSocket;
  return { overlay, getWs: () => fakeWs, getSockets: () => sockets.slice(), fireFloor: (floor) => floorListener?.(floor), zoneText, speakerText };

  function zoneText(zone) {
    const z = overlay.querySelector(`[data-zone="${zone}"]`);
    const box = z?.querySelector(".subtitle-box");
    if (!box || box.hidden) return "";
    return (box.querySelector(".translation-line")?.textContent ?? "").trim();
  }

  function speakerText(zone) {
    const z = overlay.querySelector(`[data-zone="${zone}"]`);
    const label = z?.querySelector(".live-call-speaker-label");
    return !label || label.hidden ? "" : label.textContent.trim();
  }
}

async function loadOverlay(suffix) {
  // Cache-bust so each test gets a fresh module run against the current DOM.
  return import(`${OVERLAY_URL}?v=${suffix}`);
}

const SETTINGS = {
  type: "settings",
  settings: {
    subtitle: {
      translationLanguages: ["en", "ko"],
      subtitlePositions: { en: "bottom-center", ko: "top-center" },
      maxSubtitleLines: 3,
    },
  },
};

test("pipeline recovery statuses never render operational copy on the viewer overlay", async () => {
  const dom = installDom();
  await loadOverlay("operator-status-hidden");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  ws.recv({ type: "subtitle:status", status: "reconnecting" });
  ws.recv({ type: "subtitle:status", status: "recovering" });
  ws.recv({ type: "subtitle:status", status: "degraded" });
  ws.recv({ type: "subtitle:committed", targetLanguage: "en", translatedText: "" });

  assert.equal(dom.overlay.textContent.trim(), "");
});

// The gateway already decided direction for every Live Call caption: it picks
// the lane opposite the detected source and the desktop only forwards that one
// (shouldDisplayLiveCaption in electron/main.js). The overlay's own direction
// hysteresis exists for captions-only, where the desktop runs the language
// arbiter itself. Re-judging a Live Call caption here is a SECOND, unsmoothed
// decision layer: a sourceLanguage flap between the gateway's own partials made
// the sentence-lock branch drop captions mid-utterance, so the host saw text
// being continuously rewritten while the web app — which merges purely on seq —
// showed the same stream cleanly.
test("Live Call captions are never dropped by the overlay's direction hysteresis", async () => {
  const dom = installDom();
  await loadOverlay("live-direction-not-rejudged");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const liveLine = (translatedText, sourceLanguage) => ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage,
    translationProvider: "gemini",
    translatedText,
    liveCallSpeaker: { role: "host" },
  });

  // An open (unpunctuated) sentence, then the gateway reports a different
  // source language for the very next partial of the same utterance.
  liveLine("The quarterly figures are still being consolidated", "ko");
  assert.match(dom.zoneText("bottom-center"), /quarterly figures/u);
  liveLine("The quarterly figures are still being consolidated this week", "en");
  assert.match(dom.zoneText("bottom-center"), /this week/u,
    "a gateway-side source flap must not make the overlay withhold the caption");
});

test("a new opposite-direction live line clears the stale reverse lane", async () => {
  const dom = installDom();
  await loadOverlay("reverse-lane");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  // Speaker talks Korean → English subtitle (ko→en) commits at the bottom.
  ws.recv({
    type: "subtitle:committed",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "I'm not saying anything strange.",
  });
  assert.match(dom.zoneText("bottom-center"), /strange/, "English subtitle should appear at the bottom");

  // Speaker switches to English → Korean translation (en→ko) arrives first as a
  // live partial. The stale English lane must clear immediately, not linger.
  ws.recv({
    type: "subtitle:partial",
    targetLanguage: "ko",
    sourceLanguage: "en",
    translationProvider: "gemini",
    translatedText: "제 자신에게 질문을 던졌어요.",
  });

  assert.equal(dom.zoneText("bottom-center"), "", "stale English lane must clear when the reverse direction starts");
  assert.match(dom.zoneText("top-center"), /질문을 던졌어요/, "new Korean subtitle should appear at the top");
});

test("a live lane expires even while global audio input stays active", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dom = installDom();
  await loadOverlay("live-expiry");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  ws.recv({
    type: "subtitle:partial",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "This is a long enough live hypothesis.",
  });
  assert.match(dom.zoneText("bottom-center"), /live hypothesis/, "live English partial should be visible");

  // Simulate continuous system audio: refresh the GLOBAL input-active flag every
  // 800ms (shorter than the 1600ms grace) so it is ALWAYS active when the live
  // linger fires. No NEW content arrives for this lane. The old code re-armed the
  // timer forever under exactly this condition and pinned the subtitle on screen;
  // the lane must still eventually expire once its own live window elapses
  // (generous now so a subtitle survives a silence gap, but not forever).
  for (let elapsed = 0; elapsed <= 16000; elapsed += 800) {
    ws.recv({ type: "subtitle:status", status: "hearing" });
    t.mock.timers.tick(800);
  }

  assert.equal(dom.zoneText("bottom-center"), "", "a no-longer-updating live lane must clear despite continuously active input");
});

test("append-only word rendering keeps already-shown words stable as a partial grows", async () => {
  const dom = installDom();
  await loadOverlay("append-stability");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const wordSpans = (zone) => {
    const z = dom.overlay.querySelector(`[data-zone="${zone}"]`);
    const flow = z?.querySelector(".subtitle-flow");
    return flow ? flow.children.slice() : [];
  };

  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "The Seoul hotel market is" });
  const first = wordSpans("bottom-center");
  assert.ok(first.length >= 5, "first partial should render its words");

  // The partial grows by appending words.
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "The Seoul hotel market is expanding rapidly with recovering demand" });
  const second = wordSpans("bottom-center");

  // The DOM nodes for the original words must be the SAME objects — not
  // re-created — which is what stops the on-screen text from reflowing/jittering.
  for (let i = 0; i < first.length; i += 1) {
    assert.equal(second[i], first[i], `word ${i} ("${first[i].textContent.trim()}") must keep its DOM node across the growing partial`);
  }
  assert.ok(second.length > first.length, "new words are appended, not replacing the whole block");
  assert.match(dom.zoneText("bottom-center"), /expanding rapidly with recovering demand/);
});

test("Live Call floor boundaries preserve the old frame only until the next caption arrives", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("live-call-floor-boundary");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const wordSpans = () => {
    const zone = dom.overlay.querySelector('[data-zone="bottom-center"]');
    return zone?.querySelector(".subtitle-flow")?.children.slice() ?? [];
  };

  ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The host's final sentence remains readable.",
    seq: 1,
  });
  assert.match(dom.zoneText("bottom-center"), /host's final sentence/);

  dom.fireFloor({ holder: { participantId: "participant-1", name: "Participant" } });
  assert.equal(
    dom.zoneText("bottom-center"),
    "The host's final sentence remains readable.",
    "speaker handoff must preserve the committed Caption-only roll-up",
  );

  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The participant is speaking",
    seq: 2,
  });
  const firstPartialWords = wordSpans();
  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The participant is speaking through the web app",
    seq: 3,
  });
  const grownPartialWords = wordSpans();
  for (let index = 0; index < firstPartialWords.length; index += 1) {
    assert.equal(grownPartialWords[index], firstPartialWords[index], "cumulative partials must retain stable word nodes");
  }

  ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The participant spoke through the web app.",
    seq: 4,
  });
  assert.equal(
    dom.zoneText("bottom-center"),
    "The participant spoke through the web app.",
  );

  ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "A new utterance replaces the old final.",
    seq: 5,
  });
  assert.equal(
    dom.zoneText("bottom-center"),
    "The participant spoke through the web app. A new utterance replaces the old final.",
    "the same speaker's next completed sentence rolls up below the previous final",
  );
});

test("an authoritative participant floor gives the overlay exclusively to participant gateway captions", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("participant-floor-producer-ownership");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  dom.fireFloor({
    type: "floor",
    sessionId: "live-session-participant",
    holder: { participantId: "participant-1" },
  });

  ws.recv({
    type: "subtitle:partial",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Late local host audio must stay hidden",
    seq: 1,
  });
  assert.equal(dom.zoneText("bottom-center"), "", "local output is paused while a participant owns the floor");

  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    streamId: "trusted-participant-stream",
    liveSessionId: "live-session-participant",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The participant caption is visible",
    liveCallSpeaker: { role: "participant", participantId: "participant-1", name: "Participant" },
    seq: 2,
  });
  assert.equal(dom.zoneText("bottom-center"), "The participant caption is visible");

  ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    liveSessionId: "live-session-participant",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "A delayed host gateway caption must stay hidden.",
    liveCallSpeaker: { role: "host" },
    seq: 3,
  });
  assert.doesNotMatch(dom.zoneText("bottom-center"), /delayed host gateway/u);

  ws.recv({
    type: "subtitle:snapshot",
    streamId: "mismatched-participant-stream",
    liveSessionId: "different-live-session",
    seq: 30,
    events: [{
      type: "subtitle:partial",
      source: "live-call",
      liveSessionId: "different-live-session",
      targetLanguage: "en",
      sourceLanguage: "ko",
      translatedText: "A different session snapshot must stay hidden",
      liveCallSpeaker: { role: "participant", participantId: "participant-other", name: "Other" },
      seq: 30,
    }],
  });
  assert.equal(dom.zoneText("bottom-center"), "The participant caption is visible");

  ws.recv({
    type: "subtitle:snapshot",
    streamId: "late-local-stream",
    seq: 31,
    lanes: [{
      type: "subtitle:partial",
      source: "system",
      targetLanguage: "en",
      sourceLanguage: "ko",
      translatedText: "A local snapshot cannot replace the participant",
      seq: 31,
    }],
  });
  assert.equal(dom.zoneText("bottom-center"), "The participant caption is visible");

  ws.recv({
    type: "subtitle:clear",
    source: "live-call",
    liveSessionId: "live-session-participant",
    targetLanguage: "en",
    seq: 4,
  });
  assert.equal(dom.zoneText("bottom-center"), "", "the participant gateway owns clear while its floor is active");
});

test("an authoritative host floor gives the overlay exclusively to local Caption Only output", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("host-floor-producer-ownership");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  dom.fireFloor({ type: "floor", sessionId: "live-session-host", holder: null });
  ws.recv({
    type: "subtitle:partial",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The local Caption Only engine is visible",
    seq: 1,
  });
  assert.equal(dom.zoneText("bottom-center"), "The local Caption Only engine is visible");

  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    liveSessionId: "live-session-host",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "A late participant gateway tail must stay hidden",
    liveCallSpeaker: { role: "participant", name: "Participant" },
    seq: 2,
  });
  assert.equal(dom.zoneText("bottom-center"), "The local Caption Only engine is visible");

  ws.recv({
    type: "subtitle:clear",
    source: "live-call",
    liveSessionId: "live-session-host",
    targetLanguage: "en",
    seq: 3,
  });
  assert.equal(
    dom.zoneText("bottom-center"),
    "The local Caption Only engine is visible",
    "a late participant clear cannot erase the local host caption",
  );
});

test("a participant final already attributed to the active session may land after floor release", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("participant-late-final-after-release");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  dom.fireFloor({
    type: "floor",
    sessionId: "live-session-late-final",
    holder: { participantId: "participant-late" },
  });
  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    liveSessionId: "live-session-late-final",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Participant draft",
    liveCallSpeaker: { role: "participant", participantId: "participant-late", name: "Participant" },
    seq: 11,
  });

  dom.fireFloor({ type: "floor", sessionId: "live-session-late-final", holder: null });
  ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    liveSessionId: "live-session-late-final",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Participant final after release.",
    liveCallSpeaker: { role: "participant", participantId: "participant-late", name: "Participant" },
    seq: 12,
  });
  assert.match(dom.zoneText("bottom-center"), /Participant final after release\./u);

  ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    liveSessionId: "live-session-late-final",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Gateway host echo must stay hidden.",
    liveCallSpeaker: { role: "host", participantId: "participant-late" },
    seq: 13,
  });
  assert.doesNotMatch(dom.zoneText("bottom-center"), /Gateway host echo/u);
});

test("a host-floor reconnect snapshot restores local lanes and ignores stale Live Call events", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("host-floor-mixed-reconnect-snapshot");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  dom.fireFloor({ type: "floor", sessionId: "live-session-host-snapshot", holder: null });
  ws.recv({
    type: "subtitle:snapshot",
    streamId: "reconnected-host-stream",
    liveSessionId: "live-session-host-snapshot",
    seq: 8,
    events: [{
      type: "subtitle:committed",
      source: "live-call",
      liveSessionId: "live-session-host-snapshot",
      targetLanguage: "en",
      sourceLanguage: "ko",
      translatedText: "Stale gateway participant sentence.",
      liveCallSpeaker: { role: "participant", name: "Participant" },
      seq: 7,
    }],
    lanes: [{
      type: "subtitle:partial",
      source: "system",
      targetLanguage: "en",
      sourceLanguage: "ko",
      translatedText: "Restored local host caption",
      seq: 8,
    }],
  });

  assert.equal(dom.zoneText("bottom-center"), "Restored local host caption");
  assert.doesNotMatch(dom.zoneText("bottom-center"), /gateway participant/u);
});

test("malformed and mismatched floor events fail closed without clearing or changing session ownership", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("floor-session-fail-closed");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  dom.fireFloor({ type: "floor", sessionId: "live-session-a", holder: null });
  ws.recv({
    type: "subtitle:committed",
    streamId: "trusted-live-session-stream",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The trusted local caption remains.",
    seq: 1,
  });

  dom.fireFloor({ type: "floor", sessionId: "live-session-b", holder: { participantId: "participant-b" } });
  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    streamId: "untrusted-other-session-stream",
    liveSessionId: "live-session-b",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The other session must not be adopted",
    liveCallSpeaker: { role: "participant", name: "Other" },
    seq: 2,
  });
  assert.equal(dom.zoneText("bottom-center"), "The trusted local caption remains.");

  dom.fireFloor({ type: "floor", sessionId: "live-session-a", holder: { participantId: "" } });
  ws.recv({
    type: "subtitle:clear",
    source: "live-call",
    liveSessionId: "live-session-a",
    targetLanguage: "en",
    seq: 3,
  });
  ws.recv({
    type: "subtitle:committed",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Blocked local tail.",
    seq: 4,
  });
  assert.equal(
    dom.zoneText("bottom-center"),
    "The trusted local caption remains.",
    "an unknown same-session floor preserves the last trusted frame and accepts neither producer",
  );
});

test("Caption Only keeps its legacy local display behavior when no Live Call floor is active", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("caption-only-with-floor-bridge");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  ws.recv({
    type: "subtitle:committed",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Caption Only remains unchanged.",
    seq: 1,
  });
  assert.equal(dom.zoneText("bottom-center"), "Caption Only remains unchanged.");
});

test("a Live Call floor change keeps a partial visible until the next speaker caption replaces it", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("live-call-floor-atomic-replacement");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    utteranceKey: "host:17",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The host is finishing the current thought",
    liveCallSpeaker: { role: "host" },
    seq: 17,
  });
  const previousText = dom.zoneText("bottom-center");
  assert.equal(dom.speakerText("bottom-center"), "Host");

  dom.fireFloor({ holder: { participantId: "participant-1", name: "김노엘" } });
  assert.equal(dom.zoneText("bottom-center"), previousText,
    "floor notification alone must not create an empty caption frame");
  assert.equal(dom.speakerText("bottom-center"), "Host",
    "the existing caption keeps its own metadata until the replacement caption arrives");

  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    utteranceKey: "participant-1:18",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The participant starts a new sentence",
    liveCallSpeaker: { role: "participant", name: "김노엘", department: "전략기획실", jobTitle: "PM" },
    seq: 18,
  });
  assert.equal(dom.zoneText("bottom-center"), "The participant starts a new sentence",
    "the first new-speaker caption atomically replaces the stale interim tail");
  assert.equal(dom.speakerText("bottom-center"), "김노엘 · 전략기획실 · PM",
    "old metadata must never be attached to the new caption");
});

test("the first caption after a floor atomically replaces a previous final and its speaker", async () => {
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("live-call-floor-final-speaker-replacement");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    utteranceKey: "host:final:1",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Yes.",
    liveCallSpeaker: { role: "host" },
    seq: 1,
  });
  dom.fireFloor({ holder: { participantId: "participant-1", name: "김노엘" } });
  assert.equal(dom.zoneText("bottom-center"), "Yes.");
  assert.equal(dom.speakerText("bottom-center"), "Host");

  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    utteranceKey: "participant:partial:2",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Yes.",
    liveCallSpeaker: { role: "participant", name: "김노엘", department: "전략기획실", jobTitle: "PM" },
    seq: 2,
  });
  assert.equal(dom.zoneText("bottom-center"), "Yes.", "same text from the next speaker must not be deduplicated away");
  assert.equal(dom.speakerText("bottom-center"), "김노엘 · 전략기획실 · PM");
});

test("a new Live Call partial keeps the previous final until the next sentence commits", async () => {
  const dom = installDom();
  await loadOverlay("live-call-new-utterance");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  ws.recv({ type: "subtitle:committed", source: "live-call", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Previous final.", seq: 1 });
  ws.recv({ type: "subtitle:partial", source: "live-call", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Current utterance", seq: 2 });

  assert.equal(
    dom.zoneText("bottom-center"),
    "Previous final. Current utterance",
    "Live Call must use the captions-only final-plus-live-tail layout",
  );
});

test("Live Call uses the natural flow inside a reserved three-line viewport", async () => {
  const dom = installDom();
  await loadOverlay("live-call-movie-row");
  const ws = dom.getWs();
  ws.open();
  ws.recv({
    ...SETTINGS,
    settings: { subtitle: { ...SETTINGS.settings.subtitle, maxSubtitleLines: 8 } },
  });

  ws.recv({ type: "subtitle:committed", source: "live-call", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Previous final.", seq: 1 });
  ws.recv({ type: "subtitle:partial", source: "live-call", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Current utterance grows here", seq: 2 });

  const zone = dom.overlay.querySelector('[data-zone="bottom-center"]');
  const lane = zone?.querySelector(".subtitle-lane");
  const box = zone?.querySelector(".subtitle-box");
  const flow = zone?.querySelector(".subtitle-flow");
  assert.equal(lane?.classList.contains("is-live-call"), true, "Live Call gets layout-only stability hooks");
  assert.equal(flow?.children.some((child) => child.tag === "br"), false, "both modes must wrap from one natural word flow");
  assert.equal(box?.style["--subtitle-line-clamp"], "3", "Live Call reserves at most three movie-caption lines");
});

test("captions-only keeps the reference flow unchanged", async () => {
  const dom = installDom();
  await loadOverlay("caption-reference-flow");
  const ws = dom.getWs();
  ws.open();
  ws.recv({
    ...SETTINGS,
    settings: { subtitle: { ...SETTINGS.settings.subtitle, maxSubtitleLines: 8 } },
  });

  ws.recv({ type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Reference final.", seq: 1 });
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Reference partial continues", seq: 2 });

  const zone = dom.overlay.querySelector('[data-zone="bottom-center"]');
  const lane = zone?.querySelector(".subtitle-lane");
  const box = zone?.querySelector(".subtitle-box");
  const flow = zone?.querySelector(".subtitle-flow");
  assert.equal(lane?.classList.contains("is-live-call"), false);
  assert.equal(box?.style["--subtitle-line-clamp"], "8",
    "Live-only viewport reservation must not change Caption-only's configured line budget");
  assert.equal(flow?.children.some((child) => child.tag === "br"), false, "the immutable captions-only renderer keeps its existing continuous flow");
});

test("a Live Call position change moves the speaker and caption shell together", async () => {
  const dom = installDom();
  await loadOverlay("live-position-shell");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);
  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    utteranceKey: "participant:position:1",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "The participant caption moves with its identity",
    liveCallSpeaker: { role: "participant", name: "김노엘" },
  });

  ws.recv({
    ...SETTINGS,
    settings: {
      subtitle: {
        ...SETTINGS.settings.subtitle,
        subtitlePositions: { en: "top-center", ko: "bottom-center" },
      },
    },
  });

  const top = dom.overlay.querySelector('[data-zone="top-center"]');
  const shell = top?.querySelector(".subtitle-lane");
  assert.ok(shell, "the complete Live Call lane must move to the new zone");
  assert.equal(shell.querySelector(".live-call-speaker-label")?.textContent, "김노엘");
  assert.match(shell.querySelector(".subtitle-box")?.textContent ?? "", /moves with its identity/u);
});

test("Live Call speaker identity stays above the caption until its lane or floor clears", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dom = installDom({ withDesktopFloor: true });
  await loadOverlay("live-call-speaker-label");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The host is presenting the investment assumptions",
    liveCallSpeaker: { role: "host", name: "Ignored host name", department: "Ignored", jobTitle: "Ignored" },
  });
  assert.equal(dom.speakerText("bottom-center"), "Host");

  t.mock.timers.tick(6_000);
  assert.equal(dom.speakerText("bottom-center"), "Host", "identity must not use the previous five-second badge timer");

  dom.fireFloor({ holder: { participantId: "participant-1", name: "김노엘" } });
  assert.equal(dom.speakerText("bottom-center"), "Host", "a floor boundary preserves the visible caption and its identity");

  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "The participant is speaking through the web application",
    liveCallSpeaker: { role: "participant", name: "김노엘", department: "전략기획실", jobTitle: "PM" },
  });
  assert.equal(dom.speakerText("bottom-center"), "김노엘 · 전략기획실 · PM");
});

test("Live Call idle clears both caption text and speaker metadata", async () => {
  const dom = installDom();
  await loadOverlay("live-idle-clears-speaker");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);
  ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    utteranceKey: "host:idle:1",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "The host caption is currently visible",
    liveCallSpeaker: { role: "host" },
  });
  assert.equal(dom.speakerText("bottom-center"), "Host");

  ws.recv({ type: "subtitle:status", status: "idle" });
  assert.equal(dom.zoneText("bottom-center"), "");
  assert.equal(dom.speakerText("bottom-center"), "");
  const label = dom.overlay.querySelector('[data-zone="bottom-center"]')?.querySelector(".live-call-speaker-label");
  assert.equal(label?.textContent, "", "idle must clear hidden speaker text, not only hide the row");
});

test("Live Call final roll-up respects the configured line budget and keeps the newest sentence", async () => {
  const dom = installDom();
  await loadOverlay("live-call-line-budget");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  for (const [seq, translatedText] of [
    [1, "First completed sentence."],
    [2, "Second completed sentence."],
    [3, "Third completed sentence."],
    [4, "Fourth completed sentence."],
  ]) {
    ws.recv({
      type: "subtitle:committed",
      source: "live-call",
      targetLanguage: "en",
      sourceLanguage: "ko",
      translatedText,
      seq,
    });
  }

  assert.equal(
    dom.zoneText("bottom-center"),
    "Second completed sentence. Third completed sentence. Fourth completed sentence.",
    "the oldest final rolls off while the newest final remains at the bottom",
  );
});

test("a trailing reverse-direction tail after a switch does not re-show the old lane (no ping-pong / 동시 표시)", async () => {
  const dom = installDom();
  await loadOverlay("switch-tail");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  // Speaking Korean → English subtitle at the bottom (ko→en). The sentence ENDS
  // (terminal punctuation) so the upcoming switch is at a real sentence boundary.
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "The hotel market is recovering strongly this year." });
  assert.match(dom.zoneText("bottom-center"), /recovering/, "English shows while Korean is spoken");

  // Speaker switches to English → Korean subtitle at the top (en→ko). Genuine switch.
  ws.recv({ type: "subtitle:partial", targetLanguage: "ko", sourceLanguage: "en", translationProvider: "gemini", translatedText: "올해 시장이 강하게 회복되고 있습니다" });
  assert.match(dom.zoneText("top-center"), /회복/, "Korean shows after the switch");
  assert.equal(dom.zoneText("bottom-center"), "", "the old English lane clears on the switch");

  // The Korean→English channel's translation-latency TAIL arrives LATE (it was still
  // finishing the last Korean). It must NOT re-show English and wipe the Korean —
  // that ping-pong is what the user sees as "한국어·영어가 동시에 뜨고 섞임".
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "The hotel market is recovering strongly this year indeed" });
  assert.equal(dom.zoneText("bottom-center"), "", "the stale English tail must NOT re-appear after the switch");
  assert.match(dom.zoneText("top-center"), /회복/, "Korean must stay on screen (not wiped by the tail)");
});

test("switching direction empties the reverse lane's word nodes (no stale text retained)", async () => {
  const dom = installDom();
  await loadOverlay("switch-clear");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const enFlowWords = () => {
    const z = dom.overlay.querySelector(`[data-zone="bottom-center"]`);
    const flow = z?.querySelector(".subtitle-flow");
    return flow ? flow.children.length : 0;
  };

  // KO→EN: English subtitle accumulates at the bottom.
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "The hotel market is recovering strongly this year and demand keeps rising." });
  assert.ok(enFlowWords() > 0, "english words rendered on the bottom lane");

  // Speaker switches to English → an en→ko partial clears the stale EN lane. The
  // lane's word NODES must be removed, not just hidden — otherwise the stale English
  // re-appears when the lane is reused (the "이전 영어로 점프" glitch).
  ws.recv({ type: "subtitle:partial", targetLanguage: "ko", sourceLanguage: "en", translationProvider: "gemini", translatedText: "한국어 자막이 새로 시작됩니다 이전 영어는 남지 않아야 합니다" });
  assert.equal(enFlowWords(), 0, "cleared reverse (EN) lane must drop its word nodes, not retain stale text");
  assert.match(dom.zoneText("top-center"), /새로 시작/, "new Korean subtitle shows at the top");
});

test("a direction switch waits for the current sentence to end (no mid-sentence language flip)", async () => {
  const dom = installDom();
  await loadOverlay("sentence-lock");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  // Korean is spoken → English subtitle at the bottom, sentence still in progress (no
  // terminal punctuation).
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "We are now discussing the hotel market" });
  assert.match(dom.zoneText("bottom-center"), /hotel market/, "English shows while the sentence is in progress");

  // The opposite direction arrives MID-sentence. It must be HELD — the in-progress
  // English subtitle must NOT be converted to a Korean one before the sentence ends.
  ws.recv({ type: "subtitle:partial", targetLanguage: "ko", sourceLanguage: "en", translationProvider: "gemini", translatedText: "우리는 지금 호텔 시장을" });
  assert.equal(dom.zoneText("top-center"), "", "the new direction is held until the current sentence ends");
  assert.match(dom.zoneText("bottom-center"), /hotel market/, "the in-progress sentence keeps its language");

  // The active sentence now ENDS (terminal punctuation).
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "We are now discussing the hotel market." });
  // A new opposite-direction line after the sentence boundary is now accepted.
  ws.recv({ type: "subtitle:partial", targetLanguage: "ko", sourceLanguage: "en", translationProvider: "gemini", translatedText: "이제 새로운 문장이 시작됩니다" });
  assert.match(dom.zoneText("top-center"), /새로운 문장/, "after the sentence ends, the switch is allowed");
  assert.equal(dom.zoneText("bottom-center"), "", "the finished English sentence clears once the switch happens");
});

test("roll-up offset is monotonic within a subtitle and never bounces back down", async () => {
  const dom = installDom();
  await loadOverlay("rollup-monotonic");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const offsetOf = (zone) => {
    const z = dom.overlay.querySelector(`[data-zone="${zone}"]`);
    const flow = z?.querySelector(".subtitle-flow");
    const m = String(flow?.style.transform ?? "").match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
    return m ? Number(m[1]) : 0; // negative px = how far rolled UP
  };

  // Each partial must clear GEMINI_PREDICTED_SUBTITLE_MIN_CHARS (10); the stub's
  // scrollHeight grows with WORD COUNT, so word count drives the roll-up overflow.
  const partial = (text) => ws.recv({
    type: "subtitle:partial", targetLanguage: "ko", sourceLanguage: "en",
    translationProvider: "gemini", translatedText: text,
  });

  // Grow the live partial: more words → more overflow → rolled further UP (more negative).
  partial("서울의 호텔 시장은 빠르게 회복되며 성장하고 있습니다");
  const grown = offsetOf("top-center");
  assert.ok(grown < 0, "an overflowing partial should roll up");
  partial("서울의 호텔 시장은 빠르게 회복되며 성장하고 있습니다 수요가 늘면서 매우");
  const rolledUp = offsetOf("top-center");
  assert.ok(rolledUp <= grown, "growing text rolls further up (more negative translateY)");

  // A revised partial whose re-translated TAIL got shorter (Gemini backtracks) must
  // NOT pull the block back down — the user sees a stable bottom-anchored line, not
  // the "내려왔다 올라갔다" bounce. New words later fill the lower line into the gap.
  partial("서울의 호텔 시장은 빠르게 회복되며 성장하고");
  const afterShrink = offsetOf("top-center");
  assert.equal(afterShrink, rolledUp, "a shorter revision must keep the rolled-up offset (no bounce down)");

  // A brand-new utterance (different leading word) that fits in the window resets to
  // the top so the new subtitle starts on the first line, not pinned high.
  partial("완전히 다른 문장입니다");
  assert.equal(offsetOf("top-center"), 0, "a new generation resets the roll-up to the top");
});

test("Live Call roll-up stays monotonic across revisions and utterance keys", async () => {
  const dom = installDom();
  await loadOverlay("live-utterance-key-rollup");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const flow = () => dom.overlay.querySelector('[data-zone="bottom-center"]')?.querySelector(".subtitle-flow");
  const offset = () => Number(String(flow()?.style.transform ?? "").match(/translateY\((-?\d+(?:\.\d+)?)px\)/)?.[1] ?? 0);
  const partial = (translatedText, utteranceKey) => ws.recv({
    type: "subtitle:partial", source: "live-call", targetLanguage: "en", sourceLanguage: "ko",
    translationProvider: "gemini", translatedText, utteranceKey,
  });

  partial("The market outlook continues improving across every operating segment", "host:42");
  const firstOffset = offset();
  assert.ok(firstOffset < 0);
  partial("Our revised outlook stays positive", "host:42");
  assert.ok(offset() <= firstOffset,
    "a shorter head-word polish inside one utterance must not reset monotonic roll-up");

  partial("A short new thought", "host:43");
  assert.ok(offset() <= firstOffset,
    "identity metadata must not pull a still-visible Live Call lane back down");
});

test("Live Call keeps the latest caption inside the viewport after 100 bounded-queue replacements", async () => {
  const dom = installDom();
  await loadOverlay("live-bounded-queue-rollup-rebase");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const flow = () => dom.overlay.querySelector('[data-zone="bottom-center"]')?.querySelector(".subtitle-flow");
  const transformY = () => Number(String(flow()?.style.transform ?? "").match(/translateY\((-?\d+(?:\.\d+)?)px\)/)?.[1] ?? 0);
  const event = (type, translatedText, sequence) => ws.recv({
    type,
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText,
    utteranceKey: `host:long-run:${sequence}`,
    liveCallSpeaker: { role: "host" },
    seq: sequence,
  });

  for (let index = 0; index < 120; index += 1) {
    const sequence = (index * 2) + 1;
    event("subtitle:partial", `Sentence ${index} temporarily expands across many provisional words before the provider commits it`, sequence);
    event("subtitle:committed", `Final caption ${index}.`, sequence + 1);
  }

  const currentFlow = flow();
  const latest = currentFlow?.lastChild;
  const latestIndex = (currentFlow?.childNodes.length ?? 0) - 1;
  const latestTop = (latestIndex * FAKE_LINE_PX) + transformY();
  const latestBottom = latestTop + FAKE_LINE_PX;
  assert.match(latest?.textContent ?? "", /119/u, "the bounded model and DOM retain the newest final caption");
  assert.ok(latestTop < FAKE_VIEW_PX && latestBottom > 0,
    "the latest caption must intersect the clipped viewport after historical prefixes are removed");
});

// Live Call follows the captions-only retention cadence: a finished sentence
// stays readable while the next one grows, then rolls off after
// SUBTITLE_PREVIOUS_SENTENCE_LINGER_MS. It previously opted out of that timer
// and dropped the previous sentence only when the bounded queue displaced it,
// which read as an old sentence sitting indefinitely or vanishing the instant
// a new one landed.
test("Live Call keeps a completed sentence for the linger window, then rolls it off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dom = installDom();
  await loadOverlay("live-sentence-linger-trim");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const committed = (translatedText, utteranceKey) => ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText,
    utteranceKey,
    liveCallSpeaker: { role: "host" },
  });

  committed("The already completed sentence remains part of the rolling caption.", "host:101");
  committed("The next sentence now continues naturally.", "host:102");
  assert.match(dom.zoneText("bottom-center"), /already completed/u);
  assert.match(dom.zoneText("bottom-center"), /continues naturally/u);

  // Still readable partway through the linger window.
  t.mock.timers.tick(2_000);
  assert.match(dom.zoneText("bottom-center"), /already completed/u,
    "a completed sentence must stay readable for the linger window");
  assert.match(dom.zoneText("bottom-center"), /continues naturally/u);

  // Once the window elapses it rolls off and the newest sentence remains.
  t.mock.timers.tick(2_000);
  assert.doesNotMatch(dom.zoneText("bottom-center"), /already completed/u,
    "the previous sentence rolls off after the linger window, like captions-only");
  assert.match(dom.zoneText("bottom-center"), /continues naturally/u);

  // New content keeps flowing in and the bounded queue still applies.
  committed("A third sentence advances the rolling caption.", "host:103");
  committed("A fourth sentence finally pushes the oldest one beyond the bounded queue.", "host:104");
  assert.match(dom.zoneText("bottom-center"), /fourth sentence/u);
  assert.doesNotMatch(dom.zoneText("bottom-center"), /already completed/u);

  // And the linger window rolls those off in turn, leaving the newest.
  t.mock.timers.tick(4_000);
  assert.match(dom.zoneText("bottom-center"), /fourth sentence/u);
  assert.doesNotMatch(dom.zoneText("bottom-center"), /third sentence/u);
});

test("Live Call roll-up stays monotonic across source sequences when utteranceKey is missing", async () => {
  const dom = installDom();
  await loadOverlay("live-source-seq-rollup");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const flow = () => dom.overlay.querySelector('[data-zone="bottom-center"]')?.querySelector(".subtitle-flow");
  const offset = () => Number(String(flow()?.style.transform ?? "").match(/translateY\((-?\d+(?:\.\d+)?)px\)/)?.[1] ?? 0);
  const partial = (translatedText, sourceSeq) => ws.recv({
    type: "subtitle:partial",
    source: "live-call",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText,
    sourceSeq,
    liveCallSpeaker: { role: "participant", name: "김노엘" },
  });

  partial("The market outlook continues improving across every operating segment", 42);
  const firstOffset = offset();
  assert.ok(firstOffset < 0);
  partial("Our revised outlook stays positive", 42);
  assert.ok(offset() <= firstOffset, "one source sequence must remain one roll-up generation");

  partial("A short new thought", 43);
  assert.ok(offset() <= firstOffset,
    "source sequence metadata must not pull a still-visible Live Call lane back down");
});

test("a transient shorter revision keeps already-shown trailing words (no blink)", async () => {
  const dom = installDom();
  await loadOverlay("no-blink");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const wordSpans = () => {
    const z = dom.overlay.querySelector(`[data-zone="top-center"]`);
    const flow = z?.querySelector(".subtitle-flow");
    return flow ? flow.children.slice() : [];
  };
  const partial = (text) => ws.recv({
    type: "subtitle:partial", targetLanguage: "ko", sourceLanguage: "en",
    translationProvider: "gemini", translatedText: text,
  });

  partial("서울의 호텔 시장은 빠르게 회복되며 성장하고 있습니다 수요가");
  const before = wordSpans();
  assert.equal(before.length, 8, "all words rendered");

  // Gemini backtracks: the next live hypothesis is a SHORTER prefix of what's shown.
  // The trailing words must NOT be removed (that would blink them off then back on);
  // they stay put and are overwritten only by a genuinely different continuation.
  partial("서울의 호텔 시장은 빠르게 회복되며");
  const after = wordSpans();
  assert.equal(after.length, before.length, "trailing words are kept on a pure shrink (no blink)");
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i], before[i], `word ${i} keeps its DOM node across a shorter revision`);
  }

  // But a genuine divergence (a different word, not just fewer) DOES replace the tail.
  partial("서울의 호텔 시장은 빠르게 다른방향으로 전환되었습니다");
  const diverged = wordSpans();
  assert.equal(diverged.map((s) => s.textContent.trim()).join(" "), "서울의 호텔 시장은 빠르게 다른방향으로 전환되었습니다");
});

test("a Live Call final truncates words removed by the provider's shorter final revision", async () => {
  const dom = installDom();
  await loadOverlay("live-shorter-final-truncates-tail");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  const event = (type, translatedText) => ws.recv({
    type,
    source: "live-call",
    utteranceKey: "host:short-final:1",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText,
    liveCallSpeaker: { role: "host" },
  });
  event("subtitle:partial", "The final answer includes a provisional trailing phrase");
  event("subtitle:partial", "The final answer includes");
  assert.match(dom.zoneText("bottom-center"), /provisional trailing phrase/u,
    "a transient shorter partial keeps the no-blink tail");

  event("subtitle:committed", "The final answer includes");
  assert.equal(dom.zoneText("bottom-center"), "The final answer includes",
    "committing the shorter Live Call revision must remove stale provisional words");
});

test("Caption-only keeps its existing shorter-prefix reconciliation on commit", async () => {
  const dom = installDom();
  await loadOverlay("caption-shorter-final-unchanged");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);

  ws.recv({
    type: "subtitle:partial",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "Caption only keeps the existing provisional trailing words",
  });
  ws.recv({
    type: "subtitle:committed",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "Caption only keeps the existing",
  });
  assert.equal(dom.zoneText("bottom-center"), "Caption only keeps the existing provisional trailing words",
    "this Live-only fix must not change Caption-only's byte-for-behaviour prefix retention");
});

// ---- Per-viewer channel (?lang=) ----

test("a ?lang= channel overlay subscribes and only renders its own language", async () => {
  const dom = installDom();
  globalThis.location.search = "?lang=ja";
  await loadOverlay("channel-ja");
  const ws = dom.getWs();
  const sent = [];
  ws.send = (payload) => sent.push(JSON.parse(payload));
  ws.open();
  ws.recv(SETTINGS);

  assert.equal(sent.length, 1, "overlay should subscribe on open");
  assert.equal(sent[0].type, "subtitle:subscribe");
  assert.deepEqual(sent[0].languages, ["ja"]);

  // A lane for another language must be ignored even if it slips through.
  ws.recv({
    type: "subtitle:committed",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "This must not render.",
  });
  assert.equal(dom.zoneText("bottom-center"), "");

  // Own language renders normally.
  ws.recv({
    type: "subtitle:committed",
    targetLanguage: "ja",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "こんにちは、皆さん。",
  });
  assert.match(dom.zoneText("bottom-center"), /こんにちは/);
  globalThis.location.search = "";
});

test("a snapshot paints the current live lanes for a late-joining viewer", async () => {
  const dom = installDom();
  globalThis.location.search = "";
  await loadOverlay("snapshot-late-join");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);
  ws.recv({
    type: "subtitle:snapshot",
    seq: 12,
    lanes: [
      { type: "subtitle:committed", source: "system", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Welcome back.", seq: 11 },
    ],
  });
  assert.match(dom.zoneText("bottom-center"), /Welcome back/);
});

test("snapshot sequence floor rejects stale replay and duplicate finals", async () => {
  const dom = installDom();
  globalThis.location.search = "";
  await loadOverlay("snapshot-floor-dedup");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);
  ws.recv({
    type: "subtitle:snapshot",
    seq: 20,
    lanes: [
      { type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Current confirmed caption.", seq: 20 },
    ],
  });

  ws.recv({ type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Stale replay.", seq: 19 });
  assert.doesNotMatch(dom.zoneText("bottom-center"), /Stale replay/);

  ws.recv({ type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translatedText: "Current confirmed caption", seq: 21 });
  const rendered = dom.zoneText("bottom-center");
  assert.equal(rendered.match(/Current confirmed caption/g)?.length, 1);
});

test("a new streamId resets stale sequence floors before accepting the restarted stream", async () => {
  const dom = installDom();
  globalThis.location.search = "";
  await loadOverlay("stream-id-sequence-reset");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);
  ws.recv({
    type: "subtitle:snapshot",
    streamId: "old-stream",
    seq: 100,
    lanes: [
      {
        type: "subtitle:committed",
        source: "live-call",
        streamId: "old-stream",
        utteranceKey: "old:host:100",
        targetLanguage: "en",
        sourceLanguage: "ko",
        translatedText: "Old server caption.",
        liveCallSpeaker: { role: "host" },
        seq: 100,
      },
    ],
  });
  assert.match(dom.zoneText("bottom-center"), /Old server/u);
  assert.equal(dom.speakerText("bottom-center"), "Host");

  ws.recv({ type: "subtitle:snapshot", streamId: "new-stream", seq: 0, lanes: [] });
  assert.equal(dom.zoneText("bottom-center"), "", "a restarted stream must clear the old server's snapshot");
  assert.equal(dom.speakerText("bottom-center"), "", "stream replacement must clear stale speaker metadata");
  ws.recv({
    type: "subtitle:committed",
    source: "live-call",
    streamId: "new-stream",
    sourceSeq: 1,
    targetLanguage: "ko",
    sourceLanguage: "en",
    translatedText: "New server sequence one is accepted.",
    liveCallSpeaker: { role: "participant", name: "새 참여자" },
    seq: 1,
  });
  assert.equal(dom.zoneText("top-center"), "New server sequence one is accepted.",
    "the old stream's direction lock must not reject the restarted stream's reverse language");
  assert.equal(dom.speakerText("top-center"), "새 참여자");
});

test("events from an old WebSocket cannot reset or clear the active restarted stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dom = installDom();
  globalThis.location.search = "";
  await loadOverlay("old-websocket-fence");
  const first = dom.getWs();
  first.open();
  first.recv(SETTINGS);
  first.recv({
    type: "subtitle:committed",
    streamId: "old-stream",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Old connection caption.",
    seq: 50,
  });
  first.disconnect();
  t.mock.timers.tick(1500);

  const second = dom.getWs();
  assert.notEqual(second, first);
  second.open();
  second.recv({
    type: "subtitle:snapshot",
    streamId: "new-stream",
    seq: 0,
    lanes: [],
  });
  second.recv({
    type: "subtitle:committed",
    streamId: "new-stream",
    targetLanguage: "ko",
    sourceLanguage: "en",
    translatedText: "The active restarted stream stays visible.",
    seq: 1,
  });
  assert.match(dom.zoneText("top-center"), /active restarted stream/u);

  first.recv({
    type: "subtitle:committed",
    streamId: "old-stream",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: "Late stale socket event.",
    seq: 51,
  });
  first.disconnect();
  first.fail();
  t.mock.timers.tick(1500);
  assert.match(dom.zoneText("top-center"), /active restarted stream/u);
  assert.equal(dom.getSockets().length, 2, "stale close/error events must not schedule another reconnect");
});

test("partial growth reuses the same live word nodes instead of recreating the row", async () => {
  const dom = installDom();
  globalThis.location.search = "";
  await loadOverlay("stable-partial-row");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "The hotel market is recovering", seq: 1 });
  const box = dom.overlay.querySelector('[data-zone="bottom-center"]').querySelector(".subtitle-box");
  const flow = box.querySelector(".subtitle-flow");
  assert.equal(box.classList.contains("partial"), true, "Gemini partial must remain provisional until committed");
  const firstWord = flow.childNodes[0];
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "The hotel market is recovering steadily", seq: 2 });
  assert.equal(flow.childNodes[0], firstWord);
  assert.match(dom.zoneText("bottom-center"), /steadily/);
  ws.recv({ type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "The hotel market is recovering steadily.", seq: 3 });
  assert.equal(box.classList.contains("partial"), false, "only committed events become final styling");
});

test("legacy audio-only settings cannot suppress the captions-only overlay", async () => {
  const dom = installDom();
  globalThis.location.search = "";
  await loadOverlay("audio-only-hidden");
  const ws = dom.getWs();
  ws.open();
  ws.recv(SETTINGS);
  ws.recv({
    type: "subtitle:committed",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translationProvider: "gemini",
    translatedText: "Visible before legacy settings arrive.",
  });
  assert.match(dom.zoneText("bottom-center"), /Visible before/);

  ws.recv({ ...SETTINGS, settings: { subtitle: { ...SETTINGS.settings.subtitle, outputMode: "audio" } } });
  assert.match(dom.zoneText("bottom-center"), /Visible before/, "legacy outputMode must not clear visible captions");
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "Captions remain active." });
  ws.recv({ type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "Captions remain active." });
  assert.match(dom.zoneText("bottom-center"), /Captions remain active/);
});


test("a trusted source caption remains visible beside its translated lane", async () => {
  const dom = installDom();
  await loadOverlay("source-with-translations");
  const ws = dom.getWs(); ws.open(); ws.recv(SETTINGS);
  ws.recv({ type: "subtitle:committed", targetLanguage: "ko", sourceLanguage: "ko", isSourceCaption: true,
    translationProvider: "soniox", translatedText: "이번 분기 실적입니다." });
  ws.recv({ type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "soniox",
    translatedText: "These are our quarterly results." });
  assert.match(dom.zoneText("top-center"), /분기 실적/);
  assert.match(dom.zoneText("bottom-center"), /quarterly results/);
});
