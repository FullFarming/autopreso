import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider quality runner is development-gated and logs metrics only", async () => {
  const source = await readFile(new URL("../scripts/provider-quality-60s.mjs", import.meta.url), "utf8");
  assert.match(source, /RUN_LIVE_QUALITY_PROBE/u);
  assert.match(source, /LIVE_ALLOWED_GCP_PROJECT/u);
  assert.equal(source.includes("Supabase"), false);
  assert.equal(source.includes("utterance.text}"), false);
  assert.equal(source.includes("process.stdout.write(translated"), false);
  assert.match(source, /JSON\.stringify\(metrics\)/u);
  assert.match(source, /firstTtsAudioMilliseconds/u);
  assert.match(source, /peakBacklogUtterances/u);
  assert.match(source, /QUALITY_BACKLOG_EXCEEDED/u);
  assert.match(source, /120_000/u);
  assert.match(source, /30_000/u);
  assert.match(source, /QUALITY_DIARIZATION/u);
  assert.match(source, /duplicateSourceRanges/u);
  assert.match(source, /continuityDiscardCount/u);
});
