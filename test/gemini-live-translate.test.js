// @ts-nocheck - exercises the Gemini Live translation adapter against recorded wire shapes.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGeminiSetupMessage,
  createGeminiTransport,
  handleGeminiLiveMessage,
  resamplePcm16Base64,
} from "../src/gemini-live-translate.js";

function pcm16Base64(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer.toString("base64");
}

function pcm16Samples(base64) {
  const buffer = Buffer.from(base64, "base64");
  const samples = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) samples.push(buffer.readInt16LE(i));
  return samples;
}

function transportAudioSamples(transport, samples) {
  const payload = JSON.parse(transport.audioPayload(pcm16Base64(samples)));
  return pcm16Samples(payload.realtimeInput.audio.data);
}

function sineWave(frequency, sampleCount, amplitude = 12_000, phase = 0) {
  return Array.from(
    { length: sampleCount },
    (_, index) => Math.round(amplitude * Math.sin((2 * Math.PI * frequency * index) / 24_000 + phase)),
  );
}

function measuredAmplitude(samples, frequency, sampleRate, start = 0) {
  let sine = 0;
  let cosine = 0;
  const count = samples.length - start;
  for (let index = start; index < samples.length; index += 1) {
    const angle = (2 * Math.PI * frequency * index) / sampleRate;
    sine += samples[index] * Math.sin(angle);
    cosine += samples[index] * Math.cos(angle);
  }
  return (2 * Math.hypot(sine, cosine)) / count;
}

test("resamplePcm16Base64 downsamples 24kHz to 16kHz with a 2/3 length ratio", () => {
  const input = pcm16Base64([0, 300, 600, 900, 1200, 1500]);
  const output = resamplePcm16Base64(input, 24000, 16000);
  const samples = pcm16Samples(output);
  assert.equal(samples.length, 4);
  assert.equal(samples[0], 0);
  // Linear interpolation between source samples: position 1.5 -> midway 300..600.
  assert.ok(Math.abs(samples[1] - 450) <= 1);
});

test("official 100ms frames stay exact and drift-free across repeated resampling", () => {
  const frameSamples = Array.from({ length: 2_400 }, (_, index) => ((index * 97) % 20_000) - 10_000);
  const frame = pcm16Base64(frameSamples);
  const resampledFrame = Buffer.from(resamplePcm16Base64(frame, 24_000, 16_000), "base64");
  assert.equal(resampledFrame.length, 1_600 * 2, "100ms at 16kHz must contain exactly 1,600 PCM16 samples");

  const frameCount = 50;
  const chunked = Buffer.concat(Array.from(
    { length: frameCount },
    () => Buffer.from(resamplePcm16Base64(frame, 24_000, 16_000), "base64"),
  ));
  const whole = Buffer.from(resamplePcm16Base64(
    pcm16Base64(Array.from({ length: frameCount }, () => frameSamples).flat()),
    24_000,
    16_000,
  ), "base64");
  assert.deepEqual(chunked, whole, "fixed 100ms boundaries must not lose, duplicate, or drift samples");
});

test("Gemini transport emits exact 1600-sample frames without repeated-frame drift", () => {
  const transport = createGeminiTransport();
  const frame = Array.from({ length: 2_400 }, (_, index) => ((index * 97) % 20_000) - 10_000);
  let outputSamples = 0;
  for (let frameIndex = 0; frameIndex < 50; frameIndex += 1) {
    const output = transportAudioSamples(transport, frame);
    assert.equal(output.length, 1_600);
    outputSamples += output.length;
  }
  assert.equal(outputSamples, 80_000);
});

test("Gemini transport anti-aliasing preserves a 6kHz passband tone", () => {
  const amplitude = 12_000;
  const output = transportAudioSamples(createGeminiTransport(), sineWave(6_000, 24_000, amplitude, 0.31));
  const measured = measuredAmplitude(output, 6_000, 16_000, 300);
  assert.ok(measured / amplitude > 0.95, `6kHz passband gain was ${measured / amplitude}`);
  assert.ok(measured / amplitude < 1.05, `6kHz passband gain was ${measured / amplitude}`);
});

test("Gemini transport suppresses the 6kHz alias produced by a 10kHz input tone", () => {
  const amplitude = 12_000;
  const output = transportAudioSamples(createGeminiTransport(), sineWave(10_000, 24_000, amplitude, 0.31));
  const aliasedAmplitude = measuredAmplitude(output, 6_000, 16_000, 300);
  assert.ok(aliasedAmplitude / amplitude < 0.01, `10kHz alias gain was ${aliasedAmplitude / amplitude}`);
});

test("Gemini transport preserves FIR history exactly across 100ms chunk boundaries", () => {
  const input = sineWave(3_137, 4_800, 12_000, 0.17);
  const chunkedTransport = createGeminiTransport();
  const chunked = [
    ...transportAudioSamples(chunkedTransport, input.slice(0, 2_400)),
    ...transportAudioSamples(chunkedTransport, input.slice(2_400)),
  ];
  const whole = transportAudioSamples(createGeminiTransport(), input);
  const maximumDifference = chunked.reduce(
    (maximum, sample, index) => Math.max(maximum, Math.abs(sample - whole[index])),
    0,
  );
  assert.equal(chunked.length, 3_200);
  assert.ok(Math.abs(chunked[1_600]) > 100, "boundary fixture must contain an audible sample");
  assert.equal(maximumDifference, 0, "chunked and continuous FIR output must be sample-identical");
});

test("buildGeminiSetupMessage configures translation with transcripts and no echo", () => {
  const message = JSON.parse(buildGeminiSetupMessage({ geminiModel: "gemini-3.5-live-translate-preview" }, "ko"));
  assert.equal(message.setup.model, "models/gemini-3.5-live-translate-preview");
  assert.deepEqual(message.setup.generationConfig.responseModalities, ["AUDIO"]);
  // Live-probed raw WebSocket shape: the API accepts transcript toggles at
  // setup level, while translationConfig stays inside generationConfig.
  assert.equal(message.setup.generationConfig.inputAudioTranscription, undefined);
  assert.equal(message.setup.generationConfig.outputAudioTranscription, undefined);
  assert.deepEqual(message.setup.inputAudioTranscription, {});
  assert.deepEqual(message.setup.outputAudioTranscription, {});
  assert.equal(message.setup.generationConfig.translationConfig.targetLanguageCode, "ko");
  assert.equal(message.setup.generationConfig.translationConfig.echoTargetLanguage, false);
  assert.equal(message.setup.translationConfig, undefined);
  assert.equal(message.setup.realtimeInputConfig.automaticActivityDetection.prefixPaddingMs, 100);
  // Faster word/segment separation.
  assert.equal(message.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 450);
  // Hours-long sessions: sliding-window compression removes the duration cap,
  // and session resumption is enabled (empty handle on a fresh connect).
  assert.deepEqual(message.setup.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(message.setup.sessionResumption, {});
});

test("buildGeminiSetupMessage never sends unsupported instructions to Live Translate", () => {
  const glossary = [
    "Kushiman = Cushman & Wakefield",
    "K-Field Korea = Cushman & Wakefield Korea",
    "operator = 운영사",
  ].join("\n");
  const message = JSON.parse(buildGeminiSetupMessage({ glossary }, "en"));
  assert.equal(message.setup.systemInstruction, undefined);
});

test("buildGeminiSetupMessage passes a resumption handle when reconnecting", () => {
  const message = JSON.parse(buildGeminiSetupMessage({}, "ko", "handle-abc"));
  assert.deepEqual(message.setup.sessionResumption, { handle: "handle-abc" });
});

test("gemini captures the session resumption handle for reconnects", () => {
  const ctx = makeCtx();
  let captured = null;
  ctx.setResumptionHandle = (handle) => { captured = handle; };
  handleGeminiLiveMessage(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-xyz" } }), ctx);
  assert.equal(captured, "resume-xyz");
});

test("gemini goAway asks the channel to reconnect", () => {
  const ctx = makeCtx();
  let goneAway = false;
  ctx.onServerGoAway = () => { goneAway = true; };
  handleGeminiLiveMessage(JSON.stringify({ goAway: { timeLeft: "5s" } }), ctx);
  assert.equal(goneAway, true);
  assert.ok(ctx.events.some((e) => e.type === "broadcast" && e.message.status === "reconnecting"));
});

test("gemini transport audio payload resamples to 16kHz pcm mime", () => {
  const transport = createGeminiTransport({
    settings: { geminiModel: "gemini-3.5-live-translate-preview" },
    targetLanguage: "ko",
    apiKey: "AIza-test",
  });
  const payload = JSON.parse(transport.audioPayload(pcm16Base64([0, 100, 200, 300, 400, 500])));
  assert.equal(payload.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(pcm16Samples(payload.realtimeInput.audio.data).length, 4);
});

test("gemini transport connects with the api key in the url and has no graceful close payload", () => {
  let connectedUrl = "";
  const transport = createGeminiTransport({
    settings: { geminiModel: "gemini-3.5-live-translate-preview" },
    targetLanguage: "en",
    apiKey: "AIza-test",
  });
  transport.connect({ createWebSocket: (url) => { connectedUrl = url; return { on() {} }; } });
  assert.match(connectedUrl, /^wss:\/\/generativelanguage\.googleapis\.com\/ws\//);
  assert.match(connectedUrl, /key=AIza-test/);
  assert.equal(transport.closePayload?.(), undefined);
});

function makeCtx() {
  let sourceText = "";
  let translatedText = "";
  const events = [];
  return {
    events,
    source: "mic",
    targetLanguage: "ko",
    outputMode: "audio",
    getSourceText: () => sourceText,
    setSourceText: (value) => { sourceText = value; },
    getTranslatedText: () => translatedText,
    setTranslatedText: (value) => { translatedText = value; },
    shouldDisplay: () => true,
    rememberSourceTranscriptDelta: (delta) => events.push({ type: "sourceDelta", delta }),
    emitPartial: () => events.push({ type: "partial", sourceText, translatedText }),
    schedulePartialFlush: () => events.push({ type: "schedulePartialFlush", sourceText, translatedText }),
    scheduleCommit: () => events.push({ type: "scheduleCommit" }),
    commitSubtitle: (subtitle) => events.push({ type: "commit", ...subtitle }),
    resetUtterance: () => { sourceText = ""; translatedText = ""; events.push({ type: "reset" }); },
    clearAudio: () => events.push({ type: "audioClear" }),
    broadcast: (message) => events.push({ type: "broadcast", message }),
  };
}

test("gemini transcripts accumulate fragments and commit on turnComplete", () => {
  const ctx = makeCtx();
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { inputTranscription: { text: "안녕" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { inputTranscription: { text: "하세요" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "Hello" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: " there" } } }), ctx);
  assert.equal(ctx.getSourceText(), "안녕하세요");
  assert.equal(ctx.getTranslatedText(), "Hello there");
  assert.ok(ctx.events.some((event) => event.type === "schedulePartialFlush"));
  assert.equal(ctx.events.some((event) => event.type === "scheduleCommit"), false);

  handleGeminiLiveMessage(JSON.stringify({ serverContent: { turnComplete: true } }), ctx);
  const commit = ctx.events.find((event) => event.type === "commit");
  assert.equal(commit.translatedText, "Hello there");
  assert.equal(commit.sourceText, "안녕하세요");
});

test("gemini generationComplete also commits the finalized utterance", () => {
  const ctx = makeCtx();
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { inputTranscription: { text: "The operator validates the deal" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "운영사가 딜을 검증합니다" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { generationComplete: true } }), ctx);

  const commit = ctx.events.find((event) => event.type === "commit");
  assert.equal(commit.translatedText, "운영사가 딜을 검증합니다");
  assert.equal(commit.sourceText, "The operator validates the deal");
});

test("gemini streams validated audio even when the finalized caption is not displayable", () => {
  const ctx = makeCtx();
  ctx.shouldDisplay = () => false;
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm16Base64([0, 1]) } }] } },
  }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { inputTranscription: { text: "Hello" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "Hello" }, turnComplete: true } }), ctx);
  assert.equal(ctx.events.filter((event) => event.type === "broadcast" && event.message.type === "subtitle:translated-audio").length, 1);
  assert.equal(ctx.events.some((event) => event.type === "commit"), false);
});

test("gemini silently drops valid exact-zero PCM without broadcasting audio", () => {
  const ctx = makeCtx();
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm16Base64([0, 0, 0, 0]) } }] } },
  }), ctx);

  assert.equal(ctx.events.some((event) => event.type === "broadcast" && event.message.type === "subtitle:translated-audio"), false);
  assert.equal(ctx.events.some((event) => event.type === "broadcast" && event.message.type === "subtitle:error"), false);
});

test("gemini transcripts treat full-replacement snapshots as replacements, not appends", () => {
  const ctx = makeCtx();
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "Hello" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "Hello there" } } }), ctx);
  assert.equal(ctx.getTranslatedText(), "Hello there");
});

test("gemini transcript merge never shrinks or duplicates on out-of-order/revised fragments", () => {
  const ctx = makeCtx();
  // Korean output that grows then re-sends an earlier prefix out of order
  // (docs: transcripts arrive independently with no guaranteed ordering).
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "운영사가" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "운영사가 딜을" } } }), ctx);
  assert.equal(ctx.getTranslatedText(), "운영사가 딜을");
  // An out-of-order earlier prefix must NOT shrink the line back.
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "운영사가" } } }), ctx);
  assert.equal(ctx.getTranslatedText(), "운영사가 딜을");
  // An exact duplicate of the tail must NOT double it.
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: " 딜을" } } }), ctx);
  assert.equal(ctx.getTranslatedText(), "운영사가 딜을");
  // A genuine new increment still appends.
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: " 검증합니다" } } }), ctx);
  assert.equal(ctx.getTranslatedText(), "운영사가 딜을 검증합니다");
});

test("gemini interrupted resets the in-progress utterance", () => {
  const ctx = makeCtx();
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "운영사가 딜을" } } }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { interrupted: true } }), ctx);
  assert.ok(ctx.events.some((event) => event.type === "reset"));
  assert.ok(ctx.events.some((event) => event.type === "audioClear"));
  assert.equal(ctx.getTranslatedText(), "");
});

test("gemini streams official PCM16 mono 24k audio without waiting for turnComplete", () => {
  const ctx = makeCtx();
  const audio = pcm16Base64([0, 1200, -1200, 0]);
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }],
      },
    },
  }), ctx);

  assert.deepEqual(ctx.events.find((event) => event.type === "broadcast" && event.message.type === "subtitle:translated-audio"), {
    type: "broadcast",
    message: {
      type: "subtitle:translated-audio",
      source: "mic",
      targetLanguage: "ko",
      audio,
      sampleRate: 24000,
      mimeType: "audio/pcm;rate=24000",
    },
  });
});

test("gemini transcript and turnComplete reordering cannot erase already streamed audio", () => {
  const ctx = makeCtx();
  ctx.shouldDisplay = () => false;
  const audio = pcm16Base64([0, 1200, -1200, 0]);
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] },
    },
  }), ctx);
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { outputTranscription: { text: "안녕하세요" }, turnComplete: true },
  }), ctx);
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { inputTranscription: { text: "Hello" } },
  }), ctx);

  const audioEvents = ctx.events.filter((event) => event.type === "broadcast" && event.message.type === "subtitle:translated-audio");
  assert.equal(audioEvents.length, 1);
  assert.equal(audioEvents[0].message.audio, audio);
});

test("gemini continuous translation streams all 30 audio chunks without a turn boundary", () => {
  const ctx = makeCtx();
  for (let index = 0; index < 30; index += 1) {
    const audio = pcm16Base64([index, index + 1]);
    handleGeminiLiveMessage(JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] },
      },
    }), ctx);
  }

  const audioEvents = ctx.events.filter((event) => event.type === "broadcast" && event.message.type === "subtitle:translated-audio");
  assert.equal(audioEvents.length, 30);
});

test("gemini ignores malformed or oversized translated audio without echoing its body", () => {
  const invalidParts = [
    { inlineData: { mimeType: "audio/pcm;rate=16000", data: pcm16Base64([0, 1]) } },
    { inlineData: { mimeType: "audio/wav", data: pcm16Base64([0, 1]) } },
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: "%%%=" } },
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([1]).toString("base64") } },
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(256 * 1024 + 2).toString("base64") } },
  ];
  const ctx = makeCtx();
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { modelTurn: { parts: invalidParts } } }), ctx);

  assert.equal(ctx.events.some((event) => event.type === "broadcast" && event.message.type === "subtitle:translated-audio"), false);
  assert.equal(
    ctx.events.some((event) => event.type === "broadcast" && JSON.stringify(event).includes(invalidParts.at(-1).inlineData.data)),
    false,
  );
});

test("gemini audio parts are ignored and setupComplete reports api_ready", () => {
  const ctx = makeCtx();
  handleGeminiLiveMessage(JSON.stringify({ setupComplete: {} }), ctx);
  handleGeminiLiveMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } }), ctx);
  const ready = ctx.events.find((event) => event.type === "broadcast");
  assert.equal(ready.message.status, "api_ready");
  assert.equal(ctx.getTranslatedText(), "");
});

test("gemini transport requires a setup ack and setupComplete signals transport readiness", () => {
  const transport = createGeminiTransport({
    settings: { geminiModel: "gemini-3.5-live-translate-preview" },
    targetLanguage: "ko",
    apiKey: "AIza-test",
  });
  // The Live API mandates waiting for BidiGenerateContentSetupComplete before
  // sending realtimeInput; the channel must hold audio until then.
  assert.equal(transport.requiresSetupAck, true);

  const ctx = makeCtx();
  let transportReady = false;
  ctx.onTransportReady = () => { transportReady = true; };
  handleGeminiLiveMessage(JSON.stringify({ setupComplete: {} }), ctx);
  assert.equal(transportReady, true);
});

test("gemini error frames surface as subtitle errors instead of vanishing", () => {
  const ctx = makeCtx();
  handleGeminiLiveMessage(
    JSON.stringify({ error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" } }),
    ctx,
  );
  const errorEvent = ctx.events.find((event) => event.type === "broadcast" && event.message.type === "subtitle:error");
  assert.match(errorEvent.message.message, /Resource has been exhausted/);
  assert.equal(errorEvent.message.code, "GEMINI_LIVE_ERROR");
});

test("gemini goAway broadcasts a recoverable reconnecting status", () => {
  const ctx = makeCtx();
  handleGeminiLiveMessage(JSON.stringify({ goAway: { timeLeft: "2s" } }), ctx);
  const status = ctx.events.find((event) => event.type === "broadcast");
  assert.equal(status.message.status, "reconnecting");
});
