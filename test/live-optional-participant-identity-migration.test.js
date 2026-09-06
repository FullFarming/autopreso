import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260727010000_live_optional_participant_identity.sql",
  import.meta.url,
);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("optional participant identity is nullable with bounded canonical values", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter column department drop not null/iu);
  assert.match(sql, /alter column job_title drop not null/iu);
  assert.match(sql, /department is null or \([\s\S]*char_length\(department\) between 1 and 80/iu);
  assert.match(sql, /job_title is null or \([\s\S]*char_length\(job_title\) between 1 and 100/iu);
  assert.match(sql, /nullif\(normalize\(btrim\(coalesce\(p_department, ''\)\), NFC\), ''\)/iu);
  assert.match(sql, /nullif\(normalize\(btrim\(coalesce\(p_job_title, ''\)\), NFC\), ''\)/iu);
  assert.match(sql, /set department = normalized_department,[\s\S]*job_title = normalized_job_title/iu);
});

test("optional identity keeps v3 RPC signatures and service-role-only grant security", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.apply_live_viewer_grant\([\s\S]*p_department text,[\s\S]*p_job_title text/iu);
  assert.doesNotMatch(sql, /create or replace function public\.redeem_live_(?:admission|invite)_v4/iu);
  assert.match(sql, /security definer\s+set search_path = ''/iu);
  assert.match(sql, /revoke all on function public\.apply_live_viewer_grant\([\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.apply_live_viewer_grant\([\s\S]*to service_role/iu);
});
