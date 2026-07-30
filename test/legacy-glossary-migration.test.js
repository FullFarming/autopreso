import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_SETTINGS,
} from "../src/settings-store.js";

const LEGACY_GLOSSARY_URL = new URL("../docs/glossary-default-cre-ai-2026-07.txt", import.meta.url);
const LEGACY_DOMAIN = "Commercial real estate consulting — office leasing and tenant representation, capital markets and investment sales, project & development services, property and asset management, valuation & advisory, retail and logistics — plus enterprise AI/AX adoption. A live bilingual (KO/EN) business presentation, townhall, panel, or client meeting. Ambiguous terms take their CRE/investment or AI-industry sense: conversion = 용도전환, operator = 운영사, agent = AI 에이전트, exit = 투자 회수, prompt = 프롬프트, PM = property management (never project management), disposition = 매각 (never waste disposal), stock = existing building stock (never equities), assigned/closed = 수임/거래 종결, deliver = 성과로 이어지다 (never courier delivery).";
const PREVIOUS_COMPACT_DOMAIN = "Commercial real estate consulting — leasing and tenant representation, capital markets and investment sales, development, asset management, valuation, retail and logistics — plus enterprise AI/AX. Use CRE meanings for ambiguous terms: conversion = 용도전환, operator = 운영사, exit = 투자 회수, PM = property management, disposition = 매각, stock = existing building stock, and agent = AI 에이전트.";
const PREVIOUS_COMPACT_HEADERS = new Set([
  "[규칙]",
  "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]",
  "[약어·중의어 주의 — 반드시 문맥으로 판단]",
  "[고유명사 — 회사/기관 (한국어 = English)]",
  "[상업용 부동산 — 임대차/오피스 (한국어 = English)]",
  "[상업용 부동산 — 투자/자본시장 (한국어 = English)]",
  "[AI·AX (한국어 = English)]",
  "[상업용 부동산 컨설팅 — 서비스 라인/수임 (한국어 = English)]",
  "[상업용 부동산 — 개발/인허가 심화 (한국어 = English)]",
  "[실적·조직 지표 (한국어 = English)]",
  "[직위·조직 단위 (한국어 = English)]",
  "[고유명사 추가 — 회사/브랜드 (한국어 = English)]",
  "[고유명사 추가 — 자산/프로젝트 (한국어 = English)]",
  "[캐피탈마켓 심화 — 자금조달/딜 소싱 (한국어 = English)]",
  "[임차인 서비스 심화 (한국어 = English)]",
  "[호텔·리빙 심화 (한국어 = English)]",
  "[리테일 심화 (한국어 = English)]",
  "[리스크·거버넌스 (한국어 = English)]",
  "[고유명사 추가 2 — 고객사/투자자 (한국어 = English)]",
  "[고유명사 추가 2 — 자산/프로젝트 (한국어 = English)]",
]);
const PREVIOUS_FOCUSED_DOMAIN = "Commercial real estate consulting and capital markets. Preserve CRE acronyms and registered proper names. Use CRE meanings for conversion, operator, exit, PM, disposition, stock, and yield. Never infer a domain term absent from the source.";
const PREVIOUS_FOCUSED_HEADERS = new Set([
  "[규칙]",
  "[약어·중의어 주의 — 반드시 문맥으로 판단]",
  "[고유명사 — 회사/기관 (한국어 = English)]",
  "[상업용 부동산 — 임대차/오피스 (한국어 = English)]",
  "[상업용 부동산 — 투자/자본시장 (한국어 = English)]",
  "[상업용 부동산 컨설팅 — 서비스 라인/수임 (한국어 = English)]",
  "[상업용 부동산 — 개발/인허가 심화 (한국어 = English)]",
  "[고유명사 추가 — 회사/브랜드 (한국어 = English)]",
  "[고유명사 추가 — 자산/프로젝트 (한국어 = English)]",
  "[캐피탈마켓 심화 — 자금조달/딜 소싱 (한국어 = English)]",
  "[임차인 서비스 심화 (한국어 = English)]",
  "[고유명사 추가 2 — 고객사/투자자 (한국어 = English)]",
  "[고유명사 추가 2 — 자산/프로젝트 (한국어 = English)]",
]);
const RELEASED_FOCUSED_HEADERS = new Set([
  ...PREVIOUS_FOCUSED_HEADERS,
  "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]",
  "[지명 (한국어 = English)]",
  "[영어 라벨 = 한국어 (덱 표기 고정)]",
]);

const noCodexAuth = () => null;

function compactGlossaryBySections(glossary, allowedHeaders) {
  const matches = [...String(glossary ?? "").matchAll(/^\[[^\n]+\]$/gmu)];
  if (matches.length === 0) return "";
  return matches
    .map((match, index) => String(glossary).slice(match.index, matches[index + 1]?.index ?? String(glossary).length).trim())
    .filter((section) => allowedHeaders.has(section.split("\n", 1)[0]))
    .join("\n\n");
}

async function createLegacySettingsFile(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nova-legacy-glossary-"));
  const filePath = path.join(directory, "settings.json");
  const legacyGlossary = await fs.readFile(LEGACY_GLOSSARY_URL, "utf8");
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.subtitle = {
    ...settings.subtitle,
    languagePair: { a: "en", b: "ko" },
    glossaryPresetId: "",
    glossaryPresetName: "",
    glossary: legacyGlossary,
    translationDomain: LEGACY_DOMAIN,
    tone: "business",
    ...overrides,
  };
  await fs.writeFile(filePath, JSON.stringify(settings));
  return { filePath, legacyGlossary };
}

test("exact shipped legacy full glossary advances without shrinking and keeps tone", async () => {
  const { filePath, legacyGlossary } = await createLegacySettingsFile();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });

  const settings = await store.load();

  assert.equal(settings.subtitle.glossaryPresetId, DEFAULT_SUBTITLE_SETTINGS.glossaryPresetId);
  assert.equal(settings.subtitle.glossaryPresetName, "");
  assert.ok(settings.subtitle.glossary.length >= legacyGlossary.replace(/\n+$/u, "").length);
  assert.equal(settings.subtitle.glossary, DEFAULT_SUBTITLE_SETTINGS.glossary);
  assert.equal(settings.subtitle.translationDomain, DEFAULT_SUBTITLE_SETTINGS.translationDomain);
  assert.equal(settings.subtitle.tone, "business");
});

test("a one-character Custom glossary change is never mistaken for the shipped legacy default", async () => {
  const { filePath, legacyGlossary } = await createLegacySettingsFile({
    glossary: `${await fs.readFile(LEGACY_GLOSSARY_URL, "utf8")}!`,
  });
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });

  const settings = await store.load();

  assert.equal(settings.subtitle.glossaryPresetId, "");
  assert.equal(settings.subtitle.glossary, `${legacyGlossary}!`);
  assert.equal(settings.subtitle.translationDomain, LEGACY_DOMAIN);
  assert.equal(settings.subtitle.tone, "business");
});

test("a one-character Custom domain change preserves both legacy fields", async () => {
  const { filePath, legacyGlossary } = await createLegacySettingsFile({
    translationDomain: `${LEGACY_DOMAIN}!`,
  });
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });

  const settings = await store.load();

  assert.equal(settings.subtitle.glossaryPresetId, "");
  assert.equal(settings.subtitle.glossary, legacyGlossary);
  assert.equal(settings.subtitle.translationDomain, `${LEGACY_DOMAIN}!`);
  assert.equal(settings.subtitle.tone, "business");
});

test("the previous 15k compact default advances to the restored full CRE preset", async () => {
  const fullGlossary = await fs.readFile(LEGACY_GLOSSARY_URL, "utf8");
  const previousCompactGlossary = compactGlossaryBySections(fullGlossary, PREVIOUS_COMPACT_HEADERS);
  assert.equal(previousCompactGlossary.length, 15_091);
  const { filePath } = await createLegacySettingsFile({
    glossaryPresetId: "default-cre-ai-en-ko",
    glossary: previousCompactGlossary,
    translationDomain: PREVIOUS_COMPACT_DOMAIN,
  });

  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();

  assert.equal(settings.subtitle.glossaryPresetId, DEFAULT_SUBTITLE_SETTINGS.glossaryPresetId);
  assert.equal(settings.subtitle.glossary, DEFAULT_SUBTITLE_SETTINGS.glossary);
  assert.equal(settings.subtitle.translationDomain, DEFAULT_SUBTITLE_SETTINGS.translationDomain);
  assert.equal(settings.subtitle.tone, "business");
});

test("a one-character edit to the previous compact default remains Custom", async () => {
  const fullGlossary = await fs.readFile(LEGACY_GLOSSARY_URL, "utf8");
  const customGlossary = `${compactGlossaryBySections(fullGlossary, PREVIOUS_COMPACT_HEADERS)}!`;
  const { filePath } = await createLegacySettingsFile({
    glossaryPresetId: "",
    glossary: customGlossary,
    translationDomain: PREVIOUS_COMPACT_DOMAIN,
  });

  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();

  assert.equal(settings.subtitle.glossaryPresetId, "");
  assert.equal(settings.subtitle.glossary, customGlossary);
  assert.equal(settings.subtitle.translationDomain, PREVIOUS_COMPACT_DOMAIN);
});

test("the previous 11k focused default advances to the restored full CRE preset", async () => {
  const fullGlossary = await fs.readFile(LEGACY_GLOSSARY_URL, "utf8");
  const previousFocusedGlossary = compactGlossaryBySections(fullGlossary, PREVIOUS_FOCUSED_HEADERS);
  assert.equal(previousFocusedGlossary.length, 11_031);
  const { filePath } = await createLegacySettingsFile({
    glossaryPresetId: "default-cre-ai-en-ko",
    glossary: previousFocusedGlossary,
    translationDomain: PREVIOUS_FOCUSED_DOMAIN,
  });

  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();

  assert.equal(settings.subtitle.glossaryPresetId, DEFAULT_SUBTITLE_SETTINGS.glossaryPresetId);
  assert.equal(settings.subtitle.glossary, DEFAULT_SUBTITLE_SETTINGS.glossary);
  assert.equal(settings.subtitle.translationDomain, DEFAULT_SUBTITLE_SETTINGS.translationDomain);
});

test("a one-character edit to the previous 11k focused default remains Custom", async () => {
  const fullGlossary = await fs.readFile(LEGACY_GLOSSARY_URL, "utf8");
  const customGlossary = `${compactGlossaryBySections(fullGlossary, PREVIOUS_FOCUSED_HEADERS)}!`;
  const { filePath } = await createLegacySettingsFile({
    glossaryPresetId: "",
    glossary: customGlossary,
    translationDomain: PREVIOUS_FOCUSED_DOMAIN,
  });

  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();

  assert.equal(settings.subtitle.glossaryPresetId, "");
  assert.equal(settings.subtitle.glossary, customGlossary);
  assert.equal(settings.subtitle.translationDomain, PREVIOUS_FOCUSED_DOMAIN);
});

test("the released 12k focused default advances to the restored full CRE preset", async () => {
  const fullGlossary = await fs.readFile(LEGACY_GLOSSARY_URL, "utf8");
  const releasedFocusedGlossary = compactGlossaryBySections(fullGlossary, RELEASED_FOCUSED_HEADERS).replace(
    "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]",
    "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]\n- 이 섹션은 의미·통화 보존 가이드다. 실제 자릿수 산술과 최종 표기는 공용 deterministic caption normalizer 결과를 따르며, 환율 환산은 금지한다.",
  );
  assert.equal(releasedFocusedGlossary.length, 12_914);
  const { filePath } = await createLegacySettingsFile({
    glossaryPresetId: "default-cre-ai-en-ko",
    glossary: releasedFocusedGlossary,
    translationDomain: PREVIOUS_FOCUSED_DOMAIN,
  });

  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();

  assert.equal(settings.subtitle.glossaryPresetId, DEFAULT_SUBTITLE_SETTINGS.glossaryPresetId);
  assert.equal(settings.subtitle.glossary, DEFAULT_SUBTITLE_SETTINGS.glossary);
  assert.equal(settings.subtitle.translationDomain, DEFAULT_SUBTITLE_SETTINGS.translationDomain);
});

test("a one-character edit to the released 12k focused default remains Custom", async () => {
  const fullGlossary = await fs.readFile(LEGACY_GLOSSARY_URL, "utf8");
  const releasedFocusedGlossary = compactGlossaryBySections(fullGlossary, RELEASED_FOCUSED_HEADERS).replace(
    "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]",
    "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]\n- 이 섹션은 의미·통화 보존 가이드다. 실제 자릿수 산술과 최종 표기는 공용 deterministic caption normalizer 결과를 따르며, 환율 환산은 금지한다.",
  );
  const customGlossary = `${releasedFocusedGlossary}!`;
  const { filePath } = await createLegacySettingsFile({
    glossaryPresetId: "default-cre-ai-en-ko",
    glossary: customGlossary,
    translationDomain: PREVIOUS_FOCUSED_DOMAIN,
  });

  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();

  assert.equal(settings.subtitle.glossaryPresetId, "");
  assert.equal(settings.subtitle.glossary, customGlossary);
  assert.equal(settings.subtitle.translationDomain, PREVIOUS_FOCUSED_DOMAIN);
});
