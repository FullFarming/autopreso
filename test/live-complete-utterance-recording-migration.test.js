import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202607240004_live_complete_utterance_recording.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const participantMigrationUrl = new URL(
  "../supabase/migrations/202607230004_live_participant_identity_admission.sql",
  import.meta.url,
);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

test("complete utterance recording migration follows viewer preparing access and stays additive", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202607240003_live_viewer_preparing_access.sql") < migrations.indexOf(migrationName));

  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\btruncate\b/iu);
  assert.match(sql, /create or replace function public\.persist_live_utterance_if_active\(/iu);
});

test("base persistence RPC records every valid final caption without a silent row-count gate", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const functionBody = sql.match(
    /create or replace function public\.persist_live_utterance_if_active\([\s\S]*?\n\$\$;/iu,
  )?.[0] ?? "";

  assert.match(
    functionBody,
    /p_session_id uuid,\s*p_language text,\s*p_seq bigint,\s*p_text text,\s*p_speaker_label text,\s*p_speaker_name text,\s*p_source_ended_at timestamptz,\s*p_emitted_at timestamptz/iu,
  );
  assert.match(functionBody, /security definer[\s\S]*set search_path = ''/iu);
  assert.match(functionBody, /session_status <> 'live'/iu);
  assert.match(functionBody, /not \(p_language = any\(session_languages\)\)/iu);
  assert.match(functionBody, /p_seq is null or p_seq < 1/iu);
  assert.match(functionBody, /char_length\(btrim\(p_text\)\) not between 1 and 8000/iu);
  assert.match(functionBody, /octet_length\(p_text\) > 24000/iu);
  assert.match(functionBody, /on conflict \(session_id, language, seq\) do nothing/iu);
  assert.doesNotMatch(functionBody, /existing_count|count\s*\(\s*\*\s*\)|5000/iu);
});

test("participant attribution overload remains compatible with the uncapped base RPC", async () => {
  const participantSql = await readFile(participantMigrationUrl, "utf8");
  const overload = participantSql.match(
    /create or replace function public\.persist_live_utterance_if_active\(\s*p_session_id uuid,[\s\S]*?p_participant_id uuid[\s\S]*?\n\$\$;/iu,
  )?.[0] ?? "";

  assert.match(overload, /p_source_started_at timestamptz[\s\S]*p_participant_id uuid/iu);
  assert.match(
    overload,
    /stored := public\.persist_live_utterance_if_active\(\s*p_session_id, p_language, p_seq, p_text, p_speaker_label, p_speaker_name,\s*p_source_ended_at, p_emitted_at\s*\)/iu,
  );
});

test("replacement RPC remains service-role-only and is included in fresh-project bootstrap", async () => {
  const [sql, bootstrap] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  const signature =
    "persist_live_utterance_if_active\\(\\s*uuid,\\s*text,\\s*bigint,\\s*text,\\s*text,\\s*text,\\s*timestamptz,\\s*timestamptz\\s*\\)";

  assert.match(
    sql,
    new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*from public, anon, authenticated`, "iu"),
  );
  assert.match(
    sql,
    new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*to service_role`, "iu"),
  );
  assert.match(bootstrap, new RegExp(`supabase/migrations/${migrationName}`, "u"));
  // Scope the scan to THIS migration's own section. Slicing to end-of-file
  // made the assertion read every later section too, and a later migration's
  // filename can itself contain the digits being screened for.
  const sectionStart = bootstrap.indexOf(`supabase/migrations/${migrationName}`);
  const nextSection = bootstrap.indexOf("-- supabase/migrations/", sectionStart + migrationName.length);
  assert.doesNotMatch(
    bootstrap.slice(sectionStart, nextSection === -1 ? undefined : nextSection),
    /existing_count|count\s*\(\s*\*\s*\)|5000/iu,
  );
});
