import assert from "node:assert/strict";
import test from "node:test";

import { createCaptionPolisher } from "../src/caption-polish.js";

function makeClient(responder) {
  const requests = [];
  return {
    requests,
    models: {
      async generateContent(request) {
        requests.push(request);
        return responder(request);
      },
    },
  };
}

test("polish rewrites finals with the desktop finalizer prompt (tone, glossary, domain)", async () => {
  const client = makeClient(() => ({ text: "실적이 예상을 상회했습니다." }));
  const polisher = createCaptionPolisher({ client, model: "gemini-3.5-flash" });
  const polished = await polisher.polish({
    translatedText: "실적이 예상보다 좋았어요",
    targetLanguage: "ko",
    tone: "business",
    glossary: "힐튼 가든 인 = Hilton Garden Inn",
    domain: "호텔 자산운용 미팅",
  });
  assert.equal(polished, "실적이 예상을 상회했습니다.");
  const system = String(client.requests[0].config.systemInstruction);
  assert.match(system, /second-pass finalizer/);
  assert.match(system, /격식체 존댓말/);
  assert.match(system, /힐튼 가든 인 = Hilton Garden Inn/);
  assert.match(system, /호텔 자산운용 미팅/);
});

test("polish is skipped entirely for natural tone with no glossary or domain", async () => {
  const client = makeClient(() => ({ text: "SHOULD NOT RUN" }));
  const polisher = createCaptionPolisher({ client, model: "gemini-3.5-flash" });
  const result = await polisher.polish({ translatedText: "hello there", targetLanguage: "en", tone: "natural" });
  assert.equal(result, "hello there");
  assert.equal(client.requests.length, 0);
});

test("polish fails open on provider errors and timeouts", async () => {
  const failing = createCaptionPolisher({ client: makeClient(() => { throw new Error("DOWN"); }), model: "gemini-3.5-flash" });
  assert.equal(await failing.polish({ translatedText: "raw line", targetLanguage: "en", tone: "business" }), "raw line");
  const hanging = createCaptionPolisher({
    client: { models: { generateContent: () => new Promise(() => {}) } },
    model: "gemini-3.5-flash",
    timeoutMs: 20,
  });
  assert.equal(await hanging.polish({ translatedText: "slow line", targetLanguage: "en", tone: "business" }), "slow line");
});
