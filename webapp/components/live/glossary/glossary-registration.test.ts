import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  GlossaryRegistrationError,
  buildGlossaryExtractionPrompt,
  parsePastedGlossary,
  presentGlossaryLanguageTags,
} from "./glossary-registration";

const NOW = "2026-08-27T00:00:00.000Z";

test("extraction prompt embeds the chosen languages, the exclusion rules, and both output formats", () => {
  const prompt = buildGlossaryExtractionPrompt({
    name: "행사 용어집",
    domain: "실시간 통역 API 세미나",
    sourceLanguage: "ko",
    targetLanguages: ["en", "ja"],
  });
  assert.match(prompt, /"sourceLanguage":\s*"ko"/u);
  assert.match(prompt, /"targetLanguages":\s*\["en",\s*"ja"\]/u);
  assert.match(prompt, /기본 어휘.*제외|일반적인 단어.*제외/u);
  assert.match(prompt, /중복/u);
  assert.match(prompt, /"translations"/u);
  assert.match(prompt, /\| 원문 \| en \| ja \|/u);
  assert.match(prompt, /실시간 통역 API 세미나/u);
  assert.doesNotMatch(prompt, /\$\{|\{\{/u);
});

test("extraction prompt rejects unsupported or conflicting languages", () => {
  assert.throws(() => buildGlossaryExtractionPrompt({ name: "x", domain: "", sourceLanguage: "ko", targetLanguages: [] }), GlossaryRegistrationError);
  assert.throws(() => buildGlossaryExtractionPrompt({ name: "x", domain: "", sourceLanguage: "ko", targetLanguages: ["ko"] }), GlossaryRegistrationError);
  assert.throws(() => buildGlossaryExtractionPrompt({ name: "x", domain: "", sourceLanguage: "ko", targetLanguages: ["xx"] }), GlossaryRegistrationError);
});

test("pasted simplified JSON is normalized into a valid glossary document", () => {
  const document = parsePastedGlossary(JSON.stringify({
    name: "AI 행사 용어집",
    domain: "실시간 통역",
    sourceLanguage: "ko",
    targetLanguages: ["en", "ja"],
    terms: [
      { source: "세션 재개", translations: { en: "session resumption", ja: "セッション再開" } },
      { source: "임시 토큰", translations: { en: "ephemeral token" }, context: "Live API 인증" },
      { source: "세션 재개", translations: { en: "duplicate ignored" } },
      { source: "  ", translations: { en: "blank ignored" } },
    ],
  }), NOW);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.name, "AI 행사 용어집");
  assert.deepEqual(document.targetLanguages, ["en", "ja"]);
  assert.equal(document.terms.length, 2);
  assert.equal(document.terms[0].translations.en, "session resumption");
  assert.equal(document.terms[0].provenance.kind, "import");
  assert.equal(new Set(document.terms.map((term) => term.id)).size, 2);
  assert.equal(document.createdAt, NOW);
  assert.equal(document.version, 1);
});

test("pasted JSON inside a markdown code fence still parses", () => {
  const fenced = "```json\n" + JSON.stringify({
    name: "펜스", domain: "", sourceLanguage: "ko", targetLanguages: ["en"],
    terms: [{ source: "발언권", translations: { en: "speaking floor" } }],
  }) + "\n```";
  const document = parsePastedGlossary(fenced, NOW);
  assert.equal(document.terms[0].translations.en, "speaking floor");
});

test("pasted markdown table is parsed with language columns and metadata bullets", () => {
  const markdown = [
    "# 용어집: 세미나 용어집",
    "- source-language: ko",
    "- target-languages: en, ja",
    "- domain: 실시간 통역 세미나",
    "",
    "| 원문 | en | ja | 비고 |",
    "|---|---|---|---|",
    "| 세션 재개 | session resumption | セッション再開 | Live API |",
    "| 발언권 | speaking floor |  | 발언 제어 |",
  ].join("\n");
  const document = parsePastedGlossary(markdown, NOW);
  assert.equal(document.name, "세미나 용어집");
  assert.equal(document.domain, "실시간 통역 세미나");
  assert.deepEqual(document.targetLanguages, ["en", "ja"]);
  assert.equal(document.terms.length, 2);
  assert.deepEqual(document.terms[0].translations, { en: "session resumption", ja: "セッション再開" });
  assert.deepEqual(document.terms[1].translations, { en: "speaking floor" });
  assert.equal(document.terms[1].context, "발언 제어");
});

test("unusable pastes fail with Korean guidance instead of a raw exception", () => {
  for (const text of ["", "완전히 자유로운 텍스트", "| 원문 |\n|---|", JSON.stringify({ name: "x" })]) {
    assert.throws(() => parsePastedGlossary(text, NOW), GlossaryRegistrationError);
  }
});

test("language tags list source and every target language", () => {
  const document = parsePastedGlossary(JSON.stringify({
    name: "태그", domain: "", sourceLanguage: "ko", targetLanguages: ["en", "ja"],
    terms: [{ source: "팬아웃", translations: { en: "fan-out" } }],
  }), NOW);
  assert.deepEqual(presentGlossaryLanguageTags(document), ["원문 ko", "en", "ja"]);
});

test("registration dialog offers prompt copy, paste registration, and language tags", () => {
  const dialog = readFileSync(resolve(process.cwd(), "components/live/glossary", "GlossaryRegistrationDialog.tsx"), "utf8");
  assert.match(dialog, /언어집 등록/u);
  assert.match(dialog, /프롬프트 복사/u);
  assert.match(dialog, /name="pastedGlossary"/u);
  assert.match(dialog, /name="extractionPrompt"/u);
  assert.match(dialog, /<LanguagePicker label=\{t\("번역 언어"\)\}/u);
  assert.match(dialog, /excludedLanguages=\{\[sourceLanguage\]\}/u);
  assert.match(dialog, /removeSourceLanguage\(current, language\)/u);
  assert.match(dialog, /disabled=\{isBusy \|\| targetLanguages\.length === 0\}/u);
  assert.match(dialog, /languageTag/u);
  assert.doesNotMatch(dialog, /fetch\(|\/api\//u);
});

test("editing a validated paste requires a new validation before registration", () => {
  const dialog = readFileSync(resolve(process.cwd(), "components/live/glossary", "GlossaryRegistrationDialog.tsx"), "utf8");
  assert.match(dialog, /setPasted\(event.currentTarget.value\); setValidatedPaste\(null\)/u);
  assert.match(dialog, /disabled=\{isBusy \|\| !preview \|\| validatedPaste !== pasted\}/u);
});
