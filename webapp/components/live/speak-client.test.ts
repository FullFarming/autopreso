import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

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

test("active speaking stop settles after releasing tracks even when AudioContext close never settles", async () => {
  const track = createTrack();
  let closeCount = 0;
  class FakeContext {
    state = "running";
    sampleRate = 16_000;
    destination = {};
    audioWorklet = { async addModule() { throw new Error("use processor"); } };
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; }
    close() {
      closeCount += 1;
      return new Promise<void>(() => {});
    }
  }
  const restore = [
    replaceGlobal("AudioContext", FakeContext),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() { return { getTracks: () => [track] }; } } }),
  ];
  try {
    const prepared = await prepareSpeakCapture();
    const session = await prepared.start(new FakeSocket() as unknown as WebSocket);
    const result = await Promise.race([
      session.stop().then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);
    assert.equal(result, "stopped");
    assert.equal(track.stopCount, 1);
    assert.equal(closeCount, 1);
    await session.stop();
    assert.equal(track.stopCount, 1);
    assert.equal(closeCount, 1);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("AudioContext close rejection is observable but does not reject or delay stop", async () => {
  const track = createTrack();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  class FakeContext {
    state = "running";
    resume() { return Promise.resolve(); }
    close() { return Promise.reject(new Error("close failed")); }
  }
  const restore = [
    replaceGlobal("AudioContext", FakeContext),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() { return { getTracks: () => [track] }; } } }),
  ];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    const prepared = await prepareSpeakCapture();
    await prepared.stop();
    await Promise.resolve();
    assert.equal(track.stopCount, 1);
    assert.deepEqual(warnings, ["[live-speak] AudioContext close failed"]);
  } finally {
    console.warn = originalWarn;
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("rapid stop during worklet preparation cannot resurrect capture resources", async () => {
  const track = createTrack();
  let releaseWorklet: (() => void) | undefined;
  let didCreateSource = false;
  let closeCount = 0;
  class FakeContext {
    state = "running";
    sampleRate = 16_000;
    destination = {};
    audioWorklet = { addModule: () => new Promise<void>((resolve) => { releaseWorklet = resolve; }) };
    resume() { return Promise.resolve(); }
    close() { closeCount += 1; return Promise.resolve(); }
    createMediaStreamSource() { didCreateSource = true; return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; }
  }
  const restore = [
    replaceGlobal("AudioContext", FakeContext),
    replaceGlobal("navigator", { mediaDevices: { async getUserMedia() { return { getTracks: () => [track] }; } } }),
  ];
  try {
    const prepared = await prepareSpeakCapture();
    const starting = prepared.start(new FakeSocket() as unknown as WebSocket);
    assert.ok(releaseWorklet);
    await prepared.stop();
    releaseWorklet();
    await assert.rejects(
      starting,
      (error: unknown) => error instanceof SpeakCaptureError && error.code === "AUDIO_INIT_FAILED",
    );
    assert.equal(didCreateSource, false);
    assert.equal(track.stopCount, 1);
    assert.equal(closeCount, 1);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("viewer releases UI and gateway floor before starting browser audio cleanup", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const endSpeaking = useCallback");
  const end = source.indexOf("speakSocketMessageRef.current", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.ok(body.indexOf('setSpeakState("idle")') < body.indexOf('type: "speak-end"'));
  assert.ok(body.indexOf('type: "speak-end"') < body.indexOf("stopSpeakCapture();"));
  assert.equal(body.includes("await stopSpeakCapture()"), false);
});

test("viewer enables Speak only after gateway authentication and subscription complete", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const disconnectStart = source.indexOf("const disconnectGateway = useCallback");
  const connectStart = source.indexOf("const connectGateway = useCallback", disconnectStart);
  const renderStart = source.indexOf('<div className="live-speak-bar">', connectStart);
  assert.ok(disconnectStart >= 0 && connectStart > disconnectStart && renderStart > connectStart);

  const disconnect = source.slice(disconnectStart, connectStart);
  const connection = source.slice(connectStart, renderStart);
  const subscribed = connection.indexOf("await subscribed;");
  const ready = connection.indexOf("setIsSpeakGatewayReady(true)");
  assert.ok(subscribed >= 0 && ready > subscribed,
    "Speak readiness must follow the authenticated subscription acknowledgement");
  assert.match(disconnect, /setIsSpeakGatewayReady\(false\)/u);
  assert.match(connection, /candidate\.addEventListener\("close"[\s\S]*setIsSpeakGatewayReady\(false\)/u);
});

test("viewer releases an active speaking turn before proactive socket replacement", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const connectStart = source.indexOf("const connectGateway = useCallback");
  const connectEnd = source.indexOf("const handleEvent = useCallback", connectStart);
  assert.ok(connectStart >= 0 && connectEnd > connectStart);
  const connection = source.slice(connectStart, connectEnd);
  const proactiveStart = connection.indexOf("audioProactiveTimerRef.current = window.setTimeout");
  const proactiveEnd = connection.indexOf("}, 50 * 60 * 1_000);", proactiveStart);
  assert.ok(proactiveStart >= 0 && proactiveEnd > proactiveStart);
  const proactiveRefresh = connection.slice(proactiveStart, proactiveEnd);

  assert.match(proactiveRefresh, /await endSpeaking\(true\)/u,
    "the old socket must release the floor and mic before it is replaced");
  assert.ok(proactiveRefresh.indexOf("await endSpeaking(true)") < proactiveRefresh.indexOf("installConnection()"),
    "floor release must precede opening the replacement connection");
  assert.match(connection, /\}, \[[^\]]*endSpeaking[^\]]*\]\);/u,
    "the reconnect callback must retain the current endSpeaking closure");
});

test("viewer exposes the connecting Speak state without changing its visual component", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const renderStart = source.indexOf('<div className="live-speak-bar">');
  const render = source.slice(renderStart, source.indexOf("</main>", renderStart));

  assert.match(render, /disabled=\{!language \|\| !isSpeakGatewayReady \|\| speakState === "starting"\}/u);
  assert.match(render, /aria-label=\{!language[\s\S]*"Speak unavailable until a language is selected"[\s\S]*!isSpeakGatewayReady[\s\S]*"Speak unavailable while connecting"/u);
  assert.match(render, /role="status" aria-live="polite"/u);
  assert.match(render, /aria-describedby="live-speak-connection-status"/u);
});

test("viewer keeps its last live status when operator-only translation health is unavailable", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const handlerStart = source.indexOf("const handleEvent = useCallback");
  const handlerEnd = source.indexOf("handleEventRef.current = handleEvent", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.doesNotMatch(source, /Language unavailable|Translation unavailable|번역을 (?:표시할|사용할) 수 없습니다/u);
  assert.match(handler, /event\.type === "session-status"[\s\S]*setStatus\(captionConnectionLabel\(event\.status\)\)/u);
  assert.match(handler, /event\.type === "language-status"[\s\S]*event\.status !== "unavailable"[\s\S]*setStatus\(captionConnectionLabel\(event\.status\)\)/u);
});

test("ended-session language changes reload minutes without reconnecting the gateway", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const changeLanguage = useCallback");
  const end = source.indexOf("const openPip", start);
  assert.ok(start >= 0 && end > start);
  const changeLanguage = source.slice(start, end);
  const endedBranch = changeLanguage.indexOf("if (isSessionEnded)");
  const loadMinutes = changeLanguage.indexOf("loadMinutes(nextLanguage)", endedBranch);
  const subscribe = changeLanguage.indexOf("subscribe(nextLanguage, viewer)");

  assert.ok(endedBranch >= 0, "ended records need a dedicated language-switch path");
  assert.ok(loadMinutes > endedBranch && loadMinutes < subscribe,
    "ended language switches must load records and return before gateway subscription");
});

test("minutes retry transcript independently after summary succeeds", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const effectStart = source.indexOf("// Contract C7: summaries are generated automatically after End");
  const effectEnd = source.indexOf("// 호스트가 라이브를 종료하면", effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  const effect = source.slice(effectStart, effectEnd);

  assert.match(effect, /summaryRecord && isTranscriptLoaded/u,
    "a loaded summary must not stop retries while the transcript request is unresolved");
  assert.match(effect, /summaryRecord \? "transcript" : isTranscriptLoaded \? "summary" : "both"/u,
    "the retry must request only the record resource that is still unresolved");
  assert.doesNotMatch(effect, /if \(!isSessionEnded \|\| summaryRecord\) return/u);
});

test("minutes Retry starts a fresh poll round after the previous round is exhausted", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const effectStart = source.indexOf("// Contract C7: summaries are generated automatically after End");
  const effectEnd = source.indexOf("// 호스트가 라이브를 종료하면", effectStart);
  const retryStart = source.indexOf("onRetry={() => {");
  const retryEnd = source.indexOf("}} />", retryStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart && retryStart >= 0 && retryEnd > retryStart);

  const effect = source.slice(effectStart, effectEnd);
  const retry = source.slice(retryStart, retryEnd);
  assert.match(effect, /minutesPollingRound/u,
    "the polling effect needs an explicit restart dependency after exhaustion");
  assert.match(retry, /setMinutesPollingRound\(\(round\) => round \+ 1\)/u,
    "Retry must start a new polling lifecycle even when SUMMARY_NOT_READY leaves summary state unchanged");
  assert.ok(retry.indexOf("setMinutesPollingRound") < retry.indexOf("loadMinutes"),
    "restart the poll lifecycle before issuing the immediate read-only retry");
});

test("meeting minutes distinguish transcript failure from a successful empty record", () => {
  const source = readFileSync(new URL("./MeetingMinutes.tsx", import.meta.url), "utf8");
  assert.match(source, /transcriptError/u);
  assert.match(source, /isTranscriptLoaded/u);
  assert.match(source, /Unable to load the transcript/u);
  assert.match(source, /No transcript is available/u);
});

function loadSummaryPollingUtilities(): {
  getSummaryPollDelayMilliseconds: (attempt: number, randomValue: number) => number;
  startSummaryPollLoop: (options: {
    poll: () => Promise<boolean>;
    onExhausted: () => void;
    onError: (error: unknown) => void;
    random: () => number;
    timerApi: {
      setTimeout: (callback: () => void, delayMilliseconds: number) => number;
      clearTimeout: (timer: number) => void;
    };
  }) => () => void;
} {
  const source = readFileSync(new URL("./MeetingMinutes.tsx", import.meta.url), "utf8");
  const start = source.indexOf("// ─── Summary Polling ───");
  const end = source.indexOf("// ─── Meeting Minutes ───", start);
  assert.ok(start >= 0 && end > start, "summary polling helpers must remain independently testable");
  const compiled = transpileModule(source.slice(start, end), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(compiled, { module, exports: module.exports, Math, Promise });
  return module.exports as ReturnType<typeof loadSummaryPollingUtilities>;
}

test("summary polling uses bounded jitter below the former 48 second ceiling", () => {
  const { getSummaryPollDelayMilliseconds } = loadSummaryPollingUtilities();
  assert.equal(getSummaryPollDelayMilliseconds(0, 0), 2_000);
  assert.equal(getSummaryPollDelayMilliseconds(0, 1), 2_500);
  assert.equal(getSummaryPollDelayMilliseconds(5, 0), 20_000);
  assert.equal(getSummaryPollDelayMilliseconds(5, 1), 25_000);
  assert.equal(getSummaryPollDelayMilliseconds(99, 2), 25_000, "attempt and jitter inputs must clamp");
  assert.ok(getSummaryPollDelayMilliseconds(5, 1) < 48_000);
});

test("summary polling fake timer stops after cleanup without scheduling another request", async () => {
  const { startSummaryPollLoop } = loadSummaryPollingUtilities();
  const timers = new Map<number, { callback: () => void; delayMilliseconds: number }>();
  const cleared: number[] = [];
  let nextTimer = 1;
  let pollCount = 0;
  const cleanup = startSummaryPollLoop({
    poll: async () => { pollCount += 1; return true; },
    onExhausted: () => assert.fail("cleanup must happen before exhaustion"),
    onError: (error) => assert.fail(String(error)),
    random: () => 0.5,
    timerApi: {
      setTimeout(callback, delayMilliseconds) {
        const timer = nextTimer;
        nextTimer += 1;
        timers.set(timer, { callback, delayMilliseconds });
        return timer;
      },
      clearTimeout(timer) {
        cleared.push(timer);
        timers.delete(timer);
      },
    },
  });

  assert.equal(timers.size, 1);
  const first = [...timers.entries()][0];
  assert.ok(first);
  assert.equal(first[1].delayMilliseconds, 2_250);
  timers.delete(first[0]);
  first[1].callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pollCount, 1);
  assert.equal(timers.size, 1, "a pending result schedules the next bounded retry");

  const pendingTimer = [...timers.keys()][0];
  cleanup();
  assert.deepEqual(cleared, [pendingTimer]);
  assert.equal(timers.size, 0);
  await Promise.resolve();
  assert.equal(pollCount, 1, "cleanup prevents any later poll");
});

test("host summary polling stays GET-only while the operator Retry performs one guarded recovery POST", () => {
  const host = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const hostPollingStart = host.indexOf("const loadHostSummary");
  const hostPollingEnd = host.indexOf("const retryHostSummary", hostPollingStart);
  assert.ok(hostPollingStart >= 0 && hostPollingEnd > hostPollingStart);
  const hostPolling = host.slice(hostPollingStart, hostPollingEnd);
  assert.match(hostPolling, /fetch\([\s\S]*\/summary\?language=/u);
  assert.match(hostPolling, /method: "GET"/u);
  assert.match(hostPolling, /cache: "no-store"/u);
  assert.doesNotMatch(hostPolling, /method: "POST"|generateSummaries/u);

  const hostRetryStart = host.indexOf("const retryHostSummary");
  const hostRetryEnd = host.indexOf("useEffect(() =>", hostRetryStart);
  assert.ok(hostRetryStart >= 0 && hostRetryEnd > hostRetryStart);
  const hostRetry = host.slice(hostRetryStart, hostRetryEnd);
  assert.match(hostRetry, /hostSummaryRetryRef\.current/u);
  assert.match(hostRetry, /hostSummaryFailureCode !== "SUMMARY_GENERATION_RETRYABLE_FAILED"/u,
    "only an explicitly retryable generation failure may issue a recovery POST");
  assert.ok(hostRetry.indexOf("if (hostSummaryRetryRef.current") < hostRetry.indexOf("method: \"POST\""),
    "the single-flight guard must run before the recovery request");
  assert.equal(hostRetry.match(/method: "POST"/gu)?.length, 1,
    "one operator Retry must have exactly one POST call site");
  assert.match(hostRetry, /headers: \{ "content-type": "application\/json" \}/u);
  assert.match(hostRetry, /body: JSON\.stringify\(\{ language \}\)/u);
  assert.match(hostRetry, /if \(!payload\.ok\)[\s\S]*setHostSummaryFailureCode\(payload\.code \?\? ""\)/u,
    "a rejected recovery must retain the route code so exhausted or permanent jobs cannot POST again");
  assert.match(hostRetry, /setHostSummaryPollingRound\(\(round\) => round \+ 1\)/u,
    "a successful lease reclaim must restart GET polling");
  assert.ok(hostRetry.indexOf("await fetch") < hostRetry.indexOf("setHostSummaryPollingRound"),
    "GET polling may restart only after the recovery POST succeeds");
  for (const blockedCode of [
    "SUMMARY_GENERATION_EXHAUSTED",
    "SUMMARY_GENERATION_PERMANENT_FAILED",
    "SUMMARY_GENERATION_RUNNING",
  ]) {
    assert.doesNotMatch(hostRetry, new RegExp(`hostSummaryFailureCode === ["']${blockedCode}["']`, "u"),
      `${blockedCode} must never authorize a recovery POST`);
  }
  assert.match(host, /hostSummaryFailureCode === "SUMMARY_GENERATION_RETRYABLE_FAILED"[\s\S]*?<button/u,
    "the operator Retry control is visible only for a retryable failure");
  assert.doesNotMatch(host, /Create summary again|Create AI summary|generateSummaries/u);
  assert.match(host, /startSummaryPollLoop/u);

  const retryStart = viewer.indexOf("onRetry={() => {");
  const retryEnd = viewer.indexOf("}} />", retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retry = viewer.slice(retryStart, retryEnd);
  assert.match(retry, /loadMinutes/u);
  assert.doesNotMatch(retry, /method: "POST"|\/summary`,\s*\{\s*method/u);
});
