import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// 2026-09-06 incident: the packaged desktop answered every local caption start with
// "liveWorkspaceUrl is not defined". `managedCaptionRequest` and the managed-caption callbacks
// were module-level and referenced `liveWorkspaceUrl`, a const declared inside the app-ready
// function AFTER startDesktopServer() had already captured the callbacks. The identifier was
// therefore a free variable at call time (ReferenceError), and no unit test exercised the
// callbacks because they lived next to Electron-only code.

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const source = readFileSync(path.join(rootDir, "electron", "main.js"), "utf8");

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} … ${endMarker} present in electron/main.js`);
  return source.slice(start, end);
}

test("managed caption callbacks are built from an explicit workspace URL and never read a free liveWorkspaceUrl", async () => {
  const callbacksSource = sliceBetween("async function managedCaptionRequest(", "async function startDesktopServer(");
  assert.doesNotMatch(callbacksSource, /=\s*liveWorkspaceUrl\b/u, "no default parameter may capture the app-ready local");
  assert.match(callbacksSource, /function createManagedCaptionCallbacks\(workspaceUrl\)/u);

  const calls = [];
  const context = vm.createContext({
    liveCallApi: async (baseUrl, pathname, options) => { calls.push({ baseUrl, pathname, options }); return { ok: true, data: { ticket: "t-1", engine: { stt: {} } } }; },
    geminiTranscribeLanguageCodes: () => ["ko"],
    selectGeminiTranscriptionVocabularyFromLegacyText: () => [],
    console,
  });
  vm.runInContext(`${callbacksSource}\nglobalThis.__factory = createManagedCaptionCallbacks;`, context, { filename: "managed-caption-callbacks.vm.js" });
  const callbacks = context.__factory("https://workspace.example");
  const started = await callbacks.startCaptionSession(["en", "ko"]);
  assert.equal(started.workspaceBaseUrl, "https://workspace.example");
  assert.deepEqual(calls.map((call) => [call.baseUrl, call.pathname]), [["https://workspace.example", "/api/captions/session"]]);
  await callbacks.stopCaptionSession(started);
  assert.equal(calls.at(-1).baseUrl, "https://workspace.example");
});

test("the desktop resolves the workspace URL before the local server captures the caption callbacks", () => {
  const ready = sliceBetween("await loadSettingsStoreResiliently();", "registerOverlayIpc(settingsStore,");
  const resolveAt = ready.indexOf("const liveWorkspaceUrl = resolveLiveWorkspaceUrl();");
  const serverAt = ready.indexOf("server = await startDesktopServer(settingsStore, liveWorkspaceUrl);");
  assert.ok(resolveAt >= 0, "workspace URL is resolved in the ready handler");
  assert.ok(serverAt > resolveAt, "startDesktopServer receives the URL after it is resolved");
  const starter = sliceBetween("async function startDesktopServer(", "async function createDashboardWindow(");
  assert.match(starter, /async function startDesktopServer\(settingsStore, liveWorkspaceUrl\)/u);
  assert.match(starter, /\.\.\.createManagedCaptionCallbacks\(liveWorkspaceUrl\)/u);
  assert.doesNotMatch(starter, /\.\.\.managedCaptionCallbacks\b/u);
});
