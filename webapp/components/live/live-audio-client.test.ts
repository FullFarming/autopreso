import assert from "node:assert/strict";
import test from "node:test";
import type { HostDemandControl, HostMediaRuntime } from "./host-demand-control";
import type { SourceEvent } from "../../lib/live/source-contract";
import { createGeminiCaptionConfig } from "../../../packages/caption-core/gemini-caption-contract.js";
import { DEFAULT_ENGINE_SELECTION } from "../../../packages/caption-core/caption-engine-catalog.js";

test("host original callbacks accept only canonical same-meeting sources and fixed failure status", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldOpen = true;
  const restore = [replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("fetch", async () => new Response(null, { status: 204 })),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } })];
  const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
  const credentials = { token: "host-token", gatewayUrl: "wss://gateway.example.test/live", expiresAt: new Date(Date.now() + 900000).toISOString() };
  const sources: SourceEvent[] = [];
  const statuses: string[] = [];
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({ sessionId, version: 1, sessionType: "presentation", languages: ["ko", "en"],
      inputSource: "mic", outputMode: "captions", voiceProvider: "gemini", maxViewers: 50, glossaryPack: "general_cre", credentials,
      async refreshCredentials() { return credentials; }, onCaption() {}, onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
      onSource: (source) => sources.push(source), onSourceStatus: (status) => statuses.push(status) });
    const socket = FakeWebSocket.instances[0]; assert.ok(socket);
    const send = (event: object) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    const original: SourceEvent = { type: "source", sessionId, sourceSeq: 1, sourceUtteranceId: "11111111-1111-4111-8111-111111111111",
      utteranceKey: "canonical-source-1", text: "실제 원문", sourceLanguage: "ko", languageObservation: null,
      speaker: { role: "host", label: "호스트" }, isFinal: true, sourceStartedAt: null,
      sourceEndedAt: "2026-09-01T00:00:01.000Z", emittedAt: "2026-09-01T00:00:02.000Z" };
    send({ ...original, sourceText: "translation pretending to be original" });
    send({ ...original, sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f42" });
    send({ ...original, isFinal: false });
    send({ ...original, sourceSeq: 0 });
    assert.equal(sources.length, 0);
    send(original); send(original);
    assert.deepEqual(sources.map((source) => source.text), ["실제 원문"]);
    const unavailable = { type: "source-status", sessionId, status: "unavailable", code: "SOURCE_RECORDING_UNAVAILABLE" };
    send({ ...unavailable, code: "fake" }); send({ ...unavailable, sessionId: "other" }); send(unavailable);
    assert.deepEqual(statuses, ["unavailable"]);
    await client.stop(); send({ ...original, sourceSeq: 2 }); send(unavailable);
    assert.equal(sources.length, 1); assert.equal(statuses.length, 1);
  } finally { await client?.stop(); for (const reset of restore.reverse()) reset(); }
});

import {
  LiveAudioRecoveryError,
  startLiveAudioClient,
  type LiveAudioClient,
} from "./live-audio-client";

interface GatewayMessage {
  type: string;
  sessionId?: string;
  version?: number;
  activationKey?: string;
  sessionType?: string;
  languages?: string[];
  outputMode?: string;
  maxViewers?: number;
  glossaryPack?: string;
  inputSource?: string;
  demandEnabled?: boolean;
  captionConfig?: { engine: typeof DEFAULT_ENGINE_SELECTION; models: { transcription: string; summary: string; polish: string } };
}

test("web host start, update, reconnect and manual restart carry the session engine into every gateway captionConfig", async () => {
  FakeWebSocket.instances = []; FakeWebSocket.shouldOpen = true;
  const restore = [replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("fetch", async () => new Response(null, { status: 204 })),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } })];
  // The server hands the host the normalized `{ engine, engineHistory }`; the translation role
  // differs from the default so the test proves the whole engine travels, not just the model ids.
  const engine = { ...DEFAULT_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.7-flash" } };
  const preferences = { engine, engineHistory: [] };
  const credentials = { token: "host-token", gatewayUrl: "wss://gateway.example.test/live", expiresAt: new Date(Date.now() + 900000).toISOString() };
  const settings = { version: 2, sessionStatus: "live" as const, sessionType: "presentation" as const, languages: ["ko", "en"],
    outputMode: "captions" as const, voiceProvider: "gemini" as const, maxViewers: 50, glossaryPack: "general_cre" as const, modelPreferences: preferences };
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({ ...settings, sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", inputSource: "mic", credentials,
      refreshCredentials: async () => credentials, refreshSettings: async () => settings,
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {} });
    const first = FakeWebSocket.instances[0]; assert.ok(first);
    assert.deepEqual(first.messages.find((message) => message.type === "start")?.captionConfig?.engine, engine);
    await client.update({ ...settings, version: 3, modelPreferences: undefined });
    assert.deepEqual(first.messages.find((message) => message.type === "update")?.captionConfig?.engine, engine, "an update without preferences keeps the current engine");
    first.close();
    await waitUntil(() => FakeWebSocket.instances.some((socket) => socket !== first && socket.messages.some((message) => message.type === "start")));
    const second = FakeWebSocket.instances.at(-1); assert.ok(second);
    assert.deepEqual(second.messages.find((message) => message.type === "start")?.captionConfig?.engine, engine);
    await client.restart();
    const restart = second.messages.find((message) => message.type === "restart");
    assert.deepEqual(restart?.captionConfig?.engine, engine);
    assert.deepEqual(restart?.captionConfig?.models, { transcription: engine.stt.model, summary: engine.summary.model, polish: "gemini-3.7-flash" });
  } finally { await client?.stop(); for (const reset of restore.reverse()) reset(); }
});

test("invalid or legacy web model preferences fail before gateway warmup, sockets, or microphone capture", async () => {
  FakeWebSocket.instances = [];
  let externalCalls = 0;
  const restore = [replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("fetch", async () => { externalCalls += 1; return new Response(null, { status: 204 }); }),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() { externalCalls += 1; throw new Error("must not capture"); } } })];
  const options = { sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1, sessionType: "presentation", languages: ["en", "ko"],
    inputSource: "mic", outputMode: "captions", voiceProvider: "gemini", maxViewers: 50, glossaryPack: "general_cre",
    credentials: { token: "host-token", gatewayUrl: "wss://gateway.example.test/live", expiresAt: new Date(Date.now() + 900000).toISOString() },
    onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {} };
  try {
    // The server always normalizes to `{ engine, engineHistory }`, so the browser accepts nothing else -
    // not even the legacy per-role pin, and never an engine outside the catalog.
    for (const modelPreferences of [null, {}, { engine: null }, { engine: { stt: { provider: "nope", model: "x", languageMode: "auto" } } },
      { engine: DEFAULT_ENGINE_SELECTION, override: true }, { source: "gemini-3.5-transcribe-live", summary: "gemini-3.6-flash" }]) {
      await assert.rejects(() => Reflect.apply(startLiveAudioClient, undefined, [{ ...options, modelPreferences }]), /지원하지|올바르지/u);
    }
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(externalCalls, 0);
  } finally { for (const reset of restore.reverse()) reset(); }
});

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static ignoredReplyTypes = new Set<string>();
  static errorReplyTypes = new Set<string>();
  static shouldOpen = true;

  binaryType: BinaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  readonly messages: GatewayMessage[] = [];
  readonly binaryByteLengths: number[] = [];
  readonly url: string;
  closeCallCount = 0;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (!FakeWebSocket.shouldOpen || this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== "string") {
      const byteLength = data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data.byteLength : 0;
      this.binaryByteLengths.push(byteLength);
      return;
    }
    const message = JSON.parse(data) as GatewayMessage;
    this.messages.push(message);
    if (message.type === "authenticate") this.reply("authenticated");
    if (message.type === "start" && !FakeWebSocket.errorReplyTypes.has(message.type)) this.reply("started", {
      version: typeof message.version === "number" ? message.version + 1 : 1,
    });
    if (message.type === "restart" && !FakeWebSocket.errorReplyTypes.has(message.type)) this.reply("restarted", {
      version: typeof message.version === "number" ? message.version : 1,
    });
    if (message.type === "update") this.reply("updated");
    if (message.type === "pause"
      && !FakeWebSocket.ignoredReplyTypes.has(message.type)
      && !FakeWebSocket.errorReplyTypes.has(message.type)) this.reply("paused");
    if (message.type === "resume"
      && !FakeWebSocket.ignoredReplyTypes.has(message.type)
      && !FakeWebSocket.errorReplyTypes.has(message.type)) this.reply("resumed");
    if (FakeWebSocket.errorReplyTypes.has(message.type)) this.reply("error");
    if (message.type === "drain" && !FakeWebSocket.errorReplyTypes.has(message.type) && !FakeWebSocket.ignoredReplyTypes.has(message.type)) this.reply("drained", { sessionId: message.sessionId });
    if (message.type === "audioStreamEnd" && !FakeWebSocket.ignoredReplyTypes.has(message.type)) this.reply("audio-stream-ended");
    if (message.type === "stop" && !FakeWebSocket.ignoredReplyTypes.has(message.type)) this.reply("stopped");
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (typeof callback === "function") {
      const listeners = this.listeners.get(type) ?? new Set<EventListener>();
      listeners.add(callback);
      this.listeners.set(type, listeners);
    }
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (typeof callback === "function") this.listeners.get(type)?.delete(callback);
    super.removeEventListener(type, callback, options);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  close(): void {
    this.closeCallCount += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  private reply(type: string, payload: Record<string, unknown> = {}): void {
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, ...payload }) }));
    });
  }
}

class FakeAudioContext {
  static state: AudioContextState = "running";
  static resumeError: Error | null = null;
  static closeCount = 0;
  static suspendCount = 0;
  static resumeCount = 0;
  readonly audioWorklet = { async addModule(): Promise<void> {} };
  readonly state = FakeAudioContext.state;

  createMediaStreamSource(): { connect(): void } {
    return { connect() {} };
  }

  async resume(): Promise<void> {
    FakeAudioContext.resumeCount += 1;
    if (FakeAudioContext.resumeError) throw FakeAudioContext.resumeError;
  }

  async suspend(): Promise<void> { FakeAudioContext.suspendCount += 1; }

  async close(): Promise<void> { FakeAudioContext.closeCount += 1; }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port: { onmessage: ((event: MessageEvent<unknown>) => void) | null } = { onmessage: null };

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }
}

function replaceGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  };
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("테스트 WebSocket 재연결 시간이 초과됐습니다.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("first host socket performs one bounded same-origin health warmup with private fetch options", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldOpen = true;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const restore = [
    replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(null, { status: 204 });
    }),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() {} }] };
    } } }),
  ];
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
      glossaryPack: "general_cre",
      credentials: {
        token: "host-token", gatewayUrl: "wss://gateway.example.test:443/live",
        expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
      },
      async refreshCredentials() { throw new Error("not reached"); },
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
    });
    assert.equal(requests.length, 1);
    assert.equal(String(requests[0]?.input), "https://gateway.example.test/health");
    assert.equal(requests[0]?.init?.method, "GET");
    assert.equal(requests[0]?.init?.credentials, "omit");
    assert.equal(requests[0]?.init?.cache, "no-store");
    assert.equal(requests[0]?.init?.redirect, "manual");
    assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("invalid gateway URLs fail before health, WebSocket, media, or token dispatch", async () => {
  for (const gatewayUrl of [
    "ws://gateway.example.test/live",
    "wss://user:secret@gateway.example.test/live",
    "wss://gateway.example.test:8443/live",
    "wss://gateway.example.test/live?token=secret",
    "wss://gateway.example.test/live#fragment",
    "wss://gateway.example.test/live/",
    "wss://gateway.example.test/other",
  ]) {
    FakeWebSocket.instances = [];
    let fetchCount = 0;
    let mediaCount = 0;
    const restore = [
      replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
      replaceGlobal("fetch", async () => { fetchCount += 1; return new Response(); }),
      replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
        mediaCount += 1;
        return { getTracks: () => [{ stop() {} }] };
      } } }),
    ];
    try {
      await assert.rejects(startLiveAudioClient({
        sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
        sessionType: "presentation", languages: ["en"], inputSource: "mic",
        outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
        glossaryPack: "general_cre",
        credentials: { token: "host-token", gatewayUrl, expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString() },
        async refreshCredentials() { throw new Error("not reached"); },
        onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
      }), /gateway URL/u);
      assert.equal(fetchCount, 0);
      assert.equal(mediaCount, 0);
      assert.equal(FakeWebSocket.instances.length, 0);
    } finally {
      for (const restoreGlobal of restore.reverse()) restoreGlobal();
    }
  }
});

test("WebSocket open is bounded to twenty seconds and failed warmup remains best-effort", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldOpen = false;
  const observedTimeouts: number[] = [];
  const fakeWindow = {
    setTimeout(callback: () => void, delay: number) {
      observedTimeouts.push(delay);
      if (delay === 20_000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  };
  let trackStopCount = 0;
  const restore = [
    replaceGlobal("window", fakeWindow), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("fetch", async () => { throw new Error("health unavailable"); }),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
    } } }),
  ];
  try {
    await assert.rejects(startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
      glossaryPack: "general_cre",
      credentials: { token: "host-token", gatewayUrl: "wss://gateway.example.test/live", expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString() },
      async refreshCredentials() { throw new Error("not reached"); },
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
    }), /timed out/u);
    assert.equal(observedTimeouts.filter((delay) => delay === 20_000).length >= 1, true);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(FakeWebSocket.instances[0]?.messages.length, 0);
    assert.equal(trackStopCount, 1);
  } finally {
    FakeWebSocket.shouldOpen = true;
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("health warmup aborts at twenty seconds and still proceeds to the host socket", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldOpen = true;
  let didAbort = false;
  const fakeWindow = {
    setTimeout(callback: () => void, delay: number) {
      if (delay === 20_000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  };
  const restore = [
    replaceGlobal("window", fakeWindow), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { didAbort = true; reject(new DOMException("aborted", "AbortError")); });
    })),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() {} }] };
    } } }),
  ];
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
      glossaryPack: "general_cre",
      credentials: { token: "host-token", gatewayUrl: "wss://gateway.example.test/live", expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString() },
      async refreshCredentials() { throw new Error("not reached"); },
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
    });
    assert.equal(didAbort, true);
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("concurrent initial connects share one warmup and credential rotation does not repeat it", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldOpen = true;
  let fetchCount = 0;
  let resolveWarmup: (response: Response) => void = () => undefined;
  const warmupResponse = new Promise<Response>((resolve) => { resolveWarmup = resolve; });
  const restore = [
    replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("fetch", async () => { fetchCount += 1; return warmupResponse; }),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() {} }] };
    } } }),
  ];
  const credentials = {
    token: "host-token", gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  const clients: LiveAudioClient[] = [];
  const createClient = () => startLiveAudioClient({
    sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
    sessionType: "presentation" as const, languages: ["en"], inputSource: "mic" as const,
    outputMode: "captions" as const, voiceProvider: "gemini" as const, maxViewers: 50,
    glossaryPack: "general_cre" as const, credentials,
    async refreshCredentials() { return credentials; },
    onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
  });
  try {
    const pendingClients = [createClient(), createClient()];
    await waitUntil(() => fetchCount === 1);
    resolveWarmup(new Response(null, { status: 204 }));
    clients.push(...await Promise.all(pendingClients));
    FakeWebSocket.instances[0]?.close();
    await waitUntil(() => FakeWebSocket.instances.length === 3);
    assert.equal(fetchCount, 1);
  } finally {
    await Promise.all(clients.map((client) => client.stop()));
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("leaving the host screen detaches once without stopping the saved session", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldOpen = true;
  FakeAudioContext.closeCount = 0;
  let trackStopCount = 0;
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
    } } }),
  ];
  const credentials = {
    token: "host-token", gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
      glossaryPack: "general_cre", credentials, async refreshCredentials() { return credentials; },
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    await Promise.all([client.disconnect(), client.disconnect()]);
    await client.stop();
    assert.equal(socket.messages.filter((message) => message.type === "detach").length, 1);
    assert.equal(socket.messages.some((message) => message.type === "stop" || message.type === "audioStreamEnd"), false);
    assert.equal(socket.closeCallCount, 1);
    assert.equal(trackStopCount, 1);
    assert.equal(FakeAudioContext.closeCount, 1);
    assert.equal(socket.listenerCount("close"), 0);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("explicit web host stop drains audio, receives a bounded gateway ack, then releases local media", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.ignoredReplyTypes.clear();
  FakeWebSocket.errorReplyTypes.clear();
  FakeAudioContext.closeCount = 0;
  let trackStopCount = 0;
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
    } } }),
  ];
  const credentials = {
    token: "host-token", gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  try {
    const client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
      glossaryPack: "general_cre", credentials, async refreshCredentials() { return credentials; },
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    await client.stop();
    assert.deepEqual(socket.messages.slice(-2).map((message) => message.type), ["audioStreamEnd", "stop"]);
    assert.equal(socket.closeCallCount, 1);
    assert.equal(trackStopCount, 1);
    assert.equal(FakeAudioContext.closeCount, 1);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("pause and resume reuse the authenticated socket without releasing local media", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.ignoredReplyTypes.clear();
  FakeWebSocket.errorReplyTypes.clear();
  FakeAudioContext.closeCount = 0;
  FakeAudioContext.suspendCount = 0;
  FakeAudioContext.resumeCount = 0;
  let trackStopCount = 0;
  const restore = [
    replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
    } } }),
  ];
  const credentials = {
    token: "host-token", gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  try {
    const client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
      glossaryPack: "general_cre", credentials, async refreshCredentials() { return credentials; },
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    await client.pause();
    assert.equal(socket.messages.at(-1)?.type, "pause");
    assert.equal(FakeAudioContext.suspendCount, 1);
    assert.equal(socket.closeCallCount, 0);
    assert.equal(trackStopCount, 0);
    assert.equal(FakeAudioContext.closeCount, 0);
    await client.resume();
    assert.equal(socket.messages.at(-1)?.type, "resume");
    assert.equal(FakeAudioContext.resumeCount, 1);
    assert.equal(socket.closeCallCount, 0);
    assert.equal(trackStopCount, 0);
    await client.stop();
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("a rejected pause keeps capture suspended and retains the socket for recovery", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.ignoredReplyTypes.clear();
  FakeWebSocket.errorReplyTypes.clear();
  FakeWebSocket.errorReplyTypes.add("pause");
  FakeAudioContext.closeCount = 0;
  FakeAudioContext.suspendCount = 0;
  let trackStopCount = 0;
  const restore = [
    replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
    } } }),
  ];
  const credentials = {
    token: "host-token", gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
      glossaryPack: "general_cre", credentials, async refreshCredentials() { return credentials; },
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
    });
    await assert.rejects(client.pause(), /rejected/u);
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    assert.equal(FakeAudioContext.suspendCount, 1);
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
    assert.equal(socket.closeCallCount, 0);
    assert.equal(trackStopCount, 0);
    assert.equal(FakeAudioContext.closeCount, 0);
  } finally {
    FakeWebSocket.errorReplyTypes.clear();
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("pause fails closed locally when the gateway socket is unavailable", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.ignoredReplyTypes.clear();
  FakeWebSocket.errorReplyTypes.clear();
  FakeAudioContext.suspendCount = 0;
  const restore = [
    replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() {} }] };
    } } }),
  ];
  const credentials = {
    token: "host-token", gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
      glossaryPack: "general_cre", credentials, async refreshCredentials() { return credentials; },
      onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.close();
    await assert.rejects(client.pause(), /not connected/u);
    assert.equal(FakeAudioContext.suspendCount, 1);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("stop ack timeout or error still releases local media and attempts authenticated teardown", async () => {
  for (const failure of ["timeout", "error"] as const) {
    FakeWebSocket.instances = [];
    FakeWebSocket.ignoredReplyTypes.clear();
    FakeWebSocket.errorReplyTypes.clear();
    FakeAudioContext.closeCount = 0;
    let trackStopCount = 0;
    if (failure === "timeout") FakeWebSocket.ignoredReplyTypes.add("audioStreamEnd");
    else FakeWebSocket.errorReplyTypes.add("audioStreamEnd");
    const restore = [
      replaceGlobal("window", globalThis), replaceGlobal("WebSocket", FakeWebSocket),
      replaceGlobal("AudioContext", FakeAudioContext), replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
      replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
        return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
      } } }),
    ];
    const credentials = {
      token: "host-token", gatewayUrl: "wss://gateway.example.test/live",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
    };
    try {
      const client = await startLiveAudioClient({
        sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
        sessionType: "presentation", languages: ["en"], inputSource: "mic",
        outputMode: "captions", voiceProvider: "gemini", maxViewers: 50,
        glossaryPack: "general_cre", credentials, async refreshCredentials() { return credentials; },
        onStatus() {}, onError() {}, onSpeakers() {}, onLanguageStatus() {},
      });
      await client.stop();
      const socket = FakeWebSocket.instances[0];
      assert.ok(socket);
      assert.equal(socket.messages.some((message) => message.type === "stop"), true);
      assert.equal(trackStopCount, 1);
      assert.equal(FakeAudioContext.closeCount, 1);
      assert.equal(socket.closeCallCount, 1);
    } finally {
      for (const restoreGlobal of restore.reverse()) restoreGlobal();
    }
  }
  FakeWebSocket.ignoredReplyTypes.clear();
  FakeWebSocket.errorReplyTypes.clear();
});

test("concurrent disconnect signals share one reconnect and release the stale socket exactly once", async () => {
  FakeWebSocket.instances = [];
  FakeAudioContext.state = "running";
  FakeAudioContext.resumeError = null;
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    }),
  ];
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let refreshCount = 0;
  let client: LiveAudioClient | null = null;

  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 1,
      sessionType: "presentation",
      languages: ["en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      credentials,
      async refreshCredentials() {
        refreshCount += 1;
        return credentials;
      },
      onStatus() {},
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
    });

    const staleSocket = FakeWebSocket.instances[0];
    assert.ok(staleSocket);
    staleSocket.close();
    staleSocket.dispatchEvent(new Event("close"));
    await waitUntil(() => FakeWebSocket.instances.length === 2);

    assert.equal(refreshCount, 1);
    assert.equal(staleSocket.closeCallCount, 1);
    assert.equal(staleSocket.listenerCount("message"), 0);
    assert.equal(staleSocket.listenerCount("close"), 0);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("microphone permission denial returns a recoverable status without ending the Live Session", async () => {
  FakeWebSocket.instances = [];
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    }),
  ];

  try {
    await assert.rejects(
      startLiveAudioClient({
        sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
        version: 1,
        sessionType: "presentation",
        languages: ["en"],
        inputSource: "mic",
        outputMode: "captions",
        voiceProvider: "gemini",
        maxViewers: 50,
        glossaryPack: "general_cre",
        credentials: {
          token: "host-token",
          gatewayUrl: "wss://gateway.example.test/live",
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
        },
        async refreshCredentials() { throw new Error("not reached"); },
        onStatus() {},
        onError() {},
        onSpeakers() {},
        onLanguageStatus() {},
      }),
      (error: unknown) => error instanceof LiveAudioRecoveryError
        && error.status === "microphone-permission-required",
    );
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("blocked AudioContext resume returns a recoverable user-activation status", async () => {
  FakeWebSocket.instances = [];
  FakeAudioContext.state = "suspended";
  FakeAudioContext.resumeError = new DOMException("User activation required", "NotAllowedError");
  let trackStopCount = 0;
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
        },
      },
    }),
  ];

  try {
    await assert.rejects(
      startLiveAudioClient({
        sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
        version: 1,
        sessionType: "presentation",
        languages: ["en"],
        inputSource: "mic",
        outputMode: "captions",
        voiceProvider: "gemini",
        maxViewers: 50,
        glossaryPack: "general_cre",
        credentials: {
          token: "host-token",
          gatewayUrl: "wss://gateway.example.test/live",
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
        },
        async refreshCredentials() { throw new Error("not reached"); },
        onStatus() {},
        onError() {},
        onSpeakers() {},
        onLanguageStatus() {},
      }),
      (error: unknown) => error instanceof LiveAudioRecoveryError
        && error.status === "audio-user-activation-required",
    );
    assert.equal(trackStopCount, 1);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    FakeAudioContext.state = "running";
    FakeAudioContext.resumeError = null;
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("system capture failure after microphone capture stops the partial microphone stream", async () => {
  FakeWebSocket.instances = [];
  let microphoneStopCount = 0;
  const displayCaptureError = new DOMException("Screen selection cancelled", "AbortError");
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() { microphoneStopCount += 1; } }] };
        },
        async getDisplayMedia() {
          throw displayCaptureError;
        },
      },
    }),
  ];

  try {
    await assert.rejects(
      startLiveAudioClient({
        sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
        version: 1,
        sessionType: "presentation",
        languages: ["en"],
        inputSource: "both",
        outputMode: "captions",
        voiceProvider: "gemini",
        maxViewers: 50,
        glossaryPack: "general_cre",
        credentials: {
          token: "host-token",
          gatewayUrl: "wss://gateway.example.test/live",
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
        },
        async refreshCredentials() { throw new Error("not reached"); },
        onStatus() {},
        onError() {},
        onSpeakers() {},
        onLanguageStatus() {},
      }),
      (error: unknown) => error === displayCaptureError,
    );
    assert.equal(microphoneStopCount, 1);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("non-permission AudioContext resume failure preserves the original error", async () => {
  FakeWebSocket.instances = [];
  FakeAudioContext.state = "suspended";
  const resumeError = new DOMException("Audio device is unavailable", "InvalidStateError");
  FakeAudioContext.resumeError = resumeError;
  let trackStopCount = 0;
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
        },
      },
    }),
  ];

  try {
    await assert.rejects(
      startLiveAudioClient({
        sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
        version: 1,
        sessionType: "presentation",
        languages: ["en"],
        inputSource: "mic",
        outputMode: "captions",
        voiceProvider: "gemini",
        maxViewers: 50,
        glossaryPack: "general_cre",
        credentials: {
          token: "host-token",
          gatewayUrl: "wss://gateway.example.test/live",
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
        },
        async refreshCredentials() { throw new Error("not reached"); },
        onStatus() {},
        onError() {},
        onSpeakers() {},
        onLanguageStatus() {},
      }),
      (error: unknown) => error === resumeError,
    );
    assert.equal(trackStopCount, 1);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    FakeAudioContext.state = "running";
    FakeAudioContext.resumeError = null;
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("host reuses the original activation version and key across lost-ACK reconnects", async () => {
  FakeWebSocket.instances = [];
  FakeAudioWorkletNode.instances = [];
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    }),
  ];
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 4,
      sessionType: "presentation",
      languages: ["en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      credentials,
      async refreshCredentials() { return credentials; },
      onStatus() {},
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
    });

    const firstStart = FakeWebSocket.instances[0]?.messages.find((message) => message.type === "start");
    assert.ok(firstStart?.activationKey);
    assert.match(firstStart.activationKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(firstStart.version, 4);

    FakeWebSocket.instances[0]?.close();
    await waitUntil(() => FakeWebSocket.instances.length === 2
      && FakeWebSocket.instances[1]?.messages.some((message) => message.type === "start") === true);
    const reconnectStart = FakeWebSocket.instances[1]?.messages.find((message) => message.type === "start");
    assert.equal(reconnectStart?.activationKey, firstStart.activationKey);
    assert.equal(reconnectStart?.version, 4);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("cold live reattach omits activation key and uses the current live version", async () => {
  FakeWebSocket.instances = [];
  FakeAudioWorkletNode.instances = [];
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    }),
  ];
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 9,
      sessionType: "presentation",
      languages: ["en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      activationKey: null,
      credentials,
      async refreshCredentials() { return credentials; },
      onStatus() {},
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
    });
    const start = FakeWebSocket.instances[0]?.messages.find((message) => message.type === "start");
    assert.equal(start?.version, 9);
    assert.equal(Object.hasOwn(start ?? {}, "activationKey"), false);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("host sends the persisted session version on start, update, and reconnect", async () => {
  FakeWebSocket.instances = [];
  FakeAudioWorkletNode.instances = [];
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    }),
  ];
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let refreshCount = 0;
  let client: LiveAudioClient | null = null;

  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 4,
      sessionType: "presentation",
      languages: ["en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      domainText: "Company: NOVA\nEvent type: 글로벌 타운홀",
      credentials,
      async refreshCredentials() {
        refreshCount += 1;
        return credentials;
      },
      onStatus() {},
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
    });

    const firstSocket = FakeWebSocket.instances[0];
    assert.ok(firstSocket);
    assert.deepEqual(firstSocket.messages.find((message) => message.type === "start"), {
      captionConfig: createGeminiCaptionConfig({ languages: ["en"], glossaryPack: "general_cre", domainText: "Company: NOVA\nEvent type: 글로벌 타운홀" }),
      type: "start",
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 4,
      activationKey: firstSocket.messages.find((message) => message.type === "start")?.activationKey,
      sessionType: "presentation",
      languages: ["en"],
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      domainText: "Company: NOVA\nEvent type: 글로벌 타운홀",
      inputSource: "mic",
    });

    await client.update({
      version: 5,
      sessionType: "meeting",
      languages: ["ko", "en"],
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 24,
      glossaryPack: "hotel",
      domainText: "Company: NOVA\nAgenda 1: Global expansion",
    });
    assert.deepEqual(firstSocket.messages.find((message) => message.type === "update"), {
      captionConfig: createGeminiCaptionConfig({ languages: ["ko", "en"], glossaryPack: "hotel", domainText: "Company: NOVA\nAgenda 1: Global expansion" }),
      type: "update",
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 5,
      sessionType: "meeting",
      languages: ["ko", "en"],
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 24,
      glossaryPack: "hotel",
      domainText: "Company: NOVA\nAgenda 1: Global expansion",
      inputSource: "mic",
    });

    firstSocket.close();
    await waitUntil(() => FakeWebSocket.instances.length === 2
      && FakeWebSocket.instances[1]?.messages.some((message) => message.type === "start") === true);
    const reconnectStart = FakeWebSocket.instances[1]?.messages.find((message) => message.type === "start");
    const initialStart = firstSocket.messages.find((message) => message.type === "start");
    assert.equal(refreshCount, 1);
    assert.deepEqual(reconnectStart, {
      captionConfig: createGeminiCaptionConfig({ languages: ["ko", "en"], glossaryPack: "hotel", domainText: "Company: NOVA\nAgenda 1: Global expansion" }),
      type: "start",
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 4,
      activationKey: initialStart?.activationKey,
      sessionType: "meeting",
      languages: ["ko", "en"],
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 24,
      glossaryPack: "hotel",
      domainText: "Company: NOVA\nAgenda 1: Global expansion",
      inputSource: "mic",
    });
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("host forwards only fresh 40 ms PCM16 frames to the gateway", async () => {
  FakeWebSocket.instances = [];
  FakeAudioWorkletNode.instances = [];
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    }),
  ];
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 1,
      sessionType: "presentation",
      languages: ["en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      credentials,
      async refreshCredentials() { return credentials; },
      onStatus() {},
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
    });
    const socket = FakeWebSocket.instances[0];
    const worklet = FakeAudioWorkletNode.instances[0];
    assert.ok(socket);
    assert.ok(worklet?.port.onmessage);
    worklet.port.onmessage(new MessageEvent("message", {
      data: { type: "chunk", recordedAt: Date.now(), pcm: new ArrayBuffer(1_280) },
    }));
    worklet.port.onmessage(new MessageEvent("message", {
      data: { type: "chunk", recordedAt: Date.now(), pcm: new ArrayBuffer(3_200) },
    }));
    assert.deepEqual(socket.binaryByteLengths, [1_280]);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

for (const teardown of ["stop", "disconnect"] as const) {
test(`${teardown} while credentials refresh prevents a gateway session from being resurrected`, async () => {
  FakeWebSocket.instances = [];
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    }),
  ];
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  const refreshControl: { resolve?: (value: typeof credentials) => void } = {};
  let isRefreshPending = false;
  let client: LiveAudioClient | null = null;

  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 8,
      sessionType: "presentation",
      languages: ["en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      credentials,
      refreshCredentials() {
        isRefreshPending = true;
        return new Promise((resolve) => { refreshControl.resolve = resolve; });
      },
      onStatus() {},
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
    });

    FakeWebSocket.instances[0]?.close();
    await waitUntil(() => isRefreshPending);
    await client[teardown]();
    const finishRefresh = refreshControl.resolve;
    assert.ok(finishRefresh);
    finishRefresh(credentials);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});
}

test("host caption and status callbacks enforce session, configured-language, seq, and utterance fences across reconnect", async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldOpen = true;
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("fetch", async () => new Response(null, { status: 204 })),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    }),
  ];
  const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  const captions: Array<{ language: string; seq: number; text: string }> = [];
  const statuses: string[] = [];
  let client: LiveAudioClient | null = null;
  const caption = (overrides: Record<string, unknown>) => ({
    type: "caption",
    sessionId,
    language: "ko",
    seq: 1,
    utteranceKey: "utterance-1",
    speaker: null,
    text: "진행 중",
    isFinal: false,
    sourceEndedAt: "2026-08-15T00:00:01.000Z",
    emittedAt: "2026-08-15T00:00:01.100Z",
    ...overrides,
  });

  try {
    client = await startLiveAudioClient({
      sessionId,
      version: 1,
      sessionType: "presentation",
      languages: ["ko", "en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      credentials,
      async refreshCredentials() { return credentials; },
      onCaption(event) { captions.push({ language: event.language, seq: event.seq, text: event.text }); },
      onStatus(status) { statuses.push(status); },
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
    });
    statuses.length = 0;
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    const translationCapture = { kind: "independent-live-translation", streamGeneration: "10000000-0000-4000-8000-000000000001",
      captureEpoch: "10000000-0000-4000-8000-000000000002", captureStartedAt: null,
      captureEndedAt: "2026-08-15T00:00:01.000Z", finalization: "application-sentence-boundary" };
    for (const overrides of [
      { translationCapture: { ...translationCapture, captureEpoch: "malformed" }, sourceText: "Fake source", sourceLanguage: "en" },
      { translationCapture, sourceText: "Fake source" },
      { translationCapture, sourceLanguage: "en" },
      { translationCapture, origin: "source" },
      { translationCapture, authoritativeSourceId: "10000000-0000-4000-8000-000000000003" },
    ]) first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({
      text: "invalid provenance", translationStatus: "translated", isFinal: true, ...overrides,
    })) }));
    assert.equal(captions.length, 0, "invalid capture cannot advance the final cursor or reach the host UI");
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({})) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ sessionId: "other-session", text: "cross session" })) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ language: "ja", text: "not configured" })) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ seq: 0, text: "invalid seq" })) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ utteranceKey: "other-utterance", text: "identity collision" })) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ text: "확정", isFinal: true })) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ text: "duplicate final", isFinal: true })) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ language: "en", text: "Translation", isFinal: true, translationStatus: "translated", translationCapture, sourceText: null, sourceLanguage: null })) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session-status", sessionId: "other-session", status: "paused" }) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session-status", sessionId, status: "paused" }) }));
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "language-status", sessionId, language: "ja", status: "unavailable" }) }));

    assert.deepEqual(captions, [
      { language: "ko", seq: 1, text: "진행 중" },
      { language: "ko", seq: 1, text: "확정" },
      { language: "en", seq: 1, text: "Translation" },
    ]);
    assert.deepEqual(statuses, ["paused"]);

    first.close();
    await waitUntil(() => FakeWebSocket.instances.length === 2);
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ seq: 2, utteranceKey: "utterance-2", text: "stale socket" })) }));
    second.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(caption({ seq: 2, utteranceKey: "utterance-2", text: "new socket", isFinal: true })) }));
    assert.deepEqual(captions.at(-1), { language: "ko", seq: 2, text: "new socket" });
    assert.equal(captions.some(({ text }) => text === "stale socket"), false);
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("a 4410 REPLACED close never reconnects and surfaces the takeover for a manual restart", async () => {
  FakeWebSocket.instances = [];
  FakeAudioContext.state = "running";
  FakeAudioContext.resumeError = null;
  let trackStopCount = 0;
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
        },
      },
    }),
  ];
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  let replacedCount = 0;
  let refreshCount = 0;
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 1,
      sessionType: "presentation",
      languages: ["en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      credentials,
      async refreshCredentials() {
        refreshCount += 1;
        return credentials;
      },
      onStatus() {},
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
      onReplaced() { replacedCount += 1; },
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.readyState = FakeWebSocket.CLOSED;
    const closeEvent = new Event("close");
    Object.defineProperty(closeEvent, "code", { value: 4410 });
    socket.dispatchEvent(closeEvent);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(replacedCount, 1, "the takeover must surface exactly once");
    assert.equal(refreshCount, 0, "a replaced host must not refresh credentials");
    assert.equal(FakeWebSocket.instances.length, 1, "a replaced host must not open a reconnect socket");
    assert.ok(trackStopCount >= 1, "local capture must be released");
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("frames captured during a credential swap are spooled and flushed to the new socket", async () => {
  FakeWebSocket.instances = [];
  FakeAudioWorkletNode.instances = [];
  FakeAudioContext.state = "running";
  FakeAudioContext.resumeError = null;
  const restore = [
    replaceGlobal("window", globalThis),
    replaceGlobal("WebSocket", FakeWebSocket),
    replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    }),
  ];
  const credentials = {
    token: "host-token",
    gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
  const credentialGate: { release?: () => void } = {};
  let client: LiveAudioClient | null = null;
  try {
    client = await startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 1,
      sessionType: "presentation",
      languages: ["en"],
      inputSource: "mic",
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      credentials,
      async refreshCredentials() {
        await new Promise<void>((resolve) => { credentialGate.release = resolve; });
        return credentials;
      },
      onStatus() {},
      onError() {},
      onSpeakers() {},
      onLanguageStatus() {},
    });
    const staleSocket = FakeWebSocket.instances[0];
    const worklet = FakeAudioWorkletNode.instances[0];
    assert.ok(staleSocket);
    assert.ok(worklet?.port.onmessage);

    // The gateway drops the socket; reconnect starts and blocks on credentials.
    staleSocket.close();
    staleSocket.dispatchEvent(new Event("close"));
    await waitUntil(() => credentialGate.release !== undefined);

    // Speech continues during the swap: one fresh frame (spool) and one
    // already-stale frame (discard — the gateway would reject it anyway).
    worklet.port.onmessage(new MessageEvent("message", {
      data: { type: "chunk", recordedAt: Date.now(), pcm: new ArrayBuffer(1_280) },
    }));
    worklet.port.onmessage(new MessageEvent("message", {
      data: { type: "chunk", recordedAt: Date.now() - 2_000, pcm: new ArrayBuffer(1_280) },
    }));

    credentialGate.release?.();
    await waitUntil(() => FakeWebSocket.instances.length === 2);
    const replacement = FakeWebSocket.instances[1];
    await waitUntil(() => replacement.binaryByteLengths.length >= 1);

    assert.deepEqual(replacement.binaryByteLengths, [1_280], "only the fresh spooled frame is flushed");

    worklet.port.onmessage(new MessageEvent("message", {
      data: { type: "chunk", recordedAt: Date.now(), pcm: new ArrayBuffer(1_280) },
    }));
    assert.deepEqual(replacement.binaryByteLengths, [1_280, 1_280], "live frames resume on the new socket");
  } finally {
    await client?.stop();
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

function createDemandAudioHarness(control: Omit<HostDemandControl, "retryStart"> & Partial<Pick<HostDemandControl, "retryStart">>) {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldOpen = true;
  FakeWebSocket.ignoredReplyTypes.clear();
  FakeWebSocket.errorReplyTypes.clear();
  FakeAudioWorkletNode.instances = [];
  FakeAudioContext.state = "running";
  FakeAudioContext.resumeError = null;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  let healthRequests = 0;
  let refreshRequests = 0;
  let stoppedTracks = 0;
  const statuses: string[] = [];
  const errors: string[] = [];
  const track = { readyState: "live", stop() { stoppedTracks += 1; this.readyState = "ended"; } };
  const restore = [
    replaceGlobal("window", {
      setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id: number) { timers.delete(id); },
    }),
    replaceGlobal("WebSocket", FakeWebSocket), replaceGlobal("AudioContext", FakeAudioContext),
    replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode),
    replaceGlobal("fetch", async () => { healthRequests += 1; return new Response(null, { status: 204 }); }),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } }),
  ];
  const credentials = { token: "test-host-token", gatewayUrl: "wss://gateway.example.test/live",
    expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString() };
  const settings = { version: 1, sessionStatus: "live" as "preparing" | "live", sessionType: "presentation" as const, languages: ["en"],
    outputMode: "captions" as const, voiceProvider: "gemini" as const, maxViewers: 50, glossaryPack: "general_cre" as const };
  return {
    timers, statuses, errors, settings,
    healthRequests: () => healthRequests, refreshRequests: () => refreshRequests, stoppedTracks: () => stoppedTracks,
    start: (initial: Partial<Parameters<typeof startLiveAudioClient>[0]> = {}) => startLiveAudioClient({
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", version: 1,
      sessionType: "presentation", languages: ["en"], inputSource: "mic",
      outputMode: "captions", voiceProvider: "gemini", maxViewers: 50, glossaryPack: "general_cre", credentials,
      demandControl: { retryStart: async () => { throw new Error("unexpected retry"); }, ...control },
      async refreshSettings() { return { ...settings, languages: [...settings.languages] }; },
      async refreshCredentials() { refreshRequests += 1; return credentials; },
      onStatus(value) { statuses.push(value); }, onError(value) { errors.push(value); }, onSpeakers() {}, onLanguageStatus() {},
      ...initial,
    }),
    runDemandTimer() {
      const entry = [...timers].find(([, timer]) => timer.delay === 5_000);
      assert.ok(entry, "a demand poll must remain scheduled while the host waits");
      timers.delete(entry[0]); entry[1].callback();
    },
    emitFrame() {
      const worklet = FakeAudioWorkletNode.instances[0];
      assert.ok(worklet?.port.onmessage);
      worklet.port.onmessage(new MessageEvent("message", { data: { type: "chunk", recordedAt: Date.now(), pcm: new ArrayBuffer(1_280) } }));
    },
    restore() { for (const restoreGlobal of restore.reverse()) restoreGlobal(); },
  };
}

test("zero participant demand skips health and WS and discards idle PCM before waking on demand", async () => {
  let runtime: HostMediaRuntime = { enabled: true, state: "sleeping", hostSourceReady: true, hasDemand: false };
  const readiness: boolean[] = [];
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async (ready) => { readiness.push(ready); } });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    assert.equal(client.isWaitingForParticipants?.(), true);
    assert.equal(harness.healthRequests(), 0);
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.deepEqual(readiness, [true]);
    harness.emitFrame(); harness.emitFrame();
    runtime = { enabled: true, state: "waking", hostSourceReady: true, hasDemand: true };
    harness.runDemandTimer();
    await waitUntil(() => client?.isWaitingForParticipants?.() === false && harness.statuses.includes("Connected · broadcasting"));
    assert.equal(FakeWebSocket.instances.length, 1);
    const socket = FakeWebSocket.instances[0];
    assert.equal(harness.healthRequests(), 0, "demand activation must not prewarm Cloud Run through /health");
    assert.equal(harness.refreshRequests(), 1);
    assert.equal(socket.messages.find((message) => message.type === "start")?.demandEnabled, true);
    assert.deepEqual(socket.binaryByteLengths, [], "speech while waiting must not be replayed after wake");
    harness.emitFrame();
    assert.deepEqual(socket.binaryByteLengths, [1_280]);
    assert.deepEqual(harness.errors, []);
  } finally { await client?.stop(); harness.restore(); }
  assert.equal(readiness.at(-1), false);
  assert.equal(harness.stoppedTracks(), 1);
});

test("media-idle acknowledges then detaches without a reconnect timer or replay of waiting audio", async () => {
  let runtime: HostMediaRuntime = { enabled: true, state: "active", hostSourceReady: true, hasDemand: true };
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async () => {} });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "media-idle", sessionId: "unrelated", epoch: 7 }) }));
    assert.equal(client.isWaitingForParticipants?.(), false, "another session cannot stop this stream");
    runtime = { enabled: true, state: "sleeping", hostSourceReady: true, hasDemand: false };
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "media-idle", sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", epoch: 7 }) }));
    assert.equal(client.isWaitingForParticipants?.(), true);
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    assert.equal(socket.messages.filter((message) => message.type === "media-idle-ack").length, 1);
    assert.equal(socket.listenerCount("close"), 0);
    harness.emitFrame();
    socket.dispatchEvent(new Event("close"));
    assert.deepEqual([...harness.timers.values()].map(({ delay }) => delay), [5_000], "only control-plane polling may remain");
    harness.runDemandTimer();
    await waitUntil(() => harness.timers.size === 1);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(harness.refreshRequests(), 0);
    assert.deepEqual(socket.binaryByteLengths, []);
  } finally { await client?.stop(); harness.restore(); }
});

for (const blockedRead of [1, 2]) {
test(`stop during demand poll read ${blockedRead} prevents a late positive response from resurrecting its socket`, async () => {
  let shouldBlock = false;
  let pollReads = 0;
  const gate: { finish?: (value: HostMediaRuntime) => void } = {};
  const readiness: boolean[] = [];
  const sleeping: HostMediaRuntime = { enabled: true, state: "sleeping", hostSourceReady: true, hasDemand: false };
  const waking: HostMediaRuntime = { enabled: true, state: "waking", hostSourceReady: true, hasDemand: true };
  const harness = createDemandAudioHarness({
    async read() {
      if (!shouldBlock) return sleeping;
      pollReads += 1;
      if (pollReads === blockedRead) return new Promise((resolve) => { gate.finish = resolve; });
      return waking;
    },
    async setSourceReady(ready) { readiness.push(ready); },
  });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    shouldBlock = true;
    harness.runDemandTimer();
    await waitUntil(() => gate.finish !== undefined);
    await client.stop();
    const callsAfterStop = readiness.length;
    gate.finish?.(waking);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(harness.refreshRequests(), 0);
    assert.equal(harness.healthRequests(), 0);
    assert.equal(harness.timers.size, 0);
    assert.equal(readiness.length, callsAfterStop, "a resolved stale poll must not re-register the released microphone");
    assert.equal(readiness.at(-1), false);
  } finally { gate.finish?.(sleeping); await client?.stop(); harness.restore(); }
});
}

test("a failed demand read stops startup before WS or health and releases captured media", async () => {
  const harness = createDemandAudioHarness({ read: async () => { throw new Error("runtime denied"); }, setSourceReady: async () => {} });
  try {
    await assert.rejects(harness.start(), /runtime denied/u);
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(harness.healthRequests(), 0);
    assert.equal(harness.stoppedTracks(), 1);
  } finally { harness.restore(); }
});

test("a demand wake uses authoritative settings changed during zero-viewer waiting", async () => {
  let runtime: HostMediaRuntime = { enabled: true, state: "sleeping", hostSourceReady: true, hasDemand: false };
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async () => {} });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    harness.settings.version = 9;
    harness.settings.languages = ["en", "ko"];
    harness.settings.maxViewers = 100;
    runtime = { ...runtime, state: "waking", hasDemand: true };
    harness.runDemandTimer();
    await waitUntil(() => harness.statuses.includes("Connected · broadcasting"));
    const start = FakeWebSocket.instances[0].messages.find((message) => message.type === "start");
    assert.equal(start?.version, 9);
    assert.equal(start?.maxViewers, 100);
    assert.deepEqual(start?.languages, ["en", "ko"]);
  } finally { await client?.stop(); harness.restore(); }
});

test("explicit failed-runtime retry resets control but stays truthfully waiting without participants", async () => {
  let runtime: HostMediaRuntime = { enabled: true, state: "sleeping", hostSourceReady: true, hasDemand: false };
  let retries = 0;
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async () => {},
    retryStart: async () => { retries += 1; runtime = { ...runtime, state: "sleeping" }; } });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    runtime = { ...runtime, state: "failed" };
    harness.runDemandTimer();
    await waitUntil(() => harness.errors.length > 0);
    assert.equal(retries, 0, "polling must never reset a failed runtime automatically");
    await client.restart();
    assert.equal(retries, 1);
    assert.equal(client.isWaitingForParticipants?.(), true);
    assert.equal(FakeWebSocket.instances.length, 0);
    runtime = { ...runtime, state: "waking", hasDemand: true };
    harness.runDemandTimer();
    await waitUntil(() => harness.statuses.includes("Connected · broadcasting"));
    assert.equal(FakeWebSocket.instances.length, 1);
    const restart = FakeWebSocket.instances[0].messages.find((message) => message.type === "restart");
    assert.ok(restart, "a user retry while waiting must authorize exactly the next wake");
    assert.equal(restart.activationKey, undefined);
    assert.equal(restart.demandEnabled, true);
  } finally { await client?.stop(); harness.restore(); }
});

test("manual retry propagates a failed gateway start instead of reporting successful broadcasting", async () => {
  let runtime: HostMediaRuntime = { enabled: true, state: "sleeping", hostSourceReady: true, hasDemand: false };
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async () => {},
    retryStart: async () => { runtime = { ...runtime, state: "waking", hasDemand: true }; } });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    FakeWebSocket.errorReplyTypes.add("restart");
    await assert.rejects(client.restart());
    assert.equal(client.isWaitingForParticipants?.(), true);
    assert.equal(harness.statuses.includes("Connected · broadcasting"), false);
  } finally { await client?.stop(); harness.restore(); }
});

test("fatal gateway fences automatic retry; a closed-socket user restart uses a fresh version exactly once", async () => {
  const runtime: HostMediaRuntime = { enabled: true, state: "active", hostSourceReady: true, hasDemand: true };
  let retries = 0;
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async () => {},
    retryStart: async () => { retries += 1; } });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    const original = FakeWebSocket.instances[0];
    original.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "error", code: "PIPELINE_RESTART_REQUIRED", message: "수동 재시작 필요" }) }));
    original.close();
    assert.equal(harness.timers.size, 0, "fatal failure must cancel demand and transport retry timers");
    harness.settings.version = 12;
    await Promise.all([client.restart(), client.restart()]);
    assert.equal(retries, 1, "concurrent button clicks share one manual restart");
    assert.equal(FakeWebSocket.instances.length, 2);
    const restarted = FakeWebSocket.instances[1];
    const request = restarted.messages.find((message) => message.type === "restart");
    assert.equal(request?.version, 12);
    assert.equal(request?.activationKey, undefined);
    assert.equal(request?.demandEnabled, true);
    restarted.close();
    const timer = [...harness.timers].find(([, value]) => value.delay !== 5_000);
    assert.ok(timer);
    harness.timers.delete(timer[0]); timer[1].callback();
    await waitUntil(() => FakeWebSocket.instances.length === 3 && FakeWebSocket.instances[2].messages.some((message) => message.type === "start"));
    assert.equal(FakeWebSocket.instances[2].messages.some((message) => message.type === "restart"), false, "automatic recovery cannot replay a consumed manual intent");
  } finally { await client?.stop(); harness.restore(); }
});

test("initial-style manual-required error also disables automatic transport retry", async () => {
  const runtime: HostMediaRuntime = { enabled: true, state: "active", hostSourceReady: true, hasDemand: true };
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async () => {} });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    FakeWebSocket.instances[0].dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "error", code: "PROVIDER_UNAVAILABLE", requiresManualRestart: true, message: "수동 재시작 필요" }) }));
    FakeWebSocket.instances[0].close();
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.errors.at(-1), "수동 재시작 필요");
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally { await client?.stop(); harness.restore(); }
});

test("legacy host manual restart after a closed socket omits activation identity and uses refreshed settings", async () => {
  const harness = createDemandAudioHarness({ read: async () => ({ enabled: false }), setSourceReady: async () => {} });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    FakeWebSocket.instances[0].close();
    harness.settings.version = 14;
    await client.restart();
    assert.equal(FakeWebSocket.instances.length, 2);
    const restart = FakeWebSocket.instances[1].messages.find((message) => message.type === "restart");
    assert.equal(restart?.version, 14);
    assert.equal(restart?.activationKey, undefined);
    assert.equal(restart?.demandEnabled, undefined);
  } finally { await client?.stop(); harness.restore(); }
});

test("an explicit initial retry in preparing reuses readiness activation; an automatic initial connection still starts", async () => {
  for (const initialControl of ["start", "restart"] as const) {
    const harness = createDemandAudioHarness({ read: async () => ({ enabled: false }), setSourceReady: async () => {} });
    let client: LiveAudioClient | null = null;
    const activationKey = "11111111-1111-4111-8111-111111111111";
    try {
      harness.settings.sessionStatus = "preparing";
      harness.settings.version = 7;
      client = await harness.start({ initialControl, sessionStatus: "preparing", version: 7, activationKey });
      const request = FakeWebSocket.instances[0].messages.find((message) => message.type === initialControl);
      assert.equal(request?.activationKey, activationKey);
      assert.equal(request?.version, 7);
      assert.equal(FakeWebSocket.instances[0].messages.some((message) => message.type === (initialControl === "start" ? "restart" : "start")), false);
    } finally { await client?.stop(); harness.restore(); }
  }
});

test("a waiting preparing client retries failed provider startup with its activation key after fresh settings", async () => {
  let runtime: HostMediaRuntime = { enabled: true, state: "sleeping", hostSourceReady: true, hasDemand: false };
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async () => {},
    retryStart: async () => { runtime = { ...runtime, state: "waking", hasDemand: true }; } });
  let client: LiveAudioClient | null = null;
  try {
    harness.settings.sessionStatus = "preparing";
    harness.settings.version = 6;
    const activationKey = "11111111-1111-4111-8111-111111111111";
    client = await harness.start({ sessionStatus: "preparing", activationKey });
    await client.restart();
    const restart = FakeWebSocket.instances[0].messages.find((message) => message.type === "restart");
    assert.equal(restart?.activationKey, activationKey);
    assert.equal(restart?.version, 6);
  } finally { await client?.stop(); harness.restore(); }
});

test("an enabled demand session cannot silently downgrade to legacy mode after a flag change", async () => {
  let runtime: HostMediaRuntime = { enabled: true, state: "sleeping", hostSourceReady: true, hasDemand: false };
  const harness = createDemandAudioHarness({ read: async () => runtime, setSourceReady: async () => {} });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    runtime = { enabled: false };
    harness.runDemandTimer();
    await waitUntil(() => harness.errors.length > 0);
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(harness.refreshRequests(), 0);
    assert.equal(harness.healthRequests(), 0);
    assert.equal(harness.timers.size, 0);
    assert.equal(client.isWaitingForParticipants?.(), true);
  } finally { await client?.stop(); harness.restore(); }
});

test("host drains canonical source before end, blocks more PCM and leaves transport for post-DELETE stop", async () => {
  const harness = createDemandAudioHarness({ read: async () => ({ enabled: false }), setSourceReady: async () => {} });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    const before = socket.binaryByteLengths.length;
    await Promise.all([client.drain(), client.drain()]);
    harness.emitFrame();
    assert.equal(socket.binaryByteLengths.length, before);
    assert.equal(socket.messages.filter((message) => message.type === "drain").length, 1);
    assert.equal(socket.messages.some((message) => message.type === "stop"), false);
    assert.equal(socket.closeCallCount, 0);
    await client.stop();
    assert.equal(socket.messages.filter((message) => message.type === "stop").length, 1);
  } finally { await client?.stop(); harness.restore(); }
});

test("drain rejection prevents terminal caller progress and never retries the provider", async () => {
  const harness = createDemandAudioHarness({ read: async () => ({ enabled: false }), setSourceReady: async () => {} });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start();
    FakeWebSocket.errorReplyTypes.add("drain");
    let deleted = false;
    await assert.rejects(async () => { await client?.drain(); deleted = true; }, /gateway/u);
    assert.equal(deleted, false);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(FakeWebSocket.instances[0].messages.filter((message) => message.type === "drain").length, 1);
  } finally { FakeWebSocket.errorReplyTypes.clear(); await client?.stop(); harness.restore(); }
});

test("host end callback never deletes before drain or without fresh idle evidence", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const ts = await import("typescript");
  const source = await readFile(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const stopSession = useCallback(async () => {");
  const end = source.indexOf("  }, [resetHostSummaryLifecycle, session, stopBroadcast]);", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end).replace("  const stopSession = useCallback(async () => {", "async function runStop() {") + "\n}";
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const scenario of ["active", "sleeping", "preparing", "wrong-session", "drained", "drain-failed"]) {
    const operations: string[] = []; const errors: string[] = [];
    const noOp = () => {};
    const client = scenario.startsWith("drain") ? {
      async drain() { operations.push("drain"); if (scenario === "drain-failed") throw new Error("drain failed"); },
      async stop() { operations.push("stop"); },
    } : null;
    const context = {
      session: { id: "meeting", languages: ["ko", "en"] }, recoveryListGenerationRef: { current: 0 },
      recoveryAttemptSessionIdRef: { current: null }, audioClientRef: { current: client }, currentSessionIdRef: { current: "meeting" },
      setIsBusy: noOp, setError: (value: string) => errors.push(value), setIsEndConfirmVisible: noOp, resetHostSummaryLifecycle: noOp,
      setEndedSession: noOp, setSession: noOp, setAdmission: noOp, setInvite: noOp, setSpeakers: noOp, setParticipants: noOp,
      setHostSourceLedger: noOp, createHostSourceLedger: noOp, stopBroadcast: noOp, AbortSignal,
      fetch: async (_url: string, options: { method: string }) => { operations.push(options.method); return {
        id: scenario === "wrong-session" ? "other" : "meeting", status: scenario === "preparing" ? "preparing" : "live" }; },
      readResponse: async (value: unknown) => value,
      createHostDemandControl: () => ({ read: async () => ({ enabled: true, state: scenario === "sleeping" ? "sleeping" : "active" }) }),
    };
    const run: unknown = runInNewContext(`${code}\nrunStop`, context);
    assert.equal(typeof run, "function");
    if (typeof run !== "function") throw new Error("missing host end callback");
    await run();
    if (scenario === "drained") assert.deepEqual(operations, ["drain", "DELETE", "stop"]);
    else if (scenario === "sleeping" || scenario === "preparing") assert.deepEqual(operations, ["GET", "DELETE"]);
    else { assert.equal(operations.includes("DELETE"), false); assert.ok(errors.at(-1)); }
  }
});

test("drain ignores another meeting ACK and fails within its bounded deadline", async () => {
  const harness = createDemandAudioHarness({ read: async () => ({ enabled: false }), setSourceReady: async () => {} });
  let client: LiveAudioClient | null = null;
  try {
    client = await harness.start(); FakeWebSocket.ignoredReplyTypes.add("drain");
    const pending = client.drain(); const rejected = assert.rejects(pending, /timed out/u);
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "drained", sessionId: "other-meeting" }) }));
    const deadline = [...harness.timers].find(([, timer]) => timer.delay === 12_000);
    assert.ok(deadline, "cross-meeting ACK must not clear the deadline");
    deadline[1].callback(); await rejected;
    assert.equal(socket.messages.filter((message) => message.type === "drain").length, 1);
    assert.equal(socket.messages.some((message) => message.type === "stop"), false);
  } finally { FakeWebSocket.ignoredReplyTypes.clear(); await client?.stop(); harness.restore(); }
});
