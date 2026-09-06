import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_TRANSCRIPT_ROWS,
  createNovaTranscriptRenderer,
  filterTranscriptEntries,
  isTranscriptAtLatest,
  normalizeTranscriptEntry,
  scrollTranscriptToLatest,
  upsertTranscriptEntry,
} from "../public/nova-transcript.js";

function createFakeDocument() {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.className = "";
      this.hidden = false;
      this.parentNode = null;
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      this.listeners = new Map();
      this._textContent = "";
    }

    set textContent(value) {
      this._textContent = String(value ?? "");
      this.children = [];
    }

    get textContent() {
      if (this.children.length > 0) return this.children.map((child) => child.textContent).join("");
      return this._textContent;
    }

    appendChild(child) {
      if (child.parentNode) {
        const currentIndex = child.parentNode.children.indexOf(child);
        if (currentIndex >= 0) child.parentNode.children.splice(currentIndex, 1);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    }

    dispatch(type) {
      this.listeners.get(type)?.();
    }
  }

  return {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };
}

function makeEntry(overrides = {}) {
  return {
    id: "turn-1",
    sourceText: "Hello",
    translatedText: "안녕하세요",
    speaker: "APAC Manager",
    time: "09:30",
    type: "live-coach",
    status: "partial",
    ...overrides,
  };
}

test("normalizeTranscriptEntry applies NFC, strips controls, and bounds external text", () => {
  const normalized = normalizeTranscriptEntry(makeEntry({
    sourceText: `Cafe\u0301\u0000${"a".repeat(5_000)}`,
    translatedText: "\u0007번역",
    speaker: "  Kim\u0000 ",
  }));

  assert.equal(normalized.sourceText.startsWith("Café"), true);
  assert.equal(Array.from(normalized.sourceText).length, 4_000);
  assert.equal(normalized.translatedText, "번역");
  assert.equal(normalized.speaker, "Kim");
  assert.equal(Object.isFrozen(normalized), true);
});

test("normalizeTranscriptEntry rejects missing identifiers and supplies safe metadata defaults", () => {
  assert.throws(() => normalizeTranscriptEntry({ sourceText: "hello" }), /id/u);
  assert.throws(() => normalizeTranscriptEntry(null), /entry/u);

  const entry = normalizeTranscriptEntry({ id: " a\u0000 ", sourceText: "hello" });
  assert.equal(entry.id, "a");
  assert.equal(entry.type, "general");
  assert.equal(entry.status, "final");
  assert.equal(entry.speaker, "");
  assert.equal(entry.time, "");
});

test("upsertTranscriptEntry keeps the same logical row for partial to final and does not mutate inputs", () => {
  const partial = makeEntry();
  const before = [partial];
  const after = upsertTranscriptEntry(before, makeEntry({
    sourceText: "Hello everyone",
    translatedText: "모두 안녕하세요",
    status: "final",
  }));

  assert.notEqual(after, before);
  assert.deepEqual(before, [partial]);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "turn-1");
  assert.equal(after[0].status, "final");
  assert.equal(after[0].sourceText, "Hello everyone");
});

test("upsertTranscriptEntry keeps only the newest 200 rows", () => {
  /** @type {ReadonlyArray<ReturnType<typeof normalizeTranscriptEntry>>} */
  let entries = [];
  for (let index = 0; index < MAX_TRANSCRIPT_ROWS + 2; index += 1) {
    entries = upsertTranscriptEntry(entries, makeEntry({ id: `turn-${index}`, sourceText: `line ${index}` }));
  }

  assert.equal(entries.length, MAX_TRANSCRIPT_ROWS);
  assert.equal(entries[0].id, "turn-2");
  assert.equal(entries.at(-1).id, `turn-${MAX_TRANSCRIPT_ROWS + 1}`);
});

test("filterTranscriptEntries searches normalized text and combines feature and status filters", () => {
  const entries = [
    makeEntry({ id: "1", sourceText: "Cafe\u0301 budget", type: "live-call", status: "final" }),
    makeEntry({ id: "2", sourceText: "Laptop inventory", translatedText: "노트북 자산", type: "live-coach", status: "partial" }),
    makeEntry({ id: "3", sourceText: "Network issue", speaker: "Korea IT", type: "live-coach", status: "final" }),
  ].map(normalizeTranscriptEntry);

  assert.deepEqual(filterTranscriptEntries(entries, { query: "CAFÉ" }).map((entry) => entry.id), ["1"]);
  assert.deepEqual(filterTranscriptEntries(entries, { types: ["live-coach"], statuses: ["final"] }).map((entry) => entry.id), ["3"]);
  assert.deepEqual(filterTranscriptEntries(entries, { query: "노트북", types: new Set(["live-coach"]) }).map((entry) => entry.id), ["2"]);
  assert.equal(filterTranscriptEntries(entries, { statuses: ["error"] }).length, 0);
});

test("latest helpers detect proximity and move to the newest row", () => {
  const container = { scrollTop: 350, scrollHeight: 500, clientHeight: 100 };
  assert.equal(isTranscriptAtLatest(container), false);
  assert.equal(isTranscriptAtLatest(container, { threshold: 50 }), true);
  assert.equal(isTranscriptAtLatest(null), true);

  scrollTranscriptToLatest(container);
  assert.equal(container.scrollTop, 500);
  assert.doesNotThrow(() => scrollTranscriptToLatest(null));
});

test("renderer outputs source before translation with metadata using textContent-only nodes", () => {
  const documentRef = createFakeDocument();
  const container = documentRef.createElement("section");
  const renderer = createNovaTranscriptRenderer({ container, documentRef });

  renderer.update(makeEntry());

  const row = container.children[0];
  assert.equal(row.getAttribute("data-transcript-id"), "turn-1");
  assert.equal(row.getAttribute("data-transcript-type"), "live-coach");
  assert.equal(row.getAttribute("data-transcript-status"), "partial");
  assert.equal(row.children[0].textContent, "APAC Manager09:30live-coachpartial");
  assert.equal(row.children[1].textContent, "Hello");
  assert.equal(row.children[2].textContent, "안녕하세요");
});

test("renderer supports a separate scroll surface and compatible screen class names", () => {
  const documentRef = createFakeDocument();
  const container = documentRef.createElement("section");
  const scrollElement = documentRef.createElement("main");
  scrollElement.scrollHeight = 1_000;
  scrollElement.clientHeight = 200;
  scrollElement.scrollTop = 800;
  const states = [];
  const renderer = createNovaTranscriptRenderer({
    container,
    scrollElement,
    documentRef,
    classNames: {
      row: "record-line",
      metadata: "record-meta",
      avatar: "speaker-avatar",
      source: "record-en",
      translation: "record-ko",
    },
    onLatestChange: (state) => states.push(state),
  });

  renderer.update(makeEntry({ status: "partial" }));

  const row = container.children[0];
  assert.match(row.className, /nova-transcript-row record-line/u);
  assert.match(row.children[0].className, /nova-transcript-row__metadata record-meta/u);
  assert.match(row.children[0].children[0].className, /nova-transcript-row__avatar speaker-avatar/u);
  assert.match(row.children[1].className, /nova-transcript-row__source record-en/u);
  assert.match(row.children[2].className, /nova-transcript-row__translation record-ko/u);
  assert.equal(scrollElement.scrollTop, 1_000);
  assert.deepEqual(states.at(-1), { isAtLatest: true, hasUnseenLatest: false });

  scrollElement.scrollTop = 100;
  scrollElement.dispatch("scroll");
  renderer.update(makeEntry({ id: "turn-2" }));
  assert.deepEqual(states.at(-1), { isAtLatest: false, hasUnseenLatest: true });
  renderer.moveToLatest();
  assert.equal(scrollElement.scrollTop, 1_000);
});

test("renderer reuses the exact DOM row when a partial becomes final", () => {
  const documentRef = createFakeDocument();
  const container = documentRef.createElement("section");
  const renderer = createNovaTranscriptRenderer({ container, documentRef });

  renderer.update(makeEntry());
  const partialRow = container.children[0];
  renderer.update(makeEntry({ status: "final", sourceText: "Hello everyone" }));

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], partialRow);
  assert.equal(partialRow.children[1].textContent, "Hello everyone");
  assert.equal(partialRow.getAttribute("data-transcript-status"), "final");
});

test("renderer replace collapses duplicate turn identifiers to the newest state", () => {
  const documentRef = createFakeDocument();
  const container = documentRef.createElement("section");
  const renderer = createNovaTranscriptRenderer({ container, documentRef });

  renderer.replace([
    makeEntry({ status: "partial", sourceText: "Hel" }),
    makeEntry({ status: "final", sourceText: "Hello" }),
  ]);

  assert.equal(renderer.getEntries().length, 1);
  assert.equal(renderer.getEntries()[0].status, "final");
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].children[1].textContent, "Hello");
});

test("renderer filters rows without discarding their DOM identity", () => {
  const documentRef = createFakeDocument();
  const container = documentRef.createElement("section");
  const renderer = createNovaTranscriptRenderer({ container, documentRef });
  renderer.replace([
    makeEntry({ id: "call", type: "live-call", status: "final" }),
    makeEntry({ id: "coach", type: "live-coach", status: "partial" }),
  ]);
  const coachRow = container.children[1];

  renderer.setFilters({ types: ["live-coach"], statuses: ["partial"] });
  assert.equal(container.children[0].hidden, true);
  assert.equal(container.children[1].hidden, false);

  renderer.setFilters({});
  assert.equal(container.children[1], coachRow);
  assert.equal(coachRow.hidden, false);
});

test("renderer tracks unseen latest rows while scrolled up and clears them on move", () => {
  const documentRef = createFakeDocument();
  const container = documentRef.createElement("section");
  container.scrollHeight = 1_000;
  container.clientHeight = 200;
  container.scrollTop = 100;
  const states = [];
  const renderer = createNovaTranscriptRenderer({
    container,
    documentRef,
    onLatestChange: (state) => states.push(state),
  });

  renderer.update(makeEntry());
  assert.deepEqual(renderer.getViewState(), { isAtLatest: false, hasUnseenLatest: true });

  renderer.moveToLatest();
  assert.deepEqual(renderer.getViewState(), { isAtLatest: true, hasUnseenLatest: false });
  assert.equal(container.scrollTop, 1_000);
  assert.equal(states.at(-1).hasUnseenLatest, false);

  container.scrollTop = 300;
  container.dispatch("scroll");
  assert.equal(renderer.getViewState().isAtLatest, false);
  renderer.destroy();
  assert.equal(container.listeners.has("scroll"), false);
});

test("renderer auto-follows when already at latest and prunes stale DOM rows", () => {
  const documentRef = createFakeDocument();
  const container = documentRef.createElement("section");
  container.scrollHeight = 100;
  container.clientHeight = 100;
  const renderer = createNovaTranscriptRenderer({ container, documentRef, maxRows: 2 });

  renderer.update(makeEntry({ id: "1" }));
  renderer.update(makeEntry({ id: "2" }));
  const removedRow = container.children[0];
  renderer.update(makeEntry({ id: "3" }));

  assert.deepEqual(renderer.getEntries().map((entry) => entry.id), ["2", "3"]);
  assert.equal(container.children.length, 2);
  assert.equal(removedRow.parentNode, null);
  assert.equal(renderer.getViewState().hasUnseenLatest, false);
});

test("renderer validates its DOM boundary", () => {
  assert.throws(() => createNovaTranscriptRenderer({ container: null }), /container/u);
  assert.throws(() => createNovaTranscriptRenderer({ container: { appendChild() {} }, documentRef: {} }), /document/u);
  assert.throws(() => createNovaTranscriptRenderer({
    container: { appendChild() {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0 },
    documentRef: { createElement() { return {}; } },
  }).update(makeEntry()), /invalid element/u);
});
