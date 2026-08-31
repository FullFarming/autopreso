import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import {
  createLocalTermRetriever,
  localTermRetrievalContract,
} from "../packages/caption-core/index.js";

const COMPILED_FINGERPRINT_A = `sha256:${"a".repeat(64)}`;
const COMPILED_FINGERPRINT_B = `sha256:${"b".repeat(64)}`;

function compiledGlossary({
  fingerprint = COMPILED_FINGERPRINT_A,
  version = 1,
  terms = [],
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    fingerprint,
    version,
    sourceLanguage: "en",
    targetLanguages: Object.freeze(["ko", "ja"]),
    domain: "Commercial real estate",
    terms: Object.freeze(terms),
    lookupEntries: Object.freeze(terms.flatMap((term) => [
      Object.freeze({
        termId: term.id,
        kind: "source",
        value: term.source,
        normalizedValue: term.source.toLocaleLowerCase(),
        priority: term.priority,
      }),
      ...term.aliases.map((alias) => Object.freeze({
        termId: term.id,
        kind: "alias",
        value: alias,
        normalizedValue: alias.toLocaleLowerCase(),
        priority: term.priority,
      })),
    ])),
    translationRules: Object.freeze(terms.flatMap((term) => Object.entries(term.translations).map(
      ([targetLanguage, target]) => Object.freeze({
        termId: term.id,
        source: term.source,
        targetLanguage,
        target,
        forbiddenTranslations: Object.freeze(term.forbiddenTranslations),
        priority: term.priority,
      }),
    ))),
    doNotTranslate: Object.freeze(terms.filter((term) => term.doNotTranslate).map((term) => Object.freeze({
      termId: term.id,
      value: term.source,
      normalizedValue: term.source.toLocaleLowerCase(),
      priority: term.priority,
    }))),
    contextEntries: Object.freeze(terms.filter((term) => term.context).map((term) => Object.freeze({
      termId: term.id,
      tokens: Object.freeze(term.context.toLocaleLowerCase().split(/\s+/u)),
    }))),
  });
}

/**
 * @param {{
 *   id: string,
 *   source: string,
 *   translations?: Record<string, string>,
 *   aliases?: string[],
 *   doNotTranslate?: boolean,
 *   forbiddenTranslations?: string[],
 *   context?: string | null,
 *   priority?: number,
 * }} input
 */
function compiledTerm({
  id,
  source,
  translations = { ko: `${source}-ko` },
  aliases = [],
  doNotTranslate = false,
  forbiddenTranslations = [],
  context = null,
  priority = 50,
}) {
  return Object.freeze({
    id,
    source,
    translations: Object.freeze({ ...translations }),
    aliases: Object.freeze([...aliases]),
    pronunciation: null,
    doNotTranslate,
    forbiddenTranslations: Object.freeze([...forbiddenTranslations]),
    context,
    examples: Object.freeze([]),
    tags: Object.freeze([]),
    priority,
    provenance: Object.freeze({ kind: "manual", label: null }),
  });
}

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
  const lookupStartedCpu = process.cpuUsage();
  const selected = retriever.retrieve({ sourceText: "센터필드의 Cap Rate를 검토합니다." });
  const lookupMilliseconds = performance.now() - lookupStartedAt;
  const lookupCpu = process.cpuUsage(lookupStartedCpu);
  const lookupCpuMilliseconds = (lookupCpu.user + lookupCpu.system) / 1_000;

  assert.match(selected, /센터필드 = Centerfield/u);
  assert.match(selected, /캡레이트 = Cap Rate/u);
  assert.doesNotMatch(selected, /unrelated-term-899/u);
  assert.ok(selected.length <= localTermRetrievalContract.maximumPromptCharacters);
  assert.ok(
    lookupCpuMilliseconds < localTermRetrievalContract.targetLookupMilliseconds,
    `retrieval used ${lookupCpuMilliseconds.toFixed(2)}ms CPU (${lookupMilliseconds.toFixed(2)}ms wall) after ${buildMilliseconds.toFixed(2)}ms index build`,
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

test("compiled retrieval ranks exact before alias, context, and conservative fuzzy with language-specific Top-K", () => {
  const compiled = compiledGlossary({
    terms: [
      compiledTerm({ id: "exact", source: "Revenue Outlook", translations: { ko: "매출 전망", ja: "売上見通し" }, priority: 10 }),
      compiledTerm({ id: "alias", source: "Artificial Intelligence", aliases: ["AI"], translations: { ko: "인공지능" }, priority: 100 }),
      compiledTerm({ id: "context", source: "Capital Markets", translations: { ko: "자본시장" }, context: "investment advisory transaction", priority: 100 }),
      compiledTerm({ id: "fuzzy", source: "Cushman", aliases: ["Kushiman"], translations: { ko: "쿠시먼" }, priority: 100 }),
    ],
  });
  const retriever = createLocalTermRetriever("", {
    sessionId: "compiled-ranking-session",
    compiledGlossary: compiled,
  });

  const selected = retriever.retrieve({
    sourceText: "Revenue Outlook and AI investment advisory were reviewed with Kushimann.",
    targetLanguage: "ko",
    isFinal: true,
  });
  const lines = selected.split("\n").filter((line) => line.includes(" = "));
  assert.deepEqual(lines, [
    "Revenue Outlook = 매출 전망",
    "Artificial Intelligence = 인공지능",
    "Capital Markets = 자본시장",
    "Cushman = 쿠시먼",
  ]);
  assert.doesNotMatch(selected, /売上見通し/u);
  assert.ok(lines.length <= localTermRetrievalContract.maximumResultLines);
  assert.ok(selected.length <= localTermRetrievalContract.maximumPromptCharacters);
  retriever.release();
});

test("compiled repair is final-only and rejects ambiguous or unsafe fuzzy rewrites", () => {
  const retriever = createLocalTermRetriever("", {
    sessionId: "compiled-repair-session",
    compiledGlossary: compiledGlossary({
      terms: [
        compiledTerm({ id: "cushman", source: "Cushman", aliases: ["Kushiman"] }),
        compiledTerm({ id: "mirae", source: "Mirae Asset", aliases: ["Mirai Asset"] }),
        compiledTerm({ id: "mirage", source: "Mirage Assets", aliases: ["Miraje Assets"] }),
      ],
    }),
  });

  assert.equal(
    retriever.repair("Kushiman presented.", { language: "en", isFinal: false }),
    "Kushiman presented.",
    "partials must not consult the compiled index",
  );
  assert.equal(
    retriever.repair("Kushiman presented.", { language: "en", isFinal: true }),
    "Cushman presented.",
  );
  assert.equal(
    retriever.repair("Mirage Asset reviewed it.", { language: "en", isFinal: true }),
    "Mirage Asset reviewed it.",
    "an ambiguous fuzzy match must fail closed",
  );
  assert.equal(
    retriever.repair("Asset 2026 reviewed it.", { language: "en", isFinal: true }),
    "Asset 2026 reviewed it.",
    "numeric and ordinary vocabulary must never be fuzzy-rewritten",
  );
  retriever.release();
});

test("compiled target repair applies longer specific phrases before embedded shorter rules", () => {
  const retriever = createLocalTermRetriever("", {
    sessionId: "compiled-specific-target-repair-session",
    compiledGlossary: compiledGlossary({
      terms: [
        compiledTerm({
          id: "lease-expiry",
          source: "lease expiry",
          translations: { ko: "임대차 만기" },
          aliases: ["lease expiration"],
          forbiddenTranslations: ["리스 만료"],
          priority: 80,
        }),
        compiledTerm({
          id: "wale",
          source: "weighted average lease expiry",
          translations: { ko: "가중평균잔여임대기간" },
          aliases: ["WALE"],
          forbiddenTranslations: ["가중 평균 리스 만료"],
          priority: 95,
        }),
        compiledTerm({
          id: "noi",
          source: "net operating income",
          translations: { ko: "순영업소득" },
          aliases: ["NOI"],
          forbiddenTranslations: ["순 운영 수입"],
          priority: 95,
        }),
        compiledTerm({
          id: "same-store-noi",
          source: "same-store NOI",
          translations: { ko: "동일자산 순영업소득" },
          aliases: ["same property NOI"],
          forbiddenTranslations: ["같은 가게 NOI"],
          priority: 95,
        }),
      ],
    }),
  });

  assert.equal(
    retriever.repair("가중 평균 리스 만료는 7년입니다.", { language: "ko", isFinal: true }),
    "가중평균잔여임대기간는 7년입니다.",
  );
  assert.equal(
    retriever.repair("같은 가게 NOI는 감소했습니다.", { language: "ko", isFinal: true }),
    "동일자산 순영업소득는 감소했습니다.",
  );
  assert.equal(
    retriever.repair("같은 가게 순영업소득은 감소했습니다.", { language: "ko", isFinal: true }),
    "동일자산 순영업소득은 감소했습니다.",
  );
  assert.equal(
    retriever.repair("리스 만료 위험과 순영업소득을 검토합니다.", { language: "ko", isFinal: true }),
    "임대차 만기 위험과 순영업소득을 검토합니다.",
  );
  assert.equal(
    retriever.repair("같은 가게를 방문했습니다.", { language: "ko", isFinal: true }),
    "같은 가게를 방문했습니다.",
  );
  retriever.release();
});

test("compiled do-not-translate terms render as an exact identity rule", () => {
  const retriever = createLocalTermRetriever("", {
    sessionId: "compiled-do-not-translate-session",
    compiledGlossary: compiledGlossary({
      terms: [compiledTerm({
        id: "noi",
        source: "NOI",
        translations: {},
        doNotTranslate: true,
        priority: 100,
      })],
    }),
  });

  assert.equal(
    retriever.retrieve({ sourceText: "NOI increased.", targetLanguage: "ko", isFinal: true }),
    "NOI = NOI",
  );
  retriever.release();
});

test("compiled cache is fenced by session, version, and fingerprint and stale release cannot evict a replacement", () => {
  const first = createLocalTermRetriever("", {
    sessionId: "compiled-fence-session",
    compiledGlossary: compiledGlossary({
      fingerprint: COMPILED_FINGERPRINT_A,
      version: 1,
      terms: [compiledTerm({ id: "first", source: "Alpha Tower" })],
    }),
  });
  const second = createLocalTermRetriever("", {
    sessionId: "compiled-fence-session",
    compiledGlossary: compiledGlossary({
      fingerprint: COMPILED_FINGERPRINT_B,
      version: 2,
      terms: [compiledTerm({ id: "second", source: "Beta Tower" })],
    }),
  });

  assert.equal(first.retrieve({ sourceText: "Alpha Tower", targetLanguage: "ko", isFinal: true }), "");
  first.release();
  assert.match(second.retrieve({ sourceText: "Beta Tower", targetLanguage: "ko", isFinal: true }), /Beta Tower/u);
  second.release();
  assert.equal(second.retrieve({ sourceText: "Beta Tower", targetLanguage: "ko", isFinal: true }), "");
});

test("compiled session cache pins active handles and rejects overflow until one is released", () => {
  const compiled = compiledGlossary({
    terms: [compiledTerm({ id: "bounded", source: "Bounded Asset" })],
  });
  const retrievers = Array.from(
    { length: localTermRetrievalContract.maximumCompiledSessionEntries + 1 },
    (_, index) => createLocalTermRetriever("", {
      sessionId: `bounded-session-${index}`,
      compiledGlossary: compiled,
    }),
  );

  assert.equal(retrievers[0].isReady, true);
  assert.match(
    retrievers[0].retrieve({ sourceText: "Bounded Asset", targetLanguage: "ko", isFinal: true }),
    /Bounded Asset/u,
  );
  assert.equal(retrievers.at(-1).isReady, false);
  assert.equal(
    retrievers.at(-1).retrieve({ sourceText: "Bounded Asset", targetLanguage: "ko", isFinal: true }),
    "",
  );
  retrievers[0].release();

  const admittedAfterRelease = createLocalTermRetriever("", {
    sessionId: "bounded-session-overflow-retry",
    compiledGlossary: compiled,
  });
  assert.equal(admittedAfterRelease.isReady, true);
  assert.match(
    admittedAfterRelease.retrieve({ sourceText: "Bounded Asset", targetLanguage: "ko", isFinal: true }),
    /Bounded Asset/u,
  );
  for (const retriever of retrievers.slice(1)) retriever.release();
  admittedAfterRelease.release();
});

test("10,000-term compiled correction remains below the realtime p95 budget", () => {
  const terms = Array.from({ length: 10_000 }, (_, index) => {
    const suffix = String(index).padStart(5, "0");
    return compiledTerm({
      id: `repair-${suffix}`,
      source: `Registered Asset ${suffix}`,
      translations: { ko: `등록 자산 ${suffix}` },
      aliases: [`RA-${suffix}`, `Registered Property ${suffix}`],
      forbiddenTranslations: [`금지 자산 ${suffix}`, `잘못된 등록 ${suffix}`],
      priority: index % 101,
    });
  });
  const retriever = createLocalTermRetriever("", {
    sessionId: "compiled-10k-correction-session",
    compiledGlossary: compiledGlossary({ terms }),
  });
  const durations = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const startedAt = performance.now();
    assert.equal(
      retriever.repair("잘못된 등록 09999 리스크를 검토합니다.", { language: "ko", isFinal: true }),
      "등록 자산 09999 리스크를 검토합니다.",
    );
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  const p95Milliseconds = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95Milliseconds <= 300, `compiled correction p95 took ${p95Milliseconds.toFixed(2)}ms`);
  retriever.release();
});

test("10,000 compiled terms build once and retrieve within the realtime lookup budget", () => {
  const terms = Array.from({ length: 10_000 }, (_, index) => compiledTerm({
    id: `term-${String(index).padStart(5, "0")}`,
    source: `Registered Asset ${String(index).padStart(5, "0")}`,
    translations: { ko: `등록 자산 ${String(index).padStart(5, "0")}` },
    aliases: [`RA-${String(index).padStart(5, "0")}`],
    context: `sector-${index % 50} market-${index % 100}`,
  }));
  const buildStartedAt = performance.now();
  const retriever = createLocalTermRetriever("", {
    sessionId: "compiled-10k-session",
    compiledGlossary: compiledGlossary({ terms }),
  });
  const buildMilliseconds = performance.now() - buildStartedAt;
  const lookupStartedAt = performance.now();
  const selected = retriever.retrieve({
    sourceText: "RA-09999 has entered the pipeline.",
    targetLanguage: "ko",
    isFinal: true,
  });
  const lookupMilliseconds = performance.now() - lookupStartedAt;

  assert.match(selected, /Registered Asset 09999 = 등록 자산 09999/u);
  assert.ok(
    lookupMilliseconds < localTermRetrievalContract.targetLookupMilliseconds,
    `compiled lookup took ${lookupMilliseconds.toFixed(2)}ms after ${buildMilliseconds.toFixed(2)}ms build`,
  );
  assert.ok(buildMilliseconds < 1_000, `compiled index build took ${buildMilliseconds.toFixed(2)}ms`);
  retriever.release();
});
