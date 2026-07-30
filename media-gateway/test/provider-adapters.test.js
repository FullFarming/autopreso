import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { localTermRetrievalContract } from "../../packages/caption-core/index.js";
import { CloudSpeechToTextAdapter, GeminiLiveTranslateAdapter, GeminiTextTranslateAdapter, SourceOutputCorrelationPolicy } from "../src/google-provider-adapters.js";
import { SupabaseViewerAuthorizer } from "../src/supabase-adapters.js";

test("source/output correlation policy learns rolling p99 within hard bounds", () => {
  const policy = new SourceOutputCorrelationPolicy();
  assert.equal(policy.outputWaitMs(), 150);
  assert.equal(policy.contextMaxAgeMs(), 1_000);
  for (const value of [80, 120, 240, 400, 900, 20_000]) policy.observe(value);
  assert.equal(policy.outputWaitMs(), 600);
  assert.equal(policy.contextMaxAgeMs(), 5_000);
});
test("a throwing caption handler is reported and does not break the callback tail", async () => {
  const errors = [];
  const delivered = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: {
      live: {
        async connect(options) {
          messageHandler = options.callbacks.onmessage;
          return { sendRealtimeInput() {}, close() {} };
        },
      },
    },
  });
  await adapter.open({
    language: "ko",
    async onCaption(value) {
      delivered.push(value.text);
      if (value.text.includes("boom")) throw new Error("PUBLISH_FAILED");
    },
    async onAudio() {},
    onCallbackError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });

  messageHandler({ serverContent: { outputTranscription: { text: "boom." }, turnComplete: true } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["PUBLISH_FAILED"], "the swallowed failure must surface");

  // The tail must survive: the next message still delivers.
  messageHandler({ serverContent: { outputTranscription: { text: "recovered." }, turnComplete: true } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(delivered.includes("recovered."), `tail died after the throw: ${delivered.join(" | ")}`);
});

test("Gemini close drains detached finalized caption work", async () => {
  let messageHandler;
  let releaseFinal;
  let didFinishFinal = false;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    async onCaption(caption) {
      if (!caption.isFinal) return;
      await new Promise((resolve) => { releaseFinal = resolve; });
      didFinishFinal = true;
    },
    async onAudio() {},
  });
  messageHandler({ serverContent: {
    outputTranscription: { text: "A finalized sentence." }, turnComplete: true,
  } });
  for (let tick = 0; tick < 20 && typeof releaseFinal !== "function"; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof releaseFinal, "function", "the final must be accepted before close begins");
  let didClose = false;
  const closing = session.close().then(() => { didClose = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(didClose, false);
  releaseFinal();
  await closing;
  assert.equal(didFinishFinal, true);
});

// The committed-caption handler runs an LLM polish pass. Interpreted audio is
// time-critical playout and must never queue behind it: captions must stay
// ordered relative to captions, and PCM relative to PCM, but the two are
// independent. Sharing one serialization tail meant a slow polish delayed the
// listener's audio by the full polish timeout.
test("a slow committed caption never delays interpreted audio", async () => {
  const order = [];
  let releaseCaption;
  const captionGate = new Promise((resolve) => { releaseCaption = resolve; });
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: {
      live: {
        async connect(options) {
          messageHandler = options.callbacks.onmessage;
          return { sendRealtimeInput() {}, close() {} };
        },
      },
    },
  });
  const session = await adapter.open({
    language: "ko",
    async onCaption() {
      order.push("caption:start");
      await captionGate; // stands in for the polish round-trip
      order.push("caption:end");
    },
    async onAudio() { order.push("audio"); },
  });

  // One message carrying both a committed transcription and PCM.
  messageHandler({
    serverContent: {
      outputTranscription: { text: "폴리시가 느린 문장입니다." },
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([1, 2]).toString("base64") } }] },
      turnComplete: true,
    },
  });

  // Let microtasks settle while the caption handler is still blocked.
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  // The caption handler is still parked in its await, so the polish has NOT
  // finished — and the audio must already have played anyway.
  assert.ok(order.includes("caption:start"), "the caption handler should have started");
  assert.ok(!order.includes("caption:end"), "the polish must still be pending for this test to mean anything");
  assert.ok(order.includes("audio"), `audio must not wait for the caption: ${order.join(" > ")}`);

  releaseCaption();
  await new Promise((resolve) => setImmediate(resolve));
  await session.close();
});

test("Gemini rejects an oversized inline audio part before base64 decoding", async () => {
  const errors = [];
  const audio = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: async () => {},
    onAudio: async (chunk) => { audio.push(chunk); },
    onCallbackError: (error) => { errors.push(error.message); },
  });
  messageHandler({ serverContent: { modelTurn: { parts: [{ inlineData: {
    mimeType: "audio/pcm;rate=24000",
    data: "A".repeat(256_004),
  } }] } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(audio, []);
  assert.deepEqual(errors, ["GEMINI_AUDIO_PART_TOO_LARGE"]);
  await session.close();
});

test("Gemini close reports a bounded final-drain timeout instead of hanging", async () => {
  const errors = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    finalDrainTimeoutMilliseconds: 20,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: () => new Promise(() => {}),
    onAudio: async () => {},
    onCallbackError: (error) => { errors.push(error.message); },
  });
  messageHandler({ serverContent: { outputTranscription: { text: "Never resolves." }, turnComplete: true } });
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  await session.close();
  assert.ok(Date.now() - startedAt < 200);
  assert.deepEqual(errors, ["GEMINI_FINAL_DRAIN_TIMEOUT"]);
});

test("Gemini close stays bounded when a provider input write stalls", async () => {
  const errors = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    finalDrainTimeoutMilliseconds: 20,
    client: { live: { async connect() {
      return {
        sendRealtimeInput: () => new Promise(() => {}),
        close() {},
      };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: async () => {},
    onAudio: async () => {},
    onCallbackError: (error) => { errors.push(error.message); },
  });
  void session.sendAudio(Buffer.alloc(3_200));
  await new Promise((resolve) => setImmediate(resolve));
  const closeResult = await Promise.race([
    session.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
  ]);
  assert.equal(closeResult, "closed");
  assert.deepEqual(errors, ["GEMINI_FINAL_DRAIN_TIMEOUT"]);
});

test("Gemini bounds detached final work with lossless emergency backpressure", async () => {
  const seen = [];
  const releases = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    maxDetachedFinalCallbacks: 2,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: (caption) => {
      seen.push(caption.text);
      return new Promise((resolve) => { releases.push(resolve); });
    },
    onAudio: async () => {},
  });
  for (const text of ["First", "Second", "Third"]) {
    messageHandler({ serverContent: { outputTranscription: { text }, turnComplete: true } });
  }
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["First", "Second"]);
  releases[0]();
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["First", "Second", "Third"]);
  releases.slice(1).forEach((release) => release());
  await session.close();
});

test("Gemini close stays bounded when the detached-final capacity is saturated", async () => {
  const errors = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    maxDetachedFinalCallbacks: 2,
    finalDrainTimeoutMilliseconds: 20,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: () => new Promise(() => {}),
    onAudio: async () => {},
    onCallbackError: (error) => { errors.push(error.message); },
  });
  for (const text of ["First", "Second", "Third"]) {
    messageHandler({ serverContent: { outputTranscription: { text }, turnComplete: true } });
  }
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  const closeResult = await Promise.race([
    session.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
  ]);
  assert.equal(closeResult, "closed");
  assert.deepEqual(errors, ["GEMINI_FINAL_DRAIN_TIMEOUT"]);
});

test("a timed-out close fences queued finals from publishing after shutdown", async () => {
  const seen = [];
  const errors = [];
  let releaseFirst;
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    maxDetachedFinalCallbacks: 1,
    finalDrainTimeoutMilliseconds: 20,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: (caption) => {
      seen.push(caption.text);
      if (caption.text === "First") return new Promise((resolve) => { releaseFirst = resolve; });
      return Promise.resolve();
    },
    onAudio: async () => {},
    onCallbackError: (error) => { errors.push(error.message); },
  });
  messageHandler({ serverContent: { outputTranscription: { text: "First" }, turnComplete: true } });
  messageHandler({ serverContent: { outputTranscription: { text: "Second" }, turnComplete: true } });
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["First"]);
  await session.close();
  releaseFirst();
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["First"]);
  assert.deepEqual(errors, ["GEMINI_FINAL_DRAIN_TIMEOUT"]);
});

test("Gemini forwards output transcription language metadata to caption callbacks", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "ko",
    async onCaption(value) { captions.push(value); },
    async onAudio() {},
  });

  messageHandler({ serverContent: {
    outputTranscription: { text: "Echoed English.", languageCode: "en-US" },
    turnComplete: true,
  } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captions.length, 1);
  assert.equal(captions[0].languageCode, "en-US");
  await session.close();
});

test("Gemini Live Translate uses the official audio-only translation configuration", async () => {
  const connections = [];
  const audio = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: {
      live: {
        async connect(options) {
          connections.push(options);
          return {
            sendRealtimeInput() {},
            close() {},
          };
        },
      },
    },
  });
  const session = await adapter.open({
    language: "zh-CN",
    glossaryPack: "hotel",
    async onCaption() {},
    async onAudio(value) { audio.push(value); },
  });
  assert.deepEqual(connections[0].config.translationConfig, {
    targetLanguageCode: "zh-Hans",
    echoTargetLanguage: false,
  });
  assert.deepEqual(connections[0].config.responseModalities, ["AUDIO"]);
  assert.equal("systemInstruction" in connections[0].config, false);
  // Desktop subtitle parity: the same fast end-of-speech tuning.
  assert.deepEqual(connections[0].config.realtimeInputConfig, {
    automaticActivityDetection: { prefixPaddingMs: 100, silenceDurationMs: 450 },
  });
  connections[0].callbacks.onmessage({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([1, 2, 3, 4]).toString("base64") } }] } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio[0].sampleRate, 24_000);
  assert.deepEqual(audio[0].pcm, Uint8Array.from([1, 2, 3, 4]));
  await session.close();
});

test("Gemini preserves canonical Traditional Chinese at the provider boundary", async () => {
  const connections = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      connections.push(options);
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({ language: "zh-Hant", async onCaption() {}, async onAudio() {} });
  assert.equal(connections[0].config.translationConfig.targetLanguageCode, "zh-Hant");
  await session.close();
});

test("Gemini assembles 40 ms capture frames into exact 100 ms PCM input and pads only a graceful stream tail", async () => {
  const inputs = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect() {
      return { sendRealtimeInput(value) { inputs.push(value); }, close() {} };
    } } },
  });
  const session = await adapter.open({ language: "ko", async onCaption() {} });
  await session.sendAudio(new Uint8Array(1_280).fill(1));
  await session.sendAudio(new Uint8Array(1_280).fill(2));
  await session.sendAudio(new Uint8Array(1_280).fill(3));

  assert.equal(inputs.length, 1);
  const full = Buffer.from(inputs[0].audio.data, "base64");
  assert.equal(full.byteLength, 3_200);
  assert.equal(full[0], 1);
  assert.equal(full[1_280], 2);
  assert.equal(full[2_560], 3);

  await session.audioStreamEnd();
  assert.equal(inputs.length, 3);
  const tail = Buffer.from(inputs[1].audio.data, "base64");
  assert.equal(tail.byteLength, 3_200);
  assert.deepEqual([...tail.subarray(0, 640)], new Array(640).fill(3));
  assert.deepEqual([...tail.subarray(640)], new Array(2_560).fill(0));
  assert.deepEqual(inputs[2], { audioStreamEnd: true });
  await session.close();
});

test("Gemini discards an incomplete input tail on close", async () => {
  const inputs = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect() {
      return { sendRealtimeInput(value) { inputs.push(value); }, close() {} };
    } } },
  });
  const session = await adapter.open({ language: "ko", async onCaption() {} });
  await session.sendAudio(new Uint8Array(1_280).fill(7));
  await session.close();
  assert.deepEqual(inputs, []);
});

test("Gemini reconnect never mixes an old connection tail into the replacement generation", async () => {
  const callbacks = [];
  const sentByConnection = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    async reconnectDelay() {},
    client: { live: { async connect(options) {
      callbacks.push(options.callbacks);
      const sent = [];
      sentByConnection.push(sent);
      return { sendRealtimeInput(value) { sent.push(value); }, close() {} };
    } } },
  });
  const session = await adapter.open({ language: "ko", async onCaption() {} });
  await session.sendAudio(new Uint8Array(1_280).fill(1));
  callbacks[0].onmessage({ goAway: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await session.sendAudio(new Uint8Array(1_280).fill(2));
  await session.sendAudio(new Uint8Array(1_280).fill(2));
  await session.sendAudio(new Uint8Array(1_280).fill(2));

  assert.equal(sentByConnection[0].length, 0);
  assert.equal(sentByConnection[1].length, 1);
  const replacementFrame = Buffer.from(sentByConnection[1][0].audio.data, "base64");
  assert.equal(replacementFrame.byteLength, 3_200);
  assert.deepEqual([...replacementFrame], new Array(3_200).fill(2));
  await session.close();
});

test("Cloud STT fails closed above three host-selected source candidates", () => {
  assert.throws(() => new CloudSpeechToTextAdapter({
    client: {},
    projectId: "dev-project",
    languageCodes: ["ko-KR", "en-US", "ja-JP", "cmn-CN"],
  }), /STT_LANGUAGE_CANDIDATE_LIMIT/u);
});

test("Gemini Live Translate exposes the provider interruption event", async () => {
  let callbacks;
  let interruptions = 0;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) { callbacks = options.callbacks; return { sendRealtimeInput() {}, close() {} }; } } },
  });
  const session = await adapter.open({ language: "ko", async onCaption() {}, async onInterruption() { interruptions += 1; } });
  callbacks.onmessage({ serverContent: { interrupted: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interruptions, 1);
  await session.close();
});

test("Gemini serializes audio and interruption callbacks so stale audio cannot publish after clear", async () => {
  let callbacks;
  let releaseAudio;
  const order = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) { callbacks = options.callbacks; return { sendRealtimeInput() {}, close() {} }; } } },
  });
  const session = await adapter.open({
    language: "ko",
    async onCaption() {},
    async onAudio() {
      order.push("audio-start");
      await new Promise((resolve) => { releaseAudio = resolve; });
      order.push("audio-end");
    },
    async onInterruption() { order.push("clear"); },
  });
  callbacks.onmessage({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([1, 2]).toString("base64") } }] } },
  });
  callbacks.onmessage({ serverContent: { interrupted: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["audio-start"]);
  releaseAudio();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["audio-start", "audio-end", "clear"]);
  await session.close();
});

test("Gemini drops queued callbacks from a replaced connection generation", async () => {
  const callbacks = [];
  let releaseFirstAudio;
  const audio = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    async reconnectDelay() {},
    client: { live: { async connect(options) {
      callbacks.push(options.callbacks);
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "ko",
    async onCaption() {},
    async onAudio(value) {
      audio.push(value.pcm[0]);
      if (audio.length === 1) await new Promise((resolve) => { releaseFirstAudio = resolve; });
    },
  });
  const message = (sample) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([sample, 0]).toString("base64") } }] } } });
  callbacks[0].onmessage(message(1));
  await new Promise((resolve) => setImmediate(resolve));
  callbacks[0].onmessage(message(2));
  callbacks[0].onmessage({ goAway: {} });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstAudio();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(audio, [1]);
  await session.close();
});

test("Gemini reconnect keeps retrying transient failures beyond three attempts", async () => {
  let callbacks;
  let connectionAttempts = 0;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    async reconnectDelay() {},
    client: { live: { async connect(options) {
      connectionAttempts += 1;
      callbacks = options.callbacks;
      if (connectionAttempts > 1 && connectionAttempts < 6) throw new Error("temporarily unavailable");
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({ language: "ko", async onCaption() {} });
  callbacks.onmessage({ goAway: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectionAttempts, 6);
  await session.sendAudio(new Uint8Array(1_280));
  await session.close();
});

test("Gemini reconnect swaps only after connect succeeds and closes every provider session once", async () => {
  const callbacks = [];
  const sessions = [];
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    async reconnectDelay() {},
    client: {
      live: {
        async connect(options) {
          callbacks.push(options.callbacks);
          if (sessions[0]) assert.equal(sessions[0].closeCount, 0, "the current session must remain open while replacement connects");
          const callbackIndex = callbacks.length - 1;
          const providerSession = {
            closeCount: 0,
            sendRealtimeInput() {},
            close() {
              this.closeCount += 1;
              callbacks[callbackIndex].onclose();
            },
          };
          sessions.push(providerSession);
          return providerSession;
        },
      },
    },
  });
  const liveSession = await adapter.open({ language: "ko", async onCaption() {} });

  callbacks[0].onmessage({ goAway: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].closeCount, 1);
  assert.equal(sessions[1].closeCount, 0);
  callbacks[0].onclose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.length, 2, "a replaced session callback must not start another reconnect");

  await liveSession.close();
  await liveSession.close();
  assert.equal(sessions[1].closeCount, 1);
});

test("final STT words split consecutive speakers instead of assigning all text to the last voice", async () => {
  const stream = new EventEmitter();
  let streamingConfig;
  const audioWrites = [];
  stream.write = (frame) => { audioWrites.push(frame); return true; };
  stream.end = () => stream.emit("end");
  const utterances = [];
  const adapter = new CloudSpeechToTextAdapter({
    client: { streamingRecognize(config) { streamingConfig = config; return stream; } },
    projectId: "dev-project",
    languageCodes: ["ko-KR"],
  });
  const session = await adapter.open({ async onFinalUtterance(utterance) { utterances.push(utterance); } });
  assert.deepEqual(streamingConfig, {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16_000,
      audioChannelCount: 1,
      languageCode: "ko-KR",
      model: "latest_long",
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      diarizationConfig: { enableSpeakerDiarization: true, minSpeakerCount: 2, maxSpeakerCount: 6 },
    },
    interimResults: true,
  });
  const frame = new Uint8Array(1_280);
  await session.sendAudio(frame);
  assert.equal(audioWrites[0], frame, "the public SDK stream accepts raw PCM frames");
  stream.emit("data", {
    results: [{
      isFinal: true,
      alternatives: [{
        transcript: "hello there yes",
        words: [
          { word: "hello", speakerLabel: "A", startOffset: { nanos: 100_000_000 }, endOffset: { nanos: 250_000_000 } },
          { word: "there", speakerLabel: "A", startOffset: { nanos: 260_000_000 }, endOffset: { nanos: 400_000_000 } },
          { word: "yes", speakerLabel: "B", startOffset: { nanos: 410_000_000 }, endOffset: { nanos: 500_000_000 } },
        ],
      }],
    }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(utterances.map(({ speakerLabel, text, sourceStartOffsetMs, sourceEndOffsetMs }) => [speakerLabel, text, sourceStartOffsetMs, sourceEndOffsetMs]), [
    ["A", "hello there", 100, 400],
    ["B", "yes", 410, 500],
  ]);
  await session.close();
});

test("Cloud STT accepts V1 diarization speakerTag and startTime fields", async () => {
  const stream = new EventEmitter();
  stream.write = () => true;
  stream.end = () => stream.emit("end");
  const utterances = [];
  const adapter = new CloudSpeechToTextAdapter({ client: { streamingRecognize: () => stream }, projectId: "dev-project", languageCodes: ["ko-KR"] });
  const session = await adapter.open({ async onFinalUtterance(utterance) { utterances.push(utterance); } });
  stream.emit("data", { results: [{ isFinal: true, languageCode: "ko-KR", alternatives: [{ transcript: "안녕 네", words: [
    { word: "안녕", speakerTag: 1, startTime: { nanos: 100_000_000 }, endTime: { nanos: 400_000_000 } },
    { word: "네", speakerTag: 2, startTime: { nanos: 500_000_000 }, endTime: { nanos: 700_000_000 } },
  ] }] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(utterances.map(({ speakerLabel, text }) => [speakerLabel, text]), [["1", "안녕"], ["2", "네"]]);
  assert.deepEqual((await session.getFinalWords()).map(({ speakerLabel }) => speakerLabel), ["1", "2"]);
  await session.close();
});

test("Cloud STT nondiarized mode emits stable transcript prefixes without waiting for word labels", async () => {
  const stream = new EventEmitter();
  let streamingConfig;
  stream.write = () => true;
  stream.end = () => stream.emit("end");
  const utterances = [];
  const adapter = new CloudSpeechToTextAdapter({
    client: { streamingRecognize(config) { streamingConfig = config; return stream; } },
    projectId: "dev-project",
    languageCodes: ["en-US"],
    diarization: false,
  });
  const session = await adapter.open({ async onFinalUtterance(utterance) { utterances.push(utterance); } });
  assert.equal("diarizationConfig" in streamingConfig.config, false);
  const response = (transcript, endMs, isFinal = false) => ({ results: [{
    isFinal,
    stability: isFinal ? 0 : 0.96,
    languageCode: "en-US",
    resultEndTime: { seconds: Math.floor(endMs / 1_000), nanos: (endMs % 1_000) * 1_000_000 },
    alternatives: [{ transcript, words: [] }],
  }] });
  stream.emit("data", response("welcome to the live presentation", 1_400));
  stream.emit("data", response("welcome to the live presentation today", 1_800));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(utterances.map((utterance) => utterance.text), ["welcome to the live"]);
  stream.emit("data", response("welcome to the live presentation today", 2_000, true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(utterances.map((utterance) => utterance.text), ["welcome to the live", "presentation today"]);
  assert.equal(utterances.every((utterance) => utterance.speakerLabel === "1"), true);
  await session.close();
});

test("Cloud STT exposes only safe gRPC status and reason on provider failure", async () => {
  const stream = new EventEmitter();
  stream.write = () => true;
  stream.end = () => {};
  const adapter = new CloudSpeechToTextAdapter({ client: { streamingRecognize: () => stream }, projectId: "dev-project", languageCodes: ["ko-KR"] });
  const session = await adapter.open({ async onFinalUtterance() {} });
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  try {
    stream.emit("error", { code: 3, details: "private recognizer https://speech.example?key=AIza-secret and diarization are invalid" });
  } finally {
    console.error = originalError;
  }
  await assert.rejects(() => session.sendAudio(new Uint8Array(1_280)), (error) => {
    assert.equal(error.message, "STT_PROVIDER_INVALID_ARGUMENT");
    assert.equal(error.providerStatusCode, 3);
    assert.equal(error.providerReason, "DIARIZATION_CONFIGURATION_REJECTED");
    assert.equal(error.message.includes("private"), false);
    return true;
  });
  assert.match(errors.join("\n"), /STT_PROVIDER_INVALID_ARGUMENT.*DIARIZATION_CONFIGURATION_REJECTED/u);
  assert.doesNotMatch(errors.join("\n"), /AIza|speech\.example|key=|private recognizer/u);
});

test("Cloud STT dispatches later utterances before an earlier downstream task finishes", async () => {
  const stream = new EventEmitter();
  stream.write = () => true;
  stream.end = () => stream.emit("end");
  let releaseFirst;
  const started = [];
  const adapter = new CloudSpeechToTextAdapter({ client: { streamingRecognize: () => stream }, projectId: "dev-project", languageCodes: ["ko-KR"] });
  const session = await adapter.open({
    async onFinalUtterance(utterance) {
      started.push(utterance.text);
      if (utterance.text === "one") await new Promise((resolve) => { releaseFirst = resolve; });
    },
  });
  const result = (word, startMs) => ({
    isFinal: true,
    alternatives: [{ transcript: word, words: [{
      word,
      speakerTag: 1,
      startTime: { nanos: startMs * 1_000_000 },
      endTime: { nanos: (startMs + 100) * 1_000_000 },
    }] }],
  });
  stream.emit("data", { results: [result("one", 100), result("two", 300)] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["one", "two"]);
  const close = session.close();
  let didClose = false;
  close.then(() => { didClose = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(didClose, false, "close must drain accepted downstream work");
  releaseFirst();
  await close;
});

test("Cloud STT ignores a repeated finalized result instead of enqueueing duplicate TTS work", async () => {
  const stream = new EventEmitter();
  stream.write = () => true;
  stream.end = () => stream.emit("end");
  const utterances = [];
  const adapter = new CloudSpeechToTextAdapter({ client: { streamingRecognize: () => stream }, projectId: "dev-project", languageCodes: ["ko-KR"] });
  const session = await adapter.open({ async onFinalUtterance(utterance) { utterances.push(utterance); } });
  const response = {
    results: [{
      isFinal: true,
      alternatives: [{
        transcript: "hello",
        words: [{ word: "hello", speakerLabel: "A", startOffset: { nanos: 100_000_000 }, endOffset: { nanos: 500_000_000 } }],
      }],
    }],
  };
  stream.emit("data", response);
  stream.emit("data", structuredClone(response));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(utterances.length, 1);
  assert.equal((await session.getFinalWords()).length, 1);
  await session.close();
});

test("Cloud STT emits stable interim segments before a delayed final without duplicating final words", async () => {
  const stream = new EventEmitter();
  stream.write = () => true;
  stream.end = () => stream.emit("end");
  const utterances = [];
  const adapter = new CloudSpeechToTextAdapter({ client: { streamingRecognize: () => stream }, projectId: "dev-project", languageCodes: ["ko-KR"] });
  const session = await adapter.open({ async onFinalUtterance(utterance) { utterances.push(utterance); } });
  const words = Array.from({ length: 600 }, (_, index) => ({
    word: `word-${index}`,
    speakerLabel: "A",
    startOffset: { seconds: Math.floor(index / 10), nanos: (index % 10) * 100_000_000 },
    endOffset: { seconds: Math.floor((index + 1) / 10), nanos: ((index + 1) % 10) * 100_000_000 },
  }));
  for (let index = 0; index < words.length; index += 1) {
    stream.emit("data", { results: [{ isFinal: false, stability: 0.96, languageCode: "ko-KR", alternatives: [{ words: words.slice(0, index + 1) }] }] });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(utterances.length > 0, "stable interims must flow before a delayed final");
  stream.emit("data", { results: [{ isFinal: true, languageCode: "ko-KR", alternatives: [{ words, transcript: words.map((word) => word.word).join(" ") }] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(utterances.flatMap((utterance) => utterance.text.split(" ")).length, 600);
  assert.equal(utterances.every((utterance) => utterance.sourceEndOffsetMs - utterance.sourceStartOffsetMs <= 2_400), true);
  assert.equal(utterances.every((utterance) => utterance.sourceLanguage === "ko-KR"), true);
  await session.close();
});

test("viewer authorization accepts only a live session in the granted language", async () => {
  const urls = [];
  const signals = [];
  const authorizer = new SupabaseViewerAuthorizer({
    baseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-key",
    async fetchFn(url, init) {
      urls.push(String(url));
      signals.push(init.signal);
      return new Response("true", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const abortController = new AbortController();
  assert.equal(await authorizer.authorize(
    { grantId: "grant-1", sessionId: "session-1", userId: "viewer-1" },
    "session-1",
    "ko",
    { signal: abortController.signal },
  ), true);
  assert.equal(signals.every((signal) => signal === abortController.signal), true);
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).pathname, "/rest/v1/rpc/authorize_live_viewer_topic");
  assert.equal(await authorizer.authorize(
    { grantId: "grant-1", sessionId: "another-session", userId: "viewer-1" },
    "session-1",
    "ko",
  ), false);
});

test("Cloud STT surfaces interim transcripts through onPartialTranscript", async () => {
  const stream = new EventEmitter();
  stream.write = () => true;
  stream.end = () => stream.emit("end");
  const partials = [];
  const adapter = new CloudSpeechToTextAdapter({ client: { streamingRecognize: () => stream }, projectId: "dev-project", languageCodes: ["ko-KR"] });
  const session = await adapter.open({
    async onFinalUtterance() {},
    onPartialTranscript(partial) { partials.push(partial); },
  });
  stream.emit("data", {
    results: [
      { isFinal: false, stability: 0.1, languageCode: "ko-kr", alternatives: [{ transcript: "안녕하세요 " }] },
      { isFinal: false, stability: 0.01, alternatives: [{ transcript: "여러분" }] },
    ],
  });
  stream.emit("data", { results: [{ isFinal: true, alternatives: [{ transcript: "안녕하세요 여러분", words: [] }] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(partials, [{ text: "안녕하세요 여러분", sourceLanguage: "ko-kr" }]);
  await session.close();
});

test("Gemini text translation serves BOTH partials and finals without an alternate provider", async () => {
  const calls = [];
  const geminiClient = {
    models: {
      async generateContent(request) {
        calls.push(request);
        if (String(request.contents?.[0]?.parts?.[0]?.text ?? "").includes("실패해줘")) throw new Error("GEMINI_DOWN");
        return { text: "Hello everyone, let us begin." };
      },
    },
  };
  const adapter = new GeminiTextTranslateAdapter({ client: geminiClient });

  // Finals go through Gemini for desktop-parity quality.
  const finalText = await adapter.translate({ text: "안녕하세요 여러분 시작하겠습니다", language: "en", sourceLanguage: "ko-KR", intent: "final" });
  assert.equal(finalText, "Hello everyone, let us begin.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gemini-3.6-flash");
  assert.deepEqual(calls[0].config.thinkingConfig, { thinkingLevel: "minimal" });
  assert.equal("temperature" in calls[0].config, false);
  assert.equal("topP" in calls[0].config, false);
  assert.equal("topK" in calls[0].config, false);
  assert.match(String(calls[0].contents[0].parts[0].text), /안녕하세요 여러분 시작하겠습니다/);

  // Partials also go through Gemini — captions are locked to Gemini 3.5.
  const partialText = await adapter.translate({ text: "안녕하", language: "en", sourceLanguage: "ko-KR", intent: "partial" });
  assert.equal(partialText, "Hello everyone, let us begin.");
  assert.equal(calls.length, 2);

  // A Gemini failure is explicit instead of silently changing translation engines.
  await assert.rejects(
    adapter.translate({ text: "실패해줘", language: "en", sourceLanguage: "ko-KR", intent: "final" }),
    /GEMINI_DOWN/u,
  );
});

test("Gemini text failure logs only a safe failure code and propagates", async () => {
  const secret = ["test", "gemini", "marker"].join("-");
  const providerError = new Error(`request https://generativelanguage.googleapis.com?key=${secret}`);
  providerError.code = `Bearer ${secret}`;
  const adapter = new GeminiTextTranslateAdapter({
    client: { models: { async generateContent() { throw providerError; } } },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  try {
    await assert.rejects(
      adapter.translate({ text: "안녕하세요", language: "en", sourceLanguage: "ko-KR", intent: "final" }),
      (error) => error === providerError,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /GEMINI_TRANSLATE_FAILED/u);
  assert.doesNotMatch(warnings.join("\n"), /AIza|Bearer|googleapis\.com|key=/u);
});

test("Gemini text translation rejects output in the wrong script without fallback", async () => {
  const geminiClient = {
    models: {
      // Model echoes Korean back instead of translating: must not surface.
      async generateContent() { return { text: "안녕하세요 여러분" }; },
    },
  };
  const adapter = new GeminiTextTranslateAdapter({ client: geminiClient });
  await assert.rejects(
    adapter.translate({ text: "안녕하세요 여러분", language: "en", sourceLanguage: "ko-KR", intent: "final" }),
    /TRANSLATION_WRONG_SCRIPT/u,
  );
});

test("Gemini text translation injects only relevant glossary terms into each network prompt", async () => {
  const prompts = [];
  const systemInstructions = [];
  const geminiClient = {
    models: {
      async generateContent(request) {
        prompts.push(String(request.contents?.[0]?.parts?.[0]?.text ?? ""));
        systemInstructions.push(String(request.config?.systemInstruction ?? ""));
        return { text: "Hilton Garden Inn conversion is on track." };
      },
    },
  };
  const adapter = new GeminiTextTranslateAdapter({ client: geminiClient });
  const irrelevant = Array.from({ length: 500 }, (_, index) => `무관용어${index} = irrelevant-${index}`).join("\n");
  await adapter.translate({
    text: "힐튼 가든 인 컨버전은 순항 중입니다",
    language: "en",
    sourceLanguage: "ko-KR",
    glossaryText: `[Terms]\n${irrelevant}\n힐튼 가든 인 = Hilton Garden Inn\n컨버전 = conversion`,
    intent: "final",
  });
  assert.match(systemInstructions[0], /SECURITY BOUNDARY/u);
  const promptLines = prompts[0].split("\n");
  const payload = JSON.parse(promptLines[2]);
  assert.match(payload.glossary, /힐튼 가든 인 = Hilton Garden Inn/);
  assert.match(payload.glossary, /컨버전 = conversion/);
  assert.doesNotMatch(payload.glossary, /무관용어499/u);
  assert.ok(payload.glossary.length <= localTermRetrievalContract.maximumPromptCharacters);
});

test("Gemini Live Translate uses an 800 ms fallback only after an explicit audio boundary", () => {
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { connect() {} } },
  });
  assert.equal(adapter.finalFlushMilliseconds, 800);
});

test("Gemini Live Translate accumulates transcription deltas like the desktop pipeline", async () => {
  const captions = [];
  const inputCaptions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: {
      live: {
        async connect(options) {
          messageHandler = options.callbacks.onmessage;
          return { sendRealtimeInput() {}, close() {} };
        },
      },
    },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: (caption) => { captions.push({ ...caption }); },
    onInputCaption: (caption) => { inputCaptions.push({ ...caption }); },
    onAudio: async () => {},
    onInterruption: async () => {},
  });
  // Deltas, exactly as the Live API sends them.
  messageHandler({ serverContent: { outputTranscription: { text: "Hello" } } });
  messageHandler({ serverContent: { outputTranscription: { text: " every" } } });
  messageHandler({ serverContent: { outputTranscription: { text: "one" }, inputTranscription: { text: "안녕하세요", languageCode: "ko-KR" } } });
  messageHandler({ serverContent: { turnComplete: true } });
  // Next utterance must start from a clean slate.
  messageHandler({ serverContent: { outputTranscription: { text: "Next topic" }, turnComplete: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captions.map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: "Hello", isFinal: false },
    { text: "Hello every", isFinal: false },
    { text: "Hello everyone", isFinal: false },
    { text: "Hello everyone", isFinal: true },
    { text: "Next topic", isFinal: true },
  ]);
  assert.deepEqual(inputCaptions.map(({ text, isFinal, languageCode }) => ({ text, isFinal, languageCode })), [
    { text: "안녕하세요", isFinal: false, languageCode: "ko-KR" },
    { text: "안녕하세요", isFinal: true, languageCode: "ko-KR" },
  ]);
  await session.close();
});

test("Gemini Live Translate correlates each output with same-turn source and capture identity", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en", correlateInputCaption: true,
    onCaption: (caption) => captions.push(caption), onAudio: async () => {},
  });
  await session.sendAudio(Buffer.alloc(3_200), {
    capturedAt: 100, floorSpeaker: { participantId: "A", displayName: "발표자A" },
  });
  await session.sendAudio(Buffer.alloc(3_200), {
    capturedAt: 200, floorSpeaker: { participantId: "B", displayName: "발표자B" },
  });
  messageHandler({ serverContent: {
    inputTranscription: { text: "첫 원문", languageCode: "ko-KR" },
    outputTranscription: { text: "First translation" }, turnComplete: true,
  } });
  messageHandler({ serverContent: {
    inputTranscription: { text: "둘째 원문", languageCode: "ko-KR" },
    outputTranscription: { text: "Second translation" }, turnComplete: true,
  } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captions.map((caption) => [
    caption.sourceText, caption.sourceLanguage, caption.floorSpeaker?.participantId, caption.capturedAt,
  ]), [["첫 원문", "ko-KR", "A", 100], ["둘째 원문", "ko-KR", "B", 200]]);
  assert.notEqual(captions[0].utteranceKey, captions[1].utteranceKey);
  await session.close();
});

test("Gemini Live Translate exposes target-lane input observations with host source metadata", async () => {
  const observations = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onInputObservation: (caption) => observations.push(caption),
    onCaption: async () => {}, onAudio: async () => {},
  });
  await session.sendAudio(Buffer.alloc(3_200), { capturedAt: 100, floorSpeaker: null, source: "system" });
  messageHandler({ serverContent: { inputTranscription: { text: "테스트입니다.", languageCode: "ko-KR" }, turnComplete: true } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].targetLanguage, "en");
  assert.equal(observations[0].inputSource, "system");
  await session.close();
});

test("Gemini capture segments do not let retained host audio steal a late participant final", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en", correlateInputCaption: true,
    onCaption: (caption) => captions.push(caption), onAudio: async () => {},
  });

  await session.sendAudio(Buffer.alloc(3_200), { capturedAt: 100, floorSpeaker: null });
  messageHandler({ serverContent: {
    inputTranscription: { text: "호스트 발언", languageCode: "ko-KR" },
    outputTranscription: { text: "Host speech" }, turnComplete: true,
  } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  const participant = { participantId: "P-9", displayName: "Participant Nine" };
  await session.sendAudio(Buffer.alloc(3_200), { capturedAt: 200, floorSpeaker: participant });
  // Host reclaims before Gemini returns the participant's final. The retained
  // first host segment must not win merely because inputContexts is empty.
  await session.sendAudio(Buffer.alloc(3_200), { capturedAt: 300, floorSpeaker: null });
  messageHandler({ serverContent: {
    inputTranscription: { text: "참가자 늦은 발언", languageCode: "ko-KR" },
    outputTranscription: { text: "Late participant speech" }, turnComplete: true,
  } });
  messageHandler({ serverContent: {
    inputTranscription: { text: "호스트 다음 발언", languageCode: "ko-KR" },
    outputTranscription: { text: "Next host speech" }, turnComplete: true,
  } });
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captions[1].floorSpeaker?.participantId, "P-9");
  assert.equal(captions[1].sourceText, "참가자 늦은 발언");
  assert.equal(captions[2].floorSpeaker, null);
  assert.equal(captions[2].sourceText, "호스트 다음 발언");
  await session.close();
});

test("an explicit floor transition discards an unfinalized host capture before the participant final", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en", correlateInputCaption: true,
    onCaption: (caption) => captions.push(caption), onAudio: async () => {},
  });

  await session.sendAudio(Buffer.alloc(3_200), { capturedAt: 100, floorSpeaker: null });
  const participant = { participantId: "P-42", displayName: "Participant Forty Two" };
  session.setFloorSpeaker(participant);
  await session.sendAudio(Buffer.alloc(3_200), { capturedAt: 200, floorSpeaker: participant });
  messageHandler({ serverContent: {
    inputTranscription: { text: "참가자 첫 발언", languageCode: "ko-KR" },
    outputTranscription: { text: "Participant first speech" }, turnComplete: true,
  } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captions.length, 1);
  assert.equal(captions[0].floorSpeaker?.participantId, "P-42");
  assert.equal(captions[0].capturedAt, 200);
  await session.close();
});

test("Gemini Live Translate namespaces utterance identities by canonical target lane", async () => {
  const connections = new Map();
  const inputCaptions = new Map();
  const outputCaptions = new Map();
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      connections.set(options.config.translationConfig.targetLanguageCode, options.callbacks.onmessage);
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const sessions = [];
  for (const language of ["ko", "en"]) {
    sessions.push(await adapter.open({
      language,
      correlateInputCaption: true,
      onInputCaption: (caption) => inputCaptions.set(language, caption),
      onCaption: (caption) => outputCaptions.set(language, caption),
      onAudio: async () => {},
    }));
    connections.get(language)({ serverContent: {
      inputTranscription: { text: `${language} source`, languageCode: "en-US" },
      outputTranscription: { text: `${language} output` },
      turnComplete: true,
    } });
  }
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  for (const language of ["ko", "en"]) {
    assert.equal(inputCaptions.get(language).utteranceKey, outputCaptions.get(language).utteranceKey);
    assert.match(outputCaptions.get(language).utteranceKey, new RegExp(`^gemini:${language}:\\d+:\\d+$`, "u"));
  }
  assert.notEqual(outputCaptions.get("ko").utteranceKey, outputCaptions.get("en").utteranceKey);
  await Promise.all(sessions.map((session) => session.close()));
});

test("Gemini Live Translate waits briefly when output final arrives before its input final", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en", correlateInputCaption: true,
    onCaption: (caption) => captions.push(caption), onAudio: async () => {},
  });
  messageHandler({ serverContent: { outputTranscription: { text: "Output first" }, turnComplete: true } });
  messageHandler({ serverContent: { inputTranscription: { text: "입력 원문", languageCode: "ko-KR" }, turnComplete: true } });
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captions.length, 1);
  assert.equal(captions[0].sourceText, "입력 원문");
  assert.equal(captions[0].sourceLanguage, "ko-KR");
  assert.equal(typeof captions[0].utteranceKey, "string");
  await session.close();
});

test("Gemini Live Translate pairs delayed outputs with queued input turns in order", async () => {
  const captions = [];
  let messageHandler;
  let clock = 1_000;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    now: () => clock,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en", correlateInputCaption: true,
    onCaption: (caption) => captions.push(caption), onAudio: async () => {},
  });
  await session.sendAudio(Buffer.alloc(3_200), { capturedAt: 100, floorSpeaker: { participantId: "A", displayName: "A" } });
  messageHandler({ serverContent: { inputTranscription: { text: "A 원문。", languageCode: "ko-KR" } } });
  await session.sendAudio(Buffer.alloc(3_200), { capturedAt: 200, floorSpeaker: { participantId: "B", displayName: "B" } });
  messageHandler({ serverContent: { inputTranscription: { text: "B 원문。", languageCode: "ko-KR" } } });
  messageHandler({ serverContent: { outputTranscription: { text: "A output。" } } });
  clock += 1;
  messageHandler({ serverContent: { outputTranscription: { text: "B output。" }, turnComplete: true } });
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captions.map((caption) => [caption.text, caption.sourceText, caption.floorSpeaker?.participantId]), [
    ["A output。", "A 원문。", "A"],
    ["B output。", "B 원문。", "B"],
  ]);
  assert.notEqual(captions[0].utteranceKey, captions[1].utteranceKey);
  await session.close();
});

test("Gemini Live Translate does not carry a missing turn output into the next turn", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en", correlateInputCaption: true,
    onCaption: (caption) => captions.push(caption), onAudio: async () => {},
  });
  messageHandler({ serverContent: { inputTranscription: { text: "A 원문", languageCode: "ko-KR" }, turnComplete: true } });
  messageHandler({ serverContent: {
    inputTranscription: { text: "B 원문", languageCode: "ko-KR" },
    outputTranscription: { text: "B output" }, turnComplete: true,
  } });
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captions.length, 1);
  assert.equal(captions[0].sourceText, "B 원문");
  await session.close();
});

test("Gemini Live Translate discards expired input context instead of misattributing output", async () => {
  const captions = [];
  let messageHandler;
  let clock = 1_000;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    now: () => clock,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en", correlateInputCaption: true,
    onCaption: (caption) => captions.push(caption), onAudio: async () => {},
  });
  messageHandler({ serverContent: { inputTranscription: { text: "만료 원문。", languageCode: "ko-KR" } } });
  await new Promise((resolve) => setImmediate(resolve));
  clock += 1_500;
  messageHandler({ serverContent: { inputTranscription: { text: "현재 원문。", languageCode: "ko-KR" } } });
  messageHandler({ serverContent: { outputTranscription: { text: "Current output。" }, turnComplete: true } });
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captions.length, 1);
  assert.equal(captions[0].sourceText, "현재 원문。");
  await session.close();
});

test("Gemini Live Translate interruption discards the abandoned utterance text", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) { messageHandler = options.callbacks.onmessage; return { sendRealtimeInput() {}, close() {} }; } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: (caption) => { captions.push({ ...caption }); },
    onAudio: async () => {},
    onInterruption: async () => {},
  });
  messageHandler({ serverContent: { outputTranscription: { text: "Abandoned words" } } });
  messageHandler({ serverContent: { interrupted: true } });
  messageHandler({ serverContent: { outputTranscription: { text: "Fresh start" }, turnComplete: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captions.at(-1), { text: "Fresh start", isFinal: true });
  assert.equal(captions.some((caption) => caption.isFinal && caption.text.includes("Abandoned")), false);
  await session.close();
});

test("continuous speech survives content micro-gaps and finalizes only complete sentences", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    finalFlushMilliseconds: 30,
    client: { live: { async connect(options) { messageHandler = options.callbacks.onmessage; return { sendRealtimeInput() {}, close() {} }; } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: (caption) => { captions.push({ ...caption }); },
    onAudio: async () => {},
    onInterruption: async () => {},
  });
  // The real model's delta pattern for continuous speech — no turn signal.
  // A content-delivery gap longer than the old timeout is not a speech end.
  messageHandler({ serverContent: { outputTranscription: { text: "Before we begin" } } });
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(captions.some((caption) => caption.isFinal), false);
  messageHandler({ serverContent: { outputTranscription: { text: ", I want to explain the plan. " } } });
  messageHandler({ serverContent: { outputTranscription: { text: "Hello everyone." } } });
  messageHandler({ serverContent: { outputTranscription: { text: " Let's start the meeting." } } });
  messageHandler({ serverContent: { outputTranscription: { text: " This quarter's" } } });
  await new Promise((resolve) => setImmediate(resolve));
  const finalsBeforeFlush = captions.filter((caption) => caption.isFinal).map((caption) => caption.text);
  assert.deepEqual(finalsBeforeFlush, [
    "Before we begin, I want to explain the plan.",
    "Hello everyone.",
    "Let's start the meeting.",
  ]);
  assert.equal(captions.at(-1).isFinal, false);
  assert.equal(captions.at(-1).text, "This quarter's");
  // Another long transcription gap still does not finalize the incomplete tail.
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(captions.filter((caption) => caption.isFinal).length, 3);
  // The accepted-audio/VAD owner explicitly ends the stream. If the provider
  // never returns turnComplete, the bounded fallback preserves the tail once.
  await session.audioStreamEnd();
  await new Promise((resolve) => setTimeout(resolve, 90));
  const finals = captions.filter((caption) => caption.isFinal).map((caption) => caption.text);
  assert.deepEqual(finals, [
    "Before we begin, I want to explain the plan.",
    "Hello everyone.",
    "Let's start the meeting.",
    "This quarter's",
  ]);
  await session.close();
});

test("resumed audio cancels the explicit-boundary tail fallback", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    finalFlushMilliseconds: 40,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: (caption) => { captions.push({ ...caption }); },
    onAudio: async () => {},
    onInterruption: async () => {},
  });
  messageHandler({ serverContent: { outputTranscription: { text: "A natural pause" } } });
  await session.audioStreamEnd();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await session.sendAudio(Buffer.alloc(3_200));
  messageHandler({ serverContent: { outputTranscription: { text: " continues into one sentence." }, turnComplete: true } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(captions.filter((caption) => caption.isFinal).map((caption) => caption.text), [
    "A natural pause continues into one sentence.",
  ]);
  await session.close();
});

test("back-to-back audio end and resume cannot leave a stale final timer armed", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    finalFlushMilliseconds: 20,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput: async () => {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onCaption: (caption) => { captions.push({ ...caption }); },
    onAudio: async () => {},
  });
  messageHandler({ serverContent: { outputTranscription: { text: "The resumed sentence" } } });
  const ending = session.audioStreamEnd();
  const resuming = session.sendAudio(Buffer.alloc(3_200));
  await Promise.all([ending, resuming]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(captions.some((caption) => caption.isFinal), false);
  messageHandler({ serverContent: { outputTranscription: { text: " stays intact" }, turnComplete: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captions.filter((caption) => caption.isFinal).map((caption) => caption.text), [
    "The resumed sentence stays intact",
  ]);
  await session.close();
});

test("a 25-second logical turn with repeated micro-gaps stays one correlated source/output final", async () => {
  const inputCaptions = [];
  const outputCaptions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    // Each 12 ms test gap exceeds this former content-idle budget, modelling
    // repeated ~1 s pauses without making the suite wait 25 wall-clock seconds.
    finalFlushMilliseconds: 5,
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    correlateInputCaption: true,
    onInputCaption: (caption) => { inputCaptions.push({ ...caption }); },
    onCaption: (caption) => { outputCaptions.push({ ...caption }); },
    onAudio: async () => {},
    onInterruption: async () => {},
  });
  await session.sendAudio(Buffer.alloc(3_200), {
    capturedAt: 100,
    floorSpeaker: { participantId: "participant-25", displayName: "Participant" },
  });
  for (let second = 1; second <= 25; second += 1) {
    messageHandler({ serverContent: {
      inputTranscription: { text: ` 원문${second}`, languageCode: "ko-KR" },
      outputTranscription: { text: ` word${second}` },
      ...(second === 25 ? { turnComplete: true } : {}),
    } });
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  const inputFinals = inputCaptions.filter((caption) => caption.isFinal);
  const outputFinals = outputCaptions.filter((caption) => caption.isFinal);
  assert.equal(inputFinals.length, 1);
  assert.equal(outputFinals.length, 1);
  assert.match(inputFinals[0].text, /원문1.*원문25/u);
  assert.match(outputFinals[0].text, /word1.*word25/u);
  assert.equal(outputFinals[0].utteranceKey, inputFinals[0].utteranceKey);
  assert.equal(outputFinals[0].sourceText, inputFinals[0].text);
  assert.equal(outputFinals[0].floorSpeaker?.participantId, "participant-25");
  await session.close();
});

test("close drains one unfinished source/output pair in order", async () => {
  const inputCaptions = [];
  const outputCaptions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    correlateInputCaption: true,
    onInputCaption: (caption) => { inputCaptions.push({ ...caption }); },
    onCaption: (caption) => { outputCaptions.push({ ...caption }); },
    onAudio: async () => {},
    onInterruption: async () => {},
  });
  await session.sendAudio(Buffer.alloc(3_200), {
    capturedAt: 100,
    floorSpeaker: { participantId: "participant-1", displayName: "Participant" },
  });
  messageHandler({ serverContent: {
    inputTranscription: { text: "마지막 문장은 종료 시에도 보존됩니다", languageCode: "ko-KR" },
    outputTranscription: { text: "The final sentence is preserved on close" },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  await session.close();
  assert.equal(inputCaptions.filter((caption) => caption.isFinal).length, 1);
  assert.equal(outputCaptions.filter((caption) => caption.isFinal).length, 1);
  assert.equal(outputCaptions.at(-1).sourceText, "마지막 문장은 종료 시에도 보존됩니다");
  assert.equal(outputCaptions.at(-1).utteranceKey, inputCaptions.at(-1).utteranceKey);
  assert.equal(outputCaptions.at(-1).floorSpeaker?.participantId, "participant-1");
});

test("Gemini locks mixed Korean source until punctuation then permits English in the same provider turn", async () => {
  const inputCaptions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onInputCaption: (caption) => { inputCaptions.push({ ...caption }); },
    onCaption: async () => {},
    onAudio: async () => {},
  });

  messageHandler({ serverContent: { inputTranscription: {
    text: "국내 CRE market과 Cushman & Wakefield 임대료입니다。 We will continue with the next agenda item. ",
    languageCode: "ko-KR",
  } } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    inputCaptions.filter((caption) => caption.isFinal).map(({ text, languageCode }) => ({ text, languageCode })),
    [
      { text: "국내 CRE market과 Cushman & Wakefield 임대료입니다。", languageCode: "ko-KR" },
      { text: "We will continue with the next agenda item.", languageCode: "en" },
    ],
  );
  await session.close();
});

test("a floor boundary rejects provider transcript callbacks queued for the old floor", async () => {
  const inputCaptions = [];
  let messageHandler;
  let releaseFirstPartial;
  const firstPartialBlocked = new Promise((resolve) => { releaseFirstPartial = resolve; });
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onInputCaption: async (caption) => {
      inputCaptions.push({ ...caption });
      if (caption.text === "이전 화자의") await firstPartialBlocked;
    },
    onCaption: async () => {},
    onAudio: async () => {},
  });

  messageHandler({ serverContent: { inputTranscription: { text: "이전 화자의", languageCode: "ko-KR" } } });
  await new Promise((resolve) => setImmediate(resolve));
  messageHandler({ serverContent: { inputTranscription: { text: " 폐기될 꼬리", languageCode: "ko-KR" } } });
  session.setFloorSpeaker({ participantId: "next", displayName: "Next" });
  releaseFirstPartial();
  messageHandler({ serverContent: { inputTranscription: {
    text: "The new speaker starts here",
    languageCode: "en-US",
  }, turnComplete: true } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    inputCaptions.some((caption) => caption.text.includes("폐기될 꼬리")),
    false,
    JSON.stringify(inputCaptions.map(({ text, isFinal, languageCode }) => ({ text, isFinal, languageCode }))),
  );
  assert.equal(inputCaptions.at(-1).text, "The new speaker starts here");
  assert.equal(inputCaptions.at(-1).isFinal, true);
  assert.equal(inputCaptions.at(-1).languageCode, "en-US");
  await session.close();
});

test("an interruption resets the source lock before the next utterance", async () => {
  const inputCaptions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "en",
    onInputCaption: (caption) => { inputCaptions.push({ ...caption }); },
    onCaption: async () => {},
    onAudio: async () => {},
    onInterruption: async () => {},
  });

  messageHandler({ serverContent: { inputTranscription: {
    text: "한국어로 시작한 중단 발화",
    languageCode: "ko-KR",
  } } });
  await new Promise((resolve) => setImmediate(resolve));
  messageHandler({ serverContent: { interrupted: true } });
  messageHandler({ serverContent: { inputTranscription: {
    text: "The replacement utterance is fully English",
    languageCode: "en-US",
  }, turnComplete: true } });
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    inputCaptions.filter((caption) => caption.isFinal).map(({ text, languageCode }) => ({ text, languageCode })),
    [{ text: "The replacement utterance is fully English", languageCode: "en-US" }],
  );
  await session.close();
});

test("Gemini rejects malformed output transcript text and oversized language metadata", async () => {
  const captions = [];
  let messageHandler;
  const adapter = new GeminiLiveTranslateAdapter({
    model: "gemini-3.5-live-translate-preview",
    client: { live: { async connect(options) {
      messageHandler = options.callbacks.onmessage;
      return { sendRealtimeInput() {}, close() {} };
    } } },
  });
  const session = await adapter.open({
    language: "ko",
    onCaption: (caption) => { captions.push({ ...caption }); },
    onAudio: async () => {},
  });

  messageHandler({ serverContent: { outputTranscription: {
    text: { toString() { throw new Error("must not run"); } },
    languageCode: "ko",
  }, turnComplete: true } });
  messageHandler({ serverContent: { outputTranscription: {
    text: "정상 번역",
    languageCode: "x".repeat(129),
  }, turnComplete: true } });
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(captions, [{ text: "정상 번역", isFinal: true }]);
  await session.close();
});
