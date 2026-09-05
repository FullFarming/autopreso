import assert from "node:assert/strict";
import test from "node:test";
import { registerSpeakerRosterIpc } from "../electron/speaker-roster-ipc.js";
import { createSpeakerRosterModel, validateSpeakerDraft } from "../public/subtitle-speakers.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const speakerId = "22222222-2222-4222-8222-222222222222";
const photoId = "33333333-3333-4333-8333-333333333333";
const profile = { id: speakerId, version: 1, displayName: "김 발표", company: "회사", department: "기획", photoAssetId: null, participantId: null };
const initial = { sessionId, revision: 0, appliedRevision: 0, activeOnsiteSpeakerId: null, speakers: [] };
function ipcHarness(overrides = {}) {
  const handlers = new Map(); const calls = [];
  registerSpeakerRosterIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    isAllowedSender: () => true, ensureHostSession: async () => ({ ok: true }),
    workspaceUrl: "https://workspace.example.test",
    request: async (pathname, options) => { calls.push({ pathname, options }); return { ok: true, data: initial }; },
    fetch: async () => new Response(new Uint8Array([1,2]), { headers: { "content-type": "image/png" } }),
    ...overrides,
  });
  return { calls, invoke: (channel, ...args) => handlers.get(channel)({}, ...args) };
}

test("speaker IPC rejects untrusted callers and arbitrary IDs before any host request", async () => {
  const untrusted = ipcHarness({ isAllowedSender: () => false });
  assert.equal((await untrusted.invoke("live-call:speakers-get", sessionId)).code, "FORBIDDEN");
  const trusted = ipcHarness();
  for (const id of ["../settings", "https://evil.test", "", null]) {
    assert.equal((await trusted.invoke("live-call:speakers-get", id)).ok, false);
  }
  assert.equal(trusted.calls.length, 0); assert.equal(untrusted.calls.length, 0);
});

test("speaker IPC writes only the fixed roster endpoint and bounds photos", async () => {
  const harness = ipcHarness();
  await harness.invoke("live-call:speakers-save", sessionId, { expectedRevision: 0, speakers: [profile], activeOnsiteSpeakerId: speakerId });
  assert.equal(harness.calls[0].pathname, `/api/live-sessions/${sessionId}/speakers`);
  assert.equal(harness.calls[0].options.method, "PUT");
  assert.equal((await harness.invoke("live-call:speakers-photo-upload", sessionId, { contentType: "image/svg+xml", bytes: new Uint8Array([1]) })).ok, false);
  assert.equal((await harness.invoke("live-call:speakers-photo-upload", sessionId, { contentType: "image/png", bytes: new Uint8Array(2*1024*1024+1) })).ok, false);
});

test("speaker photo read returns bounded image bytes without URLs or cookies", async () => {
  const requests = [];
  const harness = ipcHarness({ fetch: async (url, options) => {
    requests.push({ url, options });
    return new Response(new Uint8Array([1,2]), { headers: { "content-type": "image/png" } });
  } });
  const result = await harness.invoke("live-call:speakers-photo-read", { sessionId, photoAssetId: photoId });
  assert.deepEqual(result, { ok: true, data: { contentType: "image/png", imageBase64: "AQI=" } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://workspace.example.test/api/live-sessions/${sessionId}/speakers/photos/${photoId}`);
  assert.equal(requests[0].options.redirect, "error");
});

test("roster save retries the created session without creating or restarting audio", async () => {
  const calls = []; let shouldFail = true;
  const model = createSpeakerRosterModel({
    getLiveCallSpeakers: async id => { calls.push(id); return { ok: true, data: initial }; },
    saveLiveCallSpeakers: async (id, body) => {
      calls.push(id);
      if (shouldFail) return { ok: false, code: "NETWORK_UNAVAILABLE" };
      return { ok: true, data: { ...initial, ...body, revision: 1 } };
    },
  });
  model.setDraft([profile], speakerId);
  await assert.rejects(model.persistForSession(sessionId));
  assert.equal(model.getState().sessionId, sessionId);
  assert.equal(model.getState().dirty, true);
  shouldFail = false;
  await model.save();
  assert.equal(model.getState().dirty, false);
  assert.equal(model.getState().pending, true);
  assert.ok(calls.every(id => id === sessionId));
});

test("draft validation rejects blank names, oversized fields and duplicate participant assignments", () => {
  for (const change of [{ displayName: " " }, { company: "x".repeat(81) }, { department: "x".repeat(81) }]) {
    assert.throws(() => validateSpeakerDraft([{ ...profile, ...change }], speakerId));
  }
  assert.throws(() => validateSpeakerDraft(Array.from({ length: 31 }, () => profile), null));
  assert.throws(() => validateSpeakerDraft([profile], photoId));
});

test("bounded photo reads reject oversized streams even without a content length", async () => {
  const harness = ipcHarness({ fetch: async () => new Response(new Uint8Array(2*1024*1024+1), { headers: { "content-type": "image/png" } }) });
  assert.equal((await harness.invoke("live-call:speakers-photo-read", { sessionId, photoAssetId: photoId })).code, "PHOTO_READ_FAILED");
});

test("profile label retains the newest speaker when an older photo finishes late", async () => {
  const { renderCaptionSpeakerProfile } = await import("../public/subtitle-speakers.js");
  const previous = globalThis.document;
  class FakeElement {
    children = []; style = {}; textContent = ""; className = ""; src = "";
    setAttribute() {}
    replaceChildren(...children) { this.children = children; }
  }
  const completions = [];
  const oldResult = new Promise(resolve => { completions.push(resolve); });
  const bridge = { liveCallReadSpeakerPhoto: () => oldResult };
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { createElement: () => new FakeElement() } });
  try {
    const label = new FakeElement();
    renderCaptionSpeakerProfile(label, { ...profile, photoAssetId: photoId }, sessionId, bridge);
    const oldAvatar = label.children[0];
    renderCaptionSpeakerProfile(label, { ...profile, displayName: "새 발표자", photoAssetId: null }, sessionId, bridge);
    completions[0]({ ok: true, data: { contentType: "image/png", imageBase64: "AQI=" } });
    await oldResult; await new Promise(resolve => setImmediate(resolve));
    assert.match(label.children[1].textContent, /새 발표자/u);
    assert.equal(label.children[0].textContent, "새");
    assert.equal(oldAvatar.children.length, 0);
    renderCaptionSpeakerProfile(label, null, sessionId, bridge, "발언자 확인 필요");
    assert.equal(label.textContent, "발언자 확인 필요");
  } finally { globalThis.document = previous; }
});

test("roster binding and registration retry preserve the created session ID", async () => {
  const { readFile } = await import("node:fs/promises");
  const workspace = await readFile(new URL("../public/subtitle-workspace.js", import.meta.url), "utf8");
  assert.match(workspace, /pendingSpeakerStart \|\| await bridge\.startLiveCall/u);
  assert.match(workspace, /pendingSpeakerRegistration \|\| await bridge\.registerLiveCall/u);
  const main = await readFile(new URL("../electron/main.js", import.meta.url), "utf8");
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/u);
  const controller = await readFile(new URL("../public/subtitle-controller.html", import.meta.url), "utf8");
  assert.match(controller, /controller-current-speaker/u);
  assert.match(controller, /data-speaker-retry/u);
});

test("repeated record photos share one in-flight authenticated read", async () => {
  const { readSpeakerPhoto } = await import("../public/subtitle-speakers.js");
  let requests = 0; const completions = [];
  const bridge = { liveCallReadSpeakerPhoto: () => { requests++; return new Promise(resolve => completions.push(resolve)); } };
  const freshPhoto = "55555555-5555-4555-8555-555555555555";
  const first = readSpeakerPhoto(sessionId, freshPhoto, bridge);
  const second = readSpeakerPhoto(sessionId, freshPhoto, bridge);
  assert.equal(requests, 1);
  completions[0]({ ok: true, data: { contentType: "image/png", imageBase64: "AQI=" } });
  assert.equal(await first, await second);
  assert.equal(await readSpeakerPhoto(sessionId, freshPhoto, bridge), "data:image/png;base64,AQI=");
  assert.equal(requests, 1);
});
