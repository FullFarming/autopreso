// Regenerates src/glossary-preset-library.js from the editable glossary sources
// in docs/, so the shipped preset and the reviewable text file cannot drift:
//   node scripts/generate-glossary-library.mjs
//
// The glossary BODY lives in docs/*.txt (that is what a human edits). The
// preset metadata — id, label, industry, language pair, domain — lives here,
// because it is code-facing and never appears in the text file.
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fingerprintGlossaryDocumentV1,
  parseGlossaryDocumentV1,
} from "../packages/caption-core/glossary-document.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "src", "glossary-preset-library.js");
const CATALOG_OUT = path.join(ROOT, "packages", "caption-core", "built-in-glossary-catalog.js");

const BUILT_IN_CATEGORIES = Object.freeze([
  { id: "common_business", label: "공통 비즈니스·관용어", description: "발표·협상·시장 문맥에 공통으로 쓰는 관용 표현", priority: 40, targetLanguages: ["en"] },
  { id: "ai_ax", label: "AI·AX", description: "생성형 AI, 데이터, 자동화 및 AX 전환 용어", priority: 70, targetLanguages: ["en"] },
  { id: "commercial_real_estate", label: "상업용 부동산", description: "임대차, 투자, 자본시장, 개발 및 자산관리 용어", priority: 60, targetLanguages: ["en"] },
  { id: "hospitality", label: "호텔·호스피탈리티", description: "호텔 투자, 개발, 운영, 브랜드 및 성과지표 용어", priority: 70, targetLanguages: ["en"] },
  { id: "fnb_retail", label: "F&B·리테일 임대차", description: "외식 운영, 리테일 입점 및 한영·한일 임대차 용어", priority: 70, targetLanguages: ["en", "ja"] },
  { id: "proper_nouns", label: "회사·브랜드·고유명사", description: "회사, 기관, 브랜드, 프로젝트 및 지명 표기", priority: 80, targetLanguages: ["en"] },
  { id: "ko_ja_idioms", label: "한국어↔일본어 관용어", description: "시장·투자·비즈니스 문맥의 한일 관용 표현", priority: 60, targetLanguages: ["ja"] },
]);

const RAW_SOURCES = Object.freeze([
  { source: "docs/glossary-default-cre-ai-2026-07.txt", authority: 50 },
  { source: "docs/glossary-hospitality-2026-06-pairs.txt", authority: 40 },
  { source: "docs/glossary-hotel-session-2026-07.txt", authority: 60 },
  { source: "docs/glossary-fnb-leasing-ko-ja.txt", authority: 45 },
  { source: "docs/glossary-idioms-ja-2026-06.txt", authority: 50 },
  { source: "docs/glossary-live-translate-api-2026-08.txt", authority: 55 },
]);

function addDeterministicNumberAuthority(glossary) {
  const header = "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]";
  const authority = "- 이 섹션은 의미·통화 보존 가이드다. 실제 자릿수 산술과 최종 표기는 공용 deterministic caption normalizer 결과를 따르며, 환율 환산은 금지한다.";
  return glossary.replace(header, `${header}\n${authority}`);
}

function normalizeSelectionKey(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/컬쳐/gu, "컬처")
    .replace(/[‐‑‒–—―-]+/gu, " ")
    .replace(/\b([a-z])\s+(?=[가-힣])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeDocumentLookupKey(value) {
  return String(value ?? "").normalize("NFC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function classifyRecord(source, section) {
  if (source.includes("glossary-idioms-ja")) {
    return /English\s*=/iu.test(section) ? null : "ko_ja_idioms";
  }
  if (source.includes("glossary-fnb-leasing")) {
    return /일본어 비즈니스 관용/iu.test(section) ? "ko_ja_idioms" : "fnb_retail";
  }
  if (source.includes("glossary-hotel-session")) {
    if (/고유명사|지명|기관/iu.test(section)) return "proper_nouns";
    return "hospitality";
  }
  if (source.includes("glossary-hospitality")) {
    if (/회사명|브랜드 고유명사|패널 3사/iu.test(section)) return "proper_nouns";
    if (/관용|일반 표현/iu.test(section)) return "common_business";
    return "hospitality";
  }
  if (/고유명사|지명/iu.test(section)) return "proper_nouns";
  if (/AI[·/]AX/iu.test(section)) return "ai_ax";
  if (/호텔|리빙/iu.test(section)) return "hospitality";
  if (/리테일/iu.test(section)) return "fnb_retail";
  if (/관용|실적|직위|리스크|영어 표현|영어 라벨|영어 슬로건/iu.test(section)) return "common_business";
  return "commercial_real_estate";
}

function directionFor(source, section) {
  if (/번역 메모리/iu.test(section)) return null;
  if (source.includes("glossary-idioms-ja") && /English\s*=/iu.test(section)) return null;
  if (/^(?:영어|일본어|日本語)|\(English\s*=/iu.test(section)) return "reverse";
  return "forward";
}

function stripEditorialNote(value) {
  return value
    .replace(/\s*[（(][^）)]*(?:=|NEVER|직역|오역|문맥|뜻)[^）)]*[）)]\s*$/iu, "")
    .trim();
}

function hasStrongHangul(value) {
  return (value.match(/[가-힣]/gu) ?? []).length >= 1;
}

function hasStrongLatin(value) {
  return (value.match(/[A-Za-z]/gu) ?? []).length >= 2;
}

function parseRawSource(rawSource) {
  const text = fs.readFileSync(path.join(ROOT, rawSource.source), "utf8");
  const records = [];
  let section = "기타";
  for (const [zeroBasedLine, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    const header = line.match(/^\[(.+)\]$/u);
    if (header) {
      section = header[1].normalize("NFC").trim();
      continue;
    }
    if (!line || line.startsWith("-") || !section || /번역 메모리/iu.test(section)) continue;
    const pair = line.match(/^(.+?)\s*(?:=|→|->|↔)\s*(.+)$/u);
    if (!pair) continue;
    const direction = directionFor(rawSource.source, section);
    if (!direction) continue;
    let left = pair[1].normalize("NFC").trim();
    let right = pair[2].normalize("NFC").trim();
    if (!left || !right) continue;
    if (direction === "forward" && hasStrongLatin(left) && hasStrongHangul(right)) continue;
    if (direction === "reverse") [left, right] = [right, left];
    left = stripEditorialNote(left);
    right = stripEditorialNote(right);
    if (Array.from(left).length > 240 || Array.from(right).length > 240) continue;
    const categoryId = classifyRecord(rawSource.source, section);
    if (!categoryId) continue;
    records.push({
      categoryId,
      source: left,
      target: right,
      section,
      sourceFile: rawSource.source,
      line: zeroBasedLine + 1,
      authority: rawSource.authority,
      targetLanguage: rawSource.source.includes("ko-ja") || rawSource.source.includes("idioms-ja") ? "ja" : "en",
    });
  }
  return records;
}

function createCategoryDocument(category, records) {
  const bySource = new Map();
  let resolvedConflicts = 0;
  for (const record of records) {
    const key = normalizeSelectionKey(record.source);
    const aggregate = bySource.get(key) ?? { records: [], targets: new Map() };
    aggregate.records.push(record);
    const candidates = aggregate.targets.get(record.targetLanguage) ?? [];
    candidates.push(record);
    aggregate.targets.set(record.targetLanguage, candidates);
    bySource.set(key, aggregate);
  }

  const sourceKeys = new Set(bySource.keys());
  const usedCanonicalSourceKeys = new Set();
  const terms = [...bySource.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, aggregate]) => {
      const ranked = [...aggregate.records].sort(compareSourceAuthority);
      const canonical = ranked.find(({ source }) => !usedCanonicalSourceKeys.has(normalizeDocumentLookupKey(source))) ?? ranked[0];
      usedCanonicalSourceKeys.add(normalizeDocumentLookupKey(canonical.source));
      const translations = {};
      for (const [targetLanguage, languageCandidates] of [...aggregate.targets].sort(([left], [right]) => left.localeCompare(right, "en"))) {
        const candidates = languageCandidates.sort(compareSourceAuthority);
        const winningAuthority = candidates[0].authority;
        const topTargets = [...new Set(candidates
          .filter(({ authority }) => authority === winningAuthority)
          .map(({ target }) => target))].sort();
        if (topTargets.length > 1) resolvedConflicts += topTargets.length - 1;
        translations[targetLanguage] = topTargets[0];
      }
      const aliases = [...new Set(aggregate.records.map(({ source }) => source))]
        .filter((source) => source !== canonical.source && !sourceKeys.has(normalizeSelectionKey(source)))
        .sort()
        .slice(0, 16);
      return {
        id: `term-${createHash("sha256").update(`${category.id}:${key}`, "utf8").digest("hex").slice(0, 20)}`,
        source: canonical.source,
        translations,
        aliases,
        pronunciation: null,
        doNotTranslate: false,
        forbiddenTranslations: [],
        context: canonical.section,
        examples: [],
        tags: [category.id, path.basename(canonical.sourceFile, ".txt")].sort(),
        priority: category.priority,
        provenance: { kind: "import", label: `${canonical.sourceFile}:${canonical.line}` },
      };
    });

  const document = parseGlossaryDocumentV1({
    schemaVersion: 1,
    name: category.label,
    domain: category.description,
    sourceLanguage: "ko",
    targetLanguages: category.targetLanguages,
    terms: removeConflictingAliases(terms),
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    version: 1,
  });
  return {
    ...category,
    document,
    fingerprint: fingerprintGlossaryDocumentV1(document),
    analysis: {
      sourceRecords: records.length,
      uniqueTerms: document.terms.length,
      duplicateTermsRemoved: records.length - document.terms.length,
      resolvedConflicts,
      unresolvedConflicts: 0,
    },
  };
}

function removeConflictingAliases(terms) {
  const sourceKeys = new Set(terms.map(({ source }) => normalizeDocumentLookupKey(source)));
  const usedAliasKeys = new Set();
  return terms.map((term) => ({
    ...term,
    aliases: term.aliases.filter((alias) => {
      const key = normalizeDocumentLookupKey(alias);
      if (!key || sourceKeys.has(key) || usedAliasKeys.has(key)) return false;
      usedAliasKeys.add(key);
      return true;
    }),
  }));
}

function compareSourceAuthority(left, right) {
  return right.authority - left.authority
    || left.sourceFile.localeCompare(right.sourceFile, "en")
    || left.line - right.line
    || left.target.localeCompare(right.target, "und");
}

function buildBuiltInCatalog() {
  const records = RAW_SOURCES.flatMap(parseRawSource);
  return BUILT_IN_CATEGORIES.map((category) => createCategoryDocument(
    category,
    records.filter(({ categoryId }) => categoryId === category.id),
  ));
}

const PRESETS = [
  {
    id: "default-cre-ai-en-ko",
    label: "기본 — 상업용 부동산 컨설팅 (EN↔KO)",
    industry: "상업용 부동산 컨설팅 · 비즈니스 관용어 · AI/AX",
    languagePair: { a: "en", b: "ko" },
    source: "docs/glossary-default-cre-ai-2026-07.txt",
    domain:
      "Commercial real estate consulting — office leasing and tenant representation, capital markets and investment sales, project & development services, property and asset management, valuation & advisory, retail and logistics — plus enterprise AI/AX adoption. A live bilingual (KO/EN) business presentation, townhall, panel, or client meeting. Ambiguous terms take their CRE/investment or AI-industry sense: conversion = 용도전환, operator = 운영사, agent = AI 에이전트, exit = 투자 회수, prompt = 프롬프트, PM = property management (never project management), disposition = 매각 (never waste disposal), stock = existing building stock (never equities), assigned/closed = 수임/거래 종결, deliver = 성과로 이어지다 (never courier delivery).",
  },
  {
    id: "hotel-session-2026-en-ko",
    label: "호텔 세션 (Hospitality 2026, EN↔KO)",
    industry: "상업용 부동산 — 호텔/호스피탈리티 세션 전용",
    languagePair: { a: "en", b: "ko" },
    source: "docs/glossary-hotel-session-2026-07.txt",
    domain:
      "Commercial real estate — hotel/hospitality investment, development, operations, and capital markets. The 2026 hospitality market session (Hilton, TheHyoosik, First Cabin, CMG deals). All ambiguous terms take their hotel-investment sense (conversion = 호텔 전환, operator = 운영사, ADR/RevPAR/GOP stay verbatim).",
  },
];

const entries = PRESETS.map((preset) => {
  const sourceGlossary = fs.readFileSync(path.join(ROOT, preset.source), "utf8").replace(/\n+$/u, "");
  const glossary = preset.id === "default-cre-ai-en-ko"
    ? addDeterministicNumberAuthority(sourceGlossary)
    : sourceGlossary;
  return `  {
    id: ${JSON.stringify(preset.id)},
    label: ${JSON.stringify(preset.label)},
    industry: ${JSON.stringify(preset.industry)},
    languagePair: ${JSON.stringify(preset.languagePair)},
    domain: ${JSON.stringify(preset.domain)},
    glossary: ${JSON.stringify(glossary)},
  },`;
});

const js = `// AUTO-GENERATED by scripts/generate-glossary-library.mjs — do not edit the
// glossary strings by hand. Source of truth for the glossary BODY:
${PRESETS.map((preset) => `//   ${preset.id} -> ${preset.source}`).join("\n")}
// Preset metadata (label, industry, language pair, domain) lives in that script.
// One-click presets for the dashboard: the full everyday CRE glossary and the
// preserved hotel-session glossary. Runtime provider prompts use a bounded
// relevance retriever; the local corpus is intentionally not truncated here.

export const GLOSSARY_PRESET_LIBRARY = [
${entries.join("\n")}
];
`;

fs.writeFileSync(OUT, js);
console.log(`wrote ${OUT} (${js.length} chars, ${PRESETS.length} presets)`);

const builtInCatalog = buildBuiltInCatalog();
const catalogJs = `// AUTO-GENERATED by scripts/generate-glossary-library.mjs — do not edit.
// Structured, de-duplicated GlossaryDocumentV1 records generated from docs/glossary-*.txt.
import { parseGlossaryDocumentV1 } from "./glossary-document.js";

const RAW_BUILT_IN_GLOSSARY_CATALOG = ${JSON.stringify(builtInCatalog)};

export const BUILT_IN_GLOSSARY_IDS = Object.freeze(${JSON.stringify(BUILT_IN_CATEGORIES.map(({ id }) => id))});

export const BUILT_IN_GLOSSARY_CATALOG = Object.freeze(RAW_BUILT_IN_GLOSSARY_CATALOG.map((entry) => Object.freeze({
  ...entry,
  analysis: Object.freeze({ ...entry.analysis }),
  document: parseGlossaryDocumentV1(entry.document),
})));

export function getBuiltInGlossary(id) {
  return BUILT_IN_GLOSSARY_CATALOG.find((entry) => entry.id === id) ?? null;
}
`;

fs.writeFileSync(CATALOG_OUT, catalogJs);
console.log(`wrote ${CATALOG_OUT} (${catalogJs.length} chars, ${builtInCatalog.length} categories)`);
