import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGES } from "../public/subtitle-i18n.js";
import { JA } from "../public/subtitle-i18n-ja.js";

const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map((match) => match[1]).sort();

test("Japanese translates every English UI key without fallback and preserves every interpolation", () => {
  assert.deepEqual(Object.keys(JA).sort(), Object.keys(MESSAGES.en).sort());
  for (const [key, value] of Object.entries(JA)) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim().length > 0, key);
    assert.deepEqual(placeholders(value), placeholders(MESSAGES.en[key]), key);
  }
});

test("Japanese interface copy contains no Korean fallback outside literal glossary examples", () => {
  const examples = new Set(["glossary.termsPlaceholder", "glossary.error.INVALID_GLOSSARY_DOCUMENT"]);
  for (const [key, value] of Object.entries(JA)) {
    if (!examples.has(key)) assert.doesNotMatch(value, /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/u, key);
  }
  for (const key of ["nav.settings", "menu.showMainWindow", "controller.restart", "settings.saveHostAuthorization", "error.micDenied"]) {
    assert.match(JA[key], /[\u3040-\u30ff\u4e00-\u9fff]/u, key);
    assert.notEqual(JA[key], MESSAGES.en[key], key);
  }
  for (const key of ["app.name", "app.credit", "output.engineNoteValue", "live.titlePlaceholder"]) {
    assert.equal(JA[key], MESSAGES.en[key], key);
  }
});

test("Japanese captions and app-language settings retain distinct meanings", () => {
  assert.equal(JA["lang.ja"], "日本語");
  assert.match(JA["lang.group"], /アプリ/u);
  assert.match(JA["cfg.languages"], /字幕/u);
  assert.match(JA["records.meetingCount"], /\{count\}/u);
  assert.match(JA["controller.endConfirm"], /すべての参加者/u);
  assert.match(JA["controller.endConfirm"], /取り消/u);
});
