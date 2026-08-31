import assert from "node:assert/strict";
import test from "node:test";
import { groupTranscriptReading, type ReadingFragment } from "./transcript-reading-model";

function fragment(seq: number, changes: Partial<ReadingFragment> = {}): ReadingFragment {
  return { id: `source-${seq}`, seq, speakerKey: "participant:one", speaker: "김현우",
    startedAt: new Date(Date.UTC(2026, 7, 31, 4, 0, seq * 10)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 7, 31, 4, 0, seq * 10 + 5)).toISOString(),
    text: `실제 발언 ${seq}입니다.`, language: "ko", ...changes };
}

test("continuous speech keeps one speaker header and readable paragraphs without modifying source fragments", () => {
  const entries = Array.from({ length: 7 }, (_, i) => Object.freeze(fragment(i + 1)));
  const turns = groupTranscriptReading(Object.freeze(entries));
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].paragraphs.map((p) => p.fragments.length), [3, 3, 1]);
  assert.deepEqual(turns[0].paragraphs.flatMap((p) => p.fragments), entries);
  assert.equal(turns[0].startedAt, entries[0].startedAt);
  assert.equal(turns[0].endedAt, entries[6].endedAt);
});

test("same display names never merge distinct identities and returning speakers create another turn", () => {
  const entries = [fragment(1), fragment(2, { speakerKey: "participant:two" }), fragment(3)];
  assert.equal(groupTranscriptReading(entries).length, 3);
});

test("page boundaries do not repeat the header, but missing sequence or recording intervals do", () => {
  assert.equal(groupTranscriptReading([fragment(50), fragment(51)]).length, 1);
  assert.equal(groupTranscriptReading([fragment(50), fragment(52)]).length, 2);
  const entries = [fragment(1), fragment(2)];
  const gap = { startedAt: "2026-08-31T04:00:16.000Z", endedAt: "2026-08-31T04:00:19.000Z" };
  assert.equal(groupTranscriptReading(entries, [gap]).length, 2);
  assert.equal(groupTranscriptReading(entries, [{ ...gap, endedAt: null }]).length, 2);
});

test("language, topic and a long pause start paragraphs without repeating the same speaker", () => {
  const entries = [fragment(1), fragment(2, { language: "en" }), fragment(3, { language: "en", topicId: "qa" }),
    fragment(4, { language: "en", topicId: "qa", startedAt: "2026-08-31T04:01:20Z", endedAt: "2026-08-31T04:01:25Z" })];
  const turns = groupTranscriptReading(entries);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].paragraphs.map((p) => p.fragments.length), [1, 1, 1, 1]);
});

test("sentence fragments are never broken only because they are long", () => {
  const entries = [fragment(1, { text: "가".repeat(450) }), fragment(2, { text: "이어지는 문장입니다." }), fragment(3)];
  assert.deepEqual(groupTranscriptReading(entries)[0].paragraphs.map((p) => p.fragments.length), [2, 1]);
});

test("real numbering, line breaks, HTML-like text and corrected originals remain untouched", () => {
  const entry = fragment(1, { text: "1. 실제 항목\n\n<script>내용</script>", isCorrected: true, rawText: "수정 전 원문" });
  const result = groupTranscriptReading([entry])[0].paragraphs[0].fragments[0];
  assert.strictEqual(result, entry);
  assert.equal(result.text, "1. 실제 항목\n\n<script>내용</script>");
  assert.equal(result.rawText, "수정 전 원문");
});

test("untrusted time boundaries cannot imply continuous recording", () => {
  assert.deepEqual(groupTranscriptReading([]), []);
  assert.equal(groupTranscriptReading([fragment(1, { endedAt: "Invalid Date" }), fragment(2)]).length, 2);
});
