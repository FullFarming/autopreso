import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const electronMain = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");

function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist`);
  const end = source.indexOf("\nfunction ", start + 1);
  const boundary = end === -1 ? source.indexOf("\nasync function ", start + 1) : end;
  return source.slice(start, boundary === -1 ? undefined : boundary);
}

function loadRemotePresetSanitizer() {
  const script = [
    "const LIVE_DRAFT_LANGUAGES = new Set(['en','ko','ja','zh-Hans','zh-Hant','es','pt','fr','de','ru','hi','id','vi','it']);",
    "const GLOSSARY_PRESET_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;",
    sliceFunction(electronMain, "sanitizeGlossaryPresetInput"),
    sliceFunction(electronMain, "sanitizeRemoteGlossaryPreset"),
    "__sanitize = sanitizeRemoteGlossaryPreset;",
  ].join("\n");
  const context = vm.createContext({ __sanitize: null });
  vm.runInContext(script, context);
  return context.__sanitize;
}

const REMOTE_PRESET = Object.freeze({
  id: "0d9c8b7a-1234-4abc-9def-000000000001",
  name: "세미나 용어집",
  domain: "실시간 통역",
  languagePair: { a: "ko", b: "en" },
  targetLanguages: ["en", "ja"],
  version: 3,
  activeDocumentVersion: 2,
  updatedAt: "2026-08-27T00:00:00.000Z",
});

test("desktop sync keeps the full target language list of a structured preset", () => {
  const sanitize = loadRemotePresetSanitizer();
  const preset = sanitize(REMOTE_PRESET);
  assert.ok(preset);
  assert.deepEqual([...preset.targetLanguages], ["en", "ja"]);
  assert.equal(preset.languagePair.b, "en");
});

test("desktop sync falls back to the language pair when the target list is missing or invalid", () => {
  const sanitize = loadRemotePresetSanitizer();
  for (const targetLanguages of [undefined, [], ["xx"], ["ko", "en"], ["ja", "ja"], ["ja"]]) {
    const preset = sanitize({ ...REMOTE_PRESET, targetLanguages });
    assert.ok(preset, JSON.stringify(targetLanguages));
    assert.deepEqual([...preset.targetLanguages], ["en"], JSON.stringify(targetLanguages));
  }
});

test("dashboard host compatibility gates on every target language with a pair fallback", () => {
  assert.match(dashboard, /option\.targetLanguages/u);
  assert.match(dashboard, /hostTargetLanguages/u);
  assert.match(dashboard, /\[option\.languagePair\?\.b\]/u);
  assert.match(dashboard, /hostTargetLanguages\(option\)\.some\(\(language\) => targetLanguages\.includes\(language\)\)/u);
});
