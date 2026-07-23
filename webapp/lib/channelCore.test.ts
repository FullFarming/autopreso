import assert from "node:assert/strict";
import test from "node:test";

import { createTranslationChannel, type Transport, type TransportCtx } from "./channelCore";
import type { EngineEvent } from "./types";

type SocketListener = (event: { data?: string; code?: number; reason?: string }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  binaryType = "blob";
  private readonly listeners = new Map<string, SocketListener[]>();
  readonly sent: string[] = [];

  addEventListener(type: string, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: string) { this.sent.push(payload); }

  close() {
    this.readyState = 3;
  }

  emit(type: string, event: { data?: string; code?: number; reason?: string } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createEvidenceTransport(socket: FakeWebSocket): Transport {
  return {
    async connect() {
      return socket as unknown as WebSocket;
    },
    setupPayloads() {
      return [];
    },
    audioPayload(audio) {
      return audio;
    },
    handleMessage(raw: string, ctx: TransportCtx) {
      const event = JSON.parse(raw) as { sourceText: string; languageCode: string; translatedText: string };
      ctx.setSourceText(event.sourceText);
      ctx.rememberSourceTranscriptSnapshot(event.sourceText, "", event.languageCode);
      ctx.setTranslatedText(event.translatedText);
      ctx.emitPartial();
    },
  };
}

async function openChannel(targetLanguage: "ko" | "en") {
  const socket = new FakeWebSocket();
  const events: EngineEvent[] = [];
  const channel = createTranslationChannel({
    source: "mic",
    targetLanguage,
    transport: createEvidenceTransport(socket),
    settings: { tone: "natural", glossary: "", domain: "" },
    broadcast: (event) => events.push(event),
    polish: async ({ translatedText }) => translatedText,
  });
  channel.open();
  await Promise.resolve();
  socket.emit("open");
  return { channel, events, socket };
}

test("channel accepts English containing a Korean name, then suppresses switched Korean on a Korean target", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const { channel, events, socket } = await openChannel("ko");
    socket.emit("message", {
      data: JSON.stringify({
        sourceText: "We met 김민수 at the Seoul office yesterday",
        languageCode: "en-US",
        translatedText: "어제 서울 사무실에서 김민수를 만났습니다",
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        sourceText: "오늘 ADR과 GOP를 검토합니다",
        languageCode: "ko-KR",
        translatedText: "오늘 ADR과 GOP를 검토합니다",
      }),
    });

    assert.deepEqual(
      events.filter((event) => event.type === "partial").map((event) => event.translatedText),
      ["어제 서울 사무실에서 김민수를 만났습니다"],
    );
    await channel.close();
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("channel accepts Korean containing ADR/GOP, then suppresses switched English on an English target", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const { channel, events, socket } = await openChannel("en");
    socket.emit("message", {
      data: JSON.stringify({
        sourceText: "오늘 ADR과 GOP를 검토합니다",
        languageCode: "ko-KR",
        translatedText: "Today we will review ADR and GOP",
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        sourceText: "We will now review the hotel pipeline",
        languageCode: "en-US",
        translatedText: "We will now review the hotel pipeline",
      }),
    });

    assert.deepEqual(
      events.filter((event) => event.type === "partial").map((event) => event.translatedText),
      ["Today we will review ADR and GOP"],
    );
    await channel.close();
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("an abnormal channel failure retains the next shared frame through bounded reconnect", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    let connects = 0;
    const transport: Transport = {
      async connect() { return sockets[connects++] as unknown as WebSocket; },
      setupPayloads: () => [],
      audioPayload: (audio) => audio,
      handleMessage() {},
    };
    const channel = createTranslationChannel({
      source: "mic",
      targetLanguage: "ja",
      transport,
      settings: { tone: "natural", glossary: "", domain: "" },
      broadcast: () => {},
      polish: async ({ translatedText }) => translatedText,
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    channel.open();
    await Promise.resolve();
    sockets[0].emit("open");
    sockets[0].emit("close", { code: 1011, reason: "temporary" });
    channel.sendAudio("frame-after-failure");
    await new Promise((resolve) => setTimeout(resolve, 5));
    sockets[1].emit("open");
    assert.equal(connects, 2);
    assert.deepEqual(sockets[1].sent, ["frame-after-failure"]);
    await channel.close();
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("an abnormal close resets provider audio framing before reconnect", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    let connects = 0;
    let resets = 0;
    const transport: Transport = {
      async connect() { return sockets[connects++] as unknown as WebSocket; },
      setupPayloads: () => [],
      audioPayload: (audio) => audio,
      resetAudioInput() { resets += 1; },
      handleMessage() {},
    };
    const channel = createTranslationChannel({
      source: "mic",
      targetLanguage: "ja",
      transport,
      settings: { tone: "natural", glossary: "", domain: "" },
      broadcast: () => {},
      polish: async ({ translatedText }) => translatedText,
    });
    channel.open();
    await Promise.resolve();
    sockets[0].emit("open");
    sockets[0].emit("close", { code: 1011, reason: "temporary" });
    assert.equal(resets, 1);
    channel.sendAudio("new-generation-frame");
    await Promise.resolve();
    sockets[1].emit("open");
    await channel.close();
    assert.equal(resets, 2, "intentional stop must also discard an incomplete provider frame");
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("a warm pause can explicitly discard provider audio framing without closing its socket", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const socket = new FakeWebSocket();
    let resets = 0;
    const transport: Transport = {
      async connect() { return socket as unknown as WebSocket; },
      setupPayloads: () => [],
      audioPayload: (audio) => audio,
      resetAudioInput() { resets += 1; },
      handleMessage() {},
    };
    const channel = createTranslationChannel({
      source: "mic",
      targetLanguage: "ja",
      transport,
      settings: { tone: "natural", glossary: "", domain: "" },
      broadcast: () => {},
      polish: async ({ translatedText }) => translatedText,
    });
    channel.open();
    await Promise.resolve();
    socket.emit("open");
    channel.resetAudioInput();
    assert.equal(resets, 1);
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
    await channel.close();
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("setup buffering keeps only the newest short realtime audio window", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalNow = Date.now;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  let now = 1_000;
  Date.now = () => now;
  try {
    const socket = new FakeWebSocket();
    const transport: Transport = {
      requiresSetupAck: true,
      async connect() { return socket as unknown as WebSocket; },
      setupPayloads: () => [],
      audioPayload: (audio) => audio,
      handleMessage(_raw, ctx) { ctx.onTransportReady(); },
    };
    const channel = createTranslationChannel({
      source: "mic", targetLanguage: "ja", transport,
      settings: { tone: "natural", glossary: "", domain: "" },
      broadcast: () => {}, polish: async ({ translatedText }) => translatedText,
    });
    channel.open();
    await Promise.resolve();
    socket.emit("open");
    channel.sendAudio("stale");
    now += 800;
    for (let index = 0; index < 18_000; index += 1) channel.sendAudio(`fresh-${index}`);
    socket.emit("message", { data: "ready" });
    assert.deepEqual(socket.sent, Array.from({ length: 8 }, (_, index) => `fresh-${index + 17_992}`));
    await channel.close();
  } finally {
    Date.now = originalNow;
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("polish timeout emits raw finals in order and ignores late completion", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const socket = new FakeWebSocket();
    const events: EngineEvent[] = [];
    let releaseFirst: (() => void) | undefined;
    const transport: Transport = {
      async connect() { return socket as unknown as WebSocket; },
      setupPayloads: () => [], audioPayload: (audio) => audio,
      handleMessage(raw, ctx) {
        const value = JSON.parse(raw) as { text: string };
        ctx.commitSubtitle({ sourceText: "source", translatedText: value.text });
      },
    };
    const channel = createTranslationChannel({
      source: "mic", targetLanguage: "ko", transport,
      settings: { tone: "business", glossary: "", domain: "" },
      broadcast: (event) => events.push(event),
      polishTimeoutMs: 10,
      polish: async ({ translatedText }) => {
        if (translatedText === "first") await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return `P:${translatedText}`;
      },
    });
    channel.open();
    await Promise.resolve();
    socket.emit("open");
    socket.emit("message", { data: JSON.stringify({ text: "first" }) });
    socket.emit("message", { data: JSON.stringify({ text: "second" }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseFirst?.();
    await Promise.resolve();
    assert.deepEqual(events.filter((event) => event.type === "committed").map((event) => event.translatedText), ["first", "P:second"]);
    await channel.close();
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("identical stale partial snapshots coalesce until the text changes", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const socket = new FakeWebSocket();
    const events: EngineEvent[] = [];
    const transport: Transport = {
      async connect() { return socket as unknown as WebSocket; },
      setupPayloads: () => [], audioPayload: (audio) => audio,
      handleMessage(raw, ctx) {
        ctx.setSourceText("Hello there");
        ctx.rememberSourceTranscriptSnapshot("Hello there", "", "en-US");
        ctx.setTranslatedText(raw);
        ctx.emitPartial();
      },
    };
    const channel = createTranslationChannel({
      source: "mic", targetLanguage: "ko", transport,
      settings: { tone: "natural", glossary: "", domain: "" },
      broadcast: (event) => events.push(event), polish: async ({ translatedText }) => translatedText,
    });
    channel.open();
    await Promise.resolve();
    socket.emit("open");
    socket.emit("message", { data: "안녕하세요" });
    socket.emit("message", { data: "안녕하세요" });
    socket.emit("message", { data: "안녕하세요 여러분" });
    assert.deepEqual(events.filter((event) => event.type === "partial").map((event) => event.translatedText), ["안녕하세요", "안녕하세요 여러분"]);
    await channel.close();
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("connection rejection self-heals with bounded backoff and deliberate close cancels retries", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const socket = new FakeWebSocket();
    const attemptTimes: number[] = [];
    let attempts = 0;
    const transport: Transport = {
      async connect() {
        attemptTimes.push(Date.now());
        attempts += 1;
        if (attempts < 3) throw new Error("temporary");
        return socket as unknown as WebSocket;
      },
      setupPayloads: () => [], audioPayload: (audio) => audio, handleMessage() {},
    };
    const channel = createTranslationChannel({
      source: "mic", targetLanguage: "ko", transport,
      settings: { tone: "natural", glossary: "", domain: "" },
      broadcast: () => {}, polish: async ({ translatedText }) => translatedText,
      reconnectBaseMs: 5, reconnectMaxMs: 10,
    });
    channel.open();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(attempts, 3);
    assert.equal(attemptTimes[1] - attemptTimes[0] >= 4, true);
    assert.equal(attemptTimes[2] - attemptTimes[1] >= 8, true);
    socket.emit("open");
    await channel.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(attempts, 3);
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});

test("an immediately rejected socket close schedules rather than recursively reconnecting", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
  try {
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    let attempts = 0;
    const transport: Transport = {
      async connect() { return sockets[attempts++] as unknown as WebSocket; },
      setupPayloads: () => [], audioPayload: (audio) => audio, handleMessage() {},
    };
    const channel = createTranslationChannel({
      source: "mic", targetLanguage: "ko", transport,
      settings: { tone: "natural", glossary: "", domain: "" },
      broadcast: () => {}, polish: async ({ translatedText }) => translatedText,
      reconnectBaseMs: 10, reconnectMaxMs: 10,
    });
    channel.open();
    await Promise.resolve();
    sockets[0].emit("open");
    sockets[0].emit("close", { code: 1011, reason: "rejected" });
    assert.equal(attempts, 1, "close callback must not reconnect recursively");
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(attempts, 2);
    await channel.close();
  } finally {
    Object.assign(globalThis, { WebSocket: originalWebSocket });
  }
});
