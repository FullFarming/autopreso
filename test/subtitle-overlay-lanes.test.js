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
    this.style = { setProperty() {}, transform: "" };
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

function installDom() {
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
  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      this._handlers = {};
      fakeWs = this;
    }
    addEventListener(type, cb) { this._handlers[type] = cb; }
    send() {}
    close() {}
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
  globalThis.location = { protocol: "http:", host: "localhost:3210" };
  globalThis.WebSocket = FakeWebSocket;
  return { overlay, getWs: () => fakeWs, zoneText };

  function zoneText(zone) {
    const z = overlay.querySelector(`[data-zone="${zone}"]`);
    const box = z?.querySelector(".subtitle-box");
    if (!box || box.hidden) return "";
    return (box.querySelector(".translation-line")?.textContent ?? "").trim();
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

test("audio-only output clears lanes and ignores partial and committed captions", async () => {
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
    translatedText: "Visible before audio-only mode.",
  });
  assert.match(dom.zoneText("bottom-center"), /Visible before/);

  ws.recv({ ...SETTINGS, settings: { subtitle: { ...SETTINGS.settings.subtitle, outputMode: "audio" } } });
  assert.equal(dom.zoneText("bottom-center"), "", "switching to audio-only must clear existing lanes");
  ws.recv({ type: "subtitle:partial", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "Must remain hidden in audio mode." });
  ws.recv({ type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "Still hidden." });
  assert.equal(dom.zoneText("bottom-center"), "");

  ws.recv({ ...SETTINGS, settings: { subtitle: { ...SETTINGS.settings.subtitle, outputMode: "captions" } } });
  ws.recv({ type: "subtitle:committed", targetLanguage: "en", sourceLanguage: "ko", translationProvider: "gemini", translatedText: "Visible after captions return." });
  assert.match(dom.zoneText("bottom-center"), /Visible after/);
});
