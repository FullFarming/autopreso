import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { CAPTION_AUDIO_SAMPLE_RATE, CAPTION_AUDIO_PROCESSOR_BUFFER_SIZE, createCaptionAudioChunker } from "../public/subtitle-audio-capture.js";

const dashboard = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
const streamerCode = dashboard.slice(dashboard.indexOf("async function createAudioStreamer"), dashboard.indexOf("async function ensureAudioContextRunning"));
const captureCode = dashboard.slice(dashboard.indexOf("function stopLiveCallAudioBridge"), dashboard.indexOf("function forwardLiveCallHostAudioPacket"));

function makeHarness({ resume = async () => {}, failSecondSource = false, captureReady = Promise.resolve() } = {}) {
  const contexts = [], packets = [], meters = [], diagnostics = [];
  const sources = ["system", "mic"].map((source, index) => {
    const track = { stopCount: 0, stop() { this.stopCount++; } };
    return { source, label: source, stream: { value: (index + 1) / 8, getTracks: () => [track], getAudioTracks: () => [track] } };
  });
  class AudioNode {
    connections = [];
    inputs = [];
    gain = { value: 1 };
    disconnected = false;
    onaudioprocess = null;
    channelCount = 2;
    channelCountMode = "max";
    channelInterpretation = "speakers";
    constructor(value = null) { this.value = value; }
    connect(node) { this.connections.push(node); node.inputs.push(this); }
    disconnect() { this.disconnected = true; }
    readSample() { return (this.value ?? this.inputs.reduce((sum, node) => sum + node.readSample(), 0)) * this.gain.value; }
  }
  class FakeAudioContext {
    sampleRate = 24_000;
    state = "suspended";
    closeCount = 0;
    sourceNodes = [];
    processors = [];
    nodes = [];
    destination = new AudioNode();
    constructor(options) { assert.equal(options.sampleRate, 24_000); contexts.push(this); }
    async resume() { await resume(); if (this.state !== "closed") this.state = "running"; }
    async close() { this.closeCount++; this.state = "closed"; }
    createMediaStreamSource(stream) {
      if (failSecondSource && this.sourceNodes.length === 1) throw new Error("source setup failed");
      const node = new AudioNode(stream.value); this.sourceNodes.push(node); this.nodes.push(node); return node;
    }
    createScriptProcessor(size, input, output) {
      assert.deepEqual([size, input, output], [1_024, 1, 1]);
      const node = new AudioNode(); this.processors.push(node); this.nodes.push(node); return node;
    }
    createAnalyser() { const node = new AudioNode(); this.nodes.push(node); return node; }
    createGain() { const node = new AudioNode(); this.nodes.push(node); return node; }
    addEventListener() {}
    removeEventListener() {}
    render(samples = 2_400) {
      if (this.state !== "running") return;
      for (const node of this.processors) node.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(samples).fill(node.readSample()) } });
    }
  }
  const sandbox = {
    AudioContext: FakeAudioContext, AbortController, DOMException, createCaptionAudioChunker,
    CAPTION_AUDIO_SAMPLE_RATE, CAPTION_AUDIO_PROCESSOR_BUFFER_SIZE,
    ensureAudioContextRunning: async context => { await context.resume(); if (context.state !== "running") throw new Error("context not running"); },
    startAudioLevelMeter: (name, _label, analyser) => { const entry = { name, analyser, closed: false }; meters.push(entry); return { close() { entry.closed = true; } }; },
    watchAudioTrackState: (_media, name) => { const entry = { name, closed: false }; diagnostics.push(entry); return () => { entry.closed = true; }; },
    state: { settings: { inputMode: "system_mic" } },
    readSettingsFromForm: () => ({ inputMode: "system_mic" }),
    captureSelectedAudio: async () => { await captureReady; return sources; },
    stopMediaStream: media => media.getTracks().forEach(track => track.stop()),
    liveTranslationStallMonitor: { suspend() {} },
    forwardLiveCallHostAudioPacket: (packet, capture, source) => { if (sandbox.currentCapture() === capture) packets.push({ ...packet, source }); },
    setAudioSourceStatus() {}, t: key => key, console: { info() {}, warn() {} },
    currentCapture: () => null,
  };
  vm.createContext(sandbox);
  const api = vm.runInContext(`let liveBridgeCapture = null; let liveBridgeCaptureStartPromise = null; ${streamerCode}\n${captureCode}\n({startLiveCallMicCapture, stopLiveCallAudioBridge, createAudioStreamer, getCapture: () => liveBridgeCapture})`, sandbox);
  sandbox.currentCapture = api.getCapture;
  return { api, contexts, sources, packets, meters, diagnostics };
}

test("Live Call system+mic mixes simultaneous samples into one 24kHz/100ms mic wire frame", async () => {
  const h = makeHarness();
  assert.equal((await h.api.startLiveCallMicCapture()).ok, true);
  assert.equal(h.contexts.length, 1, "two capture devices must share one audio clock");
  assert.equal(h.contexts[0].processors.length, 1);
  h.contexts[0].render();
  assert.equal(h.packets.length, 1, "100ms of two inputs must not become 200ms on the gateway wire");
  const packet = h.packets[0];
  assert.equal(packet.source, "mic");
  assert.equal(packet.sampleRate, 24_000);
  assert.equal(packet.frameDurationMs, 100);
  assert.equal(packet.pcm.byteLength, 4_800);
  assert.equal(new Int16Array(packet.pcm)[0], Math.trunc(0.375 * 0x7fff), "both simultaneous sources contribute to the same sample");
  assert.equal(h.contexts[0].destination.readSample(), 0, "captured audio must not play back into system capture");
  assert.deepEqual(h.meters.map(entry => entry.name), ["system", "mic"]);
  assert.deepEqual(h.diagnostics.map(entry => entry.name), ["system", "mic"]);
  h.api.stopLiveCallAudioBridge();
});

test("Live Call close clears partial PCM, all nodes/meters/tracks, and ignores late processor callbacks", async () => {
  const h = makeHarness();
  await h.api.startLiveCallMicCapture();
  const context = h.contexts[0];
  context.render(1_200);
  const callback = context.processors[0].onaudioprocess;
  h.api.stopLiveCallAudioBridge();
  h.api.stopLiveCallAudioBridge();
  await Promise.resolve();
  callback?.({ inputBuffer: { getChannelData: () => new Float32Array(2_400).fill(0.5) } });
  assert.equal(h.packets.length, 0);
  assert.equal(context.closeCount, 1);
  assert.ok(context.nodes.every(node => node.disconnected));
  assert.ok(h.meters.every(entry => entry.closed));
  assert.ok(h.diagnostics.every(entry => entry.closed));
  assert.ok(h.sources.every(source => source.stream.getTracks()[0].stopCount === 1));
});

test("Live Call cancellation during AudioContext resume closes it before the pending resume settles", async () => {
  let resolveResume = () => {};
  const h = makeHarness({ resume: () => new Promise(resolve => { resolveResume = resolve; }) });
  const pending = h.api.startLiveCallMicCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.contexts.length, 1);
  h.api.stopLiveCallAudioBridge();
  await Promise.resolve();
  assert.equal(h.contexts[0].closeCount, 1, "cancel must release the context even if resume is unresolved");
  resolveResume();
  assert.equal((await pending).ok, false);
  assert.equal(h.contexts[0].sourceNodes.length, 0);
  assert.equal(h.packets.length, 0);
});

test("Live Call partially constructed mixed graph releases the context, first source, and both tracks", async () => {
  const h = makeHarness({ failSecondSource: true });
  const result = await h.api.startLiveCallMicCapture();
  assert.equal(result.ok, false);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].closeCount, 1);
  assert.ok(h.contexts[0].nodes.every(node => node.disconnected));
  assert.ok(h.sources.every(source => source.stream.getTracks()[0].stopCount === 1));
  assert.ok(h.meters.every(entry => entry.closed));
  assert.ok(h.diagnostics.every(entry => entry.closed));
});

test("Caption Only keeps independent input labels and one unchanged clock per capture", async () => {
  const h = makeHarness();
  const streamers = [];
  for (const source of h.sources) streamers.push(await h.api.createAudioStreamer(source.stream, source.source, source.label, packet => h.packets.push(packet)));
  assert.equal(h.contexts.length, 2);
  h.contexts.forEach(context => context.render());
  assert.deepEqual(h.packets.map(packet => packet.source), ["system", "mic"]);
  assert.deepEqual(h.packets.map(packet => new Int16Array(packet.pcm)[0]), [Math.trunc(0.125 * 0x7fff), Math.trunc(0.25 * 0x7fff)]);
  await Promise.all(streamers.map(streamer => streamer.close()));
});

test("Live Call keeps a lone input at full gain and clamps simultaneous loud samples without extra frames", async () => {
  const h = makeHarness();
  h.sources[0].stream.value = 0;
  h.sources[1].stream.value = 0.25;
  await h.api.startLiveCallMicCapture();
  const context = h.contexts[0];
  context.render();
  assert.equal(new Int16Array(h.packets[0].pcm)[0], Math.trunc(0.25 * 0x7fff));
  context.sourceNodes.forEach(node => { node.value = 0.75; });
  for (let index = 0; index < 50; index++) context.render();
  assert.equal(h.packets.length, 51);
  assert.ok(h.packets.slice(1).every(packet => new Int16Array(packet.pcm)[0] === 0x7fff));
  h.api.stopLiveCallAudioBridge();
});

test("Live Call single system input still uses one mic wire label and keeps the system meter", async () => {
  const h = makeHarness();
  h.sources.pop();
  await h.api.startLiveCallMicCapture();
  h.contexts[0].render();
  assert.equal(h.packets.length, 1);
  assert.equal(h.packets[0].source, "mic");
  assert.equal(new Int16Array(h.packets[0].pcm)[0], Math.trunc(0.125 * 0x7fff));
  assert.deepEqual(h.meters.map(entry => entry.name), ["system"]);
  h.api.stopLiveCallAudioBridge();
});

test("Live Call rejects more than two or duplicate inputs before opening an audio context", async () => {
  const h = makeHarness();
  await assert.rejects(h.api.createAudioStreamer([...h.sources, h.sources[0]], "mic", "", () => {}), /INVALID_LIVE_AUDIO_INPUTS/);
  await assert.rejects(h.api.createAudioStreamer([h.sources[0], h.sources[0]], "mic", "", () => {}), /INVALID_LIVE_AUDIO_INPUTS/);
  assert.equal(h.contexts.length, 0);
});

test("Live Call failed context resume cleans acquired tracks and closes the context without retry", async () => {
  const h = makeHarness({ resume: async () => { throw new Error("resume blocked"); } });
  assert.equal((await h.api.startLiveCallMicCapture()).ok, false);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].closeCount, 1);
  assert.ok(h.sources.every(source => source.stream.getTracks()[0].stopCount === 1));
});

test("Live Call duplicate start shares capture and cancellation releases late capture devices", async () => {
  let resolveCapture = () => {};
  const h = makeHarness({ captureReady: new Promise(resolve => { resolveCapture = resolve; }) });
  const first = h.api.startLiveCallMicCapture();
  const second = h.api.startLiveCallMicCapture();
  h.api.stopLiveCallAudioBridge();
  resolveCapture();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.cancelled));
  assert.equal(h.contexts.length, 0);
  assert.ok(h.sources.every(source => source.stream.getTracks()[0].stopCount === 1));
});

test("Live Call hybrid start, socket recovery and reconfigure use the mixed mic lane without changing saved input settings", async () => {
  const startCode = dashboard.slice(dashboard.indexOf("function requestSubtitleStart(payload)"), dashboard.indexOf("async function handleSubtitleRuntimeError"));
  const sent = [], listeners = new Map();
  const socket = {
    readyState: 1,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    send(serialized) {
      const message = JSON.parse(serialized); sent.push(message);
      queueMicrotask(() => listeners.get("message")?.({ data: JSON.stringify({ type: "subtitle:started", sessionId: message.sessionId,
        captionProducer: ["hybrid", "gateway"].includes(message.captionProducer) ? message.captionProducer : "local" }) }));
    },
  };
  const start = vm.runInNewContext(`${startCode}; requestSubtitleStart`, {
    state: { ws: socket }, WebSocket: { OPEN: 1 }, window: { setTimeout: () => 1, clearTimeout() {} },
    SUBTITLE_START_ACK_TIMEOUT_MS: 10_000, t: key => key,
  });
  const saved = Object.freeze({ inputMode: "system", translationLanguages: ["en", "ko"] });
  for (const captionProducer of ["hybrid", "hybrid", "local"]) {
    await start(Object.freeze({ type: "subtitle:start", sessionId: "live-1", captionProducer, settings: saved,
      meeting: { kind: "live-call", liveSessionId: "call-1" } }));
  }
  assert.ok(sent.every(message => message.settings.inputMode === "mic"));
  assert.equal(saved.inputMode, "system");
  await start({ type: "subtitle:start", sessionId: "live-1", captionProducer: "gateway", settings: saved,
    meeting: { kind: "live-call", liveSessionId: "call-1" } });
  await start({ type: "subtitle:start", sessionId: "local-1", settings: saved, meeting: { kind: "local" } });
  assert.deepEqual(sent.slice(3).map(message => message.settings.inputMode), ["system", "system"]);
});
