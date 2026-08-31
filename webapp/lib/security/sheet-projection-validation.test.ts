import assert from "node:assert/strict";
import test from "node:test";

import {
  SHEET_CELL_MAX_CODEPOINTS,
  SHEET_TAB_TITLE_MAX_CODEPOINTS,
  assertNoSensitiveSheetJobFields,
  encodeSheetLiteralCell,
  normalizeSheetTabTitle,
  sheetProjectionJobReferenceSchema,
} from "./sheet-projection-validation";

test("Sheet tab titles are NFC, formula-safe, bounded, and collision suffixed", () => {
  assert.equal(normalizeSheetTabTitle("  NOE\u0308L / IR [2026]  "), "NOËL IR 2026");
  assert.equal(normalizeSheetTabTitle("=SUM(A1:A2)"), "_SUM(A1 A2)");
  assert.equal(normalizeSheetTabTitle("+2026-08-15", 2), "_2026-08-15 (2)");

  const boundary = normalizeSheetTabTitle("가".repeat(120), 12);
  assert.equal(Array.from(boundary).length, SHEET_TAB_TITLE_MAX_CODEPOINTS);
  assert.equal(boundary.endsWith(" (12)"), true);
});

test("Sheet tab titles reject empty, control, bidi, markup, and invalid collision values", () => {
  for (const value of ["", " ", "<script>", "safe\u0000title", "safe\u200Btitle", "safe\u202Etitle"]) {
    assert.throws(() => normalizeSheetTabTitle(value), value);
  }
  for (const collisionIndex of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeSheetTabTitle("title", collisionIndex));
  }
});

test("Sheet cells return apostrophe-escaped literals so formula-like text is never executable", () => {
  for (const [value, expected] of [
    ["=HYPERLINK(\"https://evil.example\")", "'=HYPERLINK(\"https://evil.example\")"],
    ["+SUM(1,2)", "'+SUM(1,2)"],
    ["-1+1", "'-1+1"],
    ["@IMPORTXML(\"https://evil.example\")", "'@IMPORTXML(\"https://evil.example\")"],
    ["  =cmd|' /C calc'!A0", "'  =cmd|' /C calc'!A0"],
    ["'=already-literal", "'=already-literal"],
  ] as const) {
    assert.equal(encodeSheetLiteralCell(value), expected);
  }
  assert.equal(encodeSheetLiteralCell(null), "");
  assert.equal(encodeSheetLiteralCell(false), "false");
  assert.equal(encodeSheetLiteralCell(42), "42");
});

test("Sheet cells reject non-finite, oversized, control, bidi, and markup content", () => {
  assert.equal(encodeSheetLiteralCell("a".repeat(SHEET_CELL_MAX_CODEPOINTS)), "a".repeat(SHEET_CELL_MAX_CODEPOINTS));
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "a".repeat(SHEET_CELL_MAX_CODEPOINTS + 1),
    "<script>alert(1)</script>",
    "safe\u0000value",
    "safe\u200Bvalue",
    "safe\u202Evalue",
  ]) assert.throws(() => encodeSheetLiteralCell(value));
});

test("Sheet job references are strict identifiers and contain no PII, URL, content, or credential fields", () => {
  const safe = {
    jobId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    projectionVersion: 3,
    reason: "participant_changed",
  };
  assert.deepEqual(sheetProjectionJobReferenceSchema.parse(safe), safe);
  assert.doesNotThrow(() => assertNoSensitiveSheetJobFields(safe));

  const sensitive = [
    { ...safe, email: "private@example.com" },
    { ...safe, participantId: crypto.randomUUID() },
    { ...safe, transcript: "private" },
    { ...safe, summary: "private" },
    { ...safe, token: "secret" },
    { ...safe, url: "https://evil.example" },
    { ...safe, error: "provider failure" },
    { ...safe, providerMessage: "provider failure" },
    { ...safe, userId: crypto.randomUUID() },
    { ...safe, safeErrorCode: "provider leaked private@example.com" },
  ];
  for (const hostile of sensitive) {
    assert.equal(sheetProjectionJobReferenceSchema.safeParse(hostile).success, false);
    assert.throws(() => assertNoSensitiveSheetJobFields(hostile));
  }
  assert.equal(sheetProjectionJobReferenceSchema.safeParse({ ...safe, projectionVersion: 0 }).success, false);
  for (const reason of [
    "session_created",
    "session_changed",
    "session_ended",
    "participant_changed",
    "consent_changed",
    "archive_deleted",
    "archive_restored",
    "manual_retry",
    "migration_backfill",
  ]) assert.equal(sheetProjectionJobReferenceSchema.safeParse({ ...safe, reason }).success, true, reason);
  for (const reason of ["participant_joined", "explicit_retry"]) {
    assert.equal(sheetProjectionJobReferenceSchema.safeParse({ ...safe, reason }).success, false, reason);
  }
  assert.equal(sheetProjectionJobReferenceSchema.safeParse({
    ...safe,
    projectionVersion: Number.MAX_SAFE_INTEGER + 1,
  }).success, false);
  const failed = { ...safe, safeErrorCode: "SHEETS_PROVIDER_FAILED" };
  assert.equal(sheetProjectionJobReferenceSchema.safeParse(failed).success, false);
  assert.doesNotThrow(() => assertNoSensitiveSheetJobFields(failed));
  assert.doesNotThrow(() => assertNoSensitiveSheetJobFields({
    ...safe,
    safeErrorCode: "SHEETS_CLAIM_LEASE_EXPIRED",
  }));
  assert.doesNotThrow(() => assertNoSensitiveSheetJobFields({ ...safe, safeErrorCode: null }));
  const cyclic: Record<string, unknown> = { jobId: safe.jobId };
  cyclic.self = cyclic;
  assert.throws(() => assertNoSensitiveSheetJobFields(cyclic));
});
