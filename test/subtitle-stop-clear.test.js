import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";

const PROJECT_ROOT = path.join(import.meta.dirname, "..");

function waitForMessage(socket, predicate, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(message);
    };
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (predicate(message)) finish(null, message);
    };
    const onClose = () => finish(new Error("WebSocket closed before the expected message."));
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the expected message.")), timeoutMs);
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

async function openSocket(url) {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
    headers: { Origin: url },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

test("an accepted gateway-caption stop broadcasts idle and removes the late-join subtitle snapshot", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });
  const sockets = [];
  try {
    const producer = await openSocket(url);
    sockets.push(producer);

    const started = waitForMessage(producer, (message) => message.type === "subtitle:started");
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "live-stop-clear",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "call-stop-clear" },
    }));
    await started;

    const committed = waitForMessage(producer, (message) => message.type === "subtitle:committed");
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-stop-clear",
      partial: false,
      targetLanguage: "ko",
      sourceLanguage: "en",
      speaker: "Host",
      speakerRole: "host",
      translatedText: "종료 전에 보이는 마지막 자막",
    }));
    await committed;

    const idle = waitForMessage(
      producer,
      (message) => message.type === "subtitle:status" && message.status === "idle",
    );
    producer.send(JSON.stringify({ type: "subtitle:stop", sessionId: "live-stop-clear" }));
    await idle;

    const lateViewer = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
      headers: { Origin: url },
    });
    sockets.push(lateViewer);
    const snapshotPromise = waitForMessage(lateViewer, (message) => message.type === "subtitle:snapshot");
    await new Promise((resolve, reject) => {
      lateViewer.once("open", resolve);
      lateViewer.once("error", reject);
    });
    const snapshot = await snapshotPromise;
    assert.deepEqual(snapshot.lanes, []);
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("live-call captions clear after the caption-only silence window", async () => {
  // Parity with captions-only: the local engine broadcasts subtitle:clear
  // after SILENCE_CLEAR_MS of no new content, but the gateway emits no such
  // event — so the relay must synthesize it, or live-call captions linger on
  // the overlay 5x longer than caption-only ones.
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    liveCallSilenceClearMilliseconds: 150,
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });
  const sockets = [];
  try {
    const producer = await openSocket(url);
    sockets.push(producer);

    const started = waitForMessage(producer, (message) => message.type === "subtitle:started");
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "live-silence-clear",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "call-silence-clear" },
    }));
    await started;

    const committed = waitForMessage(producer, (message) => message.type === "subtitle:committed");
    producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-silence-clear",
      partial: false,
      targetLanguage: "ko",
      sourceLanguage: "en",
      speaker: "Host",
      speakerRole: "host",
      translatedText: "침묵 후 사라져야 하는 자막",
    }));
    await committed;

    // No further captions arrive: the relay must end the subtitle exactly the
    // way the captions-only engine does.
    const cleared = await waitForMessage(
      producer,
      (message) => message.type === "subtitle:clear" && message.source === "live-call",
      1_500,
    );
    assert.equal(cleared.targetLanguage, "ko");
    assert.equal(cleared.reason, "silence");
    assert.equal(cleared.liveSessionId, "call-silence-clear");

    // A late viewer must not resurrect the cleared lane from the snapshot.
    const lateViewer = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
      headers: { Origin: url },
    });
    sockets.push(lateViewer);
    const snapshotPromise = waitForMessage(lateViewer, (message) => message.type === "subtitle:snapshot");
    await new Promise((resolve, reject) => {
      lateViewer.once("open", resolve);
      lateViewer.once("error", reject);
    });
    const snapshot = await snapshotPromise;
    assert.deepEqual(snapshot.lanes, []);
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("live-call sentence retention matches captions-only", async () => {
  // Two halves of the same behavior:
  //  1. A completed sentence lingers while the next grows, then rolls off
  //     after SUBTITLE_PREVIOUS_SENTENCE_LINGER_MS — the overlay must arm that
  //     trim for Live Call too, not only for captions-only.
  //  2. After the speaker stops, the last sentence stays readable for that
  //     same linger on top of the 3s silence threshold.
  const [overlay, server] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "public/subtitle-overlay.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "src/server.js"), "utf8"),
  ]);

  const commitStart = overlay.indexOf("function renderCommittedSubtitle");
  const commitEnd = overlay.indexOf("function renderPredictedSubtitle", commitStart);
  assert.ok(commitStart >= 0 && commitEnd > commitStart);
  const commit = overlay.slice(commitStart, commitEnd);
  assert.match(commit, /armPreviousSentenceTrim\(lane, finalParts\.length\)/u);
  assert.doesNotMatch(commit, /if \(lane\.isLiveCall\) \{[\s\S]*?lane\.trimTimer = null;/u,
    "Live Call must not opt out of the previous-sentence linger");

  // The silence window carries the reading time, not just the silence
  // threshold: a bare 3s cleared the last sentence the instant speech stopped.
  assert.match(server, /liveCallSilenceClearMilliseconds[\s\S]{0,200}:\s*6_000/u);
});

test("only out-of-order live-call finals are records-only; in-order finals keep building the display", async () => {
  // Caption-only parity. The overlay's rolling 2-3 line stream is built from
  // COMMITTED lines plus the live partial tail, so in-order finals must keep
  // displaying — suppressing all of them leaves a single partial that gets
  // replaced wholesale and never accumulates. What breaks live-call is order:
  // the gateway's polish pass delays a final past newer partials, and painting
  // that rewinds the lane to an older sentence.
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    liveCallSilenceClearMilliseconds: 60_000,
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });
  const sockets = [];
  try {
    const producer = await openSocket(url);
    sockets.push(producer);

    const started = waitForMessage(producer, (message) => message.type === "subtitle:started");
    producer.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "live-stale-final",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "call-stale-final" },
    }));
    await started;

    const sendCaption = (payload) => producer.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "call-stale-final",
      targetLanguage: "en",
      sourceLanguage: "ko",
      speaker: "Host",
      speakerRole: "host",
      ...payload,
    }));

    // Sentence 7 partial paints the lane, then the speaker moves on and
    // sentence 8's partial paints newer content.
    const partialSeen = waitForMessage(producer, (message) => message.type === "subtitle:partial"
      && message.translatedText === "newer partial content");
    sendCaption({ partial: true, sourceSeq: 7, translatedText: "older partial content" });
    sendCaption({ partial: true, sourceSeq: 8, translatedText: "newer partial content" });
    await partialSeen;

    // Sentence 7's polished final arrives late, after sentence 8 painted: it
    // must reach history but never rewind the display.
    const staleHistorySeen = waitForMessage(producer, (message) => message.type === "subtitle:history"
      && JSON.stringify(message).includes("from the start fragment"));
    let staleCommittedSeen = false;
    const committedListener = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (message.type === "subtitle:committed" && message.translatedText === "from the start fragment") {
        staleCommittedSeen = true;
      }
    };
    producer.on("message", committedListener);
    sendCaption({ partial: false, sourceSeq: 7, translatedText: "from the start fragment", sourceText: "원문 7" });
    await staleHistorySeen;

    // The in-order final for the sentence currently on screen DOES display —
    // it is what the overlay's accumulated committed text is made of.
    const currentCommitted = waitForMessage(producer, (message) => message.type === "subtitle:committed"
      && message.translatedText === "current sentence final");
    sendCaption({ partial: false, sourceSeq: 8, translatedText: "current sentence final", sourceText: "원문 8" });
    await currentCommitted;

    // A final for a sentence that never painted (short utterance committing
    // without a partial) also displays.
    const unseenCommitted = waitForMessage(producer, (message) => message.type === "subtitle:committed"
      && message.translatedText === "never painted sentence");
    sendCaption({ partial: false, sourceSeq: 9, translatedText: "never painted sentence", sourceText: "원문 9" });
    await unseenCommitted;
    producer.off("message", committedListener);
    assert.equal(staleCommittedSeen, false,
      "an out-of-order final must not rewind the display to an older sentence");
  } finally {
    for (const socket of sockets) socket.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("desktop terminal paths clear caption text and speaker state without treating reconnect as an end", async () => {
  const [dashboard, overlay, main] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "public/subtitle-dashboard.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "public/subtitle-overlay.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "electron/main.js"), "utf8"),
  ]);

  assert.match(dashboard, /function clearActiveSubtitleSurface\(\)/u);
  assert.match(dashboard, /message\.status === "idle"[\s\S]{0,220}clearActiveSubtitleSurface\(\)/u);
  assert.match(dashboard, /async function stopSubtitles\(\)[\s\S]{0,260}clearActiveSubtitleSurface\(\)/u);
  assert.match(dashboard, /floor\?\.type === "live-call-ended"[\s\S]{0,260}clearActiveSubtitleSurface\(\)/u);

  const reconnectStart = dashboard.indexOf("async function reconnectLiveCallTranslation()");
  const reconnectEnd = dashboard.indexOf("function stopLocalStreams()", reconnectStart);
  assert.ok(reconnectStart >= 0 && reconnectEnd > reconnectStart);
  assert.doesNotMatch(dashboard.slice(reconnectStart, reconnectEnd), /clearActiveSubtitleSurface\(\)/u);

  assert.match(overlay, /floor\?\.type === "live-call-ended"[\s\S]{0,220}clearSubtitle\(\)/u);
  assert.match(main, /currentStatus === "stopped"[\s\S]{0,460}type: "live-call-ended"[\s\S]{0,120}sessionId: armedSession\.sessionId/u);
  assert.match(main, /liveCallSession = null;[\s\S]{0,260}type: "live-call-ended"[\s\S]{0,120}sessionId: endingSession\.sessionId/u);
});
