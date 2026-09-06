import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_GLOSSARY_SELECTIONS,
  normalizeGlossarySelectionKey,
  resolveGlossarySelection,
} from "../packages/caption-core/index.js";

function glossary(id, { priority = 50, source = "AI Agent", target = "AI 에이전트", aliases = [], tags = [] } = {}) {
  return {
    id,
    label: id,
    priority,
    document: {
      schemaVersion: 1,
      name: id,
      domain: id,
      sourceLanguage: "en",
      targetLanguages: ["ko"],
      terms: [{
        id: `${id}-term`,
        source,
        translations: { ko: target },
        aliases,
        tags,
        priority,
        provenance: { kind: "manual", label: id },
      }],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      version: 1,
    },
  };
}

test("selection keys normalize NFC, case, whitespace, and hyphen variants", () => {
  assert.equal(normalizeGlossarySelectionKey("  AΙ‐Agent  "), "aι agent");
  assert.equal(normalizeGlossarySelectionKey("AI---AGENT"), "ai agent");
  assert.equal(normalizeGlossarySelectionKey("호텔  운영"), "호텔 운영");
});

test("multi-selection deduplicates by target language and merges aliases and tags", () => {
  const catalog = [
    glossary("ai_ax", { aliases: ["agentic AI"], tags: ["ai"] }),
    glossary("common_business", {
      source: "ai-agent",
      aliases: ["AI assistant"],
      tags: ["business"],
    }),
  ];
  const result = resolveGlossarySelection({ catalog, selectedIds: ["common_business", "ai_ax"] });

  assert.equal(result.ok, true);
  assert.equal(result.document.terms.length, 1);
  assert.deepEqual(result.selectedIds, ["ai_ax", "common_business"]);
  assert.deepEqual(result.document.terms[0].aliases, ["AI assistant", "agentic AI"]);
  assert.deepEqual(result.document.terms[0].tags, ["ai", "business"]);
  assert.equal(result.stats.duplicateTermsRemoved, 1);
  assert.equal(result.stats.unresolvedConflicts, 0);
});

test("selection is deterministic regardless of click order", () => {
  const catalog = [glossary("ai_ax"), glossary("common_business", { source: "호텔", target: "hotel" })];
  const left = resolveGlossarySelection({ catalog, selectedIds: ["ai_ax", "common_business"] });
  const right = resolveGlossarySelection({ catalog: [...catalog].reverse(), selectedIds: ["common_business", "ai_ax"] });

  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(left.fingerprint, right.fingerprint);
  assert.deepEqual(left.document, right.document);
});

test("higher priority wins while same-priority translation conflicts are reported", () => {
  const resolved = resolveGlossarySelection({
    catalog: [
      glossary("common_business", { target: "인공지능 에이전트", priority: 40 }),
      glossary("ai_ax", { source: "ai-agent", target: "AI 에이전트", priority: 70 }),
    ],
    selectedIds: ["common_business", "ai_ax"],
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.document.terms[0].translations.ko, "AI 에이전트");

  const conflicted = resolveGlossarySelection({
    catalog: [
      glossary("left", { target: "인공지능 에이전트", priority: 70 }),
      glossary("right", { source: "ai-agent", target: "AI 에이전트", priority: 70 }),
    ],
    selectedIds: ["right", "left"],
  });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.code, "GLOSSARY_TRANSLATION_CONFLICT");
  assert.deepEqual(conflicted.conflicts, [{
    source: "AI Agent",
    targetLanguage: "ko",
    priority: 70,
    translations: ["AI 에이전트", "인공지능 에이전트"],
    glossaryIds: ["left", "right"],
  }]);
});

test("selection rejects unknown, repeated, incompatible, and over-limit selections", () => {
  const base = glossary("one");
  assert.equal(resolveGlossarySelection({ catalog: [base], selectedIds: ["missing"] }).code, "UNKNOWN_GLOSSARY_SELECTION");
  assert.equal(resolveGlossarySelection({ catalog: [base], selectedIds: ["one", "one"] }).code, "DUPLICATE_GLOSSARY_SELECTION");
  assert.equal(resolveGlossarySelection({
    catalog: Array.from({ length: MAX_GLOSSARY_SELECTIONS + 1 }, (_, index) => glossary(`g${index}`)),
    selectedIds: Array.from({ length: MAX_GLOSSARY_SELECTIONS + 1 }, (_, index) => `g${index}`),
  }).code, "TOO_MANY_GLOSSARY_SELECTIONS");

  const japanese = {
    ...base,
    id: "ja",
    document: {
      ...base.document,
      name: "ja",
      sourceLanguage: "ko",
      targetLanguages: ["ja"],
      terms: [{
        ...base.document.terms[0],
        id: "ja-term",
        source: "호텔",
        translations: { ja: "ホテル" },
      }],
    },
  };
  assert.equal(resolveGlossarySelection({ catalog: [base, japanese], selectedIds: ["one", "ja"] }).code, "INCOMPATIBLE_GLOSSARY_LANGUAGES");
  assert.equal(resolveGlossarySelection({
    catalog: [{ id: "invalid", document: { schemaVersion: 9 } }],
    selectedIds: ["invalid"],
  }).code, "INVALID_GLOSSARY_CATALOG");
});
