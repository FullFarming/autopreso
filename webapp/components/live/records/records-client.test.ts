import assert from "node:assert/strict";
import test from "node:test";

import { fetchLiveRecordExport, fetchLiveRecordOriginals, fetchLiveRecordRecipients } from "./records-client";

test("original transcript reads use the authoritative cursor endpoint", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: string) => {
    assert.equal(input, "/api/live-records/session-a/transcript?afterSourceSeq=50&pageSize=50");
    return Response.json({ ok: true, data: { transcript: { sessionId: "session-a", items: [],
      afterSourceSeq: 50, pageSize: 50, nextAfterSourceSeq: null, hasNextPage: false, recordingGaps: [] } } });
  });
  assert.equal((await fetchLiveRecordOriginals("session-a", 50)).hasNextPage, false);
});

test("recipients never turn a read error into a misleading empty list", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error: "접근할 수 없습니다." }, { status: 403 }));
  await assert.rejects(fetchLiveRecordRecipients("session-a"), /접근할 수 없습니다/u);
});

test("originals do not claim a complete recording when gap metadata is missing", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, data: { transcript: {
    sessionId: "session-a", items: [], afterSourceSeq: 0, pageSize: 50, nextAfterSourceSeq: null, hasNextPage: false,
  } } }));
  await assert.rejects(fetchLiveRecordOriginals("session-a"), /기록 구간을 확인할 수 없습니다/u);
});

test("export reads a real workbook without list filters or pagination", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    assert.equal(input, "/api/live-records/session-a/export");
    assert.equal(init?.cache, "no-store");
    return new Response(new Uint8Array([80, 75, 3, 4]), { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": "attachment; filename*=UTF-8''%ED%9A%8C%EC%9D%98.xlsx",
    } });
  });
  const result = await fetchLiveRecordExport("session-a");
  assert.equal(result.fileName, "회의.xlsx");
  assert.equal(result.blob.size, 4);
});

test("export refuses JSON errors and unexpected content instead of saving fake Excel", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error: "기록이 너무 큽니다." }, { status: 413 }));
  await assert.rejects(fetchLiveRecordExport("session-a"), /기록이 너무 큽니다/u);
  fetchMock.mock.mockImplementation(async () => new Response("login", { headers: { "Content-Type": "text/html" } }));
  await assert.rejects(fetchLiveRecordExport("session-a"), /Excel 파일/u);
});
