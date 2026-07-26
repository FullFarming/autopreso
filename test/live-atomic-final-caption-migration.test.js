import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260726064308_atomic_live_final_caption.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);
const gatewayAdapterUrl = new URL("../media-gateway/src/supabase-adapters.js", import.meta.url);

test("atomic final migration is additive and follows the participant marker wrapper", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url))).sort();
  assert.ok(migrations.indexOf("20260726061310_live_snapshot_participant_marker.sql") < migrations.indexOf(migrationName));
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\bdelete\b|\btruncate\b/iu);
  assert.match(sql, /create or replace function public\.persist_live_final_caption_if_active\(/iu);
});

test("combined RPC delegates exact wrappers and rolls back every utterance failure", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /snapshot_stored := public\.persist_live_snapshot_if_active\([\s\S]*?p_event[\s\S]*?\);\s*if not snapshot_stored then\s*return false;/iu);
  assert.match(sql, /p_event ->> 'seq'\)::bigint <> p_seq[\s\S]*LIVE_FINAL_SEQUENCE_MISMATCH/iu);
  assert.match(sql, /p_seq > coalesce\(last_utterance_seq, 0\) \+ 1[\s\S]*LIVE_FINAL_SEQUENCE_GAP/iu);
  assert.match(sql, /utterance_stored := public\.persist_live_utterance_if_active\([\s\S]*?p_translation_status[\s\S]*?\);/iu);
  assert.match(sql, /if not utterance_stored then\s*raise exception[\s\S]*LIVE_FINAL_UTTERANCE_PERSIST_FAILED/iu);
  assert.doesNotMatch(sql, /exception\s+when[\s\S]*return true/iu);
});

test("combined RPC and publisher are service-only, single-call, and delivery-after-durability", async () => {
  const [sql, adapter] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(gatewayAdapterUrl, "utf8"),
  ]);
  assert.match(sql, /revoke all on function public\.persist_live_final_caption_if_active\([\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.persist_live_final_caption_if_active\([\s\S]*to service_role/iu);
  assert.match(adapter, /persist_live_final_caption_if_active/u);
  assert.doesNotMatch(adapter, /"\/rest\/v1\/rpc\/persist_live_snapshot_if_active"/u);
  assert.doesNotMatch(adapter, /"\/rest\/v1\/rpc\/persist_live_utterance_if_active"/u);
  assert.ok(
    adapter.indexOf("persist_live_final_caption_if_active") < adapter.indexOf("this.eventFanout(sessionId, language, event)"),
    "durable RPC must complete before final fanout/mirror",
  );
  assert.match(adapter, /failedDurableCaptionLanes\.add\(durableLaneKey\)[\s\S]*DURABLE_CAPTION_PERSIST_FAILED/iu);
  assert.match(adapter, /failedDurableCaptionLanes\.has\(durableLaneKey\)[\s\S]*DURABLE_CAPTION_LANE_FAILED/iu);
});

test("fresh bootstrap contains the atomic migration byte-for-byte", async () => {
  const [sql, bootstrap] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  const marker = `-- ${migrationName}`;
  const sectionStart = bootstrap.lastIndexOf(marker);
  assert.notEqual(sectionStart, -1);
  assert.equal(bootstrap.slice(sectionStart + marker.length + 1), sql);
});
