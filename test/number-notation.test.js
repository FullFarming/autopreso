import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGlossaryCorrections as gatewayApply,
  normalizeBusinessNumberNotation as gatewayNormalize,
} from "../media-gateway/src/glossary-corrections.js";
import {
  applyGlossaryCorrections as desktopApply,
  normalizeBusinessNumberNotation as desktopNormalize,
} from "../src/subtitle-realtime.js";

// Business number notation is arithmetic, so it cannot be left to the live
// model: Korean counts in myriads (만/억/조) and English business speech counts
// in million/billion/trillion. Both live pipelines (desktop local engine and
// the media gateway) carry an identical deterministic pass so every committed
// caption AND every recorded transcript line lands in the right notation.
//
// The desktop and gateway copies are asserted identical at the bottom of this
// file — the gateway is a separate npm package and cannot import from the repo
// root, so the implementation is duplicated on purpose.
/** @type {Array<{ label: string, normalize: Function, apply: Function }>} */
const IMPLEMENTATIONS = [
  { label: "desktop", normalize: desktopNormalize, apply: desktopApply },
  { label: "gateway", normalize: gatewayNormalize, apply: gatewayApply },
];

/** @param {string} name @param {Array<[string, string, string]>} cases */
function bothPipelines(name, cases) {
  for (const { label, normalize } of IMPLEMENTATIONS) {
    test(`${name} (${label})`, () => {
      for (const [input, targetLanguage, expected] of cases) {
        assert.equal(
          normalize(input, targetLanguage),
          expected,
          `${label}: "${input}" (${targetLanguage})`,
        );
      }
    });
  }
}

bothPipelines("Korean myriad scales become English business notation", [
  // The headline case: 3,000억 is 300 billion, not "3,000 hundred million".
  ["We are targeting 3,000억 원 this year.", "en", "We are targeting KRW 300 billion this year."],
  ["We are targeting 3000억원 this year.", "en", "We are targeting KRW 300 billion this year."],
  ["The deal closed at 300억 원.", "en", "The deal closed at KRW 30 billion."],
  ["Total AUM is 1조 5,000억 원.", "en", "Total AUM is KRW 1.5 trillion."],
  ["Total AUM is 1조원.", "en", "Total AUM is KRW 1 trillion."],
  ["CapEx of 5,000만 원 per key.", "en", "CapEx of KRW 50 million per key."],
  ["The fund raised 3천억 원.", "en", "The fund raised KRW 300 billion."],
  // Bare scale words with no currency keep the currency unstated.
  ["Revenue grew to 3,000억.", "en", "Revenue grew to 300 billion."],
  // Non-KRW currencies keep their own currency.
  ["A 3억 달러 commitment.", "en", "A USD 300 million commitment."],
  // Compound Korean amounts decompose into a single English unit.
  ["Book value is 12억 5,000만 원.", "en", "Book value is KRW 1.25 billion."],
]);

bothPipelines("English business scales become Korean myriad notation", [
  ["거래 규모는 300 billion won 입니다.", "ko", "거래 규모는 3,000억 원 입니다."],
  ["거래 규모는 KRW 300 billion 입니다.", "ko", "거래 규모는 3,000억 원 입니다."],
  ["총 AUM은 1.5 trillion won 입니다.", "ko", "총 AUM은 1조 5,000억 원 입니다."],
  ["USD 30 million 규모의 투자입니다.", "ko", "3,000만 달러 규모의 투자입니다."],
  ["$500 million 규모의 딜입니다.", "ko", "5억 달러 규모의 딜입니다."],
  ["매출은 30 billion 입니다.", "ko", "매출은 300억 입니다."],
  // "hundred million" is a literal artifact of 억 — fold it into the myriad form.
  ["평가액은 3 hundred million won 입니다.", "ko", "평가액은 3억 원 입니다."],
]);

bothPipelines("the 'K' thousands shorthand converts only next to a currency", [
  // The decks quote fee revenue as "667K USD" / "USD 641K" throughout.
  ["수수료는 667K USD 였습니다.", "ko", "수수료는 66만 7,000 달러 였습니다."],
  ["수수료는 USD 641K 였습니다.", "ko", "수수료는 64만 1,000 달러 였습니다."],
  ["Project fee: 40K USD.", "ko", "Project fee: 4만 달러."],
  // Without an adjacent currency, a bare K is not a money scale — K-Pop, K-Beauty,
  // 4K video and "OK" must all survive untouched.
  ["K-Pop and K-Beauty drive 4K video demand.", "ko", "K-Pop and K-Beauty drive 4K video demand."],
  ["The room count is 100K units.", "ko", "The room count is 100K units."],
]);

bothPipelines("Japanese output uses Japanese myriad characters", [
  ["取引規模は 300 billion won です。", "ja", "取引規模は 3,000億 ウォン です。"],
  ["AUMは 1.5 trillion yen です。", "ja", "AUMは 1兆 5,000億 円 です。"],
]);

bothPipelines("literal 'hundred million' artifacts collapse in English output", [
  ["The deal closed at 300 hundred million won.", "en", "The deal closed at KRW 30 billion."],
  ["Revenue of 3 hundred million won.", "en", "Revenue of KRW 300 million."],
]);

bothPipelines("figures that are not money scales are left alone", [
  // Years, quarters, percentages, and counts carry no myriad scale word.
  ["In 2026년 we grew 10% in Q3.", "en", "In 2026년 we grew 10% in Q3."],
  ["2026년 3분기 매출은 10% 증가했습니다.", "ko", "2026년 3분기 매출은 10% 증가했습니다."],
  ["The floor plate is 1,200평.", "en", "The floor plate is 1,200평."],
  ["Occupancy reached 95 percent.", "ko", "Occupancy reached 95 percent."],
  // Already-correct notation must survive untouched (idempotence).
  ["We are targeting KRW 300 billion this year.", "en", "We are targeting KRW 300 billion this year."],
  ["거래 규모는 3,000억 원 입니다.", "ko", "거래 규모는 3,000억 원 입니다."],
  // A scale word with no number attached is prose, not a figure.
  ["billion-dollar question", "ko", "billion-dollar question"],
  ["", "en", ""],
]);

bothPipelines("area and count units keep their unit but fix the number", [
  ["GFA is 3.3만㎡ in total.", "en", "GFA is 33,000㎡ in total."],
  ["The portfolio covers 12만㎡.", "en", "The portfolio covers 120,000㎡."],
]);

bothPipelines("amounts that cannot be expressed exactly fall back to digits", [
  // 1,234,567,890 is not a clean multiple of a million — comma digits are the
  // honest business rendering, and inventing decimals would misstate the figure.
  ["Net proceeds were 12억 3,456만 7,890원.", "en", "Net proceeds were KRW 1,234,567,890."],
]);

test("normalization is idempotent in both directions", () => {
  for (const { label, normalize } of IMPLEMENTATIONS) {
    const cases = [
      ["We are targeting 3,000억 원 this year.", "en"],
      ["거래 규모는 300 billion won 입니다.", "ko"],
      ["Total AUM is 1조 5,000억 원.", "en"],
    ];
    for (const [input, targetLanguage] of cases) {
      const once = normalize(input, targetLanguage);
      assert.equal(normalize(once, targetLanguage), once, `${label}: not idempotent for "${input}"`);
    }
  }
});

test("committed lines get business notation even with no glossary configured", () => {
  // Number notation is arithmetic, not terminology: it must not depend on a
  // session having picked a glossary preset.
  for (const { label, apply } of IMPLEMENTATIONS) {
    assert.equal(
      apply("We are targeting 3,000억 원 this year.", { glossary: "", targetLanguage: "en" }),
      "We are targeting KRW 300 billion this year.",
      `${label}: empty glossary skipped number notation`,
    );
    assert.equal(
      apply("거래 규모는 300 billion won 입니다.", { glossary: "컨버전 = conversion", targetLanguage: "ko" }),
      "거래 규모는 3,000억 원 입니다.",
      `${label}: glossary path skipped number notation`,
    );
  }
});

test("desktop and gateway number notation implementations do not drift", () => {
  const battery = [
    ["3,000억 원", "en"],
    ["1조 5,000억 원", "en"],
    ["300 billion won", "ko"],
    ["USD 30 million", "ko"],
    ["3.3만㎡", "en"],
    ["2026년 10% Q3", "en"],
    ["12억 3,456만 7,890원", "en"],
    ["1.5 trillion yen", "ja"],
    ["", "ko"],
  ];
  for (const [text, targetLanguage] of battery) {
    assert.equal(
      gatewayNormalize(text, targetLanguage),
      desktopNormalize(text, targetLanguage),
      `divergence on: "${text}" (${targetLanguage})`,
    );
  }
});
