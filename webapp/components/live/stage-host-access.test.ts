import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./LiveStageView.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("LiveStageView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && ["clearHostState", "refreshSession"].includes(node.name.text)) callbacks.push(`const ${node.getText(tree)};`);
  ts.forEachChild(node, visit);
}
visit(tree);
const compiled = ts.transpileModule(callbacks.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

interface Reply { status: number; data?: unknown }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const savedSession = { id: "owned-session", title: "Private title", status: "live", version: 5 };
const savedActivity = { participants: [{ participantId: "person", displayName: "Private name", isPresent: true }],
  recentSpeeches: [{ text: "Private caption", seq: 1 }] };

function harness(fetchReply: (url: string) => Promise<Reply>) {
  const states = new Map<string, unknown>([
    ["session", savedSession], ["invite", { admissionCode: "001234" }],
    ["participants", savedActivity.participants], ["recentSpeeches", savedActivity.recentSpeeches], ["error", ""],
  ]);
  const requests: string[] = [];
  const generation = { current: 0 };
  const latest = { current: savedSession as unknown };
  const context: Record<string, unknown> = {
    Error, Date, AbortController, sessionId: "owned-session", refreshGenerationRef: generation,
    latestSessionRef: latest, useCallback: (callback: unknown) => callback,
    fetch: async (url: string) => { requests.push(url); return fetchReply(url); },
    readResponse: async (reply: Reply) => {
      if (reply.status >= 400) throw new Error("Request rejected");
      return reply.data;
    },
  };
  for (const name of ["session", "invite", "participants", "recentSpeeches", "error", "inviteError"]) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = (value: unknown) => states.set(name, value);
  }
  vm.createContext(context);
  vm.runInContext(compiled, context);
  return { states, latest, generation, requests, refresh: () => vm.runInContext("refreshSession()", context) as Promise<void> };
}

function assertCleared(state: ReturnType<typeof harness>) {
  assert.equal(state.states.get("session"), null);
  assert.equal(state.states.get("invite"), null);
  assert.equal(state.latest.current, null);
  assert.equal(JSON.stringify(state.states.get("participants")), "[]");
  assert.equal(JSON.stringify(state.states.get("recentSpeeches")), "[]");
  assert.equal(state.states.get("error"), "auth");
}

test("an authorized stage refresh displays the current session and present participants", async () => {
  const activity = { ...savedActivity, participants: [...savedActivity.participants,
    { participantId: "gone", displayName: "Absent person", isPresent: false }] };
  const state = harness(async (url) => ({ status: 200, data: url.endsWith("/participants") ? activity : savedSession }));
  await state.refresh();
  assert.equal(state.states.get("session"), savedSession);
  assert.equal(JSON.stringify(state.states.get("participants")), JSON.stringify(savedActivity.participants));
  assert.equal(state.states.get("recentSpeeches"), savedActivity.recentSpeeches);
  assert.equal(state.states.get("error"), "");
  assert.deepEqual(state.requests, ["/api/live-sessions/owned-session", "/api/live-sessions/owned-session/participants"]);
});

test("a completed session clears its invitation and private activity without another activity read", async () => {
  const ended = { ...savedSession, status: "stopped", version: 6 };
  const state = harness(async () => ({ status: 200, data: ended }));
  await state.refresh();
  assert.equal(state.states.get("session"), ended);
  assert.equal(state.states.get("invite"), null);
  assert.equal(JSON.stringify(state.states.get("participants")), "[]");
  assert.equal(JSON.stringify(state.states.get("recentSpeeches")), "[]");
  assert.equal(state.requests.length, 1);
});

for (const status of [401, 403, 404]) {
  test(`stage removes previously displayed private data on session ${status}`, async () => {
    const state = harness(async () => ({ status }));
    await state.refresh();
    assertCleared(state);
    assert.equal(state.requests.length, 1);
  });
  test(`stage removes private data when participant access returns ${status}`, async () => {
    const state = harness(async (url) => url.endsWith("/participants") ? { status } : { status: 200, data: savedSession });
    await state.refresh();
    assertCleared(state);
  });
}

test("an older session response cannot restore data after a newer authorization failure", async () => {
  const pending = deferred<Reply>();
  let count = 0;
  const state = harness(async () => ++count === 1 ? pending.promise : { status: 401 });
  const old = state.refresh();
  await state.refresh();
  pending.resolve({ status: 200, data: savedSession });
  await old;
  assertCleared(state);
  assert.equal(state.requests.length, 2);
});

test("an older participant response cannot restore captions after access was revoked", async () => {
  const pending = deferred<Reply>();
  const enteredParticipants = deferred<void>();
  let count = 0;
  const state = harness(async (url) => {
    if (url.endsWith("/participants")) { enteredParticipants.resolve(); return pending.promise; }
    return ++count === 1 ? { status: 200, data: savedSession } : { status: 403 };
  });
  const old = state.refresh();
  await enteredParticipants.promise;
  await state.refresh();
  pending.resolve({ status: 200, data: savedActivity });
  await old;
  assertCleared(state);
});

test("disposed stage requests cannot overwrite the next screen", async () => {
  const pending = deferred<Reply>();
  const state = harness(async () => pending.promise);
  const before = JSON.stringify([...state.states]);
  const request = state.refresh();
  state.generation.current += 1;
  pending.resolve({ status: 200, data: { ...savedSession, title: "Late previous screen" } });
  await request;
  assert.equal(JSON.stringify([...state.states]), before);
  assert.equal(state.requests.length, 1);
});

test("the stage obtains QR codes from the owner API and never connects microphone or gateway", () => {
  assert.doesNotMatch(source, /readInviteFromHash|window\.location\.hash/u);
  assert.match(source, /buildAdmissionJoinUrl\(window\.location\.origin, result\.admissionCode\)/u);
  assert.match(source, /action: "read-if-open"/u);
  assert.doesNotMatch(source, /getUserMedia|new WebSocket|startBroadcast|action: "create"|\/gateway-token/u);
});
