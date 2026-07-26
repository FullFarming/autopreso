import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260726061310_live_snapshot_participant_marker.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

test("participant marker migration follows replay provenance and stays additive", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url))).sort();
  assert.ok(migrations.indexOf("202607260003_live_utterance_replay_provenance.sql") < migrations.indexOf(migrationName));
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\bdelete\b|\btruncate\b/iu);
  assert.match(sql, /rename to persist_live_snapshot_if_active_202607260001/iu);
  assert.match(sql, /revoke all on function public\.persist_live_snapshot_if_active_202607260001\(uuid, text, jsonb\)[\s\S]*service_role/iu);
});

test("wrapper accepts only a boolean isParticipant and delegates every prior invariant", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /\(p_event -> 'speaker'\) \? 'isParticipant'/u);
  assert.match(sql, /jsonb_typeof\(participant_marker\) <> 'boolean'/u);
  assert.match(sql, /public\.persist_live_snapshot_if_active_202607260001\([\s\S]*p_event #- array\['speaker', 'isParticipant'\]::text\[\]/u);
  assert.doesNotMatch(sql, /p_event\s*-\s*'speaker'/u);
  assert.match(sql, /jsonb_set\([\s\S]*array\['speaker', 'isParticipant'\]::text\[\][\s\S]*participant_marker/iu);
  assert.match(sql, /\(stored_event -> 'speaker'\) \? 'isParticipant'[\s\S]*return true/iu);
});

test("public wrapper remains service-role-only and fresh bootstrap is exact", async () => {
  const [sql, bootstrap] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  assert.match(sql, /revoke all on function public\.persist_live_snapshot_if_active\(uuid, text, jsonb\)[\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.persist_live_snapshot_if_active\(uuid, text, jsonb\)[\s\S]*to service_role/iu);
  const marker = `-- ${migrationName}`;
  const sectionStart = bootstrap.lastIndexOf(marker);
  assert.notEqual(sectionStart, -1);
  const contentStart = sectionStart + marker.length + 1;
  const nextMigration = bootstrap.indexOf("\n-- 20260726064308_atomic_live_final_caption.sql", contentStart);
  assert.equal(bootstrap.slice(contentStart, nextMigration === -1 ? undefined : nextMigration), sql);
});
