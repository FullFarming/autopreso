import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The webapp's TypeScript tests cannot be discovered by a bare `node --test`:
// they need --experimental-strip-types plus lib/security/test-typescript-loader.mjs,
// so each one is named explicitly in a package.json script. That enumeration
// silently rots -- 10 of 21 test files once sat on disk referenced by no script
// at all, including the language-detection and translation-engine suites where
// the hard-won EN<->KO fixes live. Nothing failed; they simply never ran.
// This guard fails instead.

const repoRoot = new URL("..", import.meta.url).pathname;
const webappDir = path.join(repoRoot, "webapp");

function collectTestFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(absolute));
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      found.push(path.relative(webappDir, absolute));
    }
  }
  return found;
}

test("every webapp test file is named in a webapp package.json script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(webappDir, "package.json"), "utf8"));
  const scripts = manifest.scripts ?? {};
  // Only scripts that actually run the test runner count as coverage.
  const runnerScripts = Object.entries(scripts).filter(([, command]) => command.includes("--test"));
  assert.ok(runnerScripts.length > 0, "no webapp script runs node --test");
  const covered = runnerScripts.map(([, command]) => command).join(" ");

  const onDisk = collectTestFiles(webappDir).sort();
  assert.ok(onDisk.length > 0, "no webapp test files found");

  const orphans = onDisk.filter((file) => !covered.includes(file));
  assert.deepEqual(
    orphans,
    [],
    `these webapp test files run in no script, so they are never gated: ${orphans.join(", ")}`,
  );
});

test("the webapp aggregate test script runs every runner script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(webappDir, "package.json"), "utf8"));
  const scripts = manifest.scripts ?? {};
  // `npm --prefix webapp test` is the single entry point CI and `test:all` use.
  // If a new test:* script is added but not chained here, CI would keep passing
  // while silently skipping it.
  assert.equal(typeof scripts.test, "string", "webapp needs a `test` script as the CI entry point");
  const chained = scripts.test;
  for (const name of Object.keys(scripts)) {
    if (name === "test" || !name.startsWith("test")) continue;
    if (!scripts[name].includes("--test")) continue;
    assert.ok(
      chained.includes(name),
      `webapp script \`${name}\` runs tests but \`npm test\` does not chain it`,
    );
  }
});

test("subtitle frontend assets live only in public/", () => {
  // These files were duplicated at the repo root, referenced by nothing:
  // src/server.js serves PUBLIC_DIR only, and npm `files` / electron-builder
  // `build.files` ship public/ only. Editing a root copy looked like real work
  // and changed nothing in the running app. Five separate tests had grown to
  // police root-vs-public byte equality; this one guard replaces them by
  // keeping the duplication from coming back at all.
  const strays = fs.readdirSync(repoRoot)
    .filter((name) => /^subtitle.*\.(js|css|html)$/u.test(name));
  assert.deepEqual(
    strays,
    [],
    `subtitle frontend assets belong in public/ only; found at repo root: ${strays.join(", ")}`,
  );
  // And the real copies must still be there.
  for (const file of ["subtitle.html", "subtitle.css", "subtitle-dashboard.js", "subtitle-controller.html", "subtitle-controller.js", "subtitle-overlay.js", "subtitle-workspace.js", "subtitle-audio-player.js"]) {
    assert.ok(fs.existsSync(path.join(repoRoot, "public", file)), `public/${file} is missing`);
  }
});

test("the repo-wide test:all script covers all three suites", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const testAll = manifest.scripts?.["test:all"] ?? "";
  assert.match(testAll, /npm test/u, "test:all must run the root suite");
  assert.match(testAll, /--prefix media-gateway test/u, "test:all must run the media-gateway suite");
  assert.match(testAll, /--prefix webapp test\b/u, "test:all must run the whole webapp suite, not one subset");
});
