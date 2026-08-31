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
