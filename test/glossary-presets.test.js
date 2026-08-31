import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";

import { GLOSSARY_PRESETS } from "../src/glossary-presets.js";
import { MAX_SUBTITLE_GLOSSARY_CHARS } from "../src/settings-store.js";

// A shipped preset that does not fit the configured glossary limit is worse than
// a missing one: the desktop settings store REJECTS it outright, while the
// webapp and the gateway silently slice it, dropping whichever sections happen
// to sit at the end. Every ceiling in the repo has to clear the largest preset.
test("every shipped preset fits every glossary size limit in the repo", () => {
  const largest = GLOSSARY_PRESETS.reduce((max, preset) => Math.max(max, preset.glossary.length), 0);

  assert.ok(
    largest <= MAX_SUBTITLE_GLOSSARY_CHARS,
    `largest preset is ${largest} chars but the desktop store rejects over ${MAX_SUBTITLE_GLOSSARY_CHARS}`,
  );

  const webappLimit = Number(
    /MAX_GLOSSARY_CHARS = (\d+)/u.exec(readFileSync("webapp/lib/settings.ts", "utf8"))?.[1],
  );
  assert.ok(
    largest <= webappLimit,
    `largest preset is ${largest} chars but webapp/lib/settings.ts slices at ${webappLimit}`,
  );

  // Caption-only and Live Call send this exact stored value. Keeping every
  // built-in below the shared limit prevents either path from slicing it.
  for (const preset of GLOSSARY_PRESETS) {
    assert.equal(preset.glossary.length <= MAX_SUBTITLE_GLOSSARY_CHARS, true);
  }

  const gatewayLimit = Number(
    /glossaryText \?\? ""\)\.trim\(\)\.slice\(0, ([\d_]+)\)/u
      .exec(readFileSync("media-gateway/src/config.js", "utf8"))?.[1]
      ?.replace(/_/gu, ""),
  );
  assert.ok(
    largest <= gatewayLimit,
    `largest preset is ${largest} chars but media-gateway/src/config.js slices at ${gatewayLimit}`,
  );
});

test("the BASE CRE glossary is what a session gets before anyone picks a preset", async () => {
  const { getDefaultSubtitleGlossaryContext } = await import("../src/glossary-presets.js");
  const cre = GLOSSARY_PRESETS.find((preset) => preset.id === "default-cre-ai-en-ko");

  // Resolution used to return the FIRST preset matching the language pair, and
  // hotel-investment-en-ko is listed before the library — so an untouched
  // install silently ran the HOTEL termbase (MRG, RevPAR, hotel translation
  // memory) as its default for every EN<->KO session. The everyday default has
  // to be the general CRE consulting glossary.
  for (const pair of [{ a: "en", b: "ko" }, { a: "ko", b: "en" }, {}]) {
    const context = getDefaultSubtitleGlossaryContext(pair);
    assert.equal(context.glossary, cre.glossary, `wrong default for pair ${JSON.stringify(pair)}`);
    assert.equal(context.domain, cre.domain);
  }

  // Other pairs still resolve to their own prepared preset.
  const fnb = GLOSSARY_PRESETS.find((preset) => preset.id === "fnb-leasing-ko-ja");
  assert.equal(getDefaultSubtitleGlossaryContext({ a: "ko", b: "ja" }).glossary, fnb.glossary);
});

test("built-in glossary presets cover both prepared industries with full content", () => {
  const ids = GLOSSARY_PRESETS.map((preset) => preset.id);
  assert.ok(ids.includes("hotel-investment-en-ko"));
  assert.ok(ids.includes("fnb-leasing-ko-ja"));
  // 2026-07: one-click switch between the everyday default and hotel sessions.
  assert.ok(ids.includes("default-cre-ai-en-ko"));
  assert.ok(ids.includes("hotel-session-2026-en-ko"));

  const cre = GLOSSARY_PRESETS.find((preset) => preset.id === "default-cre-ai-en-ko");
  const fullCreSource = readFileSync("docs/glossary-default-cre-ai-2026-07.txt", "utf8").replace(/\n+$/u, "");
  const expectedCreGlossary = fullCreSource.replace(
    "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]",
    "[숫자 표기 규칙 — 자릿수 단위를 반드시 바꾼다]\n- 이 섹션은 의미·통화 보존 가이드다. 실제 자릿수 산술과 최종 표기는 공용 deterministic caption normalizer 결과를 따르며, 환율 환산은 금지한다.",
  );
  assert.match(cre.glossary, /공실률 = vacancy rate/);
  assert.equal(cre.glossary, expectedCreGlossary);
  assert.match(cre.glossary, /\[숫자 표기 규칙/u);
  assert.match(cre.glossary, /공용 deterministic caption normalizer 결과/u);
  assert.match(cre.glossary, /3,000억 원 → KRW 300 billion/u);
  assert.match(cre.glossary, /서울 = Seoul/u);
  assert.match(cre.glossary, /Disposition Advisory = 매각 자문/u);
  assert.match(cre.glossary, /Kushiman = Cushman & Wakefield/u);
  assert.match(cre.glossary, /펀더맨털 = fundamentals/u);
  assert.match(cre.glossary, /\[AI·AX/);
  assert.match(cre.glossary, /\[직위·조직 단위/);
  assert.match(cre.glossary, /\[관용·비유 표현/);
  assert.match(cre.glossary, /\[영어 슬로건·구어/);
  assert.match(cre.glossary, /Cushman & Wakefield Korea/);

  const hotelSession = GLOSSARY_PRESETS.find((preset) => preset.id === "hotel-session-2026-en-ko");
  const fullHotelSessionSource = readFileSync("docs/glossary-hotel-session-2026-07.txt", "utf8").replace(/\n+$/u, "");
  assert.equal(hotelSession.glossary, fullHotelSessionSource);
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
  assert.match(hotel.glossary, /\[추가 2026-06-23 — Hospitality Market Session 패널 3사 고유명사\/약어\/운영 용어\]/);
  assert.match(hotel.glossary, /\[일반 관용 표현/);
  assert.match(hotel.glossary, /Kushi = Cushman & Wakefield/);
  assert.match(hotel.glossary, /First Cabin Myeongdong = 퍼스트 캐빈 명동/);
  assert.match(hotel.glossary, /low manning model = 저인력 운영 모델/);
  const fnb = GLOSSARY_PRESETS.find((preset) => preset.id === "fnb-leasing-ko-ja");
  assert.match(fnb.glossary, /키테넌트 = キーテナント/);
  assert.deepEqual(fnb.languagePair, { a: "ko", b: "ja" });
});
