import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import test from "node:test";

import {
  SCHEDULED_START_RETRY_OFFSETS,
  canCancelScheduledGatewayStart,
  createScheduledGatewayStartTransport,
  getScheduledGatewayHealthUrl,
  resolveScheduledGatewayPrewarmLeadMilliseconds,
  resolveScheduledGatewayStart,
  warmScheduledGateway,
} from "./scheduled-gateway-start";

const scheduledAt = Date.parse("2026-08-16T01:00:00.000Z");

test("scheduled start stays web-only until T0 when prewarm is explicitly disabled", () => {
  const base = { scheduledAt, manualStartedAt: null, prewarmLeadMilliseconds: 0 as const,
    hasWarmed: false, attemptedThrough: -1, hasGatewayStartedAck: false,
    isCancelled: false, sessionStatus: "preparing" as const };
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt - 60_000 }), { action: "wait", delayMilliseconds: 60_000 });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt - 1 }), { action: "wait", delayMilliseconds: 1 });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt }), { action: "start", attemptIndex: 0 });
});

test("scheduled prewarm defaults to one hour and supports an explicit development opt-out", () => {
  assert.equal(resolveScheduledGatewayPrewarmLeadMilliseconds(undefined), 3_600_000);
  assert.equal(resolveScheduledGatewayPrewarmLeadMilliseconds("false"), 0);
  assert.equal(resolveScheduledGatewayPrewarmLeadMilliseconds("unexpected"), 3_600_000);
  assert.equal(resolveScheduledGatewayPrewarmLeadMilliseconds(" TRUE "), 3_600_000);
  const base = { scheduledAt, manualStartedAt: null, prewarmLeadMilliseconds: 3_600_000 as const,
    hasWarmed: false, attemptedThrough: -1, hasGatewayStartedAck: false, isCancelled: false,
    sessionStatus: "preparing" as const };
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt - 3_600_001 }), { action: "wait", delayMilliseconds: 1 });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt - 3_600_000 }), { action: "warm" });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt - 1, hasWarmed: true }), { action: "wait", delayMilliseconds: 1 });
});

test("T0 retries are bounded to 0, 2, 5, 10, and 20 seconds without replaying slept timers", () => {
  assert.deepEqual(SCHEDULED_START_RETRY_OFFSETS, [0, 2_000, 5_000, 10_000, 20_000]);
  const base = { scheduledAt, manualStartedAt: null, hasWarmed: true, hasGatewayStartedAck: false,
    isCancelled: false, sessionStatus: "preparing" as const };
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt, attemptedThrough: -1 }), { action: "start", attemptIndex: 0 });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt + 6_000, attemptedThrough: 0 }), { action: "start", attemptIndex: 2 });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt + 20_000, attemptedThrough: 2 }), { action: "start", attemptIndex: 4 });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt + 29_999, attemptedThrough: 4 }), { action: "wait", delayMilliseconds: 1 });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, now: scheduledAt + 30_000, attemptedThrough: 4 }), { action: "action-required" });
});

test("manual start is immediate while ACK, cancellation, replacement, and terminal states fence work", () => {
  const base = { now: scheduledAt - 300_000, scheduledAt, manualStartedAt: scheduledAt - 300_000,
    hasWarmed: false, attemptedThrough: -1, hasGatewayStartedAck: false, isCancelled: false,
    sessionStatus: "preparing" as const };
  assert.deepEqual(resolveScheduledGatewayStart(base), { action: "start", attemptIndex: 0 });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, hasGatewayStartedAck: true }), { action: "confirming" });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, isCancelled: true }), { action: "cancelled" });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, sessionStatus: "live" }), { action: "complete" });
  assert.deepEqual(resolveScheduledGatewayStart({ ...base, sessionStatus: "stopped" }), { action: "complete" });
});

test("Cancel is unavailable during an irreversible start flight or after ACK", () => {
  assert.equal(canCancelScheduledGatewayStart({
    isFlightPending: true, hasGatewayStartedAck: false, sessionStatus: "preparing",
  }), false);
  assert.equal(canCancelScheduledGatewayStart({
    isFlightPending: false, hasGatewayStartedAck: true, sessionStatus: "preparing",
  }), false);
  assert.equal(canCancelScheduledGatewayStart({
    isFlightPending: false, hasGatewayStartedAck: false, sessionStatus: "live",
  }), false);
  assert.equal(canCancelScheduledGatewayStart({
    isFlightPending: false, hasGatewayStartedAck: false, sessionStatus: "preparing",
  }), true);
});

test("health URL is exact HTTPS /health and rejects confused gateway URLs", () => {
  assert.equal(getScheduledGatewayHealthUrl("wss://gateway.example.test/live"), "https://gateway.example.test/health");
  for (const value of ["ws://gateway.example.test/live", "wss://gateway.example.test:8443/live",
    "wss://gateway.example.test/live?x=1", "wss://gateway.example.test/live#fragment",
    "wss://user@gateway.example.test/live", "wss://gateway.example.test/live/", "wss://gateway.example.test/other"]) {
    assert.throws(() => getScheduledGatewayHealthUrl(value));
  }
});

test("scheduled warmup reuses the canonical private bounded single flight", async () => {
  let requestCount = 0;
  let capturedInit: RequestInit | undefined;
  let resolveRequest: (response: Response) => void = () => undefined;
  const pendingResponse = new Promise<Response>((resolve) => { resolveRequest = resolve; });
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestCount += 1;
    capturedInit = init;
    return pendingResponse;
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } });
  try {
    const first = warmScheduledGateway("wss://scheduled-one.example.test/live");
    const second = warmScheduledGateway("wss://scheduled-one.example.test/live");
    await Promise.resolve();
    assert.equal(requestCount, 1);
    assert.equal(capturedInit?.credentials, "omit");
    assert.equal(capturedInit?.cache, "no-store");
    assert.equal(capturedInit?.redirect, "manual");
    assert.ok(capturedInit?.signal instanceof AbortSignal);
    resolveRequest(new Response(null, { status: 503 }));
    await Promise.all([first, second]);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("scheduled warmup aborts at twenty seconds without becoming authoritative", async () => {
  let observedDelay = 0;
  let didAbort = false;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        didAbort = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout(callback: () => void, delay: number) {
      observedDelay = delay;
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  } });
  try {
    await warmScheduledGateway("wss://scheduled-two.example.test/live");
    assert.equal(observedDelay, 20_000);
    assert.equal(didAbort, true);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("start transport keeps the server activation key in memory and sends only the immutable version", async () => {
  const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
  const activationKey = "0192d0f4-9f72-7a36-91f5-6a76ef736f42";
  const requests: Array<{ input: string; body: unknown }> = [];
  const transport = createScheduledGatewayStartTransport(async (input, init) => {
    requests.push({ input: String(input), body: JSON.parse(String(init?.body)) as unknown });
    return new Response(JSON.stringify({
      ok: true,
      data: { sessionId, status: "preparing", version: 7, activationKey },
    }), { headers: { "content-type": "application/json" } });
  });
  const [first, retry] = await Promise.all([
    transport.prepare(sessionId, 7),
    transport.prepare(sessionId, 99),
  ]);
  assert.deepEqual(requests, [
    { input: `/api/live-sessions/${sessionId}/start`, body: { version: 7 } },
  ]);
  assert.equal(first.activationKey, activationKey);
  assert.equal(retry.activationKey, activationKey);
  assert.deepEqual(transport.getFlight(sessionId), { activationKey, activationVersion: 7 });
});

test("host composes the shared countdown with keyboard Retry and Cancel plus lifecycle recomputation", () => {
  const host = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  const countdown = readFileSync(new URL("./status/ScheduledGatewayCountdown.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./status/scheduled-gateway-countdown.module.css", import.meta.url), "utf8");
  assert.match(host, /ScheduledGatewayCountdown/u);
  assert.match(host, /visibilitychange/u);
  assert.match(host, /pageshow/u);
  assert.match(host, /online/u);
  assert.match(countdown, /role="timer"/u);
  assert.match(countdown, /aria-live="polite"/u);
  assert.match(countdown, />\{t\("다시 시도"\)\}</u);
  assert.match(countdown, />\{t\("자동 시작 취소"\)\}</u);
  assert.match(styles, /min-height:\s*44px/u);
  assert.match(styles, /outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|gradient/iu);
});

test("host leaves activation keys to transport and adopts live only after gateway ACK plus authoritative refetch", () => {
  const host = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  const startFunction = host.slice(host.indexOf("const startBroadcast"), host.indexOf("/** Stage fast path"));
  assert.doesNotMatch(startFunction, /randomUUID|localStorage/u);
  const connectIndex = startFunction.indexOf("connectBroadcastWithRecovery(transportSession, activation,");
  const refetchIndex = startFunction.indexOf("fetch(`/api/live-sessions/${activeSession.id}`", connectIndex);
  const adoptIndex = startFunction.indexOf("mergePolledHostSession(current, authoritative)");
  assert.ok(connectIndex >= 0 && connectIndex < refetchIndex && refetchIndex < adoptIndex);
  assert.match(startFunction, /currentSessionIdRef\.current !== activeSession\.id/u);
  assert.match(host, /broadcastStartFlightRef/u);
  assert.match(host, /scheduledStartRuntimeRef/u);
  assert.match(host, /activationKey: activation\?\.activationKey/u);
  // 2026-08-22 handover contract: an already-live session presents the
  // SERVER-owned activation key so the gateway warm-reattaches the pipeline
  // (page reload and web↔Electron takeover share this path). The dashboard
  // still never mints keys locally — the doesNotMatch(randomUUID) above pins that.
  assert.match(startFunction, /activationKey: activeSession\.activationKey \?\? null/u);
  const orchestration = host.slice(host.indexOf("const scheduledTime = Date.parse"), host.indexOf("const requestScheduledStart"));
  assert.ok(orchestration.indexOf("if (runtime.isFlightPending)") < orchestration.indexOf("resolveScheduledGatewayStart({"),
    "a hanging irreversible flight must remain connecting instead of exposing Cancel");
});

test("dashboard initial fatal retry requires a user action and refreshes the preparing activation before restarting", async () => {
  const host = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  const source = host.slice(host.indexOf("const startBroadcast"), host.indexOf("/** Stage fast path"));
  const calls: Array<{ kind: string; version?: number; control?: string }> = [];
  const session = { id: "meeting-a", status: "preparing", version: 2 };
  let fetches = 0;
  const transport = {
    clear() { calls.push({ kind: "clear" }); },
    async prepare(_id: string, version: number) {
      calls.push({ kind: "prepare", version });
      return { status: "preparing", version, activationKey: "11111111-1111-4111-8111-111111111111" };
    },
    getFlight() { return undefined; },
  };
  const context = {
    useCallback: (callback: unknown) => callback, session,
    isPageActiveRef: { current: true }, currentSessionIdRef: { current: session.id },
    manualRestartSessionIdRef: { current: session.id },
    isBroadcasting: false, isGlossaryPinPending: false,
    broadcastStartFlightRef: { current: null }, scheduledStartTransportRef: { current: transport },
    audioClientRef: { current: null },
    setIsBusy() {}, setError() {}, setGatewayStatus() {}, setSession() {},
    AbortSignal,
    fetch: async () => { fetches += 1; return { id: session.id, status: fetches === 1 ? "preparing" : "live", version: fetches === 1 ? 7 : 8 }; },
    readResponse: async (value: unknown) => value,
    connectBroadcastWithRecovery: async (_session: unknown, activation: { activationVersion: number }, control: string) => {
      calls.push({ kind: "connect", version: activation.activationVersion, control }); return true;
    },
  };
  const compiled = ts.transpileModule(`${source}; startBroadcast;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  const start: (isUserInitiated?: boolean) => Promise<boolean> = vm.runInNewContext(compiled.outputText, context);
  assert.equal(await start(), false);
  assert.equal(calls.length, 0, "scheduled and automatic calls cannot consume manual recovery authority");
  const result = await Promise.all([start(true), start(true)]);
  assert.deepEqual(result, [true, true]);
  assert.deepEqual(calls.filter((call) => call.kind !== "clear"), [
    { kind: "prepare", version: 7 }, { kind: "connect", version: 7, control: "restart" },
  ]);
  assert.equal(fetches, 2);
  assert.equal(context.manualRestartSessionIdRef.current, null);
  assert.match(host, /onStart=\{\(\) => \{ void startBroadcast\(true\); \}\}/u);
});

test("countdown retry button dispatches one explicit manual retry instead of relying on automatic clock ticks", async () => {
  const host = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  const source = host.slice(host.indexOf("const requestScheduledStart"), host.indexOf("const cancelScheduledStart"));
  const runtime = { sessionId: "meeting-a", generation: 1, isFlightPending: false, pendingAction: null, hasGatewayStartedAck: false };
  const attempts: boolean[] = [];
  const context = {
    useCallback: (callback: unknown) => callback,
    session: { id: "meeting-a", status: "preparing" }, isBusy: false, isGlossaryPinPending: false,
    isPageActiveRef: { current: true }, currentSessionIdRef: { current: "meeting-a" }, scheduledStartRuntimeRef: { current: runtime },
    setScheduledStartState: () => undefined, setError: () => undefined, manualRestartSessionIdRef: { current: "meeting-a" },
    getScheduledStartRuntime: () => runtime, setIsAutomaticStartEnabled() {}, setScheduledStartNow() {},
    startBroadcast: async (isUserInitiated: boolean) => { attempts.push(isUserInitiated); return true; },
  };
  const compiled = ts.transpileModule(`${source}; requestScheduledStart;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  const retry: () => void = vm.runInNewContext(compiled.outputText, context);
  retry(); retry();
  assert.deepEqual(attempts, [true]);
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  assert.equal(runtime.isFlightPending, false);
  assert.equal(runtime.hasGatewayStartedAck, true);
});

test("viewer preparing remains on same-origin status polling and marks connected only after subscribe ACK", () => {
  const viewer = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  assert.match(viewer, /sessionStatus === "preparing" \? 2_500 : 10_000/u);
  assert.match(viewer, /shouldConnectViewerGateway\(sessionStatus, isSessionEnded\)/u);
  const subscribeIndex = viewer.indexOf("await subscribed;");
  const connectedIndex = viewer.indexOf('dispatchGatewayConnection({ type: "socket-opened"', subscribeIndex);
  assert.ok(subscribeIndex >= 0 && subscribeIndex < connectedIndex);
  assert.match(viewer, /setStatus\("연결됨 · 실시간 자막 수신 중"\)/u);
});

test("host and viewer keep truthful Korean gateway state in the top-right control", () => {
  const host = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const hostHeader = host.slice(host.indexOf('<header className="live-host-page-heading">'), host.indexOf("{error &&"));
  assert.match(hostHeader, /GatewayConnectionStatus state=\{hostConnectionState\}/u);
  assert.match(host, /scheduledStartState === "warming" \? "warming"/u);
  assert.match(host, /scheduledStartState === "connecting" \|\| scheduledStartState === "confirming"/u);
  assert.match(viewer, /<GatewayConnectionStatus state=\{gatewayConnectionState\}/u);
  assert.match(viewer, /sessionStatus === "preparing"/u);
});
