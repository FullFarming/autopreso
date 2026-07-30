import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import {
  createLocalTermRetriever,
  localTermRetrievalContract,
} from "../packages/caption-core/index.js";

const GLOSSARY = [
  "[규칙]",
  "- 등록된 고유명사와 약어만 실제 문맥에서 적용한다.",
  "[숫자 표기 규칙 — 결정적 코드 전용]",
  "3,000억 원 = KRW 300 billion",
  "[고유명사 — 회사/기관 (한국어 = English)]",
  "쿠시먼앤드웨이크필드 = Cushman & Wakefield",
  "Kushi = Cushman & Wakefield",
  "Kushiman = Cushman & Wakefield",
  "미래에셋 = Mirae Asset",
  "코람코자산운용 = Koramco Asset Management",
  "Capital Markets Advisory = 자본시장 자문",
  "[상업용 부동산 — 투자/자본시장 (한국어 = English)]",
  "운영사 / 운영자 = operator",
  "캡레이트 = Cap Rate",
].join("\n");

test("local term retrieval combines exact aliases, conservative fuzzy names, and context", () => {
  const retriever = createLocalTermRetriever(GLOSSARY);

  const exact = retriever.retrieve({ sourceText: "Kushi Korea presented the outlook." });
  assert.match(exact, /Kushi = Cushman & Wakefield/u);

  const fuzzy = retriever.retrieve({ sourceText: "Kushima Korea reviewed the acquisition." });
  assert.match(fuzzy, /Kushiman = Cushman & Wakefield/u);

  const unregisteredFuzzy = retriever.retrieve({ sourceText: "Mirage Asset reviewed the acquisition." });
  assert.doesNotMatch(unregisteredFuzzy, /미래에셋 = Mirae Asset/u);

  const contextual = retriever.retrieve({
    sourceText: "Our capital markets team provides advisory services.",
  });
  assert.match(contextual, /Capital Markets Advisory = 자본시장 자문/u);
});

test("term evidence distinguishes satisfied target terms from unresolved source terms", () => {
  const retriever = createLocalTermRetriever([
    "[고유명사 — 회사]",
    "쿠시먼 / 쿠쉬먼 / 쿠시먼앤드웨이크필드 = Cushman & Wakefield",
    "[전문 용어]",
    "순영업소득 = NOI",
  ].join("\n"));

  const satisfied = retriever.assess({
    sourceText: "쿠시먼이 순영업소득을 발표했습니다.",
    translatedText: "Cushman & Wakefield reported NOI.",
    targetLanguage: "en",
  });
  assert.equal(satisfied.hasSourceTerm, true);
  assert.equal(satisfied.isTargetSatisfied, true);
  assert.equal(satisfied.hasUnresolvedTerm, false);

  const unresolved = retriever.assess({
    sourceText: "쿠쉬먼이 순영업소득을 발표했습니다.",
    translatedText: "The company reported its result.",
    targetLanguage: "en",
  });
  assert.equal(unresolved.hasSourceTerm, true);
  assert.equal(unresolved.hasUnresolvedTerm, true);
  assert.match(unresolved.selectedGlossary, /Cushman & Wakefield/u);
  assert.match(unresolved.selectedGlossary, /NOI/u);
});

test("registered alias only and high-confidence phonetic names repair post-ASR text", () => {
  const retriever = createLocalTermRetriever(GLOSSARY);

  assert.equal(
    retriever.repair("Kushi Korea presented the outlook.", { language: "en" }),
    "Cushman & Wakefield Korea presented the outlook.",
  );
  assert.equal(
    retriever.repair("Kushimanend Wakefield Korea presented.", { language: "en" }),
    "Cushman & Wakefield Korea presented.",
  );
  assert.equal(
    retriever.repair("Kushimann Korea reviewed the acquisition.", { language: "en" }),
    "Cushman & Wakefield Korea reviewed the acquisition.",
  );
  assert.equal(
    retriever.repair("Mirage Asset reviewed the acquisition.", { language: "en" }),
    "Mirage Asset reviewed the acquisition.",
  );
  assert.equal(
    retriever.repair("Cushman presented results in the field today.", { language: "en" }),
    "Cushman presented results in the field today.",
  );
  assert.equal(
    retriever.repair("The operator reviewed an ordinary lease.", { language: "en" }),
    "The operator reviewed an ordinary lease.",
  );
  assert.equal(
    retriever.repair("Ｋｕｓｈｉ Korea presented.", { language: "en" }),
    "Cushman & Wakefield Korea presented.",
  );
  assert.equal(
    retriever.repair("미래에셋이 검토했습니다.", { language: "ko" }),
    "미래에셋이 검토했습니다.",
  );
  const unregisteredNfd = "일반 문장입니다.";
  assert.equal(retriever.repair(unregisteredNfd, { language: "ko" }), unregisteredNfd);

  const koreanAliases = createLocalTermRetriever(
    "[고유명사 — 회사]\n쿠시먼 / 쿠쉬먼 = 쿠시먼앤드웨이크필드",
  );
  assert.equal(
    koreanAliases.repair("쿠쉬먼이 발표했습니다.", { language: "ko", isFinal: true }),
    "쿠시먼앤드웨이크필드이 발표했습니다.",
  );
  assert.equal(
    koreanAliases.repair("쿠쉬먼앤드웨이크필드가 발표했습니다.", { language: "ko", isFinal: true }),
    "쿠시먼앤드웨이크필드가 발표했습니다.",
    "an existing canonical tail must not be duplicated and its particle must remain",
  );
  assert.equal(
    koreanAliases.repair("쿠쉬만가 발표했습니다.", { language: "ko", isFinal: true }),
    "쿠쉬만가 발표했습니다.",
    "Korean fuzzy repair must not swallow an attached particle",
  );
});

test("legacy registered-company alias rules remain retrievable without becoming global instructions", () => {
  const glossary = "- 회사명 동일 지칭: 쿠시먼앤드웨이크필드 / Cushman & Wakefield / C&W 는 모두 같은 회사다.";
  const retriever = createLocalTermRetriever(glossary);
  const selected = retriever.retrieve({
    sourceText: "쿠시먼앤드웨이크필드 코리아가 발표했습니다.",
    translatedText: "Kushima is why Field Korea presented.",
  });

  assert.equal(selected, glossary);
});

test("numeric rules never enter retrieval or phonetic repair", () => {
  const retriever = createLocalTermRetriever(GLOSSARY);
  const selected = retriever.retrieve({ sourceText: "3,000억 원을 투자했습니다." });

  assert.doesNotMatch(selected, /KRW 300 billion/u);
  assert.equal(
    retriever.repair("3,000억 원을 투자했습니다.", { language: "ko" }),
    "3,000억 원을 투자했습니다.",
  );
});

test("large local glossary retrieval stays bounded and below the realtime budget", () => {
  const filler = Array.from(
    { length: 900 },
    (_, index) => `무관용어${index} = unrelated-term-${index}`,
  ).join("\n");
  const glossary = `${GLOSSARY}\n[기타]\n${filler}\n[고유명사 — 자산]\n센터필드 = Centerfield`;
  const buildStartedAt = performance.now();
  const retriever = createLocalTermRetriever(glossary);
  const buildMilliseconds = performance.now() - buildStartedAt;
  const lookupStartedAt = performance.now();
  const selected = retriever.retrieve({ sourceText: "센터필드의 Cap Rate를 검토합니다." });
  const lookupMilliseconds = performance.now() - lookupStartedAt;

  assert.match(selected, /센터필드 = Centerfield/u);
  assert.match(selected, /캡레이트 = Cap Rate/u);
  assert.doesNotMatch(selected, /unrelated-term-899/u);
  assert.ok(selected.length <= localTermRetrievalContract.maximumPromptCharacters);
  assert.ok(
    lookupMilliseconds < localTermRetrievalContract.targetLookupMilliseconds,
    `retrieval took ${lookupMilliseconds.toFixed(2)}ms after ${buildMilliseconds.toFixed(2)}ms index build`,
  );
});

test("retrieval always scans the bounded corpus instead of dropping late terms under scheduler delay", () => {
  const glossary = [
    "[고유명사 — 회사/기관 (한국어 = English)]",
    ...Array.from({ length: 500 }, (_, index) => `테스트회사${index} = Test Company ${index}`),
    "마지막등록회사 = Last Registered Company",
  ].join("\n");
  const retriever = createLocalTermRetriever(glossary);

  assert.match(
    retriever.retrieve({ sourceText: "마지막등록회사의 투자안을 검토했습니다." }),
    /마지막등록회사 = Last Registered Company/u,
  );
});

test("oversized queries fail closed without entering the cache or repair path", () => {
  const retriever = createLocalTermRetriever(GLOSSARY);
  const oversized = `Kushi ${"x".repeat(localTermRetrievalContract.maximumQueryCharacters)}`;

  assert.equal(retriever.retrieve({ sourceText: oversized }), "");
  assert.equal(retriever.repair(oversized, { language: "en" }), oversized);
});

test("oversized glossaries fail closed instead of compiling a truncated pair", () => {
  const oversizedGlossary = `${"x".repeat(localTermRetrievalContract.maximumGlossaryCharacters)}\nKushi = Cushman & Wakefield`;
  const retriever = createLocalTermRetriever(oversizedGlossary);

  assert.equal(retriever.retrieve({ sourceText: "Kushi Korea" }), "");
  assert.equal(retriever.repair("Kushi Korea", { language: "en" }), "Kushi Korea");
});
