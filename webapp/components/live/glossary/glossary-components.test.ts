import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (file: string) => readFileSync(resolve(process.cwd(), "components/live/glossary", file), "utf8");

test("workspace exposes the complete structured glossary workflow without a raw JSON primary editor", () => {
  const workspace = read("GlossaryWorkspace.tsx");
  const editor = read("GlossaryEditor.tsx");
  const terms = read("GlossaryTermRows.tsx");
  const importPreview = read("GlossaryImportPreview.tsx");
  const versions = read("GlossaryVersionHistory.tsx");
  const presetList = read("GlossaryPresetList.tsx");
  const validation = read("GlossaryValidationSummary.tsx");
  const combined = [workspace, presetList, editor, terms, importPreview, validation, versions].join("\n");

  for (const label of ["용어집 목록", "용어집 편집", "가져오기 미리보기", "검증 결과", "버전 기록", "복제", "내보내기", "세션에 사용"]) {
    assert.match(combined, new RegExp(label, "u"));
  }
  assert.match(combined, /승인 대기/u);
  assert.match(combined, /후보 승인/u);
  assert.match(combined, /버전 활성화/u);
  assert.doesNotMatch(combined, /<textarea[^>]*(?:json|JSON)/u);
  assert.doesNotMatch(combined, /fetch\(|\/api\//u);
});

test("form controls have stable names, labels, announcements, and explicit candidate approval", () => {
  const combined = [read("GlossaryEditor.tsx"), read("GlossaryTermRows.tsx"), read("GlossaryImportPreview.tsx"), read("GlossaryValidationSummary.tsx")].join("\n");
  for (const name of ["presetName", "domain", "sourceTerm", "targetTerm", "aliases", "glossaryImport"]) {
    assert.match(combined, new RegExp(`name="${name}"`, "u"));
  }
  assert.match(combined, /htmlFor=/u);
  assert.match(combined, /role="alert"/u);
  assert.match(combined, /aria-live="polite"/u);
  assert.match(combined, /onApproveCandidate/u);
  assert.match(combined, /onRejectCandidate/u);
});

test("large glossaries expose bounded search, pagination, and validation focus routing", () => {
  const editor = read("GlossaryEditor.tsx");
  const terms = read("GlossaryTermRows.tsx");
  const workspace = read("GlossaryWorkspace.tsx");
  const combined = `${editor}\n${terms}\n${workspace}`;

  assert.match(editor, /type="search"/u);
  assert.match(editor, /createGlossaryTermWindow/u);
  assert.match(editor, /createGlossaryDraftEdits/u);
  assert.match(terms, /다음 50개 보기/u);
  assert.match(terms, /이전 50개 보기/u);
  assert.match(workspace, /onRequestFocus/u);
  assert.match(combined, /aria-live="polite"/u);
});

test("NOVA glossary styles preserve responsive layouts, zoom flow, focus, and target size", () => {
  const css = read("glossary.module.css");
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(css, /@media \(max-width:\s*1023px\)/u);
  assert.match(css, /@media \(max-width:\s*767px\)/u);
  assert.match(css, /@media \(max-width:\s*359px\)/u);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(css, /overflow-wrap:\s*anywhere/u);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}|gradient\(|9999px/iu);
});

test("host exposes the connected glossary workspace and selected active version", () => {
  const host = readFileSync(resolve(process.cwd(), "components/live/LiveHostDashboard.tsx"), "utf8");
  assert.match(host, /<ConnectedGlossaryWorkspace/u);
  assert.match(host, /용어집 관리/u);
  assert.match(host, /세션 용어집/u);
  assert.match(host, /활성 버전/u);
});

test("host session glossary uses grouped checkboxes, a five-item count, and the plural pin contract", () => {
  const host = readFileSync(resolve(process.cwd(), "components/live/LiveHostDashboard.tsx"), "utf8");
  const checklist = read("GlossarySessionChecklist.tsx");
  const client = read("glossary-client.ts");
  assert.match(host, /<ConnectedGlossarySessionChecklist/u);
  assert.match(host, /pinSessionGlossaries/u);
  assert.match(checklist, /type="checkbox"/u);
  assert.match(checklist, /name="glossaries"/u);
  assert.match(checklist, /value=\{key\}/u);
  assert.match(checklist, /내장 용어집/u);
  assert.match(checklist, /내 용어집/u);
  assert.match(checklist, /5개/u);
  assert.match(checklist, /aria-live="polite"/u);
  assert.match(checklist, /언어/u);
  assert.match(checklist, /충돌/u);
  assert.match(checklist, /적용할 때 번역 충돌을 확인합니다/u);
  assert.doesNotMatch(checklist, /저장 전에/u);
  assert.match(checklist, /getGlossarySessionOptionAvailability/u);
  assert.match(checklist, /선택한 용어집과 원문 언어가 다름/u);
  // Host options carry the FULL target list of the preset (multi-target
  // glossaries stay selectable for every language they cover), and the source
  // language must never leak into the target list.
  assert.match(checklist, /targetLanguages:\s*\[\.\.\.preset\.targetLanguages\]/u);
  assert.doesNotMatch(checklist, /targetLanguages:\s*\[preset\.languagePair\.a,\s*preset\.languagePair\.b\]/u);
  assert.match(client, /sourceKind:\s*glossary\.sourceKind/u);
  assert.doesNotMatch(checklist, /role="radio"|radiogroup/u);
});

test("connected workspace owns frozen routes, safe state, and explicit AI candidate approval", () => {
  const connected = read("ConnectedGlossaryWorkspace.tsx");
  const client = read("glossary-client.ts");
  const combined = `${connected}\n${client}`;
  for (const route of ["/api/glossary-presets", "/import?validateOnly=true", "/extract", "/versions", "/activate", "/duplicate"]) {
    assert.match(combined, new RegExp(route.replace(/[?]/gu, "\\?"), "u"));
  }
  assert.match(connected, /approve-candidate/u);
  assert.match(connected, /reject-candidate/u);
  assert.doesNotMatch(combined, /localStorage|sessionStorage|console\.|window\.location/u);
  assert.doesNotMatch(connected, /extract[\s\S]{0,500}activateGlossaryVersion/u);
});

test("host pins the selected glossary array before invite or Start and preserves selection on failure", () => {
  const host = readFileSync(resolve(process.cwd(), "components/live/LiveHostDashboard.tsx"), "utf8");
  assert.match(host, /pinSessionGlossaries\(fetch, activeSession\.id, activeSession\.version, glossaries\)/u);
  assert.match(host, /if \(glossarySelections\.length\)[\s\S]*pinGlossariesToSession\(next, glossarySelections\)[\s\S]*\/invites/u);
  assert.match(host, /if \(isGlossaryPinPending\)[\s\S]*세션 용어집 적용을 완료한 뒤 라이브를 시작/u);
  assert.match(host, /catch \(reason: unknown\)[\s\S]*setGlossarySelections\(previousSelections\)/u);
});
