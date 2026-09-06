import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { buildGroundedPostCallIndex, formatSectionTime, searchSelectedTranscript } from "./earnings-presentation";

test("selected transcript search is linear and bounded across 12000 captions", () => {
  let visits = 0;
  const captions = Array.from({ length: 12_000 }, (_, index) => ({
    id: `caption-${index}`,
    text: index % 2 === 0 ? `매출 전망 ${index}` : `운영 현황 ${index}`,
    speakerLabel: "발표자",
  }));
  const results = searchSelectedTranscript(captions, "매출", 50, () => { visits += 1; });
  assert.equal(visits, 12_000);
  assert.equal(results.length, 50);
  assert.ok(results.every((result) => result.text.includes("매출")));
});

test("empty search is inert and post-call index is grounded and progressively bounded", () => {
  assert.deepEqual(searchSelectedTranscript([{ id: "one", text: "본문" }], "   "), []);
  const topics = Array.from({ length: 1_000 }, (_, index) => ({ id: `topic-${index}`, title: `주제 ${index + 1}` }));
  const index = buildGroundedPostCallIndex(
    [{ ordinal: 1, label: "Prepared remarks" }, { ordinal: 2, label: "Q&A" }],
    topics,
    40,
  );
  assert.equal(index.visibleTopics.length, 40);
  assert.equal(index.totalTopicCount, 1_000);
  assert.deepEqual(index.agenda.map((item) => item.label), ["Prepared remarks", "Q&A"]);
  assert.equal(formatSectionTime("not-a-date"), null);
});

test("viewer join validation and snapshots preserve the frozen earnings event fields", () => {
  const source = readFileSync(resolve(process.cwd(), "components/live/viewer-controller-contract.ts"), "utf8");
  for (const field of ["companyName", "ticker", "fiscalPeriod", "eventType", "agenda", "activeSection", "sectionStartedAt"]) {
    assert.match(source, new RegExp(`value\\.session\\.${field}|${field}: snapshot\\.session\\.${field}`, "u"));
    assert.match(source, new RegExp(`${field}: snapshot\\.session\\.${field}`, "u"));
  }
  assert.match(source, /value\.session\.agenda\.every\(isAgendaItem\)/u);
  assert.match(source, /Number\(value\.ordinal\) >= 1/u);
});
