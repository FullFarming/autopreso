import assert from "node:assert/strict";
import { test } from "node:test";

import { GLOSSARY_PRESETS } from "../src/glossary-presets.js";

test("built-in glossary presets cover both prepared industries with full content", () => {
  const ids = GLOSSARY_PRESETS.map((preset) => preset.id);
  assert.ok(ids.includes("hotel-investment-en-ko"));
  assert.ok(ids.includes("fnb-leasing-ko-ja"));
  // 2026-07: one-click switch between the everyday default and hotel sessions.
  assert.ok(ids.includes("default-cre-ai-en-ko"));
  assert.ok(ids.includes("hotel-session-2026-en-ko"));

  const cre = GLOSSARY_PRESETS.find((preset) => preset.id === "default-cre-ai-en-ko");
  assert.match(cre.glossary, /공실률 = vacancy rate/);
  assert.match(cre.glossary, /AI 전환 = AX/);
  assert.match(cre.glossary, /옥석 가리기/);
  assert.match(cre.glossary, /Cushman & Wakefield Korea/);

  const hotelSession = GLOSSARY_PRESETS.find((preset) => preset.id === "hotel-session-2026-en-ko");
  assert.match(hotelSession.glossary, /힐튼 가든 인 = Hilton Garden Inn/);
  assert.match(hotelSession.glossary, /RevPAR/);

  for (const preset of GLOSSARY_PRESETS) {
    assert.equal(typeof preset.label, "string");
    assert.equal(typeof preset.industry, "string");
    assert.match(preset.languagePair.a, /^(en|ko|ja)$/);
    assert.match(preset.languagePair.b, /^(en|ko|ja)$/);
    assert.ok(preset.glossary.length > 1000, `${preset.id} glossary should be substantial`);
    assert.ok(preset.domain.length > 50, `${preset.id} domain should describe the industry`);
  }

  const hotel = GLOSSARY_PRESETS.find((preset) => preset.id === "hotel-investment-en-ko");
  assert.match(hotel.glossary, /MRG/);
  assert.match(hotel.glossary, /현주소 = current landscape/);
  assert.match(hotel.glossary, /MRG Gap \/ MRG 차이 \/ MRG 갭 문제 = MRG 갭/);
  assert.match(hotel.glossary, /Focused-service \/ Focused service \/ 포커스 서비스 = 포커스드 서비스/);
  assert.match(hotel.glossary, /Panel Discussion = 패널 토론/);
  assert.match(hotel.glossary, /Hilton \/ TheHyoosik \/ First Cabin/);
  // Company-name normalization incl. the Korea entity (a mashed-together proper
  // noun should map to C&W Korea / 쿠시먼앤드웨이크필드 코리아, not a hallucination).
  assert.match(hotel.glossary, /쿠시먼앤드웨이크필드코리아/);
  assert.match(hotel.glossary, /C&W Korea/);
  // Deterministic replacement pairs (NOT "-" bullets, which the replacer skips)
  // so the term is normalized even without the polish model.
  assert.match(hotel.glossary, /쿠시먼앤드웨이크필드 코리아 = Cushman & Wakefield Korea/);
  assert.match(hotel.glossary, /쿠시먼앤드웨이크필드 = Cushman & Wakefield/);
  assert.match(hotel.glossary, /\[번역 메모리 — Hospitality Market Session 2026 문장 매칭\]/);
  assert.match(hotel.glossary, /국내 호텔 시장의 변화와 기회 = Changes and Opportunities in Korea's Hotel Market/);
  assert.match(hotel.glossary, /좋은 시장은 기회를 만들지만, 그 기회를 딜로 바꾸는 건 체계적인 검증에서 나옵니다 = A strong market creates opportunities, but turning those opportunities into deals comes from systematic validation/);
  assert.match(hotel.glossary, /MRG란 호텔 운영사가 임대인에게 보장하는 최소 수익입니다 = MRG is the minimum revenue that a hotel operator guarantees to the landlord/);
  assert.match(hotel.glossary, /\[추가 2026-06-23 — Hospitality Market Session 패널 3사 고유명사\/약어\/운영 용어\]/);
  assert.match(hotel.glossary, /Kushi = Cushman & Wakefield/);
  assert.match(hotel.glossary, /Kushiman = Cushman & Wakefield/);
  assert.match(hotel.glossary, /K-Field Korea = Cushman & Wakefield Korea/);
  assert.match(hotel.glossary, /Kushi = 쿠시먼앤드웨이크필드/);
  assert.match(hotel.glossary, /Kushiman = 쿠시먼앤드웨이크필드/);
  assert.match(hotel.glossary, /K-Field Korea = 쿠시먼앤드웨이크필드 코리아/);
  assert.match(hotel.glossary, /First Cabin Myeongdong = 퍼스트 캐빈 명동/);
  assert.match(hotel.glossary, /Noon Square \/ NOON Square \/ NOOn square \/ 눈스퀘어 = 눈스퀘어/);
  assert.match(hotel.glossary, /Hilton Garden Inn = 힐튼 가든 인/);
  assert.match(hotel.glossary, /Hampton by Hilton = 햄튼 바이 힐튼/);
  assert.match(hotel.glossary, /Spark by Hilton = 스파크 바이 힐튼/);
  assert.match(hotel.glossary, /Motto by Hilton = 모토 바이 힐튼/);
  assert.match(hotel.glossary, /Third-Party Operator \/ third-party operator = 써드파티 운영사/);
  assert.match(hotel.glossary, /kit-of-parts approach = kit-of-parts 방식/);
  assert.match(hotel.glossary, /low manning model = 저인력 운영 모델/);
  assert.match(hotel.glossary, /fire life safety requirements = 소방·인명 안전 요건/);
  assert.match(hotel.glossary, /lift core location \/ lift core locations = 엘리베이터 코어 위치/);
  assert.match(hotel.glossary, /upfront CapEx \/ upfront CAPEX = 초기 CAPEX/);
  const fnb = GLOSSARY_PRESETS.find((preset) => preset.id === "fnb-leasing-ko-ja");
  assert.match(fnb.glossary, /키테넌트 = キーテナント/);
  assert.deepEqual(fnb.languagePair, { a: "ko", b: "ja" });
});
