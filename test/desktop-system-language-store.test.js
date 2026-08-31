import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDesktopSystemLanguage, persistDesktopSystemLanguage } from "../electron/system-language-store.js";

test("desktop language survives a new process and local server port without changing caption settings", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-system-language-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "settings.json"), '{"translationLanguages":["ko","en"]}');
  assert.equal(readDesktopSystemLanguage(directory), null);
  persistDesktopSystemLanguage(directory, "ja");
  assert.equal(readDesktopSystemLanguage(directory), "ja");
  const moduleUrl = new URL("../electron/system-language-store.js", import.meta.url).href;
  const restored = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { readDesktopSystemLanguage } from ${JSON.stringify(moduleUrl)}; process.stdout.write(readDesktopSystemLanguage(${JSON.stringify(directory)}) ?? "missing");`,
  ], { encoding: "utf8" });
  assert.equal(restored, "ja");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")), { translationLanguages: ["ko", "en"] });
  assert.throws(() => persistDesktopSystemLanguage(directory, "../../other"), /INVALID_SYSTEM_LANGUAGE/);
  assert.equal(readDesktopSystemLanguage(directory), "ja");
});

test("corrupt or unsupported desktop preferences never become a system locale", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-system-language-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const content of ['{', '{"systemLanguage":"fr"}', '{"systemLanguage":["ja"]}', 'x'.repeat(513)]) {
    fs.writeFileSync(path.join(directory, "system-language.json"), content);
    assert.equal(readDesktopSystemLanguage(directory), null);
  }
});
