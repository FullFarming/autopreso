import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SUBTITLE_SETTINGS, createSettingsStore } from "../src/settings-store.js";
import { resolveLiveCallLanguages } from "../src/subtitle-languages.js";

test("Live Call languages resolve independently with subtitle fallback", () => {
  assert.deepEqual(resolveLiveCallLanguages({ translationLanguages: ["en", "ko"] }), ["en", "ko"]);
  assert.deepEqual(resolveLiveCallLanguages({
    translationLanguages: ["en", "ko"],
    liveCallTranslationLanguages: ["ja"],
  }), ["ja"]);
  assert.deepEqual(resolveLiveCallLanguages({
    translationLanguages: ["en", "ko"],
    liveCallTranslationLanguages: [],
  }), ["en", "ko"]);
  assert.deepEqual(resolveLiveCallLanguages({}), []);
});

test("default settings carry an empty (inherit) Live Call language list", () => {
  assert.deepEqual(DEFAULT_SUBTITLE_SETTINGS.liveCallTranslationLanguages, []);
});

test("settings store validates the Live Call language list but allows empty", async (t) => {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "nova-livecall-langs-"));
  const store = createSettingsStore({ filePath: path.join(directory, "settings.json"), env: {} });
  await store.load();
  await store.save({ subtitle: { liveCallTranslationLanguages: ["ja"] } });
  assert.deepEqual((await store.load()).subtitle.liveCallTranslationLanguages, ["ja"]);
  await store.save({ subtitle: { liveCallTranslationLanguages: [] } });
  assert.deepEqual((await store.load()).subtitle.liveCallTranslationLanguages, []);
  for (const invalid of [["xx"], ["en", "en"], ["en", "ko", "ja", "es"], "en"]) {
    await assert.rejects(store.save({ subtitle: { liveCallTranslationLanguages: invalid } }));
  }
});
