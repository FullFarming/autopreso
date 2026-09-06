import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_GLOSSARY_SOURCE_IDS,
  GlossarySelectionValidationError,
  glossarySelectionContract,
  parseGlossarySelections,
} from "./glossary-selection-validation";
import {
  enforceGlossarySelectionRateLimit,
  type RateLimitStore,
} from "./live-rate-limit";

const hostGlossaryId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";

function assertInvalid(value: unknown): void {
  assert.throws(
    () => parseGlossarySelections(value),
    (error: unknown) => error instanceof GlossarySelectionValidationError
      && error.code === "INVALID_GLOSSARY_SELECTION"
      && error.status === 400,
  );
}

test("selection parser returns one immutable canonical contract for builtin and host glossaries", () => {
  assert.deepEqual(BUILTIN_GLOSSARY_SOURCE_IDS, [
    "common_business",
    "ai_ax",
    "commercial_real_estate",
    "hospitality",
    "fnb_retail",
    "proper_nouns",
    "ko_ja_idioms",
  ]);
  assert.equal(glossarySelectionContract.maximumSelections, 5);

  const parsed = parseGlossarySelections([
    { sourceKind: "builtin", sourceId: "commercial_real_estate" },
    { sourceKind: "host", sourceId: hostGlossaryId.toUpperCase(), documentVersion: 7 },
  ]);

  assert.deepEqual(parsed, [
    { sourceKind: "builtin", sourceId: "commercial_real_estate", documentVersion: 1 },
    { sourceKind: "host", sourceId: hostGlossaryId, documentVersion: 7 },
  ]);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed[0]), true);
  assert.equal(Object.isFrozen(parsed[1]), true);
});

test("selection parser requires a dense one-to-five item array", () => {
  for (const invalid of [
    null,
    undefined,
    {},
    "commercial_real_estate",
    [],
    Array.from({ length: 6 }, () => ({ sourceKind: "builtin", sourceId: "common_business" })),
  ]) assertInvalid(invalid);

  const sparse = new Array(1);
  assertInvalid(sparse);
  const extended = [{ sourceKind: "builtin", sourceId: "common_business" }];
  Object.defineProperty(extended, "attacker", { value: true, enumerable: true });
  assertInvalid(extended);
});

test("selection items are exact discriminated objects", () => {
  let accessorReads = 0;
  const accessorSelection = {
    get sourceKind() {
      accessorReads += 1;
      return "builtin";
    },
    sourceId: "common_business",
  };
  for (const invalid of [
    [null],
    [[]],
    [new Date()],
    [{ sourceKind: "builtin", sourceId: "common_business", documentVersion: 1 }],
    [{ sourceKind: "builtin", sourceId: "common_business", role: "admin" }],
    [{ sourceKind: "host", sourceId: hostGlossaryId }],
    [{ sourceKind: "host", sourceId: hostGlossaryId, documentVersion: 1, fingerprint: `sha256:${"a".repeat(64)}` }],
    [{ sourceKind: "other", sourceId: "common_business" }],
    [JSON.parse('{"sourceKind":"builtin","sourceId":"common_business","__proto__":{"polluted":true}}')],
    [accessorSelection],
  ]) assertInvalid(invalid);
  assert.equal(accessorReads, 0);
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
});

test("builtin selection accepts only the seven catalog IDs and rejects unsafe or non-NFC text", () => {
  for (const sourceId of BUILTIN_GLOSSARY_SOURCE_IDS) {
    assert.equal(parseGlossarySelections([{ sourceKind: "builtin", sourceId }])[0]?.sourceId, sourceId);
  }
  for (const sourceId of [
    "general_cre",
    "hotel",
    "fnb",
    "common_business ",
    "COMMON_BUSINESS",
    "common_business<script>",
    "common\u0000business",
    "common\u200Ebusiness",
    "common\u202Ebusiness",
    "common\u2066business",
    "cafe\u0301",
    "🎉".repeat(glossarySelectionContract.maximumSourceIdCodepoints + 1),
  ]) assertInvalid([{ sourceKind: "builtin", sourceId }]);
});

test("host selection requires a canonical UUID and bounded positive document version", () => {
  for (const sourceId of [
    "",
    "host-owned-id",
    `${hostGlossaryId}<script>`,
    `${hostGlossaryId}\u0000`,
    `${hostGlossaryId}\u200F`,
    `${hostGlossaryId}\u202A`,
    "a".repeat(glossarySelectionContract.maximumSourceIdCodepoints + 1),
  ]) assertInvalid([{ sourceKind: "host", sourceId, documentVersion: 1 }]);

  for (const documentVersion of [
    undefined,
    null,
    "1",
    0,
    -1,
    1.5,
    glossarySelectionContract.maximumDocumentVersion + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) assertInvalid([{ sourceKind: "host", sourceId: hostGlossaryId, documentVersion }]);
});

test("duplicates are rejected by normalized source identity even when versions or UUID case differ", () => {
  for (const invalid of [
    [
      { sourceKind: "builtin", sourceId: "common_business" },
      { sourceKind: "builtin", sourceId: "common_business" },
    ],
    [
      { sourceKind: "host", sourceId: hostGlossaryId, documentVersion: 1 },
      { sourceKind: "host", sourceId: hostGlossaryId, documentVersion: 2 },
    ],
    [
      { sourceKind: "host", sourceId: hostGlossaryId.toUpperCase(), documentVersion: 1 },
      { sourceKind: "host", sourceId: hostGlossaryId, documentVersion: 1 },
    ],
  ]) assertInvalid(invalid);
});

test("glossary mutation uses one opaque host-session bucket capped at 30 requests per minute", async () => {
  const calls: Parameters<RateLimitStore["consumeRateLimit"]>[0][] = [];
  const allowedStore: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push(input);
      return true;
    },
  };
  await enforceGlossarySelectionRateLimit("host-private-id", hostGlossaryId, allowedStore);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    scope: "glossary-selection-host-session",
    keyHash: calls[0]?.keyHash,
    limit: 30,
    windowSeconds: 60,
  });
  assert.match(calls[0]?.keyHash ?? "", /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(calls), /host-private-id|0192d0f4/u);

  const deniedStore: RateLimitStore = {
    async consumeRateLimit() { return false; },
  };
  await assert.rejects(
    () => enforceGlossarySelectionRateLimit("host-private-id", hostGlossaryId, deniedStore),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "GLOSSARY_SELECTION_RATE_LIMITED"
      && "status" in error
      && error.status === 429,
  );
});
