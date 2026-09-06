import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mountSystemLanguageButton } from "../public/system-language-button.js";
import { getLanguage, setLanguage } from "../public/subtitle-i18n.js";
import { SYSTEM_LANGUAGE_STORAGE_KEY } from "../public/system-language.js";

class FakeElement extends EventTarget {
  /** @param {string} tagName @param {FakeDocument} ownerDocument */
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    this.className = "";
    this.hidden = false;
    this.id = "";
    this.textContent = "";
    this.type = "";
    this.tabIndex = 0;
  }
  /** @param {...FakeElement} children */
  append(...children) { this.children.push(...children); }
  /** @param {...FakeElement} children */
  replaceChildren(...children) { this.children = children; }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  /** @param {string} name */
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  /** @param {string} name */
  removeAttribute(name) { this.attributes.delete(name); }
  /** @param {unknown} target @returns {boolean} */
  contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
  focus() { this.ownerDocument.activeElement = this; }
}

class FakeWindow extends EventTarget {
  /** @param {(() => unknown) | undefined} getUiLanguage @param {(language: string) => unknown} setUiLanguage */
  constructor(getUiLanguage, setUiLanguage) {
    super();
    this.realtimeNoelDesktop = { getUiLanguage, setUiLanguage };
  }
}

class FakeDocument extends EventTarget {
  /** @type {FakeElement | null} */
  activeElement = null;
  /** @param {FakeWindow} defaultView */
  constructor(defaultView) {
    super();
    this.defaultView = defaultView;
  }
  /** @param {string} tagName */
  createElement(tagName) { return new FakeElement(tagName, this); }
}

function createDeferred() {
  /** @type {{ resolve: (value: unknown) => void, reject: (reason: unknown) => void } | undefined} */
  let controls;
  const promise = new Promise((resolve, reject) => { controls = { resolve, reject }; });
  assert.ok(controls, "Promise executors initialize their controls synchronously");
  return { promise, ...controls };
}

/** @param {{ getUiLanguage?: () => unknown, setUiLanguage?: (language: string) => unknown, initialStoredLanguage?: string }} [options] */
function setup({ getUiLanguage, setUiLanguage, initialStoredLanguage } = {}) {
  setLanguage(initialStoredLanguage ?? "ko");
  /** @type {Map<string, string>} */
  const storage = new Map(initialStoredLanguage === undefined ? [] : [[SYSTEM_LANGUAGE_STORAGE_KEY, initialStoredLanguage]]);
  /** @type {string[]} */
  const ipcCalls = [];
  const window = new FakeWindow(getUiLanguage, (language) => {
    ipcCalls.push(language);
    return setUiLanguage ? setUiLanguage(language) : language;
  });
  const document = new FakeDocument(window);
  const container = document.createElement("div");
  container.id = "test-system-language";
  globalThis.localStorage = {
    get length() { return storage.size; },
    clear() { storage.clear(); },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };
  /** @type {boolean[]} */
  const openChanges = [];
  const control = mountSystemLanguageButton(container, { onOpenChange: (open) => openChanges.push(open) });
  const [trigger, menu, status] = container.children;
  return { document, window, container, trigger, menu, status, choices: menu.children, control, storage, ipcCalls, openChanges };
}

function fire(target, type, values = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

test.afterEach(() => { setLanguage("ko"); delete globalThis.localStorage; });

test("the compact trigger opens native-language choices with the current item focused", () => {
  const h = setup();
  assert.equal(h.trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(h.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(h.menu.hidden, true);
  assert.deepEqual(h.choices.map((choice) => choice.getAttribute("lang")), ["ko", "en", "ja"]);
  assert.deepEqual(h.choices.map((choice) => choice.children[0].textContent), ["한국어", "English", "日本語"]);
  fire(h.trigger, "click");
  assert.equal(h.menu.hidden, false);
  assert.equal(h.document.activeElement, h.choices[0]);
  assert.equal(h.choices[0].getAttribute("aria-checked"), "true");
  h.control.destroy();
});

test("arrows wrap, Home/End navigate, Escape closes and restores the trigger", () => {
  const h = setup();
  fire(h.trigger, "keydown", { key: "ArrowDown" });
  fire(h.menu, "keydown", { key: "ArrowUp", target: h.choices[0] });
  assert.equal(h.document.activeElement, h.choices[2]);
  fire(h.menu, "keydown", { key: "Home", target: h.choices[2] });
  assert.equal(h.document.activeElement, h.choices[0]);
  fire(h.menu, "keydown", { key: "End", target: h.choices[0] });
  assert.equal(h.document.activeElement, h.choices[2]);
  fire(h.menu, "keydown", { key: "Escape", target: h.choices[2] });
  assert.equal(h.menu.hidden, true);
  assert.equal(h.document.activeElement, h.trigger);
  assert.deepEqual(h.openChanges, [true, false]);
  h.control.destroy();
});

test("choosing Japanese persists and publishes only UI language, then restores focus", () => {
  const h = setup();
  fire(h.trigger, "click");
  fire(h.choices[2], "click");
  assert.equal(getLanguage(), "ja");
  assert.equal(h.storage.get(SYSTEM_LANGUAGE_STORAGE_KEY), "ja");
  assert.deepEqual(h.ipcCalls, ["ko", "ja"]);
  assert.equal(h.trigger.children[1].textContent, "日本語");
  assert.equal(h.choices[2].getAttribute("aria-checked"), "true");
  assert.equal(h.menu.hidden, true);
  assert.equal(h.document.activeElement, h.trigger);
  h.control.destroy();
});

test("outside pointer, Tab departure and window blur dismiss without stealing another control's focus", () => {
  const h = setup();
  const outside = h.document.createElement("button");
  for (const close of [
    () => fire(h.document, "pointerdown", { target: outside }),
    () => fire(h.container, "focusout", { relatedTarget: outside }),
    () => fire(h.window, "blur"),
  ]) {
    fire(h.trigger, "click");
    outside.focus();
    close();
    assert.equal(h.menu.hidden, true);
    assert.equal(h.document.activeElement, outside);
  }
  h.control.destroy();
});

test("a remote UI language update repaints the selector without writing storage or IPC", () => {
  const h = setup();
  setLanguage("en");
  assert.equal(h.trigger.children[1].textContent, "English");
  assert.equal(h.trigger.getAttribute("aria-label"), "App language: English");
  assert.equal(h.storage.size, 0);
  assert.deepEqual(h.ipcCalls, ["ko"]);
  h.control.destroy();
  setLanguage("ja");
  assert.equal(h.trigger.children[1].textContent, "English");
});

test("desktop language restores before the initial IPC publish, including Japanese", async () => {
  const deferredLanguage = createDeferred();
  const h = setup({ getUiLanguage: () => deferredLanguage.promise });
  assert.deepEqual(h.ipcCalls, []);
  deferredLanguage.resolve("ja");
  await h.control.ready;
  assert.equal(getLanguage(), "ja");
  assert.equal(h.storage.get(SYSTEM_LANGUAGE_STORAGE_KEY), "ja");
  assert.deepEqual(h.ipcCalls, ["ja"]);
  h.control.destroy();
});

test("a user's choice wins over a late desktop preference without publishing an intermediate locale", async () => {
  const deferredLanguage = createDeferred();
  const h = setup({ getUiLanguage: () => deferredLanguage.promise });
  fire(h.trigger, "click");
  fire(h.choices[1], "click");
  assert.equal(getLanguage(), "en");
  assert.deepEqual(h.ipcCalls, []);
  deferredLanguage.resolve("ja");
  await h.control.ready;
  assert.equal(getLanguage(), "en");
  assert.deepEqual(h.ipcCalls, ["en"]);
  h.control.destroy();
});

test("explicitly choosing the visible default also overrides a late stored preference", async () => {
  const deferredLanguage = createDeferred();
  const h = setup({ getUiLanguage: () => deferredLanguage.promise });
  fire(h.trigger, "click");
  fire(h.choices[0], "click");
  deferredLanguage.resolve("ja");
  await h.control.ready;
  assert.equal(getLanguage(), "ko");
  assert.deepEqual(h.ipcCalls, ["ko"]);
  h.control.destroy();
});

test("invalid saved preferences cannot enter the UI, and unmounted controls ignore late restores", async () => {
  const invalid = setup({ getUiLanguage: async () => "fr" });
  await invalid.control.ready;
  assert.equal(getLanguage(), "ko");
  assert.deepEqual(invalid.ipcCalls, ["ko"]);
  invalid.control.destroy();
  const deferredLanguage = createDeferred();
  const h = setup({ getUiLanguage: () => deferredLanguage.promise });
  h.control.destroy();
  deferredLanguage.resolve("ja");
  await h.control.ready;
  assert.equal(getLanguage(), "ko");
  assert.deepEqual(h.ipcCalls, []);
});

test("a failed restore never overwrites a saved preference, but explicit pending choices still save", async (context) => {
  const warnings = [];
  context.mock.method(console, "warn", (code) => warnings.push(code));
  const h = setup({ getUiLanguage: async () => { throw new Error("private read detail"); } });
  await h.control.ready;
  assert.deepEqual(h.ipcCalls, []);
  assert.equal(getLanguage(), "ko");
  h.control.destroy();

  const deferredLanguage = createDeferred();
  const chosen = setup({ getUiLanguage: () => deferredLanguage.promise });
  fire(chosen.trigger, "click");
  fire(chosen.choices[2], "click");
  deferredLanguage.reject(new Error("private IPC detail"));
  await chosen.control.ready;
  assert.deepEqual(chosen.ipcCalls, ["ja"]);
  assert.deepEqual(warnings, ["SYSTEM_LANGUAGE_RESTORE_FAILED", "SYSTEM_LANGUAGE_RESTORE_FAILED"]);
  chosen.control.destroy();
});

test("another window's language change wins over an older pending desktop read", async () => {
  const deferredLanguage = createDeferred();
  const h = setup({ getUiLanguage: () => deferredLanguage.promise });
  setLanguage("en");
  deferredLanguage.resolve("ja");
  await h.control.ready;
  assert.equal(getLanguage(), "en");
  assert.deepEqual(h.ipcCalls, ["en"]);
  h.control.destroy();
});

test("a storage write wins before its delayed storage event, without rewriting it from the desktop response", async () => {
  const deferredLanguage = createDeferred();
  const h = setup({ initialStoredLanguage: "ko", getUiLanguage: () => deferredLanguage.promise });
  h.storage.set(SYSTEM_LANGUAGE_STORAGE_KEY, "ja");
  assert.equal(getLanguage(), "ko");
  deferredLanguage.resolve("ko");
  await h.control.ready;
  assert.equal(getLanguage(), "ja");
  assert.equal(h.storage.get(SYSTEM_LANGUAGE_STORAGE_KEY), "ja");
  assert.deepEqual(h.ipcCalls, ["ja"]);
  h.control.destroy();
});

test("an explicit default choice in another window wins even when the initial key was missing", async () => {
  const deferredLanguage = createDeferred();
  const h = setup({ getUiLanguage: () => deferredLanguage.promise });
  h.storage.set(SYSTEM_LANGUAGE_STORAGE_KEY, "ko");
  deferredLanguage.resolve("ja");
  await h.control.ready;
  assert.equal(getLanguage(), "ko");
  assert.equal(h.storage.get(SYSTEM_LANGUAGE_STORAGE_KEY), "ko");
  assert.deepEqual(h.ipcCalls, ["ko"]);
  h.control.destroy();
});

test("a later remote change back to the initial language wins over an earlier local choice", async () => {
  const deferredLanguage = createDeferred();
  const h = setup({ initialStoredLanguage: "ko", getUiLanguage: () => deferredLanguage.promise });
  fire(h.trigger, "click");
  fire(h.choices[1], "click");
  h.storage.set(SYSTEM_LANGUAGE_STORAGE_KEY, "ko");
  deferredLanguage.resolve("ja");
  await h.control.ready;
  assert.equal(getLanguage(), "ko");
  assert.equal(h.storage.get(SYSTEM_LANGUAGE_STORAGE_KEY), "ko");
  assert.deepEqual(h.ipcCalls, ["ko"]);
  h.control.destroy();
});

test("a failed save is visibly localized and selecting the same language explicitly retries once", async (context) => {
  context.mock.method(console, "warn", () => {});
  let canSave = false;
  const h = setup({ setUiLanguage: (language) => {
    if (language === "ja" && !canSave) return Promise.reject(new Error("private disk detail"));
    return language;
  } });
  await h.control.ready;
  fire(h.trigger, "click");
  fire(h.choices[2], "click");
  await Promise.resolve();
  assert.equal(h.status.getAttribute("role"), "status");
  assert.equal(h.status.hidden, false);
  assert.match(h.status.textContent, /保存できませんでした/u);
  assert.doesNotMatch(h.status.textContent, /private/u);
  assert.equal(h.trigger.getAttribute("aria-describedby"), h.status.id);
  await Promise.resolve();
  assert.deepEqual(h.ipcCalls, ["ko", "ja"], "failure never starts an automatic retry");
  fire(h.trigger, "click");
  assert.equal(h.status.hidden, true, "the failure notice must not overlap the language menu");
  canSave = true;
  fire(h.choices[2], "click");
  await Promise.resolve();
  assert.deepEqual(h.ipcCalls, ["ko", "ja", "ja"]);
  assert.equal(h.status.hidden, true);
  assert.equal(h.trigger.getAttribute("aria-describedby"), null);
  h.control.destroy();
});

test("a rejected acknowledgement is a visible failure, and stale save failures cannot replace a newer success", async (context) => {
  context.mock.method(console, "warn", () => {});
  const denied = setup({ setUiLanguage: () => null });
  await denied.control.ready;
  assert.equal(denied.status.hidden, false);
  assert.match(denied.status.textContent, /저장하지 못했어요/u);
  denied.control.destroy();
  const deferredOldSave = createDeferred();
  const h = setup({ setUiLanguage: (language) => language === "ja"
    ? deferredOldSave.promise : language });
  await h.control.ready;
  fire(h.trigger, "click");
  fire(h.choices[2], "click");
  fire(h.trigger, "click");
  fire(h.choices[1], "click");
  await Promise.resolve();
  deferredOldSave.reject(new Error("older failure"));
  await Promise.resolve();
  assert.equal(h.status.hidden, true);
  assert.equal(getLanguage(), "en");
  assert.deepEqual(h.ipcCalls, ["ko", "ja", "en"]);
  h.control.destroy();
});

test("desktop pages share the language menu, preserve Japanese on first paint and synchronize storage", async () => {
  for (const name of ["subtitle", "subtitle-controller"]) {
    const html = await readFile(new URL(`../public/${name}.html`, import.meta.url), "utf8");
    const script = await readFile(new URL(`../public/${name === "subtitle" ? "subtitle-workspace" : name}.js`, import.meta.url), "utf8");
    assert.match(html, /system-language-button\.css/u);
    assert.match(html, /stored === "ja"/u);
    assert.match(script, /mountSystemLanguageButton/u);
    assert.match(script, /setLanguage\(readStoredLanguage\(\)\)/u);
    assert.match(script, /event\.key !== SYSTEM_LANGUAGE_STORAGE_KEY/u);
    assert.doesNotMatch(html, /workspace-language-toggle|data-language-choice/u);
  }
  const workspace = await readFile(new URL("../public/subtitle.html", import.meta.url), "utf8");
  assert.ok(workspace.indexOf('id="workspace-theme-toggle"') < workspace.indexOf('id="workspace-system-language"'));
  const css = await readFile(new URL("../public/system-language-button.css", import.meta.url), "utf8");
  assert.match(css, /min-height: 44px/u);
  assert.match(css, /outline: 2px solid var\(--nova-system-default\)/u);
  const component = await readFile(new URL("../public/system-language-button.js", import.meta.url), "utf8");
  assert.doesNotMatch(component, /sendControl|translationLanguages|subtitlePositions|restart|WebSocket|fetch\(/u);
});
