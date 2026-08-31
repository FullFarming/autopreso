import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  connectViewerGatewayOnce,
  createViewerGatewayConnectionGate,
  resetViewerGatewayConnectionGate,
  isCurrentViewerGatewayRequest,
  resolveViewerGatewayStatusDecision,
  shouldConnectViewerGateway,
  isViewerGatewayTicketData,
} from "./viewer-gateway-lifecycle";

test("demand gateway tickets require an atomic connection id and positive epoch", () => {
  const base = { ticket: "ticket", expiresAt: "2026-08-31T12:00:00.000Z" };
  const connectionId = "11111111-1111-4111-8111-111111111111";
  assert.equal(isViewerGatewayTicketData({ ...base, connectionId, epoch: 1 }), true);
  assert.equal(isViewerGatewayTicketData({ ...base, connectionId }), false);
  assert.equal(isViewerGatewayTicketData({ ...base, epoch: 1 }), false);
  assert.equal(isViewerGatewayTicketData({ ...base, connectionId, epoch: -1 }), false);
});

test("viewer gateway tickets are short-lived one-connection credentials", () => {
  assert.equal(isViewerGatewayTicketData({
    ticket: "viewer-gateway-ticket",
    expiresAt: "2026-08-22T00:00:30.000Z",
  }), true);
  assert.equal(isViewerGatewayTicketData({ ticket: "", expiresAt: "2026-08-22T00:00:30.000Z" }), false);
  assert.equal(isViewerGatewayTicketData({ ticket: "viewer-gateway-ticket", expiresAt: "invalid" }), false);
  assert.equal(isViewerGatewayTicketData({ ticket: "viewer-gateway-ticket", expiresAt: "2026-08-22T00:00:30.000Z", viewerToken: "legacy" }), false);
});

test("viewer keeps durable grants in httpOnly cookies and requests a fresh ticket per socket", () => {
  const source = readFileSync(resolve(process.cwd(), "components/live/LiveViewer.tsx"), "utf8");
  const contract = readFileSync(resolve(process.cwd(), "components/live/viewer-controller-contract.ts"), "utf8");

  assert.doesNotMatch(source, /viewerToken|authorization:\s*`Bearer/u);
  assert.doesNotMatch(contract, /viewerToken/u);
  assert.match(source, /fetch\(\s*`\/api\/live-sessions\/\$\{sessionId\}\/viewer-gateway-ticket`,\s*\{ method: "POST" \}/u);
  assert.match(source, /if \(!isViewerGatewayTicketData\(result\)\)/u);
  assert.match(source, /const ticketData = await requestViewerGatewayTicket\(viewer\.session\.id\)[\s\S]*?const \{ ticket \} = ticketData[\s\S]*?new WebSocket\(LIVE_GATEWAY_URL\)/u,
    "the speaking socket must acquire its own ticket immediately before opening");
  assert.match(source, /const ticketData = await requestViewerGatewayTicket\(currentViewer\.session\.id\)[\s\S]*?const \{ ticket \} = ticketData[\s\S]*?new WebSocket\(LIVE_GATEWAY_URL\)/u,
    "every caption connection and reconnect must acquire a fresh ticket");
  assert.doesNotMatch(source, /use(?:State|Ref)[^\n]{0,160}(?:ticket|token)/iu);
});

test("only live and paused viewer sessions may open the Cloud Run gateway", () => {
  assert.equal(shouldConnectViewerGateway("live", false), true);
  assert.equal(shouldConnectViewerGateway("paused", false), true);
  assert.equal(shouldConnectViewerGateway("preparing", false), false);
  assert.equal(shouldConnectViewerGateway("stopped", false), false);
  assert.equal(shouldConnectViewerGateway("failed", false), false);
  assert.equal(shouldConnectViewerGateway("live", true), false);
});

test("duplicate lifecycle effects share one connection and reset fences late completion", async () => {
  const gate = createViewerGatewayConnectionGate();
  let connectCount = 0;
  let releaseFirst: (() => void) | undefined;
  const connect = () => {
    connectCount += 1;
    return new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; });
  };

  const first = connectViewerGatewayOnce(gate, "session-1:ko", connect);
  const duplicate = connectViewerGatewayOnce(gate, "session-1:ko", connect);
  assert.equal(connectCount, 1);
  assert.equal(first, duplicate);

  resetViewerGatewayConnectionGate(gate);
  releaseFirst?.();
  await first;
  assert.equal(gate.connectedKey, null, "a completion fenced by stop or leave cannot become connected");

  await connectViewerGatewayOnce(gate, "session-1:ko", async () => { connectCount += 1; });
  assert.equal(connectCount, 2);
  assert.equal(gate.connectedKey, "session-1:ko");
});

test("authoritative status and session fences decide whether a closed socket may reconnect", () => {
  assert.equal(resolveViewerGatewayStatusDecision("live"), "reconnect");
  assert.equal(resolveViewerGatewayStatusDecision("paused"), "reconnect");
  assert.equal(resolveViewerGatewayStatusDecision("preparing"), "wait");
  assert.equal(resolveViewerGatewayStatusDecision("stopped"), "ended");
  assert.equal(resolveViewerGatewayStatusDecision("failed"), "failed",
    "a failed session is terminal but must not be mistaken for a completed meeting");
  assert.equal(resolveViewerGatewayStatusDecision(undefined), "wait",
    "a transient Vercel status failure must not wake Cloud Run");
  assert.equal(isCurrentViewerGatewayRequest(4, 4, "session-1", "session-1"), true);
  assert.equal(isCurrentViewerGatewayRequest(3, 4, "session-1", "session-1"), false);
  assert.equal(isCurrentViewerGatewayRequest(4, 4, "session-old", "session-new"), false);
});

test("viewer join and restore defer gateway work to the status-gated lifecycle effect", () => {
  const source = readFileSync(resolve(process.cwd(), "components/live/LiveViewer.tsx"), "utf8");
  const restoreStart = source.indexOf("const restoreViewerSession");
  const restoreEnd = source.indexOf("const { isRestoringViewer", restoreStart);
  const joinStart = source.indexOf("const join = useCallback");
  const joinEnd = source.indexOf("useEffect(() =>", joinStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart && joinStart >= 0 && joinEnd > joinStart);
  assert.doesNotMatch(source.slice(restoreStart, restoreEnd), /subscribe\(/u);
  assert.doesNotMatch(source.slice(joinStart, joinEnd), /subscribe\(/u);
  assert.match(source, /shouldConnectViewerGateway\(sessionStatus, isSessionEnded\)/u);
  assert.match(source, /connectViewerGatewayOnce\(/u);
  assert.match(source, /sessionStatus === "preparing" \? 2_500 : 10_000/u,
    "preparing waits on the Vercel lifecycle status poll");
  assert.match(source, /event\.status === "stopped"\) markSessionEndedRef\.current\(\)/u);
  const endedStart = source.indexOf("markSessionEndedRef.current = () =>");
  const endedEnd = source.indexOf("const resolveViewerGatewayStatus", endedStart);
  assert.match(source.slice(endedStart, endedEnd), /stopGatewayLifecycle\(\)/u,
    "a stopped broadcast must synchronously fence reconnects and disconnect the socket");

  const failedStart = source.indexOf("markSessionFailedRef.current = () =>");
  const failedEnd = source.indexOf("const resolveViewerGatewayStatus", failedStart);
  const failedHandler = source.slice(failedStart, failedEnd);
  assert.ok(failedStart >= 0 && failedEnd > failedStart);
  assert.match(failedHandler, /updateSessionStatus\("failed"\)/u);
  assert.match(failedHandler, /stopGatewayLifecycle\(\)/u,
    "a failed broadcast must synchronously fence reconnects and disconnect the socket");
  assert.doesNotMatch(failedHandler, /markSessionEnded|loadMinutes/u,
    "failure must retain captions without entering the completed-minutes lifecycle");
  assert.match(source, /decision === "failed"[\s\S]*markSessionFailedRef\.current\(\)/u);
  assert.match(source, /result\.status === "failed"[\s\S]*markSessionFailedRef\.current\(\)/u,
    "the Vercel poll must publish the terminal failure even when the gateway event was missed");
  assert.match(source, /event\.status === "failed"\) markSessionFailedRef\.current\(\)/u,
    "a gateway failure event must immediately stop its own lifecycle");
  assert.match(source, /sessionStatus === "failed"[\s\S]*기존 자막은 계속 볼 수 있습니다/u,
    "the failed surface must explain the terminal state while retaining cached captions");

  const closeStart = source.indexOf('candidate.addEventListener("close"');
  const closeEnd = source.indexOf("if (gatewayProactiveTimerRef.current !== null) window.clearTimeout", closeStart);
  const closeHandler = source.slice(closeStart, closeEnd);
  assert.match(closeHandler, /resolveViewerGatewayStatus/u);
  assert.ok(closeHandler.indexOf("resolveViewerGatewayStatus") < closeHandler.indexOf("scheduleReconnect()"),
    "every non-terminal close must confirm Vercel status before waking Cloud Run");
  assert.match(closeHandler, /decision === "reconnect"[\s\S]*scheduleReconnect\(\)/u);
  assert.doesNotMatch(closeHandler, /\.catch\(\(\) => scheduleReconnect\(\)\)/u,
    "status-read failure must wait for the lifecycle poll rather than reconnecting immediately");
  assert.match(closeHandler, /\.catch\(\(\) => waitForAuthoritativeStatus\(\)\)/u,
    "status-read failure must fail closed to the Vercel lifecycle poll");

  const scheduleStart = source.indexOf("const scheduleReconnect = () =>");
  const scheduleEnd = source.indexOf("const openConnection", scheduleStart);
  const scheduledReconnect = source.slice(scheduleStart, scheduleEnd);
  assert.ok(scheduledReconnect.indexOf("resolveViewerGatewayStatus")
    < scheduledReconnect.indexOf("installConnection()"),
  "the reconnect timer must re-confirm status before opening a socket");
  assert.match(scheduledReconnect, /decision === "reconnect"[\s\S]*installConnection\(\)/u);
  assert.match(scheduledReconnect, /decision === "reconnect"[\s\S]*isCurrentViewerGatewayRequest\([\s\S]*installConnection\(\)/u,
    "the timer must re-check its generation and session fence immediately before socket creation");
  assert.match(scheduledReconnect, /decision === "wait"[\s\S]*waitForAuthoritativeStatus\(\)/u);

  const proactiveStart = source.indexOf("gatewayProactiveTimerRef.current = window.setTimeout");
  const proactiveEnd = source.indexOf("}, 50 * 60 * 1_000);", proactiveStart);
  const proactiveReconnect = source.slice(proactiveStart, proactiveEnd);
  assert.match(proactiveReconnect, /scheduleReconnect\(\)/u);
  assert.doesNotMatch(proactiveReconnect, /installConnection\(/u,
    "proactive refresh must enter the central authoritative reconnect boundary");

  const initialStart = source.indexOf("try {\n      await installConnection();");
  const initialEnd = source.indexOf("  }, [", initialStart);
  const initialConnection = source.slice(initialStart, initialEnd);
  assert.match(initialConnection, /catch[\s\S]*scheduleReconnect\(\)/u);
  assert.doesNotMatch(initialConnection, /catch[\s\S]*installConnection\(/u,
    "initial failure must not bypass the central reconnect boundary");

  const foregroundStart = source.indexOf("const recover = (event: ForegroundRecoveryEvent)");
  const foregroundEnd = source.indexOf("const handleVisibilityChange", foregroundStart);
  const foregroundRecovery = source.slice(foregroundStart, foregroundEnd);
  assert.ok(foregroundRecovery.indexOf("resolveViewerGatewayStatus")
    < foregroundRecovery.indexOf("connectViewerGatewayOnce"),
  "online recovery must confirm authoritative status before reconnecting");
});
