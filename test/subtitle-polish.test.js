// @ts-nocheck - injects a fake generateText to exercise the polish contract.
import assert from "node:assert/strict";
import { test } from "node:test";

import { captionPolishContract } from "../packages/caption-core/index.js";
import { createSubtitlePolisher } from "../src/subtitle-polish.js";

test("desktop polish keeps a six-second budget for full glossary prompts", () => {
  assert.equal(captionPolishContract.timeoutMilliseconds, 6_000);
});

function recordingGenerateText(text) {
  const calls = [];
  const fn = async (options) => {
    calls.push(options);
    return { text };
  };
  return { fn, calls };
}

test("polish passes through unchanged and makes no call when tone is natural", async () => {
  const { fn, calls } = recordingGenerateText("ignored");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "test-model" });

  const result = await polisher.polish({
    translatedText: "Hello there",
    sourceText: "안녕하세요",
    targetLanguage: "en",
    tone: "natural",
  });

  assert.equal(result, "Hello there");
  assert.equal(calls.length, 0);
});

test("polish rewrites a committed line into the business register when tone is business", async () => {
  const { fn, calls } = recordingGenerateText("  안녕하십니까. 회의를 시작하겠습니다.  ");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "test-model" });

  const result = await polisher.polish({
    translatedText: "안녕 회의 시작할게",
    sourceText: "Hi, let's start the meeting",
    targetLanguage: "ko",
    tone: "business",
  });

  assert.equal(result, "안녕하십니까. 회의를 시작하겠습니다.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "test-model");
});

test("business prompt encodes the register rules per target language", async () => {
  const { fn, calls } = recordingGenerateText("ok");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  await polisher.polish({ translatedText: "회의 시작", targetLanguage: "ko", tone: "business" });
  const koPrompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  assert.match(koPrompt, /격식체|존댓말/);
  assert.match(koPrompt, /proper noun/i);
  assert.match(koPrompt, /meaning/i);

  await polisher.polish({ translatedText: "Start the meeting", targetLanguage: "en", tone: "business" });
  const enPrompt = `${calls[1].system ?? ""}\n${calls[1].prompt ?? ""}`;
  assert.match(enPrompt, /professional business English/i);
  assert.match(enPrompt, /KRW 300 billion/u);
  assert.doesNotMatch(enPrompt, /KRW 300bn/u, "compact CRE notation is a Live Call finalizer concern");
});

test("polish never drops a subtitle: generateText throwing falls back to raw text", async () => {
  const polisher = createSubtitlePolisher({
    generateText: async () => { throw new Error("api down"); },
    model: "m",
  });

  const result = await polisher.polish({
    translatedText: "안녕 회의 시작",
    targetLanguage: "ko",
    tone: "business",
  });

  assert.equal(result, "안녕 회의 시작");
});

test("polish falls back to raw text when the model exceeds the timeout", async () => {
  const polisher = createSubtitlePolisher({
    model: "m",
    timeoutMs: 10,
    generateText: (options) => new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });

  const result = await polisher.polish({
    translatedText: "원문 그대로",
    targetLanguage: "ko",
    tone: "business",
  });

  assert.equal(result, "원문 그대로");
});

test("polish injects the configured glossary into the prompt", async () => {
  const { fn, calls } = recordingGenerateText("수급 균형과 운영사 선정");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  await polisher.polish({
    translatedText: "수요 공급 균형과 오퍼레이터 선정",
    sourceText: "The operator will be selected after reviewing supply and demand.",
    targetLanguage: "ko",
    tone: "business",
    glossary: "operator -> 운영사\nMRG, DSCR, RevPAR -> keep verbatim",
  });

  const prompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  assert.match(prompt, /operator -> 운영사/);
  assert.doesNotMatch(prompt, /MRG, DSCR, RevPAR/);
  // Professional interpreting termbase discipline: the glossary is a list of
  // SYMMETRIC pairs enforced identically in both directions (KO→EN and
  // EN→KO), not two separate directional lists.
  assert.match(prompt, /bidirectional/i);
  assert.match(prompt, /both KO→EN and EN→KO/);
  assert.match(prompt, /TRANSLATION MEMORY/);
  assert.match(prompt, /full-sentence|clause-level/);
  assert.match(prompt, /close variant/);
  // The global prompt carries one restraint, not a broad idiom dictionary that
  // biases ordinary speech or makes every committed line expensive.
  assert.match(prompt, /intended meaning rather than its literal words/);
  assert.match(prompt, /Do not introduce an idiom/);
  assert.doesNotMatch(prompt, /soft landing|separating the wheat|현주소/u);
});

test("a relevant late glossary entry survives bounded selection with its section and global rules", async () => {
  const { fn, calls } = recordingGenerateText("Cushman & Wakefield Korea");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });
  const unrelated = Array.from(
    { length: 700 },
    (_, index) => `무관용어${index} = irrelevant-term-${index}`,
  ).join("\n");
  const glossary = [
    "[규칙]",
    "- 아래 용어쌍은 양방향으로 적용한다.",
    "[일반 용어]",
    unrelated,
    "[고유명사 — 회사]",
    "Kushiman = Cushman & Wakefield",
  ].join("\n");

  await polisher.polish({
    translatedText: "Kushimanend Wakefield Korea",
    sourceText: "쿠시먼앤드웨이크필드 코리아",
    targetLanguage: "en",
    tone: "business",
    glossary,
  });

  const system = String(calls[0].system);
  const dataBlock = system.match(/^BEGIN_UNTRUSTED_DATA\n([^\n]+)\nEND_UNTRUSTED_DATA$/mu);
  assert.ok(dataBlock, "bounded glossary JSON must be carried inside the untrusted-data block");
  const selectedGlossary = JSON.parse(dataBlock[1]).glossary;
  assert.match(selectedGlossary, /\[규칙\]/u);
  assert.match(selectedGlossary, /양방향으로 적용/u);
  assert.match(selectedGlossary, /\[고유명사 — 회사\]/u);
  assert.match(selectedGlossary, /Kushiman = Cushman & Wakefield/u);
  assert.doesNotMatch(selectedGlossary, /irrelevant-term-699/u);
  assert.ok(selectedGlossary.length <= 6_000, `selected glossary was ${selectedGlossary.length} chars`);
});

test("no-match glossary keeps bounded global instructions without unrelated entries", async () => {
  const { fn, calls } = recordingGenerateText("Good morning.");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });
  await polisher.polish({
    translatedText: "Good morning.",
    sourceText: "좋은 아침입니다.",
    targetLanguage: "en",
    tone: "business",
    glossary: "[규칙]\n- 용어가 실제로 나타날 때만 적용한다.\n[투자]\n캡레이트 = Cap Rate",
  });

  const system = String(calls[0].system);
  assert.match(system, /용어가 실제로 나타날 때만 적용/u);
  assert.doesNotMatch(system, /캡레이트 = Cap Rate/u);
});

test("full-sentence translation-memory pairs retain their section context", async () => {
  const { fn, calls } = recordingGenerateText("시장이 회복되고 있습니다.");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });
  await polisher.polish({
    translatedText: "시장이 다시 좋아지고 있습니다.",
    sourceText: "The market is recovering.",
    targetLanguage: "ko",
    tone: "natural",
    glossary: "[문장 번역 메모리]\nThe market is recovering = 시장이 회복되고 있습니다\nThe hotel is full = 호텔이 만실입니다",
  });

  const system = String(calls[0].system);
  assert.match(system, /\[문장 번역 메모리\]/u);
  assert.match(system, /The market is recovering = 시장이 회복되고 있습니다/u);
  assert.doesNotMatch(system, /The hotel is full/u);
});

test("polish applies an explicit hierarchy: glossary where present, plain translation for everyday speech", async () => {
  const { fn, calls } = recordingGenerateText("ok");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  await polisher.polish({
    translatedText: "잠시 쉬었다가 다시 시작하겠습니다",
    targetLanguage: "ko",
    tone: "business",
    glossary: "operator -> 운영사",
    domain: "Commercial real estate",
  });

  const prompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  // The rules form a numbered priority order, not a flat list.
  assert.match(prompt, /APPLICATION ORDER/);
  // Glossary renderings bind only where their terms actually appear — never
  // inject domain jargon into sentences that do not contain them.
  assert.match(prompt, /only where .* actually appear/i);
  assert.match(prompt, /never inject/i);
  // Everyday/conversational lines (greetings, logistics, asides) stay a plain
  // natural translation with minimal edits.
  assert.match(prompt, /everyday|conversational/i);
  assert.match(prompt, /minimal edits/i);
});

test("the configured domain anchors the prompt separately from the glossary", async () => {
  const { fn, calls } = recordingGenerateText("ok");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  await polisher.polish({
    translatedText: "운영사 선정",
    targetLanguage: "ko",
    tone: "business",
    domain: "Commercial real estate — hotel investment and asset management",
    glossary: "operator -> 운영사",
  });

  const prompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  assert.match(prompt, /DOMAIN:/);
  assert.match(prompt, /hotel investment and asset management/);
  assert.match(prompt, /operator -> 운영사/);
});

test("a domain alone (no glossary) still triggers polishing", async () => {
  const { fn, calls } = recordingGenerateText("운영사 선정");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  const result = await polisher.polish({
    translatedText: "오퍼레이터 선정",
    targetLanguage: "ko",
    tone: "natural",
    domain: "Commercial real estate",
  });

  assert.equal(result, "운영사 선정");
  assert.equal(calls.length, 1);
});

test("japanese-target polish demands business keigo in the desu-masu register", async () => {
  const { fn, calls } = recordingGenerateText("ok");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  await polisher.polish({ translatedText: "会議を始めます", targetLanguage: "ja", tone: "business" });
  const prompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  assert.match(prompt, /です・ます/);
  assert.match(prompt, /ビジネス敬語/);
});

test("korean-target polish demands natural Korean and bans translationese", async () => {
  const { fn, calls } = recordingGenerateText("ok");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  await polisher.polish({ translatedText: "그것은 시장에 대하여 영향을 가지고 있습니다", targetLanguage: "ko", tone: "business" });
  const koPrompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  // EN->KO must read like native Korean, not translated English: no English
  // word order, no pronoun/passive carry-over, subjects dropped naturally.
  assert.match(koPrompt, /번역투/);
  assert.match(koPrompt, /translationese/i);

  await polisher.polish({ translatedText: "The market is recovering", targetLanguage: "en", tone: "business" });
  const enPrompt = `${calls[1].system ?? ""}\n${calls[1].prompt ?? ""}`;
  assert.doesNotMatch(enPrompt, /번역투/);
});

test("a glossary triggers terminology polishing even in natural tone", async () => {
  const { fn, calls } = recordingGenerateText("운영사 검증");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  const result = await polisher.polish({
    translatedText: "오퍼레이터 검증",
    targetLanguage: "ko",
    tone: "natural",
    glossary: "operator -> 운영사",
  });

  assert.equal(result, "운영사 검증");
  assert.equal(calls.length, 1);
  // Natural tone with a glossary corrects terminology but must NOT impose the
  // business register.
  const prompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  assert.doesNotMatch(prompt, /격식체/);
  assert.doesNotMatch(prompt, /business register/i);
  assert.match(prompt, /natural phrasing/i);
});

test("ellipsis placeholders trigger final subtitle recovery from the source even in natural tone", async () => {
  const { fn, calls } = recordingGenerateText("운영사가 딜을 검증합니다.");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  const result = await polisher.polish({
    translatedText: "...",
    sourceText: "The operator validates the deal",
    targetLanguage: "ko",
    tone: "natural",
    glossary: "operator = 운영사",
  });

  assert.equal(result, "운영사가 딜을 검증합니다.");
  assert.equal(calls.length, 1);
  const prompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  assert.match(prompt, /second-pass finalizer/i);
  assert.match(prompt, /complete, display-ready subtitle cue/i);
  assert.match(prompt, /Check the glossary/i);
  assert.match(prompt, /Do not output ellipses/i);
  assert.match(prompt, /The operator validates the deal/);
});

test("polish skips trivial or empty text without calling the model", async () => {
  const { fn, calls } = recordingGenerateText("x");
  const polisher = createSubtitlePolisher({ generateText: fn, model: "m" });

  assert.equal(await polisher.polish({ translatedText: "", targetLanguage: "ko", tone: "business" }), "");
  assert.equal(await polisher.polish({ translatedText: "  ", targetLanguage: "ko", tone: "business" }), "  ");
  assert.equal(calls.length, 0);
});
