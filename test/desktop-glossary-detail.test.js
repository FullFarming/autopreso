import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { startServer } from "../src/server.js";

const html = readFileSync(new URL("../public/subtitle.html", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/subtitle-i18n.js", import.meta.url), "utf8");
const electronMain = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");

function fakeTranscription() {
  return { ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} };
}

test("built-in glossary documents are served read-only for the detail popup", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: fakeTranscription,
  });
  try {
    const response = await fetch(`${url}/api/built-in-glossaries/ai_ax`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.glossary.id, "ai_ax");
    assert.equal(body.glossary.sourceLanguage, "ko");
    assert.ok(body.glossary.targetLanguages.includes("en"));
    assert.ok(body.glossary.terms.length >= 50);
    const term = body.glossary.terms.find((entry) => entry.source === "세션 재개");
    assert.equal(term.translations.en, "session resumption");
    // Read-only projection: no ids, provenance, or tags leak to the browser.
    assert.deepEqual(Object.keys(body.glossary.terms[0]).sort(), ["context", "source", "translations"]);

    const missing = await fetch(`${url}/api/built-in-glossaries/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("session glossary selection is a compact dropdown with per-glossary detail buttons", () => {
  assert.match(html, /id="glossary-select-trigger"[\s\S]{0,160}aria-haspopup/u);
  assert.match(html, /id="glossary-select-panel"/u);
  assert.match(html, /id="glossary-selection-builtins"/u);
  assert.match(html, /id="glossary-selection-users"/u);
  // The conflict status line survives the compaction.
  assert.match(html, /적용할 때 번역 충돌을 확인합니다/u);
  assert.match(dashboard, /glossary-detail-button/u);
  assert.match(dashboard, /openGlossaryDetail\(/u);
});

test("glossary detail popup supports search, per-language filtering, and custom terms", () => {
  assert.match(html, /id="glossary-detail-dialog"/u);
  assert.match(html, /id="glossary-detail-search"/u);
  assert.match(html, /id="glossary-detail-languages"/u);
  assert.match(html, /id="glossary-detail-terms"/u);
  assert.match(html, /id="glossary-custom-source"/u);
  assert.match(html, /id="glossary-custom-target"/u);
  assert.match(html, /id="glossary-custom-save"/u);
  // Built-ins load over the read-only route; synced presets come through the
  // existing authenticated bridge.
  assert.match(dashboard, /\/api\/built-in-glossaries\//u);
  assert.match(dashboard, /readGlossaryPresetVersion/u);
  // Custom terms persist into the local glossary through the normal save path.
  assert.match(dashboard, /function saveGlossaryCustomTerm/u);
  assert.match(dashboard, /markGlossaryPresetCustom\(\)/u);
  for (const key of ["glossary.detail", "glossary.detailSearch", "glossary.detailAll", "glossary.detailCustomSave"]) {
    assert.match(i18n, new RegExp(`"${key.replace(".", "\\.")}"`, "u"));
  }
});

test("the preset bridge exposes bounded terms so the popup can render synced glossaries", () => {
  assert.match(electronMain, /terms: sanitizeGlossaryDocumentTerms\(result\.data\?\.document\)/u);
  assert.match(electronMain, /function sanitizeGlossaryDocumentTerms/u);
});


test("glossary selection uses modal focus ownership, filters rows, and restores its trigger", () => {
  const listeners = new Map();
  let focused = "";
  const node = (id) => ({ id, hidden: true, style: {}, addEventListener(type, listener) { listeners.set(id + type, listener); },
    setAttribute() {}, focus() { focused = id; } });
  const trigger = node("trigger");
  const search = node("search");
  const done = node("done");
  const rows = [{ textContent: "호텔 투자", hidden: false }, { textContent: "공통 비즈니스", hidden: false }];
  let open = false;
  const panel = { ...node("glossary-select-panel"), showModal() { open = true; }, close() { open = false; },
    querySelector: () => search, querySelectorAll: (selector) => selector === "[data-glossary-select-close]" ? [done] : rows };
  const root = { ...node("root"), querySelector: (selector) => selector === ".lang-select-trigger" ? trigger : panel };
  const document = { querySelectorAll: () => [root], getElementById: () => null, addEventListener() {} };
  const start = dashboard.indexOf("function setupLanguageDropdowns()");
  const end = dashboard.indexOf("setupLanguageDropdowns();", start);
  vm.runInNewContext(dashboard.slice(start, end) + "setupLanguageDropdowns();", { document });
  listeners.get("triggerclick")();
  assert.equal(open, true);
  assert.equal(focused, "search");
  listeners.get("searchinput")({ currentTarget: { value: "호텔" } });
  assert.deepEqual(rows.map((row) => row.hidden), [false, true]);
  listeners.get("doneclick")();
  assert.equal(open, false);
  assert.equal(panel.hidden, true);
  assert.equal(focused, "trigger");
  listeners.get("triggerclick")();
  let prevented = false;
  listeners.get("glossary-select-panelcancel")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(open, false);
  assert.equal(focused, "trigger");
});

test("caption setup has one glossary selector while management lives in settings", () => {
  const captions = html.slice(html.indexOf('data-workspace-page="captions"'), html.indexOf('data-workspace-page="livecall"'));
  assert.match(captions, /id="glossary-select-trigger"/);
  assert.doesNotMatch(captions, /id="glossary-preset"|id="create-glossary-preset"/);
  const settings = html.slice(html.indexOf('data-workspace-page="settings"'));
  assert.match(settings, /id="glossary-preset"/);
  assert.match(html, /<dialog id="glossary-detail-dialog"/);
  assert.match(html, /class="glossary-detail-body"/);
  assert.match(html, /id="glossary-detail-done"/);
});
