// @ts-nocheck - injected fakes for streamText/generateText return simplified shapes that don't satisfy the AI SDK return type.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_AGENT_TIMEOUT_MS, runWhiteboardAgent, selectSubtitlePolishOptions, startServer, whiteboardSystemPrompt } from "../src/server.js";
import { createSettingsStore, MAX_SUBTITLE_GLOSSARY_CHARS } from "../src/settings-store.js";

function sameOriginHeaders(url, headers = {}) {
  return { origin: new URL(url).origin, ...headers };
}

test("default whiteboard agent timeout is 90 seconds", () => {
  assert.equal(DEFAULT_AGENT_TIMEOUT_MS, 90_000);
});

test("startServer waits for Moonshine readiness before listening", async () => {
  let resolveReady;
  let closed = false;
  const progressMessages = [];
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const serverPromise = startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    onStatus: (message) => progressMessages.push(message),
    createTranscription: () => ({
      ready: () => readyPromise,
      sendAudio: () => {},
      stop: () => {},
      close: () => {
        closed = true;
      },
    }),
  });

  let started = false;
  serverPromise.then(() => {
    started = true;
  });
  await Promise.resolve();
  assert.equal(started, false);
  assert.deepEqual(progressMessages, ["Preparing Moonshine medium transcription model..."]);

  resolveReady();
  const { httpServer } = await serverPromise;
  assert.equal(started, true);
  assert.deepEqual(progressMessages, [
    "Preparing Moonshine medium transcription model...",
    "Moonshine medium transcription model ready.",
  ]);

  await new Promise((resolve) => httpServer.close(resolve));
  assert.equal(closed, true);
});

test("server still starts when the transcription model fails to load (missing sidecar)", async () => {
  // A missing local Moonshine sidecar must not crash boot — the subtitle feature
  // (Gemini/OpenAI Realtime) is independent of it. startServer must resolve and
  // listen even though ready() rejects.
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => { throw new Error("Cannot find Moonshine sidecar package for darwin/arm64."); },
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  try {
    assert.ok(url, "server should still come up and listen");
    const messages = await collectWebSocketMessages(url.replace("http:", "ws:") + "/ws", 1);
    assert.equal(messages[0].type, "config", "server serves clients despite the transcription model being unavailable");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("desktop subtitle static assets are always revalidated instead of surviving an app update cache", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });
  try {
    for (const asset of [
      "subtitle.html",
      "subtitle-dashboard.js",
      "subtitle.css",
      "subtitle-overlay.html",
      "subtitle-overlay.js",
      "subtitle-controller.html",
      "subtitle-controller.js",
    ]) {
      const response = await fetch(`${url}/${asset}`);
      assert.equal(response.status, 200, asset);
      assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate, proxy-revalidate", asset);
      assert.equal(response.headers.get("pragma"), "no-cache", asset);
      assert.equal(response.headers.get("expires"), "0", asset);
      assert.equal(response.headers.get("surrogate-control"), "no-store", asset);
    }
    const unrelated = await fetch(`${url}/app.js`);
    assert.equal(unrelated.status, 200);
    assert.equal(unrelated.headers.get("cache-control")?.includes("no-store"), false, "the emergency policy must stay scoped to subtitle assets");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("websocket clients receive the current agent status on connect", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  try {
    const messages = await collectWebSocketMessages(url.replace("http:", "ws:") + "/ws", 7);
    assert.deepEqual(
      messages.map((message) => message.type),
      ["config", "agent:status", "mode", "warmup", "cost", "subtitle:history", "subtitle:snapshot"],
    );
    assert.equal(messages[1].status, "idle");
    assert.equal(messages[2].mode, "staging");
    assert.equal(messages[3].state, "idle");
    assert.equal(messages[4].agent.cost, 0);
    assert.equal(messages[4].transcription.cost, 0);
    assert.deepEqual(messages[5].records, []);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("subtitle:mirror relays phone-linked lines to every client as real subtitles", { skip: "node:test runner hangs on the dual-ws flow (plain-node probe passes in 320ms — see scripts/probe-mirror.mjs, live-verified 2026-06-12)" }, async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
  });

  try {
    const wsUrl = url.replace("http:", "ws:") + "/ws";
    const listener = new WebSocket(wsUrl);
    const sender = new WebSocket(wsUrl);
    const received = [];
    listener.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    await Promise.all([listener, sender].map((socket) => new Promise((resolve) => socket.on("open", resolve))));

    sender.send(JSON.stringify({ type: "subtitle:mirror", partial: true, translatedText: "안녕하세요", sourceText: "Hello", speaker: "Noel" }));
    sender.send(JSON.stringify({ type: "subtitle:mirror", partial: false, translatedText: "안녕하세요", sourceText: "Hello", speaker: "Noel" }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const partial = received.find((message) => message.type === "subtitle:partial");
    const committed = received.find((message) => message.type === "subtitle:committed");
    assert.equal(partial?.translatedText, "안녕하세요");
    assert.equal(committed?.translatedText, "안녕하세요");
    assert.equal(committed?.source, "mirror");
    listener.close(); sender.close();
  } finally {
    // Without closeAllConnections the server waits indefinitely for the ws
    // upgrade sockets to finish closing — verified hang (probe 2026-06-12).
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("the server serves built-in glossary presets", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  try {
    const presets = await fetch(`${url}/api/glossary-presets`).then((res) => res.json());
    assert.ok(Array.isArray(presets));
    assert.ok(presets.some((preset) => preset.id === "hotel-investment-en-ko"));
    assert.ok(presets.some((preset) => preset.id === "fnb-leasing-ko-ja"));
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("settings export downloads subtitle settings as a portable JSON file", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    settingsStore: await (async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rn-export-"));
      const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {}, readCodexAuth: () => null });
      await store.load();
      await store.save({
        apiKeys: { openai: "sk-test" },
        subtitle: {
          tone: "business",
          glossary: "operator = 운영사",
          apiKeys: { gemini: "nested-secret-must-not-export" },
          longLivedSecret: "nested-long-secret-must-not-export",
        },
      });
      return store;
    })(),
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  try {
    const response = await fetch(`${url}/api/settings/export`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
    const body = await response.json();
    // Export is a strict subtitle allowlist. Legacy includeKeys flags must not
    // re-enable either top-level or nested long-lived credentials.
    assert.equal(typeof body.subtitle, "object");
    assert.equal(body.apiKeys, undefined);
    assert.equal(body.subtitleHistory, undefined);
    assert.equal(body.agent, undefined);

    const withKeys = await fetch(`${url}/api/settings/export?includeKeys=1`).then((res) => res.json());
    assert.equal(withKeys.apiKeys, undefined);
    assert.equal(withKeys.subtitle.apiKeys, undefined);
    assert.equal(withKeys.subtitle.longLivedSecret, undefined);
    assert.equal(JSON.stringify(withKeys).includes("sk-test"), false);
    assert.equal(JSON.stringify(withKeys).includes("nested-secret-must-not-export"), false);

    const withoutKeys = await fetch(`${url}/api/settings/export?includeKeys=0`).then((res) => res.json());
    assert.equal(withoutKeys.apiKeys, undefined);
    assert.equal(typeof withoutKeys.subtitle, "object");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("text adapter accepts one-character speech without optional polish settings", () => {
  const saved = { apiKeys: { gemini: "test-caption-key" } };
  assert.deepEqual(selectSubtitlePolishOptions({
    args: { translatedText: "…", sourceText: "네", tone: "natural" }, saved, env: {},
  }), { provider: "gemini", apiKey: saved.apiKeys.gemini, modelId: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite"] });
  assert.equal(selectSubtitlePolishOptions({
    args: { translatedText: "…", sourceText: "  ", tone: "natural" }, saved, env: {},
  }), null);
});

// Availability routing only: one attempt per model in the selected engine's
// catalog chain, in order, and no model is retried.
test("text adapter outages walk the engine fallback chain once per model", async () => {
  let polish;
  const calls = [];
  const { httpServer } = await startServer({
    host: "127.0.0.1", port: 0, env: { GEMINI_API_KEY: "test-caption-key" },
    createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
    createSubtitleRealtimeManager: (options) => { polish = options.polish; return { close() {} }; },
    fetchImpl: async (url) => { calls.push(url); return new Response("", { status: 503 }); },
  });
  try {
    await polish({ translatedText: "…", sourceText: "오늘 회의를 시작합니다.", targetLanguage: "en", tone: "natural" });
    assert.deepEqual(
      calls.map((url) => String(url).split("/").at(-1)),
      ["gemini-3.6-flash:generateContent", "gemini-3.5-flash-lite:generateContent"],
    );
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

// The "polish" call is the caption text-translation call, so its model is the
// engine selection's translation model — not a separate hard-coded pin.
test("caption text translation follows the saved engine translation model", () => {
  const saved = {
    apiKeys: { gemini: "AIza-live" },
    subtitle: {
      engine: {
        stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
        translation: { provider: "gemini", model: "gemini-3.7-flash" },
        summary: { provider: "gemini", model: "gemini-3.6-flash" },
      },
    },
  };
  assert.deepEqual(
    selectSubtitlePolishOptions({ args: { tone: "business", glossary: "" }, saved, env: {} }),
    { provider: "gemini", apiKey: "AIza-live", modelId: "gemini-3.7-flash", fallbackModels: ["gemini-3.6-flash", "gemini-3.5-flash-lite"] },
  );
});

test("subtitle second-pass polish uses separated provider keys", () => {
  const secondaryFixture = "AIza-finalizer";
  assert.equal(
    selectSubtitlePolishOptions({
      args: { tone: "natural", glossary: "operator = 운영사" },
      saved: { apiKeys: { openai: "sk-primary" }, subtitle: { tonePolishModel: "gpt-5.5" } },
      env: {},
    }),
    null,
  );

  assert.deepEqual(
    selectSubtitlePolishOptions({
      args: { tone: "business", glossary: "", polishProvider: "gemini" },
      saved: {
        apiKeys: { gemini: "AIza-live", geminiSecondary: "AIza-finalizer" },
        subtitle: { geminiPolishModel: "gemini-3.5-flash" },
      },
      env: {},
    }),
    { provider: "gemini", apiKey: secondaryFixture, modelId: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite"] },
  );

  assert.deepEqual(
    selectSubtitlePolishOptions({
      args: {
        tone: "natural",
        glossary: "",
        translatedText: "...",
        sourceText: "The operator validates the deal",
        polishProvider: "gemini",
      },
      saved: {
        apiKeys: { gemini: "AIza-live", geminiSecondary: "AIza-finalizer" },
        subtitle: { geminiPolishModel: "gemini-3.5-flash" },
      },
      env: {},
    }),
    { provider: "gemini", apiKey: secondaryFixture, modelId: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite"] },
  );

  assert.deepEqual(
    selectSubtitlePolishOptions({
      args: { tone: "business", glossary: "", polishProvider: "gemini" },
      saved: {
        apiKeys: { gemini: "AIza-live" },
        subtitle: { geminiPolishModel: "gemini-3.5-flash" },
      },
      env: {},
    }),
    { provider: "gemini", apiKey: "AIza-live", modelId: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite"] },
  );

  assert.equal(
    selectSubtitlePolishOptions({
      args: { tone: "business", glossary: "", polishProvider: "gemini" },
      saved: { apiKeys: {}, subtitle: {} },
      env: {},
    }),
    null,
  );

  assert.deepEqual(
    selectSubtitlePolishOptions({
      args: { tone: "business", glossary: "", polishProvider: "gemini" },
      saved: { apiKeys: { gemini: "AIza-live" }, subtitle: {} },
      env: {},
    }),
    { provider: "gemini", apiKey: "AIza-live", modelId: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite"] },
  );
});

test("subtitle:start validates runtime subtitle settings before opening providers", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  let ws;
  try {
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers: { Origin: url } });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const errorPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for subtitle start validation error.")), 2000);
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "subtitle:error") {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });

    ws.send(JSON.stringify({
      type: "subtitle:start",
      sessionId: "active",
      settings: { glossary: "x".repeat(MAX_SUBTITLE_GLOSSARY_CHARS + 1) },
    }));

    const error = await errorPromise;
    assert.equal(error.code, "SUBTITLE_START_FAILED");
    assert.match(error.message, /glossary/);
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("subtitle:stop without a sessionId cannot stop the active subtitle session", async () => {
  const sockets = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    env: { OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "AIza-test" },
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
    createSubtitleWebSocket: (socketUrl, protocols, init) => {
      const socket = new FakeRealtimeSocket(socketUrl, init);
      sockets.push(socket);
      return socket;
    },
  });

  let ws;
  try {
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers: { Origin: url } });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({
      type: "subtitle:start",
      sessionId: "active",
      settings: { inputMode: "mic", translationProvider: "gemini" },
    }));
    await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:status" && message.status === "api_ready");

    ws.send(JSON.stringify({ type: "subtitle:stop" }));
    ws.send(JSON.stringify({
      type: "subtitle:audio",
      sessionId: "active",
      source: "mic",
      audio: Buffer.alloc(4_800, 1).toString("base64"),
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(
      sockets[0].sent.some((message) => Boolean(JSON.parse(message).realtimeInput?.audio)),
      true,
    );
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("subtitle:input-status preserves the microphone source for the stall watchdog", { timeout: 2_000 }, async () => {
  let resolveSignal;
  const signalPromise = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
    createSubtitleRealtimeManager: () => ({
      start: async () => {},
      stop: async () => {},
      sendAudio: () => {},
      restartChannels: async () => {},
      noteInputSignal: (signal) => resolveSignal(signal),
      close: () => {},
    }),
  });

  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers: { Origin: url } });
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const started = new Promise((resolve) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.type === "subtitle:started") resolve();
      });
    });
    ws.send(JSON.stringify({ type: "subtitle:start", sessionId: "mic-session", settings: {} }));
    await started;
    ws.send(JSON.stringify({
      type: "subtitle:input-status",
      sessionId: "mic-session",
      source: "mic",
      status: "signal",
    }));

    assert.deepEqual(await signalPromise, { sessionId: "mic-session", source: "mic" });
  } finally {
    ws.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("history exports as Excel-compatible CSV with a UTF-8 BOM", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  try {
    const response = await fetch(`${url}/api/subtitles/history/export.csv`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
    // fetch's text() strips a leading BOM per spec, so verify raw bytes:
    // EF BB BF is what makes Excel decode Korean correctly on double-click.
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.match(buffer.toString("utf8"), /날짜,시간,입력,언어,주제,번역/);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("server requires exact local origin for mutating HTTP and websocket requests", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
  });

  try {
    const sameOriginResponse = await fetch(`${url}/api/session/reset`, {
      method: "POST",
      headers: sameOriginHeaders(url),
    });
    assert.equal(sameOriginResponse.status, 200);

    const missingOriginResponse = await fetch(`${url}/api/session/reset`, {
      method: "POST",
    });
    assert.equal(missingOriginResponse.status, 403);
    assert.deepEqual(await missingOriginResponse.json(), {
      ok: false,
      error: "허용되지 않은 요청 출처입니다.",
      code: "INVALID_ORIGIN",
    });

    const response = await fetch(`${url}/api/session/reset`, {
      method: "POST",
      headers: { origin: "https://example.test" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "허용되지 않은 요청 출처입니다.",
      code: "INVALID_ORIGIN",
    });

    const localOrigin = new URL(url).origin;
    for (const origin of [
      `${localOrigin}.evil.test`,
      `${localOrigin}/forged-path`,
      localOrigin.replace(/:\d+$/u, ":444"),
    ]) {
      const confused = await fetch(`${url}/api/session/reset`, {
        method: "POST",
        headers: { origin },
      });
      assert.equal(confused.status, 403, origin);
    }

    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url.replace("http:", "ws:") + "/ws", {
          headers: { origin: "https://example.test" },
        });
        ws.once("open", () => {
          ws.close();
          resolve();
        });
        ws.once("error", reject);
      }),
    );
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("server validates OpenAI Realtime transcription keys before saving", async () => {
  const sockets = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
    createSubtitleWebSocket: (socketUrl, protocols, init) => {
      const socket = new FakeRealtimeSocket(socketUrl, init);
      socket.responseType = "transcription_session.updated";
      sockets.push(socket);
      return socket;
    },
  });

  try {
    const response = await fetch(`${url}/api/subtitles/openai/validate`, {
      method: "POST",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ apiKey: "sk-test" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { status: "valid" } });
    assert.equal(sockets[0].url, "wss://api.openai.com/v1/realtime?intent=transcription");
    assert.equal(sockets[0].init.headers.Authorization, "Bearer sk-test");
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "gpt-realtime-whisper" },
          },
        },
      },
    });
    assert.equal(sockets[0].closed, true);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("server returns a sanitized OpenAI validation error", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
    createSubtitleWebSocket: () => {
      const socket = new FakeRealtimeSocket("wss://example.test", {});
      socket.failOnOpen = true;
      return socket;
    },
  });

  try {
    const response = await fetch(`${url}/api/subtitles/openai/validate`, {
      method: "POST",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ apiKey: "sk-secret-value" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "OpenAI Realtime 연결 확인에 실패했습니다. API key, 네트워크, 사용량 한도를 확인하세요.",
      code: "OPENAI_REALTIME_VALIDATE_FAILED",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("server validates Gemini model access without paid inference and rate limits repeated checks", async () => {
  const fetchCalls = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
    fetchImpl: async (requestUrl, init) => {
      fetchCalls.push({ url: requestUrl, init });
      return {
        ok: true,
        json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }] }),
      };
    },
  });

  try {
    const response = await fetch(`${url}/api/subtitles/gemini/validate`, {
      method: "POST",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ apiKey: "AIza-test" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { status: "valid" } });
    assert.match(fetchCalls[0].url, /generativelanguage\.googleapis\.com/);
    assert.match(fetchCalls[0].url, /gemini-3\.6-flash/u);
    assert.equal(fetchCalls[0].init.headers["x-goog-api-key"], "AIza-test");
    assert.equal(fetchCalls[0].init.method, "GET");
    assert.equal(fetchCalls[0].init.body, undefined);
    assert.equal(fetchCalls[0].init.redirect, "error");
    const repeated = await fetch(`${url}/api/subtitles/gemini/validate`, {
      method: "POST", headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ apiKey: "AIza-test" }),
    });
    assert.equal(repeated.status, 429);
    assert.equal(fetchCalls.length, 1);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("server returns a sanitized Gemini validation error", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "AIza-secret denied" } }) }),
  });

  try {
    const response = await fetch(`${url}/api/subtitles/gemini/validate`, {
      method: "POST",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ apiKey: "AIza-secret" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "Gemini 연결 확인에 실패했습니다. API key, 프로젝트 권한, 사용량 한도를 확인하세요.",
      code: "GEMINI_VALIDATE_FAILED",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("websocket screenshot messages update agent visual context", async () => {
  let resolveGenerateText;
  const generateTextStarted = new Promise((resolve) => {
    resolveGenerateText = resolve;
  });
  const { httpServer, url, state } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: ({ queueTranscript }) => ({
      ready: async () => {},
      sendAudio: () => queueTranscript("Update the visual layout"),
      stop: () => {},
      close: () => {},
    }),
    generateTextFn: async ({ messages }) => {
      const currentCanvasMessage = messages.at(-1);
      assert.deepEqual(currentCanvasMessage.content.at(-1), { type: "image", image: "data:image/png;base64,latest" });
      resolveGenerateText();
      return { text: "DONE", finishReason: "stop" };
    },
  });

  try {
    state.mode = "live";
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
    const initialMessages = new Promise((resolve) => {
      let count = 0;
      ws.on("message", () => {
        count += 1;
        if (count === 7) resolve();
      });
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await initialMessages;
    ws.send(JSON.stringify({ type: "whiteboard:screenshot", image: "data:image/png;base64,latest" }));
    ws.send(JSON.stringify({ type: "audio", audio: "" }));
    await generateTextStarted;
    ws.close();
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

class FakeRealtimeSocket extends EventEmitter {
  constructor(url, init) {
    super();
    this.url = url;
    this.init = init;
    this.sent = [];
    queueMicrotask(() => this.emit("open"));
  }

  send(message) {
    this.sent.push(message);
    if (this.failOnOpen) {
      queueMicrotask(() => this.emit("message", JSON.stringify({
        type: "error",
        error: { message: "secret upstream error" },
      })));
      return;
    }
    const value = JSON.parse(message);
    queueMicrotask(() => this.emit("message", JSON.stringify(
      value.setup ? { setupComplete: {} } : { type: this.responseType ?? "session.updated" },
    )));
  }

  close() {
    this.closed = true;
  }
}

test("websocket stop makes synchronous transcript flush stale", async () => {
  let generateCalled = false;
  let ws;
  let resolveStopCalled;
  const stopCalled = new Promise((resolve) => {
    resolveStopCalled = resolve;
  });
  const { httpServer, url, state } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: ({ queueTranscript }) => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {
        queueTranscript("Final flushed words");
        resolveStopCalled();
      },
      close: () => {},
    }),
    generateTextFn: async () => {
      generateCalled = true;
      return { text: "DONE", finishReason: "stop" };
    },
  });

  try {
    state.mode = "live";
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
    const initialMessages = new Promise((resolve) => {
      let count = 0;
      ws.on("message", () => {
        count += 1;
        if (count === 5) resolve();
      });
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await initialMessages;
    ws.send(JSON.stringify({ type: "stop" }));
    await Promise.race([
      stopCalled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for transcription stop.")), 2000)),
    ]);
    await state.idle();
    assert.equal(generateCalled, false);
    ws.close();
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("runWhiteboardAgent rejects with a timeout instead of hanging forever", async () => {
  await assert.rejects(
    () =>
      runWhiteboardAgent({
        transcript: "hello",
        state: { elements: [], agentHistory: [] },
        wss: { clients: new Set() },
        options: { agentTimeoutMs: 1 },
        generateTextFn: () => new Promise(() => {}),
      }),
    /Whiteboard agent timed out/,
  );
});

test("runWhiteboardAgent exposes whiteboard_apply that combines edits and viewport in one call", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "text", id: "title", x: 72, y: 68, text: "Realtime Noel" }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Add a voice box and focus on it",
    state,
    wss: {
      clients: new Set([
        {
          readyState: WebSocket.OPEN,
          send: (message) => broadcasts.push(JSON.parse(message)),
        },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      assert.equal(tools.updateWhiteboard, undefined);
      assert.equal(tools.whiteboard_edit, undefined, "whiteboard_edit removed");
      assert.equal(tools.whiteboard_viewport, undefined, "whiteboard_viewport removed");
      assert.ok(tools.whiteboard_overwrite);
      assert.ok(tools.whiteboard_apply);

      const result = await tools.whiteboard_apply.execute({
        operations: [
          {
            type: "insert_after",
            line: 1,
            element: { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
          },
        ],
        viewport: { action: "scroll_to_content", focus_ids: ["voice"] },
      });

      assert.match(result, /001: \{"type":"text","id":"title"/);
      assert.match(result, /002: \{"type":"rectangle","id":"voice"/);
      assert.match(result, /Viewport scrolled to 1 element: \["voice"\]/);
    },
  });

  assert.deepEqual(state.elements, [
    { type: "text", id: "title", x: 72, y: 68, text: "Realtime Noel" },
    { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
  ]);
  assert.deepEqual(
    broadcasts,
    [
      { type: "whiteboard:update", elements: state.elements },
      { type: "whiteboard:viewport", action: "scroll_to_content", focus_ids: ["voice"] },
    ],
  );
});

test("whiteboard_apply with operations only edits the canvas without touching viewport", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "text", id: "title", x: 0, y: 0, text: "Hi" }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Add a box",
    state,
    wss: {
      clients: new Set([
        { readyState: WebSocket.OPEN, send: (msg) => broadcasts.push(JSON.parse(msg)) },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      const result = await tools.whiteboard_apply.execute({
        operations: [
          { type: "insert_after", line: 1, element: { type: "rectangle", id: "box", x: 10, y: 50, width: 100, height: 50 } },
        ],
      });
      assert.match(result, /002: \{"type":"rectangle","id":"box"/);
      assert.doesNotMatch(result, /Viewport/);
    },
  });

  assert.equal(broadcasts.filter((m) => m.type === "whiteboard:viewport").length, 0);
});

test("whiteboard_apply with viewport only moves the camera without editing", async () => {
  const broadcasts = [];
  const state = {
    elements: [{ type: "rectangle", id: "oauth-box", x: 0, y: 0, width: 200, height: 100 }],
    agentHistory: [],
  };

  await runWhiteboardAgent({
    transcript: "Zoom to the OAuth box",
    state,
    wss: {
      clients: new Set([
        { readyState: WebSocket.OPEN, send: (msg) => broadcasts.push(JSON.parse(msg)) },
      ]),
    },
    options: {},
    generateTextFn: async ({ tools }) => {
      const result = await tools.whiteboard_apply.execute({
        viewport: { action: "scroll_to_content", focus_ids: ["oauth-box"] },
      });
      assert.match(result, /Viewport scrolled to 1 element/);
    },
  });

  assert.deepEqual(
    broadcasts.filter((m) => m.type === "whiteboard:viewport"),
    [{ type: "whiteboard:viewport", action: "scroll_to_content", focus_ids: ["oauth-box"] }],
  );
  assert.equal(broadcasts.filter((m) => m.type === "whiteboard:update").length, 0);
});

test("whiteboard_apply rejects calls with neither operations nor viewport", async () => {
  let returned;
  await runWhiteboardAgent({
    transcript: "do nothing",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {},
    generateTextFn: async ({ tools }) => {
      returned = await tools.whiteboard_apply.execute({});
    },
  });
  assert.match(returned, /Provide at least one of operations or viewport/);
});

test("whiteboard_apply scroll_to_content without focus_ids returns a nudge to use them", async () => {
  let returned;
  await runWhiteboardAgent({
    transcript: "scroll please",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {},
    generateTextFn: async ({ tools }) => {
      returned = await tools.whiteboard_apply.execute({
        viewport: { action: "scroll_to_content" },
      });
    },
  });
  assert.match(returned, /focus_ids/);
});

test("runWhiteboardAgent passes OpenAI reasoning effort provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "openai",
        model: "gpt-5.5",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    generateTextFn: async ({ providerOptions }) => {
      assert.deepEqual(providerOptions, {
        openai: { reasoningEffort: "low" },
      });
    },
  });
});

test("runWhiteboardAgent always uses the production system prompt", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { systemPrompt: "Custom whiteboard instructions" },
    generateTextFn: async ({ system }) => {
      assert.equal(system, whiteboardSystemPrompt());
    },
  });
});

test("runWhiteboardAgent records a model result summary in agent events", async () => {
  const events = [];

  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: { onAgentEvent: (event) => events.push(event) },
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop", usage: { totalTokens: 12 } }),
  });

  const endEvent = events.find((event) => event.type === "model:end");
  assert.deepEqual(endEvent.result, {
    text: "DONE",
    finishReason: "stop",
    usage: { totalTokens: 12 },
  });
});

test("runWhiteboardAgent passes Codex reasoning effort provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    streamTextFn: ({ providerOptions }) => ({
      consumeStream: async () => {
        assert.deepEqual(providerOptions, {
          openai: { reasoningEffort: "low", store: false, instructions: whiteboardSystemPrompt() },
        });
      },
    }),
  });
});

test("runWhiteboardAgent passes Codex fast mode provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        requestedModel: "gpt-5.5-fast",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
        serviceTier: "priority",
      },
    },
    streamTextFn: ({ providerOptions }) => ({
      consumeStream: async () => {
        assert.deepEqual(providerOptions, {
          openai: { reasoningEffort: "low", serviceTier: "priority", store: false, instructions: whiteboardSystemPrompt() },
        });
      },
    }),
  });
});

test("runWhiteboardAgent passes Codex instructions provider option", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    streamTextFn: ({ providerOptions, system }) => ({
      consumeStream: async () => {
        assert.equal(providerOptions.openai.instructions, system);
      },
    }),
  });
});

test("runWhiteboardAgent disables Codex response storage", async () => {
  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    streamTextFn: ({ providerOptions }) => ({
      consumeStream: async () => {
        assert.equal(providerOptions.openai.store, false);
      },
    }),
  });
});

test("runWhiteboardAgent uses streaming for Codex responses", async () => {
  let consumed = false;

  await runWhiteboardAgent({
    transcript: "hello",
    state: { elements: [], agentHistory: [] },
    wss: { clients: new Set() },
    options: {
      agentProvider: {
        provider: "codex",
        model: "gpt-5.5",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "test",
        reasoningEffort: "low",
      },
    },
    generateTextFn: async () => {
      throw new Error("Codex should use streamText");
    },
    streamTextFn: () => ({
      consumeStream: async () => {
        consumed = true;
      },
    }),
  });

  assert.equal(consumed, true);
});

function collectWebSocketMessages(url, count) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for ${count} websocket messages.`));
    }, 2000);

    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
      if (messages.length === count) {
        clearTimeout(timeout);
        ws.close();
        resolve(messages);
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForWebSocketMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for websocket message."));
    }, 2000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

test("caption engine settings come from the server catalog and reject unknown selections", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-model-settings-"));
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {}, readCodexAuth: () => null });
  await store.load();
  const activeState = { active: true };
  let providerStarts = 0;
  const { httpServer, url } = await startServer({
    host: "127.0.0.1", port: 0, moonshineModel: "medium", settingsStore: store,
    createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
    createSubtitleRealtimeManager: () => ({ _state: activeState, start() { providerStarts += 1; }, stop() {}, close() {}, sendAudio() {} }),
  });
  try {
    const config = await fetch(`${url}/api/config`).then((response) => response.json());
    assert.equal(config.captionModels, undefined, "the retired per-role model catalog is gone");
    assert.deepEqual(
      config.captionEngines.stt.map((entry) => `${entry.provider}:${entry.model}`),
      ["gemini:gemini-3.5-transcribe-live", "soniox:stt-rt-v5"],
    );
    assert.deepEqual(config.captionEngines.defaults, {
      stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
      translation: { provider: "gemini", model: "gemini-3.6-flash" },
      summary: { provider: "gemini", model: "gemini-3.6-flash" },
    });
    // Availability is reported, never the key itself.
    assert.equal(JSON.stringify(config.captionEngines).includes("apiKey"), false);
    assert.equal(config.captionEngines.stt.every((entry) => entry.available === false), true);

    const put = (subtitle) => fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ subtitle }),
    });

    // Retired per-role model fields and unknown provider/model pairs are refused.
    assert.equal((await put({ geminiTranscribeModel: "gemini-3.7-flash" })).status, 400);
    assert.equal((await put({ engine: { stt: { provider: "gemini", model: "gemini-9.9-imaginary", languageMode: "auto" } } })).status, 400);
    assert.equal((await put({ engine: { translation: { provider: "soniox", model: "stt-rt-v5" } } })).status, 400,
      "a combined translation engine cannot be paired with a Gemini STT engine");
    assert.deepEqual((await store.load()).subtitle.engine.stt, {
      provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto",
    });

    // A valid engine change is accepted even while a session is running: the
    // selection is picked up by the next channel restart.
    assert.equal((await put({ engine: { translation: { provider: "gemini", model: "gemini-3.7-flash" } } })).status, 200);
    const saved = await store.load();
    assert.equal(saved.subtitle.engine.translation.model, "gemini-3.7-flash");
    assert.equal(saved.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
    assert.equal(providerStarts, 0, "reading or saving settings never starts a paid session");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
