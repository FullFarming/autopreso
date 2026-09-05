import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const rootDir = path.join(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

test("NOVA package starts captions and excludes canvas sidecars", () => {
  const rootPackage = readJson("package.json");

  assert.deepEqual(rootPackage.files, [
    "assets/",
    "electron/",
    "LICENSE",
    "packages/caption-core/",
    "packages/gemini-server/",
    "public/",
    "src/",
  ]);
  assert.equal(rootPackage.name, "nova");
  assert.deepEqual(rootPackage.bin, { nova: "src/nova-cli.js" });
  assert.equal(rootPackage.main, "electron/main.js");
  assert.equal(rootPackage.scripts.dev, "node ./src/nova-cli.js");
  assert.equal(rootPackage.scripts.start, "node ./src/nova-cli.js");
  assert.equal(rootPackage.scripts.desktop, "node ./scripts/start-desktop.js");
  assert.match(rootPackage.scripts.test, /packages\/gemini-server\/\*\.test\.js/);
  assert.equal(rootPackage.scripts["dist:mac"], "electron-builder --mac dmg --arm64 --publish never");
  assert.equal(rootPackage.scripts["dist:mac:x64"], "electron-builder --mac dmg --x64 --publish never");
  assert.equal(rootPackage.scripts["dist:win"], "electron-builder --win portable --x64 --publish never");
  assert.equal(rootPackage.build.appId, "com.realtime-noel.app");
  assert.equal(rootPackage.build.productName, "NOVA");
  assert.equal(rootPackage.build.mac.category, "public.app-category.productivity");
  assert.match(rootPackage.build.mac.extendInfo.NSAudioCaptureUsageDescription, /NOVA/);
  assert.match(rootPackage.build.mac.extendInfo.NSMicrophoneUsageDescription, /NOVA/);
  assert.match(rootPackage.build.mac.extendInfo.NSScreenCaptureUsageDescription, /NOVA/);
  assert.equal(rootPackage.build.mac.target[0].target, "dmg");
  assert.equal(rootPackage.build.win.target[0].target, "portable");
  assert.equal(rootPackage.build.portable.artifactName, "${productName}-${version}-win-portable.${ext}");
  assert.equal(rootPackage.scripts["build:moonshine-sidecars"], undefined);
  assert.equal(rootPackage.scripts["prepare:release-packages"], undefined);
  assert.equal(rootPackage.workspaces, undefined);
  assert.equal(rootPackage.optionalDependencies, undefined);
  assert.equal(rootPackage.build.files.some((entry) => entry.includes("moonshine")), false);
});

test("NOVA release recipe contains only its own package and validates an unpublished artifact", () => {
  const config = readJson("release-please-config.json");
  assert.deepEqual(Object.keys(config.packages), ["."]);
  assert.equal(config.packages["."]["package-name"], "nova");
  assert.equal(config.packages["."].component, "nova");
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/release-please.yml"), "utf8");
  assert.doesNotMatch(workflow, /moonshine|npm publish|publish-sidecars|setup-python/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm pack/);
  assert.match(workflow, /actions\/upload-artifact@/);
  assert.match(workflow, /googleapis\/release-please-action@v5/);
});
