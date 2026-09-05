import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".py", ".ts", ".tsx"]);
const SCANNED_PATHS = [
  "README.md",
  "LICENSE",
  "package.json",
  "chrome-extension",
  "docs",
  "electron",
  "media-gateway/README.md",
  "public",
  "scripts",
  "src",
  "webapp/README.md",
  "webapp/app",
  "webapp/components",
];

async function collectTextFiles(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  const entry = await readFileOrDirectory(absolutePath);
  if (entry.kind === "file") return TEXT_EXTENSIONS.has(path.extname(absolutePath)) || path.basename(absolutePath) === "LICENSE"
    ? [absolutePath]
    : [];
  const nested = await Promise.all(entry.names.map((name) => collectTextFiles(path.join(relativePath, name))));
  return nested.flat();
}

async function readFileOrDirectory(absolutePath) {
  try {
    return { kind: "file", contents: await readFile(absolutePath, "utf8") };
  } catch (error) {
    if (error?.code !== "EISDIR") throw error;
    return { kind: "directory", names: await readdir(absolutePath) };
  }
}

test("no product surface carries a retired display name", async () => {
  const files = (await Promise.all(SCANNED_PATHS.map(collectTextFiles))).flat();
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/Realtime_Noel|AutoPreso|Auto Preso/u.test(source)) violations.push(path.relative(ROOT, file));
  }
  assert.deepEqual(violations, []);
});

test("NOVA packaging keeps the installed desktop identity while separating its CLI", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.build.productName, "NOVA");
  assert.equal(packageJson.name, "nova");
  assert.deepEqual(packageJson.bin, { nova: "src/nova-cli.js" });
  assert.equal(packageJson.build.appId, "com.realtime-noel.app");
  for (const message of Object.values(packageJson.build.mac.extendInfo)) {
    // The OS shows productName in Privacy & Security, so the usage strings
    // must name the same app or they point at an entry the user cannot find.
    assert.match(message, /NOVA/u);
    assert.doesNotMatch(message, /Realtime_Noel/u);
  }
});
