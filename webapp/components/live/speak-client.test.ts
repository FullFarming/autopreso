import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SpeakCaptureError,
  prepareSpeakCapture,
} from "./speak-client";
import { getSummaryPollDelayMilliseconds, MAX_POLLING_WALL_CLOCK_MS, startSummaryPollLoop } from "./meeting-summary-polling";
import { getSafeSummaryErrorMessage, shouldResetSummaryGeneration } from "./useHostSummaryLifecycle";
import { recordsMessages } from "../../lib/system-language/records-messages";
import { viewerMessages } from "../../lib/system-language/viewer-messages";

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

test("speaking level prefers a Web Audio analyser and cancels its animation frame on stop", async () => {
  const track = createTrack();
  const levels: number[] = [];
  let animationCallback: FrameRequestCallback | null = null;
  let cancelledFrame: number | null = null;
  let didDisconnectAnalyser = false;
  class FakeContext {
    state = "running";
    sampleRate = 16_000;
    destination = {};
    audioWorklet = { async addModule() {} };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 8,
        connect() {},
        disconnect() { didDisconnectAnalyser = true; },
        getByteTimeDomainData(samples: Uint8Array) {
          samples.fill(224);
        },
      };
    }
  }
  class FakeWorkletNode {
    port = { onmessage: null };
    constructor() {}
    disconnect() {}
  }
  const restore = [
    replaceGlobal("AudioContext", FakeContext),
    replaceGlobal("AudioWorkletNode", FakeWorkletNode),
    replaceGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationCallback = callback;
      return 17;
    }),
    replaceGlobal("cancelAnimationFrame", (frame: number) => { cancelledFrame = frame; }),
    replaceGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() { return { getTracks: () => [track] }; },
      },
    }),
  ];
  try {
    const prepared = await prepareSpeakCapture();
    const session = await prepared.start(new FakeSocket() as unknown as WebSocket, {
      onLevel(level) { levels.push(level); },
    });
    assert.ok(animationCallback);
    (animationCallback as FrameRequestCallback)(0);
    assert.ok((levels.at(-1) ?? 0) > 0.7);
    await session.stop();
    assert.equal(cancelledFrame, 17);
    assert.equal(didDisconnectAnalyser, true);
    assert.equal(levels.at(-1), 0);
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

test("participant floor capture is capability-gated and isolated from caption language sockets", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /viewer\.session\.participantSpeakingEnabled === true/u);
  assert.match(source, /prepareSpeakCapture/u);
  assert.match(source, /speakSocketRef/u);
  assert.match(source, /speak-start/u);
  assert.match(source, /speak-end/u);
  assert.doesNotMatch(source, /translated audio|Audio On|Audio Off/iu);
});

test("participant gateway authenticates and subscribes before captions become live", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const disconnectStart = source.indexOf("const disconnectGateway = useCallback");
  const connectStart = source.indexOf("const connectGateway = useCallback", disconnectStart);
  const handlerStart = source.indexOf("const handleEvent = useCallback", connectStart);
  assert.ok(disconnectStart >= 0 && connectStart > disconnectStart && handlerStart > connectStart);

  const connection = source.slice(connectStart, handlerStart);
  const authenticated = connection.indexOf('event.type === "authenticated"');
  const subscription = connection.indexOf('type: "subscribe"');
  const authentication = connection.indexOf('type: "authenticate"');
  const subscribed = connection.indexOf("await subscribed;");
  assert.ok(authenticated >= 0 && subscription > authenticated
    && authentication > subscription && subscribed > authentication,
    "caption readiness must follow authenticated subscription acknowledgement");
  assert.match(connection, /setStatus\("연결됨 · 실시간 자막 수신 중"\)/u);
});

test("participant proactive reconnect uses the authoritative status boundary", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const connectStart = source.indexOf("const connectGateway = useCallback");
  const connectEnd = source.indexOf("const handleEvent = useCallback", connectStart);
  assert.ok(connectStart >= 0 && connectEnd > connectStart);
  const connection = source.slice(connectStart, connectEnd);
  const proactiveStart = connection.indexOf("gatewayProactiveTimerRef.current = window.setTimeout");
  const proactiveEnd = connection.indexOf("}, 50 * 60 * 1_000);", proactiveStart);
  assert.ok(proactiveStart >= 0 && proactiveEnd > proactiveStart);
  const proactiveRefresh = connection.slice(proactiveStart, proactiveEnd);

  assert.match(proactiveRefresh, /scheduleReconnect\(\)/u);
  assert.doesNotMatch(proactiveRefresh, /installConnection\(/u,
    "the proactive timer must not wake the gateway before Vercel status reconciliation");
  assert.doesNotMatch(proactiveRefresh, /speaking|floor|microphone|audio/iu);
});

test("participant live controls expose capability-gated speaking without translated audio", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const renderStart = source.indexOf('<main className={`live-viewer-shell ${compact');
  const render = source.slice(renderStart, source.indexOf("</main>", renderStart));

  assert.match(render, /TranslationViewport|LanguageSelector|ControlDrawer/u);
  assert.match(render, /live-speak/u);
  assert.doesNotMatch(render, /Translated audio|Audio On|Audio Off/u);
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
  const end = source.indexOf("const leaveMeeting", start);
  assert.ok(start >= 0 && end > start);
  const changeLanguage = source.slice(start, end);
  const endedBranch = changeLanguage.indexOf("if (isSessionEnded)");
  const loadMinutes = changeLanguage.indexOf("loadMinutes(nextLanguage)", endedBranch);

  assert.ok(endedBranch >= 0, "ended records need a dedicated language-switch path");
  assert.ok(loadMinutes > endedBranch,
    "ended language switches must load the selected record");
  assert.doesNotMatch(changeLanguage, /subscribe\(/u,
    "language changes defer every gateway decision to the live-or-paused lifecycle gate");
});

test("minutes retry transcript independently after summary succeeds", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const effectStart = source.indexOf("// Contract C7: summaries are generated automatically after End");
  const effectEnd = source.indexOf("// 호스트가 라이브를 종료하면", effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  const effect = source.slice(effectStart, effectEnd);

  // A settled summary is either a record or an empty record; both leave the
  // transcript request as the only reason to keep polling.
  assert.match(effect, /\(summaryRecord \|\| isSummaryEmpty\) && isTranscriptLoaded/u,
    "a loaded summary must not stop retries while the transcript request is unresolved");
  assert.match(effect, /summaryRecord \|\| isSummaryEmpty \? "transcript" : isTranscriptLoaded \? "summary" : "both"/u,
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
  assert.match(source, /전체 자막을 불러오지 못했습니다/u);
  assert.match(source, /표시할 자막이 없습니다/u);
});

test("summary polling uses bounded jitter below the former 48 second ceiling", () => {
  assert.equal(getSummaryPollDelayMilliseconds(0, 0), 2_000);
  assert.equal(getSummaryPollDelayMilliseconds(0, 1), 2_500);
  assert.equal(getSummaryPollDelayMilliseconds(5, 0), 20_000);
  assert.equal(getSummaryPollDelayMilliseconds(5, 1), 25_000);
  assert.equal(getSummaryPollDelayMilliseconds(99, 2), 25_000, "attempt and jitter inputs must clamp");
  assert.ok(getSummaryPollDelayMilliseconds(5, 1) < 48_000);
});

test("summary polling fake timer stops after cleanup without scheduling another request", async () => {
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
  const hostLifecycle = readFileSync(new URL("./useHostSummaryLifecycle.ts", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const hostPollingStart = hostLifecycle.indexOf("const loadSummary");
  const hostPollingEnd = hostLifecycle.indexOf("const loadTranscript", hostPollingStart);
  assert.ok(hostPollingStart >= 0 && hostPollingEnd > hostPollingStart);
  const hostPolling = hostLifecycle.slice(hostPollingStart, hostPollingEnd);
  assert.match(hostPolling, /fetch\([\s\S]*\/summary\?language=/u);
  assert.match(hostPolling, /method: "GET"/u);
  assert.match(hostPolling, /cache: "no-store"/u);
  assert.doesNotMatch(hostPolling, /method: "POST"|generateSummaries/u);

  const hostRetryStart = hostLifecycle.indexOf("const retrySummary");
  const hostRetryEnd = hostLifecycle.indexOf("useEffect(() =>", hostRetryStart);
  assert.ok(hostRetryStart >= 0 && hostRetryEnd > hostRetryStart);
  const hostRetry = hostLifecycle.slice(hostRetryStart, hostRetryEnd);
  assert.match(hostRetry, /retryRef\.current/u);
  // Every failure class that polling cannot clear may now issue exactly one
  // reset-and-claim POST; the allowed set is named once, in the lifecycle.
  assert.match(hostRetry, /!shouldResetSummaryGeneration\(summaryFailureCode\)/u,
    "only a failure class that polling cannot clear may issue a recovery POST");
  assert.ok(hostRetry.indexOf("if (retryRef.current") < hostRetry.indexOf("method: \"POST\""),
    "the single-flight guard must run before the recovery request");
  assert.equal(hostRetry.match(/method: "POST"/gu)?.length, 1,
    "one operator Retry must have exactly one POST call site");
  assert.match(hostRetry, /headers: \{ "content-type": "application\/json" \}/u);
  assert.match(hostRetry, /body: JSON\.stringify\(\{ language, reset: true \}\)/u);
  assert.match(hostRetry, /if \(!payload\.ok\)[\s\S]*setSummaryFailureCode\(payload\.code \?\? ""\)/u,
    "a rejected recovery must retain the route code so the next click cannot lie about the state");
  assert.match(hostRetry, /setPollingRound\(\(round\) => round \+ 1\)/u,
    "a successful lease reclaim must restart GET polling");
  assert.ok(hostRetry.indexOf("await fetch") < hostRetry.indexOf("setPollingRound"),
    "GET polling may restart only after the recovery POST succeeds");
  assert.match(hostLifecycle, /export const SUMMARY_RESET_FAILURE_CODES = \[\s*\n\s*"SUMMARY_GENERATION_RETRYABLE_FAILED",\s*\n\s*"SUMMARY_GENERATION_PERMANENT_FAILED",\s*\n\s*"SUMMARY_GENERATION_EXHAUSTED",\s*\n\s*\] as const;/u);
  for (const pollableCode of ["SUMMARY_GENERATION_RUNNING", "SUMMARY_NOT_READY"]) {
    assert.doesNotMatch(hostLifecycle, new RegExp(`SUMMARY_RESET_FAILURE_CODES = \\[[^\\]]*${pollableCode}`, "su"),
      `${pollableCode} must keep polling instead of authorizing a recovery POST`);
  }
  assert.match(hostLifecycle, /shouldResetSummaryGeneration\(summaryFailureCode\)\) void retrySummary\(\)/u,
    "only the reset-eligible failure classes may invoke the recovery POST callback");
  assert.doesNotMatch(host, /Create summary again|Create AI summary|generateSummaries/u);
  assert.match(hostLifecycle, /startSummaryPollLoop/u);

  const retryStart = viewer.indexOf("onRetry={() => {");
  const retryEnd = viewer.indexOf("}} />", retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retry = viewer.slice(retryStart, retryEnd);
  assert.match(retry, /loadMinutes/u);
  assert.doesNotMatch(retry, /method: "POST"|\/summary`,\s*\{\s*method/u);
});

test("post-session errors map stable codes to Korean copy without exposing provider or model details", () => {
  const hostLifecycle = readFileSync(new URL("./useHostSummaryLifecycle.ts", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");

  assert.match(hostLifecycle, /function getSafeSummaryErrorMessage\(code: string \| undefined\)/u);
  assert.match(hostLifecycle, /SUMMARY_GENERATION_RETRYABLE_FAILED[\s\S]*회의 요약 생성이 지연되고 있습니다/u);
  assert.match(hostLifecycle, /SUMMARY_GENERATION_EXHAUSTED[\s\S]*회의 요약을 생성하지 못했습니다/u);
  assert.match(hostLifecycle, /SUMMARY_FORBIDDEN[\s\S]*회의 요약을 볼 권한이 없습니다/u);
  assert.match(hostLifecycle, /return "회의 요약을 불러오지 못했습니다\. 다시 시도해 주세요\."/u,
    "unknown summary codes must fail closed to a generic Korean message");
  assert.match(hostLifecycle, /function getSafeTranscriptErrorMessage\(code: string \| undefined\)/u);
  assert.match(hostLifecycle, /TRANSCRIPT_FORBIDDEN[\s\S]*전체 자막을 볼 권한이 없습니다/u);
  assert.match(hostLifecycle, /return "전체 자막을 불러오지 못했습니다\. 다시 확인해 주세요\."/u,
    "unknown transcript codes must fail closed to a generic Korean message");

  for (const source of [hostLifecycle, viewer]) {
    assert.doesNotMatch(source, /set(?:Summary|Transcript)Error\(payload\.error/u,
      "raw API errors must never reach the post-session UI");
    assert.doesNotMatch(source, /Unable to (?:load|retry) the (?:AI summary|transcript)/u);
  }
  assert.match(viewer, /const code = result\.error instanceof ApiRequestError \? result\.error\.code : undefined/u);
  assert.match(viewer, /getSafeSummaryErrorMessage\(code\)/u);
  assert.match(viewer, /getSafeTranscriptErrorMessage\(result\.error instanceof ApiRequestError \? result\.error\.code : undefined\)/u);

  const userFacingErrorAssignments = [hostLifecycle, viewer]
    .flatMap((source) => [...source.matchAll(/set(?:Summary|Transcript)Error\(([^\n;]+)\)/gu)])
    .map((match) => match[1] ?? "")
    .join("\n");
  assert.doesNotMatch(userFacingErrorAssignments, /gemini|provider|model/iu,
    "model and provider names must remain absent from user-facing error assignments");
});

test("host dashboard presents setup, invite, live, and ended as exclusive surfaces", () => {
  const host = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  const liveSurface = readFileSync(new URL("./quality/HostLiveSurface.tsx", import.meta.url), "utf8");

  assert.match(host, /import \{ resolveHostSurface \} from "\.\/host-surface"/u);
  assert.match(host, /data-host-surface=\{hostSurface\}/u);
  for (const surface of ["setup", "invite", "live", "ended"]) {
    assert.match(surface === "live" ? liveSurface : host, new RegExp(`data-host-surface-panel="${surface}"`, "u"));
    assert.match(surface === "live" ? liveSurface : host, new RegExp(`data-host-primary="${surface}"`, "u"));
  }
  assert.doesNotMatch(host, /\{isConfiguring &&/u,
    "configuration must not bypass the mutually exclusive surface resolver");
});

test("authoritative pending stays pollable beyond six rounds while hidden pages pause and repeated read errors stop", async () => {
  const timers: Array<() => void> = [];
  let reads = 0; let exhausted = 0; let hidden = false; let pending = true;
  const stop = startSummaryPollLoop({
    poll: async () => { reads += 1; return pending ? "pending" : true; },
    onExhausted: (reason) => { exhausted += 1; assert.equal(reason, "SUMMARY_READ_EXHAUSTED"); }, onError: () => assert.fail("unexpected error"),
    isHidden: () => hidden, random: () => 1,
    timerApi: { setTimeout: (callback, delay) => { assert.ok(delay <= 25_000); timers.push(callback); return timers.length; }, clearTimeout: () => {} },
  });
  const tick = async () => { const callback = timers.shift(); assert.ok(callback); callback(); await Promise.resolve(); await Promise.resolve(); };
  for (let round = 0; round < 16; round += 1) await tick();
  assert.equal(reads, 16); assert.equal(exhausted, 0);
  hidden = true; await tick(); assert.equal(reads, 16);
  hidden = false; pending = false;
  for (let round = 0; round < 6; round += 1) await tick();
  assert.equal(exhausted, 1); assert.equal(timers.length, 0); stop();
});

test("summary polling gives up with SUMMARY_GENERATION_STALLED once pending answers pass the 30 minute wall clock", async () => {
  assert.equal(MAX_POLLING_WALL_CLOCK_MS, 30 * 60_000);
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let nowMs = 1_000_000; let reads = 0; const reasons: string[] = [];
  startSummaryPollLoop({
    poll: async () => { reads += 1; return "pending"; },
    onExhausted: (reason) => { reasons.push(reason); }, onError: () => assert.fail("unexpected error"),
    isHidden: () => false, random: () => 0, now: () => nowMs,
    timerApi: { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout: () => {} },
  });
  const tick = async () => { const timer = timers.shift(); assert.ok(timer); nowMs += timer.delay; timer.callback(); await Promise.resolve(); await Promise.resolve(); };
  while (reasons.length === 0) { assert.ok(reads < 200, "the cap must trigger within a bounded number of polls"); await tick(); }
  assert.deepEqual(reasons, ["SUMMARY_GENERATION_STALLED"]);
  const elapsed = nowMs - 1_000_000;
  assert.ok(elapsed >= MAX_POLLING_WALL_CLOCK_MS && elapsed < MAX_POLLING_WALL_CLOCK_MS + 25_000, `stops at the cap, not a poll later (${elapsed})`);
  assert.equal(timers.length, 0, "no further poll is scheduled after the cap");

  // Both surfaces map the reason through the shared copy so the existing
  // "다시 확인" retry (a new pollingRound) restarts the clock.
  const hostLifecycle = readFileSync(new URL("./useHostSummaryLifecycle.ts", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  assert.match(hostLifecycle, /onExhausted: \(reason\) => \{[\s\S]*?setSummaryError\(getSafeSummaryErrorMessage\(reason\)\)/u);
  assert.match(viewer, /onExhausted: \(reason\) => \{[\s\S]*?setSummaryError\(getSafeSummaryErrorMessage\(reason\)\)/u);
  assert.equal(getSafeSummaryErrorMessage("SUMMARY_GENERATION_STALLED"), "요약 생성이 30분이 지나도 끝나지 않았습니다. 다시 확인해 주세요.");
  assert.equal(getSafeSummaryErrorMessage("SUMMARY_READ_EXHAUSTED"), "요약 상태 확인이 지연되고 있습니다. 다시 확인해 주세요.");
  assert.equal(shouldResetSummaryGeneration("SUMMARY_GENERATION_STALLED"), false, "retry re-polls; it does not reset the job");
  for (const language of ["ko", "en", "ja"] as const) {
    assert.ok(viewerMessages[language]["요약 생성이 30분이 지나도 끝나지 않았습니다. 다시 확인해 주세요."]?.trim(), `viewer ${language}`);
    assert.ok(recordsMessages[language]["요약 생성이 30분이 지나도 끝나지 않았습니다. 다시 확인해 주세요."]?.trim(), `records ${language}`);
  }
});
