import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
