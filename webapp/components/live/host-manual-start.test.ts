import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { createRequire } from "node:module";
import { resolveScheduledGatewayStart } from "./scheduled-gateway-start";

const dashboard = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
function mountManualStart(scheduledAt: string | null) {
  const now = Date.parse("2026-08-31T01:00:00Z");
  const runtime = { sessionId: "session-a", generation: 1, manualStartedAt: null as number | null, attemptedThrough: -1,
    hasGatewayStartedAck: false, hasAttemptedReattach: false, isCancelled: false, isFlightPending: false, pendingAction: null as string | null, hasWarmed: false };
  const results: Array<(value: boolean) => void> = [];
  const failures: Array<(reason: Error) => void> = [];
  const context = {
    session: { id: "session-a", status: "preparing", scheduledAt }, isBusy: false, isGlossaryPinPending: false,
    isAutomaticStartEnabled: false, isBroadcasting: false, scheduledStartNow: now, scheduledStartState: "countdown", error: "",
    isPageActiveRef: { current: true }, currentSessionIdRef: { current: "session-a" as string | null },
    manualRestartSessionIdRef: { current: null }, scheduledStartRuntimeRef: { current: runtime },
    getScheduledStartRuntime: () => runtime,
    Date: { now: () => now, parse: Date.parse }, calls: [] as boolean[],
    startBroadcast: (isUserInitiated = false) => { context.calls.push(isUserInitiated); return new Promise<boolean>((resolve, reject) => { results.push(resolve); failures.push(reject); }); },
    setIsAutomaticStartEnabled: (value: boolean) => { context.isAutomaticStartEnabled = value; },
    setScheduledStartNow: (value: number) => { context.scheduledStartNow = value; },
    setScheduledStartState: (value: string) => { context.scheduledStartState = value; },
    setGatewayStatus: () => undefined, setError: (value: string) => { context.error = value; },
    useCallback: (callback: () => void) => callback,
    useEffect: (callback: () => void) => { runEffect = callback; }, resolveScheduledGatewayStart,
  };
  let runEffect: () => void = () => undefined;
  vm.createContext(context);
  const begin = dashboard.indexOf("  const requestScheduledStart = useCallback(");
  const end = dashboard.indexOf("  const cancelScheduledStart", begin);
  assert.ok(begin > 0 && end > begin);
  const automaticBegin = dashboard.indexOf('  useEffect(() => {\n    if (!isPageActiveRef.current || !isAutomaticStartEnabled');
  assert.ok(automaticBegin > 0 && automaticBegin < begin);
  vm.runInContext(`${dashboard.slice(automaticBegin, end)}\nglobalThis.startManually = requestScheduledStart;`, context);
  const start = vm.runInContext("startManually", context) as () => void;
  return { context, runtime, start, runEffect: () => runEffect(), finish: async (value: boolean) => {
    assert.ok(results.length, "a start request should be pending"); results.shift()!(value); failures.shift(); await new Promise<void>(resolve => setImmediate(resolve));
  }, reject: async () => {
    assert.ok(failures.length, "a start request should be pending"); results.shift(); failures.shift()!(new Error("Connection failed")); await new Promise<void>(resolve => setImmediate(resolve));
  } };
}

test("future and unscheduled host sessions start immediately from a single manual action", async () => {
  for (const scheduledAt of ["2026-08-31T12:00:00Z", null]) {
    const h = mountManualStart(scheduledAt);
    h.start();
    assert.deepEqual(h.context.calls, [true]);
    assert.equal(h.runtime.attemptedThrough, 0);
    assert.equal(h.context.scheduledStartState, "connecting");
    h.start(); h.runEffect();
    assert.equal(h.context.calls.length, 1);
    await h.finish(true);
    assert.equal(h.runtime.hasGatewayStartedAck, true);
    assert.equal(h.context.scheduledStartState, "confirming");
    h.runEffect(); assert.equal(h.context.calls.length, 1);
  }
});

test("manual failure never triggers scheduled retries and remains explicitly retryable", async () => {
  const h = mountManualStart("2026-08-31T12:00:00Z");
  h.start(); await h.finish(false);
  assert.equal(h.context.isAutomaticStartEnabled, false);
  for (const delay of [2_000, 5_000, 10_000, 20_000, 60_000]) { h.context.scheduledStartNow += delay; h.runEffect(); }
  assert.equal(h.context.calls.length, 1);
  h.context.isAutomaticStartEnabled = true;
  h.context.session.status = "live";
  h.runEffect();
  assert.equal(h.context.calls.length, 1, "an old auto effect is synchronously fenced even if status becomes live");
  h.context.isAutomaticStartEnabled = false;
  h.context.session.status = "preparing";
  h.start(); assert.equal(h.context.calls.length, 2); await h.finish(true);
});

test("unexpected manual rejection also stops retries and restores the pending guard", async () => {
  const h = mountManualStart("2026-08-31T12:00:00Z");
  h.start(); await h.reject();
  assert.equal(h.context.isAutomaticStartEnabled, false);
  assert.equal(h.runtime.isCancelled, true);
  assert.equal(h.runtime.isFlightPending, false);
  assert.equal(h.context.error, "라이브를 시작하지 못했습니다.");
  h.context.isAutomaticStartEnabled = true;
  h.context.scheduledStartNow += 60_000;
  h.runEffect(); assert.equal(h.context.calls.length, 1);
});

test("busy, glossary, lifecycle, and terminal guards still prevent manual starts", () => {
  for (const guard of ["busy", "glossary", "inactive", "paused", "stopped"] as const) {
    const h = mountManualStart("2026-08-31T12:00:00Z");
    if (guard === "busy") h.context.isBusy = true;
    else if (guard === "glossary") h.context.isGlossaryPinPending = true;
    else if (guard === "inactive") h.context.isPageActiveRef.current = false;
    else h.context.session.status = guard;
    h.start(); assert.equal(h.context.calls.length, 0, guard);
  }
});

test("late manual completion cannot alter a different session generation", async () => {
  const h = mountManualStart("2026-08-31T12:00:00Z");
  h.start();
  h.runtime.generation += 1;
  await h.finish(true);
  assert.equal(h.runtime.hasGatewayStartedAck, false);
  assert.equal(h.context.scheduledStartState, "connecting");
});

test("a hidden page releases only its own flight and can be started manually after restoration", async () => {
  for (const result of [true, false, "reject"]) {
    const h = mountManualStart("2026-08-31T12:00:00Z");
    h.start();
    h.context.isPageActiveRef.current = false;
    h.context.currentSessionIdRef.current = null;
    if (result === "reject") await h.reject(); else await h.finish(Boolean(result));
    assert.equal(h.runtime.isFlightPending, false);
    assert.equal(h.runtime.pendingAction, null);
    assert.equal(h.context.scheduledStartState, "connecting", "hidden completion cannot update screen state");
    h.context.isPageActiveRef.current = true;
    h.context.currentSessionIdRef.current = "session-a";
    h.context.isAutomaticStartEnabled = true;
    h.context.scheduledStartNow += 5_000;
    for (const status of ["preparing", "live"]) {
      h.context.session.status = status;
      h.runEffect();
      assert.equal(h.context.calls.length, 1, `hidden ${String(result)} cannot restart from old auto ${status} effect`);
    }
    h.context.session.status = "preparing";
    h.context.isAutomaticStartEnabled = false;
    h.start(); assert.equal(h.context.calls.length, 2); await h.finish(true);
  }
});

test("automatic clock still waits for future schedule until the host explicitly starts", () => {
  const h = mountManualStart("2026-08-31T12:00:00Z");
  h.context.isAutomaticStartEnabled = true;
  h.runEffect();
  assert.equal(h.context.calls.length, 0);
  assert.equal(h.runtime.manualStartedAt, null);
});

test("connecting and confirming UI cannot imply it is waiting for a future scheduled time", () => {
  const source = readFileSync(new URL("./status/ScheduledGatewayCountdown.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = createRequire(import.meta.url);
  const deps: Record<string, unknown> = {
    "@/components/system-language/SystemLanguageProvider": { useSystemText: () => (key: string) => key },
    "@/lib/system-language/host-messages": { hostMessages: {} }, "./scheduled-gateway-countdown.module.css": { default: {} },
  };
  const output = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
  new Function("require", "module", "exports", code)((id: string) => deps[id] ?? require(id), output, output.exports);
  for (const state of ["connecting", "confirming", "action-required"]) {
    const html = renderToStaticMarkup(createElement(output.exports.ScheduledGatewayCountdown, { state, remainingMilliseconds: 3_600_000, onRetry() {}, onCancel() {} }));
    assert.doesNotMatch(html, /01:00:00|role="timer"/u, state);
  }
});
