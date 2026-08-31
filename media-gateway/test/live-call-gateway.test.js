import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { AUDIO_CONFIG } from "../src/config.js";
import { createGatewayServer } from "../src/gateway-server.js";
import { evaluateCaptionPolish, LiveMediaPipeline } from "../src/live-media-pipeline.js";
import { SupabaseLivePublisher } from "../src/supabase-adapters.js";

const INPUT_FRAME_BYTES = AUDIO_CONFIG.inputSampleRate * 2 * AUDIO_CONFIG.chunkMilliseconds / 1_000;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_TWO_ID = "11111111-1111-4111-8111-111111111112";

function fixtureUuid(seed) {
  const digest = createHmac("sha256", "fixture-uuid").update(seed).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function signHostToken(secret, { now = Date.now(), expiresInSeconds = 900, sessionId = SESSION_ID } = {}) {
  const nowSeconds = Math.floor(now / 1_000);
  const claims = { role: "HOST", sub: "host-1", sessionId, aud: "media-gateway", iat: nowSeconds, exp: nowSeconds + expiresInSeconds };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

function signViewerToken(secret, grantId, { now = Date.now(), expiresInMilliseconds = 60_000, sessionId = SESSION_ID } = {}) {
  const nowSeconds = Math.floor(now / 1_000);
  const claims = {
    role: "VIEWER",
    sub: fixtureUuid(`viewer-${grantId}`),
    grantId: fixtureUuid(`grant-${grantId}`),
    sessionId,
    aud: "live-gateway-viewer",
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + Math.ceil(expiresInMilliseconds / 1_000),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

async function nextJson(webSocket) {
  const [data] = await once(webSocket, "message");
  return JSON.parse(data.toString("utf8"));
}

async function waitForJson(webSocket, predicate) {
  while (true) {
    const message = await nextJson(webSocket);
    if (predicate(message)) return message;
  }
}

function bufferJson(webSocket) {
  const queue = [];
  const waiters = [];
  webSocket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  return async function next(predicate) {
    while (true) {
      const message = queue.length > 0 ? queue.shift() : await new Promise((resolve) => waiters.push(resolve));
      if (predicate(message)) return message;
    }
  };
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition never became true: ${condition}`);
}

async function within(promise, label, milliseconds = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const START_MESSAGE = {
  type: "start",
  sessionId: SESSION_ID,
  sessionType: "meeting",
  outputMode: "captions_audio",
  version: 1,
  languages: ["ko", "en"],
};

function createLiveGateway({ gatewayOptions = {}, pipelineHooks = {} } = {}) {
  const pipelines = [];
  const timers = [];
  const gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cancelled = true; },
    ...gatewayOptions,
    async pipelineFactory(settings) {
      const pipeline = {
        settings,
        closed: 0,
        paused: 0,
        resumed: 0,
        topicsCompleted: 0,
        frames: [],
        floorSpeakers: [],
        async start() {},
        async tick() {},
        async acceptAudio(frame) { this.frames.push(frame); },
        setFloorSpeaker(speaker) { this.floorSpeakers.push(speaker); },
        pause() { this.paused += 1; },
        resume() { this.resumed += 1; },
        async endAudioStream() {},
        async completeTopicsOnSessionEnd() { this.topicsCompleted += 1; },
        async close() { this.closed += 1; },
        ...pipelineHooks,
      };
      pipelines.push(pipeline);
      return pipeline;
    },
  });
  return { gateway, pipelines, timers };
}

function createSelectivePolishHarness() {
  const events = [];
  const observations = [];
  const polishCalls = [];
  let captionSession;
  let sourceSeq = 0;
  let clock = 0;
  const pipeline = new LiveMediaPipeline({
    sessionId: "selective-polish-session",
    sessionType: "meeting",
    outputMode: "captions",
    languages: ["ko"],
    translationTone: "business",
    domainText: "Commercial real estate",
    captionPolishPolicy: "selective",
    now: () => clock,
    observeLatency: (name, value) => observations.push([name, value]),
    dependencies: {
      speechToText: {
        async open(options) {
          captionSession = {
            ...options,
            async sendAudio() {},
            async close() {},
            async getFinalWords() { return []; },
          };
          return captionSession;
        },
      },
      textTranslate: { async translate() { return "일반 번역 문장입니다."; } },
      captionPolish: {
        async polish(input) {
          polishCalls.push(input);
          clock += 500;
          return input.translatedText;
        },
      },
      publisher: {
        async markLive() {},
        async persistAuthoritativeSource() {
          sourceSeq += 1;
          return {
            sourceUtteranceId: `00000000-0000-4000-8000-${String(sourceSeq).padStart(12, "0")}`,
            sourceSeq,
            idempotent: false,
          };
        },
        async publish(_sessionId, _language, event, { onLiveEvent } = {}) {
          await onLiveEvent?.(event);
          events.push(event);
        },
      },
    },
  });
  return { pipeline, events, observations, polishCalls, get captionSession() { return captionSession; } };
}

async function connectHost(port, startMessage = START_MESSAGE) {
  const host = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(host, "open");
  const next = bufferJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret") }));
  assert.equal((await next((message) => message.type === "authenticated")).type, "authenticated");
  host.send(JSON.stringify(startMessage));
  assert.equal((await next((message) => message.type === "started")).type, "started");
  host.initialFloorSnapshot = await next((message) => message.type === "floor");
  assert.equal(host.initialFloorSnapshot.sessionId, SESSION_ID);
  assert.equal(Object.hasOwn(host.initialFloorSnapshot, "holder"), true);
  return host;
}

async function authenticateHost(port, sessionId = SESSION_ID) {
  const host = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(host, "open");
  const received = nextJson(host);
  host.send(JSON.stringify({ type: "authenticate", token: signHostToken("gateway-secret", { sessionId }) }));
  assert.equal((await received).type, "authenticated");
  return host;
}

async function authenticateViewer(port, grantId, { sessionId = SESSION_ID } = {}) {
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(viewer, "open");
  const received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", grantId, { sessionId }) }));
  assert.equal((await received).type, "authenticated");
  return viewer;
}

async function joinViewer(port, grantId, { language = "ko", lastSeq, sessionId = SESSION_ID } = {}) {
  const viewer = await authenticateViewer(port, grantId, { sessionId });
  const received = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId, language, ...(lastSeq === undefined ? {} : { lastSeq }) }));
  assert.equal((await received).type, "subscribed");
  return viewer;
}

test("selective policy polishes evidence-backed risks and skips ordinary configured context", () => {
  assert.deepEqual(evaluateCaptionPolish("selective", {
    text: "일반 번역 문장입니다.",
    sourceText: "This is an ordinary translated sentence.",
    targetLanguage: "ko",
    tone: "business",
    domain: "Commercial real estate",
  }), { shouldPolish: false, reason: "ordinary" });
  assert.deepEqual(evaluateCaptionPolish("selective", {
    text: "…", sourceText: "This sentence has enough content.", targetLanguage: "ko",
  }), { shouldPolish: true, reason: "placeholder" });
  assert.deepEqual(evaluateCaptionPolish("selective", {
    text: "3,000억 원", sourceText: "3,000억 원", targetLanguage: "en",
  }), { shouldPolish: false, reason: "ordinary" });
  assert.deepEqual(evaluateCaptionPolish("selective", {
    text: "A new hotel opened.",
    sourceText: "Hilton opened a new hotel.",
    targetLanguage: "en",
    hasUnresolvedTerm: true,
  }), { shouldPolish: true, reason: "term_unresolved" });
  assert.deepEqual(evaluateCaptionPolish("selective", {
    text: "�", sourceText: "This translation was corrupted.", targetLanguage: "en",
  }), { shouldPolish: true, reason: "translation_anomaly" });
});

test("ordinary business captions skip selective provider polish and publish immediately", async () => {
  const harness = createSelectivePolishHarness();
  await harness.pipeline.start();
  await harness.captionSession.onFinalUtterance({
    speakerLabel: "1",
    text: "This is an ordinary translated sentence.",
    sourceLanguage: "en-US",
    sourceEndedAt: "2026-08-27T00:00:00.000Z",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.polishCalls.length, 0);
  assert.equal(harness.events.find((event) => event.type === "caption" && event.isFinal)?.text, "일반 번역 문장입니다.");
  assert.deepEqual(harness.observations.find(([name]) => name === "caption_publish_latency_ms"), ["caption_publish_latency_ms", 0]);
  await harness.pipeline.close();
});

test("one WebSocket meeting keeps host, viewer, and replay captions in parity", async (context) => {
  const persisted = [];
  let releaseReplay;
  const replayGate = new Promise((resolve) => { releaseReplay = resolve; });
  let gateway;
  const publisher = new SupabaseLivePublisher({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "secret",
    snapshotGuardTimeoutMilliseconds: 50,
    async eventFanout(sessionId, language, event) {
      await gateway.broadcastEvent(sessionId, language, event);
    },
    async audioFanout() {},
    async fetchFn(url, init) {
      if (String(url).includes("persist_live_final_caption_if_active")) {
        persisted.push(JSON.parse(String(init.body)).p_event);
      }
      return Response.json(true);
    },
  });
  gateway = createGatewayServer({
    gatewaySecret: "gateway-secret",
    viewerSecret: "viewer-secret",
    viewerAuthorizer: { async authorize() { return true; }, async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); } },
    hostAuthorizer: { async authorize() { return true; } },
    async replayUtterances(_sessionId, _language, afterSeq, limit) {
      await replayGate;
      return persisted.filter((caption) => caption.seq > afterSeq).slice(0, limit);
    },
    async pipelineFactory(settings, _previous, onHostEvent) {
      let sequence = 0;
      return {
        async start() {},
        async tick() {},
        async acceptAudio() {
          const caption = {
            type: "caption",
            seq: ++sequence,
            sessionId: settings.sessionId,
            language: "ko",
            speaker: null,
            text: "같은 문장",
            isFinal: true,
            sourceEndedAt: "2026-07-26T00:00:00.000Z",
            emittedAt: "2026-07-26T00:00:00.100Z",
          };
          await publisher.publish(settings.sessionId, "ko", caption, { onLiveEvent: onHostEvent });
        },
        async endAudioStream() {},
        async close() {},
      };
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await connectHost(port, { ...START_MESSAGE, outputMode: "captions", languages: ["ko"] });
  const viewer = await joinViewer(port, "grant-speaker", { language: "ko" });
  context.after(() => host.terminate());
  context.after(() => viewer.terminate());
  const nextHost = bufferJson(host);
  const nextViewer = bufferJson(viewer);

  const hostFirst = nextHost((message) => message.type === "caption" && message.seq === 1);
  const viewerFirst = nextViewer((message) => message.type === "live-event" && message.payload.type === "caption" && message.payload.seq === 1);
  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  assert.equal((await within(hostFirst, "host first caption")).text, "같은 문장");
  assert.equal((await within(viewerFirst, "viewer first caption")).payload.text, "같은 문장");

  const hostAgain = nextHost((message) => message.type === "caption" && message.seq === 2);
  const viewerAgain = nextViewer((message) => message.type === "live-event" && message.payload.type === "caption" && message.payload.seq === 2);
  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  assert.equal((await within(hostAgain, "host second caption")).speaker, null);
  assert.equal((await within(viewerAgain, "viewer second caption")).payload.speaker, null);
  assert.deepEqual(persisted.map((caption) => [caption.seq, caption.text]), [
    [1, "같은 문장"], [2, "같은 문장"],
  ]);

  const replayViewer = await joinViewer(port, "grant-replay", { language: "ko", lastSeq: 0 });
  context.after(() => replayViewer.terminate());
  const nextReplay = bufferJson(replayViewer);
  releaseReplay();
  const replayed = [];
  for (let seq = 1; seq <= 2; seq += 1) {
    replayed.push(await within(
      nextReplay((message) => message.type === "live-event" && message.payload.type === "caption" && message.payload.seq === seq),
      `replay caption ${seq}`,
    ));
  }
  assert.deepEqual(replayed.map((message) => [message.payload.seq, message.payload.text, message.payload.replay]), [
    [1, "같은 문장", true], [2, "같은 문장", true],
  ]);
});

test("a hung caption replay cannot grow the live-event buffer without bound", async (context) => {
  // The replay never resolves, so the buffer would previously accumulate every
  // live event for the rest of the session.
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      async replayUtterances() { await new Promise(() => {}); return []; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const viewer = await joinViewer(port, "grant-overflow", { lastSeq: 0 });
  context.after(() => viewer.terminate());
  const received = [];
  viewer.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.type === "live-event") received.push(message.payload);
  });

  for (let seq = 1; seq <= 620; seq += 1) {
    await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq, text: `line ${seq}`, isFinal: true });
  }
  await waitFor(() => received.length > 0);

  // Once the cap is passed the viewer starts receiving live events directly
  // instead of them piling up behind a replay that will never finish.
  assert.ok(received.length >= 100, `overflow must fall through to live delivery, got ${received.length}`);
  assert.match(gateway.metrics.render(), /replay_buffer_overflow_total/u);
});

test("a newer subscription aborts a hung replay and fences its stale closure", async (context) => {
  const signals = [];
  let calls = 0;
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      async replayUtterances(_sessionId, language, _afterSeq, _limit, { signal }) {
        signals.push(signal);
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return [{ type: "caption", seq: 1, text: `${language} replay`, isFinal: true }];
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const viewer = await joinViewer(gateway.server.address().port, "grant-resubscribe", { lastSeq: 0 });
  context.after(() => viewer.terminate());
  await waitFor(() => signals.length === 1);
  const next = bufferJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "en", lastSeq: 0 }));
  await next((message) => message.type === "subscribed" && message.language === "en");
  const replay = await next((message) => message.type === "live-event");
  assert.equal(signals[0].aborted, true);
  assert.equal(replay.payload.language ?? "en", "en");
  assert.equal(replay.payload.text, "en replay");
});

test("caption replay timeout fails visibly instead of skipping buffered history", async (context) => {
  const { gateway, timers } = createLiveGateway({
    gatewayOptions: {
      replayTimeoutMilliseconds: 123,
      async replayUtterances() { return new Promise(() => {}); },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const viewer = await joinViewer(gateway.server.address().port, "grant-timeout", { lastSeq: 0 });
  context.after(() => viewer.terminate());
  const next = bufferJson(viewer);
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 1, text: "buffered", isFinal: true });
  await waitFor(() => timers.some((timer) => timer.delay === 123));
  timers.find((timer) => timer.delay === 123).callback();
  const error = await next((message) => message.type === "error");
  assert.equal(error.code, "REPLAY_FAILED");
  assert.match(gateway.metrics.render(), /caption_replay_timeouts_total 1/u);
});

test("a large replay keyset-pages to the live edge without a 200-caption gap", async (context) => {
  let releaseFirstPage;
  const firstPageGate = new Promise((resolve) => { releaseFirstPage = resolve; });
  const calls = [];
  let serializations = 0;
  let slowConsumerChecks = 0;
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      serializeJson(value) { serializations += 1; return JSON.stringify(value); },
      slowConsumerPredicate() { slowConsumerChecks += 1; return false; },
      async replayUtterances(_sessionId, language, afterSeq, limit) {
        calls.push(afterSeq);
        if (calls.length === 1) await firstPageGate;
        const end = Math.min(450, afterSeq + limit);
        return Array.from({ length: Math.max(0, end - afterSeq) }, (_, index) => ({
          type: "caption", seq: afterSeq + index + 1, language,
          text: `line ${afterSeq + index + 1}`, isFinal: true,
        }));
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const viewer = await joinViewer(gateway.server.address().port, "grant-paged", { lastSeq: 0 });
  context.after(() => viewer.terminate());
  const received = [];
  viewer.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.type === "live-event") received.push(message.payload.seq);
  });
  releaseFirstPage();
  await waitFor(() => received.length === 450);
  assert.deepEqual(calls, [0, 200, 400]);
  assert.deepEqual(received, Array.from({ length: 450 }, (_, index) => index + 1));
  assert.equal(serializations, 450, "each replay event is serialized exactly once");
  assert.equal(slowConsumerChecks, 450, "every replay event crosses the JSON backpressure boundary");
});

test("a slow reconnecting viewer drops replay partials then closes on the first durable event without paging ahead", async (context) => {
  let releaseFirstPage;
  const firstPageGate = new Promise((resolve) => { releaseFirstPage = resolve; });
  let replayCalls = 0;
  let serializations = 0;
  let slowConsumerChecks = 0;
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      serializeJson(value) { serializations += 1; return JSON.stringify(value); },
      slowConsumerPredicate() { slowConsumerChecks += 1; return true; },
      async replayUtterances(_sessionId, language, afterSeq, limit) {
        replayCalls += 1;
        if (replayCalls === 1) await firstPageGate;
        return Array.from({ length: limit }, (_value, index) => ({
          type: "caption",
          seq: afterSeq + index + 1,
          language,
          text: `line ${afterSeq + index + 1}`,
          isFinal: index !== 0,
        }));
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const viewer = await joinViewer(gateway.server.address().port, "grant-slow-replay", { lastSeq: 0 });
  context.after(() => viewer.terminate());
  const next = bufferJson(viewer);

  releaseFirstPage();
  const terminal = await within(next((message) => message.type === "error"
    || (message.type === "live-event" && message.payload.seq === 200)), "slow replay terminal event");

  assert.equal(terminal.type, "error");
  assert.equal(terminal.code, "SLOW_CONSUMER");
  assert.equal(replayCalls, 1, "a closed viewer must not start another replay page");
  assert.equal(serializations, 2, "the partial and first durable event are each serialized once");
  assert.equal(slowConsumerChecks, 2);
  assert.match(gateway.metrics.render(), /json_partials_dropped_total 1/u);
  assert.match(gateway.metrics.render(), /slow_consumers_terminated_total 1/u);
});

test("a viewer can subscribe to the four-letter script subtags the host UI offers", async (context) => {
  // zh-Hans / zh-Hant are in the language registry and are selectable in the
  // host dashboard, so the subscribe validator must admit a 4-letter subtag.
  const { gateway } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  for (const language of ["zh-Hans", "zh-Hant"]) {
    const viewer = await joinViewer(port, `grant-${language}`, { language });
    context.after(() => viewer.terminate());
    assert.equal(gateway.subscriberCount(SESSION_ID, language), 1, `${language} must have a live topic`);
  }
});

test("a viewer cannot subscribe to a language outside the registry", async (context) => {
  const { gateway } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  for (const language of ["zh-Hanx", "e", "toolongsubtag", "ko-KOREA", "../ko", "ko;en"]) {
    const viewer = new WebSocket(`ws://127.0.0.1:${port}/live`);
    await once(viewer, "open");
    context.after(() => viewer.terminate());
    let received = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "authenticate", token: signViewerToken("viewer-secret", `grant-bad-${language}`) }));
    assert.equal((await received).type, "authenticated");
    received = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language }));
    const reply = await received;
    assert.equal(reply.type, "error", `${language} must be rejected`);
    assert.equal(gateway.subscriberCount(SESSION_ID, language), 0);
  }
});

test("a reconnecting viewer replays exactly the missed captions before live events, without duplicates", async (context) => {
  let releaseReplay;
  const replayGate = new Promise((resolve) => { releaseReplay = resolve; });
  const replayCalls = [];
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      async replayUtterances(sessionId, language, afterSeq, limit) {
        replayCalls.push([sessionId, language, afterSeq, limit]);
        await replayGate;
        return [
          { type: "caption", seq: 3, sessionId, language, text: "셋", isFinal: true },
          { type: "caption", seq: 4, sessionId, language, text: "넷", isFinal: true },
        ];
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const viewer = await joinViewer(port, "grant-replay", { lastSeq: 2 });
  context.after(() => viewer.terminate());
  const received = [];
  viewer.on("message", (data) => received.push(JSON.parse(data.toString("utf8"))));

  // Live events arriving while the replay is still fetching are queued: seq 4
  // duplicates a replayed row and must be dropped; seq 5 must follow.
  assert.equal(gateway.subscriberCount(SESSION_ID, "ko"), 1);
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 4, text: "라이브 중복", isFinal: true });
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 5, text: "다섯", isFinal: true });
  releaseReplay();
  await waitFor(() => received.length >= 3);

  assert.deepEqual(replayCalls, [[SESSION_ID, "ko", 2, 200]]);
  assert.deepEqual(received.map((message) => [message.payload.seq, message.payload.text, message.payload.replay ?? false]), [
    [3, "셋", true],
    [4, "넷", true],
    [5, "다섯", false],
  ]);
});

test("a reconnecting viewer with no gap receives no replay duplicates", async (context) => {
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      async replayUtterances() { return []; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const viewer = await joinViewer(port, "grant-nogap", { lastSeq: 9 });
  context.after(() => viewer.terminate());

  const live = nextJson(viewer);
  await gateway.broadcastEvent(SESSION_ID, "ko", { type: "caption", seq: 10, text: "이어서", isFinal: true });
  const message = await live;
  assert.equal(message.payload.seq, 10);
  assert.equal(message.payload.replay, undefined);
});

test("host disconnect keeps the pipeline and caption viewer for the grace window and reattaches", async (context) => {
  const { gateway, pipelines, timers } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 45_000,
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await connectHost(port);
  const viewer = await joinViewer(port, "grant-viewer");
  context.after(() => viewer.terminate());

  host.close();
  await once(host, "close");
  await waitFor(() => timers.some((timer) => timer.delay === 45_000 && !timer.cancelled));

  // During grace: pipeline and the receive-only caption viewer stay alive.
  assert.equal(pipelines[0].closed, 0);
  assert.equal(viewer.readyState, WebSocket.OPEN);

  // Same host reconnects with the same session settings: reattach, no new pipeline.
  const reconnected = await connectHost(port);
  context.after(() => reconnected.terminate());
  assert.equal(reconnected.initialFloorSnapshot.holder, null);
  assert.equal(pipelines.length, 1, "reattach must not build a fresh pipeline");
  assert.equal(pipelines[0].closed, 0);
  const graceTimer = timers.find((timer) => timer.delay === 45_000);
  assert.equal(graceTimer.cancelled, true, "reattach cancels the grace expiry");

  // The replacement HOST remains the only media ingress into the same pipeline.
  reconnected.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await waitFor(() => pipelines[0].frames.length === 1);

  const ended = nextJson(reconnected);
  reconnected.send(JSON.stringify({ type: "audioStreamEnd" }));
  assert.equal((await ended).type, "audio-stream-ended");
});

test("authenticated host detach immediately releases providers but preserves viewers and durable topic state", async (context) => {
  const releasedSessions = [];
  const { gateway, pipelines, timers } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 45_000,
      async releaseGeminiSession(sessionId) { releasedSessions.push(sessionId); },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const port = gateway.server.address().port;
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const viewer = await joinViewer(port, "detach-viewer");
  context.after(() => viewer.terminate());
  const viewerEvents = [];
  viewer.on("message", (data) => viewerEvents.push(JSON.parse(data.toString())));
  const hostClosed = once(host, "close");
  host.send(JSON.stringify({ type: "detach" }));
  assert.equal((await within(hostClosed, "host detach"))[0], 1000);
  await waitFor(() => pipelines[0].closed === 1);
  assert.equal(pipelines[0].topicsCompleted, 0);
  assert.deepEqual(releasedSessions, [SESSION_ID]);
  assert.equal(viewer.readyState, WebSocket.OPEN);
  assert.equal(gateway.subscriberCount(SESSION_ID, "ko"), 1);
  assert.equal(timers.some((timer) => timer.delay === 45_000 && !timer.cancelled), false);
  await waitFor(() => viewerEvents.some((event) => event.payload?.type === "floor" && event.payload.holder === null));
  assert.equal(viewerEvents.some((event) => event.payload?.status === "stopped"), false);
  const reconnected = await connectHost(port);
  context.after(() => reconnected.terminate());
  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[0].closed, 1);
  reconnected.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await waitFor(() => pipelines[1].frames.length === 1);
});

test("a new host cannot start providers until detached provider cleanup finishes", async (context) => {
  let finishClose;
  let isClosing = false;
  const closeGate = new Promise((resolve) => { finishClose = resolve; });
  const { gateway, pipelines } = createLiveGateway({
    pipelineHooks: { async close() { this.closed += 1; isClosing = true; await closeGate; } },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { finishClose(); await gateway.close(); });
  const port = gateway.server.address().port;
  const host = await connectHost(port);
  context.after(() => host.terminate());
  host.send(JSON.stringify({ type: "detach" }));
  await waitFor(() => isClosing);
  const reconnecting = connectHost(port);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pipelines.length, 1);
  finishClose();
  const replacement = await within(reconnecting, "reattach after detach drain");
  context.after(() => replacement.terminate());
  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[0].closed, 1);
});

test("detach followed immediately by socket close releases the active floor only once without ending viewers", async (context) => {
  const floorReleases = [];
  const releasedSessions = [];
  const { gateway, pipelines } = createLiveGateway({
    gatewayOptions: {
      viewerAuthorizer: {
        async authorize() { return true; },
        async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, true])); },
        async authorizeSpeaking() { return true; },
      },
      floorController: {
        async take() { return { ok: true, displayName: "Participant" }; },
        async release(...args) { floorReleases.push(args); return true; },
      },
      async releaseGeminiSession(sessionId) { releasedSessions.push(sessionId); },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const port = gateway.server.address().port;
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const viewer = await joinViewer(port, "speaking-detach");
  context.after(() => viewer.terminate());
  const nextViewer = bufferJson(viewer);
  viewer.send(JSON.stringify({ type: "speak-start" }));
  await within(nextViewer((event) => event.type === "speak-started"), "speaking floor granted");
  const events = [];
  viewer.on("message", (data) => events.push(JSON.parse(data.toString())));
  host.send(JSON.stringify({ type: "detach" }));
  host.close(1000, "host connection released");
  await once(host, "close");
  await waitFor(() => pipelines[0].closed === 1);
  assert.equal((await within(nextViewer((event) => event.type === "speak-ended"), "floor release")).reason, "host-detached");
  await within(nextViewer((event) => event.payload?.type === "floor" && event.payload.holder === null), "floor null");
  assert.equal(floorReleases.length, 1);
  assert.deepEqual(releasedSessions, [SESSION_ID]);
  assert.equal(pipelines[0].topicsCompleted, 0);
  assert.equal(viewer.readyState, WebSocket.OPEN);
  assert.equal(events.some((event) => event.payload?.status === "stopped"), false);
  viewer.send(JSON.stringify({ type: "speak-start" }));
  assert.equal((await within(nextViewer((event) => event.type === "error"), "detached floor denial")).code, "SESSION_NOT_STARTED");
});

test("an authenticated but nonowning host cannot detach another active host connection", async (context) => {
  const { gateway, pipelines } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const port = gateway.server.address().port;
  const owner = await connectHost(port);
  context.after(() => owner.terminate());
  const nonowner = await authenticateHost(port);
  context.after(() => nonowner.terminate());
  const rejected = nextJson(nonowner);
  nonowner.send(JSON.stringify({ type: "detach" }));
  assert.equal((await within(rejected, "nonowner detach rejection")).code, "SESSION_NOT_STARTED");
  await once(nonowner, "close");
  assert.equal(pipelines[0].closed, 0);
  assert.equal(owner.readyState, WebSocket.OPEN);
  owner.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await waitFor(() => pipelines[0].frames.length === 1);
});

test("authenticated host stop broadcasts stopped then closes every session socket and provider exactly once", async (context) => {
  const teardownOrder = [];
  const releasedSessions = [];
  const { gateway, pipelines, timers } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 45_000,
      serializeJson(value) {
        if (value?.payload?.type === "session-status" && value.payload.status === "stopped") teardownOrder.push("status");
        return JSON.stringify(value);
      },
      async releaseGeminiSession(sessionId) { releasedSessions.push(sessionId); teardownOrder.push("gemini"); },
    },
    pipelineHooks: {
      async close() { this.closed += 1; teardownOrder.push("pipeline"); },
      async completeTopicsOnSessionEnd() { this.topicsCompleted += 1; teardownOrder.push("topics"); },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const port = gateway.server.address().port;
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const viewers = await Promise.all(Array.from(
    { length: 200 },
    (_, index) => joinViewer(port, `viewer-stop-cleanup-${index}`),
  ));
  context.after(() => viewers.forEach((viewer) => viewer.terminate()));

  const viewerStatuses = viewers.map((viewer) => waitForJson(viewer, (message) => message.type === "live-event"
    && message.payload?.type === "session-status" && message.payload.status === "stopped"));
  const viewerClosed = viewers.map((viewer) => once(viewer, "close"));
  const hostClosed = once(host, "close");
  const reply = nextJson(host);
  host.send(JSON.stringify({ type: "stop" }));
  assert.equal((await Promise.all(viewerStatuses)).every((message) => message.payload.status === "stopped"), true);
  assert.deepEqual(await reply, { type: "stopped", sessionId: SESSION_ID });
  assert.equal((await Promise.all(viewerClosed)).every(([code]) => code === 1000), true);
  assert.equal((await hostClosed)[0], 1000);
  await waitFor(() => pipelines[0].closed === 1);
  assert.equal(pipelines[0].topicsCompleted, 1);
  assert.equal(timers.some((timer) => timer.delay === 45_000 && !timer.cancelled), false);
  assert.deepEqual(releasedSessions, [SESSION_ID]);
  await waitFor(() => gateway.subscriberCount(SESSION_ID, "ko") === 0);
  assert.equal(gateway.subscriberCount(SESSION_ID, "ko"), 0);
  assert.ok(teardownOrder.indexOf("pipeline") < teardownOrder.indexOf("status"));
  assert.ok(teardownOrder.indexOf("topics") < teardownOrder.indexOf("status"));
  assert.ok(teardownOrder.indexOf("gemini") < teardownOrder.indexOf("status"));
  assert.equal(timers.some((timer) => timer.delay === 45_000 && !timer.cancelled), false);
  await waitFor(() => /realtime_noel_viewer_connections 0/u.test(gateway.metrics.render()));
  const metrics = gateway.metrics.render();
  assert.match(metrics, /realtime_noel_host_intentional_stops_total 1/u);
  assert.match(metrics, /realtime_noel_viewer_connections 0/u);

  const restarted = await connectHost(port);
  context.after(() => restarted.terminate());
  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[0].closed, 1, "a new provider starts only after the stopped provider is closed");
});

test("host stop closes subscribed and authenticate-only viewers for its session without touching another session", async (context) => {
  const { gateway } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const port = gateway.server.address().port;
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const authOnlyHostA = await authenticateHost(port);
  const authOnlyA = await authenticateViewer(port, "viewer-auth-only-a");
  const subscribedA = await joinViewer(port, "viewer-subscribed-a");
  const subscribedB = await joinViewer(port, "viewer-subscribed-b", { sessionId: SESSION_TWO_ID });
  const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await once(unauthenticated, "open");
  context.after(() => authOnlyHostA.terminate());
  context.after(() => authOnlyA.terminate());
  context.after(() => subscribedA.terminate());
  context.after(() => subscribedB.terminate());
  context.after(() => unauthenticated.terminate());

  const authOnlyHostAClosed = once(authOnlyHostA, "close");
  const authOnlyAClosed = once(authOnlyA, "close");
  const subscribedAClosed = once(subscribedA, "close");
  const stopped = nextJson(host);
  host.send(JSON.stringify({ type: "stop" }));
  assert.equal((await stopped).type, "stopped");
  assert.equal((await within(authOnlyHostAClosed, "authenticate-only host close"))[0], 1000);
  assert.equal((await within(authOnlyAClosed, "authenticate-only viewer close"))[0], 1000);
  assert.equal((await within(subscribedAClosed, "subscribed viewer close"))[0], 1000);
  assert.equal(subscribedB.readyState, WebSocket.OPEN);
  assert.equal(unauthenticated.readyState, WebSocket.OPEN);
  assert.equal(gateway.subscriberCount(SESSION_TWO_ID, "ko"), 1);
});

test("an authenticated viewer cannot stop the host provider", async (context) => {
  const { gateway, pipelines } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const port = gateway.server.address().port;
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const viewer = await joinViewer(port, "viewer-stop-attempt");
  context.after(() => viewer.terminate());

  const reply = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "stop" }));
  assert.equal((await reply).code, "VIEWER_CONTROL_FORBIDDEN");
  await once(viewer, "close");
  assert.equal(pipelines[0].closed, 0);
});

test("VIEWER is subscribe-only: captions arrive while forged media and control messages fail closed", async (context) => {
  const { gateway, pipelines } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const port = gateway.server.address().port;
  const host = await connectHost(port);
  context.after(() => host.terminate());

  const passiveViewer = await joinViewer(port, "viewer-caption-only");
  context.after(() => passiveViewer.terminate());
  const caption = nextJson(passiveViewer);
  await gateway.broadcastEvent(SESSION_ID, "ko", {
    type: "caption", sessionId: SESSION_ID, language: "ko", seq: 1,
    text: "번역 자막", isFinal: true,
  });
  assert.equal((await caption).payload.text, "번역 자막");

  const attacks = [
    { label: "binary PCM", payload: Buffer.alloc(INPUT_FRAME_BYTES), code: "VIEWER_MEDIA_FORBIDDEN" },
    { label: "floor request", payload: { type: "speak-start" }, code: "VIEWER_CONTROL_FORBIDDEN" },
    { label: "floor release", payload: { type: "speak-end" }, code: "VIEWER_CONTROL_FORBIDDEN" },
    { label: "floor preempt", payload: { type: "host-speak" }, code: "VIEWER_CONTROL_FORBIDDEN" },
    { label: "host pause", payload: { type: "pause" }, code: "VIEWER_CONTROL_FORBIDDEN" },
    { label: "host resume", payload: { type: "resume" }, code: "VIEWER_CONTROL_FORBIDDEN" },
    { label: "host start", payload: START_MESSAGE, code: "VIEWER_CONTROL_FORBIDDEN" },
    { label: "host stop", payload: { type: "stop" }, code: "VIEWER_CONTROL_FORBIDDEN" },
    { label: "host detach", payload: { type: "detach" }, code: "VIEWER_CONTROL_FORBIDDEN" },
  ];
  for (const attack of attacks) {
    const viewer = await joinViewer(port, `forged-${attack.label.replaceAll(" ", "-")}`);
    context.after(() => viewer.terminate());
    const reply = nextJson(viewer);
    viewer.send(Buffer.isBuffer(attack.payload) ? attack.payload : JSON.stringify(attack.payload));
    const rejected = await within(reply, attack.label, 500);
    assert.equal(rejected.code, attack.code, attack.label);
    await once(viewer, "close");
  }

  assert.equal(pipelines[0].frames.length, 0);
  assert.equal(pipelines[0].paused, 0);
  assert.equal(pipelines[0].resumed, 0);
  assert.equal(pipelines[0].closed, 0);
});

test("authenticated host PCM remains the only media ingress and host-caption commands are unavailable", async (context) => {
  const { gateway, pipelines } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(gateway.server.address().port);
  context.after(() => host.terminate());
  const nextHost = bufferJson(host);
  host.send(Buffer.alloc(INPUT_FRAME_BYTES));
  await waitFor(() => pipelines[0].frames.length === 1);

  host.send(JSON.stringify({
    type: "host-caption", liveSessionId: SESSION_ID, localCaptionId: "local-1",
    floorRevision: host.initialFloorSnapshot.floorRevision, targetLanguage: "ko",
    sourceLanguage: "en", sourceText: "Net operating income", translatedText: "순영업소득",
    isFinal: true, emittedAt: "2026-07-30T01:00:00.000Z",
  }));
  const rejected = await within(
    nextHost((message) => message.type === "error"),
    "unsupported host caption command",
  );
  assert.equal(rejected.code, "INVALID_START");
  assert.equal(pipelines[0].frames.length, 1, "text commands cannot replace or duplicate the PCM source");
});

test("a reattach reuses the pipeline for the same glossary but rebuilds it for an edited one", async (context) => {
  const { gateway, pipelines } = createLiveGateway({
    gatewayOptions: { hostReconnectGraceMilliseconds: 45_000 },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  // The stored settings must round-trip glossaryText / translationTone / domainText:
  // when they were dropped, an unchanged reconnect compared undefined against the
  // validated defaults and rebuilt the pipeline every single time.
  const started = { ...START_MESSAGE, glossaryText: "CMG = 씨엠지", domainText: "CRE" };
  const host = await connectHost(port, started);
  host.close();
  await once(host, "close");
  const sameGlossary = await connectHost(port, started);
  context.after(() => sameGlossary.terminate());
  assert.equal(pipelines.length, 1, "an unchanged glossary must reattach to the running pipeline");

  sameGlossary.close();
  await once(sameGlossary, "close");
  const editedGlossary = await connectHost(port, { ...started, glossaryText: "CMG = 씨엠지\nGFA = 연면적" });
  context.after(() => editedGlossary.terminate());
  assert.equal(pipelines.length, 2, "an edited glossary must reach the model, not reuse the old pipeline");
});

test("grace expiry tears down the detached host before a fresh reconnect", async (context) => {
  const { gateway, pipelines, timers } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 45_000,
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();

  const host = await connectHost(port);
  host.close();
  await once(host, "close");
  await waitFor(() => timers.some((timer) => timer.delay === 45_000 && !timer.cancelled));
  assert.equal(pipelines[0].closed, 0);

  timers.find((timer) => timer.delay === 45_000 && !timer.cancelled).callback();
  await waitFor(() => pipelines[0].closed === 1);

  // A late reconnect after expiry builds a fresh pipeline instead of reattaching.
  const late = await connectHost(port);
  context.after(() => late.terminate());
  assert.equal(pipelines.length, 2);
  assert.equal(late.initialFloorSnapshot.floorRevision, 0,
    "a fully expired session must not inherit an abandoned floor revision");
});

test("a lease revocation still tears the pipeline down immediately, bypassing the grace window", async (context) => {
  let leaseCallback;
  let authorizeCalls = 0;
  const { gateway, pipelines } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 45_000,
      hostAuthorizer: {
        async authorize(_claims, _settings, options) {
          authorizeCalls += 1;
          return options.compareVersion; // the lease uses compareVersion: false
        },
      },
      setHostLeaseIntervalFn(callback) { leaseCallback = callback; return { lease: true }; },
      clearHostLeaseIntervalFn() {},
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(gateway.server.address().port);
  context.after(() => host.terminate());

  const revoked = nextJson(host);
  leaseCallback();
  assert.equal((await revoked).code, "SESSION_REVOKED");
  await once(host, "close");
  await waitFor(() => pipelines[0].closed === 1);
  assert.ok(authorizeCalls >= 3);
});

test("a detached host lease observes REST termination before the 90-second grace expires", async (context) => {
  let leaseCallback;
  const { gateway, pipelines, timers } = createLiveGateway({
    gatewayOptions: {
      hostReconnectGraceMilliseconds: 90_000,
      hostAuthorizer: {
        async authorize(_claims, _settings, options) {
          return options.compareVersion;
        },
      },
      setHostLeaseIntervalFn(callback) { leaseCallback = callback; return { lease: true }; },
      clearHostLeaseIntervalFn() {},
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const host = await connectHost(gateway.server.address().port);

  host.close();
  await once(host, "close");
  await waitFor(() => timers.some((timer) => timer.delay === 90_000 && !timer.cancelled));
  leaseCallback();

  await waitFor(() => pipelines[0].closed === 1);
  assert.equal(
    timers.some((timer) => timer.delay === 90_000 && !timer.cancelled),
    false,
    "REST termination must cancel detached reconnect grace",
  );
});

test("host pause/resume gates the pipeline and broadcasts session-status to viewers", async (context) => {
  const { gateway, pipelines } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const viewer = await joinViewer(port, "grant-viewer");
  context.after(() => viewer.terminate());

  const pausedStatus = waitForJson(viewer, (message) => message.type === "live-event" && message.payload.type === "session-status");
  const pausedReply = waitForJson(host, (message) => message.type === "paused");
  host.send(JSON.stringify({ type: "pause" }));
  assert.equal((await pausedReply).sessionId, SESSION_ID);
  assert.equal((await pausedStatus).payload.status, "paused");
  assert.equal(pipelines[0].paused, 1);
  assert.equal(pipelines[0].closed, 0, "pause keeps the pipeline");
  assert.equal(viewer.readyState, WebSocket.OPEN, "pause keeps viewer sockets");

  const liveStatus = waitForJson(viewer, (message) => message.type === "live-event" && message.payload.type === "session-status" && message.payload.status === "live");
  const resumedReply = waitForJson(host, (message) => message.type === "resumed");
  host.send(JSON.stringify({ type: "resume" }));
  await resumedReply;
  await liveStatus;
  assert.equal(pipelines[0].resumed, 1);
});

test("forged VIEWER floor requests never consult the participant directory", async (context) => {
  const lookups = [];
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      async fetchFloorParticipant(...args) { lookups.push(args); return null; },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const viewer = await joinViewer(gateway.server.address().port, "grant-forged-floor");
  context.after(() => viewer.terminate());
  const reply = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "speak-start" }));
  assert.equal((await reply).code, "VIEWER_CONTROL_FORBIDDEN");
  assert.deepEqual(lookups, []);
});

test("concurrent forged VIEWER floor requests are both rejected without pipeline effects", async (context) => {
  const { gateway, pipelines } = createLiveGateway();
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const host = await connectHost(port);
  context.after(() => host.terminate());
  const viewerA = await joinViewer(port, "grant-a");
  const viewerB = await joinViewer(port, "grant-b");
  context.after(() => viewerA.terminate());
  context.after(() => viewerB.terminate());
  const replyA = nextJson(viewerA);
  const replyB = nextJson(viewerB);
  viewerA.send(JSON.stringify({ type: "speak-start" }));
  viewerB.send(JSON.stringify({ type: "speak-start" }));
  assert.equal((await replyA).code, "VIEWER_CONTROL_FORBIDDEN");
  assert.equal((await replyB).code, "VIEWER_CONTROL_FORBIDDEN");
  assert.equal(pipelines[0].frames.length, 0);
});

test("a viewer cannot subscribe before the host session is live", async (context) => {
  let isLive = false;
  const { gateway } = createLiveGateway({
    gatewayOptions: {
      viewerAuthorizer: {
        async authorize() { return isLive; },
        async authorizeBatch(requests) { return new Map(requests.map(({ key }) => [key, isLive])); },
      },
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => gateway.close());
  const { port } = gateway.server.address();
  const viewer = await authenticateViewer(port, "grant-early");
  context.after(() => viewer.terminate());
  const rejected = nextJson(viewer);
  viewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
  assert.equal((await rejected).code, "GRANT_REVOKED");
  const host = await connectHost(port);
  context.after(() => host.terminate());
  isLive = true;
  const liveViewer = await authenticateViewer(port, "grant-after-live");
  context.after(() => liveViewer.terminate());
  const subscribed = nextJson(liveViewer);
  liveViewer.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, language: "ko" }));
  assert.equal((await subscribed).type, "subscribed");
});
