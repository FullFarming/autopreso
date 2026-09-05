import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSettingsStore } from "../src/settings-store.js";

test("NOVA settings never read Codex login or retain canvas settings", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nova-settings-split-"));
  const filePath = path.join(directory, "settings.json");
  try {
    const store = createSettingsStore({ filePath, env: { CODEX_MODEL: "canvas-model", OLLAMA_MODEL: "canvas-agent" } });
    assert.deepEqual(Object.keys(await store.load()).sort(), ["apiKeys", "subtitle", "subtitleHistory"]);
    assert.doesNotMatch(await fs.readFile(new URL("../src/settings-store.js", import.meta.url), "utf8"), /codex-auth|readCodexCliAuth/u);
    await assert.rejects(store.save({ agent: { provider: "codex" } }), /NOVA/u);
    await assert.rejects(store.save({ agentInstructions: "canvas" }), /NOVA/u);
    await fs.writeFile(filePath, JSON.stringify({ agent: { provider: "codex" }, transcription: { provider: "moonshine" }, agentInstructions: "private canvas context", subtitle: { translationFontSize: 42 } }));
    const reloaded = await createSettingsStore({ filePath, env: {} }).load();
    assert.deepEqual(Object.keys(reloaded).sort(), ["apiKeys", "subtitle", "subtitleHistory"]);
    assert.equal(reloaded.subtitle.translationFontSize, 42);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
