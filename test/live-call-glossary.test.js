import assert from "node:assert/strict";
import test from "node:test";

import { buildLiveCallGlossary, liveCallGlossaryPolicy } from "../src/live-call-glossary.js";
import { GLOSSARY_PRESET_LIBRARY } from "../src/glossary-preset-library.js";

test("Live Call derives a lean CRE glossary without changing captions-only settings", () => {
  const preset = GLOSSARY_PRESET_LIBRARY.find((entry) => entry.id === "default-cre-ai-en-ko");
  const original = preset.glossary;
  const live = buildLiveCallGlossary(original);

  assert.equal(preset.glossary, original);
  assert.ok(live.length < original.length * 0.75);
  assert.ok(live.length <= liveCallGlossaryPolicy.maxChars);
  assert.match(live, /약어는 양방향 모두 원문 그대로 유지/u);
  assert.match(live, /\[숫자 표기 규칙/u);
  assert.match(live, /\[상업용 부동산 — 투자\/자본시장/u);
  assert.match(live, /\[고유명사 추가 — 자산\/프로젝트/u);
  assert.match(live, /쿠시먼앤드웨이크필드 = Cushman & Wakefield/u);
  assert.doesNotMatch(live, /\[관용·비유 표현/u);
  assert.doesNotMatch(live, /\[AI·AX/u);
  assert.doesNotMatch(live, /^\[지명 /mu);
  assert.doesNotMatch(live, /\[직위·조직 단위/u);
  assert.doesNotMatch(live, /\[영어 슬로건·구어/u);
});

test("Live Call keeps hospitality brands and assets but drops sentence memory and general places", () => {
  const preset = GLOSSARY_PRESET_LIBRARY.find((entry) => entry.id === "hotel-session-2026-en-ko");
  const live = buildLiveCallGlossary(preset.glossary);

  assert.match(live, /힐튼 가든 인 = Hilton Garden Inn/u);
  assert.match(live, /타임워크 명동 = Time Walk Myeongdong/u);
  assert.match(live, /\[부동산 투자·거래 용어/u);
  assert.doesNotMatch(live, /\[번역 메모리/u);
  assert.doesNotMatch(live, /^\[지명 /mu);
  assert.doesNotMatch(live, /\[영어 표현 = 한국어/u);
});
