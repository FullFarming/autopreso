import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Electron sandboxed preload scripts (sandbox defaults to true since Electron 20)
// are executed as classic scripts with a limited require() shim — ESM `import`
// statements make the whole preload fail to load ("Cannot use import statement
// outside a module"), silently killing every contextBridge API in the packaged app.
test("electron/preload.js is valid CommonJS so the sandboxed preload can load", () => {
  const code = fs.readFileSync(new URL("../electron/preload.js", import.meta.url), "utf8");
  assert.doesNotThrow(
    () => new vm.Script(code, { filename: "preload.js" }),
    "preload.js must not use ESM syntax (import/export) — use require()",
  );
  assert.match(code, /contextBridge\.exposeInMainWorld\("realtimeNoelDesktop"/, "bridge API must stay exposed");
});
