import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { normalizeLanguage } from "../public/subtitle-i18n.js";

const source = fs.readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
function sourceBetween(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  return source.slice(startIndex, endIndex);
}

test("system language IPC rejects foreign origins and unsupported values without touching native settings", () => {
  const handlers = new Map();
  const calls = [];
  const context = vm.createContext({
    URL, Set, normalizeLanguage,
    localAppOrigin: "http://127.0.0.1:3210", lastServerUrl: "http://127.0.0.1:3210",
    app: { getPath: () => "/test-user-data" },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    persistDesktopSystemLanguage: (directory, language) => calls.push(["save", directory, language]),
    readDesktopSystemLanguage: () => { calls.push(["read"]); return "ja"; },
    setLanguage: (language) => calls.push(["ui", language]),
    installApplicationMenu: () => calls.push(["menu"]),
  });
  vm.runInContext(sourceBetween("function isAllowedOrigin(", "// Boot must never reject silently."), context);
  vm.runInContext(sourceBetween("function applyUiLanguage(", "function destroyOverlayWindow("), context);
  vm.runInContext(sourceBetween('ipcMain.handle("app:set-ui-language"', 'ipcMain.handle("app:quit"'), context);
  const event = (url) => ({ sender: { getURL: () => url } });
  for (const url of ["https://evil.example", "http://127.0.0.1.evil.example:3210", "http://127.0.0.1:3211", "file:///subtitle.html", "http://user:pass@127.0.0.1:3210", ""]) {
    assert.equal(handlers.get("app:set-ui-language")(event(url), "ja"), null);
    assert.equal(handlers.get("app:get-ui-language")(event(url)), null);
  }
  const local = event("http://127.0.0.1:3210/subtitle.html");
  for (const value of [null, {}, ["ja"], "fr", "<script>"]) assert.equal(handlers.get("app:set-ui-language")(local, value), null);
  assert.deepEqual(calls, []);
  assert.equal(handlers.get("app:set-ui-language")(local, "ja"), "ja");
  assert.deepEqual(calls, [["save", "/test-user-data", "ja"], ["ui", "ja"], ["menu"]]);
  assert.equal(handlers.get("app:get-ui-language")(local), "ja");
});

test("a failed native language save never reports success or changes the native menu", () => {
  const context = vm.createContext({
    normalizeLanguage, app: { getPath: () => "/test-user-data" },
    persistDesktopSystemLanguage: () => { throw new Error("SYSTEM_LANGUAGE_SAVE_FAILED"); },
    setLanguage: () => assert.fail("unsaved native locale must not apply"),
    installApplicationMenu: () => assert.fail("unsaved native menu must not apply"),
  });
  vm.runInContext(sourceBetween("function applyUiLanguage(", "function destroyOverlayWindow("), context);
  assert.throws(() => vm.runInContext('applyUiLanguage("ja")', context), /SYSTEM_LANGUAGE_SAVE_FAILED/);
});
