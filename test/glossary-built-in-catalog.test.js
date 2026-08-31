import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILT_IN_GLOSSARY_CATALOG,
  BUILT_IN_GLOSSARY_IDS,
  resolveGlossarySelection,
} from "../packages/caption-core/index.js";

const EXPECTED_IDS = [
  "common_business",
  "ai_ax",
  "commercial_real_estate",
  "hospitality",
  "fnb_retail",
  "proper_nouns",
  "ko_ja_idioms",
];

test("generated built-in catalog exposes the seven stable industry IDs", () => {
  assert.deepEqual(BUILT_IN_GLOSSARY_IDS, EXPECTED_IDS);
  assert.deepEqual(BUILT_IN_GLOSSARY_CATALOG.map(({ id }) => id), EXPECTED_IDS);
  for (const entry of BUILT_IN_GLOSSARY_CATALOG) {
    assert.ok(entry.document.terms.length > 0, entry.id);
    assert.equal(entry.analysis.unresolvedConflicts, 0, entry.id);
    assert.ok(entry.analysis.sourceRecords >= entry.document.terms.length, entry.id);
    assert.match(entry.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  }
  assert.deepEqual(BUILT_IN_GLOSSARY_CATALOG.find(({ id }) => id === "fnb_retail").document.targetLanguages, ["en", "ja"]);
});

test("every valid five-way built-in selection compiles without duplicate source-target keys", () => {
  for (let omitted = 0; omitted < 3; omitted += 1) {
    const selectedIds = EXPECTED_IDS.slice(omitted, omitted + 5);
    const sourceLanguage = BUILT_IN_GLOSSARY_CATALOG.find(({ id }) => id === selectedIds[0]).document.sourceLanguage;
    const compatibleIds = selectedIds.filter((id) => BUILT_IN_GLOSSARY_CATALOG
      .find((entry) => entry.id === id).document.sourceLanguage === sourceLanguage);
    const result = resolveGlossarySelection({ catalog: BUILT_IN_GLOSSARY_CATALOG, selectedIds: compatibleIds });
    assert.equal(result.ok, true, JSON.stringify(result));
    const keys = result.document.terms.flatMap((term) => Object.keys(term.translations)
      .map((language) => `${term.source.normalize("NFC").toLocaleLowerCase("und")}|${language}`));
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(result.stats.unresolvedConflicts, 0);
  }
});

test("2026-08 live translation API study terms are classified into ai_ax and proper_nouns", () => {
  const aiAx = BUILT_IN_GLOSSARY_CATALOG.find(({ id }) => id === "ai_ax");
  const properNouns = BUILT_IN_GLOSSARY_CATALOG.find(({ id }) => id === "proper_nouns");
  const translationOf = (entry, source) =>
    entry.document.terms.find((term) => term.source === source)?.translations.en;

  assert.equal(translationOf(aiAx, "세션 재개"), "session resumption");
  assert.equal(translationOf(aiAx, "사용자 정의 어휘"), "custom vocabulary");
  assert.equal(translationOf(aiAx, "임시 토큰"), "ephemeral token");
  assert.equal(translationOf(aiAx, "발언권"), "speaking floor");
  assert.equal(translationOf(aiAx, "화자 분리"), "speaker diarization");
  assert.equal(translationOf(properNouns, "제미나이 라이브 트랜슬레이트"), "Gemini Live Translate");
  assert.equal(translationOf(properNouns, "수파베이스"), "Supabase");

  // The API-study terms must not collide with pre-existing pack entries.
  for (const entry of [aiAx, properNouns]) {
    const keys = entry.document.terms.map((term) => term.source.normalize("NFC").toLocaleLowerCase("und"));
    assert.equal(new Set(keys).size, keys.length, entry.id);
  }
});

test("generated catalog folds common Korean loanword spelling variants before runtime selection", () => {
  for (const id of ["commercial_real_estate", "hospitality"]) {
    const entry = BUILT_IN_GLOSSARY_CATALOG.find((item) => item.id === id);
    const culture = entry.document.terms.filter((term) => term.translations.en === "K-culture");
    assert.equal(culture.length, 1, id);
    assert.equal(culture[0].source, "K-컬처");
    assert.equal(entry.document.terms.some((term) => term.source === "K컬쳐"), false, id);
  }
});
