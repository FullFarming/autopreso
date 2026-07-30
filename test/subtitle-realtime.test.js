// @ts-nocheck - fake WebSocket implements only the event surface used by subtitle manager tests.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { WebSocket } from "ws";

import {
  createSubtitleRealtimeManager,
  describeSocketError,
  applyGlossaryCorrections,
  detectSourceLanguage,
  isSameLanguageEcho,
  isSourceEcho,
  normalizeSubtitleSettings,
} from "../src/subtitle-realtime.js";
import { GLOSSARY_PRESETS, getDefaultSubtitleGlossaryContext } from "../src/glossary-presets.js";

test("desktop outer polish deadline matches the six-second polisher budget", async () => {
  const source = await readFile(new URL("../src/subtitle-realtime.js", import.meta.url), "utf8");
  assert.match(source, /DEFAULT_POLISH_TIMEOUT_MS\s*=\s*6_000/u);
  assert.doesNotMatch(source, /DEFAULT_POLISH_TIMEOUT_MS\s*=\s*1_500/u);
});

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

test("the HOTEL preset preserves panel brand names and hospitality operating terms", () => {
  // These are hotel-session terms (First Cabin, Noon Square, third-party
  // operator, low manning model, 힐튼 가든 인), so they belong to the hotel
  // preset — not to the everyday default, which is now the general CRE
  // consulting glossary. The company-name repairs above DO stay in the default,
  // because STT garbles "Cushman" in every session regardless of topic.
  const glossary = GLOSSARY_PRESETS.find((preset) => preset.id === "hotel-investment-en-ko").glossary;

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

test("gemini provider opens Live sockets and skips an ordinary business final", async () => {
  const sockets = [];
  const broadcasts = [];
  let polishCalls = 0;
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
    polish: async ({ translatedText }) => {
      polishCalls += 1;
      return translatedText;
    },
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
  assert.equal(committed.translatedText, "안녕하세요 여러분 오늘 회의에 참석해 주셔서 감사합니다");
  assert.equal(polishCalls, 0, "ordinary business finals must not pay for Flash polish");
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
  assert.equal(normalizeSubtitleSettings({}).translationDomain, getDefaultSubtitleGlossaryContext().domain);
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

test("the Gemini provider hands the glossary to the shared finalizer", async () => {
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
          glossary: "operator -> 운영사\nMRG -> keep verbatim\nHilton -> 힐튼",
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
  koreanTarget.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "해당 회사가 관리합니다" } } }));
  koreanTarget.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(polishArgs.length, 1);
  assert.match(polishArgs[0].glossary, /operator -> 운영사/);
  assert.match(polishArgs[0].glossary, /MRG -> keep verbatim/);
  assert.doesNotMatch(polishArgs[0].glossary, /Hilton -> 힐튼/);
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function businessToneManager({ broadcast, sockets, polish, tone = "business", polishTimeoutMs }) {
  return createSubtitleRealtimeManager({
    broadcast,
    settingsStore: {
      load: async () => ({
        apiKeys: { gemini: "AIza-test" },
        subtitle: { translationProvider: "gemini", inputMode: "mic", languagePair: { a: "en", b: "ko" }, tone },
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

test("Gemini distributes three target languages across two configured keys", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: { load: async () => ({
      apiKeys: { gemini: "AIza-primary", geminiSecondary: "AIza-secondary" },
      subtitle: {
        inputMode: "mic",
        translationLanguages: ["en", "ko", "ja"],
        translationProvider: "gemini",
      },
    }) },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });
  await manager.start({ sessionId: "three-language-keys" });
  assert.equal(sockets.length, 3);
  assert.match(sockets[0].url, /key=AIza-primary/u);
  assert.match(sockets[1].url, /key=AIza-primary/u);
  assert.match(sockets[2].url, /key=AIza-secondary/u);
  assert.equal(sockets.every((socket) => socket.url.includes("generativelanguage.googleapis.com")), true);
  await manager.stop("three-language-keys");
});

test("Gemini uses the primary key for every target when no secondary key is configured", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: { load: async () => ({
      apiKeys: { gemini: "AIza-primary" },
      subtitle: {
        inputMode: "mic",
        translationLanguages: ["en", "ko", "ja"],
        translationProvider: "gemini",
      },
    }) },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });
  await manager.start({ sessionId: "three-language-primary" });
  assert.equal(sockets.length, 3);
  assert.equal(sockets.every((socket) => socket.url.includes("key=AIza-primary")), true);
  await manager.stop("three-language-primary");
});

test("a dropped Gemini channel reconnects with its saved resumption handle", async () => {
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
        outputMode: "audio",
        audioLanguage: "en",
      },
    }) },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });
  await manager.start({ sessionId: "resume" });
  const initialCount = sockets.length;
  const dropped = sockets[0];
  dropped.emit("open");
  dropped.emit("message", JSON.stringify({ setupComplete: {} }));
  dropped.emit("message", JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-123" } }));
  dropped.emit("close", 1011, Buffer.from("session expired"));
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.ok(sockets.length > initialCount);
  const replacement = sockets.at(-1);
  replacement.emit("open");
  assert.deepEqual(JSON.parse(replacement.sent[0]).setup.sessionResumption, { handle: "resume-123" });
  replacement.emit("message", JSON.stringify({ setupComplete: {} }));
  dropped.emit("message", JSON.stringify({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(4_800).toString("base64") } }],
      },
    },
  }));
  assert.equal(broadcasts.some((message) => message.type === "subtitle:translated-audio"), false);
  await manager.stop("resume");
});

test("a deliberately stopped Gemini session never auto-reconnects", async () => {
  const sockets = [];
  const manager = createSubtitleRealtimeManager({
    broadcast: () => {},
    settingsStore: { load: async () => ({
      apiKeys: { gemini: "AIza-test" },
      subtitle: { inputMode: "mic", translationLanguages: ["en", "ko"], translationProvider: "gemini" },
    }) },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });
  await manager.start({ sessionId: "deliberate-stop" });
  const initialCount = sockets.length;
  await manager.stop("deliberate-stop");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(sockets.length, initialCount);
});

test("a Gemini committed caption falls back to its draft when polish throws", async () => {
  const sockets = [];
  const broadcasts = [];
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async () => { throw new Error("polish down"); },
  });
  await manager.start({ sessionId: "polish-error" });
  const koreanTarget = sockets[1];
  koreanTarget.emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "Hello", languageCode: "en" },
      outputTranscription: { text: "안녕하세요." },
      turnComplete: true,
    },
  }));
  await tick();
  assert.equal(broadcasts.find((message) => message.type === "subtitle:committed")?.translatedText, "안녕하세요.");
  await manager.stop("polish-error");
});

test("a Gemini final still being polished is discarded after session teardown", async () => {
  const sockets = [];
  const broadcasts = [];
  let releasePolish = () => {};
  const polishGate = new Promise((resolve) => { releasePolish = resolve; });
  const manager = businessToneManager({
    broadcast: (message) => broadcasts.push(message),
    sockets,
    polish: async ({ translatedText }) => { await polishGate; return `P:${translatedText}`; },
  });
  await manager.start({ sessionId: "polish-teardown" });
  sockets[1].emit("message", JSON.stringify({
    serverContent: {
      inputTranscription: { text: "Hello", languageCode: "en" },
      outputTranscription: { text: "안녕하세요." },
      turnComplete: true,
    },
  }));
  await manager.stop("polish-teardown");
  releasePolish();
  await tick();
  assert.equal(broadcasts.some((message) => message.type === "subtitle:committed"), false);
});

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

test("subtitle manager normalizes stale OpenAI voice settings and keeps interpreted audio on Gemini", async () => {
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

  await manager.start({ sessionId: "gemini-only-audio" });
  assert.equal(sockets.filter((socket) => socket.url.includes("generativelanguage.googleapis.com")).length, 2);
  assert.equal(sockets.filter((socket) => socket.url.includes("api.openai.com/v1/realtime/translations")).length, 0);
  assert.equal(manager._state.settings.voiceProvider, "gemini");
  assert.equal(manager._state.captionConfig.voiceProvider, "gemini");
  await manager.stop("gemini-only-audio");
});

test("stale OpenAI voice selection publishes Gemini PCM and never opens an OpenAI translation socket", async () => {
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
        outputMode: "audio",
        audioLanguage: "ko",
      },
    }) },
    createWebSocket: (url, _protocols, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });
  await manager.start({ sessionId: "gemini-only-audio-delta" });
  assert.equal(sockets.some((socket) => socket.url.includes("api.openai.com")), false);
  for (const socket of sockets) socket.emit("open");
  const voiceSocket = sockets.find((socket) => {
    const setup = JSON.parse(socket.sent[0]);
    return setup.setup.generationConfig.translationConfig.targetLanguageCode === "ko";
  });
  voiceSocket.emit("message", JSON.stringify({ setupComplete: {} }));
  voiceSocket.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "숨겨야 합니다" } } }));
  const audio = Buffer.from([1, 0, 2, 0]).toString("base64");
  voiceSocket.emit("message", JSON.stringify({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] } },
  }));
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
  await manager.stop("gemini-only-audio-delta");
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
        outputMode: "audio",
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
  const outputAudioTimer = setInterval(() => {
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
  }, 10);
  koreanSocket.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Hello there" } } }));
  koreanSocket.emit("message", JSON.stringify({ serverContent: { outputTranscription: { text: "안녕하세요 여러분" }, turnComplete: true } }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearInterval(outputAudioTimer);

  assert.equal(broadcasts.some((message) => message.type === "subtitle:status"
    && message.status === "recovering"
    && message.reason === "stall_watchdog"), false);
  await manager.stop("audio-watchdog-pcm");
});
