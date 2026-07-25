// @ts-nocheck - injects a fake generateText to exercise the polish contract.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSubtitlePolisher } from "../src/subtitle-polish.js";

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
    targetLanguage: "ko",
    tone: "business",
    glossary: "operator -> 운영사\nMRG, DSCR, RevPAR -> keep verbatim",
  });

  const prompt = `${calls[0].system ?? ""}\n${calls[0].prompt ?? ""}`;
  assert.match(prompt, /operator -> 운영사/);
  assert.match(prompt, /MRG, DSCR, RevPAR/);
  // Professional interpreting termbase discipline: the glossary is a list of
  // SYMMETRIC pairs enforced identically in both directions (KO→EN and
  // EN→KO), not two separate directional lists.
  assert.match(prompt, /bidirectional/i);
  assert.match(prompt, /both KO→EN and EN→KO/);
  assert.match(prompt, /TRANSLATION MEMORY/);
  assert.match(prompt, /full-sentence|clause-level/);
  assert.match(prompt, /close variant/);
  // Figurative source expressions (현주소, 발목을 잡다, 옥석 가리기 …) must be
  // rendered by meaning, never word-for-word.
  assert.match(prompt, /sense-for-sense/);
  assert.match(prompt, /never word-for-word/);
  // And when the TARGET language has an equivalent idiom, prefer it
  // (idiom-for-idiom) over a flat paraphrase — in both directions
  // (옥석 가리기 ↔ separating the wheat from the chaff, 연착륙 ↔ soft landing).
  assert.match(prompt, /idiom-for-idiom/);
  assert.match(prompt, /equivalent idiom/);
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
