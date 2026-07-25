const MAX_RECORDS = 200;
const MAX_TEXT_CHARS = 700;
const DEFAULT_TOPIC = "General";
const HISTORY_TIME_ZONE = "Asia/Seoul";
const UNKNOWN_DATE_LABEL = "Unknown date";

// Excel-ready CSV of the un-cleared history (translation text only — source
// speech is intentionally never persisted). Times are rendered in KST to match
// the dashboard's day grouping; rows are chronological for spreadsheet reading.
/** @param {any} snapshot */
export function historyToCsv(snapshot = {}) {
  const records = Array.isArray(snapshot.records) ? [...snapshot.records] : [];
  records.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: HISTORY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: HISTORY_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const rows = [["날짜", "시간", "입력", "언어", "주제", "번역"]];
  for (const record of records) {
    const created = new Date(record.createdAt ?? NaN);
    const valid = !Number.isNaN(created.getTime());
    rows.push([
      valid ? dateFormat.format(created) : "",
      valid ? timeFormat.format(created) : "",
      record.source === "system" ? "시스템" : "마이크",
      record.targetLanguage ?? "",
      record.topic ?? "",
      record.translatedText ?? "",
    ]);
  }
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

function csvField(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Batch window for persisting history to settings.json. Every committed
// subtitle line calls record(); rewriting the whole settings file (glossary +
// up to 200 records) per line piles up disk writes during fast speech. One
// trailing write per burst keeps persistence without the write storm.
const DEFAULT_PERSIST_DELAY_MS = 1000;

/** @param {any} options */
export function createSubtitleHistory({ settingsStore, fetchImpl = globalThis.fetch, now = () => new Date(), log = console, persistDelayMs = DEFAULT_PERSIST_DELAY_MS } = {}) {
  const records = [];
  let lastError = "";
  let sequence = 0;
  let hydrated = false;
  let persistTimer = null;

  async function record(message = {}) {
    await hydrate();
    const translatedText = normalizeText(message.translatedText);
    if (!translatedText) return getSnapshot();

    const settings = await loadSubtitleSettings();
    const provider = settings.recordProvider ?? "none";
    let topic = heuristicTopic(translatedText);

    if (provider === "ollama") {
      try {
        topic = await classifyWithOllama({ text: translatedText, settings, fetchImpl });
        lastError = "";
      } catch (error) {
        lastError = error.message || String(error);
        log.warn?.(`[subtitle-history] local topic classification skipped: ${lastError}`);
      }
    }

    const createdAt = now();
    records.unshift({
      id: `subtitle-${createdAt.getTime()}-${sequence += 1}`,
      topic,
      translatedText,
      source: message.source === "system" ? "system" : "mic",
      targetLanguage: typeof message.targetLanguage === "string" ? message.targetLanguage : "",
      createdAt: createdAt.toISOString(),
      provider,
      model: provider === "ollama" ? settings.ollamaModel : "",
    });
    records.splice(MAX_RECORDS);
    await schedulePersist();
    return getSnapshot();
  }

  async function clear() {
    await hydrate();
    records.length = 0;
    lastError = "";
    // Clearing is a deliberate user action — persist immediately (and cancel
    // any pending batch so it can't resurrect the cleared records).
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    await persist();
    return getSnapshot();
  }

  // Trailing-edge batch: the first record() of a burst arms one timer; every
  // line in the burst is included when it fires. persistDelayMs = 0 keeps the
  // old write-per-record behavior (used by tests that assert the saved shape).
  async function schedulePersist() {
    if (!settingsStore?.save) return;
    if (persistDelayMs <= 0) {
      await persist();
      return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist().catch((error) => {
        lastError = error?.message || String(error);
        log.warn?.(`[subtitle-history] batched persist failed: ${lastError}`);
      });
    }, persistDelayMs);
  }

  async function hydrate() {
    if (hydrated || !settingsStore) return;
    const settings = await settingsStore.load();
    const savedRecords = Array.isArray(settings.subtitleHistory?.records) ? settings.subtitleHistory.records : [];
    records.splice(0, records.length, ...savedRecords.map(normalizeSavedRecord).filter(Boolean).slice(0, MAX_RECORDS));
    hydrated = true;
  }

  async function persist() {
    if (!settingsStore?.save) return;
    await settingsStore.save({ subtitleHistory: { records } });
  }

  function getSnapshot() {
    const historyDays = groupHistoryDays(records);
    return {
      records: [...records],
      topics: groupTopics(records),
      historyDays,
      dateGroups: historyDays,
      recorderStatus: {
        lastError,
        maxRecords: MAX_RECORDS,
      },
    };
  }

  async function loadSubtitleSettings() {
    const settings = settingsStore ? await settingsStore.load() : {};
    return {
      recordProvider: "none",
      ollamaBaseURL: "http://127.0.0.1:11434",
      ollamaModel: "gemma3n:e2b",
      ...(settings.subtitle ?? {}),
    };
  }

  return { record, clear, hydrate, getSnapshot };
}

/** @param {any} args */
async function classifyWithOllama({ text, settings, fetchImpl }) {
  const baseURL = assertLocalOllamaBaseURL(settings.ollamaBaseURL);
  const response = await fetchImpl(new URL("/api/chat", baseURL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: settings.ollamaModel,
      stream: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: [
            "Classify this translated subtitle into one short topic label.",
            "Return JSON only: {\"topic\":\"...\"}.",
            "Use 2 to 6 Korean or English words. Do not include the source sentence.",
          ].join(" "),
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  const body = await response.json();
  const content = body?.message?.content ?? body?.response ?? "";
  const parsed = JSON.parse(content);
  return normalizeTopic(parsed.topic) || heuristicTopic(text);
}

export function assertLocalOllamaBaseURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Ollama URL is invalid.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!["http:", "https:"].includes(url.protocol) || !localHosts.has(url.hostname)) {
    throw new Error("Ollama URL must point to localhost.");
  }
  return url;
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

function normalizeTopic(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[{}[\]"']/g, "").replace(/\s+/g, " ").trim().slice(0, 48);
}

function normalizeSavedRecord(value) {
  if (!value || typeof value !== "object") return null;
  const translatedText = normalizeText(value.translatedText);
  if (!translatedText) return null;
  return {
    id: normalizeText(value.id) || `subtitle-saved-${translatedText.slice(0, 24)}`,
    topic: normalizeTopic(value.topic) || DEFAULT_TOPIC,
    translatedText,
    source: value.source === "system" ? "system" : "mic",
    targetLanguage: normalizeText(value.targetLanguage),
    createdAt: normalizeText(value.createdAt),
    provider: value.provider === "ollama" ? "ollama" : "none",
    model: normalizeText(value.model),
  };
}

function heuristicTopic(text) {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .slice(0, 4);
  return normalizeTopic(words.join(" ")) || DEFAULT_TOPIC;
}

function groupTopics(records) {
  const map = new Map();
  for (const record of records) {
    const topic = record.topic || DEFAULT_TOPIC;
    const existing = map.get(topic) ?? { topic, count: 0, latestAt: record.createdAt, items: [] };
    existing.count += 1;
    existing.latestAt = existing.latestAt > record.createdAt ? existing.latestAt : record.createdAt;
    existing.items.push(record);
    map.set(topic, existing);
  }
  return [...map.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

function groupHistoryDays(records) {
  const map = new Map();
  records.forEach((record, index) => {
    const dateInfo = getHistoryDateInfo(record.createdAt);
    const existing = map.get(dateInfo.dateKey) ?? {
      dateKey: dateInfo.dateKey,
      label: dateInfo.label,
      latestAt: dateInfo.latestAt,
      count: 0,
      items: [],
      sortTime: dateInfo.sortTime,
      firstIndex: index,
    };
    existing.count += 1;
    existing.items.push({ record, sortTime: dateInfo.sortTime, index });
    if (dateInfo.sortTime > existing.sortTime) {
      existing.latestAt = dateInfo.latestAt;
      existing.sortTime = dateInfo.sortTime;
    }
    map.set(dateInfo.dateKey, existing);
  });

  return [...map.values()]
    .sort((a, b) => {
      if (a.dateKey === "unknown") return 1;
      if (b.dateKey === "unknown") return -1;
      return b.sortTime - a.sortTime || a.firstIndex - b.firstIndex;
    })
    .map(({ sortTime: _sortTime, firstIndex: _firstIndex, ...group }) => ({
      ...group,
      items: group.items
        .sort((a, b) => b.sortTime - a.sortTime || a.index - b.index)
        .map((item) => item.record),
    }));
}

function getHistoryDateInfo(value) {
  if (typeof value !== "string") {
    return { dateKey: "unknown", label: UNKNOWN_DATE_LABEL, latestAt: "", sortTime: Number.NEGATIVE_INFINITY };
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return { dateKey: "unknown", label: UNKNOWN_DATE_LABEL, latestAt: "", sortTime: Number.NEGATIVE_INFINITY };
  }
  const iso = new Date(time).toISOString();
  const dateKey = formatHistoryDateKey(time);
  return { dateKey, label: dateKey, latestAt: iso, sortTime: time };
}

function formatHistoryDateKey(time) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: HISTORY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return new Date(time).toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
}
