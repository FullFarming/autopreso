import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateNovaConfig, getNovaConfigPaths } from "../src/nova-config.js";
import { parseNovaCliArgs } from "../src/nova-cli.js";

test("NOVA CLI keeps loopback and uses its own port with validated overrides", () => {
  assert.deepEqual(parseNovaCliArgs(["--no-open"], {}), { host: "127.0.0.1", port: 3317, openBrowser: false, help: false });
  assert.equal(parseNovaCliArgs([], { PORT: "4001" }).port, 4001);
  assert.throws(() => parseNovaCliArgs([], { PORT: "-1" }), /Invalid PORT/);
  assert.throws(() => parseNovaCliArgs(["--host", "0.0.0.0"], {}), /Unknown argument/);
});

test("NOVA imports legacy data once without modifying originals or overwriting NOVA files", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-migration-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const oldDir = path.join(homeDir, ".config", "realtime-noel");
  await fs.mkdir(path.join(oldDir, "transcripts", "nested"), { recursive: true });
  await fs.writeFile(path.join(oldDir, "settings.json"), '{"subtitle":{"sourceLanguage":"ko"},"agentInstructions":"canvas-only"}');
  const caption = { id: "record", kind: "local", startedAt: "2026-09-05T00:00:00Z", lines: [{ sourceText: "안녕", translatedText: "Hello" }] };
  await fs.writeFile(path.join(oldDir, "transcripts", "record.json"), JSON.stringify(caption));
  await fs.writeFile(path.join(oldDir, "transcripts", "canvas.json"), '{"elements":[]}');
  await fs.writeFile(path.join(oldDir, "transcripts", "record.mic.wav"), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(oldDir, "transcripts", "unrelated.mic.wav"), Buffer.from([9]));
  await migrateNovaConfig({ homeDir });
  const paths = getNovaConfigPaths(homeDir);
  assert.equal(paths.configDir, path.join(homeDir, ".config", "nova"));
  assert.deepEqual(JSON.parse(await fs.readFile(paths.settingsPath, "utf8")), { subtitle: { sourceLanguage: "ko" } });
  assert.equal((await fs.stat(paths.settingsPath)).mode & 0o777, 0o600);
  const record = path.join(paths.transcriptsDir, "record.json");
  assert.deepEqual(JSON.parse(await fs.readFile(record, "utf8")), caption);
  assert.deepEqual(await fs.readFile(path.join(paths.transcriptsDir, "record.mic.wav")), Buffer.from([1, 2, 3]));
  await assert.rejects(fs.access(path.join(paths.transcriptsDir, "unrelated.mic.wav")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(paths.transcriptsDir, "canvas.json")), { code: "ENOENT" });
  await fs.writeFile(paths.settingsPath, "NOVA-owned");
  await fs.unlink(record);
  await migrateNovaConfig({ homeDir });
  assert.equal(await fs.readFile(paths.settingsPath, "utf8"), "NOVA-owned");
  await assert.rejects(fs.access(record), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(oldDir, "transcripts", "record.json"), "utf8")), caption);
});

test("migration preserves existing NOVA files and refuses destination symlinks", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-migration-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const paths = getNovaConfigPaths(homeDir);
  const oldDir = path.join(homeDir, ".config", "realtime-noel");
  await fs.mkdir(oldDir, { recursive: true });
  await fs.writeFile(path.join(oldDir, "settings.json"), "legacy");
  await fs.mkdir(paths.configDir, { recursive: true });
  await fs.writeFile(paths.settingsPath, "existing");
  await migrateNovaConfig({ homeDir });
  assert.equal(await fs.readFile(paths.settingsPath, "utf8"), "existing");
  await fs.rm(paths.configDir, { recursive: true });
  await fs.symlink(oldDir, paths.configDir);
  await assert.rejects(migrateNovaConfig({ homeDir }), /directory/);
});

test("fresh NOVA CLI serves captions without agent credentials and leaves canvas config absent", async (t) => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-cli-"));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => probe.close(() => resolve(undefined)));
  const child = spawn(process.execPath, [path.resolve("src/nova-cli.js"), "--no-open"], {
    env: { PATH: process.env.PATH, HOME: homeDir, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("NOVA CLI startup timed out")), 10000);
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("NOVA CLI exited before startup")); });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("NOVA 실행 중:")) { clearTimeout(timeout); resolve(undefined); }
    });
  });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /subtitle-dashboard\.js/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/app.js`)).status, 404);
  await fs.access(getNovaConfigPaths(homeDir).settingsPath);
  await assert.rejects(fs.access(path.join(homeDir, ".config", "realtime-noel")), { code: "ENOENT" });
});
