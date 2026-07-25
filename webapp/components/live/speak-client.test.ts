import assert from "node:assert/strict";
import test from "node:test";

import {
  SpeakCaptureError,
  prepareSpeakCapture,
} from "./speak-client";

function replaceGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  };
}

function createTrack() {
  return {
    stopCount: 0,
    stop() { this.stopCount += 1; },
  };
}

class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  readonly frames: ArrayBuffer[] = [];
  send(frame: ArrayBuffer): void { this.frames.push(frame); }
}

test("prepare starts getUserMedia and resumes AudioContext in the same gesture turn", async () => {
  const calls: string[] = [];
  const track = createTrack();
  const streamResolver: { current?: (value: MediaStream) => void } = {};
  class FakeContext {
    state = "suspended";
    sampleRate = 48_000;
    destination = {};
    audioWorklet = { async addModule() {} };
    resume() {
      calls.push("resume");
      this.state = "running";
      return Promise.resolve();
    }
    close() { return Promise.resolve(); }
  }
  const restore = [
    replaceGlobal("AudioContext", FakeContext),
    replaceGlobal("navigator", {
      mediaDevices: {
        getUserMedia() {
          calls.push("getUserMedia");
          return new Promise<MediaStream>((resolve) => { streamResolver.current = resolve; });
        },
      },
    }),
  ];
  try {
    const preparing = prepareSpeakCapture();
    assert.deepEqual(calls, ["resume", "getUserMedia"]);
    assert.ok(streamResolver.current);
    streamResolver.current({ getTracks: () => [track] } as unknown as MediaStream);
    const prepared = await preparing;
    await prepared.stop();
    await prepared.stop();
    assert.equal(track.stopCount, 1, "prepared capture cleanup must be idempotent");
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("webkitAudioContext is supported when the standard constructor is absent", async () => {
  const track = createTrack();
  let didResume = false;
  class FakeWebkitContext {
    state = "suspended";
    sampleRate = 48_000;
    destination = {};
    audioWorklet = { async addModule() {} };
    resume() { didResume = true; this.state = "running"; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  const restore = [
    replaceGlobal("AudioContext", undefined),
    replaceGlobal("webkitAudioContext", FakeWebkitContext),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() { return { getTracks: () => [track] }; },
      },
    }),
  ];
  try {
    const prepared = await prepareSpeakCapture();
    assert.equal(didResume, true);
    await prepared.stop();
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("worklet loading failure falls back to ScriptProcessor and emits PCM frames plus levels", async () => {
  const track = createTrack();
  const processorRef: { current?: {
    onaudioprocess: ((event: AudioProcessingEvent) => void) | null;
    connect(): void;
    disconnect(): void;
  } } = {};
  class FakeContext {
    state = "running";
    sampleRate = 16_000;
    destination = {};
    audioWorklet = { async addModule() { throw new Error("blocked module"); } };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const value = { onaudioprocess: null, connect() {}, disconnect() {} };
      processorRef.current = value;
      return value;
    }
  }
  const restore = [
    replaceGlobal("AudioContext", FakeContext),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() { return { getTracks: () => [track] }; },
      },
    }),
  ];
  try {
    const prepared = await prepareSpeakCapture();
    const socket = new FakeSocket();
    const levels: number[] = [];
    const session = await prepared.start(socket as unknown as WebSocket, {
      onLevel(level) { levels.push(level); },
    });
    assert.ok(processorRef.current?.onaudioprocess);
    const samples = new Float32Array(640).fill(0.5);
    processorRef.current.onaudioprocess({
      inputBuffer: { getChannelData: () => samples },
    } as unknown as AudioProcessingEvent);
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0]?.byteLength, 1_280);
    assert.ok((levels[0] ?? 0) > 0.49);
    await session.stop();
    await session.stop();
    assert.equal(track.stopCount, 1);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("AudioWorkletNode construction failure also falls back to ScriptProcessor", async () => {
  let didCreateProcessor = false;
  class FakeContext {
    state = "running";
    sampleRate = 16_000;
    destination = {};
    audioWorklet = { async addModule() {} };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      didCreateProcessor = true;
      return { onaudioprocess: null, connect() {}, disconnect() {} };
    }
  }
  class BrokenWorkletNode {
    constructor() { throw new Error("worklet unavailable"); }
  }
  const restore = [
    replaceGlobal("AudioContext", FakeContext),
    replaceGlobal("AudioWorkletNode", BrokenWorkletNode),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() { return { getTracks: () => [createTrack()] }; },
      },
    }),
  ];
  try {
    const prepared = await prepareSpeakCapture();
    const session = await prepared.start(new FakeSocket() as unknown as WebSocket);
    assert.equal(didCreateProcessor, true);
    await session.stop();
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

for (const [name, code] of [
  ["NotAllowedError", "MIC_PERMISSION_DENIED"],
  ["NotFoundError", "MIC_DEVICE_NOT_FOUND"],
  ["NotReadableError", "MIC_DEVICE_BUSY"],
] as const) {
  test(`${name} is exposed as ${code}`, async () => {
    class FakeContext {
      state = "running";
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }
    const restore = [
      replaceGlobal("AudioContext", FakeContext),
      replaceGlobal("navigator", {
        mediaDevices: {
          async getUserMedia() {
            const error = new Error(name);
            Object.defineProperty(error, "name", { value: name });
            throw error;
          },
        },
      }),
    ];
    try {
      await assert.rejects(
        prepareSpeakCapture(),
        (error: unknown) => error instanceof SpeakCaptureError && error.code === code,
      );
    } finally {
      for (const restoreGlobal of restore.reverse()) restoreGlobal();
    }
  });
}

test("missing mediaDevices on an insecure page is classified separately", async () => {
  const restore = [
    replaceGlobal("isSecureContext", false),
    replaceGlobal("navigator", {}),
  ];
  try {
    await assert.rejects(
      prepareSpeakCapture(),
      (error: unknown) => error instanceof SpeakCaptureError && error.code === "MIC_INSECURE_CONTEXT",
    );
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("an AudioContext resume rejection is not misreported as microphone permission denial", async () => {
  const track = createTrack();
  class FakeContext {
    state = "suspended";
    resume() {
      const error = new Error("activation lost");
      Object.defineProperty(error, "name", { value: "NotAllowedError" });
      return Promise.reject(error);
    }
    close() { return Promise.resolve(); }
  }
  const restore = [
    replaceGlobal("AudioContext", FakeContext),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() { return { getTracks: () => [track] }; },
      },
    }),
  ];
  try {
    await assert.rejects(
      prepareSpeakCapture(),
      (error: unknown) => error instanceof SpeakCaptureError && error.code === "AUDIO_INIT_FAILED",
    );
    assert.equal(track.stopCount, 1);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});
