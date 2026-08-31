import assert from "node:assert/strict";
import test from "node:test";
import { isFixedTargetOutputSupported, createLocalTermRetriever, compileGlossaryDocumentV1, buildPolishSystemPrompt } from "../packages/caption-core/index.js";

const compiled = compileGlossaryDocumentV1({
  schemaVersion: 1, name: "표기 보존", domain: "제품 실적", sourceLanguage: "en", targetLanguages: ["ko"],
  terms: [
    { id: "product", source: "iPhone", translations: {}, aliases: ["Apple phone"], doNotTranslate: true },
    { id: "company", source: "NOVA", translations: {}, doNotTranslate: true },
    { id: "income", source: "net operating income", translations: { ko: "NOI" } },
    { id: "revenue", source: "Revenue", translations: { ko: "매출" } },
    { id: "margin", source: "Operating Margin", translations: { ko: "영업 이익률" } },
  ].map((term) => ({ ...term, provenance: { kind: "manual" } })),
  createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z", version: 1,
});

test("capitalization is never proof that a foreign term belongs on a Korean output lane", () => {
  for (const text of ["이번 분기 Revenue와 Operating Margin이 개선됐습니다.", "이번 분기 revenue와 operating margin이 개선됐습니다.", "iPhone 매출이 늘었습니다.", "NOVA의 매출입니다."]) {
    assert.equal(isFixedTargetOutputSupported(text, "ko"), false, text);
  }
  assert.equal(isFixedTargetOutputSupported("이번 분기 매출과 영업 이익률이 개선됐습니다.", "ko"), true);
});

test("only exact explicitly protected terms may retain foreign script, including Korean particles and NFC", () => {
  const options = { protectedTerms: ["NOVA", "iPhone", "NOI", "ADR", "Café"] };
  for (const text of ["NOVA의 iPhone 매출이 늘었습니다.", "NOI와 ADR이 올랐습니다.", "Cafe\u0301가 열렸습니다.", "NOVA", "NOVA 2026"]) {
    assert.equal(isFixedTargetOutputSupported(text, "ko", options), true, text);
  }
  for (const text of ["INNOVA 매출입니다.", "iPhonePlus 매출입니다.", "iphone 매출입니다.", "NOVA의 Revenue가 늘었습니다.", "NOVA Revenue Is Growing.", "NOVA, Revenue와 Operating Margin이 개선됐습니다."]) {
    assert.equal(isFixedTargetOutputSupported(text, "ko", options), false, text);
  }
});

test("protected output terms come from pinned canonical preservation or explicit target renderings, never aliases or source-side English", () => {
  const retriever = createLocalTermRetriever("Revenue = Revenue", { sessionId: "protected-core", compiledGlossary: compiled });
  const terms = retriever.getProtectedTerms({ translatedText: "NOVA iPhone iphone NOI Revenue Operating Margin", targetLanguage: "ko" });
  assert.deepEqual(new Set(terms), new Set(["NOVA", "iPhone", "NOI"]));
  assert.equal(isFixedTargetOutputSupported("NOVA의 iPhone 매출과 NOI가 늘었습니다.", "ko", { protectedTerms: terms }), true);
  retriever.release();
  assert.deepEqual(retriever.getProtectedTerms({ translatedText: "NOVA", targetLanguage: "ko" }), []);
});

test("legacy text requires an explicit identity pair and malformed pinned data cannot fall back to it", () => {
  const glossary = "[고유명사]\nNOVA = NOVA\n아이폰 = iPhone\nRevenue = 매출";
  const legacy = createLocalTermRetriever(glossary);
  assert.deepEqual(legacy.getProtectedTerms({ translatedText: "NOVA iPhone Revenue", targetLanguage: "ko" }), ["NOVA"]);
  const invalid = createLocalTermRetriever(glossary, { sessionId: "bad-pinned", compiledGlossary: {} });
  assert.deepEqual(invalid.getProtectedTerms({ translatedText: "NOVA", targetLanguage: "ko" }), []);
});


test("Korean prompt replaces generic foreign words and preserves only explicit glossary spellings", () => {
  const korean = buildPolishSystemPrompt("ko", { glossary: "NOVA = NOVA" });
  assert.match(korean, /ordinary English words.*natural Korean/u);
  assert.match(korean, /Capitalization is not/u);
  assert.match(korean, /explicit.*glossary/u);
  assert.doesNotMatch(korean, /Keep proper nouns .*untranslated and unchanged/u);
  assert.match(buildPolishSystemPrompt("en"), /Keep proper nouns .*untranslated and unchanged/u);
});


test("protected term normalization and literal boundaries do not turn registered punctuation into patterns", () => {
  assert.equal(isFixedTargetOutputSupported("Café", "ko", { protectedTerms: ["Cafe\u0301"] }), true);
  const options = { protectedTerms: ["C++", "A.B"] };
  assert.equal(isFixedTargetOutputSupported("C++와 A.B를 설명합니다.", "ko", options), true);
  assert.equal(isFixedTargetOutputSupported("AXB를 설명합니다.", "ko", options), false);
  assert.equal(isFixedTargetOutputSupported("C++Code를 설명합니다.", "ko", options), false);
});
