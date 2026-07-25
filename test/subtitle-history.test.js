import assert from "node:assert/strict";
import { test } from "node:test";

import { assertLocalOllamaBaseURL, createSubtitleHistory, historyToCsv } from "../src/subtitle-history.js";

test("historyToCsv renders Excel-ready rows with proper escaping", () => {
  const csv = historyToCsv({
    records: [
      {
        createdAt: "2026-06-12T05:30:00.000Z",
        source: "mic",
        targetLanguage: "en",
        topic: "MRG, Financing",
        translatedText: 'He said "the gap widened", then paused.',
      },
      {
        createdAt: "2026-06-12T05:31:00.000Z",
        source: "system",
        targetLanguage: "ko",
        topic: "Market",
        translatedText: "공급이 제한적입니다",
      },
    ],
  });

  const lines = csv.split("\r\n");
  assert.equal(lines[0], "날짜,시간,입력,언어,주제,번역");
  // Quotes and commas must be escaped CSV-style so Excel parses one row per record.
  assert.match(lines[1], /"He said ""the gap widened"", then paused\."/);
  assert.match(lines[1], /"MRG, Financing"/);
  assert.match(lines[2], /공급이 제한적입니다/);
  assert.equal(lines.length, 3);
});

test("subtitle history records translated text only and groups by Ollama topic", async () => {
  const calls = [];
  const history = createSubtitleHistory({
    settingsStore: {
      load: async () => ({
        subtitle: {
          recordProvider: "ollama",
          ollamaBaseURL: "http://127.0.0.1:11434",
          ollamaModel: "gemma3n:e2b",
        },
      }),
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ message: { content: JSON.stringify({ topic: "Market leasing" }) } }),
      };
    },
    now: () => new Date("2026-05-17T00:00:00.000Z"),
  });

  const snapshot = await history.record({
    source: "system",
    sourceText: "This source text must not be stored.",
    translatedText: "임대 시장이 회복되고 있습니다.",
    targetLanguage: "ko",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(calls[0].body.model, "gemma3n:e2b");
  assert.equal(snapshot.records[0].translatedText, "임대 시장이 회복되고 있습니다.");
  assert.equal(snapshot.records[0].sourceText, undefined);
  assert.equal(snapshot.topics[0].topic, "Market leasing");
  assert.equal(snapshot.topics[0].count, 1);
});

test("subtitle history falls back to heuristic topics when local Gemma is unavailable", async () => {
  const history = createSubtitleHistory({
    settingsStore: {
      load: async () => ({
        subtitle: {
          recordProvider: "ollama",
          ollamaBaseURL: "http://127.0.0.1:11434",
          ollamaModel: "gemma3n:e2b",
        },
      }),
    },
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });

  const snapshot = await history.record({ translatedText: "Office demand increased again" });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.topics[0].topic, "Office demand increased again");
  assert.match(snapshot.recorderStatus.lastError, /HTTP 404/);
});

test("subtitle history persists records through the settings store", async () => {
  /** @type {any} */
  let savedPatch = null;
  const settings = {
    subtitle: { recordProvider: "none" },
    subtitleHistory: {
      records: [{ id: "saved", topic: "Saved topic", translatedText: "저장된 문장", createdAt: "2026-05-17T00:00:00.000Z" }],
    },
  };
  const history = createSubtitleHistory({
    // persistDelayMs 0 = write-per-record, so the saved shape can be asserted
    // synchronously; production batching is covered in queue-backpressure.test.js.
    persistDelayMs: 0,
    settingsStore: {
      load: async () => settings,
      save: async (patch) => {
        savedPatch = patch;
        settings.subtitleHistory = patch.subtitleHistory;
        return settings;
      },
    },
  });

  await history.hydrate();
  assert.equal(history.getSnapshot().records[0].translatedText, "저장된 문장");
  await history.record({ translatedText: "새 번역 문장" });
  assert.ok(savedPatch);
  assert.equal(savedPatch.subtitleHistory.records[0].translatedText, "새 번역 문장");
  assert.equal(savedPatch.subtitleHistory.historyDays, undefined);
  assert.equal(savedPatch.subtitleHistory.dateGroups, undefined);
});

test("subtitle history groups records by created date with newest days first", async () => {
  const dates = [
    new Date("2026-05-17T15:30:00.000Z"),
    new Date("2026-05-16T23:00:00.000Z"),
  ];
  const history = createSubtitleHistory({
    settingsStore: { load: async () => ({ subtitle: { recordProvider: "none" } }) },
    now: () => dates.shift() ?? new Date("2026-05-17T00:00:00.000Z"),
  });

  await history.record({ translatedText: "둘째 날 기록" });
  const snapshot = await history.record({ translatedText: "첫째 날 기록" });

  assert.deepEqual(snapshot.historyDays.map((group) => group.dateKey), ["2026-05-18", "2026-05-17"]);
  assert.equal(snapshot.historyDays[0].label, "2026-05-18");
  assert.equal(snapshot.historyDays[0].latestAt, "2026-05-17T15:30:00.000Z");
  assert.equal(snapshot.historyDays[0].count, 1);
  assert.equal(snapshot.historyDays[0].items[0].translatedText, "둘째 날 기록");
  assert.equal(snapshot.historyDays[1].items[0].translatedText, "첫째 날 기록");
  assert.deepEqual(snapshot.dateGroups, snapshot.historyDays);
  assert.equal(snapshot.records.length, 2);
  assert.ok(Array.isArray(snapshot.topics));
});

test("subtitle history groups existing saved records and invalid dates safely", async () => {
  const settings = {
    subtitleHistory: {
      records: [
        { id: "saved-newer", topic: "Saved", translatedText: "최근 저장", createdAt: "2026-05-18T02:00:00.000Z" },
        { id: "saved-invalid", topic: "Saved", translatedText: "날짜 오류", createdAt: "not-a-date" },
        { id: "saved-missing", topic: "Saved", translatedText: "날짜 없음" },
        { id: "saved-older", topic: "Saved", translatedText: "이전 저장", createdAt: "2026-05-17T02:00:00.000Z" },
      ],
    },
  };
  const history = createSubtitleHistory({
    settingsStore: { load: async () => settings },
  });

  await history.hydrate();
  const snapshot = history.getSnapshot();

  assert.deepEqual(snapshot.historyDays.map((group) => group.dateKey), ["2026-05-18", "2026-05-17", "unknown"]);
  assert.equal(snapshot.historyDays[2].label, "Unknown date");
  assert.equal(snapshot.historyDays[2].latestAt, "");
  assert.equal(snapshot.historyDays[2].count, 2);
  assert.deepEqual(
    snapshot.historyDays[2].items.map((record) => record.translatedText),
    ["날짜 오류", "날짜 없음"],
  );
  assert.equal(snapshot.records[1].createdAt, "not-a-date");
  assert.equal(snapshot.records[2].createdAt, "");
});

test("subtitle history rejects non-local Ollama URLs", () => {
  assert.throws(
    () => assertLocalOllamaBaseURL("https://example.com:11434"),
    /localhost/,
  );
});
