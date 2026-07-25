import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubtitleAudioPlayer,
  createTranslatedAudioGuard,
  decodePcm16Base64,
  getAdaptivePlaybackRate,
  shouldGateTranslatedAudioInput,
} from "../public/subtitle-audio-player.js";

function pcmBase64(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return Buffer.from(bytes).toString("base64");
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0.25;
    this.state = "suspended";
    this.destination = {};
    this.sources = [];
    this.resumeCalls = 0;
    this.closeCalls = 0;
  }

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }

  createBuffer(channels, length, sampleRate) {
    assert.equal(channels, 1);
    const channel = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => channel, channel };
  }

  createBufferSource() {
    let endedListener = null;
    const source = {
      buffer: null,
      playbackRate: { value: 1 },
      startedAt: null,
      stopped: false,
      ended: false,
      connect() {},
      disconnect() {},
      addEventListener(type, listener) { if (type === "ended") endedListener = listener; },
      emitEnded() { if (!this.ended) { this.ended = true; endedListener?.(); } },
      start(at) { this.startedAt = at; },
      stop() { this.stopped = true; },
    };
    this.sources.push(source);
    return source;
  }

  async resume() { this.resumeCalls += 1; this.state = "running"; }
  async close() { this.closeCalls += 1; }
}

test("adaptive playback rate follows queue pressure with bounded per-chunk changes", () => {
  let rate = 1;
  const observed = [];
  for (const queueAhead of [0.5, 2, 4, 7, 10, 14, 14, 14, 4, 0.5]) {
    const nextRate = getAdaptivePlaybackRate(queueAhead, rate);
    observed.push(nextRate);
    assert.ok(nextRate >= 1 && nextRate <= 1.6);
    assert.ok(nextRate - rate <= 0.080001, "speed-up must be gradual");
    assert.ok(rate - nextRate <= 0.040001, "slow-down must be gradual");
    rate = nextRate;
  }
  assert.equal(observed[0], 1);
  assert.ok(observed[6] > 1.3, "sustained ten-second backlog must activate catch-up playback");
  assert.ok(Math.max(...observed) > 1.5, "sustained critical backlog must reach the 1.6x safety headroom gradually");
  assert.ok(observed.at(-1) > 1, "rate must settle gradually instead of dropping abruptly");
});

test("PCM16 LE base64 is decoded to normalized mono Float32", () => {
  const decoded = decodePcm16Base64(pcmBase64([-32768, 0, 32767]));
  assert.equal(decoded.length, 3);
  assert.equal(decoded[0], -1);
  assert.equal(decoded[1], 0);
  assert.ok(Math.abs(decoded[2] - (32767 / 32768)) < 0.000001);
});

test("decoder rejects noncanonical, odd-byte, and oversized PCM before playback", () => {
  assert.throws(() => decodePcm16Base64("%%%="), /base64/);
  assert.throws(() => decodePcm16Base64(Buffer.from([1]).toString("base64")), /PCM/);
  assert.throws(() => decodePcm16Base64(Buffer.alloc(256 * 1024 + 2).toString("base64")), /크기/);
});

test("player resumes from the start gesture and schedules PCM in order through gain", async () => {
  const contexts = [];
  const player = createSubtitleAudioPlayer({
    createAudioContext: () => {
      const context = new FakeAudioContext();
      contexts.push(context);
      return context;
    },
  });

  await player.resume(0.4);
  assert.equal(contexts[0].resumeCalls, 1);
  assert.equal(player.volume, 0.4);
  assert.equal(player.enqueue({ audio: pcmBase64(new Array(24_000).fill(1000)), sampleRate: 24_000 }), true);
  assert.equal(player.enqueue({ audio: pcmBase64(new Array(12_000).fill(-1000)), sampleRate: 24_000 }), true);
  assert.equal(contexts[0].sources[0].startedAt, 0.5);
  assert.equal(contexts[0].sources[1].startedAt, 1.5);
});

test("long translated speech schedules continuously beyond three seconds", async () => {
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({
    createAudioContext: () => context,
  });

  await player.resume(0.8);
  assert.equal(player.enqueue({ audio: pcmBase64(new Array(48_000).fill(1200)), sampleRate: 24_000 }), true);
  assert.equal(player.enqueue({ audio: pcmBase64(new Array(48_000).fill(1200)), sampleRate: 24_000 }), true);
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0].stopped, false);
  assert.equal(context.sources[1].startedAt, 2.5);
  assert.equal(player.isFailed, false);
});

test("scheduled duration is divided by adaptive playbackRate while preserving chunk order", async () => {
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({ createAudioContext: () => context });
  await player.resume();
  const oneSecond = pcmBase64(new Array(24_000).fill(1200));
  for (let index = 0; index < 8; index += 1) player.enqueue({ audio: oneSecond, sampleRate: 24_000 });

  const accelerated = context.sources.find((source) => source.playbackRate.value > 1);
  assert.ok(accelerated, "backlogged audio must accelerate without clearing the queue");
  const acceleratedIndex = context.sources.indexOf(accelerated);
  const following = context.sources[acceleratedIndex + 1];
  assert.ok(following);
  assert.ok(Math.abs(following.startedAt - (accelerated.startedAt + accelerated.buffer.duration / accelerated.playbackRate.value)) < 0.000001,
    "nextStart must use effective accelerated duration");
  assert.equal(context.sources.some((source) => source.stopped), false);
});

test("90.4 seconds of generated audio follows a 60-second input without a queue restart", async () => {
  const context = new FakeAudioContext();
  const restarts = [];
  const player = createSubtitleAudioPlayer({
    createAudioContext: () => context,
    onQueueRestart: (detail) => restarts.push(detail),
  });
  await player.resume();
  const generatedChunk = pcmBase64(new Array(3_616).fill(900));

  for (let tick = 0; tick < 600; tick += 1) {
    player.enqueue({ audio: generatedChunk, sampleRate: 24_000 });
    context.currentTime += 0.1;
    for (const source of context.sources) {
      const effectiveEnd = source.startedAt + source.buffer.duration / source.playbackRate.value;
      if (!source.ended && effectiveEnd <= context.currentTime) source.emitEnded();
    }
  }

  assert.equal(restarts.length, 0, "adaptive catch-up must preserve continuous speech below the hard safety boundary");
  const playbackTail = Math.max(...context.sources.filter((source) => !source.ended)
    .map((source) => source.startedAt + source.buffer.duration / source.playbackRate.value));
  assert.ok(playbackTail - context.currentTime < 10,
    "measured 1.507x generation pressure must remain below the critical backlog band");
  assert.equal(context.sources.some((source) => source.stopped), false);
});

test("excessive backlog clears only scheduled audio and immediately continues with the newest chunk", async () => {
  const restarts = [];
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({
    createAudioContext: () => context,
    maxQueueSeconds: 5,
    onQueueRestart: (detail) => restarts.push(detail),
  });

  await player.resume(0.8);
  const twoSeconds = pcmBase64(new Array(48_000).fill(1200));
  assert.equal(player.enqueue({ audio: twoSeconds, sampleRate: 24_000 }), true);
  assert.equal(player.enqueue({ audio: twoSeconds, sampleRate: 24_000 }), true);
  assert.equal(player.enqueue({ audio: twoSeconds, sampleRate: 24_000 }), true);
  assert.equal(restarts.length, 1);
  assert.equal(context.sources.length, 3);
  assert.equal(context.sources[0].stopped, true);
  assert.equal(context.sources[1].stopped, true);
  assert.equal(context.sources[2].stopped, false, "newest audio must start after an in-place queue restart");
  assert.equal(context.sources[2].startedAt, context.currentTime + 0.25);
  assert.equal(player.isFailed, false);
});

test("PCM memory cap counts PCM16 wire bytes rather than expanded Float32 playback bytes", async () => {
  const restarts = [];
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({
    createAudioContext: () => context,
    maxQueueSeconds: 30,
    maxQueuePcmBytes: 8,
    onQueueRestart: (detail) => restarts.push(detail),
  });

  await player.resume();
  assert.equal(player.enqueue({ audio: pcmBase64([1, 2]), sampleRate: 24_000 }), true);
  assert.equal(player.enqueue({ audio: pcmBase64([3, 4]), sampleRate: 24_000 }), true);
  assert.equal(restarts.length, 0, "four PCM16 samples use exactly eight queue bytes");
  assert.equal(player.enqueue({ audio: pcmBase64([5]), sampleRate: 24_000 }), true);
  assert.equal(restarts.length, 1);
  assert.equal(context.sources[0].stopped, true);
  assert.equal(context.sources[1].stopped, true);
  assert.equal(context.sources[2].stopped, false);
});

test("ended sources release their queue bytes instead of causing a false restart loop", async () => {
  const restarts = [];
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({
    createAudioContext: () => context,
    maxQueuePcmBytes: 4,
    onQueueRestart: (detail) => restarts.push(detail),
  });
  await player.resume();
  player.enqueue({ audio: pcmBase64([1, 2]), sampleRate: 24_000 });
  context.currentTime = 1;
  context.sources[0].emitEnded();
  assert.equal(player.enqueue({ audio: pcmBase64([3, 4]), sampleRate: 24_000 }), true);
  assert.equal(restarts.length, 0);
});

test("a fully drained queue applies the bounded startup lead again", async () => {
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({ createAudioContext: () => context });
  await player.resume();
  const audio = pcmBase64(new Array(6_000).fill(100));

  assert.equal(player.enqueue({ audio, sampleRate: 24_000 }), true);
  assert.equal(context.sources[0].startedAt, 0.5);
  context.currentTime = 0.75;
  context.sources[0].emitEnded();

  assert.equal(player.enqueue({ audio, sampleRate: 24_000 }), true);
  assert.equal(context.sources[1].startedAt, 1);
});

test("valid exact-zero PCM is ignored without creating a playback source", async () => {
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({ createAudioContext: () => context });
  await player.resume();

  assert.equal(player.enqueue({ audio: pcmBase64(new Array(6_000).fill(0)), sampleRate: 24_000 }), true);
  assert.equal(context.sources.length, 0);
  assert.equal(player.isInputSuppressionActive(), false);
});

test("clear cancels queued sources while preserving an enabled playback context", async () => {
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({ createAudioContext: () => context });
  await player.resume(0.7);
  player.enqueue({ audio: pcmBase64(new Array(1_000).fill(100)), sampleRate: 24_000 });
  player.clear();
  assert.equal(context.sources[0].stopped, true);
  assert.equal(player.enqueue({ audio: pcmBase64(new Array(1_000).fill(100)), sampleRate: 24_000 }), true);
  await player.resume(0.6);
  assert.equal(player.isFailed, false);
  await player.close();
  assert.equal(context.closeCalls, 1);
});

test("wrong sample rate is discarded in place while blocked AudioContext requires a new user gesture", async () => {
  const failures = [];
  const player = createSubtitleAudioPlayer({
    createAudioContext: () => {
      const context = new FakeAudioContext();
      context.resume = async () => { context.resumeCalls += 1; };
      return context;
    },
    onFailure: (error) => failures.push(error.message),
  });
  await assert.rejects(() => player.resume(0.8), /재생 권한/);
  assert.equal(player.isFailed, true);
  assert.match(failures[0], /재생 권한/);

  const rateFailures = [];
  const ratePlayer = createSubtitleAudioPlayer({ onFailure: (error) => rateFailures.push(error.message), createAudioContext: () => new FakeAudioContext() });
  await ratePlayer.resume(0.8);
  assert.equal(ratePlayer.enqueue({ audio: pcmBase64([1, 2]), sampleRate: 16_000 }), false);
  assert.equal(ratePlayer.isFailed, false);
  assert.equal(rateFailures.length, 1);
  assert.equal(ratePlayer.enqueue({ audio: pcmBase64([1, 2]), sampleRate: 24_000 }), true);
});

test("translated audio guard rejects replayed seq and identical resumption audio without growing forever", () => {
  let now = 1_000;
  const guard = createTranslatedAudioGuard({ maxEntries: 2, retentionMs: 5_000, now: () => now });
  const first = { seq: 10, source: "system", targetLanguage: "en", audio: pcmBase64([1, 2]) };
  assert.equal(guard.shouldAccept(first), true);
  assert.equal(guard.shouldAccept(first), false, "same sequence must never replay");
  assert.equal(guard.shouldAccept({ ...first, seq: 11 }), false, "resumption replay with a new seq must be fingerprinted");
  assert.equal(guard.shouldAccept({ ...first, seq: 12, audio: pcmBase64([3, 4]) }), true);
  assert.equal(guard.shouldAccept({ ...first, seq: 13, audio: pcmBase64([5, 6]) }), true);
  now += 5_001;
  assert.equal(guard.shouldAccept({ ...first, seq: 14 }), true, "bounded retention must eventually admit a legitimate repeat");
});

test("translated audio guard admits one frame under a hundred transport and resumption replays", () => {
  const guard = createTranslatedAudioGuard();
  const audio = pcmBase64([120, -120, 60, -60]);
  let acceptedAudio = 0;
  for (let index = 0; index < 100; index += 1) {
    if (guard.shouldAccept({
      streamId: "stream-replay",
      seq: index + 1,
      source: "system",
      targetLanguage: "ko",
      audio,
    })) acceptedAudio += 1;
  }
  assert.equal(acceptedAudio, 1, "a replayed PCM frame must be scheduled exactly once even when seq changes");

  let acceptedControls = 0;
  for (let index = 0; index < 100; index += 1) {
    if (guard.markControl({ streamId: "stream-control", seq: 1 })) acceptedControls += 1;
  }
  assert.equal(acceptedControls, 1, "a duplicated restart/clear control must run exactly once");
});

test("audio-control floor rejects stale frames while a new session resets the guard", () => {
  const guard = createTranslatedAudioGuard();
  assert.equal(guard.shouldAccept({ seq: 20, source: "system", targetLanguage: "ko", audio: pcmBase64([1]) }), true);
  guard.markControl({ seq: 24 });
  assert.equal(guard.shouldAccept({ seq: 23, source: "system", targetLanguage: "ko", audio: pcmBase64([2]) }), false);
  assert.equal(guard.shouldAccept({ seq: 25, source: "system", targetLanguage: "ko", audio: pcmBase64([2]) }), true);
  guard.reset();
  assert.equal(guard.shouldAccept({ seq: 1, source: "system", targetLanguage: "ko", audio: pcmBase64([1]) }), true);
});

test("stream rollover admits the first new frame, retires the old stream, and dedupes control clears", () => {
  const guard = createTranslatedAudioGuard();
  const audio = pcmBase64([1, 2]);
  assert.equal(guard.shouldAccept({ streamId: "stream-a", seq: 1, source: "system", targetLanguage: "en", audio }), true);
  assert.equal(guard.markControl({ streamId: "stream-b", seq: 1 }), true);
  assert.equal(guard.markControl({ streamId: "stream-b", seq: 1 }), false, "duplicate control must not clear playback twice");
  assert.equal(guard.shouldAccept({ streamId: "stream-b", seq: 2, source: "system", targetLanguage: "en", audio }), true,
    "new stream must reset the old fingerprint cache");
  assert.equal(guard.shouldAccept({ streamId: "stream-a", seq: 2, source: "system", targetLanguage: "en", audio: pcmBase64([3]) }), false,
    "late frames from the retired stream must not switch the guard backwards");
});

test("translated playback suppression covers physical echo tail and then resumes automatically", async () => {
  const context = new FakeAudioContext();
  const player = createSubtitleAudioPlayer({ createAudioContext: () => context });
  await player.resume();
  player.enqueue({ audio: pcmBase64(new Array(24_000).fill(100)), sampleRate: 24_000 });
  assert.equal(player.isInputSuppressionActive(), true);
  context.currentTime = 1.26;
  context.sources[0].emitEnded();
  context.currentTime = 1.9;
  assert.equal(player.isInputSuppressionActive(), true, "750ms tail prevents speaker echo returning through either input");
  context.currentTime = 2.26;
  assert.equal(player.isInputSuppressionActive(), false, "capture resumes instead of being suppressed forever");
});

test("translated playback gates system feedback but never pauses continuous microphone input", () => {
  for (const outputMode of ["audio", "captions_audio"]) {
    let systemSendCount = 0;
    let microphoneSendCount = 0;
    for (let index = 0; index < 100; index += 1) {
      if (!shouldGateTranslatedAudioInput(outputMode, true, "system")) systemSendCount += 1;
      if (!shouldGateTranslatedAudioInput(outputMode, true, "mic")) microphoneSendCount += 1;
    }
    assert.equal(systemSendCount, 0, `${outputMode} must gate system feedback during playback`);
    assert.equal(microphoneSendCount, 100, `${outputMode} must keep microphone translation continuous during playback`);
  }
  assert.equal(shouldGateTranslatedAudioInput("captions", true, "system"), false, "caption-only input must remain unaffected");
  assert.equal(shouldGateTranslatedAudioInput("captions_audio", false, "system"), false, "system input must resume after playback and tail end");
  assert.equal(shouldGateTranslatedAudioInput("audio", true), true, "unknown input sources must fail closed during playback");
});
