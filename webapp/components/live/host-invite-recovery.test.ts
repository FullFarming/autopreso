import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { buildAdmissionJoinUrl } from "./admission-link";
import { appendRecoverableHostSessions, canApplyHostRecovery } from "./host-session-recovery";

const source = readFileSync(new URL("./LiveHostDashboard.tsx", import.meta.url), "utf8");
const start = source.indexOf("const recoverSession = useCallback");
const end = source.indexOf("const openStageWindow = useCallback", start);
const recoverySource = source.slice(start, end);
const compiled = ts.transpileModule(recoverySource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function setupRecovery({ expired = false, closed = false, stopped = false, delayRead = false } = {}) {
  const now = Date.now();
  const saved = { id: "owned-session", title: "Electron session", status: stopped ? "stopped" : "preparing", version: 12,
    expiresAt: new Date(now + (expired ? -60_000 : 60_000)).toISOString(),
    admissionOpenUntil: closed ? null : new Date(now + 60_000).toISOString(),
    languages: ["ko", "en"], sessionType: "presentation", outputMode: "captions", maxViewers: 50, glossaryPack: "general_cre" };
  const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const values = new Map<string, unknown>();
  let releaseRead: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { releaseRead = resolve; });
  const generation = { current: 0 };
  const context: Record<string, unknown> = {
    Error, Date, buildAdmissionJoinUrl, appendRecoverableHostSessions, canApplyHostRecovery,
    useCallback: (callback: unknown) => callback,
    recoveryAttemptSessionIdRef: { current: null }, recoveryListGenerationRef: generation,
    isPageActiveRef: { current: true }, currentSessionIdRef: { current: null }, recoveryPagePendingRef: { current: false },
    restoreSessionIdentity: () => undefined, agendaTextFromSession: () => "", languageStatusMap: () => ({}),
    window: { location: { origin: "https://nova.test" } },
    readResponse: async (value: unknown) => value,
    fetch: async (url: string, options: RequestInit) => {
      const body = typeof options.body === "string" ? options.body : undefined;
      requests.push({ url, method: options.method ?? "GET", body });
      if (options.method === "GET") { if (delayRead) await barrier; return saved; }
      if (url.endsWith("/restore")) return { ...saved, version: 13, expiresAt: new Date(now + 3600_000).toISOString() };
      assert.ok(url.endsWith("/invites"), "recovery must never request a gateway, microphone or new session");
      assert.deepEqual(JSON.parse(body ?? "{}"), { action: "read-if-open" });
      return { admissionCode: "001234", admissionOpenUntil: saved.admissionOpenUntil };
    },
  };
  for (const [, name] of recoverySource.matchAll(/\b(set[A-Z]\w*)\(/gu)) {
    context[name] = (value: unknown) => values.set(name, typeof value === "function" ? value(values.get(name) ?? []) : value);
  }
  vm.createContext(context);
  vm.runInContext(compiled, context);
  return { saved, requests, values, generation, releaseRead,
    recover: (renew = false) => vm.runInContext(`recoverSession("owned-session", ${renew === true})`, context) as Promise<void> };
}

test("another host device restores a scannable code without rotating invites, changing versions or starting audio", async () => {
  const harness = setupRecovery();
  await harness.recover();
  assert.deepEqual(harness.requests.map((request) => [request.method, request.url]), [
    ["GET", "/api/live-sessions/owned-session"], ["POST", "/api/live-sessions/owned-session/invites"],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.values.get("setInvite"))), {
    sessionId: "owned-session", url: "https://nova.test/m/watch#code=001234", admissionCode: "001234", expiresAt: harness.saved.admissionOpenUntil,
  });
  assert.equal(harness.values.get("setIsAutomaticStartEnabled"), false);
  assert.equal(harness.values.get("setIsBroadcasting"), false);
  assert.equal(harness.values.get("setSession"), harness.saved);
  assert.equal(harness.saved.version, 12);
});

test("expired access is presented for explicit renewal and never extended on login", async () => {
  const harness = setupRecovery({ expired: true });
  await harness.recover();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.values.get("setExpiredRecoveryId"), "owned-session");
  assert.equal(harness.values.has("setSession"), false);
  assert.match(String(harness.values.get("setError")), /입장 시간이 만료/u);
  await harness.recover(true);
  assert.equal(harness.requests.filter((request) => request.url.endsWith("/restore")).length, 1);
  assert.deepEqual(JSON.parse(harness.requests.find((request) => request.url.endsWith("/restore"))?.body ?? "{}"), { version: 12 });
  assert.equal(harness.values.get("setExpiredRecoveryId"), null);
});

test("closed admission and terminal sessions never yield a QR or reopen admission", async () => {
  const closed = setupRecovery({ closed: true });
  await closed.recover();
  assert.equal(closed.requests.length, 1);
  assert.equal(closed.values.get("setInvite"), null);
  const stopped = setupRecovery({ stopped: true, expired: true });
  await stopped.recover(true);
  assert.equal(stopped.requests.length, 1);
  assert.equal(stopped.values.has("setSession"), false);
});

test("late recovery and double clicks cannot renew or replace a newer selection", async () => {
  const harness = setupRecovery({ expired: true, delayRead: true });
  const first = harness.recover(true);
  const duplicate = harness.recover(true);
  assert.equal(harness.requests.length, 1);
  harness.generation.current += 1;
  assert.ok(harness.releaseRead);
  harness.releaseRead();
  await Promise.all([first, duplicate]);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.values.has("setSession"), false);
  assert.equal(harness.values.has("setInvite"), false);
});
