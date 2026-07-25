import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202607250001_live_utterance_source_text.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

test("source-text migration follows complete utterance recording and stays additive", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202607240004_live_complete_utterance_recording.sql") < migrations.indexOf(migrationName));

  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\btruncate\b/iu);
  assert.match(sql, /add column if not exists source_text text/iu);
  assert.match(sql, /add column if not exists source_language text/iu);
});

test("source text is bounded exactly like the translated text it accompanies", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  // An unbounded original would let one utterance carry an arbitrarily large
  // second payload, doubling every caption row and broadcast frame.
  assert.match(sql, /char_length\(btrim\(source_text\)\) between 1 and 8000/iu);
  assert.match(sql, /octet_length\(source_text\) <= 24000/iu);
  // Same canonical language shape the `language` column already enforces.
  assert.match(sql, /source_language ~ '\^\[A-Za-z\]\{2,3\}\(-\[A-Za-z0-9\]\{2,8\}\)\*\$'/u);
});

test("the provenance overload delegates to the participant overload instead of reimplementing it", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const overload = sql.match(
    /create or replace function public\.persist_live_utterance_if_active\([\s\S]*?\n\$\$;/iu,
  )?.[0] ?? "";

  assert.match(overload, /p_participant_id uuid,\s*p_source_text text,\s*p_source_language text/iu);
  assert.match(overload, /security definer[\s\S]*set search_path = ''/iu);
  // Delegation keeps the live/language/seq/byte gates in exactly one place.
  assert.match(
    overload,
    /stored := public\.persist_live_utterance_if_active\(\s*p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,\s*p_source_started_at, p_source_ended_at, p_emitted_at, p_participant_id\s*\)/iu,
  );
  // An oversized or blank original must not fail the whole caption: the row is
  // already stored, so provenance degrades to null rather than throwing.
  assert.match(overload, /if not stored then\s*return stored;/iu);
});

test("the provenance overload is service-role-only and reaches fresh projects", async () => {
  const [sql, bootstrap] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  const signature =
    "persist_live_utterance_if_active\\(\\s*uuid,\\s*text,\\s*bigint,\\s*text,\\s*text,\\s*text,\\s*timestamptz,\\s*timestamptz,\\s*timestamptz,\\s*uuid,\\s*text,\\s*text\\s*\\)";

  assert.match(
    sql,
    new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*from public, anon, authenticated`, "iu"),
  );
  assert.match(
    sql,
    new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*to service_role`, "iu"),
  );
  assert.match(bootstrap, new RegExp(`supabase/migrations/${migrationName}`, "u"));
});
