import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createSubtitleAudioPlayer,
  createTranslatedAudioGuard,
  shouldGateTranslatedAudioInput,
} from "../public/subtitle-audio-player.js";
import { createSubtitleChannelHub } from "../src/subtitle-channels.js";
import { handleGeminiLiveMessage } from "../src/gemini-live-translate.js";
import { normalizeSubtitleLanguageCode } from "../src/subtitle-languages.js";
import { handleRealtimeMessage } from "../src/subtitle-realtime.js";
import { validateSubtitleSettings } from "../src/settings-store.js";

const geminiSource = readFileSync(new URL("../src/gemini-live-translate.js", import.meta.url), "utf8");
const realtimeSource = readFileSync(new URL("../src/subtitle-realtime.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
const audioPlayerSource = readFileSync(new URL("../public/subtitle-audio-player.js", import.meta.url), "utf8");

const VALID_PCM = Buffer.alloc(4_800, 1).toString("base64");

function modelTurn(inlineData, content = {}) {
  return JSON.stringify({
    serverContent: {
      ...content,
      modelTurn: { parts: [{ inlineData }] },
    },
  });
}

function collectGeminiEvents(raw, context = {}) {
  const events = [];
  const logs = [];
  let sourceText = "";
  let translatedText = "";
  const geminiContext = {
    source: "mic",
    targetLanguage: "ko",
    outputMode: "audio",
    getSourceText: () => sourceText,
    setSourceText: (value) => { sourceText = value; },
    getTranslatedText: () => translatedText,
    setTranslatedText: (value) => { translatedText = value; },
    shouldDisplay: () => true,
    broadcast: (event) => events.push(event),
    log: {
      warn: (value) => logs.push(String(value)),
      error: (value) => logs.push(String(value)),
    },
    ...context,
  };
  const handle = (nextRaw) => handleGeminiLiveMessage(nextRaw, geminiContext);
  handle(raw);
  return { events, handle, logs };
}

function translatedAudioEvents(events) {
  return events.filter((event) => event?.type === "subtitle:translated-audio");
}

function requireSource(source, pattern, message) {
  assert.equal(pattern.test(source), true, message);
}

function forbidSource(source, pattern, message) {
  assert.equal(pattern.test(source), false, message);
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.sources = [];
  }

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }

  createBuffer(_channels, length, sampleRate) {
    return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) };
  }

  createBufferSource() {
    const source = {
      stopped: false,
      playbackRate: { value: 1 },
      connect() {},
      disconnect() {},
      addEventListener() {},
      start() {},
      stop() { this.stopped = true; },
    };
    this.sources.push(source);
    return source;
  }

  async resume() {}
  async close() {}
}

test("Gemini streams canonical PCM16 mono 24 kHz audio without waiting for a transcript boundary", () => {
  for (const outputMode of ["audio"]) {
    const result = collectGeminiEvents(modelTurn({
      mimeType: "audio/pcm;rate=24000",
      data: VALID_PCM,
    }), { outputMode });
    const streamed = translatedAudioEvents(result.events);
    assert.equal(streamed.length, 1, `${outputMode} must stream canonical audio immediately`);
    const { audio, ...header } = streamed[0];
    assert.deepEqual(header, {
      type: "subtitle:translated-audio",
      source: "mic",
      targetLanguage: "ko",
      sampleRate: 24_000,
      mimeType: "audio/pcm;rate=24000",
    });
    assert.equal(audio, VALID_PCM);
  }

  const captionsOnly = collectGeminiEvents(modelTurn({
    mimeType: "audio/pcm;rate=24000",
    data: VALID_PCM,
  }), { outputMode: "captions" });
  assert.equal(translatedAudioEvents(captionsOnly.events).length, 0);
  requireSource(geminiSource, /for \(const part of content\.modelTurn\?\.parts \?\? \[\]\)[\s\S]{0,320}ctx\.broadcast\?\.\(\{/u,
    "validated provider audio must stream without depending on transcription ordering");
  forbidSource(geminiSource, /(?:buffer|flush|clear)TranslatedAudio/u,
    "provider audio must not depend on a transcript turn gate");
});

test("continuous audio rejects exact transport replay and stale stream frames", () => {
  const hub = createSubtitleChannelHub();
  const guard = createTranslatedAudioGuard();
  const message = {
    type: "subtitle:translated-audio",
    source: "mic",
    targetLanguage: "en",
    sampleRate: 24_000,
    mimeType: "audio/pcm;rate=24000",
    audio: VALID_PCM,
  };

  const first = hub.ingest(message);
  const providerReplay = hub.ingest(message);
  assert.equal(first.streamId, providerReplay.streamId);
  assert.equal(providerReplay.seq, first.seq + 1);
  assert.equal(guard.shouldAccept(first), true);
  assert.equal(guard.shouldAccept(first), false, "the same ordered frame must not play twice");
  assert.equal(guard.shouldAccept(providerReplay), false,
    "a provider replay with a fresh seq must still fail the PCM fingerprint guard");

  const newPcm = hub.ingest({ ...message, audio: Buffer.alloc(4_800, 2).toString("base64") });
  assert.equal(guard.shouldAccept(newPcm), true, "new PCM in the same stream must remain continuous");
  const clear = hub.ingest({ type: "subtitle:audio-control", action: "clear", source: "mic", targetLanguage: "en" });
  assert.equal(guard.markControl(clear), true);
  assert.equal(guard.shouldAccept(newPcm), false, "a frame at or below the clear floor must stay retired");

  const resumedHub = createSubtitleChannelHub();
  const resumed = resumedHub.ingest(message);
  assert.notEqual(resumed.streamId, first.streamId);
  assert.equal(guard.shouldAccept(resumed), true, "the first frame from a new server stream must be admitted");
  const lateOldStream = hub.ingest({ ...message, audio: Buffer.alloc(4_800, 3).toString("base64") });
  assert.equal(guard.shouldAccept(lateOldStream), false,
    "late frames from a retired stream must never switch playback backwards");
});

test("malformed, oversized, non-base64, odd-byte, and wrong-format inlineData never broadcasts", () => {
  const invalidParts = [
    null,
    {},
    { mimeType: "audio/pcm;rate=24000", data: "%%%not-base64%%%" },
    { mimeType: "audio/pcm;rate=24000", data: "AA==" },
    { mimeType: "audio/pcm;rate=16000", data: VALID_PCM },
    { mimeType: "audio/wav", data: VALID_PCM },
    { mimeType: "audio/pcm;rate=24000<img onerror=alert(1)>", data: VALID_PCM },
    { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(2 * 1024 * 1024).toString("base64") },
  ];
  for (const inlineData of invalidParts) {
    const { events } = collectGeminiEvents(modelTurn(inlineData));
    assert.equal(translatedAudioEvents(events).length, 0, JSON.stringify(inlineData)?.slice(0, 120));
  }
  const invalidLanguage = collectGeminiEvents(modelTurn({
    mimeType: "audio/pcm;rate=24000",
    data: VALID_PCM,
  }), { targetLanguage: "ko<img>" });
  assert.equal(translatedAudioEvents(invalidLanguage.events).length, 0);
});

test("provider errors and invalid frames never expose raw audio, API keys, or subtitle bodies", () => {
  const sensitive = "super-secret-api-key-and-caption-body";
  const invalid = collectGeminiEvents(`not-json-${sensitive}`);
  assert.equal(JSON.stringify(invalid).includes(sensitive), false);

  forbidSource(geminiSource, /console\.(?:log|info|warn|error)\([^\n]*(?:apiKey|inlineData|\.data|line)/u, "Gemini raw values must not be logged");
  forbidSource(realtimeSource, /log\.(?:warn|error)\?\.\([^\n]*\$\{error\.message\}/u, "provider error.message must be redacted before logging");
  forbidSource(realtimeSource, /log\.(?:warn|error)\?\.\([^\n]*\$\{reasonText\}/u, "provider close reason must be redacted before logging");
  forbidSource(serverSource, /console\.(?:log|info|warn|error)\([^\n]*(?:translatedText|sourceText|audio|apiKey)/u, "server must not log sensitive media fields");
});

test("provider language codes cross an allowlist boundary before language state is updated", () => {
  assert.equal(normalizeSubtitleLanguageCode(" EN "), "en");
  assert.equal(normalizeSubtitleLanguageCode("korean"), "ko");
  for (const value of [
    "en<script>alert(1)</script>",
    "__proto__",
    "../../ko",
    "ko\u0000en",
    "x".repeat(100_000),
  ]) {
    assert.equal(normalizeSubtitleLanguageCode(value), "", value.slice(0, 40));
  }
  requireSource(
    realtimeSource,
    /const languageFromProvider = normalizeProviderLanguageCode\(languageCode\);[\s\S]{0,260}sourceLanguageCoordinator\?\.apply\(languageFromProvider\)/u,
    "raw provider languageCode must be normalized before it reaches the source-language coordinator",
  );
  requireSource(
    realtimeSource,
    /const exact = normalizeLanguageCode\(code\);[\s\S]{0,100}if \(exact\) return exact;[\s\S]{0,180}if \(isSupportedSubtitleLanguage\(primary\)\) return primary;[\s\S]{0,100}return "";/u,
    "provider locale normalization must resolve aliases and fail outside the product language allowlist",
  );
});

test("subtitle transcript diagnostics are opt-in and remain broadcast-only", () => {
  const previousDebug = process.env.SUBTITLE_DEBUG;
  try {
    delete process.env.SUBTITLE_DEBUG;
    const defaultResult = collectGeminiEvents(JSON.stringify({
      serverContent: { inputTranscription: { text: "private source text", languageCode: "en" } },
    }));
    assert.equal(defaultResult.events.some((event) => event.type === "subtitle:debug"), false);

    const explicitResult = collectGeminiEvents(JSON.stringify({
      serverContent: { inputTranscription: { text: "private source text", languageCode: "en" } },
    }), { debug: true });
    assert.equal(explicitResult.events.some((event) => event.type === "subtitle:debug"), true);

    process.env.SUBTITLE_DEBUG = "false";
    const explicitFalseResult = collectGeminiEvents(JSON.stringify({
      serverContent: { inputTranscription: { text: "private source text", languageCode: "en" } },
    }));
    assert.equal(explicitFalseResult.events.some((event) => event.type === "subtitle:debug"), false,
      "the literal false must not opt in to transcript diagnostics");

    const historyGate = serverSource.match(/const broadcastSubtitleMessage[\s\S]*?if \(message\.type !== "subtitle:committed"\) return;/u)?.[0] ?? "";
    assert.match(historyGate, /message\.type !== "subtitle:committed"/u);
    forbidSource(historyGate, /subtitle:debug[\s\S]{0,240}(?:record|writeFile|appendFile|fetch\()/u,
      "debug transcript events must never enter history, disk, or remote persistence");
  } finally {
    if (previousDebug === undefined) delete process.env.SUBTITLE_DEBUG;
    else process.env.SUBTITLE_DEBUG = previousDebug;
  }
});

test("malformed provider messages never reflect raw transcript payloads to clients", () => {
  const sensitive = "private-transcript-and-provider-payload";
  const events = [];
  handleRealtimeMessage(`not-json-${sensitive}`, { broadcast: (event) => events.push(event) });
  assert.ok(events.some((event) => event.type === "subtitle:error"));
  assert.equal(JSON.stringify(events).includes(sensitive), false);
});

test("oversized provider transcripts cannot grow subtitle language state", () => {
  const oversized = "A".repeat(100_000);
  let openAiSource = "unchanged";
  const openAiEvents = [];
  handleRealtimeMessage(JSON.stringify({ type: "session.input_transcript.delta", delta: oversized }), {
    getSourceText: () => openAiSource,
    setSourceText: (value) => { openAiSource = value; },
    broadcast: (event) => openAiEvents.push(event),
  });
  assert.equal(openAiSource, "unchanged");
  assert.equal(JSON.stringify(openAiEvents).includes(oversized.slice(0, 1_000)), false);

  let geminiSource = "unchanged";
  const geminiEvents = [];
  handleGeminiLiveMessage(JSON.stringify({
    serverContent: { inputTranscription: { text: oversized, languageCode: "en" } },
  }), {
    source: "mic",
    targetLanguage: "ko",
    getSourceText: () => geminiSource,
    setSourceText: (value) => { geminiSource = value; },
    getTranslatedText: () => "",
    setTranslatedText() {},
    broadcast: (event) => geminiEvents.push(event),
  });
  assert.equal(geminiSource, "unchanged");
  assert.equal(JSON.stringify(geminiEvents).includes(oversized.slice(0, 1_000)), false);
});

test("subtitle audio settings reject provider confusion, missing language, and invalid volume", () => {
  const validAudio = {
    outputMode: "audio",
    translationProvider: "gemini",
    translationLanguages: ["en", "ko"],
    audioLanguage: "ko",
    audioVolume: 0.75,
  };
  assert.doesNotThrow(() => validateSubtitleSettings(validAudio));
  // Mixed caption+audio output is retired: rejected on write, migrated on read.
  assert.throws(
    () => validateSubtitleSettings({ ...validAudio, outputMode: "captions_audio" }),
    /outputMode must be captions or audio/u,
  );
  assert.throws(() => validateSubtitleSettings({ outputMode: "captions", translationProvider: "openai" }), /remain gemini/u);

  for (const settings of [
    { ...validAudio, outputMode: "video" },
    { ...validAudio, translationProvider: "openai" },
    { ...validAudio, audioLanguage: "" },
    { ...validAudio, audioLanguage: undefined },
    { ...validAudio, audioLanguage: "ja" },
    { ...validAudio, audioVolume: Number.NaN },
    { ...validAudio, audioVolume: Number.POSITIVE_INFINITY },
    { ...validAudio, audioVolume: -0.01 },
    { ...validAudio, audioVolume: 1.01 },
  ]) {
    assert.throws(() => validateSubtitleSettings(settings), JSON.stringify(settings));
  }
});

test("stop, interruption, reconnect, and reconfigure clear every queued audio source", () => {
  requireSource(geminiSource, /content\.interrupted[\s\S]{0,240}subtitle:audio-control[\s\S]{0,160}action:\s*["']clear["']/u, "Gemini interruption must emit audio clear control");
  let localClearCount = 0;
  const interrupted = collectGeminiEvents(JSON.stringify({ serverContent: { interrupted: true } }), {
    clearAudio: () => { localClearCount += 1; },
  });
  assert.ok(interrupted.events.some((event) => event.type === "subtitle:audio-control"
    && event.action === "clear"
    && event.reason === "interrupted"));
  assert.equal(localClearCount, 1, "interruption must clear the channel-local playback state too");
  requireSource(realtimeSource, /socket\.on\(["']close["'][\s\S]{0,900}type:\s*["']subtitle:audio-control["'][\s\S]{0,180}reason:\s*intentionalClose\s*\?\s*["']close["']\s*:\s*["']reconnect["']/u,
    "provider reconnect and channel close must invalidate queued audio");
  requireSource(realtimeSource, /async function stop[\s\S]{0,300}clearTranslatedAudio\(["']stop["']\)/u,
    "session stop must invalidate queued audio before closing providers");
  requireSource(dashboardSource, /function clearTranslatedAudioQueue\(\)[\s\S]{0,240}subtitleAudioPlayer\.clear\s*\(/u, "queue-clear helper must delegate to the player");
  requireSource(dashboardSource, /function stopSubtitles[\s\S]*?clearTranslatedAudioQueue\s*\(/u, "stop must clear translated audio");
  requireSource(dashboardSource, /function reconfigureRunningSession[\s\S]*?clearTranslatedAudioQueue\s*\(/u, "reconfigure must clear translated audio");
  requireSource(dashboardSource, /addEventListener\(["']close["'][\s\S]{0,300}clearTranslatedAudioQueue\s*\(/u, "WebSocket close must clear translated audio");
  requireSource(dashboardSource, /subtitle:audio-control[\s\S]{0,300}action\s*===\s*["']clear["'][\s\S]{0,300}clearTranslatedAudioQueue\s*\(/u, "server clear control must clear translated audio");
  requireSource(audioPlayerSource, /\.stop\(\)[\s\S]{0,160}\.disconnect\(\)/u, "queued sources must be stopped and disconnected");
});

test("translated audio uses a bounded queue that restarts in place without killing playback", async () => {
  forbidSource(audioPlayerSource, /MAX_QUEUE_SECONDS\s*=\s*3\s*;/u, "normal speech must not be rejected at three seconds");
  requireSource(audioPlayerSource, /MAX_QUEUE_SECONDS\s*=\s*30/u, "scheduler must allow a realistic continuous interpretation backlog");
  requireSource(audioPlayerSource, /MAX_QUEUE_PCM_BYTES/u, "scheduler must enforce a memory cap as well as a time cap");
  requireSource(audioPlayerSource, /maxQueueSeconds\s*=\s*MAX_QUEUE_SECONDS/u, "scheduler must use the bounded default");
  requireSource(audioPlayerSource, /projectedQueueDuration\s*>\s*maxQueueSeconds/u, "scheduler must enforce the configured queue limit");
  requireSource(audioPlayerSource, /function clear\(\)[\s\S]{0,180}stopScheduledSources\(\)/u, "clear must stop every scheduled source");
  requireSource(audioPlayerSource, /function restartQueue[\s\S]{0,300}clear\(\)[\s\S]{0,200}onQueueRestart/u, "queue overflow must clear and report an in-place restart");
  const restarts = [];
  /** @type {FakeAudioContext | null} */
  let context = null;
  const player = createSubtitleAudioPlayer({
    createAudioContext: () => (context = new FakeAudioContext()),
    maxQueueSeconds: 3,
    onQueueRestart: (detail) => restarts.push(detail),
  });
  await player.resume();
  const twoSeconds = Buffer.alloc(2 * 24_000 * 2, 1).toString("base64");
  assert.equal(player.enqueue({ audio: twoSeconds, sampleRate: 24_000 }), true);
  assert.equal(player.enqueue({ audio: twoSeconds, sampleRate: 24_000 }), true);
  assert.equal(restarts.length, 1);
  assert.ok(context instanceof FakeAudioContext);
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0].stopped, true);
  assert.equal(context.sources[1].stopped, false);
  assert.equal(player.isFailed, false);
});

test("translated-audio WebSocket data has no HTML execution path", () => {
  forbidSource(dashboardSource, /(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function)/u, "dashboard must not use executable HTML sinks");
  requireSource(dashboardSource, /subtitle:translated-audio/u, "dashboard must recognize translated audio explicitly");
  requireSource(dashboardSource, /message\.mimeType\s*===\s*["']audio\/pcm;rate=24000["']/u, "client must validate exact MIME");
  requireSource(dashboardSource, /message\.sampleRate\s*===\s*24_000/u, "client must validate 24 kHz");
  requireSource(dashboardSource, /const base64Audio\s*=\s*message\.audio[\s\S]{0,500}subtitleAudioPlayer\.enqueue\(\{\s*audio:\s*base64Audio/u, "client must pass only the audio field to the PCM player");
  requireSource(audioPlayerSource, /atob\(audio\)/u, "PCM player must base64-decode the audio field");
});

test("translated audio is never persisted locally or remotely", () => {
  const historyGate = serverSource.match(/const broadcastSubtitleMessage[\s\S]*?if \(message\.type !== "subtitle:committed"\) return;/u)?.[0] ?? "";
  assert.match(historyGate, /message\.type !== "subtitle:committed"/u);
  forbidSource(serverSource, /subtitle:translated-audio[\s\S]{0,500}(?:subtitleHistory\.record|settingsStore\.save|fetch\()/u, "server audio events must remain broadcast-only");
  forbidSource(dashboardSource, /subtitle:translated-audio[\s\S]{0,500}(?:localStorage|indexedDB|fetch\()/u, "client audio events must remain memory-only");
});

test("desktop translated audio blocks replay and its own system-loopback feedback", () => {
  requireSource(dashboardSource, /createTranslatedAudioGuard/u, "dashboard must dedupe provider and resumption replay");
  requireSource(dashboardSource, /translatedAudioGuard\.shouldAccept\(message\)/u, "audio must pass the replay guard before enqueue");
  requireSource(dashboardSource, /translatedAudioGuard\.markControl\(message\)/u, "restart controls must advance the stale-audio floor");
  assert.equal(shouldGateTranslatedAudioInput("audio", true, "system"), true,
    "system loopback must remain isolated while translated audio plays");
  assert.equal(shouldGateTranslatedAudioInput("audio", true, "mic"), false,
    "microphone speech must continue while translated audio plays");
  requireSource(dashboardSource, /shouldGateTranslatedAudioInput\([\s\S]{0,180}capture\.source/u,
    "streaming feedback isolation must distinguish system loopback from microphone input");
  requireSource(dashboardSource, /isFeedbackSuppressed = shouldGateTranslatedAudioInput[\s\S]{0,180}sourceName/u,
    "input status must report source-specific feedback isolation");
  requireSource(dashboardSource, /echoCancellation:\s*true/u, "microphone echo cancellation must be enabled");
  requireSource(dashboardSource, /noiseSuppression:\s*true/u, "microphone noise suppression must be enabled");
  requireSource(dashboardSource, /autoGainControl:\s*true/u, "microphone automatic gain control must be enabled");
});
