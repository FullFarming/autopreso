import assert from "node:assert/strict";
import test from "node:test";

import { applyGlossaryCorrections as gatewayApply } from "../media-gateway/src/glossary-corrections.js";
import { applyGlossaryCorrections as desktopApply } from "../src/subtitle-realtime.js";

// The gateway ships a copy of the desktop deterministic glossary pass (the
// Gemini Live Translate API has no glossary support, so this pass IS the
// terminology guarantee). The two implementations must stay behaviorally
// identical — this battery fails if either copy drifts.
const GLOSSARY = [
  "[호텔 브랜드]",
  "힐튼 가든 인 = Hilton Garden Inn",
  "르메르디앙 / 르 메르디앙 = Le Méridien",
  "쿠시먼앤드웨이크필드 = Cushman & Wakefield",
  "컨버전 = conversion",
  "[번역 메모리]",
  "안녕하세요 여러분 = Hello everyone",
].join("\n");

test("gateway glossary corrections behave exactly like the desktop subtitle pass", () => {
  const cases = [
    ["We visited the 힐튼 가든 인 yesterday.", "en", ""],
    ["Hilton Garden Inn 컨버전은 순항 중입니다", "ko", ""],
    ["Kushiman and Wakefield Korea reported growth.", "en", ""],
    ["쿠시먼 웨이크 필드 코리아 실적 발표", "ko", ""],
    ["K-Field Korea announced results.", "en", ""],
    ["회사를 다녀왔다", "ko", ""],
    ["hello", "en", "안녕하세요 여러분"],
    ["plain text without any glossary terms", "en", ""],
    ["르 메르디앙 서울의 리브랜딩", "ko", ""],
    ["", "en", ""],
  ];
  for (const [text, targetLanguage, sourceText] of cases) {
    assert.equal(
      gatewayApply(text, { glossary: GLOSSARY, targetLanguage, sourceText }),
      desktopApply(text, { glossary: GLOSSARY, targetLanguage, sourceText }),
      `divergence on: "${text}" (${targetLanguage})`,
    );
  }
});

test("Caption Only and Gateway enforce the same exact deterministic correction after final polish", () => {
  const polishedDraft = "We visited 힐튼 가든 인 with Kushiman and Wakefield Korea.";
  const expected = "We visited Hilton Garden Inn with Cushman & Wakefield Korea.";
  const input = {
    glossary: GLOSSARY,
    targetLanguage: "en",
    sourceText: "쿠시먼앤드웨이크필드 코리아와 힐튼 가든 인을 방문했습니다.",
  };
  assert.equal(desktopApply(polishedDraft, input), expected);
  assert.equal(gatewayApply(polishedDraft, input), expected);
});
