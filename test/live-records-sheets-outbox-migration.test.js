import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608150005_live_records_sheets_outbox.sql";
const nextMigrationName = "202608150006_live_gateway_readiness_start.sql";
const repairMigrationName = "202608150007_live_plpgsql_ambiguity_repair.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const nextMigrationUrl = new URL(`../supabase/migrations/${nextMigrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

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

test("records migration sorts after every approved dependency and is mirrored exactly", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202608150004_live_glossary_document_session_sections.sql") < migrations.indexOf(migrationName));

  const [sql, nextSql, bootstrap] = await Promise.all([
    readMigration(),
    readFile(nextMigrationUrl, "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  const marker = `-- supabase/migrations/${migrationName}`;
  const nextMarker = `-- supabase/migrations/${nextMigrationName}`;
  assert.equal(bootstrap.split(marker).length - 1, 1);
  assert.equal(bootstrap.split(nextMarker).length - 1, 1);
  assert.ok(
    bootstrap.includes(`${marker}\n\n${sql}\n${nextMarker}`),
    "bootstrap keeps the exact records block immediately before readiness",
  );
  assert.ok(
    bootstrap.includes(`${nextMarker}\n\n${nextSql}\n-- supabase/migrations/${repairMigrationName}`),
    "bootstrap keeps the exact readiness block immediately before its forward repair",
  );
});

test("archive lifecycle is additive, recoverable, and content retention is independent from grants", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.live_sessions[\s\S]*add column if not exists archived_at timestamptz[\s\S]*add column if not exists archive_deleted_at timestamptz[\s\S]*add column if not exists archive_purge_after timestamptz/iu);
  assert.match(sql, /archive_purge_after = statement_timestamp\(\) \+ interval '30 days'/iu);
  assert.match(sql, /create or replace function public\.restore_live_session_archive_v1\(/iu);
  assert.match(sql, /drop policy if exists live_sessions_host_select on public\.live_sessions[\s\S]*create policy live_sessions_host_select[\s\S]*host_id = \(select auth\.uid\(\)\)::text[\s\S]*archive_deleted_at is null/iu);
  assert.match(sql, /create or replace function public\.purge_live_session_archives_v1\(/iu);
  assert.match(extractFunction(sql, "purge_live_session_archives_v1"), /archive_purge_after <= statement_timestamp\(\)[\s\S]*delete from public\.live_sessions/iu);

  const cleanup = extractFunction(sql, "cleanup_expired_live_state");
  assert.match(cleanup, /delete from public\.viewer_grants/iu);
  assert.match(cleanup, /delete from public\.live_recap_grants/iu);
  assert.match(cleanup, /delete from public\.live_session_invites/iu);
  assert.doesNotMatch(cleanup, /delete from public\.live_utterances|delete from public\.live_meeting_summaries/iu);
  assert.doesNotMatch(extractFunction(sql, "cleanup_expired_live_participants"), /delete from public\.live_participants/iu);
  assert.doesNotMatch(extractFunction(sql, "cleanup_expired_live_topics"), /delete from public\.live_topics|delete from public\.live_topic_processed_utterances/iu);
  assert.doesNotMatch(sql, /drop\s+(table|column)|truncate/iu);
});

test("current host create and update paths accept up to 200 viewers", async () => {
  const [sql, eventMigration] = await Promise.all([
    readMigration(),
    readFile(new URL("../supabase/migrations/202608150004_live_glossary_document_session_sections.sql", import.meta.url), "utf8"),
  ]);
  assert.match(sql, /alter table public\.live_sessions[\s\S]*drop constraint if exists live_sessions_max_viewers_check[\s\S]*add constraint live_sessions_max_viewers_check[\s\S]*max_viewers between 1 and 200/iu);
  for (const functionName of ["create_live_session", "update_live_session"]) {
    const body = extractFunction(sql, functionName);
    assert.match(body, /p_max_viewers not between 1 and 200/iu);
    assert.doesNotMatch(body, /p_max_viewers not between 1 and 50/iu);
    assert.match(body, /security definer[\s\S]*set search_path = ''/iu);
  }
  assert.match(eventMigration, /create_live_session_with_event_v1[\s\S]*from public\.create_live_session\([\s\S]*p_max_viewers/iu);
  assert.match(eventMigration, /update_live_session_with_event_v1[\s\S]*from public\.update_live_session\([\s\S]*p_max_viewers/iu);
});

test("purpose-scoped consent is an immutable participant-bound audit", async () => {
  const sql = await readMigration();
  assert.match(sql, /create table public\.live_participant_consents \([\s\S]*purpose text not null[\s\S]*check \(purpose in \('privacy', 'summary_delivery', 'marketing'\)\)[\s\S]*notice_version text not null[\s\S]*revision integer not null/iu);
  assert.match(sql, /unique \(participant_id, purpose, revision\)/iu);
  assert.match(sql, /participant_row\.id = new\.participant_id[\s\S]*participant_row\.session_id = new\.session_id/iu);
  assert.match(sql, /create trigger live_participant_consents_binding_before_insert[\s\S]*before insert on public\.live_participant_consents/iu);
  assert.match(sql, /create trigger live_participant_consents_immutable_before_change[\s\S]*before update or delete/iu);
  assert.match(sql, /insert into public\.live_participant_consents[\s\S]*'summary_delivery'[\s\S]*participant_row\.summary_consent_at/iu);
  assert.doesNotMatch(sql, /summary_consent_at[\s\S]{0,200}'privacy'|summary_consent_at[\s\S]{0,200}'marketing'/iu);

  const consent = extractFunction(sql, "record_live_participant_consent_v1");
  assert.match(consent, /participant_row\.session_id = p_session_id[\s\S]*participant_row\.user_id = p_user_id[\s\S]*for update/iu);
  assert.match(consent, /p_purpose = 'privacy' and p_is_accepted is false[\s\S]*PRIVACY_CONSENT_REQUIRED/iu);
  assert.match(consent, /coalesce\(max\(consent_row\.revision\), 0\) \+ 1/iu);
});

test("attendee v2 admission commits privacy and independent optional choices in one RPC", async () => {
  const sql = await readMigration();
  const join = extractFunction(sql, "redeem_live_attendee_v2");
  assert.match(join, /p_privacy_consent boolean[\s\S]*p_privacy_notice_version text[\s\S]*p_summary_consent boolean[\s\S]*p_summary_notice_version text[\s\S]*p_marketing_consent boolean[\s\S]*p_marketing_notice_version text/iu);
  assert.match(join, /p_privacy_consent is not true[\s\S]*PRIVACY_CONSENT_REQUIRED/iu);
  assert.match(join, /public\.redeem_live_attendee_v1\(/iu);
  assert.equal((join.match(/public\.record_live_participant_consent_v1\(/giu) ?? []).length, 3);
  assert.match(join, /'privacy'[\s\S]*'summary_delivery'[\s\S]*'marketing'/iu);
});

test("optional consent choices commit atomically and enqueue one projection", async () => {
  const sql = await readMigration();
  const choices = extractFunction(sql, "record_live_participant_consent_choices_v1");
  assert.match(choices, /p_session_id uuid,\s*p_participant_id uuid,\s*p_user_id text,\s*p_summary_is_accepted boolean,\s*p_summary_notice_version text,\s*p_marketing_is_accepted boolean,\s*p_marketing_notice_version text/iu);
  assert.match(choices, /returns table \([\s\S]*consent_id uuid[\s\S]*purpose text[\s\S]*projection_version bigint/iu);
  assert.match(choices, /participant_row\.id = p_participant_id[\s\S]*participant_row\.session_id = p_session_id[\s\S]*participant_row\.user_id = p_user_id[\s\S]*for update/iu);
  assert.match(choices, /summary_notice_version[\s\S]*marketing_notice_version[\s\S]*\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,63\}\$/iu);
  assert.match(choices, /summary_consent\.notice_version = normalized_summary_notice_version[\s\S]*summary_consent\.is_accepted = p_summary_is_accepted[\s\S]*marketing_consent\.notice_version = normalized_marketing_notice_version[\s\S]*marketing_consent\.is_accepted = p_marketing_is_accepted[\s\S]*return query[\s\S]*return;/iu);
  assert.equal((choices.match(/insert into public\.live_participant_consents/giu) ?? []).length, 1);
  assert.doesNotMatch(choices, /enqueue_live_sheet_projection/iu);
  assert.match(choices, /values\s*\([\s\S]*'summary_delivery'[\s\S]*\), \([\s\S]*'marketing'/iu);
  assert.match(choices, /order by case inserted_consent\.purpose[\s\S]*'summary_delivery'[\s\S]*'marketing'/iu);

  const trigger = extractFunction(sql, "enqueue_live_consent_projection_trigger");
  assert.match(trigger, /select distinct consent_row\.session_id[\s\S]*from new_consent_rows consent_row/iu);
  assert.match(sql, /create trigger live_consents_sheet_projection_after_insert[\s\S]*referencing new table as new_consent_rows[\s\S]*for each statement/iu);
});

test("Sheets metadata uses bounded database sequences and PII-free jobs", async () => {
  const sql = await readMigration();
  assert.match(sql, /create sequence public\.live_sheet_id_seq[\s\S]*minvalue 1[\s\S]*maxvalue 2147483647[\s\S]*no cycle/iu);
  assert.match(sql, /create sequence public\.live_sheet_index_row_seq[\s\S]*minvalue 1[\s\S]*maxvalue 2147483647[\s\S]*no cycle/iu);
  assert.match(sql, /create table public\.live_sheet_exports \([\s\S]*sheet_id integer not null default nextval\('public\.live_sheet_id_seq'/iu);
  assert.match(sql, /session_index_row integer not null default nextval\('public\.live_sheet_index_row_seq'/iu);
  assert.match(sql, /last_exported_participant_count integer not null default 0[\s\S]*between 0 and 10000/iu);
  assert.match(sql, /unique \(sheet_id\)[\s\S]*unique \(session_index_row\)[\s\S]*unique \(tab_title\)/iu);

  const jobTable = sql.match(/create table public\.live_sheet_sync_jobs \([\s\S]*?\n\);/iu)?.[0];
  assert.ok(jobTable);
  assert.doesNotMatch(jobTable, /email|company|department|job_title|transcript|summary_body|payload|credential/iu);
  assert.doesNotMatch(jobTable, /provider_token|invite_token|access_token/iu);
  assert.match(jobTable, /unique \(session_id, projection_version\)/iu);
  assert.match(sql, /create unique index live_sheet_sync_jobs_one_pending_idx[\s\S]*where state = 'pending'/iu);
});

test("canonical session, participant, consent, and end mutations coalesce an idempotent outbox row", async () => {
  const sql = await readMigration();
  const enqueue = extractFunction(sql, "enqueue_live_sheet_projection");
  assert.match(enqueue, /for update/iu);
  assert.match(enqueue, /next_projection_version := export_row\.projection_version \+ 1/iu);
  assert.match(enqueue, /on conflict \(session_id\) where \(state = 'pending'\)[\s\S]*do update/iu);
  assert.match(sql, /create trigger live_sessions_sheet_projection_after_insert[\s\S]*after insert on public\.live_sessions/iu);
  assert.match(sql, /create trigger live_sessions_sheet_projection_after_end[\s\S]*after update of [^\n]*status[^\n]*ended_at on public\.live_sessions/iu);
  assert.match(sql, /create trigger live_participants_sheet_projection_after_change[\s\S]*after insert or update/iu);
  assert.match(sql, /create trigger live_consents_sheet_projection_after_insert[\s\S]*after insert on public\.live_participant_consents/iu);
  assert.doesNotMatch(sql, /http|googleapis|net\.|fetch|webhook/iu);
});

test("terminal summary outcomes enqueue one fresh session projection", async () => {
  const sql = await readMigration();
  const ready = extractFunction(sql, "enqueue_live_summary_projection_trigger");
  assert.match(ready, /select distinct summary_row\.session_id[\s\S]*from new_summary_rows summary_row/iu);
  assert.equal((ready.match(/enqueue_live_sheet_projection/giu) ?? []).length, 1);
  assert.match(ready, /'session_changed'/iu);
  assert.match(sql, /create trigger live_meeting_summaries_sheet_projection_after_insert[\s\S]*after insert on public\.live_meeting_summaries[\s\S]*referencing new table as new_summary_rows[\s\S]*for each statement/iu);
  assert.match(sql, /create trigger live_meeting_summaries_sheet_projection_after_update[\s\S]*after update on public\.live_meeting_summaries[\s\S]*referencing new table as new_summary_rows[\s\S]*for each statement/iu);

  const failed = extractFunction(sql, "enqueue_failed_live_summary_projection_trigger");
  assert.equal((failed.match(/enqueue_live_sheet_projection/giu) ?? []).length, 1);
  assert.match(failed, /new\.session_id[\s\S]*'session_changed'/iu);
  assert.match(sql, /create trigger live_summary_generation_jobs_sheet_projection_after_failure[\s\S]*after update of status on public\.live_summary_generation_jobs[\s\S]*for each row[\s\S]*old\.status is distinct from new\.status[\s\S]*new\.status = 'failed'/iu);
  assert.doesNotMatch(sql, /new\.status = 'succeeded'[\s\S]*enqueue_failed_live_summary_projection_trigger/iu);
});

test("claim and projection expose stable sheet coordinates without putting PII in jobs", async () => {
  const sql = await readMigration();
  for (const functionName of ["claim_live_sheet_sync_job_v1", "read_live_sheet_projection_v1"]) {
    const body = extractFunction(sql, functionName);
    assert.match(body, /session_index_row integer[\s\S]*sheet_id integer[\s\S]*tab_title text[\s\S]*should_create boolean[\s\S]*projection_version bigint[\s\S]*previous_participant_count integer/iu);
  }
  const claim = extractFunction(sql, "claim_live_sheet_sync_job_v1");
  assert.match(claim, /for update skip locked/iu);
  assert.match(claim, /state = 'running'/iu);
  const projection = extractFunction(sql, "read_live_sheet_projection_v1");
  assert.match(projection, /jsonb_agg[\s\S]*participant_row\.email[\s\S]*live_participant_consents/iu);
  assert.match(projection, /summary_state text/iu);
  assert.match(projection, /count\(distinct summary_row\.language\)[\s\S]*cardinality\(session_row\.languages\)[\s\S]*then 'ready'[\s\S]*summary_job\.status = 'running'[\s\S]*then 'running'[\s\S]*summary_job\.status = 'failed'[\s\S]*then 'failed'[\s\S]*then 'pending'[\s\S]*else 'not_started'/iu);
});

test("one durable workbook lease prevents concurrent serverless claims", async () => {
  const sql = await readMigration();
  assert.match(sql, /create table public\.live_sheet_workbook_leases \([\s\S]*scope text primary key[\s\S]*running_job_id uuid[\s\S]*lease_token uuid[\s\S]*lease_expires_at timestamptz/iu);
  assert.match(sql, /insert into public\.live_sheet_workbook_leases \(scope\)[\s\S]*'configured_workbook'/iu);
  assert.match(sql, /claim_scope text not null default 'configured_workbook'[\s\S]*check \(claim_scope = 'configured_workbook'\)/iu);
  assert.match(sql, /create unique index live_sheet_sync_jobs_one_running_idx[\s\S]*on public\.live_sheet_sync_jobs \(claim_scope\)[\s\S]*where state = 'running'/iu);

  const claim = extractFunction(sql, "claim_live_sheet_sync_job_v1");
  assert.match(claim, /from public\.live_sheet_workbook_leases lease_row[\s\S]*where lease_row\.scope = 'configured_workbook'[\s\S]*for update/iu);
  assert.match(claim, /lease_row\.lease_expires_at <= statement_timestamp\(\)[\s\S]*state = 'failed'[\s\S]*safe_error_code = 'SHEETS_CLAIM_LEASE_EXPIRED'/iu);
  assert.match(claim, /if lease_row\.running_job_id is not null then[\s\S]*return/iu);
  assert.match(claim, /for update skip locked[\s\S]*limit 1/iu);
  assert.match(claim, /lease_expires_at = statement_timestamp\(\) \+ interval '5 minutes'/iu);
  assert.doesNotMatch(claim, /state = 'pending'[\s\S]*SHEETS_CLAIM_LEASE_EXPIRED/iu);
});

test("completion and failure CAS the durable workbook lease and release it exactly once", async () => {
  const sql = await readMigration();
  for (const name of ["complete_live_sheet_sync_job_v1", "fail_live_sheet_sync_job_v1"]) {
    const body = extractFunction(sql, name);
    assert.match(body, /from public\.live_sheet_workbook_leases lease_row[\s\S]*running_job_id = p_job_id[\s\S]*lease_token = p_claim_token[\s\S]*for update/iu);
    assert.match(body, /update public\.live_sheet_workbook_leases[\s\S]*running_job_id = null[\s\S]*lease_token = null[\s\S]*lease_expires_at = null/iu);
  }
});

test("completion CAS records exported count/version while failure never changes them", async () => {
  const sql = await readMigration();
  const complete = extractFunction(sql, "complete_live_sheet_sync_job_v1");
  assert.match(complete, /p_projection_version bigint[\s\S]*p_participant_count integer/iu);
  assert.match(complete, /last_exported_projection_version = p_projection_version[\s\S]*last_exported_participant_count = p_participant_count/iu);
  assert.match(complete, /job_row\.projection_version = p_projection_version[\s\S]*job_row\.claim_token = p_claim_token/iu);
  const fail = extractFunction(sql, "fail_live_sheet_sync_job_v1");
  assert.doesNotMatch(fail, /last_exported_projection_version|last_exported_participant_count/iu);
  assert.match(fail, /p_safe_error_code !~ '\^\[A-Z0-9_\]\{3,64\}\$'/iu);
});

test("retry is owner-bound, job-id-free, and deterministically selects the latest failure", async () => {
  const retry = extractFunction(await readMigration(), "retry_live_sheet_sync_job_v1");
  assert.match(retry, /p_session_id uuid,\s*p_host_id text\s*\)/iu);
  assert.doesNotMatch(retry, /p_job_id|job_id uuid/iu);
  assert.match(retry, /session_row\.id = p_session_id and session_row\.host_id = p_host_id/iu);
  assert.match(retry, /pending_job\.state = 'pending'[\s\S]*LIVE_SHEET_RETRY_CONFLICT/iu);
  assert.match(retry, /job_row\.session_id = p_session_id[\s\S]*job_row\.state = 'failed'[\s\S]*order by job_row\.created_at desc, job_row\.id desc[\s\S]*for update/iu);
  assert.match(retry, /LIVE_SHEET_RETRY_NOT_AVAILABLE/iu);
});

test("ADMIN records list is owner-scoped, bounded, searchable, and excludes recoverable deletions", async () => {
  const list = extractFunction(await readMigration(), "list_owned_live_records_v1");
  assert.match(list, /p_host_id text,\s*p_page integer,\s*p_page_size integer,\s*p_search text/iu);
  assert.match(list, /p_page < 1[\s\S]*p_page_size not between 1 and 100[\s\S]*char_length\(normalized_search\) > 100/iu);
  assert.match(list, /session_row\.host_id = p_host_id[\s\S]*session_row\.archived_at is not null[\s\S]*session_row\.archive_deleted_at is null/iu);
  assert.match(list, /position\(lower\(normalized_search\) in lower\(session_row\.title\)\) > 0[\s\S]*to_char\(/iu);
  assert.match(list, /limit p_page_size[\s\S]*offset \(p_page - 1\)::bigint \* p_page_size/iu);
  assert.match(list, /summary_state text[\s\S]*sheet_sync_state text[\s\S]*total_count bigint/iu);
  assert.doesNotMatch(list, /participant_row\.user_id|summary_row\.model|generation_token/iu);
});

test("ADMIN record detail is owner-first and exposes only bounded base/archive/sync counts", async () => {
  const detail = extractFunction(await readMigration(), "read_owned_live_record_v1");
  assert.match(detail, /session_row\.id = p_session_id[\s\S]*session_row\.host_id = p_host_id[\s\S]*session_row\.archive_deleted_at is null/iu);
  assert.match(detail, /if not found then[\s\S]*HOST_ACCESS_REQUIRED/iu);
  assert.match(detail, /utterance_count bigint[\s\S]*topic_count bigint[\s\S]*summary_state text[\s\S]*sheet_sync_state text/iu);
  assert.doesNotMatch(detail, /participant_row\.user_id|summary_row\.model|generation_token|summary jsonb/iu);
});

test("ADMIN participant projection returns current purpose states without internal user IDs", async () => {
  const participants = extractFunction(await readMigration(), "read_owned_live_record_participants_v1");
  assert.match(participants, /session_row\.id = p_session_id[\s\S]*session_row\.host_id = p_host_id[\s\S]*session_row\.archive_deleted_at is null[\s\S]*for update/iu);
  for (const field of ["privacy_is_accepted", "summary_delivery_is_accepted", "marketing_is_accepted"]) {
    assert.match(participants, new RegExp(`${field} boolean`, "iu"));
  }
  assert.match(participants, /distinct on \(consent_row\.participant_id, consent_row\.purpose\)[\s\S]*order by consent_row\.participant_id, consent_row\.purpose, consent_row\.revision desc/iu);
  assert.doesNotMatch(participants, /participant_user_id|participant_row\.user_id|summary_row\.model/iu);
});

test("record deletion, restore, and purge eligibility are exact owner-bound recoverable RPCs", async () => {
  const sql = await readMigration();
  const softDelete = extractFunction(sql, "soft_delete_owned_live_record_v1");
  const restore = extractFunction(sql, "restore_owned_live_record_v1");
  const eligibility = extractFunction(sql, "read_owned_live_record_purge_eligibility_v1");
  for (const body of [softDelete, restore, eligibility]) {
    assert.match(body, /session_row\.id = p_session_id[\s\S]*session_row\.host_id = p_host_id[\s\S]*for update/iu);
    assert.doesNotMatch(body, /participant_row\.user_id|summary_row\.model|generation_token/iu);
  }
  assert.match(softDelete, /archive_purge_after = statement_timestamp\(\) \+ interval '30 days'/iu);
  assert.match(restore, /archive_deleted_at = null[\s\S]*archive_purge_after = null/iu);
  assert.match(eligibility, /is_purge_eligible boolean[\s\S]*recovery_seconds_remaining bigint/iu);
});

test("new tables are RLS-closed and every callable mutation is service-role only", async () => {
  const sql = await readMigration();
  for (const table of ["live_participant_consents", "live_sheet_sync_jobs", "live_sheet_exports", "live_sheet_workbook_leases"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "iu"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table}[\\s\\S]*?from public, anon, authenticated, service_role`, "iu"));
  }
  for (const helper of [
    "mark_live_session_archived()",
    "assert_live_participant_consent_binding()",
    "prevent_live_participant_consent_mutation()",
    "enqueue_live_session_projection_trigger()",
    "enqueue_live_participant_projection_trigger()",
    "enqueue_live_consent_projection_trigger()",
    "enqueue_live_summary_projection_trigger()",
    "enqueue_failed_live_summary_projection_trigger()",
  ]) {
    const escaped = helper.replace(/[()]/gu, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated, service_role`, "iu"));
  }
  for (const signature of [
    "create_live_session(uuid, text, text, text, text[], integer, text, text, text, timestamptz, timestamptz)",
    "update_live_session(uuid, text, integer, text, text, text[], integer, text, text, text, timestamptz)",
    "record_live_participant_consent_v1(uuid, uuid, text, text, text, boolean)",
    "record_live_participant_consent_choices_v1(uuid, uuid, text, boolean, text, boolean, text)",
    "redeem_live_attendee_v2(text, text, text, text, timestamptz, text, text, text, text, boolean, text, boolean, text, boolean, text)",
    "claim_live_sheet_sync_job_v1(uuid)",
    "read_live_sheet_projection_v1(uuid, uuid)",
    "complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)",
    "fail_live_sheet_sync_job_v1(uuid, uuid, text)",
    "retry_live_sheet_sync_job_v1(uuid, text)",
    "request_live_session_archive_deletion_v1(uuid, text)",
    "restore_live_session_archive_v1(uuid, text)",
    "purge_live_session_archives_v1(integer)",
    "list_owned_live_records_v1(text, integer, integer, text)",
    "read_owned_live_record_v1(text, uuid)",
    "read_owned_live_record_participants_v1(text, uuid)",
    "soft_delete_owned_live_record_v1(text, uuid)",
    "restore_owned_live_record_v1(text, uuid)",
    "read_owned_live_record_purge_eligibility_v1(text, uuid)",
  ]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(", ", ",\\s*").replaceAll("\\(", "\\(\\s*").replaceAll("\\)", "\\s*\\)");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"), signature);
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"), signature);
  }
});
