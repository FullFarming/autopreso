import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608220001_live_authoritative_source_transcript.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);
const recordsMigrationUrl = new URL("../supabase/migrations/202608150005_live_records_sheets_outbox.sql", import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

function extractFunction(sql, functionName) {
  const match = sql.match(new RegExp(
    `create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ));
  assert.ok(match, `${functionName} exists`);
  return match[0];
}

test("authoritative transcript migration is ordered after the current live archive schema and is additive", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202608150007_live_plpgsql_ambiguity_repair.sql") < migrations.indexOf(migrationName));

  const sql = await readMigration();
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\btruncate\b/iu);
  assert.match(sql, /create table public\.live_source_utterances/iu);
  assert.match(sql, /create table public\.live_source_utterance_corrections/iu);
  assert.doesNotMatch(sql, /raw_audio|audio_(blob|bytes|path|url)|storage_object/iu);
});

test("fresh-project bootstrap retains the authoritative transcript migration byte-for-byte", async () => {
  const [sql, bootstrap] = await Promise.all([
    readMigration(),
    readFile(bootstrapUrl, "utf8"),
  ]);
  const marker = `-- supabase/migrations/${migrationName}`;
  assert.equal(bootstrap.split(marker).length - 1, 1);
  assert.ok(
    bootstrap.includes(`${marker}\n\n${sql}\n-- supabase/migrations/202608270001_live_session_multi_glossary_pins.sql`),
    "bootstrap must preserve the exact migration before the later glossary dependency",
  );
});

test("source records keep raw and normalized text separate with two idempotency fences", async () => {
  const sql = await readMigration();
  assert.match(sql, /raw_text text not null/iu);
  assert.match(sql, /normalized_text text not null/iu);
  assert.match(sql, /unique \(session_id, source_seq\)/iu);
  assert.match(sql, /unique \(session_id, utterance_key\)/iu);
  assert.match(sql, /char_length\(btrim\(raw_text\)\) between 1 and 8000[\s\S]*octet_length\(raw_text\) <= 24000/iu);
  assert.match(sql, /normalized_text = normalize\(btrim\(normalized_text\), NFC\)/iu);
  assert.match(sql, /glossary_fingerprint[\s\S]*pipeline_config_fingerprint/iu);
  assert.match(sql, /participant_id uuid[\s\S]*speaker_name text[\s\S]*speaker_department text[\s\S]*speaker_job_title text/iu);
});

test("source commit serializes on the session and returns one stable database sequence", async () => {
  const sql = await readMigration();
  const commit = extractFunction(sql, "persist_authoritative_live_source_utterance_v1");
  assert.match(commit, /security definer[\s\S]*set search_path = ''/iu);
  assert.match(commit, /from public\.live_sessions session_row[\s\S]*for update/iu);
  assert.match(commit, /where source_row\.session_id = p_session_id[\s\S]*source_row\.utterance_key = clean_key/iu);
  assert.match(commit, /coalesce\(max\(source_row\.source_seq\), 0\) \+ 1/iu);
  assert.match(commit, /'sourceUtteranceId'[\s\S]*'sourceSeq'[\s\S]*'idempotent'/iu);
  assert.match(commit, /SOURCE_UTTERANCE_IDEMPOTENCY_CONFLICT/iu);
  assert.doesNotMatch(commit, /update public\.live_source_utterances/iu);
});

test("raw tables are RLS protected and all transcript operations are service-only RPCs", async () => {
  const sql = await readMigration();
  for (const table of ["live_source_utterances", "live_source_utterance_corrections"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "iu"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table}[\\s\\S]*from public, anon, authenticated, service_role`, "iu"));
  }
  for (const functionName of [
    "persist_authoritative_live_source_utterance_v1",
    "persist_live_final_caption_if_active",
    "append_owned_live_source_correction_v1",
    "read_owned_authoritative_live_transcript_v1",
    "read_authoritative_live_summary_input_v1",
    "authorize_live_participant_speaking_v1",
    "take_live_floor",
    "create_live_session_with_event_v2",
    "update_live_session_with_event_v2",
    "redeem_live_attendee_v3",
    "restore_live_attendee_v2",
    "authorize_live_viewer_grants_v2",
    "read_owned_live_record_v2",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${functionName}\\([\\s\\S]*from public, anon, authenticated`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${functionName}\\([\\s\\S]*to service_role`, "iu"));
  }
});

test("caption linkage is additive, atomic, and checks source identity", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.live_utterances[\s\S]*add column if not exists authoritative_source_id uuid/iu);
  assert.match(sql, /live_utterances_authoritative_source_language_idx/iu);
  const linkedFinal = sql.match(
    /create or replace function public\.persist_live_final_caption_if_active\([\s\S]*?p_authoritative_source_id uuid[\s\S]*?\n\$\$;/iu,
  )?.[0] ?? "";
  assert.match(linkedFinal, /public\.persist_live_final_caption_if_active\([\s\S]*p_translation_status[\s\S]*\)/iu);
  assert.match(linkedFinal, /source_row\.session_id = p_session_id[\s\S]*source_row\.utterance_key = p_utterance_key/iu);
  assert.match(linkedFinal, /AUTHORITATIVE_SOURCE_LINK_CONFLICT/iu);
});

test("corrections append with optimistic revision and never overwrite the immutable source", async () => {
  const sql = await readMigration();
  const correction = extractFunction(sql, "append_owned_live_source_correction_v1");
  assert.match(correction, /session_row\.host_id = p_host_id[\s\S]*session_row\.archive_deleted_at is null/iu);
  assert.match(correction, /for update/iu);
  assert.match(correction, /coalesce\(max\(correction_row\.revision\), 0\)/iu);
  assert.match(correction, /p_expected_revision[\s\S]*LIVE_SOURCE_CORRECTION_CONFLICT/iu);
  assert.match(correction, /insert into public\.live_source_utterance_corrections/iu);
  assert.doesNotMatch(correction, /update public\.live_source_utterances/iu);
});

test("host transcript read is cursor bounded, excludes soft-deleted archives, and includes linked translations", async () => {
  const sql = await readMigration();
  const read = extractFunction(sql, "read_owned_authoritative_live_transcript_v1");
  assert.match(read, /p_after_source_seq bigint default 0[\s\S]*p_limit integer default 200/iu);
  assert.match(read, /session_row\.host_id = p_host_id[\s\S]*session_row\.archive_deleted_at is null/iu);
  assert.match(read, /session_row\.status in \('stopped', 'failed'\)[\s\S]*coalesce\(session_row\.ended_at, session_row\.archived_at\) is not null[\s\S]*LIVE_TRANSCRIPT_NOT_READY/iu);
  assert.match(read, /source_row\.source_seq > p_after_source_seq[\s\S]*order by source_row\.source_seq[\s\S]*limit p_limit/iu);
  assert.match(read, /coalesce\(latest_correction\.corrected_text, source_row\.normalized_text\)/iu);
  assert.match(read, /jsonb_agg[\s\S]*public\.live_utterances/iu);
});

test("summary input is terminal-only and cannot silently use translated lanes", async () => {
  const sql = await readMigration();
  const summary = extractFunction(sql, "read_authoritative_live_summary_input_v1");
  assert.match(summary, /session_row\.status in \('stopped', 'failed'\)/iu);
  assert.match(summary, /coalesce\(session_row\.ended_at, session_row\.archived_at\) is not null/iu);
  assert.match(summary, /coalesce\(latest_correction\.corrected_text, source_row\.normalized_text\)/iu);
  assert.doesNotMatch(summary, /live_utterances|translation_status/iu);
});

test("participant speaking is opt-in and exposed only through additive versioned RPCs", async () => {
  const sql = await readMigration();
  assert.match(sql, /add column if not exists participant_speaking_enabled boolean not null default false/iu);
  const floor = extractFunction(sql, "take_live_floor");
  assert.match(floor, /session_row\.participant_speaking_enabled is not true[\s\S]*PARTICIPANT_SPEAKING_DISABLED/iu);

  for (const functionName of [
    "create_live_session_with_event_v2",
    "update_live_session_with_event_v2",
    "redeem_live_attendee_v3",
    "restore_live_attendee_v2",
    "authorize_live_viewer_grants_v2",
    "read_owned_live_record_v2",
  ]) {
    const fn = extractFunction(sql, functionName);
    assert.match(fn, /participant_speaking_enabled/iu);
  }
  assert.doesNotMatch(sql, /drop function/iu);
});

test("participant redemption records an explicit attendee display name instead of deriving the public name from email", async () => {
  const sql = await readMigration();
  const redeem = extractFunction(sql, "redeem_live_attendee_v3");
  assert.match(redeem, /p_display_name text/iu);
  assert.match(redeem, /clean_display_name := nullif\(normalize\(btrim\(coalesce\(p_display_name, ''\)\), NFC\), ''\)/iu);
  assert.match(redeem, /clean_display_name is null[\s\S]*char_length\(clean_display_name\) > 40/iu);
  assert.match(redeem, /set display_name = clean_display_name/iu);
  assert.match(redeem, /return query select[\s\S]*clean_display_name[\s\S]*attendee_row\.email/iu);
  assert.doesNotMatch(redeem, /mask|regexp_replace\(.*email/iu);
});

test("speaking disable transition clears only the exact owned version and restores on a rejected base update", async () => {
  const sql = await readMigration();
  const update = extractFunction(sql, "update_live_session_with_event_v2");
  assert.match(update, /session_row\.id = p_session_id[\s\S]*session_row\.host_id = p_host_id[\s\S]*session_row\.version = p_expected_version[\s\S]*for update/iu);
  assert.match(update, /if previous_speaking_enabled and not p_participant_speaking_enabled then[\s\S]*set participant_speaking_enabled = false[\s\S]*session_row\.host_id = p_host_id[\s\S]*session_row\.version = p_expected_version/iu);
  assert.match(update, /from public\.update_live_session_with_event_v1\([\s\S]*if not found then[\s\S]*set participant_speaking_enabled = previous_speaking_enabled[\s\S]*session_row\.host_id = p_host_id[\s\S]*session_row\.version = p_expected_version/iu);
  assert.doesNotMatch(update, /set participant_speaking_enabled = false\s*where session_row\.id = p_session_id\s*;/iu);
});

test("authoritative records inherit archive retention and are removed only by the parent purge", async () => {
  const sql = await readMigration();
  assert.match(sql, /session_id uuid not null references public\.live_sessions\(id\) on delete cascade/iu);
  assert.match(sql, /archive_deleted_at is null/iu);
  assert.doesNotMatch(sql, /delete from public\.live_source_utterances|delete from public\.live_source_utterance_corrections/iu);
  assert.match(sql, /30-day parent-session purge/iu);
});

test("a named verified pg_cron job purges only already-eligible archives in bounded batches", async () => {
  const [sql, recordsSql] = await Promise.all([
    readMigration(),
    readFile(recordsMigrationUrl, "utf8"),
  ]);
  assert.match(sql, /create extension if not exists pg_cron/iu);
  assert.match(sql, /to_regprocedure\('public\.purge_live_session_archives_v1\(integer\)'\)/iu);
  assert.match(sql, /has_function_privilege\([\s\S]*'cron\.schedule\(text,text,text\)'[\s\S]*'EXECUTE'/iu);
  assert.match(sql, /cron\.schedule\(\s*'realtime-noel-live-archive-purge',\s*'13 \* \* \* \*',\s*'select public\.purge_live_session_archives_v1\(50\);'/iu);
  assert.match(sql, /job_row\.jobname = 'realtime-noel-live-archive-purge'[\s\S]*job_row\.active is true[\s\S]*LIVE_ARCHIVE_PURGE_CRON_NOT_READY/iu);
  assert.doesNotMatch(sql, /cron\.unschedule|purge_live_session_archives_v1\((101|[1-9][0-9]{3,})\)/iu);
  const purge = extractFunction(recordsSql, "purge_live_session_archives_v1");
  assert.match(purge, /archive_deleted_at is not null[\s\S]*archive_purge_after <= statement_timestamp\(\)[\s\S]*limit p_limit/iu);
});
