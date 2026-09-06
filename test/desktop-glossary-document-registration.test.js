import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { convertLegacyGlossaryTextToDocumentV1 } from "../packages/caption-core/index.js";

const electronMain = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");

function loadDocumentBuilder() {
  const start = electronMain.indexOf("function buildGlossaryDocumentFromLegacyInput(");
  assert.notEqual(start, -1);
  const end = electronMain.indexOf("\nfunction ", start + 1);
  // The vm context creates metadata with its own Object.prototype, which
  // caption-core's plain-object assertion rejects; re-clone into this realm
  // the way the real (same-realm) electron process sees it.
  const bridgedConverter = (text, metadata) => convertLegacyGlossaryTextToDocumentV1(text, { ...metadata });
  const context = vm.createContext({ convertLegacyGlossaryTextToDocumentV1: bridgedConverter, Date, __build: null });
  vm.runInContext(`${electronMain.slice(start, end)}\n__build = buildGlossaryDocumentFromLegacyInput;`, context);
  return context.__build;
}

const INPUT = Object.freeze({
  name: "행사 프리셋",
  domain: "실시간 통역 세미나",
  glossary: [
    "[규칙]",
    "- 이 줄은 규칙 설명이라 용어가 아니다.",
    "[고유명사 (한국어 = English)]",
    "세션 재개 = session resumption",
    "임시 토큰 -> ephemeral token",
    "설명만 있는 줄은 건너뛴다",
  ].join("\n"),
  languagePair: { a: "ko", b: "en" },
});

test("desktop registration converts flat input into a valid document, skipping rule lines", () => {
  const build = loadDocumentBuilder();
  const document = build(INPUT);
  assert.ok(document);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.name, "행사 프리셋");
  assert.deepEqual([...document.targetLanguages], ["en"]);
  assert.equal(document.terms.length, 2);
  assert.equal(document.terms[0].translations.en, "session resumption");
  assert.equal(document.terms[0].context, "고유명사 (한국어 = English)");
  assert.equal(document.version, 1);
});

test("structured presets render back into sectioned legacy text on apply", () => {
  const start = electronMain.indexOf("function renderGlossaryDocumentAsLegacyText(");
  assert.notEqual(start, -1);
  const end = electronMain.indexOf("\nfunction ", start + 1);
  const context = vm.createContext({ __render: null });
  vm.runInContext(`${electronMain.slice(start, end)}\n__render = renderGlossaryDocumentAsLegacyText;`, context);
  const render = context.__render;
  const text = render({ terms: [
    { source: "세션 재개", translations: { en: "session resumption", ja: "セッション再開" }, context: "Live API" },
    { source: "발언권", translations: { en: "speaking floor" }, context: "Live API" },
    { source: "팬아웃", translations: { ja: "ファンアウト" }, context: null },
    { source: "빈 항목", translations: {} },
  ] }, "en");
  assert.equal(text, [
    "[Live API]",
    "세션 재개 = session resumption",
    "발언권 = speaking floor",
    "[용어]",
    "팬아웃 = ファンアウト",
  ].join("\n"));
  assert.equal(render({ terms: [] }, "en"), null);

  // The renderer applies structured presets through the read-version bridge.
  const dashboard = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
  assert.match(dashboard, /invokeGlossaryPresetBridge\("readGlossaryPresetVersion"/u);
  const preload = readFileSync(new URL("../electron/preload.js", import.meta.url), "utf8");
  assert.match(preload, /readGlossaryPresetVersion: \(input\) => ipcRenderer\.invoke\("glossary-presets:read-version", input\)/u);
  assert.match(electronMain, /\/versions\/\$\{encodeURIComponent\(value\.version\)\}/u);
});

test("desktop registration versions the document for updates and rejects pair-less input", () => {
  const build = loadDocumentBuilder();
  const versioned = build(INPUT, { documentVersion: 4 });
  assert.equal(versioned.version, 4);
  assert.equal(build({ ...INPUT, glossary: "[규칙]\n- 규칙만 있는 용어집" }), null);
});
