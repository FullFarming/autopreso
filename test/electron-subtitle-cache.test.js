import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");

test("desktop clears the subtitle renderer cache before its first load", () => {
  assert.match(source, /await createDashboardWindow\(server\.url\)/u);
  const createWindow = source.match(/async function createDashboardWindow\(url\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  const clearIndex = createWindow.indexOf("await dashboardWindow.webContents.session.clearCache()");
  const loadIndex = createWindow.indexOf("await dashboardWindow.loadURL");
  assert.ok(clearIndex >= 0, "subtitle session cache must be cleared");
  assert.ok(loadIndex > clearIndex, "cache clear must settle before subtitle.html loads");
});

test("cache-clear failure is nonfatal and the load requests no-store assets", () => {
  const createWindow = source.match(/async function createDashboardWindow\(url\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(createWindow, /try \{[\s\S]*?clearCache\(\)[\s\S]*?\} catch \{[\s\S]*?console\.warn\("\[subtitle\] renderer cache could not be cleared; loading no-store assets"\)/u);
  assert.match(createWindow, /loadURL\(`\$\{url\}\/subtitle\.html`[\s\S]*?Cache-Control: no-cache, no-store, must-revalidate/u);
  assert.match(createWindow, /Pragma: no-cache/u);
});

test("desktop opens at the approved two-column dashboard size", () => {
  const createWindow = source.match(/async function createDashboardWindow\(url\) \{[\s\S]*?\n\}/u)?.[0] ?? "";

  assert.match(createWindow, /width: 1440/u);
  assert.match(createWindow, /height: 900/u);
  assert.match(createWindow, /minWidth: 960/u);
  assert.match(createWindow, /minHeight: 680/u);
});
