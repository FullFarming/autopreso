import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";
import { buildTranscriptSummaryPrompt, createSessionTranscripts, parseSummaryText } from "../src/session-transcripts.js";

async function makeStorageDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "rn-transcripts-"));
}

function sameOriginHeaders(url, headers = {}) {
  return { origin: new URL(url).origin, ...headers };
}

test("records timestamped source and translated lines inside a session", async () => {
  const storageDir = await makeStorageDir();
  let tick = 0;
  const transcripts = createSessionTranscripts({
    storageDir,
    persistDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 6, 24, 12, 0, tick += 10)),
  });

  await transcripts.begin({ sessionId: "session-1", title: "Weekly sync" });
  await transcripts.recordLine({
    sourceText: "안녕하세요 여러분",
    translatedText: "Hello everyone",
    sourceLanguage: "ko",
    targetLanguage: "en",
    source: "mic",
  });
  await transcripts.recordLine({ sourceText: "오늘 안건은 두 가지입니다", translatedText: "", targetLanguage: "" });
  const meta = await transcripts.end();

  assert.equal(meta.id, "session-1");
  assert.equal(meta.lineCount, 2);
  assert.ok(meta.startedAt < meta.endedAt);

  const full = await transcripts.get("session-1");
  assert.equal(full.meta.title, "Weekly sync");
  assert.equal(full.lines.length, 2);
  assert.equal(full.lines[0].sourceText, "안녕하세요 여러분");
  assert.equal(full.lines[0].translatedText, "Hello everyone");
  assert.equal(full.lines[0].source, "mic");
  assert.match(full.lines[0].at, /^2026-07-24T/u);
  assert.ok(full.lines[1].elapsedMs > full.lines[0].elapsedMs);
});

test("lines without an active session or without text are ignored", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({ storageDir, persistDelayMs: 0 });

  await transcripts.recordLine({ sourceText: "버려질 라인" });
  assert.deepEqual(await transcripts.list(), []);

  await transcripts.begin({ sessionId: "session-2" });
  await transcripts.recordLine({ sourceText: "  ", translatedText: "" });
  const meta = await transcripts.end();
  assert.equal(meta.lineCount, 0);
});

test("sessions persist to disk and are listed newest-first by a fresh instance", async () => {
  const storageDir = await makeStorageDir();
  let tick = 0;
  const first = createSessionTranscripts({
    storageDir,
    persistDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 6, 24, 9, 0, tick += 1)),
  });
  await first.begin({ sessionId: "older" });
  await first.recordLine({ sourceText: "첫 세션" });
  await first.end();
  await first.begin({ sessionId: "newer" });
  await first.recordLine({ sourceText: "둘째 세션" });
  await first.end();

  const reloaded = createSessionTranscripts({ storageDir, persistDelayMs: 0 });
  const sessions = await reloaded.list();
  assert.deepEqual(sessions.map((session) => session.id), ["newer", "older"]);
  assert.equal(sessions[0].lineCount, 1);
  assert.equal(sessions[0].hasSummary, false);
  const older = await reloaded.get("older");
  assert.equal(older.lines[0].sourceText, "첫 세션");
});

test("summarize builds a timestamped prompt, stores the parsed summary, and flags the session", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({ storageDir, persistDelayMs: 0 });
  await transcripts.begin({ sessionId: "session-3", title: "제품 회의" });
  await transcripts.recordLine({ sourceText: "출시일은 8월로 확정합니다", translatedText: "Launch is set for August" });
  await transcripts.end();

  const calls = [];
  const summary = await transcripts.summarize("session-3", async ({ system, prompt }) => {
    calls.push({ system, prompt });
    return {
      text: [
        "```json",
        JSON.stringify({
          title: "제품 회의",
          overview: "출시일 논의",
          chapters: [{ heading: "일정", summary: "8월 출시 확정" }],
          decisions: ["8월 출시"],
          actionItems: [{ description: "마케팅 준비", owner: "노엘" }],
        }),
        "```",
      ].join("\n"),
    };
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /\[00:00:00\]/u);
  assert.match(calls[0].prompt, /출시일은 8월로 확정합니다/u);
  assert.equal(summary.title, "제품 회의");
  assert.equal(summary.decisions[0], "8월 출시");

  const sessions = await transcripts.list();
  assert.equal(sessions[0].hasSummary, true);
  const full = await transcripts.get("session-3");
  assert.equal(full.summary.overview, "출시일 논의");
});

test("summarize rejects empty sessions with a clear error", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({ storageDir, persistDelayMs: 0 });
  await transcripts.begin({ sessionId: "session-4" });
  await transcripts.end();
  await assert.rejects(
    transcripts.summarize("session-4", async () => ({ text: "{}" })),
    /기록된 원문이 없습니다/u,
  );
});

test("parseSummaryText tolerates fences and prose around the JSON", () => {
  const parsed = parseSummaryText('여기 요약입니다:\n```json\n{"title":"T","overview":"O"}\n```\n감사합니다');
  assert.equal(parsed.title, "T");
  assert.throws(() => parseSummaryText("no json here"), /요약 응답을 해석하지 못했습니다/u);
});

test("importSession archives an external (Live Call) transcript with speakers and optional summary", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({ storageDir, persistDelayMs: 0 });

  const meta = await transcripts.importSession({
    id: "live-abc",
    title: "Town Hall",
    startedAt: "2026-07-24T01:00:00.000Z",
    endedAt: "2026-07-24T01:30:00.000Z",
    lines: [
      { at: "2026-07-24T01:00:10.000Z", speaker: "Host", sourceText: "안녕하세요" },
      { at: "2026-07-24T01:00:40.000Z", speaker: "김게스트 · 영업", sourceText: "질문 있습니다" },
    ],
    summary: null,
  });
  assert.equal(meta.id, "live-abc");
  assert.equal(meta.lineCount, 2);

  const full = await transcripts.get("live-abc");
  assert.equal(full.lines[0].speaker, "Host");
  assert.equal(full.lines[1].elapsedMs, 40_000);

  // Speakers appear in the summary prompt so the AI can attribute turns.
  const prompt = buildTranscriptSummaryPrompt({ title: full.meta.title, lines: full.lines });
  assert.match(prompt, /Host: 안녕하세요/u);
  assert.match(prompt, /김게스트 · 영업: 질문 있습니다/u);
});

test("caption session audio is archived as playable WAV files per source", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({ storageDir, persistDelayMs: 0 });
  await transcripts.begin({ sessionId: "audio-session" });

  const frame = Buffer.alloc(4800, 7); // 100ms of 24kHz mono PCM16
  await transcripts.appendAudioChunk("mic", frame.toString("base64"));
  await transcripts.appendAudioChunk("mic", frame.toString("base64"));
  await transcripts.appendAudioChunk("system", frame.toString("base64"));
  await transcripts.recordLine({ sourceText: "오디오 보관 확인" });
  const meta = await transcripts.end();

  assert.deepEqual(meta.audioSources, ["mic", "system"]);
  const micPath = await transcripts.getAudioFile("audio-session", "mic");
  assert.ok(micPath);
  const wav = await fs.readFile(micPath);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.length, 44 + frame.length * 2);
  // Unknown source or session yields null, never a path traversal.
  assert.equal(await transcripts.getAudioFile("audio-session", "../evil"), null);
  assert.equal(await transcripts.getAudioFile("nope", "mic"), null);
});

class FakeRealtimeSocket extends EventEmitter {
  constructor(url, init) {
    super();
    this.url = url;
    this.init = init;
    this.sent = [];
    queueMicrotask(() => this.emit("open"));
  }

  send(message) {
    this.sent.push(message);
    const value = JSON.parse(message);
    queueMicrotask(() => this.emit("message", JSON.stringify(value.setup ? { setupComplete: {} } : { type: "session.updated" })));
  }

  close() {
    this.closed = true;
  }
}

function waitForWebSocketMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for websocket message."));
    }, 3000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

test("caption sessions record committed lines start-to-stop and auto-summarize over the API", async () => {
  const transcriptsDir = await makeStorageDir();
  const summaryRequests = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    env: { OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "AIza-test" },
    transcriptsDir,
    subtitleSummaryGenerateText: async (request) => {
      summaryRequests.push(request);
      return { text: JSON.stringify({ title: "자동 요약", overview: "테스트", chapters: [], decisions: [], actionItems: [] }) };
    },
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    }),
    createSubtitleWebSocket: (socketUrl, protocols, init) => new FakeRealtimeSocket(socketUrl, init),
  });

  let ws;
  try {
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers: { Origin: url } });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({
      type: "subtitle:start",
      sessionId: "caption-session",
      settings: { inputMode: "mic", translationProvider: "gemini" },
    }));
    await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:status" && message.status === "api_ready");

    // Mirror lines rebroadcast as subtitle:committed — the transcript recorder
    // must capture the ORIGINAL sourceText, not only the translation.
    ws.send(JSON.stringify({ type: "subtitle:mirror", partial: false, translatedText: "Hello everyone", sourceText: "안녕하세요 여러분" }));
    await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:committed");

    const summaryPromise = waitForWebSocketMessage(ws, (message) => message.type === "subtitle:session-summary");
    ws.send(JSON.stringify({ type: "subtitle:stop", sessionId: "caption-session" }));
    const summaryMessage = await summaryPromise;
    assert.equal(summaryMessage.sessionId, "caption-session");
    assert.equal(summaryMessage.summary.title, "자동 요약");
    assert.match(summaryRequests[0].prompt, /안녕하세요 여러분/u);

    const listResponse = await fetch(`${url}/api/subtitles/sessions`);
    const listBody = await listResponse.json();
    assert.equal(listBody.ok, true);
    assert.equal(listBody.data[0].id, "caption-session");
    assert.equal(listBody.data[0].lineCount, 1);
    assert.equal(listBody.data[0].hasSummary, true);

    const detailResponse = await fetch(`${url}/api/subtitles/sessions/caption-session`);
    const detailBody = await detailResponse.json();
    assert.equal(detailBody.data.lines[0].sourceText, "안녕하세요 여러분");
    assert.equal(detailBody.data.summary.title, "자동 요약");

    const regenResponse = await fetch(`${url}/api/subtitles/sessions/caption-session/summary`, {
      method: "POST",
      headers: sameOriginHeaders(url),
    });
    const regenBody = await regenResponse.json();
    assert.equal(regenBody.ok, true);
    assert.equal(regenBody.data.title, "자동 요약");
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("transcript summary is unavailable without Gemini and never falls back to OpenAI", async () => {
  const transcriptsDir = await makeStorageDir();
  await fs.writeFile(path.join(transcriptsDir, "openai-only.json"), JSON.stringify({
    id: "openai-only",
    title: "OpenAI-only transcript",
    startedAt: "2026-08-15T00:00:00.000Z",
    endedAt: "2026-08-15T00:05:00.000Z",
    lines: [{ at: "2026-08-15T00:01:00.000Z", sourceText: "요약 대상 발화", translatedText: "Line to summarize" }],
    summary: null,
  }));

  let providerDispatchCount = 0;
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    env: { OPENAI_API_KEY: "sk-openai-only", GEMINI_API_KEY: "" },
    transcriptsDir,
    fetchImpl: async (requestUrl) => {
      providerDispatchCount += 1;
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: `raw provider detail ${requestUrl}` }),
      };
    },
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
  });

  try {
    const response = await fetch(`${url}/api/subtitles/sessions/openai-only/summary`, {
      method: "POST",
      headers: sameOriginHeaders(url),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.deepEqual(body, {
      ok: false,
      error: "AI 요약을 사용하려면 Gemini API 키를 설정해 주세요.",
      code: "TRANSCRIPT_SUMMARY_UNAVAILABLE",
    });
    assert.equal(providerDispatchCount, 0);
    assert.equal(JSON.stringify(body).includes("sk-openai-only"), false);
    assert.equal(JSON.stringify(body).includes("gpt"), false);
    assert.equal(JSON.stringify(body).includes("generativelanguage.googleapis.com"), false);
    assert.equal(JSON.stringify(body).includes("raw provider detail"), false);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("Records page exposes the session transcript + AI summary panel", async () => {
  const read = (relative) => fs.readFile(path.join(import.meta.dirname, "..", relative), "utf8");
  // public/ is the only copy — the root-level subtitle-* duplicates this test
  // used to compare against were deleted as dead weight.
  const [html, dashboard, css] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle-dashboard.js"),
    read("public/subtitle.css"),
  ]);
  assert.match(html, /id="session-records-panel"/u);
  assert.match(html, /id="session-records-list"/u);
  assert.match(html, /id="session-records-status"[^>]*role="status"/u);
  assert.match(dashboard, /\/api\/subtitles\/sessions/u);
  assert.match(dashboard, /subtitle:session-summary/u);
  // The generate button lives on the detail subview markup now.
  assert.match(html, /AI 요약 생성/u);
  // Caption-only sessions render as list rows beneath the calendar.
  assert.match(css, /\.records-local-row/u);
});

test("Records page is a month/week/day meeting calendar that opens 원문 + 요약", async () => {
  const read = (relative) => fs.readFile(path.join(import.meta.dirname, "..", relative), "utf8");
  const [html, dashboard, css] = await Promise.all([
    read("public/subtitle.html"),
    read("public/subtitle-dashboard.js"),
    read("public/subtitle.css"),
  ]);
  // Detail subview: back button + side-by-side source transcript and summary.
  assert.match(html, /id="session-record-detail-page"[^>]*hidden/u);
  assert.match(html, /id="session-detail-back"/u);
  assert.match(html, /id="session-detail-transcript"/u);
  assert.match(html, /id="session-detail-summary"/u);
  assert.match(html, /id="session-detail-generate-summary"/u);
  // Cards open the detail view instead of expanding inline buttons.
  assert.match(dashboard, /openSessionRecordDetail/u);
  assert.match(dashboard, /closeSessionRecordDetail/u);
  // Calendar, not a shelf: month/week/day switch, period navigation, and a grid
  // built from the pure view model.
  assert.match(html, /id="records-cal-grid"/u);
  assert.match(html, /data-records-view="month"/u);
  assert.match(html, /data-records-view="week"/u);
  assert.match(html, /data-records-view="day"/u);
  assert.match(html, /id="records-cal-prev"/u);
  assert.match(html, /id="records-cal-next"/u);
  assert.match(html, /id="records-cal-today"/u);
  assert.match(dashboard, /from "\.\/records-calendar\.js"/u);
  assert.match(dashboard, /buildMonthGrid|buildTimeGrid/u);
  assert.match(css, /\.records-month-body \{[^}]*grid-template-columns: repeat\(7/u);
  // Only Live Call meetings are placed on the grid; caption-only sessions have
  // no meeting time and stay in their own list.
  assert.match(dashboard, /kind === "live-call"/u);
  assert.match(html, /id="records-local-sessions"/u);
  // The album-art shelf is gone: a gradient tile said nothing about when a
  // meeting happened.
  assert.doesNotMatch(dashboard, /SESSION_COVER_GRADIENTS|sessionCoverStyle/u);
  assert.doesNotMatch(css, /\.session-record-cover/u);
  assert.match(css, /\.session-detail-columns \{[^}]*grid-template-columns/u);
});

test("prompt caps runaway transcripts instead of growing without bound", () => {
  const lines = Array.from({ length: 5000 }, (_value, index) => ({
    at: "2026-07-24T00:00:00.000Z",
    elapsedMs: index * 1000,
    sourceText: `라인 ${index} ${"가".repeat(60)}`,
    translatedText: "",
  }));
  const prompt = buildTranscriptSummaryPrompt({ title: "긴 세션", lines });
  assert.ok(prompt.length <= 120_000 + 2_000);
  assert.match(prompt, /긴 세션/u);
});

// ── Records-as-calendar data layer. The calendar shows Live Call meetings placed
// at their real start time, so a record must know (a) that it IS a Live Call,
// (b) its title, and (c) an end time even when the app died mid-session. It must
// also be listable without parsing every transcript. ─────────────────────────

test("a Live Call record keeps its kind, title and the call's own start time", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({
    storageDir,
    persistDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 6, 25, 9, 30, 0)),
  });

  // The Live Call went live before captions started, so the call's clock wins.
  const meta = await transcripts.begin({
    sessionId: "live-1",
    kind: "live-call",
    liveSessionId: "supabase-abc",
    title: "Q3 Earnings Call",
    startedAt: "2026-07-25T09:00:00.000Z",
  });

  assert.equal(meta.kind, "live-call");
  assert.equal(meta.liveSessionId, "supabase-abc");
  assert.equal(meta.title, "Q3 Earnings Call");
  assert.equal(meta.startedAt, "2026-07-25T09:00:00.000Z", "the Live Call start anchors the record, not subtitle:start");

  const [listed] = await transcripts.list();
  assert.equal(listed.kind, "live-call");
  assert.equal(listed.startedAt, "2026-07-25T09:00:00.000Z");
});

test("a plain caption session is local and still uses the clock", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({
    storageDir,
    persistDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 6, 25, 11, 0, 0)),
  });

  const meta = await transcripts.begin({ sessionId: "local-1" });
  assert.equal(meta.kind, "local", "records default to local so old files keep working");
  assert.equal(meta.startedAt, "2026-07-25T11:00:00.000Z");
});

test("effectiveEnd falls back to the last line when a session never ended", async () => {
  const storageDir = await makeStorageDir();
  let tick = 0;
  const transcripts = createSessionTranscripts({
    storageDir,
    persistDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 6, 25, 14, 0, tick += 30)),
  });

  await transcripts.begin({ sessionId: "crashed-1", kind: "live-call", title: "Crashed" });
  await transcripts.recordLine({ sourceText: "마지막 줄", translatedText: "last line" });
  // No end() — this is what a killed process leaves behind.

  const [listed] = await transcripts.list();
  assert.equal(listed.endedAt, "", "a guessed end is never written to disk");
  assert.equal(listed.effectiveEnd, "2026-07-25T14:01:00.000Z", "derived from the last recorded line");
  assert.equal(listed.isUnterminated, true, "the UI must be able to show this as unterminated");
});

test("effectiveEnd floors an empty crashed session so it stays clickable", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({
    storageDir,
    persistDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 6, 25, 16, 0, 0)),
    minBlockMs: 15 * 60 * 1000,
  });

  await transcripts.begin({ sessionId: "empty-1", kind: "live-call" });

  const [listed] = await transcripts.list();
  assert.equal(listed.effectiveEnd, "2026-07-25T16:15:00.000Z");
  assert.equal(listed.isUnterminated, true);
});

test("a finished session reports its real end and is not unterminated", async () => {
  const storageDir = await makeStorageDir();
  let tick = 0;
  const transcripts = createSessionTranscripts({
    storageDir,
    persistDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 6, 25, 18, 0, tick += 60)),
  });

  await transcripts.begin({ sessionId: "done-1", kind: "live-call", title: "Done" });
  await transcripts.recordLine({ sourceText: "끝", translatedText: "end" });
  await transcripts.end();

  const [listed] = await transcripts.list();
  assert.notEqual(listed.endedAt, "");
  assert.equal(listed.effectiveEnd, listed.endedAt);
  assert.equal(listed.isUnterminated, false);
});

test("list reads a meta sidecar instead of parsing whole transcripts", async () => {
  const storageDir = await makeStorageDir();
  const transcripts = createSessionTranscripts({
    storageDir,
    persistDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 6, 25, 20, 0, 0)),
  });

  await transcripts.begin({ sessionId: "meta-1", kind: "live-call", title: "Indexed" });
  await transcripts.recordLine({ sourceText: "가", translatedText: "a" });
  await transcripts.end();

  const metaPath = path.join(storageDir, "meta-1.meta.json");
  const sidecar = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.equal(sidecar.title, "Indexed");
  assert.equal(sidecar.kind, "live-call");
  assert.ok(!("lines" in sidecar), "the sidecar must not carry the transcript itself");

  // Corrupt the full transcript. A list() that still succeeds proves it never
  // parsed it -- this is the whole point: a month view must not read 3MB/meeting.
  await fs.writeFile(path.join(storageDir, "meta-1.json"), "{ this is not json");
  const listed = await transcripts.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "Indexed");
});

test("a record with no sidecar is still listed, and the sidecar is backfilled", async () => {
  const storageDir = await makeStorageDir();
  // An existing record written before meta sidecars existed.
  await fs.writeFile(path.join(storageDir, "legacy-1.json"), JSON.stringify({
    id: "legacy-1",
    title: "Legacy meeting",
    startedAt: "2026-07-20T01:00:00.000Z",
    endedAt: "2026-07-20T02:00:00.000Z",
    lines: [{ at: "2026-07-20T01:30:00.000Z", sourceText: "구", translatedText: "old" }],
    summary: null,
  }));

  const transcripts = createSessionTranscripts({ storageDir, persistDelayMs: 0 });
  const [listed] = await transcripts.list();
  assert.equal(listed.title, "Legacy meeting");
  assert.equal(listed.kind, "local", "records predating the field are local");
  assert.equal(listed.effectiveEnd, "2026-07-20T02:00:00.000Z");

  // Self-healing: no migration step, the sidecar appears on first listing.
  const sidecar = JSON.parse(await fs.readFile(path.join(storageDir, "legacy-1.meta.json"), "utf8"));
  assert.equal(sidecar.title, "Legacy meeting");
});

test("list filters by kind and by an inclusive time range", async () => {
  const storageDir = await makeStorageDir();
  const write = (id, kind, startedAt, endedAt) => fs.writeFile(
    path.join(storageDir, `${id}.json`),
    JSON.stringify({ id, kind, title: id, startedAt, endedAt, lines: [], summary: null }),
  );
  await write("july-live", "live-call", "2026-07-10T01:00:00.000Z", "2026-07-10T02:00:00.000Z");
  await write("july-local", "local", "2026-07-11T01:00:00.000Z", "2026-07-11T02:00:00.000Z");
  await write("august-live", "live-call", "2026-08-02T01:00:00.000Z", "2026-08-02T02:00:00.000Z");

  const transcripts = createSessionTranscripts({ storageDir, persistDelayMs: 0 });

  const liveOnly = await transcripts.list({ kind: "live-call" });
  assert.deepEqual(liveOnly.map((s) => s.id), ["august-live", "july-live"]);

  const july = await transcripts.list({ from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T23:59:59.999Z" });
  assert.deepEqual(july.map((s) => s.id), ["july-local", "july-live"]);

  const julyLive = await transcripts.list({ kind: "live-call", from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T23:59:59.999Z" });
  assert.deepEqual(julyLive.map((s) => s.id), ["july-live"]);

  // A meeting that merely overlaps the window counts as inside it.
  const overlap = await transcripts.list({ from: "2026-07-10T01:30:00.000Z", to: "2026-07-10T01:31:00.000Z" });
  assert.deepEqual(overlap.map((s) => s.id), ["july-live"]);
});

test("subtitle:start carries optional meeting identity into the record", async () => {
  const transcriptsDir = await makeStorageDir();
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    env: { OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "AIza-test" },
    transcriptsDir,
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleWebSocket: (socketUrl, protocols, init) => new FakeRealtimeSocket(socketUrl, init),
  });

  let ws;
  try {
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers: { Origin: url } });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({
      type: "subtitle:preflight",
      requestId: "preflight-1",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "session-1" },
    }));
    const preflightAck = await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:preflight-ready");
    assert.equal(preflightAck.requestId, "preflight-1");
    ws.send(JSON.stringify({
      type: "subtitle:start",
      sessionId: "live-9",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "sb-9", title: "Board Review", startedAt: "2026-07-25T05:00:00.000Z" },
    }));
    await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:status" && message.status === "api_ready");

    // The store persists on a 1s debounce, so poll rather than race it.
    let record = null;
    for (let attempt = 0; attempt < 40 && !record; attempt += 1) {
      const body = await (await fetch(new URL("/api/subtitles/sessions?kind=live-call", url))).json();
      record = body.data.find((entry) => entry.id === "live-9") ?? null;
      if (!record) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(record, "the Live Call caption session was not recorded as a live-call");
    assert.equal(record.kind, "live-call");
    assert.equal(record.liveSessionId, "sb-9");
    assert.equal(record.title, "Board Review");
    assert.equal(record.startedAt, "2026-07-25T05:00:00.000Z", "the record is anchored to the call start, not subtitle:start");

    // The same endpoint must still hide it from a local-only query.
    const localOnly = await (await fetch(new URL("/api/subtitles/sessions?kind=local", url))).json();
    assert.equal(localOnly.data.find((entry) => entry.id === "live-9"), undefined);
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

// The point of Live Call at this stage: a participant speaks, and that turn ends
// up in the host's session record with attribution. Participant speech never
// touches the local audio pipeline -- the gateway mirrors its captions to the
// host, the main process forwards them over IPC, and the dashboard relays them
// here. That relay had no test, so a silent break would have cost the recording.
test("a participant's mirrored caption is recorded on the host with attribution", async () => {
  const transcriptsDir = await makeStorageDir();
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    env: { OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "AIza-test" },
    transcriptsDir,
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleWebSocket: (socketUrl, protocols, init) => new FakeRealtimeSocket(socketUrl, init),
  });

  let ws;
  try {
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers: { Origin: url } });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "participant-record",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "sb-1", title: "Town Hall", startedAt: "2026-07-25T06:00:00.000Z" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    // The translated lane: this is what viewers read and what the overlay shows.
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "sb-1",
      partial: false,
      targetLanguage: "en",
      speaker: "김게스트",
      speakerRole: "participant",
      speakerDepartment: "영업",
      speakerJobTitle: "Director",
      translatedText: "Our occupancy recovered in the third quarter.",
      sourceText: "3분기에 객실 점유율이 회복되었습니다",
    }));
    const participantCaption = await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:committed");
    assert.deepEqual(participantCaption.liveCallSpeaker, {
      role: "participant",
      name: "김게스트",
      department: "영업",
      jobTitle: "Director",
    });

    // The untranslated source lane is relayed record-only: it must reach the
    // record so 원문 survives, but must never be broadcast to the overlay.
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "sb-1",
      recordOnly: true,
      partial: false,
      targetLanguage: "ko",
      speaker: "김게스트",
      speakerRole: "participant",
      speakerDepartment: "영업",
      speakerJobTitle: "Director",
      translatedText: "3분기에 객실 점유율이 회복되었습니다",
    }));

    ws.send(JSON.stringify({ type: "subtitle:stop", sessionId: "participant-record" }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    let record = null;
    for (let attempt = 0; attempt < 40 && !record; attempt += 1) {
      const body = await (await fetch(new URL("/api/subtitles/sessions/participant-record", url))).json();
      if (body.ok && body.data?.lines?.length >= 1) record = body.data;
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(record, "the participant's speech never reached the host session record");

    const spoken = record.lines.find((line) => line.translatedText.includes("occupancy recovered"));
    assert.ok(spoken, "the translated participant turn is missing from the record");
    assert.equal(spoken.speaker, "김게스트", "the record must keep who said it");

    const original = record.lines.find((line) => line.sourceText.includes("객실 점유율"));
    assert.ok(original, "the untranslated 원문 is missing from the record");
    assert.equal(original.speaker, "김게스트");
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("a gateway-canonical Live Call records captions without opening the local translation producer", async () => {
  const transcriptsDir = await makeStorageDir();
  let localSocketCount = 0;
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: {},
    transcriptsDir,
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleWebSocket: () => { localSocketCount += 1; return new FakeRealtimeSocket(); },
  });
  let ws;
  try {
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers: { Origin: url } });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({
      type: "subtitle:start",
      captionProducer: "gateway",
      sessionId: "live-session-1",
      settings: { inputMode: "mic", translationProvider: "gemini" },
      meeting: { kind: "live-call", liveSessionId: "session-1", title: "Canonical call" },
    }));
    const startAck = await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:started");
    assert.equal(startAck.sessionId, "live-session-1");
    assert.equal(startAck.captionProducer, "gateway");
    const attacker = new WebSocket(url.replace("http:", "ws:") + "/ws");
    await new Promise((resolve, reject) => { attacker.once("open", resolve); attacker.once("error", reject); });
    attacker.send(JSON.stringify({ type: "subtitle:stop", sessionId: "live-session-1" }));
    const stopRejection = await waitForWebSocketMessage(attacker, (message) => message.code === "SUBTITLE_SESSION_MISMATCH");
    assert.equal(stopRejection.type, "subtitle:error");
    const stillActive = await (await fetch(new URL("/api/subtitles/sessions/live-session-1", url))).json();
    assert.equal(stillActive.data.meta.endedAt, "", "a secondary renderer must not finalize the active record");
    const injected = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.translatedText === "Injected caption") injected.push(message);
    });
    attacker.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      partial: false,
      targetLanguage: "en",
      speakerRole: "host",
      translatedText: "Injected caption",
      speaker: "Forged participant",
    }));
    const rejection = await waitForWebSocketMessage(attacker, (message) => (
      message.code === "LIVE_CALL_CAPTION_PRODUCER_MISMATCH"
    ));
    assert.equal(rejection.type, "subtitle:error");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(injected.length, 0, "a non-owner loopback socket must not inject Live Call captions");
    attacker.close();
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "different-session",
      partial: false,
      targetLanguage: "en",
      translatedText: "Wrong session caption",
    }));
    const sessionRejection = await waitForWebSocketMessage(ws, (message) => (
      message.code === "LIVE_CALL_CAPTION_SESSION_MISMATCH"
    ));
    assert.equal(sessionRejection.type, "subtitle:error");
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "session-1",
      recordOnly: true,
      partial: false,
      targetLanguage: "ko",
      speakerRole: "host",
      utteranceKey: "session-1:input:1",
      translatedText: "안녕하세요",
    }));
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "session-1",
      partial: false,
      targetLanguage: "en",
      speakerRole: "host",
      utteranceKey: "session-1:input:1",
      sourceSeq: 41,
      sourceLanguage: "ko",
      sourceText: "안녕하세요",
      translatedText: "Hello.",
    }));
    const hostCaption = await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:committed");
    assert.equal(
      hostCaption.utteranceKey,
      "session-1:input:1",
      "the desktop overlay must receive the canonical Live Call utterance identity",
    );
    assert.equal(hostCaption.sourceSeq, 41, "the gateway sequence must survive the desktop relay as fallback identity");
    assert.deepEqual(hostCaption.liveCallSpeaker, {
      role: "host",
      name: "Host",
      department: "",
      jobTitle: "",
    });
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "session-1",
      recordOnly: true,
      partial: false,
      targetLanguage: "ko",
      utteranceKey: "session-1:input:2",
      translatedText: "안녕하세요",
    }));
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "session-1",
      partial: false,
      targetLanguage: "en",
      utteranceKey: "session-1:input:2",
      sourceLanguage: "ko",
      sourceText: "안녕하세요",
      translatedText: "Hello.",
    }));
    await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:committed");
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "session-1",
      recordOnly: true,
      partial: false,
      targetLanguage: "ko",
      speakerRole: "host",
      translatedText: "키가 없는 원문",
    }));
    ws.send(JSON.stringify({
      type: "subtitle:live-call-caption",
      sessionId: "session-1",
      partial: false,
      targetLanguage: "en",
      speakerRole: "host",
      sourceLanguage: "ko",
      translatedText: "Unkeyed translated line.",
    }));
    await waitForWebSocketMessage(ws, (message) => message.type === "subtitle:committed"
      && message.translatedText === "Unkeyed translated line.");
    ws.send(JSON.stringify({ type: "subtitle:stop", sessionId: "live-session-1" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const body = await (await fetch(new URL("/api/subtitles/sessions/live-session-1", url))).json();
    assert.equal(body.ok, true);
    assert.equal(body.data.lines[0].sourceText, "안녕하세요");
    assert.equal(body.data.lines[0].translatedText, "Hello.");
    assert.equal(body.data.lines.length, 3, "keyed duplicates and the unkeyed FIFO pair must each remain one record");
    assert.equal(body.data.lines[2].sourceText, "키가 없는 원문");
    assert.equal(body.data.lines[2].translatedText, "Unkeyed translated line.");
    assert.equal(localSocketCount, 0, "the local Gemini/OpenAI producer must remain cold");
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("a transcript begin failure compensates the already-opened local providers", async () => {
  const root = await makeStorageDir();
  const unusableStoragePath = path.join(root, "not-a-directory");
  await fs.writeFile(unusableStoragePath, "occupied");
  const providerSockets = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    env: { GEMINI_API_KEY: "AIza-test" },
    transcriptsDir: unusableStoragePath,
    transcriptPersistDelayMs: 0,
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, close: () => {} }),
    createSubtitleWebSocket: (socketUrl, protocols, init) => {
      const socket = new FakeRealtimeSocket(socketUrl, init);
      providerSockets.push(socket);
      return socket;
    },
  });
  let ws;
  try {
    ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers: { Origin: url } });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({
      type: "subtitle:start",
      sessionId: "begin-failure",
      settings: { inputMode: "mic", translationProvider: "gemini" },
    }));
    const error = await waitForWebSocketMessage(ws, (message) => message.code === "SUBTITLE_START_FAILED");
    assert.equal(error.sessionId, "begin-failure");
    assert.ok(providerSockets.length > 0);
    assert.equal(providerSockets.every((socket) => socket.closed === true), true);
  } finally {
    ws?.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("the record detail keeps 원문 per language and pulls audio from the record's own meta", async () => {
  const [html, dashboard] = await Promise.all([
    fs.readFile(path.join(import.meta.dirname, "..", "public/subtitle.html"), "utf8"),
    fs.readFile(path.join(import.meta.dirname, "..", "public/subtitle-dashboard.js"), "utf8"),
  ]);
  // Left side: one tab per language. Right side: the AI summary.
  assert.match(html, /data-transcript-lang="en"/u);
  assert.match(html, /data-transcript-lang="ko"/u);
  assert.match(html, /id="session-detail-summary"/u);
  assert.match(html, /id="session-detail-export"/u);
  assert.match(dashboard, /function transcriptTextForLanguage/u);

  // A calendar chip carries only id and title, so the detail must read
  // audioSources and lineCount off the fetched record or the audio players
  // silently vanish -- which is exactly what happened.
  assert.match(dashboard, /Array\.isArray\(meta\.audioSources\)/u);

  // The live topic/committed panels follow the RUNNING session; under Records
  // they described nothing the page was about.
  const recordsPage = html.slice(html.indexOf('data-workspace-page="records"'), html.indexOf('data-workspace-page="settings"'));
  assert.doesNotMatch(recordsPage, /history-panel|translation-log-panel/u);
  const captionsPage = html.slice(html.indexOf('data-workspace-page="captions"'), html.indexOf('data-workspace-page="livecall"'));
  assert.match(captionsPage, /history-panel/u);
  assert.match(captionsPage, /translation-log-panel/u);
});

test("a language tab shows whichever side of a turn is in that language", async () => {
  const dashboard = await fs.readFile(path.join(import.meta.dirname, "..", "public/subtitle-dashboard.js"), "utf8");
  const body = dashboard.slice(
    dashboard.indexOf("function transcriptTextForLanguage"),
    dashboard.indexOf("function renderSessionTranscript"),
  );
  const transcriptTextForLanguage = new Function(`${body}; return transcriptTextForLanguage;`)();

  // Korean speaker: Korean is the SOURCE, English the translation.
  const koTurn = { sourceText: "회복되었습니다", translatedText: "It recovered.", sourceLanguage: "ko", targetLanguage: "en" };
  assert.equal(transcriptTextForLanguage(koTurn, "en"), "It recovered.");
  assert.equal(transcriptTextForLanguage(koTurn, "ko"), "회복되었습니다");
  // English speaker: the same line, reversed. A naive "translatedText for EN"
  // rule would print Korean on the English tab.
  const enTurn = { sourceText: "What drove it?", translatedText: "무엇이 이끌었나요?", sourceLanguage: "en", targetLanguage: "ko" };
  assert.equal(transcriptTextForLanguage(enTurn, "en"), "What drove it?");
  assert.equal(transcriptTextForLanguage(enTurn, "ko"), "무엇이 이끌었나요?");
  // Unlabelled (older records, record-only 원문 relay): never drop the turn.
  assert.equal(transcriptTextForLanguage({ sourceText: "원문만", translatedText: "" }, "en"), "원문만");
  // A line with nothing in that language is skipped, not mislabelled.
  assert.equal(transcriptTextForLanguage({ sourceText: "只有中文", sourceLanguage: "zh", targetLanguage: "zh" }, "en"), "");
});
