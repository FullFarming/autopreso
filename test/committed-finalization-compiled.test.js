import assert from "node:assert/strict";
import test from "node:test";

import { createCommittedCaptionFinalizer } from "../packages/caption-core/committed-finalization.js";

const compiledGlossary = Object.freeze({
  schemaVersion: 1,
  fingerprint: `sha256:${"c".repeat(64)}`,
  version: 7,
  sourceLanguage: "en",
  targetLanguages: Object.freeze(["ko"]),
  domain: "Commercial real estate",
  terms: Object.freeze([Object.freeze({
    id: "cushman",
    source: "Cushman",
    translations: Object.freeze({ ko: "쿠시먼" }),
    aliases: Object.freeze(["Kushiman"]),
    pronunciation: null,
    doNotTranslate: false,
    forbiddenTranslations: Object.freeze(["쿠쉬만"]),
    context: "commercial real estate advisory",
    examples: Object.freeze([]),
    tags: Object.freeze([]),
    priority: 80,
    provenance: Object.freeze({ kind: "manual", label: null }),
  })]),
  lookupEntries: Object.freeze([
    Object.freeze({ termId: "cushman", kind: "source", value: "Cushman", normalizedValue: "cushman", priority: 80 }),
    Object.freeze({ termId: "cushman", kind: "alias", value: "Kushiman", normalizedValue: "kushiman", priority: 80 }),
  ]),
  translationRules: Object.freeze([Object.freeze({
    termId: "cushman",
    source: "Cushman",
    targetLanguage: "ko",
    target: "쿠시먼",
    forbiddenTranslations: Object.freeze(["쿠쉬만"]),
    priority: 80,
  })]),
  doNotTranslate: Object.freeze([]),
  contextEntries: Object.freeze([Object.freeze({
    termId: "cushman",
    tokens: Object.freeze(["commercial", "real", "estate", "advisory"]),
  })]),
});

test("committed finalization consumes the session-pinned compiled slice and releases it exactly once", async () => {
  const polishCalls = [];
  const finalizer = createCommittedCaptionFinalizer({
    sessionId: "compiled-finalizer-session",
    compiledGlossary,
    config: {
      provider: "gemini",
      glossary: "[고유명사 — 회사]\nKushiman = Attacker Corporation",
      tone: "business",
      domain: "Commercial real estate",
      polishPolicy: { mode: "full" },
    },
    async polish(request) {
      polishCalls.push(request);
      return request.translatedText;
    },
  });

  const finalized = await finalizer.finalize({
    sourceText: "Kushiman advised the transaction.",
    translatedText: "쿠쉬만이 거래를 자문했습니다.",
    sourceLanguage: "en",
    targetLanguage: "ko",
  });

  assert.equal(finalized.sourceText, "Cushman advised the transaction.");
  assert.equal(finalized.text, "쿠시먼이 거래를 자문했습니다.");
  assert.equal(polishCalls.length, 1);
  assert.equal(polishCalls[0].glossary, "Cushman = 쿠시먼");
  finalizer.release();
  finalizer.release();
  assert.equal(
    finalizer.termRetriever.retrieve({ sourceText: "Cushman", targetLanguage: "ko", isFinal: true }),
    "",
  );
});

test("an authoritative unpinned result disables client-supplied legacy glossary text", async () => {
  const finalizer = createCommittedCaptionFinalizer({
    sessionId: "authoritative-empty-session",
    compiledGlossary: null,
    config: {
      provider: "gemini",
      glossary: "[고유명사 — 회사]\nKushiman = Attacker Corporation",
      tone: "business",
      domain: "Commercial real estate",
      polishPolicy: { mode: "off" },
    },
  });

  const finalized = await finalizer.finalize({
    sourceText: "Kushiman presented.",
    translatedText: "발표했습니다.",
    sourceLanguage: "en",
    targetLanguage: "ko",
  });
  assert.equal(finalized.sourceText, "Kushiman presented.");
  finalizer.release();
});
