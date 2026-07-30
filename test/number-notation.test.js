import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCommittedCreCaption,
} from "../packages/caption-core/index.js";
import {
  applyGlossaryCorrections as gatewayApplyGlossaryCorrections,
  normalizeCommittedCreCaption as gatewayNormalizeCommittedCreCaption,
} from "../media-gateway/src/glossary-corrections.js";

function normalize(text, targetLanguage, isFinal = true) {
  return normalizeCommittedCreCaption({ text, targetLanguage, isFinal });
}

function cases(name, targetLanguage, examples) {
  test(name, () => {
    for (const [input, expected] of examples) {
      assert.equal(normalize(input, targetLanguage), expected, input);
    }
  });
}

cases("committed Korean money becomes exact compact English CRE notation", "en", [
  ["3,000억원", "KRW 300bn"],
  ["The fund raised 3천억 원.", "The fund raised KRW 300bn."],
  ["AUM은 1조 2,000억원입니다.", "AUM은 KRW 1.2tn입니다."],
  ["AUM은 1조 5,000억 원입니다.", "AUM은 KRW 1.5tn입니다."],
  ["투자금은 500만 달러입니다.", "투자금은 USD 5m입니다."],
  ["Book value is 12억 5,000만 원.", "Book value is KRW 1.25bn."],
  ["A 3억 달러 commitment.", "A USD 300m commitment."],
  ["Revenue grew to 3,000억.", "Revenue grew to 300bn."],
]);

cases("full English scale words canonicalize without changing magnitude", "en", [
  ["KRW 300 billion", "KRW 300bn"],
  ["USD 5 million", "USD 5m"],
  ["1.2 trillion won", "KRW 1.2tn"],
  ["300 billion", "300bn"],
  ["3 hundred million won", "KRW 300m"],
  ["KRW 300bn", "KRW 300bn"],
]);

cases("English CRE money becomes exact Korean myriad notation", "ko", [
  ["KRW 300 billion", "3,000억 원"],
  ["KRW 300bn", "3,000억 원"],
  ["1.5 trillion won", "1조 5,000억 원"],
  ["USD 30 million", "3,000만 달러"],
  ["$500 million", "5억 달러"],
  ["300 billion", "3,000억"],
  ["3 hundred million won", "3억 원"],
]);

cases("currency-bound K and M shorthand remains exact", "ko", [
  ["USD 641K", "64만 1,000 달러"],
  ["USD 7.41M", "741만 달러"],
  ["40K USD", "4만 달러"],
  ["667K USD", "66만 7,000 달러"],
]);

cases("area, yield, CRE acronyms, and registered names normalize conservatively", "en", [
  ["GFA is 3.3만㎡.", "GFA is 33,000㎡."],
  ["The portfolio covers 12만㎡.", "The portfolio covers 120,000㎡."],
  ["capex와 noi, cap rate 5.2 percent", "CAPEX와 NOI, Cap Rate 5.2%"],
  ["revpar, dscr, ltv and irr", "RevPAR, DSCR, LTV and IRR"],
  ["Cushman and Wakefield Korea", "Cushman & Wakefield Korea"],
]);

test("partials remain byte-for-byte stable even when a number is incomplete", () => {
  for (const text of [
    "3,000억원",
    "거래 규모는 1조 5,",
    "거래 규모는 1조 5,0",
    "거래 규모는 1조 5,000",
    "USD 641K",
  ]) {
    assert.equal(normalize(text, "en", false), text);
  }
});

test("malformed, ambiguous, and oversized numeric tokens fail closed", () => {
  const oversized = `${"9".repeat(40)}억 원`;
  for (const text of [
    "1.2.3조 원",
    "1e309억 원",
    "1,2억 원",
    "1.23456억 원",
    "+1억 원",
    oversized,
    "K-Pop and K-Beauty drive 4K video demand.",
    "The room count is 100K units.",
    "5m of frontage",
    "12만명",
  ]) {
    assert.equal(normalize(text, "en"), text);
  }
});

test("negative money keeps its sign and exact magnitude", () => {
  assert.equal(normalize("-1억 원", "en"), "-KRW 100m");
  assert.equal(normalize("-KRW 100m", "ko"), "-1억 원");
});

test("normalization is idempotent after full forms become compact", () => {
  for (const [text, targetLanguage] of [
    ["3,000억원", "en"],
    ["KRW 300 billion", "en"],
    ["USD 7.41M", "ko"],
    ["1.5 trillion won", "ko"],
  ]) {
    const once = normalize(text, targetLanguage);
    assert.equal(normalize(once, targetLanguage), once);
  }
});

test("gateway re-exports the same shared final-only normalizer", () => {
  assert.equal(gatewayNormalizeCommittedCreCaption, normalizeCommittedCreCaption);
});

test("partial glossary correction keeps terminology but does not rewrite numbers", () => {
  assert.equal(
    gatewayApplyGlossaryCorrections("3,000억원 운영자", {
      glossary: "운영자 = 운영사",
      targetLanguage: "ko",
    }),
    "3,000억원 운영사",
  );
});
