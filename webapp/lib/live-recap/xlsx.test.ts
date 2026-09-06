import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildLiveRecordWorkbook, splitExcelText } from "./xlsx";
import { RECAP_NOTICE_VERSION, type RecordExportSnapshot } from "./contract";

export function snapshotFixture(): RecordExportSnapshot {
  const id = "11111111-1111-4111-8111-111111111111";
  const participantId = "22222222-2222-4222-8222-222222222222";
  return {
    snapshotId: "33333333-3333-4333-8333-333333333333", generatedAt: "2026-08-31T01:00:00Z",
    session: { id, title: "=HYPERLINK(\"https://attacker.test\",\"run\")", status: "stopped",
      scheduledAt: null, endedAt: "2026-08-31T00:00:00Z", languages: ["ko"] },
    participants: [{ id: participantId, displayName: " \t=1+1", email: "viewer@example.test", company: "@SUM(A1)", department: "", jobTitle: "", joinedAt: "2026-08-30T23:00:00Z" }],
    utterances: Array.from({ length: 75 }, (_, index) => ({
      id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`, seq: index + 1,
      speaker: "+external", language: "ko", startedAt: null, endedAt: "2026-08-31T00:00:00Z", text: `발언 ${index + 1}`, topicTitle: null,
    })),
    recordingGaps: [],
    summaries: [{ language: "ko", status: "ready", createdAt: "2026-08-31T00:01:00Z", summary: { title: "요약", overview: "-1+1", decisions: ["확정 사항"] } }],
    requests: [{ id: "55555555-5555-4555-8555-555555555555", sessionId: id, participantId,
      requestedAt: "2026-08-31T00:02:00Z", noticeVersion: RECAP_NOTICE_VERSION, status: "requested", email: "viewer@example.test", revision: 1,
      displayName: "참가자", company: null, department: "", jobTitle: "", consentAcceptedAt: "2026-08-31T00:02:00Z", cancelledAt: null }],
  };
}

test("full record XLSX has five sheets, all 75 transcript rows, and literal hostile text without links or formulas", async () => {
  const snapshot = snapshotFixture();
  const bytes = await buildLiveRecordWorkbook(snapshot);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["회의 정보", "참여자", "원문", "AI 요약", "수신 신청자"]);
  const original = workbook.getWorksheet("원문");
  assert.equal(original?.rowCount, 76);
  assert.equal(original?.getCell("H76").value, "발언 75");
  assert.equal(workbook.getWorksheet("참여자")?.getCell("B2").value, " \t=1+1");
  for (const sheet of workbook.worksheets) sheet.eachRow((row) => row.eachCell((cell) => {
    assert.equal(cell.formula, undefined);
    assert.equal(cell.hyperlink, undefined);
    assert.ok(typeof cell.value === "string" || typeof cell.value === "number");
  }));
});

test("long Korean and surrogate-pair text is split losslessly into explicit continuation rows", async () => {
  const longText = "한글😀".repeat(12_000);
  const chunks = splitExcelText(longText);
  assert.equal(chunks.join(""), longText);
  assert.ok(chunks.every((chunk) => chunk.length <= 30_000 && !/[\uD800-\uDBFF]$/u.test(chunk)));
  const snapshot = snapshotFixture();
  const bytes = await buildLiveRecordWorkbook({ ...snapshot, utterances: [{ ...snapshot.utterances[0], text: longText }] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  const sheet = workbook.getWorksheet("원문");
  assert.equal(sheet?.rowCount, chunks.length + 1);
  const restored = chunks.map((_, index) => sheet?.getCell(`H${index + 2}`).value).join("");
  assert.equal(restored.length, longText.length);
  assert.equal(restored === longText, true, "XLSX text must preserve every UTF-16 unit across ZIP and cell boundaries");
});

test("literal SpreadsheetML-looking text stays literal and source sequence survives overlapping capture clocks", async () => {
  const snapshot = snapshotFixture();
  const firstText = "literal _x0041_ _xD83D_ _x005F_ and 😀";
  const bytes = await buildLiveRecordWorkbook({ ...snapshot, utterances: [
    { ...snapshot.utterances[0], text: firstText, endedAt: "2026-08-31T00:00:10Z" },
    { ...snapshot.utterances[1], text: "두 번째", endedAt: "2026-08-31T00:00:09Z" },
  ] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  assert.equal(workbook.getWorksheet("원문")?.getCell("H2").value, firstText);
  assert.equal(workbook.getWorksheet("원문")?.getCell("H3").value, "두 번째");
});

test("oversized exports and unsupported source shapes fail explicitly rather than truncate", async () => {
  await assert.rejects(() => buildLiveRecordWorkbook({ ...snapshotFixture(), utterances: Array.from({ length: 12_001 }, () => snapshotFixture().utterances[0]) }), { code: "EXPORT_TOO_LARGE" });
  const snapshot = snapshotFixture();
  await assert.rejects(() => buildLiveRecordWorkbook({ ...snapshot, summaries: [{ language: "ko", status: "ready", createdAt: null, summary: { value: { nested: { bad: () => 1 } } } }] }), { code: "EXPORT_INVALID_DATA" });
  for (const text of ["before\u0000after", "broken\uD800", "broken\uDC00"]) {
    await assert.rejects(() => buildLiveRecordWorkbook({ ...snapshot, utterances: [{ ...snapshot.utterances[0], text }] }), { code: "EXPORT_INVALID_DATA" });
  }
});

test("recording gaps retain server times and reasons without fabricating missing speech or a closing time", async () => {
  const snapshot = snapshotFixture();
  const recordingGaps = [
    { id: "66666666-6666-4666-8666-666666666666", startedAt: "2026-08-30T23:00:00Z", endedAt: "2026-08-30T23:05:00Z", reason: "no_viewers" as const },
    { id: "77777777-7777-4777-8777-777777777777", startedAt: "2026-08-30T23:59:00Z", endedAt: null, reason: "host_unavailable" as const },
  ];
  const bytes = await buildLiveRecordWorkbook({ ...snapshot, recordingGaps });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  const original = workbook.getWorksheet("원문");
  assert.ok(original);
  assert.equal(original.rowCount, 78);
  assert.equal(original.getCell("A2").value, recordingGaps[0].id);
  assert.equal(original.getCell("C2").value, "미수집 구간");
  assert.equal(original.getCell("E2").value, recordingGaps[0].startedAt);
  assert.equal(original.getCell("F2").value, recordingGaps[0].endedAt);
  assert.equal(original.getCell("F3").value, "종료 시각 미확인");
  assert.match(String(original.getCell("G2").value), /no_viewers/u);
  assert.equal(original.getCell("H3").value, "이 구간의 발언은 수집되지 않았습니다.");
  assert.equal(original.getCell("H78").value, "발언 75");
  const metadata = workbook.getWorksheet("회의 정보");
  assert.ok(metadata);
  const values = metadata.getSheetValues().flatMap((value) => Array.isArray(value) ? value : []);
  assert.ok(values.includes(recordingGaps[0].id));
  assert.ok(values.includes(recordingGaps[0].startedAt));
  assert.ok(values.includes("종료 시각 미확인"));
  assert.ok(values.includes("미수집 구간 수"));
});

test("source recorder failure exports a truthful separate gap while retaining translated/original records", async () => {
  const snapshot = snapshotFixture();
  const gap = { id: "88888888-8888-4888-8888-888888888888", startedAt: "2026-08-30T23:10:00Z", endedAt: "2026-08-30T23:10:15Z", reason: "source_recording_failed" as const };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(await buildLiveRecordWorkbook({ ...snapshot, recordingGaps: [gap] })).buffer);
  const original = workbook.getWorksheet("원문");
  assert.ok(original);
  assert.equal(original.getCell("A2").value, gap.id);
  assert.equal(original.getCell("E2").value, gap.startedAt);
  assert.equal(original.getCell("F2").value, gap.endedAt);
  assert.equal(original.getCell("G2").value, "원문 기록 중단 (source_recording_failed)");
  assert.equal(original.rowCount, 77);
});
