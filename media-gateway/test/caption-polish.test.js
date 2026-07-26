import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createCaptionPolisher } from "../src/caption-polish.js";
import { createSubtitlePolisher } from "../../src/subtitle-polish.js";

test("gateway polish keeps the desktop six-second budget for full glossary prompts", async () => {
  const source = await readFile(new URL("../src/caption-polish.js", import.meta.url), "utf8");
  assert.match(source, /DEFAULT_TIMEOUT_MS\s*=\s*6000/u);
});

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
    sourceText: "Hilton Garden Inn performed above expectations.",
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

test("desktop and gateway build the same bounded glossary prompt", async () => {
  const irrelevant = Array.from(
    { length: 800 },
    (_, index) => `irrelevant-${index} = 무관-${index}`,
  ).join("\n");
  const glossary = `[규칙]\n- keep section-level rules\n[Terms]\n${irrelevant}\n[Late Names]\nKushiman = Cushman & Wakefield`;
  let desktopSystem = "";
  const desktop = createSubtitlePolisher({
    model: "m",
    async generateText(request) {
      desktopSystem = String(request.system);
      return { text: "Cushman & Wakefield Korea" };
    },
  });
  const gatewayClient = makeClient(() => ({ text: "Cushman & Wakefield Korea" }));
  const gateway = createCaptionPolisher({ client: gatewayClient, model: "m" });
  const input = {
    translatedText: "Kushimanend Wakefield Korea",
    sourceText: "쿠시먼앤드웨이크필드 코리아",
    targetLanguage: "en",
    tone: "business",
    glossary,
    domain: "Commercial real estate",
  };

  await desktop.polish(input);
  await gateway.polish(input);
  const gatewaySystem = String(gatewayClient.requests[0].config.systemInstruction);
  assert.equal(gatewaySystem, desktopSystem);
  assert.match(gatewaySystem, /Kushiman = Cushman & Wakefield/u);
  assert.doesNotMatch(gatewaySystem, /irrelevant-799/u);
  assert.ok((gatewaySystem.split("GLOSSARY:\n")[1] ?? "").length <= 6_000);
});
