import assert from "node:assert/strict";
import test from "node:test";

import type { GlossaryDocumentV1 } from "@/lib/glossary-presets/types";
import { buildEditedGlossaryDocument, extractedCandidatesToEditable } from "./glossary-controller";

const baseDocument: GlossaryDocumentV1 = {
  schemaVersion: 1, name: "실적 발표", domain: "CRE", sourceLanguage: "ko", targetLanguages: ["en"],
  terms: [], createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z", version: 1,
};

test("AI extraction remains review-only until each candidate is explicitly approved", () => {
  const [candidate] = extractedCandidatesToEditable([{
    id: "candidate-0001", source: "순영업소득", translations: { en: "NOI" }, aliases: [], pronunciation: null,
    doNotTranslate: false, forbiddenTranslations: [], context: null, examples: [], tags: [], priority: 50,
    provenance: { kind: "ai_extracted", label: null },
  }]);
  assert.ok(candidate);
  const edits = { name: "실적 발표", domain: "CRE", terms: [{ id: candidate.term.id, source: candidate.term.source, target: "NOI", aliases: "" }] };
  const pending = buildEditedGlossaryDocument(baseDocument, [candidate], edits, "2026-08-15T01:00:00Z");
  assert.equal(pending.document?.terms.length, 0);
  const approved = buildEditedGlossaryDocument(baseDocument, [{ ...candidate, status: "approved" }], edits, "2026-08-15T01:00:00Z");
  assert.equal(approved.document?.terms.length, 1);
  assert.equal(approved.document?.terms[0]?.provenance.kind, "ai_extracted");
});

test("invalid edits return field issues without replacing the current document", () => {
  const result = buildEditedGlossaryDocument(baseDocument, [], { name: " ", domain: "CRE", terms: [] }, "2026-08-15T01:00:00Z");
  assert.equal(result.document, null);
  assert.equal(result.issues[0]?.fieldId, "glossary-preset-name");
  assert.equal(baseDocument.name, "실적 발표");
  assert.equal(baseDocument.version, 1);
});


test("protected terms save without translations and multilingual edits retain every lane", () => {
  const term = { id: "brand", source: "NOVA", translations: {}, aliases: [], pronunciation: null,
    doNotTranslate: true, forbiddenTranslations: [], context: null, examples: [], tags: [], priority: 50,
    provenance: { kind: "manual" as const, label: null } };
  const current = { ...baseDocument, targetLanguages: ["en", "ja", "zh-Hans"] as const };
  const protectedResult = buildEditedGlossaryDocument(current, [{ term, status: "approved" }],
    { name: "브랜드", domain: "", terms: [{ id: "brand", source: "NOVA", target: "", aliases: "" }] }, current.updatedAt);
  assert.deepEqual(protectedResult.issues, []);
  assert.deepEqual(protectedResult.document?.terms[0]?.translations, {});
  const translated = buildEditedGlossaryDocument(current, [{ term: { ...term, doNotTranslate: false }, status: "approved" }],
    { name: "다국어", domain: "", terms: [{ id: "brand", source: "매출", target: "Revenue", aliases: "", translations: { en: "Revenue", ja: "売上", "zh-Hans": "收入" }, doNotTranslate: false }] }, current.updatedAt);
  assert.deepEqual(translated.issues, []);
  assert.deepEqual(translated.document?.terms[0]?.translations, { en: "Revenue", ja: "売上", "zh-Hans": "收入" });
});


test("turning protection on clears conflicting translations and preserves source metadata", () => {
  const term = { id: "company", source: "NOVA", translations: { en: "Nova", ja: "ノヴァ" }, aliases: ["노바"], pronunciation: null,
    doNotTranslate: false, forbiddenTranslations: [], context: "제품 이름", examples: [], tags: [], priority: 70,
    provenance: { kind: "manual" as const, label: null } };
  const result = buildEditedGlossaryDocument({ ...baseDocument, targetLanguages: ["en", "ja"] }, [{ term, status: "approved" }],
    { name: "브랜드", domain: "", terms: [{ id: term.id, source: "NOVA", target: "Nova", aliases: "노바", doNotTranslate: true }] }, baseDocument.updatedAt);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.document?.terms[0]?.translations, {});
  assert.equal(result.document?.terms[0]?.doNotTranslate, true);
  assert.equal(result.document?.terms[0]?.context, "제품 이름");
  assert.deepEqual(term.translations, { en: "Nova", ja: "ノヴァ" });
});

test("separate PDF imports preserve prior candidates even when extraction reuses identifiers", () => {
  const term = { id: "candidate-0001", source: "매출", translations: { en: "Revenue" }, aliases: [], pronunciation: null,
    doNotTranslate: false, forbiddenTranslations: [], context: null, examples: [], tags: [], priority: 50,
    provenance: { kind: "ai_extracted" as const, label: "first.pdf" } };
  const first = extractedCandidatesToEditable([term], "first-import");
  const second = extractedCandidatesToEditable([{ ...term, source: "영업이익", translations: { en: "Operating income" }, provenance: { kind: "ai_extracted", label: "second.pdf" } }], "second-import");
  assert.notEqual(first[0].term.id, second[0].term.id);
  assert.equal(first[0].term.source, "매출");
  const approved = [...first, ...second].map((item) => ({ ...item, status: "approved" as const }));
  const result = buildEditedGlossaryDocument(baseDocument, approved, { name: baseDocument.name, domain: baseDocument.domain,
    terms: approved.map(({ term }) => ({ id: term.id, source: term.source, target: term.translations.en, aliases: "" })) }, baseDocument.updatedAt);
  assert.deepEqual(result.issues, []);
  assert.equal(result.document?.terms.length, 2);
  assert.deepEqual(result.document?.terms.map((item) => item.provenance.label), ["first.pdf", "second.pdf"]);
});
