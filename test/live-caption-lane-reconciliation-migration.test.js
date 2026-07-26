import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260726201500_live_caption_lane_reconciliation.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

test("caption lane reconciliation is additive and follows atomic final persistence", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url))).sort();
  assert.ok(migrations.indexOf("20260726064308_atomic_live_final_caption.sql") < migrations.indexOf(migrationName));

  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\bdelete\b|\btruncate\b/iu);
  assert.match(sql, /create or replace function public\.reconcile_live_caption_lane\(\s*p_session_id uuid,\s*p_language text\s*\)/iu);
  assert.match(sql, /returns jsonb/iu);
});

test("reconciliation serializes on the session row and returns the durable lane maximum", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /from public\.live_sessions session_row[\s\S]*where session_row\.id = p_session_id[\s\S]*for update;/iu);
  assert.match(sql, /session_status <> 'live'/iu);
  assert.match(sql, /session_row\.expires_at > statement_timestamp\(\)/iu);
  assert.match(sql, /not \(p_language = any\(session_languages\)\)/iu);
  assert.match(sql, /coalesce\(max\(utterance_row\.seq\), 0\)/iu);
  assert.match(sql, /utterance_row\.session_id = p_session_id[\s\S]*utterance_row\.language = p_language/iu);
  assert.match(sql, /jsonb_build_object\(\s*'max_seq',\s*last_utterance_seq\s*\)/iu);
});

test("caption lane reconciliation is service-role only", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /security definer[\s\S]*set search_path = ''/iu);
  assert.match(sql, /revoke all on function public\.reconcile_live_caption_lane\(uuid, text\)\s*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.reconcile_live_caption_lane\(uuid, text\)\s*to service_role/iu);
});

test("fresh bootstrap contains the reconciliation migration byte-for-byte", async () => {
  const [sql, bootstrap] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  const marker = `-- ${migrationName}`;
  const sectionStart = bootstrap.lastIndexOf(marker);
  assert.notEqual(sectionStart, -1);
  assert.equal(bootstrap.slice(sectionStart + marker.length + 1), sql);
});
