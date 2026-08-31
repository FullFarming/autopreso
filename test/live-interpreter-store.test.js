import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createLiveInterpreterStore } from "../src/live-interpreter/index.js";

const NOW = "2026-08-01T00:00:00.000Z";

function record(overrides = {}) {
  return {
    id: "record-1",
    sessionId: "session-1",
    lane: "INBOUND",
    sourceLanguage: "en",
    targetLanguage: "ko",
    sourceText: "Hello\u0000",
    translatedText: "Cafe\u0301",
    createdAt: NOW,
    audioBase64: "must-not-persist",
    ...overrides,
  };
}

test("serialized atomic store persists only allowlisted sanitized committed transcript fields", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "live-interpreter-store-"));
  const store = createLiveInterpreterStore({ directory });
  await Promise.all([
    store.appendRecord(record()),
    store.appendRecord(record({ id: "record-2", sourceText: "Second" })),
  ]);
  const records = await store.readRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].sourceText, "Hello");
  assert.equal(records[0].translatedText, "Café");
  assert.equal(Object.hasOwn(records[0], "audioBase64"), false);

  const raw = await readFile(path.join(directory, "transcripts.json"), "utf8");
  assert.equal(raw.includes("must-not-persist"), false);
  assert.equal(raw.endsWith("\n"), true);
});

test("store bounds retained records and rejects unsupported lane or language", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "live-interpreter-store-"));
  const store = createLiveInterpreterStore({ directory, maxRecords: 2 });
  await store.appendRecord(record({ id: "record-1" }));
  await store.appendRecord(record({ id: "record-2" }));
  await store.appendRecord(record({ id: "record-3" }));
  assert.deepEqual((await store.readRecords()).map((item) => item.id), ["record-2", "record-3"]);
  await assert.rejects(
    store.appendRecord(record({ lane: "SIDE" })),
    (error) => error instanceof Error && "code" in error && error.code === "INVALID_LANE",
  );
  await assert.rejects(
    store.appendRecord(record({ targetLanguage: "xx" })),
    (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_LANGUAGE",
  );
});

test("corrupt store is quarantined and returns an empty fail-closed record set", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "live-interpreter-store-"));
  await writeFile(path.join(directory, "transcripts.json"), "{not-json", "utf8");
  const store = createLiveInterpreterStore({ directory, nowMilliseconds: () => 123 });
  assert.deepEqual(await store.readRecords(), []);
  const quarantined = await readFile(path.join(directory, "transcripts.json.quarantine-123"), "utf8");
  assert.equal(quarantined, "{not-json");
});
