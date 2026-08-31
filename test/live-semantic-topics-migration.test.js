import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608150002_live_semantic_topics.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

async function readMigrationBuffer() {
  return readFile(migrationUrl);
}

function flexibleSignature(signature) {
  return signature
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll(", ", ",\\s*")
    .replace("\\(", "\\(\\s*")
    .replace("\\)", "\\s*\\)");
}

function extractFunction(sql, functionName) {
  const match = sql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "iu"));
  assert.ok(match, `${functionName} body exists`);
  return match[0];
}

function assertFullTopicShape(functionSql, label) {
  for (const field of [
    "id",
    "session_id",
    "ordinal",
    "title",
    "summary",
    "status",
    "completion_reason",
    "detector_health",
    "started_at",
    "completed_at",
    "version",
  ]) {
    assert.match(functionSql, new RegExp(`'${field}'`, "iu"), `${label} topic includes ${field}`);
  }
}

function assertPublicMembershipShape(functionSql, label) {
  for (const field of ["session_id", "topic_id", "utterance_key", "position"]) {
    assert.match(functionSql, new RegExp(`'${field}'`, "iu"), `${label} membership includes ${field}`);
  }
  assert.doesNotMatch(functionSql, /'sourceSeq'|'source_seq'/iu, `${label} does not expose source sequence in public membership shape`);
}

test("semantic topics migration follows durable caption provenance and creates additive topic tables", async () => {
  const [sql, migrations] = await Promise.all([readMigration(), readdir(new URL("../supabase/migrations/", import.meta.url))]);
  assert.ok(migrations.indexOf("202607260001_live_caption_identity_provenance.sql") < migrations.indexOf(migrationName));
  assert.match(sql, /create table if not exists public\.live_topics\s*\(/iu);
  assert.match(sql, /create table if not exists public\.live_topic_utterances\s*\(/iu);
  assert.match(sql, /create table if not exists public\.live_topic_processed_utterances\s*\(/iu);
  assert.match(sql, /references public\.live_sessions\(id\) on delete cascade/iu);
  assert.match(sql, /references public\.live_topics\(id\) on delete cascade/iu);
  assert.doesNotMatch(sql, /alter table public\.live_(utterances|meeting_summaries|snapshots)/iu);
  assert.doesNotMatch(sql, /drop table|drop column|delete from public\.live_utterances|delete from public\.live_meeting_summaries/iu);
});

test("semantic topics migration source stays ASCII-safe around escaped bidi literals", async () => {
  const bytes = await readMigrationBuffer();
  const forbidden = [];
  for (const [index, byte] of bytes.entries()) {
    const isAllowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if ((byte <= 0x1f && !isAllowedWhitespace) || (byte >= 0x7f && byte <= 0x9f)) {
      forbidden.push({ index, byte });
    }
  }
  assert.deepEqual(forbidden, []);

  const sql = bytes.toString("utf8");
  const escapedBidiLiteral = "U&'\\200E\\200F\\202A\\202B\\202C\\202D\\202E\\2066\\2067\\2068\\2069'";
  assert.equal(sql.split(escapedBidiLiteral).length - 1, 7);
});

test("semantic topic tables enforce one active partial and bounded plain metadata", async () => {
  const sql = await readMigration();
  assert.match(sql, /create unique index if not exists live_topics_one_active_partial_idx[\s\S]*on public\.live_topics \(session_id\)[\s\S]*where status = 'active'/iu);
  assert.match(sql, /status text not null default 'active'/iu);
  assert.match(sql, /status in \('active', 'completed'\)/iu);
  assert.match(sql, /title text not null default 'Live topic'/iu);
  assert.match(sql, /char_length\(title\) between 1 and 120[\s\S]*title = normalize\(btrim\(title\), NFC\)[\s\S]*title !~ '\[\[:cntrl:\]\]'[\s\S]*title !~ '\[<>\]'/iu);
  assert.match(sql, /summary text[\s\S]*char_length\(summary\) between 1 and 500[\s\S]*summary = normalize\(btrim\(summary\), NFC\)/iu);
  assert.match(sql, /translate\(title, U&'\\200E\\200F\\202A\\202B\\202C\\202D\\202E\\2066\\2067\\2068\\2069'/iu);
  assert.match(sql, /translate\(summary, U&'\\200E\\200F\\202A\\202B\\202C\\202D\\202E\\2066\\2067\\2068\\2069'/iu);
  assert.match(sql, /completion_reason text[\s\S]*completion_reason in \('silence', 'semantic_shift', 'session_end'\)/iu);
  assert.doesNotMatch(sql, /fallback/iu);
  assert.match(sql, /detector_health text not null default 'healthy'[\s\S]*detector_health in \('healthy', 'degraded'\)/iu);
  assert.match(sql, /version integer not null default 1[\s\S]*version > 0/iu);
  assert.match(sql, /utterance_key text not null[\s\S]*char_length\(utterance_key\) between 1 and 256[\s\S]*octet_length\(utterance_key\) <= 768/iu);
  assert.match(sql, /utterance_key = normalize\(btrim\(utterance_key\), NFC\)[\s\S]*utterance_key !~ '\[<>\]'[\s\S]*translate\(utterance_key, U&'\\200E\\200F\\202A\\202B\\202C\\202D\\202E\\2066\\2067\\2068\\2069'/iu);
  assert.match(sql, /primary key \(session_id, utterance_key\)/iu);
  assert.match(sql, /unique \(topic_id, position\)/iu);
});

test("semantic topic RPCs are service-role only and contain no external IO", async () => {
  const sql = await readMigration();
  for (const signature of [
    "read_live_topic_context(uuid, text)",
    "apply_live_topic_transition(uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean)",
    "complete_idle_live_topic(uuid, text, uuid, integer)",
    "complete_live_topics_on_session_end(uuid)",
    "recover_live_topic_assignments(uuid, text, bigint)",
    "cleanup_expired_live_topics()",
  ]) {
    const escaped = flexibleSignature(signature);
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"), signature);
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"), signature);
  }
  assert.doesNotMatch(sql, /https?:|fetch\(|net\.http|extensions\.http|pg_net|http_post|http_get/iu);
});

test("semantic topic RPC bodies have balanced dollar quote wrappers", async () => {
  const sql = await readMigration();
  for (const functionName of [
    "read_live_topic_context",
    "apply_live_topic_transition",
    "complete_idle_live_topic",
    "complete_live_topics_on_session_end",
    "recover_live_topic_assignments",
    "cleanup_expired_live_topics",
  ]) {
    const body = extractFunction(sql, functionName);
    assert.equal(body.match(/\bas \$\$/giu)?.length ?? 0, 1, `${functionName} has one as $$`);
    assert.equal(body.match(/\n\$\$;/gu)?.length ?? 0, 1, `${functionName} has one $$ terminator`);
  }
});

test("apply transition is versioned, idempotent by utteranceKey, and preserves durable source guards", async () => {
  const sql = await readMigration();
  const apply = extractFunction(sql, "apply_live_topic_transition");
  assert.match(apply, /p_decision text[\s\S]*p_expected_topic_id uuid[\s\S]*p_expected_version integer/iu);
  assert.match(apply, /p_meaningful boolean/iu);
  assert.match(apply, /p_decision not in \('continue', 'shift'\)/iu);
  assert.match(apply, /from public\.live_topic_utterances existing_membership[\s\S]*existing_membership\.session_id = p_session_id[\s\S]*existing_membership\.utterance_key = clean_utterance_key/iu);
  assert.match(apply, /return jsonb_build_object\('ok', true, 'status', 'idempotent'/iu);
  assert.match(apply, /'event', 'topic-upsert'[\s\S]*'memberships_added'/iu);
  assert.match(apply, /from public\.live_utterances source_utterance[\s\S]*source_utterance\.origin = 'source'[\s\S]*source_utterance\.utterance_key = clean_utterance_key[\s\S]*source_utterance\.seq = p_source_seq/iu);
  assert.match(apply, /topic_row\.version <> p_expected_version[\s\S]*TOPIC_VERSION_CONFLICT/iu);
  assert.match(apply, /p_decision = 'shift'[\s\S]*update public\.live_topics[\s\S]*status = 'completed'/iu);
  assert.match(apply, /insert into public\.live_topic_utterances[\s\S]*clean_utterance_key/iu);
  assert.equal(apply.match(/SOURCE_FINAL_NOT_DURABLE/giu)?.length ?? 0, 1);
  assert.match(apply, /'topics', jsonb_build_array\(/iu);
  assertFullTopicShape(apply, "apply/idempotent");
  assertPublicMembershipShape(apply, "apply");
});

test("apply transition returns ordered topic arrays and handles non-meaningful finals without extending timers", async () => {
  const sql = await readMigration();
  const apply = extractFunction(sql, "apply_live_topic_transition");
  assert.match(apply, /return jsonb_build_object\('ok', true, 'status', 'idempotent'[\s\S]*'topics', jsonb_build_array\(target_topic_payload\)/iu);
  assert.match(apply, /from public\.live_topic_processed_utterances processed_membership[\s\S]*processed_membership\.session_id = p_session_id[\s\S]*processed_membership\.utterance_key = clean_utterance_key[\s\S]*return jsonb_build_object\('ok', true, 'status', 'idempotent'[\s\S]*'topics', '\[\]'::jsonb[\s\S]*'memberships_added', '\[\]'::jsonb/iu);
  assert.match(apply, /p_decision = 'shift'[\s\S]*completed_topic_payload[\s\S]*target_topic_payload[\s\S]*else jsonb_build_array\(completed_topic_payload, target_topic_payload\)/iu);
  assert.match(apply, /p_meaningful is false[\s\S]*not found[\s\S]*insert into public\.live_topic_processed_utterances[\s\S]*return jsonb_build_object\('ok', true, 'status', 'ignored'[\s\S]*'topics', '\[\]'::jsonb/iu);
  assert.match(apply, /p_meaningful is false[\s\S]*found[\s\S]*insert into public\.live_topic_utterances[\s\S]*insert into public\.live_topic_processed_utterances/iu);
  const nonMeaningfulBranch = apply.match(/if p_meaningful is false then([\s\S]*?)\n  end if;/iu);
  assert.ok(nonMeaningfulBranch, "non-meaningful branch exists");
  assert.doesNotMatch(nonMeaningfulBranch[1], /update public\.live_topics[\s\S]*last_activity_at/iu);
});

test("continue preserves existing topic title when detector sends null title", async () => {
  const sql = await readMigration();
  const apply = extractFunction(sql, "apply_live_topic_transition");
  assert.match(apply, /raw_title text := nullif\(normalize\(btrim\(coalesce\(p_title, ''\)\), NFC\), ''\)/iu);
  assert.match(apply, /clean_title text := coalesce\(raw_title, 'Live topic'\)/iu);
  assert.match(apply, /p_decision = 'shift'[\s\S]*clean_title/iu);
  assert.match(apply, /set title = coalesce\(raw_title, title\)/iu);
  assert.doesNotMatch(apply, /set title = clean_title/iu);
});

test("read context returns universal membership mapping and exact public shape", async () => {
  const sql = await readMigration();
  const readContext = extractFunction(sql, "read_live_topic_context");
  assert.match(readContext, /bounded_topics as \([\s\S]*order by topic_row\.ordinal desc[\s\S]*limit 1000[\s\S]*topic_payload/iu);
  assert.match(readContext, /bounded_memberships as \([\s\S]*join bounded_topics[\s\S]*order by membership_row\.source_seq desc[\s\S]*limit 12000[\s\S]*topic_membership_payload/iu);
  assert.match(readContext, /'topics', topic_payload[\s\S]*'topic_memberships', topic_membership_payload/iu);
  assert.doesNotMatch(readContext, /'memberships',/iu);
  assert.doesNotMatch(readContext, /membership_row\.source_language = clean_language/iu);
  assertFullTopicShape(readContext, "read context");
  assertPublicMembershipShape(readContext, "read context");
});

test("idle and session-end RPCs close stale topics deterministically", async () => {
  const sql = await readMigration();
  const idle = extractFunction(sql, "complete_idle_live_topic");
  const end = extractFunction(sql, "complete_live_topics_on_session_end");
  assert.match(idle, /topic_row\.last_activity_at > statement_timestamp\(\) - interval '12 seconds'[\s\S]*TOPIC_NOT_IDLE/iu);
  assert.match(idle, /latest_source_final_at > topic_row\.last_activity_at[\s\S]*LATEST_SOURCE_FINAL_UNASSIGNED/iu);
  assert.match(idle, /completion_reason = 'silence'/iu);
  assert.match(idle, /'topics', jsonb_build_array\(completed_topic_payload\)/iu);
  assertFullTopicShape(idle, "idle");
  assert.match(end, /session_row\.status not in \('live', 'paused', 'stopped'\)[\s\S]*return 0/iu);
  assert.doesNotMatch(end, /session_row\.status = 'stopped' is not true/iu);
  assert.match(end, /update public\.live_topics[\s\S]*status = 'completed'[\s\S]*where session_id = p_session_id[\s\S]*and status = 'active'/iu);
  assert.match(end, /completion_reason = 'session_end'/iu);
});

test("recovery RPC is read-only keyset lookup and does not create phantom topics", async () => {
  const sql = await readMigration();
  const recover = extractFunction(sql, "recover_live_topic_assignments");
  assert.match(recover, /p_after_source_seq bigint default 0/iu);
  assert.match(recover, /left join public\.live_topic_utterances membership_row[\s\S]*membership_row\.utterance_key is null/iu);
  assert.match(recover, /left join public\.live_topic_processed_utterances processed_row[\s\S]*processed_row\.utterance_key is null/iu);
  assert.match(recover, /source_utterance\.origin = 'source'[\s\S]*source_utterance\.utterance_key is not null/iu);
  assert.match(recover, /source_utterance\.seq > coalesce\(p_after_source_seq, 0\)[\s\S]*order by source_utterance\.seq[\s\S]*limit 100[\s\S]*jsonb_agg/iu);
  assert.match(recover, /coalesce\(max\(bounded_source\.seq\), coalesce\(p_after_source_seq, 0\)\)/iu);
  assert.match(recover, /'next_source_seq', next_source_seq/iu);
  assert.match(recover, /'unassigned_finals'/iu);
  assert.match(recover, /'utterance_key'[\s\S]*'source_seq'[\s\S]*'source_language'[\s\S]*'text'[\s\S]*'emitted_at'/iu);
  assert.match(recover, /char_length\(source_utterance\.text\) <= 2000/iu);
  assert.doesNotMatch(recover, /for update|insert into|update public\.|delete from/iu);
  assert.doesNotMatch(recover, /jsonb_build_object\([\s\S]*'topics'|jsonb_build_object\([\s\S]*'topic_memberships'|jsonb_build_object\([\s\S]*'topic', jsonb_build_object/iu);
});

test("semantic topic cleanup is thirty-day bounded and bootstrap mirrors the migration", async () => {
  const [sql, bootstrap] = await Promise.all([readMigration(), readFile(bootstrapUrl, "utf8")]);
  assert.match(sql, /create or replace function public\.cleanup_expired_live_topics\(\)/iu);
  assert.match(sql, /delete from public\.live_topics[\s\S]*interval '30 days'/iu);
  const cleanup = extractFunction(sql, "cleanup_expired_live_topics");
  assert.doesNotMatch(cleanup, /topic_row\.status = 'completed'/iu);
  assert.match(sql, /delete from public\.live_topic_processed_utterances[\s\S]*expired_sessions[\s\S]*interval '30 days'/iu);
  assert.match(sql, /cron\.schedule\([\s\S]*realtime-noel-live-topic-cleanup[\s\S]*select public\.cleanup_expired_live_topics\(\);/iu);
  assert.match(
    sql,
    /if exists \([\s\S]*from cron\.job job_row[\s\S]*where job_row\.jobname = 'realtime-noel-live-topic-cleanup'[\s\S]*\) then[\s\S]*perform cron\.unschedule\('realtime-noel-live-topic-cleanup'\);[\s\S]*end if;/iu,
  );
  assert.doesNotMatch(
    sql,
    /from pg_namespace\s+where nspname = 'cron'\s+\) then\s+perform cron\.unschedule/iu,
  );
  assert.match(bootstrap, new RegExp(`-- supabase/migrations/${migrationName}[\\s\\S]*create table if not exists public\\.live_topics`, "iu"));
  assert.match(bootstrap, /create or replace function public\.apply_live_topic_transition\(/iu);
  const migrationBlock = bootstrap.match(
    new RegExp(`-- supabase/migrations/${migrationName}\\n([\\s\\S]*?)(?=\\n-- supabase/migrations/|$)`, "u"),
  );
  assert.ok(migrationBlock, "bootstrap includes the semantic topics migration block");
  assert.equal(migrationBlock[1].trim(), sql.trim(), "bootstrap semantic topics block matches migration exactly");
});
