// @ts-nocheck - injected fakes for streamText/generateText return simplified shapes that don't satisfy the AI SDK return type.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { selectSubtitlePolishOptions, startServer } from "../src/server.js";
import { createSettingsStore, MAX_SUBTITLE_GLOSSARY_CHARS } from "../src/settings-store.js";
import { DEFAULT_ENGINE_SELECTION, GEMINI_ENGINE_SELECTION } from "../packages/caption-core/caption-engine-catalog.js";

function sameOriginHeaders(url, headers = {}) {
  return { origin: new URL(url).origin, ...headers };
}

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
    assert.equal(unrelated.status, 404, "the canvas application is served only by its independent project");
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
      const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {} });
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
  const saved = { apiKeys: { gemini: "test-caption-key" }, subtitle: { engine: GEMINI_ENGINE_SELECTION } };
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
    settingsStore: { load: async () => ({ transcription: { provider: "moonshine", moonshine: { model: "medium" }, openai: { model: "gpt-4o-transcribe" } }, subtitle: { engine: GEMINI_ENGINE_SELECTION } }), getSanitized: async () => ({ subtitle: { engine: GEMINI_ENGINE_SELECTION } }) },
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
        subtitle: { engine: GEMINI_ENGINE_SELECTION, geminiPolishModel: "gemini-3.5-flash" },
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
        subtitle: { engine: GEMINI_ENGINE_SELECTION, geminiPolishModel: "gemini-3.5-flash" },
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
        subtitle: { engine: GEMINI_ENGINE_SELECTION, geminiPolishModel: "gemini-3.5-flash" },
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
      saved: { apiKeys: { gemini: "AIza-live" }, subtitle: { engine: GEMINI_ENGINE_SELECTION } },
      env: {},
    }),
    { provider: "gemini", apiKey: "AIza-live", modelId: "gemini-3.6-flash", fallbackModels: ["gemini-3.5-flash-lite"] },
  );
});

test("subtitle:start validates runtime subtitle settings before opening providers", async () => {
  const { httpServer, url } = await startServer({
    resolveCaptionEngine: async () => GEMINI_ENGINE_SELECTION,
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
    resolveCaptionEngine: async () => GEMINI_ENGINE_SELECTION,
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
    resolveCaptionEngine: async () => GEMINI_ENGINE_SELECTION,
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
    const sameOriginResponse = await fetch(`${url}/api/subtitles/history/clear`, {
      method: "POST",
      headers: sameOriginHeaders(url),
    });
    assert.equal(sameOriginResponse.status, 200);

    const missingOriginResponse = await fetch(`${url}/api/subtitles/history/clear`, {
      method: "POST",
    });
    assert.equal(missingOriginResponse.status, 403);
    assert.deepEqual(await missingOriginResponse.json(), {
      ok: false,
      error: "허용되지 않은 요청 출처입니다.",
      code: "INVALID_ORIGIN",
    });

    const response = await fetch(`${url}/api/subtitles/history/clear`, {
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
      const confused = await fetch(`${url}/api/subtitles/history/clear`, {
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
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {} });
  await store.load();
  const activeState = { active: true };
  let providerStarts = 0;
  const { httpServer, url } = await startServer({
    host: "127.0.0.1", port: 0, moonshineModel: "medium", settingsStore: store,
    createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
    createSubtitleRealtimeManager: () => ({
      _state: activeState, start() { providerStarts += 1; }, stop() {}, close() {}, sendAudio() {},
      restartChannels: async () => true,
    }),
  });
  try {
    const config = await fetch(`${url}/api/config`).then((response) => response.json());
    assert.equal(config.captionModels, undefined, "the retired per-role model catalog is gone");
    assert.deepEqual(
      config.captionEngines.stt.map((entry) => `${entry.provider}:${entry.model}`),
      ["gemini:gemini-3.5-transcribe-live", "soniox:stt-rt-v5"],
    );
    assert.deepEqual(config.captionEngines.defaults, DEFAULT_ENGINE_SELECTION);
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
    assert.equal((await put({ engine: { translation: { provider: "gemini", model: "gemini-3.6-flash" } } })).status, 400,
      "Gemini translation cannot be paired with Soniox STT");
    assert.deepEqual((await store.load()).subtitle.engine.stt, DEFAULT_ENGINE_SELECTION.stt);

    // A valid engine change is accepted even while a session is running: the
    // selection is picked up by the next channel restart.
    assert.equal((await put({ engine: { ...GEMINI_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.7-flash" } } })).status, 200);
    const saved = await store.load();
    assert.equal(saved.subtitle.engine.translation.model, "gemini-3.7-flash");
    assert.equal(saved.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
    assert.equal(providerStarts, 0, "reading or saving settings never starts a paid session");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Active sessions retain their assigned engine and credentials until the host ends them.
test("saving an engine or key while captions run applies only to the next session", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-engine-hotswap-"));
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {} });
  await store.load();
  await store.save({ apiKeys: { soniox: "fixture-key" } });
  const calls = [];
  const fakeManager = {
    start: async () => {}, stop: async () => true, close() {}, sendAudio() {}, noteInputSignal() {},
    restartChannels: async (args) => { calls.push(args); return true; },
    _state: { active: true },
  };
  const { httpServer, url } = await startServer({
    host: "127.0.0.1", port: 0, moonshineModel: "medium", settingsStore: store,
    createTranscription: () => ({ ready: async () => {}, sendAudio() {}, stop() {}, close() {} }),
    createSubtitleRealtimeManager: () => fakeManager,
  });
  try {
    const response = await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({
        subtitle: {
          engine: {
            stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
            translation: { provider: "soniox", model: "stt-rt-v5" },
            summary: { provider: "gemini", model: "gemini-3.6-flash" },
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, []);

    const again = await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ subtitle: { fontSize: 40 } }),
    });
    assert.equal(again.status, 200);
    assert.equal(calls.length, 0, "unrelated settings do not restart the engine");

    // Credential rotation also applies at the next product session boundary.
    const rotated = await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ apiKeys: { soniox: "fixture-key-rotated" } }),
    });
    assert.equal(rotated.status, 200);
    assert.deepEqual(calls, []);

    // A key the selected engine does not use is still not a reason to restart.
    const unrelatedKey = await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ apiKeys: { openai: "sk-unrelated" } }),
    });
    assert.equal(unrelatedKey.status, 200);
    assert.equal(calls.length, 0, "a key no selected engine requires never restarts the channels");

    // Re-saving the SAME key value is not a change either.
    const sameKey = await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: sameOriginHeaders(url, { "content-type": "application/json" }),
      body: JSON.stringify({ apiKeys: { soniox: "fixture-key-rotated" } }),
    });
    assert.equal(sameKey.status, 200);
    assert.equal(calls.length, 0, "an unchanged key value never restarts the channels");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Soniox captions never request Gemini polish even when Gemini credentials exist", () => {
  const args = { tone: "business", glossary: "NOVA = NOVA", sourceText: "안녕", translatedText: "…", required: true };
  const saved = { apiKeys: { gemini: "fixture-key", geminiSecondary: "fixture-secondary" }, subtitle: { engine: DEFAULT_ENGINE_SELECTION } };
  assert.equal(selectSubtitlePolishOptions({ args, saved, env: {} }), null);
});
