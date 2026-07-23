import assert from "node:assert/strict";
import test from "node:test";

import { startLiveAudioClient, type LiveAudioClient } from "./live-audio-client";

interface GatewayMessage {
  type: string;
  sessionId?: string;
  version?: number;
  sessionType?: string;
  languages?: string[];
  outputMode?: string;
  maxViewers?: number;
  glossaryPack?: string;
  inputSource?: string;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  binaryType: BinaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  readonly messages: GatewayMessage[] = [];
  readonly binaryByteLengths: number[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
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
    if (message.type === "start") this.reply("started");
    if (message.type === "update") this.reply("updated");
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  private reply(type: string): void {
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type }) }));
    });
  }
}

class FakeAudioContext {
  readonly audioWorklet = { async addModule(): Promise<void> {} };

  createMediaStreamSource(): { connect(): void } {
    return { connect() {} };
  }

  async close(): Promise<void> {}
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
      type: "start",
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 4,
      sessionType: "presentation",
      languages: ["en"],
      outputMode: "captions",
      voiceProvider: "gemini",
      maxViewers: 50,
      glossaryPack: "general_cre",
      inputSource: "mic",
    });

    await client.update({
      version: 5,
      sessionType: "meeting",
      languages: ["ko", "en"],
      outputMode: "captions_audio",
      voiceProvider: "gemini",
      maxViewers: 24,
      glossaryPack: "hotel",
    });
    assert.deepEqual(firstSocket.messages.find((message) => message.type === "update"), {
      type: "update",
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 5,
      sessionType: "meeting",
      languages: ["ko", "en"],
      outputMode: "captions_audio",
      voiceProvider: "gemini",
      maxViewers: 24,
      glossaryPack: "hotel",
      inputSource: "mic",
    });

    firstSocket.close();
    await waitUntil(() => FakeWebSocket.instances.length === 2
      && FakeWebSocket.instances[1]?.messages.some((message) => message.type === "start") === true);
    const reconnectStart = FakeWebSocket.instances[1]?.messages.find((message) => message.type === "start");
    assert.equal(refreshCount, 1);
    assert.deepEqual(reconnectStart, {
      type: "start",
      sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
      version: 5,
      sessionType: "meeting",
      languages: ["ko", "en"],
      outputMode: "captions_audio",
      voiceProvider: "gemini",
      maxViewers: 24,
      glossaryPack: "hotel",
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
      outputMode: "audio",
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

test("stopping while credentials refresh prevents a gateway session from being resurrected", async () => {
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
    await client.stop();
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
