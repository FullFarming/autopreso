// @ts-nocheck - fake WebSocket implements only the event surface used by subtitle manager tests.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

import {
  buildSubtitleSession,
  createSubtitleRealtimeManager,
  describeSocketError,
  applyGlossaryCorrections,
  detectSourceLanguage,
  handleRealtimeMessage,
  isSameLanguageEcho,
  isSourceEcho,
  normalizeRealtimeModel,
  normalizeSubtitleOutput,
  normalizeSubtitleSettings,
} from "../src/subtitle-realtime.js";
import { handleGeminiLiveMessage } from "../src/gemini-live-translate.js";
import { getDefaultSubtitleGlossaryContext } from "../src/glossary-presets.js";

test("detectSourceLanguage stays English when Hangul only stray-contaminates English speech (EN→KO robustness)", () => {
  // English being spoken: Latin-dominant with a stray Hangul char (Gemini
  // mis-transcription / a Korean name). MUST detect English so the EN→KO direction
  // doesn't flip the source to Korean and echo the English source back as a subtitle.
  assert.equal(detectSourceLanguage("We look at ADR and GOP this quarter 그"), "en");
  assert.equal(detectSourceLanguage("I met 김철수 at the office downtown yesterday"), "en");
  assert.equal(detectSourceLanguage("The hotel market is recovering strongly this year"), "en");
});

test("detectSourceLanguage keeps Korean for genuinely mixed/code-switch speech (KO→EN robustness)", () => {
  // Korean actually being spoken — Hangul is a meaningful share — must stay Korean,
  // even with heavy English proper nouns/jargon. This is what makes KO→EN solid.
  assert.equal(detectSourceLanguage("안녕하세요 Next slide"), "ko");
  assert.equal(detectSourceLanguage("쿠시먼앤드웨이크필드 코리아가 ADR과 GOP를 봅니다"), "ko");
  assert.equal(detectSourceLanguage("Value-Add 전략으로 NOI를 개선했습니다"), "ko");
  assert.equal(detectSourceLanguage("안녕하세요"), "ko");
});

test("the built-in glossary normalizes the Cushman & Wakefield Korea proper noun", () => {
  const { glossary } = getDefaultSubtitleGlossaryContext({ a: "ko", b: "en" });
  const en = (text) => applyGlossaryCorrections(text, { glossary, targetLanguage: "en", sourceText: text });
  assert.equal(en("쿠시먼앤드웨이크필드 코리아"), "Cushman & Wakefield Korea");
  assert.equal(en("쿠시먼앤드웨이크필드코리아"), "Cushman & Wakefield Korea");
  assert.equal(en("쿠시먼 코리아"), "Cushman & Wakefield Korea");
  assert.equal(en("쿠시먼앤드웨이크필드"), "Cushman & Wakefield");
});

test("isSameLanguageEcho suppresses same-language echoes (incl. empty source) but never real translations", () => {
  // English spoken on the EN channel → English echoed back: suppress.
  assert.equal(isSameLanguageEcho("This is now good", "Hmm. This is now good?", "en"), true);
  // Output-only echo with NO source transcript (the empty-source gap): suppress.
  assert.equal(isSameLanguageEcho("", "This is the smallest company.", "en"), true);
  assert.equal(isSameLanguageEcho("   ", "I'm not saying anything strange.", "en"), true);
  // Korean echoed on the KO channel: suppress.
  assert.equal(isSameLanguageEcho("가장 작은 회사예요", "가장 작은 회사예요.", "ko"), true);

  // Real translations must NEVER be suppressed.
  assert.equal(isSameLanguageEcho("쿠시먼앤드웨이크필드 코리아가 작은 회사예요", "Cushman & Wakefield Korea is a small company.", "en"), false);
  assert.equal(isSameLanguageEcho("This is now good", "이거 지금 좋아요.", "ko"), false);
  // Mixed-language source still needs translating → not an echo.
  assert.equal(isSameLanguageEcho("안녕하세요 Next slide", "다음 슬라이드", "ko"), false);
  // Single-char different-language source is still a real translation.
  assert.equal(isSameLanguageEcho("네", "Yes.", "en"), false);
  // Output not in the target language → let the other gates decide (not an echo here).
  assert.equal(isSameLanguageEcho("Hello", "Hello", "ko"), false);
});

test("Cushman & Wakefield name is normalized from fused/mangled mistranscriptions the glossary can't enumerate", () => {
  // A glossary that merely REFERENCES the company (no per-variant pairs) is
  // enough to enable the fuzzy company-name normalizer.
  const glossary = "- 회사명 동일 지칭: Cushman & Wakefield / 쿠시먼앤드웨이크필드";

  // Fused "and" into the first token, dropped "&", phonetic spellings.
  assert.equal(
    applyGlossaryCorrections("Kushimanend Wakefield Korea.", { glossary, targetLanguage: "en" }),
    "Cushman & Wakefield Korea.",
  );
  assert.equal(
    applyGlossaryCorrections("Cushman and Wakefield said so.", { glossary, targetLanguage: "en" }),
    "Cushman & Wakefield said so.",
  );
  assert.equal(
    applyGlossaryCorrections("K-Field Korea presented.", { glossary, targetLanguage: "en" }),
    "Cushman & Wakefield Korea presented.",
  );
  // Severe garbling with junk words between an invented token and "Field".
  assert.equal(
    applyGlossaryCorrections("Kushima is why Field Korea is the smallest in the market.", { glossary, targetLanguage: "en" }),
    "Cushman & Wakefield Korea is the smallest in the market.",
  );
  // The real word "cushman" near "field" in an ordinary sentence must NOT match.
  assert.equal(
    applyGlossaryCorrections("Cushman presented results in the field today.", { glossary, targetLanguage: "en" }),
    "Cushman presented results in the field today.",
  );
  // Korean phonetic forms collapse to the canonical Korean name.
  assert.equal(
    applyGlossaryCorrections("쿠시만 웨이크 필드 코리아", { glossary, targetLanguage: "ko" }),
    "쿠시먼앤드웨이크필드 코리아",
  );
  // Idempotent on the already-correct names.
  assert.equal(applyGlossaryCorrections("Cushman & Wakefield", { glossary, targetLanguage: "en" }), "Cushman & Wakefield");
  assert.equal(applyGlossaryCorrections("쿠시먼앤드웨이크필드", { glossary, targetLanguage: "ko" }), "쿠시먼앤드웨이크필드");

  // No false positives: ordinary words and the unrelated city stay untouched.
  for (const text of ["Wakefield is a city in England.", "The field is wide open.", "Springfield Korea office"]) {
    assert.equal(applyGlossaryCorrections(text, { glossary, targetLanguage: "en" }), text);
  }
  // Scoped: a glossary that does NOT reference the company never triggers it.
  assert.equal(
    applyGlossaryCorrections("Kushimanend Wakefield Korea.", { glossary: "운영자 = 운영사", targetLanguage: "en" }),
    "Kushimanend Wakefield Korea.",
  );
});

test("the built-in glossary repairs common Cushman mistranscriptions without waiting for polish", () => {
  const { glossary } = getDefaultSubtitleGlossaryContext({ a: "ko", b: "en" });

  assert.equal(
    applyGlossaryCorrections("Kushi Korea", { glossary, targetLanguage: "en", sourceText: "쿠시먼 코리아" }),
    "Cushman & Wakefield Korea",
  );
  assert.equal(
    applyGlossaryCorrections("Kushman presented the market outlook.", { glossary, targetLanguage: "en" }),
    "Cushman & Wakefield presented the market outlook.",
  );
  assert.equal(
    applyGlossaryCorrections("Kushiman, but why K-Field Korea?", { glossary, targetLanguage: "en" }),
    "Cushman & Wakefield, but why Cushman & Wakefield Korea?",
  );
  assert.equal(
    applyGlossaryCorrections("Kushi에서 본 서울 호텔 시장입니다.", { glossary, targetLanguage: "ko" }),
    "쿠시먼앤드웨이크필드에서 본 서울 호텔 시장입니다.",
  );
});

test("the built-in glossary preserves panel brand names and hospitality operating terms", () => {
  const { glossary } = getDefaultSubtitleGlossaryContext({ a: "ko", b: "en" });

  assert.equal(
    applyGlossaryCorrections("First Cabin Myeongdong opened near Noon Square.", { glossary, targetLanguage: "ko" }),
    "퍼스트 캐빈 명동 opened near 눈스퀘어.",
  );
  assert.equal(
    applyGlossaryCorrections("The third-party operator uses a low manning model.", { glossary, targetLanguage: "ko" }),
    "The 써드파티 운영사 uses a 저인력 운영 모델.",
  );
  assert.equal(
    applyGlossaryCorrections("Fire life safety requirements and lift core locations matter.", { glossary, targetLanguage: "ko" }),
    "소방·인명 안전 요건 and 엘리베이터 코어 위치 matter.",
  );
  assert.equal(
    applyGlossaryCorrections("힐튼 가든 인과 햄튼 바이 힐튼", { glossary, targetLanguage: "en" }),
    "Hilton Garden Inn과 Hampton by Hilton",
  );
});

test("isSourceEcho suppresses a same-language passthrough but not a real translation", () => {
  // English spoken on the EN channel → the "translation" IS the source.
  assert.equal(isSourceEcho("Korea. Yeah.", "Korea. Yeah."), true);
  assert.equal(isSourceEcho("Hello there", "hello there."), true);
  // Real translations differ from their source.
  assert.equal(isSourceEcho("안녕하세요 반갑습니다", "Hello, nice to meet you."), false);
  assert.equal(isSourceEcho("쿠시먼앤드웨이크필드 코리아", "Cushman & Wakefield Korea"), false);
  // Empty / tiny inputs don't trigger suppression.
  assert.equal(isSourceEcho("", ""), false);
});

test("buildSubtitleSession uses the official minimal translation session shape", () => {
  const session = buildSubtitleSession({ model: "gpt-realtime-2", languagePair: { a: "en", b: "ko" } }, "ko");

  assert.equal(session.model, undefined);
  assert.equal(session.instructions, undefined);
  assert.equal(session.output_modalities, undefined);
  assert.equal(session.audio.input, undefined);
  assert.deepEqual(session.audio.output, { language: "ko" });
});

test("buildSubtitleSession maps Chinese scripts to OpenAI's single zh output code", () => {
  assert.deepEqual(buildSubtitleSession({}, "zh-Hans").audio.output, { language: "zh" });
  assert.deepEqual(buildSubtitleSession({}, "zh-Hant").audio.output, { language: "zh" });
});

test("normalizeSubtitleOutput handles JSON, partial JSON, and two-line fallback", () => {
  assert.deepEqual(
    normalizeSubtitleOutput('{"translatedText":"안녕하세요","sourceText":"hello"}'),
    { translatedText: "안녕하세요", sourceText: "hello" },
  );
  assert.deepEqual(
    normalizeSubtitleOutput('{"translatedText":"안녕","sourceText":"hel'),
    { translatedText: "안녕", sourceText: "hel" },
  );
  assert.deepEqual(
    normalizeSubtitleOutput("Translation: Hello\nSource: 안녕하세요"),
    { translatedText: "Hello", sourceText: "안녕하세요" },
  );
  assert.deepEqual(
    normalizeSubtitleOutput('{"translatedText":"JP: こんにちは","sourceText":"KO: 안녕하세요"}'),
    { translatedText: "こんにちは", sourceText: "안녕하세요" },
  );
  assert.deepEqual(
    normalizeSubtitleOutput("Eng: Hello."),
    { translatedText: "Hello.", sourceText: "" },
  );
});

test("normalizeSubtitleSettings clamps an unknown tone back to natural", () => {
  assert.equal(normalizeSubtitleSettings({ tone: "casual" }).tone, "natural");
  assert.equal(normalizeSubtitleSettings({ tone: "business" }).tone, "business");
  assert.equal(normalizeSubtitleSettings({}).tone, "natural");
});

test("normalizeSubtitleSettings keeps subtitle defaults bounded", () => {
  const settings = normalizeSubtitleSettings({
    inputMode: "bad",
    translationFontSize: 200,
    sourceFontSize: 1,
    maxWidth: 50,
    opacity: 3,
    position: "unknown",
  });

  assert.equal(settings.inputMode, "system_mic");
  assert.equal(settings.translationFontSize, 96);
  assert.equal(settings.sourceFontSize, 14);
  assert.equal(settings.maxWidth, 320);
  assert.equal(settings.opacity, 1);
  assert.equal(settings.position, "bottom-center");
  assert.equal(settings.model, "gpt-realtime-translate");
  assert.equal(settings.displayMode, "translation_only");
  assert.equal(settings.maxSubtitleLines, 2);
  assert.equal(settings.recordProvider, "ollama");
  assert.equal(settings.showSourceText, false);
  assert.equal(settings.translateAllLanguages, false);
});

test("normalizeRealtimeModel maps voice-agent models to the translation model", () => {
  assert.equal(normalizeRealtimeModel("gpt-realtime-2"), "gpt-realtime-translate");
  assert.equal(normalizeRealtimeModel("gpt-realtime"), "gpt-realtime-translate");
  assert.equal(normalizeRealtimeModel("gpt-realtime-translate"), "gpt-realtime-translate");
});

test("applyGlossaryCorrections enforces configured hospitality terms in realtime text", () => {
  const glossary = [
    "MRG Gap / MRG 차이 = MRG 갭",
    "Focused-service / Focused service / 포커스 서비스 = 포커스드 서비스",
    "운영사 / 운영자 / operating company = operator",
  ].join("\n");

  assert.equal(
    applyGlossaryCorrections("MRG 차이를 줄이는 구조입니다.", { glossary, targetLanguage: "ko" }),
    "MRG 갭을 줄이는 구조입니다.",
  );
  assert.equal(
    applyGlossaryCorrections("포커스 서비스 브랜드 확대", { glossary, targetLanguage: "ko" }),
    "포커스드 서비스 브랜드 확대",
  );
  assert.equal(
    applyGlossaryCorrections("운영자 검증이 중요합니다.", { glossary, targetLanguage: "ko" }),
    "운영사 검증이 중요합니다.",
  );
  assert.equal(
    applyGlossaryCorrections("The operating company must join early.", { glossary, targetLanguage: "en" }),
    "The operator must join early.",
  );
});

test("applyGlossaryCorrections applies hospitality sentence memory in both directions", () => {
  const glossary = [
    "국내 호텔 시장의 변화와 기회 = Changes and Opportunities in Korea's Hotel Market",
    "좋은 시장은 기회를 만들지만, 그 기회를 딜로 바꾸는 건 체계적인 검증에서 나옵니다 = A strong market creates opportunities, but turning those opportunities into deals comes from systematic validation.",
  ].join("\n");

  assert.equal(
    applyGlossaryCorrections("국내 호텔 시장의 변화와 기회", { glossary, targetLanguage: "en" }),
    "Changes and Opportunities in Korea's Hotel Market",
  );
  assert.equal(
    applyGlossaryCorrections("Changes and Opportunities in Korea's Hotel Market", { glossary, targetLanguage: "ko" }),
    "국내 호텔 시장의 변화와 기회",
  );
  assert.equal(
    applyGlossaryCorrections("좋은 시장은 기회를 만들지만, 그 기회를 딜로 바꾸는 건 체계적인 검증에서 나옵니다", { glossary, targetLanguage: "en" }),
    "A strong market creates opportunities, but turning those opportunities into deals comes from systematic validation.",
  );
});

test("applyGlossaryCorrections prefers registered source idioms before raw translation wording", () => {
  const glossary = [
    '현주소 = current landscape ("현재 상황"의 뜻. NEVER "current address")',
    "국내 호텔 시장의 변화와 기회 = Changes and Opportunities in Korea's Hotel Market",
  ].join("\n");

  assert.equal(
    applyGlossaryCorrections("current address", { glossary, targetLanguage: "en", sourceText: "현주소" }),
    "current landscape",
  );
  assert.equal(
    applyGlossaryCorrections("Changes in the domestic hotel market", {
      glossary,
      targetLanguage: "en",
      sourceText: "국내 호텔 시장의 변화와 기회",
    }),
    "Changes and Opportunities in Korea's Hotel Market",
  );
});

test("handleRealtimeMessage renders realtime translation transcript deltas", () => {
  let sourceText = "";
  let translatedText = "";
  const broadcasts = [];
  const ctx = {
    source: "mic",
    targetLanguage: "en",
    getSourceText: () => sourceText,
    setSourceText: (value) => { sourceText = value; },
    getTranslatedText: () => translatedText,
    setTranslatedText: (value) => { translatedText = value; },
    emitPartial: () => {
      broadcasts.push({
        type: "subtitle:partial",
        source: "mic",
        targetLanguage: "en",
        sourceText: sourceText.trim(),
        translatedText: translatedText.trim(),
      });
    },
    scheduleCommit: () => {},
    broadcast: (message) => broadcasts.push(message),
  };

  handleRealtimeMessage(JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕" }), ctx);
  handleRealtimeMessage(JSON.stringify({ type: "session.input_transcript.delta", delta: "하세요" }), ctx);
  handleRealtimeMessage(JSON.stringify({ type: "session.output_transcript.delta", delta: "Hello." }), ctx);

  assert.equal(broadcasts[0].type, "subtitle:partial");
  assert.equal(broadcasts[0].source, "mic");
  assert.equal(broadcasts[0].sourceText, "안녕");
  assert.equal(broadcasts[1].sourceText, "안녕하세요");
  assert.deepEqual(
    { translatedText: broadcasts.at(-1).translatedText, sourceText: broadcasts.at(-1).sourceText },
    { translatedText: "Hello.", sourceText: "안녕하세요" },
  );
});

test("invalid realtime JSON is reported without reflecting untrusted raw input", () => {
  const broadcasts = [];
  handleRealtimeMessage("{<script>secret-token</script>", {
    broadcast: (message) => broadcasts.push(message),
  });

  assert.deepEqual(broadcasts, [{
    type: "subtitle:error",
    message: "Invalid realtime message.",
    code: "INVALID_REALTIME_MESSAGE",
  }]);
});

test("OpenAI and Gemini transcript accumulation stays bounded", () => {
  let openAiSource = "";
  handleRealtimeMessage(JSON.stringify({
    type: "session.input_transcript.delta",
    delta: "A".repeat(50_000),
  }), {
    getSourceText: () => openAiSource,
    setSourceText: (value) => { openAiSource = value; },
  });
  assert.ok(openAiSource.length <= 16_384);

  let geminiSource = "";
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { inputTranscription: { text: "가".repeat(50_000) } },
  }), {
    getSourceText: () => geminiSource,
    setSourceText: (value) => { geminiSource = value; },
  });
  assert.ok(geminiSource.length <= 16_384);
});

test("SUBTITLE_DEBUG requires an explicit enabled value", () => {
  const previous = process.env.SUBTITLE_DEBUG;
  process.env.SUBTITLE_DEBUG = "0";
  const broadcasts = [];
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { inputTranscription: { text: "Hello", languageCode: "en" } },
  }), {
    getSourceText: () => "",
    setSourceText: () => {},
    broadcast: (message) => broadcasts.push(message),
  });
  if (previous === undefined) delete process.env.SUBTITLE_DEBUG;
  else process.env.SUBTITLE_DEBUG = previous;

  assert.equal(broadcasts.some((message) => message.type === "subtitle:debug"), false);
});

test("subtitle channel waits for stable source language before displaying target transcript", () => {
  let sourceText = "";
  let translatedText = "";
  const broadcasts = [];
  const shouldDisplay = () => {
    if (sourceText.length < 4) return false;
    const sourceLanguage = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(sourceText) ? "ko" : /[A-Za-z]/.test(sourceText) ? "en" : "unknown";
    if (sourceLanguage === "unknown") return false;
    return "ko" !== sourceLanguage;
  };
  const ctx = {
    source: "mic",
    targetLanguage: "ko",
    getSourceText: () => sourceText,
    setSourceText: (value) => { sourceText = value; },
    getTranslatedText: () => translatedText,
    setTranslatedText: (value) => { translatedText = value; },
    shouldDisplay,
    emitPartial: () => {
      if (!shouldDisplay() || !translatedText.trim()) return;
      broadcasts.push({
        type: "subtitle:partial",
        source: "mic",
        targetLanguage: "ko",
        sourceText: sourceText.trim(),
        translatedText: translatedText.trim(),
      });
    },
    scheduleCommit: () => {},
    broadcast: (message) => broadcasts.push(message),
  };

  handleRealtimeMessage(JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요." }), ctx);
  assert.deepEqual(broadcasts, []);

  handleRealtimeMessage(JSON.stringify({ type: "session.input_transcript.delta", delta: "He" }), ctx);
  assert.deepEqual(broadcasts, []);

  handleRealtimeMessage(JSON.stringify({ type: "session.input_transcript.delta", delta: "llo" }), ctx);
  assert.deepEqual(broadcasts.at(-1), { type: "subtitle:partial", source: "mic", targetLanguage: "ko", sourceText: "Hello", translatedText: "안녕하세요." });
});

test("same-language translation channel is suppressed after source language is known", () => {
  let sourceText = "";
  let translatedText = "";
  const broadcasts = [];
  const shouldDisplay = () => {
    if (!sourceText) return false;
    const sourceLanguage = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(sourceText) ? "ko" : /[A-Za-z]/.test(sourceText) ? "en" : "unknown";
    if (sourceLanguage === "unknown") return false;
    return "en" !== sourceLanguage;
  };
  const ctx = {
    source: "mic",
    targetLanguage: "en",
    getSourceText: () => sourceText,
    setSourceText: (value) => { sourceText = value; },
    getTranslatedText: () => translatedText,
    setTranslatedText: (value) => { translatedText = value; },
    shouldDisplay,
    emitPartial: () => {
      if (!shouldDisplay() || !translatedText.trim()) return;
      broadcasts.push({ type: "subtitle:partial", translatedText: translatedText.trim() });
    },
    scheduleCommit: () => {},
    broadcast: (message) => broadcasts.push(message),
  };

  handleRealtimeMessage(JSON.stringify({ type: "session.output_transcript.delta", delta: "Hello." }), ctx);
  handleRealtimeMessage(JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello" }), ctx);

  assert.deepEqual(broadcasts, []);
});

test("subtitle channel displays English after Korean using the recent source segment language", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕하세요" }));
  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "Hello." }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕하세요" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕." }));

  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: " Next slide" }));
  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: " Next slide" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: " Next slide" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.done", transcript: "안녕하세요 Next slide" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: " 다음 슬라이드" }));

  const partials = broadcasts.filter((message) => message.type === "subtitle:partial");
  assert.deepEqual(
    partials.map((message) => ({
      targetLanguage: message.targetLanguage,
      sourceText: message.sourceText,
      translatedText: message.translatedText,
    })),
    [
      { targetLanguage: "en", sourceText: "안녕하세요", translatedText: "Hello." },
      { targetLanguage: "ko", sourceText: "Next slide", translatedText: "다음 슬라이드" },
    ],
  );
});

test("subtitle manager holds translated deltas until source language is stable", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요." }));
  assert.equal(broadcasts.some((message) => message.type === "subtitle:partial"), false);

  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "He" }));
  assert.equal(broadcasts.some((message) => message.type === "subtitle:partial"), false);

  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "llo" }));
  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.deepEqual(partial, {
    type: "subtitle:partial",
    source: "mic",
    targetLanguage: "ko",
    sourceLanguage: "en",
    translationRole: 1,
    sourceText: "Hello",
    translatedText: "안녕하세요.",
  });
});

test("subtitle manager holds incomplete translated deltas until the line looks stable", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "좋은 시장은 기회를 만들지만" }));
  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "A strong market creates" }));

  assert.deepEqual(broadcasts.filter((message) => message.type === "subtitle:partial"), []);

  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: " opportunities." }));
  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.deepEqual(
    { targetLanguage: partial?.targetLanguage, sourceLanguage: partial?.sourceLanguage, translatedText: partial?.translatedText },
    { targetLanguage: "en", sourceLanguage: "ko", translatedText: "A strong market creates opportunities." },
  );
});

test("subtitle manager releases long unpunctuated partials within the realtime hold budget", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "This market needs a systematic validation framework" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "이 시장은 체계적인 검증 프레임워크 확보가 핵심" }));

  assert.deepEqual(broadcasts.filter((message) => message.type === "subtitle:partial"), []);
  await new Promise((resolve) => setTimeout(resolve, 480));

  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.deepEqual(
    { targetLanguage: partial?.targetLanguage, sourceLanguage: partial?.sourceLanguage, translatedText: partial?.translatedText },
    { targetLanguage: "ko", sourceLanguage: "en", translatedText: "이 시장은 체계적인 검증 프레임워크 확보가 핵심" },
  );
});

test("subtitle manager holds short unpunctuated partials until the source is stable enough", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "Okay" }));
  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "좋아요" }));

  assert.deepEqual(broadcasts.filter((message) => message.type === "subtitle:partial"), []);
  await new Promise((resolve) => setTimeout(resolve, 480));

  assert.deepEqual(broadcasts.filter((message) => message.type === "subtitle:partial"), []);
});

test("subtitle manager routes delayed-source output only through matching target-language channels", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "Hello." }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요." }));
  assert.deepEqual(broadcasts.filter((message) => message.type === "subtitle:partial"), []);

  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕하세요" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello" }));

  assert.deepEqual(
    broadcasts.filter((message) => message.type === "subtitle:partial").map((message) => ({
      targetLanguage: message.targetLanguage,
      translatedText: message.translatedText,
    })),
    [
      { targetLanguage: "en", translatedText: "Hello." },
      { targetLanguage: "ko", translatedText: "안녕하세요." },
    ],
  );
});

test("subtitle manager can fan any supported source language out to the other two languages", async () => {
  const cases = [
    {
      sourceText: "안녕하세요",
      outputs: { en: "Hello.", ko: "안녕하세요.", ja: "こんにちは。" },
      expected: [
        { targetLanguage: "en", sourceText: "안녕하세요", translatedText: "Hello." },
        { targetLanguage: "ja", sourceText: "안녕하세요", translatedText: "こんにちは。" },
      ],
      roles: { en: 1, ja: 2 },
    },
    {
      sourceText: "Hello",
      outputs: { en: "Hello.", ko: "안녕하세요.", ja: "こんにちは。" },
      expected: [
        { targetLanguage: "ko", sourceText: "Hello", translatedText: "안녕하세요." },
        { targetLanguage: "ja", sourceText: "Hello", translatedText: "こんにちは。" },
      ],
      roles: { ko: 1, ja: 2 },
    },
    {
      sourceText: "こんにちは",
      outputs: { en: "Hello.", ko: "안녕하세요.", ja: "こんにちは。" },
      expected: [
        { targetLanguage: "en", sourceText: "こんにちは", translatedText: "Hello." },
        { targetLanguage: "ko", sourceText: "こんにちは", translatedText: "안녕하세요." },
      ],
      roles: { en: 1, ko: 2 },
    },
  ];

  for (const item of cases) {
    const sockets = [];
    const broadcasts = [];
    const manager = createSubtitleRealtimeManager({
      broadcast: (message) => broadcasts.push(message),
      settingsStore: {
        load: async () => ({
          apiKeys: { openai: "sk-test" },
          subtitle: { translationProvider: "openai",
            inputMode: "mic",
            languagePair: { a: "en", b: "ko" },
            translateAllLanguages: true,
          },
        }),
      },
      createWebSocket: (url, protocols, init) => {
        const socket = new FakeSocket(url, init);
        sockets.push(socket);
        return socket;
      },
    });

    await manager.start({ sessionId: `active-${item.sourceText}` });
    assert.equal(sockets.length, 3);

    for (const [index, targetLanguage] of ["en", "ko", "ja"].entries()) {
      sockets[index].emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: item.sourceText }));
      sockets[index].emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: item.outputs[targetLanguage] }));
    }

    assert.deepEqual(
      broadcasts.filter((message) => message.type === "subtitle:partial").map((message) => ({
        targetLanguage: message.targetLanguage,
        sourceText: message.sourceText,
        translatedText: message.translatedText,
      })),
      item.expected,
    );
    assert.deepEqual(
      Object.fromEntries(broadcasts.filter((message) => message.type === "subtitle:partial").map((message) => [message.targetLanguage, message.translationRole])),
      item.roles,
    );
  }
});

test("all-language OpenAI subtitles use one channel per output language, distributed across the two keys", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-primary", openaiSecondary: "sk-secondary" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translateAllLanguages: true,
          translationProvider: "openai",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });

  // gpt-realtime-translate is output-language-only, so exactly one channel per
  // target (no duplicate Korean channel). Targets spread across the two keys.
  assert.equal(sockets.length, 3);
  assert.deepEqual(
    sockets.map((socket) => socket.init.headers.Authorization),
    ["Bearer sk-primary", "Bearer sk-primary", "Bearer sk-secondary"],
  );
  assert.deepEqual(
    sockets.map((socket) => socket.init.headers["OpenAI-Safety-Identifier"]),
    [
      "realtime-noel-subtitles-mic-en-api1",
      "realtime-noel-subtitles-mic-ko-api1",
      "realtime-noel-subtitles-mic-ja-api2",
    ],
  );
});

test("all-language subtitles use selected translation languages instead of a fixed EN-KO-JA list", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-primary", openaiSecondary: "sk-secondary" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "ko", b: "ja" },
          translationLanguages: ["ko", "ja", "en"],
          translateAllLanguages: true,
          translationProvider: "openai",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });

  // translationLanguages order [ko, ja, en] → one channel each, first half on
  // key 1, the rest on key 2.
  assert.equal(sockets.length, 3);
  assert.deepEqual(
    sockets.map((socket) => socket.init.headers["OpenAI-Safety-Identifier"]),
    [
      "realtime-noel-subtitles-mic-ko-api1",
      "realtime-noel-subtitles-mic-ja-api1",
      "realtime-noel-subtitles-mic-en-api2",
    ],
  );
  assert.deepEqual(
    sockets.map((socket) => socket.init.headers.Authorization),
    ["Bearer sk-primary", "Bearer sk-primary", "Bearer sk-secondary"],
  );
});

test("the single Korean channel shows Korean for both English and Japanese input (no duplicate channel)", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-primary", openaiSecondary: "sk-secondary" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translateAllLanguages: true,
          translationProvider: "openai",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  // targets [en, ko, ja] → exactly one Korean channel (index 1). No second
  // Korean socket exists to collide with it.
  assert.equal(sockets.length, 3);
  const korean = sockets[1];

  korean.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello" }));
  korean.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요." }));

  assert.deepEqual(
    broadcasts.filter((message) => message.type === "subtitle:partial").map((message) => ({
      targetLanguage: message.targetLanguage,
      sourceLanguage: message.sourceLanguage,
      translatedText: message.translatedText,
    })),
    [{ targetLanguage: "ko", sourceLanguage: "en", translatedText: "안녕하세요." }],
  );

  broadcasts.length = 0;
  korean.emit("message", JSON.stringify({ type: "session.input_audio_buffer.speech_started" }));
  korean.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "こんにちは" }));
  korean.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요." }));

  assert.deepEqual(
    broadcasts.filter((message) => message.type === "subtitle:partial").map((message) => ({
      targetLanguage: message.targetLanguage,
      sourceLanguage: message.sourceLanguage,
      translatedText: message.translatedText,
    })),
    [{ targetLanguage: "ko", sourceLanguage: "ja", translatedText: "안녕하세요." }],
  );
});

test("all-language OpenAI subtitles ignore Gemini routing and use only OpenAI project keys", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-primary", openaiSecondary: "sk-secondary", gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translateAllLanguages: true,
          translationProvider: "openai",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });

  // ja routes to Gemini whenever a Gemini key exists (even in all-language
  // mode) so it isn't stuck on the slow OpenAI translate model; en/ko stay on
  // OpenAI. One channel per output language.
  assert.equal(sockets.length, 3);
  assert.deepEqual(
    sockets.slice(0, 2).map((socket) => socket.url),
    [
      "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate",
      "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate",
    ],
  );
  assert.match(sockets[2].url, /generativelanguage\.googleapis\.com/);
  assert.deepEqual(
    sockets.slice(0, 2).map((socket) => socket.init.headers.Authorization),
    ["Bearer sk-primary", "Bearer sk-primary"],
  );
});

test("gemini provider splits 3 target languages across two gemini keys in parallel", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-primary", geminiSecondary: "AIza-secondary" },
        subtitle: {
          inputMode: "mic",
          translationLanguages: ["en", "ko", "ja"],
          translateAllLanguages: true,
          translationProvider: "gemini",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });

  // Mirrors the OpenAI two-key split: targets [en, ko, ja] → first half on the
  // primary Gemini project, the rest on the secondary, all on Gemini Live.
  assert.equal(sockets.length, 3);
  for (const socket of sockets) assert.match(socket.url, /generativelanguage\.googleapis\.com/);
  assert.match(sockets[0].url, /key=AIza-primary/);
  assert.match(sockets[1].url, /key=AIza-primary/);
  assert.match(sockets[2].url, /key=AIza-secondary/);
});

test("gemini provider with a single key keeps every target on the primary key", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-primary" },
        subtitle: {
          inputMode: "mic",
          translationLanguages: ["en", "ko", "ja"],
          translateAllLanguages: true,
          translationProvider: "gemini",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });

  // No secondary key → unchanged single-key behavior: all three on the primary.
  assert.equal(sockets.length, 3);
  for (const socket of sockets) assert.match(socket.url, /key=AIza-primary/);
});

test("a dropped Gemini session auto-reconnects and resumes with the saved handle", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", translationLanguages: ["en", "ko"], translationProvider: "gemini", outputMode: "audio", audioLanguage: "en" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const initialCount = sockets.length; // en + ko channels
  const en = sockets[0];
  en.emit("open");
  en.emit("message", JSON.stringify({ setupComplete: {} }));
  en.emit("message", JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-123" } }));
  // Server-side drop / duration cap (NOT a deliberate stop) → must reconnect.
  en.emit("close", 1011, Buffer.from("session expired"));
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.ok(sockets.length > initialCount, "the dropped channel should auto-reconnect");
  const reconnected = sockets[sockets.length - 1];
  assert.match(reconnected.url, /generativelanguage\.googleapis\.com/);
  reconnected.emit("open");
  const setup = JSON.parse(reconnected.sent[0]);
  assert.deepEqual(setup.setup.sessionResumption, { handle: "resume-123" });
  reconnected.emit("message", JSON.stringify({ setupComplete: {} }));
  en.emit("message", JSON.stringify({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(4_800).toString("base64") } }] } },
  }));
  assert.equal(
    broadcasts.filter((message) => message.type === "subtitle:translated-audio").length,
    0,
    "a stale socket must not replay pre-resumption audio into the replacement channel",
  );
});

test("a deliberately stopped Gemini channel does not auto-reconnect", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", translationLanguages: ["en", "ko"], translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const initialCount = sockets.length;
  await manager.stop("active");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(sockets.length, initialCount, "a stopped session must stay down");
});

test("two-language OpenAI subtitles keep using the primary key even when a secondary key exists", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-primary", openaiSecondary: "sk-secondary" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translateAllLanguages: false,
          translationProvider: "openai",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });

  assert.equal(sockets.length, 2);
  assert.deepEqual(
    sockets.map((socket) => socket.init.headers.Authorization),
    ["Bearer sk-primary", "Bearer sk-primary"],
  );
});

test("subtitle manager suppresses wrong-language delayed-source output and stale replay", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" } },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요." }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "Hello." }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello" }));

  assert.deepEqual(
    broadcasts.filter((message) => message.type === "subtitle:partial"),
    [],
  );

  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요." }));
  assert.deepEqual(
    broadcasts.filter((message) => message.type === "subtitle:partial"),
    [{ type: "subtitle:partial", source: "mic", targetLanguage: "ko", sourceLanguage: "en", translationRole: 1, sourceText: "Hello", translatedText: "안녕하세요." }],
  );
});

test("handleRealtimeMessage ignores realtime response text to avoid hallucinated subtitles", async () => {
  const broadcasts = [];
  const ctx = {
    source: "system",
    setText: () => {},
    broadcast: (message) => broadcasts.push(message),
  };

  handleRealtimeMessage(JSON.stringify({ type: "response.output_text.delta", delta: "Yes, I can hear you now." }), ctx);
  handleRealtimeMessage(JSON.stringify({
    type: "response.content_part.done",
    part: { type: "text", text: '{"translatedText":"Hello","sourceText":"안녕"}' },
  }), ctx);
  handleRealtimeMessage(JSON.stringify({
    type: "response.output_item.done",
    item: { content: [{ type: "output_text", text: '{"translatedText":"안녕","sourceText":"Hello"}' }] },
  }), ctx);

  assert.deepEqual(broadcasts, []);
});

test("handleRealtimeMessage broadcasts natural hearing and translating states", () => {
  const broadcasts = [];
  const ctx = {
    source: "system",
    broadcast: (message) => broadcasts.push(message),
  };

  handleRealtimeMessage(JSON.stringify({ type: "session.input_audio_buffer.speech_started" }), ctx);
  handleRealtimeMessage(JSON.stringify({ type: "session.input_audio_buffer.speech_stopped" }), ctx);
  handleRealtimeMessage(JSON.stringify({ type: "session.updated" }), ctx);

  assert.deepEqual(broadcasts, [
    { type: "subtitle:status", status: "hearing", source: "system", targetLanguage: "ko" },
    { type: "subtitle:status", status: "translating", source: "system", targetLanguage: "ko" },
    { type: "subtitle:status", status: "api_ready", source: "system", targetLanguage: "ko" },
  ]);
});

test("subtitle manager ignores stale session audio and tags source streams", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "system_mic", model: "gpt-realtime-2" },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  assert.equal(sockets.length, 4);
  manager.sendAudio({ sessionId: "stale", source: "mic", audio: "AAAA" });
  assert.equal(sockets.length, 4);

  manager.sendAudio({ sessionId: "active", source: "mic", audio: "AAAA" });
  sockets[2].emit("open");

  assert.equal(sockets[2].url, "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate");
  assert.equal(sockets[2].init.headers.Authorization, "Bearer sk-test");
  assert.equal(sockets[2].init.headers["OpenAI-Safety-Identifier"], "realtime-noel-subtitles-mic-en");
  assert.equal(JSON.parse(sockets[2].sent[0]).type, "session.update");
  assert.equal(JSON.parse(sockets[2].sent[1]).type, "session.input_audio_buffer.append");
  assert.deepEqual(broadcasts[0], { type: "subtitle:status", status: "connecting" });
  assert.deepEqual(broadcasts[1], { type: "subtitle:status", status: "listening" });
});

test("subtitle manager streams audio continuously without response lifecycle events", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", model: "gpt-realtime" },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  sockets[0].emit("open");
  manager.sendAudio({ sessionId: "active", source: "mic", audio: "AAAA" });

  const sentTypes = sockets[0].sent.map((message) => JSON.parse(message).type);
  assert.deepEqual(sentTypes, ["session.update", "session.input_audio_buffer.append"]);
});

test("subtitle manager caps pending audio before realtime sockets are ready", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", model: "gpt-realtime" },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  for (let index = 0; index < 18_000; index += 1) {
    manager.sendAudio({ sessionId: "active", source: "mic", audio: `CHUNK-${String(index).padStart(3, "0")}` });
  }
  sockets[0].emit("open");

  const audioMessages = sockets[0].sent
    .map((message) => JSON.parse(message))
    .filter((message) => message.type === "session.input_audio_buffer.append");
  assert.equal(audioMessages.length, 8);
  assert.equal(audioMessages[0].audio, "CHUNK-17992");
  assert.equal(audioMessages.at(-1).audio, "CHUNK-17999");
});

test("subtitle manager drops setup-buffered audio older than the realtime budget", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const sockets = [];
    const manager = createSubtitleRealtimeManager({
      settingsStore: { load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", model: "gpt-realtime" },
      }) },
      createWebSocket: (url, protocols, init) => {
        const socket = new FakeSocket(url, init);
        sockets.push(socket);
        return socket;
      },
    });
    await manager.start({ sessionId: "active" });
    manager.sendAudio({ sessionId: "active", source: "mic", audio: "STALE" });
    now += 800;
    manager.sendAudio({ sessionId: "active", source: "mic", audio: "FRESH" });
    sockets[0].emit("open");
    const audioMessages = sockets[0].sent.map((message) => JSON.parse(message))
      .filter((message) => message.type === "session.input_audio_buffer.append");
    assert.deepEqual(audioMessages.map((message) => message.audio), ["FRESH"]);
    await manager.stop("active");
  } finally {
    Date.now = originalNow;
  }
});

test("subtitle manager treats realtime socket errors as recoverable reconnects", async () => {
  const sockets = [];
  const broadcasts = [];
  const warnings = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", model: "gpt-realtime-translate" },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    log: { warn: (message) => warnings.push(message) },
  });

  await manager.start({ sessionId: "active" });
  sockets[0].emit("open");
  sockets[0].emit("error", new Error("network down"));
  manager.sendAudio({ sessionId: "active", source: "mic", audio: "AAAA" });
  sockets[2].emit("open");

  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 3);
  assert.deepEqual(
    broadcasts.filter((message) => message.type === "subtitle:status" && message.status === "reconnecting"),
    [{ type: "subtitle:status", status: "reconnecting", source: "mic", targetLanguage: "en" }],
  );
  assert.equal(JSON.parse(sockets[2].sent[0]).type, "session.update");
  assert.equal(JSON.parse(sockets[2].sent[1]).type, "session.input_audio_buffer.append");
  assert.match(warnings[0], /network down/);
});

test("subtitle stop gracefully closes realtime sessions before dropping sockets", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", model: "gpt-realtime-translate" },
      }),
    },
    createWebSocket: (url, protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  sockets[0].emit("open");
  sockets[1].emit("open");
  await manager.stop("active");

  assert.deepEqual(
    sockets.map((socket) => socket.sent.at(-1)).map((message) => JSON.parse(message).type),
    ["session.close", "session.close"],
  );
  assert.deepEqual(sockets.map((socket) => socket.closed), [true, true]);
});

test("output completion commits once and resets subtitle channel text", () => {
  let sourceText = "Hello";
  let translatedText = "안녕하세요";
  const broadcasts = [];
  const ctx = {
    source: "mic",
    targetLanguage: "ko",
    getSourceText: () => sourceText,
    setSourceText: (value) => { sourceText = value; },
    getTranslatedText: () => translatedText,
    setTranslatedText: (value) => { translatedText = value; },
    shouldDisplay: () => true,
    broadcast: (message) => broadcasts.push(message),
  };

  handleRealtimeMessage(JSON.stringify({ type: "session.output_transcript.done" }), ctx);
  handleRealtimeMessage(JSON.stringify({ type: "session.output_transcript.done" }), ctx);

  assert.deepEqual(broadcasts, [{
    type: "subtitle:committed",
    source: "mic",
    targetLanguage: "ko",
    sourceText: "Hello",
    translatedText: "안녕하세요",
  }]);
  assert.equal(sourceText, "");
  assert.equal(translatedText, "");
});

function businessToneManager({ broadcast, sockets, polish, tone = "business", polishTimeoutMs }) {
  return createSubtitleRealtimeManager({
    broadcast,
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" }, tone },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish,
    polishTimeoutMs,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("committed subtitle is polished by the injected polisher while partials stay raw", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async ({ translatedText, tone }) => (tone === "business" ? `[격식] ${translatedText}` : translatedText),
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요." }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello" }));

  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.equal(partial.translatedText, "안녕하세요.", "partials must stay raw (realtime feel)");

  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "안녕하세요." }));
  await tick();

  const committed = broadcasts.find((message) => message.type === "subtitle:committed");
  assert.equal(committed.translatedText, "[격식] 안녕하세요.");
  assert.equal(committed.sourceText, "Hello");
});

test("partial subtitle stays raw so realtime predictions are not locally rewritten", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai",
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          glossary: '현주소 = current landscape ("현재 상황"의 뜻. NEVER "current address")',
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "current address." }));
  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "서울 호텔 현주소" }));

  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.equal(partial.translatedText, "current address.");
});

test("empty glossary does not apply hidden default rewrites to model translations", async () => {
  const sockets = [];
  const broadcasts = [];
  const polishArgs = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" }, glossary: "" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async (args) => { polishArgs.push(args); return args.translatedText; },
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "current address." }));
  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "서울 호텔 현주소" }));

  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.equal(partial.translatedText, "current address.");

  englishTarget.emit("message", JSON.stringify({ type: "session.input_audio_buffer.speech_started" }));
  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "좋은 시장은 기회를 만들지만, 그 기회를 딜로 바꾸는 건 체계적인 검증에서 나옵니다" }));
  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "A good market creates chances." }));
  await tick();

  const committed = broadcasts.find((message) => message.type === "subtitle:committed");
  assert.equal(committed.translatedText, "A good market creates chances.");
  assert.equal(polishArgs.length, 0, "default glossary must stay local in natural tone to preserve realtime commits");
});

test("configured glossary uses the second-pass polisher in natural tone", async () => {
  const sockets = [];
  const polishArgs = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-primary", openaiSecondary: "sk-secondary" },
        subtitle: { translationProvider: "openai",
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          tone: "natural",
          glossary: "운영자 = 운영사",
          translationDomain: "Commercial real estate",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async (args) => { polishArgs.push(args); return "운영사가 딜을 검증합니다"; },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "The operator validates the deal" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "운영자가 딜을 검증합니다" }));
  await tick();

  const committed = broadcasts.find((message) => message.type === "subtitle:committed");
  assert.equal(committed.translatedText, "운영사가 딜을 검증합니다");
  assert.equal(polishArgs.length, 1);
  assert.equal(polishArgs[0].translatedText, "운영자가 딜을 검증합니다");
  assert.equal(polishArgs[0].glossary, "운영자 = 운영사");
  assert.equal(polishArgs[0].domain, "Commercial real estate");
  assert.equal(polishArgs[0].tone, "natural");
});

test("deterministic glossary correction is enforced after polish when the LLM misses a registered term", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-primary", openaiSecondary: "sk-secondary" },
        subtitle: { translationProvider: "openai",
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          tone: "natural",
          glossary: "운영자 = 운영사",
          translationDomain: "Commercial real estate",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    // Simulate the live polisher leaving the registered term uncorrected — a
    // large glossary that the LLM does not exhaustively apply.
    polish: async () => "운영자가 거래를 확인합니다",
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "The operator validates the deal" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "운영자가 딜을 검증합니다" }));
  await tick();

  const committed = broadcasts.find((message) => message.type === "subtitle:committed");
  assert.equal(
    committed.translatedText,
    "운영사가 거래를 확인합니다",
    "the deterministic glossary pass must enforce 운영자 → 운영사 even after the polisher returns it uncorrected",
  );
});

test("committed subtitle falls back to raw text when polish throws", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async () => { throw new Error("polish down"); },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "안녕하세요." }));
  await tick();

  const committed = broadcasts.find((message) => message.type === "subtitle:committed");
  assert.equal(committed.translatedText, "안녕하세요.");
});

test("a committed line being polished is dropped when the session is torn down", async () => {
  const sockets = [];
  const broadcasts = [];
  let releasePolish;
  const polishGate = new Promise((resolve) => { releasePolish = resolve; });
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async ({ translatedText }) => { await polishGate; return `P:${translatedText}`; },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "안녕하세요." }));

  await manager.stop();
  releasePolish();
  await tick();

  assert.equal(broadcasts.some((message) => message.type === "subtitle:committed"), false);
});

test("a hung polisher falls back to raw finals in order and its late result is ignored", async () => {
  const sockets = [];
  const broadcasts = [];
  let releaseFirst;
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polishTimeoutMs: 10,
    polish: async ({ translatedText }) => {
      if (translatedText === "첫째") await new Promise((resolve) => { releaseFirst = resolve; });
      return `P:${translatedText}`;
    },
  });
  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "First" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "첫째" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Second" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "둘째" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseFirst();
  await tick();
  assert.deepEqual(broadcasts.filter((message) => message.type === "subtitle:committed").map((message) => message.translatedText), ["첫째", "P:둘째"]);
  await manager.stop("active");
});

test("end-to-end: a garbled company name in a committed Gemini line is normalized through the real pipeline", async () => {
  // Drives the actual createTranslationChannel commit path (not just the helper)
  // with the exact garbling seen on screen ("Kushima is why Field Korea").
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test", geminiSecondary: "AIza-test-2" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translationProvider: "gemini",
          tone: "business",
          glossary: "- 회사명 동일 지칭: 쿠시먼앤드웨이크필드 / Cushman & Wakefield / C&W 는 모두 같은 회사다.",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    // Polisher passthrough (simulates the LLM NOT fixing the garble) so the test
    // proves the DETERMINISTIC normalizer in the commit path repairs it.
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  englishTarget.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "쿠시먼앤드웨이크필드 코리아가 가장 작은 회사예요", languageCode: "ko" },
      outputTranscription: { text: "Kushima is why Field Korea is the smallest company." },
    },
  }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await tick();

  const committed = broadcasts.find((m) => m.type === "subtitle:committed" && m.targetLanguage === "en");
  assert.ok(committed, "the ko→en line should commit");
  assert.equal(committed.translatedText, "Cushman & Wakefield Korea is the smallest company.");
});

test("gemini provider opens Gemini Live sockets and routes polished committed subtitles", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translationProvider: "gemini",
          tone: "business",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText, tone }) => (tone === "business" ? `[B] ${translatedText}` : translatedText),
  });

  await manager.start({ sessionId: "active" });
  assert.equal(sockets.length, 2);
  assert.match(sockets[0].url, /generativelanguage\.googleapis\.com/);
  assert.match(sockets[0].url, /key=AIza-test/);

  const koreanTarget = sockets[1];
  koreanTarget.emit("open");
  const setup = JSON.parse(koreanTarget.sent[0]);
  assert.equal(setup.setup.generationConfig.translationConfig.targetLanguageCode, "ko");

  // Live API handshake: realtimeInput must NOT be sent before setupComplete.
  manager.sendAudio({ sessionId: "active", source: "mic", audio: Buffer.alloc(12).toString("base64") });
  assert.equal(koreanTarget.sent.length, 1, "audio must be buffered until setupComplete");

  koreanTarget.emit("message", JSON.stringify({ setupComplete: {} }));
  assert.equal(koreanTarget.sent.length, 2, "buffered audio flushes after setupComplete");
  const audioMessage = JSON.parse(koreanTarget.sent.at(-1));
  assert.equal(audioMessage.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");

  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Hello everyone today" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "안녕하세요 여러분 오늘 회의에 참석해 주셔서 감사합니다" } } }));
  await new Promise((resolve) => setTimeout(resolve, 1060));
  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.equal(partial.translatedText, "안녕하세요 여러분 오늘 회의에 참석해 주셔서 감사합니다", "Gemini partials must flush before sentence completion and stay raw");
  assert.equal(partial.translationProvider, "gemini");

  koreanTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const committed = broadcasts.find((message) => message.type === "subtitle:committed");
  assert.equal(committed.translatedText, "[B] 안녕하세요 여러분 오늘 회의에 참석해 주셔서 감사합니다");
  assert.equal(committed.targetLanguage, "ko");
  assert.equal(committed.translationProvider, "gemini");
});

test("gemini setup handshake timeout reconnects instead of buffering audio forever", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    setupAckTimeoutMs: 20,
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("open");
  manager.sendAudio({ sessionId: "active", source: "mic", audio: Buffer.alloc(12).toString("base64") });
  assert.equal(koreanTarget.sent.length, 1, "audio must remain buffered before setupComplete");

  await new Promise((resolve) => setTimeout(resolve, 40));

  const timeoutError = broadcasts.find((message) => message.code === "TRANSLATION_SETUP_TIMEOUT");
  assert.ok(timeoutError, "a stuck Gemini setup must be surfaced to the UI");
  assert.equal(koreanTarget.closed || koreanTarget.terminated, true, "the stuck socket must be closed so reconnect can start");

  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.ok(sockets.length > 2, "the channel should reconnect without requiring stop/start");
});

test("gemini partial subtitles apply a local proper-noun guard before display", async () => {
  const sockets = [];
  const broadcasts = [];
  const glossary = [
    "Kushiman = Cushman & Wakefield",
    "K-Field Korea = Cushman & Wakefield Korea",
  ].join("\n");
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "ko", b: "en" },
          translationProvider: "gemini",
          glossary,
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[1];
  englishTarget.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "쿠시먼 코리아", languageCode: "ko" },
      outputTranscription: { text: "Kushiman, but why K-Field Korea?" },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 610));

  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.equal(partial.translationProvider, "gemini");
  assert.equal(partial.translatedText, "Cushman & Wakefield, but why Cushman & Wakefield Korea?");
});

test("gemini same-language transliteration echo is suppressed via cross-channel source match", async () => {
  // Real Gemini behavior on English audio: the KO-target channel transcribes
  // clean English ("Good morning everyone"), while the EN-target channel
  // hallucinates a Korean-transliterated source ("굿모닝 에브리원") and echoes the
  // English back. The Korean script defeats the same-language guard, so the EN
  // channel must instead recognize its output is verbatim the KO channel's source.
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  // KO channel hears the SAME English audio correctly and publishes its source.
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Good morning everyone, welcome", languageCode: "en" } } }));
  // EN channel hallucinates a Korean-transliterated source and echoes English.
  englishTarget.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "굿모닝 에브리원 웰컴", languageCode: "ko" },
      outputTranscription: { text: "Good morning everyone, welcome" },
    },
  }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await tick();

  const enEcho = broadcasts.filter((m) => (m.type === "subtitle:partial" || m.type === "subtitle:committed")
    && m.targetLanguage === "en" && /good morning everyone/i.test(m.translatedText ?? ""));
  assert.deepEqual(enEcho, [], "the EN channel must not echo English that is verbatim the KO channel's source");
});

test("EN→KO: a Korean translation studded with English proper nouns is displayed, not suppressed", async () => {
  // The EN→KO asymmetry: a valid Korean line carries English proper nouns/acronyms
  // (Cushman & Wakefield, Hilton Garden Inn, ADR…) whose Latin chars outnumber the
  // Hangul. The output gate must accept it on TARGET-LANGUAGE PRESENCE, not
  // dominance, or the Korean subtitle vanishes ("자막이 안 나오는" / English passes
  // through instead).
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1]; // languagePair [en, ko] → channel 1 = ko target
  koreanTarget.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "Cushman and Wakefield Korea is the smallest company.", languageCode: "en" },
      outputTranscription: { text: "Cushman & Wakefield Korea가 호텔 업계에서 가장 작은 회사입니다." },
    },
  }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await tick();

  const committed = broadcasts.find((m) => m.type === "subtitle:committed" && m.targetLanguage === "ko");
  assert.ok(committed, "the Korean translation must be displayed even though English proper nouns outnumber the Hangul");
  assert.match(committed.translatedText, /가장 작은 회사입니다/);
});

test("EN→KO is not suppressed by the EN channel's transliteration polluting a shared language read", async () => {
  // Root cause of the recurring EN→KO "원문 나오다 멈춤 / no subtitle": the source-
  // language tracker used to be SHARED, so when the EN channel hallucinated a
  // Korean-transliterated source ("굿모닝...", languageCode ko) it polluted the
  // read to "ko", and the KO channel then saw source==target and dropped its valid
  // Korean translation. The tracker is now PER-CHANNEL, so the KO channel keeps
  // translating English→Korean regardless of what the EN channel transcribes.
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  // EN channel hallucinates a Korean-transliterated source for the English audio.
  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "굿모닝 에브리원 웰컴 투데이", languageCode: "ko" } } }));
  // KO channel hears the SAME English correctly and translates it to Korean.
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Good morning everyone, welcome today", languageCode: "en" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "여러분 안녕하세요, 오늘 환영합니다." } } }));
  await new Promise((resolve) => setTimeout(resolve, 650));

  const koPartial = broadcasts.find((m) => m.type === "subtitle:partial" && m.targetLanguage === "ko");
  assert.ok(koPartial, "the KO channel must still emit its Korean translation despite the EN channel's transliteration");
  assert.match(koPartial.translatedText, /여러분 안녕하세요/);
});

test("KO→EN resumes immediately after an English-source hold when the new Korean turn arrives first on EN target", async () => {
  // Real long-session failure: after English speech, the cross-channel arbiter
  // briefly holds "en". If the next Korean turn's English translation arrives
  // before the KO-target sibling confirms Korean, the EN-target channel must
  // defer until arbitration catches up instead of deleting the ready translation.
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Good morning everyone", languageCode: "en" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Good morning everyone", languageCode: "en" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "여러분 안녕하세요." } } }));
  await new Promise((resolve) => setTimeout(resolve, 180));

  englishTarget.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "이제 국내 호텔 시장을 보겠습니다", languageCode: "ko" },
      outputTranscription: { text: "Now let's look at the domestic hotel market." },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "이제 국내 호텔 시장을 보겠습니다", languageCode: "ko" } } }));
  await new Promise((resolve) => setTimeout(resolve, 650));

  const enPartial = broadcasts.find((m) => m.type === "subtitle:partial"
    && m.targetLanguage === "en"
    && /domestic hotel market/i.test(m.translatedText ?? ""));
  assert.ok(enPartial, "the EN translation should appear once Korean consensus catches up");
});

test("once both channels agree on Korean, a lone languageCode flip can't echo the Korean source (KO→EN stays clean)", async () => {
  // The user's bug: speaking Korean, Gemini mid-utterance returns langCode=en on the
  // KO channel ONLY (the EN channel still says ko), so the KO channel thinks the
  // source is English and echoes the spoken Korean as a "translation" — Korean and
  // English then show at once and "중간에 계속 변함". With a cross-channel consensus
  // (both said ko for the first part), that lone flip is held off and the KO channel
  // stays suppressed (ko→ko), so only the English translation shows.
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  // Both channels AGREE the source is Korean (Korean is being spoken).
  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "오늘 세션을 시작하겠습니다", languageCode: "ko" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "오늘 세션을 시작하겠습니다", languageCode: "ko" } } }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "Let's begin today's session." } } }));
  await new Promise((resolve) => setTimeout(resolve, 350));

  // Gemini now flips ONLY the KO channel's languageCode to en (hallucination); the EN
  // channel still correctly reports ko. The KO channel would echo the Korean source.
  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: " 그리고 패널 토론을", languageCode: "ko" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: " 그리고 패널 토론을", languageCode: "en" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "그리고 패널 토론을" } } }));
  await new Promise((resolve) => setTimeout(resolve, 650));

  const koEcho = broadcasts.find((m) => m.type === "subtitle:partial" && m.targetLanguage === "ko" && /패널 토론/.test(m.translatedText || ""));
  assert.equal(koEcho, undefined, "the KO channel must NOT echo the Korean source after a lone langCode flip (consensus holds ko)");
  const enPartial = broadcasts.find((m) => m.type === "subtitle:partial" && m.targetLanguage === "en");
  assert.ok(enPartial && /begin today's session/i.test(enPartial.translatedText), "the English translation keeps showing");
});

test("English speech with contradictory languageCodes shows only Korean (text script beats langCode)", async () => {
  // The user's "영어로만 얘기하는데 자막이 한글↔영어로 계속 바뀜": Gemini transcribes the
  // English on BOTH channels (English TEXT) but returns CONTRADICTORY languageCodes —
  // en-channel langCode=ko, ko-channel langCode=en. Trusting langCode made each channel
  // disagree on the source, so BOTH emitted (English echo + Korean) and the lanes
  // flipped. Trusting the transcript SCRIPT instead (sustained English words → English)
  // makes both agree the source is English: the EN channel suppresses its echo and only
  // the KO channel's Korean translation shows.
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  // English is being spoken. The EN channel HALLUCINATES a Korean-script TRANSLITERATION
  // of the English ("디스커션 앤드 인테그레이티드…") so its source detects as Korean — the
  // Hangul defeats isSameLanguageEcho and it echoes the English back. The KO channel
  // hears real English (Latin). Because a sibling's source is sustained Latin English,
  // the arbiter must conclude English is being spoken → suppress the EN echo, show Korean.
  // The two channels' English wordings DIFFER (as in the real capture), so the exact
  // cross-channel containment match can't catch the echo — only recognizing the
  // sustained Latin-English source can.
  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "예스 예스 나우 아워 패널 디스커션", languageCode: "ko" } } }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "Yes, yes. Now, our panel discussion" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "We were now being a panelist discussion and integrated session today", languageCode: "en" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "저희는 이제 패널 토론과 통합 세션을 진행합니다" } } }));
  await new Promise((resolve) => setTimeout(resolve, 650));

  const enEcho = broadcasts.find((m) => m.type === "subtitle:partial" && m.targetLanguage === "en");
  assert.equal(enEcho, undefined, "the EN channel must suppress its English echo when a sibling sees sustained English source");
  const koPartial = broadcasts.find((m) => m.type === "subtitle:partial" && m.targetLanguage === "ko");
  assert.ok(koPartial && /패널 토론/.test(koPartial.translatedText), "only the Korean translation shows");
});

test("a Korean consensus does not pin the source for the rest of the session (EN passage after KO still reaches Korean viewers)", async () => {
  // The STATE-DEPENDENT twin of the test above, and the highest-impact subtitle bug
  // found in audit: the two tests directly above both exercise sub-2s windows, so
  // neither noticed that a CONSENSUS hold never expired. `resolveSource` returned an
  // authoritative consensus BEFORE its staleness check, and the sustained-English
  // tie-break was gated on `!authoritativeIsConsensus` — so the first time both
  // channels agreed (the first Korean sentence of any bilingual meeting) the
  // arbitrated source froze at "ko" for the WHOLE session. When the speaker then
  // switched to English, Korean viewers saw NOTHING for the entire English passage
  // (the ko channel read source=ko=target and suppressed itself) while English
  // viewers had their own words echoed back at them.
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];

  // Sentence 1 — Korean. Both channels agree the source is Korean → CONSENSUS forms.
  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "오늘 세션을 시작하겠습니다", languageCode: "ko" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "오늘 세션을 시작하겠습니다", languageCode: "ko" } } }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "Let's begin today's session." } } }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(
    broadcasts.some((m) => m.targetLanguage === "en" && /begin today's session/i.test(m.translatedText ?? "")),
    "the Korean sentence reaches English viewers",
  );

  // The speaker pauses past SOURCE_HOLD_MS (2000ms) — the consensus is not re-confirmed.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const beforeEnglishPassage = broadcasts.length;

  // Sentence 2 — ENGLISH. Same channel signals as the test above: the en-target
  // channel hallucinates a Hangul transliteration and echoes the English back, the
  // ko-target channel hears real Latin English. Differing wordings, so the exact
  // cross-channel containment match cannot catch the echo.
  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "예스 예스 나우 아워 패널 디스커션", languageCode: "ko" } } }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "Yes, yes. Now, our panel discussion" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "We were now being a panelist discussion and integrated session today", languageCode: "en" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "저희는 이제 패널 토론과 통합 세션을 진행합니다" } } }));
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const passage = broadcasts.slice(beforeEnglishPassage);
  const koShown = passage.find((m) => (m.type === "subtitle:partial" || m.type === "subtitle:committed")
    && m.targetLanguage === "ko"
    && /패널 토론/.test(m.translatedText ?? ""));
  assert.ok(koShown, "Korean viewers must get the English passage translated, not an empty lane");
  assert.equal(koShown.sourceLanguage, "en", "the arbitrated source must follow the speaker to English");
  const enEcho = passage.find((m) => (m.type === "subtitle:partial" || m.type === "subtitle:committed")
    && m.targetLanguage === "en"
    && /panel discussion/i.test(m.translatedText ?? ""));
  assert.equal(enEcho, undefined, "English viewers must not get their own words echoed back");

  await manager.stop();
});

test("two consecutive silence timeouts both clear the lane (a silence clear is never swallowed)", async () => {
  // clearTargetSubtitle de-duplicates by reason and only resetUtterance() resets that
  // memo, but the silence handler is not a commit — so a second silence timeout with no
  // intervening commit emitted NO subtitle:clear and the lane stayed on screen until the
  // frontend's 15s stale timeout instead of the documented 3s (SILENCE_CLEAR_MS).
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];
  const speak = (enHangul, enEcho, koSource, koOutput) => {
    englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: enHangul, languageCode: "ko" } } }));
    englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: enEcho } } }));
    koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: koSource, languageCode: "en" } } }));
    koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: koOutput } } }));
  };
  const silenceClears = () => broadcasts.filter((m) => m.type === "subtitle:clear"
    && m.targetLanguage === "ko" && m.reason === "silence").length;

  // Utterance 1 → Korean subtitle, then 3s of silence clears it.
  speak("예스 예스 나우 아워 패널 디스커션", "Yes, yes. Now, our panel discussion",
    "We were now being a panelist discussion and integrated session today",
    "저희는 이제 패널 토론과 통합 세션을 진행합니다");
  await new Promise((resolve) => setTimeout(resolve, 700));
  await new Promise((resolve) => setTimeout(resolve, 3400));
  assert.equal(silenceClears(), 1, "the first silence timeout clears the lane");

  // Utterance 2 — the partial never finalizes, so nothing resets lastClearReason.
  speak("쏘 렛츠 무브 온 투 더 넥스트", "So let's move on to the next",
    "So let us move to the next topic of the agenda now",
    "이제 다음 의제로 넘어가겠습니다");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(
    broadcasts.some((m) => m.type === "subtitle:partial" && m.targetLanguage === "ko"
      && /다음 의제/.test(m.translatedText ?? "")),
    "the second utterance shows on the Korean lane",
  );

  await new Promise((resolve) => setTimeout(resolve, 3400));
  assert.equal(silenceClears(), 2, "the SECOND silence timeout must also clear the lane");

  await manager.stop();
});

test("a subtitle clears after 3s of no new content (silence ends the subtitle)", async () => {
  // User spec: "인입이 3초 이상 없으면 자막은 끝나야 한다". A Gemini partial that never
  // gets a turnComplete would otherwise grow/linger forever; after 3s of no new
  // transcription/translation content the channel must reset and clear the display.
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "en", b: "ko" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];
  // English spoken → Korean subtitle (same shape as the working contradictory case).
  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "예스 예스 나우 아워 패널 디스커션", languageCode: "ko" } } }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "Yes, yes. Now, our panel discussion" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "We were now being a panelist discussion and integrated session today", languageCode: "en" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "저희는 이제 패널 토론과 통합 세션을 진행합니다" } } }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(broadcasts.some((m) => m.type === "subtitle:partial" && m.targetLanguage === "ko"), "Korean partial shows while speaking");

  // No new content arrives for > 3s.
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.ok(
    broadcasts.some((m) => m.type === "subtitle:clear" && m.targetLanguage === "ko" && m.reason === "silence"),
    "the subtitle must clear after 3s of no new content",
  );
});

test("gemini does not re-broadcast an unchanged partial (no flicker on a frozen turn)", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "ko", b: "en" }, translationProvider: "gemini" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[1];
  // A ko→en turn that paints a complete-looking partial, then Gemini re-sends the
  // SAME transcript repeatedly without ever finalizing (no turnComplete).
  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "안녕하세요 여러분", languageCode: "ko" } } }));
  for (let i = 0; i < 4; i += 1) {
    englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "Hello everyone." } } }));
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  const englishPartials = broadcasts.filter((m) => m.type === "subtitle:partial" && m.targetLanguage === "en" && m.translatedText === "Hello everyone.");
  assert.equal(englishPartials.length, 1, "the same frozen partial must be broadcast at most once, not re-emitted");
});

test("gemini does not echo same-language source even when the provider mislabels its language", async () => {
  // Reproduces the ko→en switch double-display: the EN-target channel hears
  // English, but Gemini's inputTranscription mislabels it as ko (the language
  // code lags the switch), which forces the shared coordinator to "ko" and would
  // make the channel show its own English input as a "ko→en translation"
  // alongside the real Korean subtitle. The own-source guard must suppress it.
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translationProvider: "gemini",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  englishTarget.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "This is now good, something good", languageCode: "ko" },
      outputTranscription: { text: "Hmm. This is now good, something good?" },
    },
  }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const enMessages = broadcasts.filter(
    (m) => (m.type === "subtitle:committed" || m.type === "subtitle:partial") && m.targetLanguage === "en",
  );
  assert.deepEqual(enMessages, [], "the EN channel must not echo its own English source as a translation");
});

test("gemini partials do not flush short Korean ending fragments as complete subtitles", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translationProvider: "gemini",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "We operate" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "운영합니다" } } }));
  await new Promise((resolve) => setTimeout(resolve, 1060));

  assert.equal(
    broadcasts.some((message) => message.type === "subtitle:partial" && message.targetLanguage === "ko"),
    false,
  );
});

test("gemini same-language source clears the stale target-language lane", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          translationLanguages: ["en", "ko"],
          translationProvider: "gemini",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "오늘은 한국어로 시작합니다" } } }));

  const clear = broadcasts.find((message) => message.type === "subtitle:clear" && message.targetLanguage === "ko");
  assert.equal(clear?.reason, "same_language_source");
  assert.equal(clear?.translationProvider, "gemini");
});

test("gemini does not reuse the previous Korean source language for a new English turn", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          translationLanguages: ["en", "ko"],
          translationProvider: "gemini",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];

  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "오늘은 한국어로 시작합니다" } } }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "We will start in Korean." } } }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  broadcasts.length = 0;

  englishTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "We" } } }));
  englishTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "We need to validate the deal." } } }));

  assert.deepEqual(
    broadcasts.filter((message) => message.type === "subtitle:partial" && message.targetLanguage === "en"),
    [],
  );
});

test("gemini uses input transcription languageCode for immediate English to Korean routing", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          translationLanguages: ["en", "ko"],
          translationProvider: "gemini",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];

  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "I", languageCode: "en-US" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "거래를 검증해야 합니다." } } }));

  assert.deepEqual(
    broadcasts.filter((message) => message.type === "subtitle:partial").map((message) => ({
      targetLanguage: message.targetLanguage,
      sourceLanguage: message.sourceLanguage,
      translatedText: message.translatedText,
    })),
    [{ targetLanguage: "ko", sourceLanguage: "en", translatedText: "거래를 검증해야 합니다." }],
  );
});

test("gemini ignores a languageCode outside the supported allowlist", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: { load: async () => ({
      apiKeys: { gemini: "AIza-test" },
      subtitle: {
        inputMode: "mic",
        translationLanguages: ["en", "ko"],
        translationProvider: "gemini",
      },
    }) },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "language-allowlist" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({
    serverContent: { inputTranscription: { text: "I", languageCode: "en<script>" } },
  }));
  koreanTarget.emit("message", JSON.stringify({
    serverContent: { outputTranscription: { text: "거래를 검증해야 합니다." } },
  }));

  assert.equal(broadcasts.some((message) => message.type === "subtitle:partial"), false);
  await manager.stop("language-allowlist");
});

test("single Gemini key finalizes ellipsis placeholders from the committed source", async () => {
  const sockets = [];
  const broadcasts = [];
  const polishArgs = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-live" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translationProvider: "gemini",
          tone: "natural",
          glossary: "",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async (args) => {
      polishArgs.push(args);
      return "운영사가 딜을 검증합니다.";
    },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "The operator validates the deal" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "..." } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await tick();

  const committed = broadcasts.find((message) => message.type === "subtitle:committed");
  assert.equal(committed.translatedText, "운영사가 딜을 검증합니다.");
  assert.equal(committed.sourceText, "The operator validates the deal");
  assert.equal(polishArgs.length, 1);
  assert.equal(polishArgs[0].translatedText, "...");
  assert.equal(polishArgs[0].sourceText, "The operator validates the deal");
  assert.equal(polishArgs[0].polishProvider, "gemini");
});

test("the channel hands the configured glossary to the polisher on commit", async () => {
  const sockets = [];
  const polishArgs = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai",
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          tone: "business",
          glossary: "operator -> 운영사",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async (args) => { polishArgs.push(args); return args.translatedText; },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello there" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "안녕하세요" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(polishArgs[0].glossary, "operator -> 운영사");
  assert.equal(polishArgs[0].tone, "business");
});

test("the channel hands the configured domain to the polisher on commit", async () => {
  const sockets = [];
  const polishArgs = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai",
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          tone: "business",
          translationDomain: "Commercial real estate hospitality",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async (args) => { polishArgs.push(args); return args.translatedText; },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello there" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.done", transcript: "안녕하세요" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(polishArgs[0].domain, /Commercial real estate/);
});

test("japanese-target channels auto-route to Gemini even when OpenAI is selected", async () => {
  // Probe evidence (2026-06-12): OpenAI's gpt-realtime-translate produces
  // Japanese OUTPUT with 10-25s latency or not at all, while Gemini streams it
  // in realtime. Per-channel routing keeps every direction on the fastest
  // engine: ja-target channels use Gemini whenever a Gemini key exists.
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test", gemini: "AIza-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "ko", b: "ja" }, translationProvider: "openai" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  assert.equal(sockets.length, 2);
  assert.match(sockets[0].url, /api\.openai\.com/, "ko-target stays on OpenAI");
  assert.match(sockets[1].url, /generativelanguage\.googleapis\.com/, "ja-target auto-routes to Gemini");
  assert.match(sockets[1].url, /key=AIza-test/);
});

test("japanese-target channels stay on OpenAI when no Gemini key exists", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { inputMode: "mic", languagePair: { a: "ko", b: "ja" }, translationProvider: "openai" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  assert.equal(sockets.length, 2);
  assert.match(sockets[0].url, /api\.openai\.com/);
  assert.match(sockets[1].url, /api\.openai\.com/, "no Gemini key → fall back to OpenAI");
});

test("a Korean-Japanese pair routes Japanese speech to the Korean channel only", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "ko", b: "ja" } },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "active" });
  assert.equal(sockets.length, 2);
  const koreanTarget = sockets[0];
  const japaneseTarget = sockets[1];

  // Japanese speech (kana signal) → the ko-target channel shows Korean…
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "本日はよろしくお願いいたします" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "오늘 잘 부탁드립니다" }));
  // …while the ja-target channel (same-language echo) stays suppressed.
  japaneseTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "本日はよろしくお願いいたします" }));
  japaneseTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "本日はよろしくお願いいたします" }));

  const partials = broadcasts.filter((message) => message.type === "subtitle:partial");
  assert.deepEqual(
    partials.map((message) => ({ targetLanguage: message.targetLanguage, translatedText: message.translatedText })),
    [{ targetLanguage: "ko", translatedText: "오늘 잘 부탁드립니다" }],
  );
});

test("normalizeSubtitleSettings accepts a Japanese language pair", () => {
  const settings = normalizeSubtitleSettings({ languagePair: { a: "ko", b: "ja" } });
  assert.deepEqual(settings.languagePair, { a: "ko", b: "ja" });
  assert.deepEqual(normalizeSubtitleSettings({ languagePair: { a: "japanese", b: "korean" } }).languagePair, { a: "ja", b: "ko" });
});

test("normalizeSubtitleSettings clamps verticalOffset and keeps the domain string", () => {
  assert.equal(normalizeSubtitleSettings({}).verticalOffset, 48);
  assert.equal(normalizeSubtitleSettings({ verticalOffset: 120 }).verticalOffset, 120);
  assert.equal(normalizeSubtitleSettings({ verticalOffset: 9000 }).verticalOffset, 600);
  assert.equal(normalizeSubtitleSettings({ verticalOffset: -5 }).verticalOffset, 0);
  assert.equal(normalizeSubtitleSettings({ translationDomain: "CRE" }).translationDomain, "CRE");
  assert.equal(normalizeSubtitleSettings({}).translationDomain, "");
});

// Replaces an earlier "long mixed-language output is suppressed" test that had become
// VACUOUS: its input carried no terminal punctuation and the test never advanced timers,
// so isPartialDisplayReady() returned false and NO partial could be emitted regardless
// of the language gate. Adding a period made the very same line display — because the
// dominance check that test was written for was deliberately REPLACED by a
// target-script PRESENCE check (>= 3 target chars). That replacement is the EN→KO fix:
// a correct Korean translation in this domain is studded with English proper nouns and
// acronyms (Cushman & Wakefield, Hilton Garden Inn, ADR, GOP, Value-Add…) whose Latin
// characters often OUTNUMBER the Hangul, and requiring dominance suppressed the Korean
// subtitle entirely. So mixed output DISPLAYING is the intended contract; what must
// stay suppressed is output with no target-language content at all (a same-language
// echo). Both halves are asserted below, each with a display-ready line.
test("the output gate keys on target-language PRESENCE: mixed KO+EN displays, a zero-Hangul echo does not", async () => {
  const displayReadyPartials = async (outputLine) => {
    const sockets = [];
    const broadcasts = [];
    const manager = businessToneManager({
      broadcast: (message) => broadcasts.push(message),
      sockets,
      polish: async ({ translatedText }) => translatedText,
      tone: "natural",
    });
    await manager.start({ sessionId: "active" });
    const koreanTarget = sockets[1];
    koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello there my friend" }));
    // Terminal punctuation makes the line display-ready, so what this test observes is
    // the OUTPUT-LANGUAGE gate and nothing else.
    koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: outputLine }));
    const partials = broadcasts
      .filter((message) => message.type === "subtitle:partial")
      .map((message) => message.translatedText);
    await manager.stop();
    return partials;
  };

  // Code-switched / proper-noun-heavy Korean output: Latin chars outnumber the Hangul,
  // but Korean is meaningfully PRESENT → it must reach Korean viewers.
  assert.deepEqual(
    await displayReadyPartials("안녕하세요 여러분 반갑습니다 this is mixed."),
    ["안녕하세요 여러분 반갑습니다 this is mixed."],
  );
  assert.deepEqual(
    await displayReadyPartials("Cushman & Wakefield Korea의 ADR과 GOP는 Value-Add 전략을 따릅니다."),
    ["Cushman & Wakefield Korea의 ADR과 GOP는 Value-Add 전략을 따릅니다."],
  );

  // Zero Korean characters on the Korean channel = the English source echoed back,
  // not a translation → still suppressed even though it is display-ready.
  assert.deepEqual(await displayReadyPartials("This is an English echo on the Korean channel."), []);
  // Fewer than the 3 target chars the gate requires is still treated as no Korean.
  assert.deepEqual(await displayReadyPartials("The operator screening process is 완 today."), []);
});

test("korean output with english proper nouns still displays on the ko channel", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async ({ translatedText }) => translatedText,
    tone: "natural",
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello there my friend" }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "OpenAI 모델은 정말 좋습니다" }));

  const partial = broadcasts.find((message) => message.type === "subtitle:partial");
  assert.equal(partial?.translatedText, "OpenAI 모델은 정말 좋습니다");
});

test("korean speech mixed with english terms is treated as Korean source and displays English", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { translationProvider: "openai", inputMode: "mic", languagePair: { a: "en", b: "ko" }, tone: "natural" },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const englishTarget = sockets[0];
  const koreanTarget = sockets[1];
  const mixedSource = "오늘은 hotel conversion strategy와 operator screening을 이야기하겠습니다";
  englishTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: mixedSource }));
  englishTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "Today we will discuss hotel conversion strategy and operator screening." }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: mixedSource }));
  koreanTarget.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "오늘은 호텔 전환 전략과 운영사 선별을 이야기하겠습니다." }));

  const englishPartial = broadcasts.find((message) => message.type === "subtitle:partial" && message.targetLanguage === "en");
  assert.equal(englishPartial?.sourceLanguage, "ko");
  assert.equal(englishPartial?.translatedText, "Today we will discuss hotel conversion strategy and operator screening.");
  assert.equal(
    broadcasts.some((message) => message.type === "subtitle:partial" && message.targetLanguage === "ko"),
    false,
  );
});

test("socket errors surface once per channel with corporate-network diagnosis", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  sockets[1].emit("error", new Error("self-signed certificate in certificate chain"));
  sockets[1].emit("error", new Error("self-signed certificate in certificate chain"));

  const errors = broadcasts.filter((message) => message.type === "subtitle:error" && message.code === "TRANSLATION_SOCKET_ERROR");
  assert.equal(errors.length, 1, "same error must not spam the UI");
  assert.match(errors[0].message, /self-signed certificate/);
  // Corporate TLS interception is the classic Windows-only failure; the
  // message must carry actionable Korean guidance, not just the raw error.
  assert.match(errors[0].message, /보안 프록시|SSL 검사/);
});

test("describeSocketError maps common failures to actionable Korean guidance", () => {
  assert.match(describeSocketError("unable to verify the first certificate"), /보안 프록시|SSL 검사/);
  assert.match(describeSocketError("getaddrinfo ENOTFOUND api.openai.com"), /DNS|차단/);
  assert.match(describeSocketError("connect ETIMEDOUT 1.2.3.4:443"), /방화벽|프록시/);
  // The two signatures of a corporate network silently stalling the WS
  // upgrade: a close while still CONNECTING, and a handshake timeout.
  assert.match(describeSocketError("WebSocket was closed before the connection was established"), /방화벽|프록시|핫스팟/);
  assert.match(describeSocketError("Opening handshake has timed out"), /방화벽|프록시|핫스팟/);
  assert.equal(describeSocketError("weird"), "");
});

test("a proxy block page surfaces as an HTTP-status error instead of a silent stall", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  // ws emits "unexpected-response" when the upgrade gets a non-101 reply —
  // exactly what corporate proxies/block pages return.
  sockets[1].emit("unexpected-response", {}, { statusCode: 403, statusMessage: "Forbidden" });

  const errorEvent = broadcasts.find((message) => message.type === "subtitle:error" && /403/.test(message.message));
  assert.ok(errorEvent, "blocked upgrade must surface with its HTTP status");
  assert.match(errorEvent.message, /프록시|차단/);
});

test("an error while still CONNECTING terminates instead of close (no synthetic second error)", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  const socket = sockets[1];
  socket.readyState = WebSocket.CONNECTING;
  socket.emit("error", new Error("connect ETIMEDOUT 1.2.3.4:443"));

  assert.equal(socket.terminated, true, "CONNECTING sockets must be terminated, not closed");
  assert.equal(socket.closed, undefined, "close() on a CONNECTING socket emits a synthetic error");
});

test("abnormal socket close reasons surface to the UI as subtitle errors", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async ({ translatedText }) => translatedText,
  });

  await manager.start({ sessionId: "active" });
  sockets[1].emit("close", 1011, Buffer.from("Your prepayment credits are depleted."));

  const errorEvent = broadcasts.find((message) => message.type === "subtitle:error");
  assert.match(errorEvent.message, /prepayment credits are depleted/);
  assert.equal(errorEvent.code, "TRANSLATION_SOCKET_CLOSED");
});

test("the gemini provider hands the glossary to the polisher exactly like openai", async () => {
  const sockets = [];
  const polishArgs = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          inputMode: "mic",
          languagePair: { a: "en", b: "ko" },
          translationProvider: "gemini",
          tone: "business",
          glossary: "operator -> 운영사\nMRG -> keep verbatim",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    polish: async (args) => { polishArgs.push(args); return args.translatedText; },
  });

  await manager.start({ sessionId: "active" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "The operator manages MRG" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "운영사가 MRG를 관리합니다" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(polishArgs[0].glossary, /operator -> 운영사/);
  assert.equal(polishArgs[0].tone, "business");
  assert.equal(polishArgs[0].targetLanguage, "ko");
  assert.equal(polishArgs[0].polishProvider, "gemini");
});

test("subtitle manager rejects start when the Gemini key is missing for the gemini provider", async () => {
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test" },
        subtitle: { inputMode: "mic", translationProvider: "gemini" },
      }),
    },
  });

  await assert.rejects(manager.start({ sessionId: "missing" }), /Gemini API key is required/);
});

test("subtitle manager rejects start before capture when OpenAI key is missing", async () => {
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({ apiKeys: {}, subtitle: { translationProvider: "openai", inputMode: "mic" } }),
    },
  });

  await assert.rejects(
    manager.start({ sessionId: "missing-key" }),
    /OpenAI API key is required/,
  );
  assert.equal(manager._state.active, false);
  assert.deepEqual(broadcasts, []);
});

class FakeSocket extends EventEmitter {
  constructor(url, init) {
    super();
    this.url = url;
    this.init = init;
    this.sent = [];
    this.readyState = WebSocket.OPEN;
  }

  send(message) {
    this.sent.push(message);
    if (JSON.parse(message).type === "session.close") {
      setTimeout(() => this.emit("message", JSON.stringify({ type: "session.closed" })), 0);
    }
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  terminate() {
    this.terminated = true;
    this.emit("close");
  }
}

// ---- N-language expansion (registry-driven) ----

test("normalizeSubtitleSettings accepts new registry languages in translationLanguages", () => {
  const settings = normalizeSubtitleSettings({ translationLanguages: ["ko", "zh", "es"] });
  assert.deepEqual(settings.translationLanguages, ["ko", "zh-Hans", "es"]);
});

test("normalizeSubtitleSettings allows up to three languages and drops the rest", () => {
  const settings = normalizeSubtitleSettings({ translationLanguages: ["en", "ko", "ja", "zh", "es", "fr"] });
  assert.deepEqual(settings.translationLanguages, ["en", "ko", "ja"]);
});

test("normalizeSubtitleSettings still rejects unsupported codes and keeps the legacy default", () => {
  const settings = normalizeSubtitleSettings({ translationLanguages: ["klingon", "xx"] });
  assert.deepEqual(settings.translationLanguages, ["en", "ko"]);
});

test("normalizeSubtitleSettings keeps the classic en/ko/ja behavior untouched", () => {
  assert.deepEqual(normalizeSubtitleSettings({ translationLanguages: ["en", "ko", "ja"] }).translationLanguages, ["en", "ko", "ja"]);
  assert.deepEqual(normalizeSubtitleSettings({ translateAllLanguages: true }).translationLanguages, ["en", "ko", "ja"]);
});

test("subtitle manager keeps Gemini captions and opens OpenAI only for interpreted audio", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: {
      load: async () => ({
        apiKeys: { openai: "sk-test", gemini: "AIza-test" },
        subtitle: {
          translationProvider: "gemini",
          voiceProvider: "openai",
          inputMode: "mic",
          translationLanguages: ["en", "ko"],
          outputMode: "audio",
          audioLanguage: "ko",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "openai-audio" });
  assert.equal(sockets.filter((socket) => socket.url.includes("generativelanguage.googleapis.com")).length, 2);
  assert.equal(sockets.filter((socket) => socket.url.includes("api.openai.com/v1/realtime/translations")).length, 1);
  await manager.stop("openai-audio");
});

test("OpenAI voice channel publishes PCM but never publishes its transcript as captions", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: { load: async () => ({
      apiKeys: { openai: "sk-test", gemini: "AIza-test" },
      subtitle: {
        translationProvider: "gemini",
        voiceProvider: "openai",
        inputMode: "mic",
        translationLanguages: ["en", "ko"],
        outputMode: "captions_audio",
        audioLanguage: "ko",
      },
    }) },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });
  await manager.start({ sessionId: "openai-audio-delta" });
  const voiceSocket = sockets.find((socket) => socket.url.includes("api.openai.com"));
  voiceSocket.emit("open");
  voiceSocket.emit("message", JSON.stringify({ type: "session.updated" }));
  voiceSocket.emit("message", JSON.stringify({ type: "session.output_transcript.delta", delta: "숨겨야 합니다" }));
  const audio = Buffer.from([1, 0, 2, 0]).toString("base64");
  voiceSocket.emit("message", JSON.stringify({ type: "session.output_audio.delta", delta: audio }));
  await tick();
  assert.equal(broadcasts.some((message) => ["subtitle:partial", "subtitle:committed"].includes(message.type) && message.translatedText?.includes("숨겨야")), false);
  assert.deepEqual(broadcasts.find((message) => message.type === "subtitle:translated-audio"), {
    type: "subtitle:translated-audio",
    source: "mic",
    targetLanguage: "ko",
    sampleRate: 24000,
    mimeType: "audio/pcm;rate=24000",
    audio,
  });
  await manager.stop("openai-audio-delta");
});

test("subtitle manager streams Gemini audio only for the selected language without a turn boundary", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          translationProvider: "gemini",
          inputMode: "mic",
          translationLanguages: ["en", "ko"],
          outputMode: "captions_audio",
          audioLanguage: "ko",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "gemini-audio" });
  for (const socket of sockets) socket.emit("open");
  const socketByLanguage = new Map(sockets.map((socket) => {
    const setup = JSON.parse(socket.sent[0]);
    return [setup.setup.generationConfig.translationConfig.targetLanguageCode, socket];
  }));
  const audio = Buffer.from([0, 0, 1, 0]).toString("base64");
  for (const socket of socketByLanguage.values()) {
    socket.emit("message", JSON.stringify({ setupComplete: {} }));
    socket.emit("message", JSON.stringify({
      serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] } },
    }));
  }

  assert.deepEqual(broadcasts.filter((message) => message.type === "subtitle:translated-audio"), [{
    type: "subtitle:translated-audio",
    source: "mic",
    targetLanguage: "ko",
    sampleRate: 24000,
    mimeType: "audio/pcm;rate=24000",
    audio,
  }]);
  await manager.stop("gemini-audio");
});

test("Gemini audio rejects same-language stale output after strong script correction", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: { load: async () => ({
      apiKeys: { gemini: "AIza-test" },
      subtitle: {
        translationProvider: "gemini",
        inputMode: "mic",
        translationLanguages: ["en", "ko"],
        outputMode: "captions_audio",
        audioLanguage: "ko",
      },
    }) },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });
  await manager.start({ sessionId: "gemini-audio-direction" });
  for (const socket of sockets) socket.emit("open");
  const koreanSocket = sockets.find((socket) => {
    const setup = JSON.parse(socket.sent[0]);
    return setup.setup.generationConfig.translationConfig.targetLanguageCode === "ko";
  });
  koreanSocket.emit("message", JSON.stringify({ setupComplete: {} }));
  const audio = Buffer.from([1, 0, 2, 0]).toString("base64");

  koreanSocket.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "지금 한국어로 이야기하고 있습니다", languageCode: "en" },
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] },
    },
  }));
  assert.equal(broadcasts.some((message) => message.type === "subtitle:translated-audio"), false);

  koreanSocket.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  koreanSocket.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "We are now speaking in English", languageCode: "ko" },
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] },
    },
  }));
  assert.equal(broadcasts.some((message) => message.type === "subtitle:translated-audio"), true);
  await manager.stop("gemini-audio-direction");
});

test("audio-only mode suppresses caption events and stop/reconfigure clear playback", async () => {
  const sockets = [];
  const broadcasts = [];
  const saved = {
    apiKeys: { gemini: "AIza-test" },
    subtitle: {
      translationProvider: "gemini",
      inputMode: "mic",
      translationLanguages: ["en", "ko"],
      outputMode: "audio",
      audioLanguage: "ko",
    },
  };
  const manager = createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: { load: async () => saved },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  await manager.start({ sessionId: "audio-only" });
  for (const socket of sockets) socket.emit("open");
  const koreanSocket = sockets.find((socket) => JSON.parse(socket.sent[0]).setup.generationConfig.translationConfig.targetLanguageCode === "ko");
  koreanSocket.emit("message", JSON.stringify({ setupComplete: {} }));
  koreanSocket.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Hello" } } }));
  koreanSocket.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "안녕하세요." } } }));
  koreanSocket.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await tick();
  assert.equal(broadcasts.some((message) => ["subtitle:partial", "subtitle:committed"].includes(message.type)), false);

  await manager.restartChannels({ reason: "reconfigure" });
  assert.ok(broadcasts.some((message) => message.type === "subtitle:audio-control" && message.action === "clear" && message.reason === "reconfigure"));
  await manager.stop("audio-only");
  assert.ok(broadcasts.some((message) => message.type === "subtitle:audio-control" && message.action === "clear" && message.reason === "stop"));
});

function createAudioWatchdogManager({ broadcasts, sockets }) {
  return createSubtitleRealtimeManager({
    broadcast: (message) => broadcasts.push(message),
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: {
          translationProvider: "gemini",
          inputMode: "mic",
          translationLanguages: ["en", "ko"],
          outputMode: "audio",
          audioLanguage: "ko",
        },
      }),
    },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    log: { warn() {} },
    stallWatchdog: { intervalMs: 5, stallMs: 30, cooldownMs: 0 },
  });
}

test("audio-only watchdog ignores hidden caption output and restarts without translated audio", async () => {
  const broadcasts = [];
  const sockets = [];
  const manager = createAudioWatchdogManager({ broadcasts, sockets });
  await manager.start({ sessionId: "audio-watchdog-text-only" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  manager.noteInputSignal({ sessionId: "audio-watchdog-text-only" });

  const koreanSocket = sockets[1];
  koreanSocket.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Hello there friend" } } }));
  koreanSocket.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "안녕하세요 여러분." } } }));
  koreanSocket.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(broadcasts.some((message) => message.type === "subtitle:status"
    && message.status === "recovering"
    && message.reason === "stall_watchdog"));
  await manager.stop("audio-watchdog-text-only");
});

test("audio-only watchdog treats translated audio as the pipeline liveness signal", async () => {
  const broadcasts = [];
  const sockets = [];
  const manager = createAudioWatchdogManager({ broadcasts, sockets });
  await manager.start({ sessionId: "audio-watchdog-pcm" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  manager.noteInputSignal({ sessionId: "audio-watchdog-pcm" });

  const koreanSocket = sockets[1];
  koreanSocket.emit("message", JSON.stringify({
    serverContent: {
      modelTurn: {
        parts: [{
          inlineData: {
            mimeType: "audio/pcm;rate=24000",
            data: Buffer.alloc(4_800, 1).toString("base64"),
          },
        }],
      },
    },
  }));
  koreanSocket.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Hello there" } } }));
  koreanSocket.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "안녕하세요 여러분" }, turnComplete: true } }));
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(broadcasts.some((message) => message.type === "subtitle:status"
    && message.status === "recovering"
    && message.reason === "stall_watchdog"), false);
  await manager.stop("audio-watchdog-pcm");
});
