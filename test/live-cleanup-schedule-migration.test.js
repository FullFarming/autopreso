import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260720061119_live_cleanup_schedule.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("cleanup schedule migration sorts after the cleanup function migration", async () => {
  const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const functionIndex = migrations.indexOf("20260720060633_live_personal_data_cleanup.sql");
  const scheduleIndex = migrations.indexOf(migrationName);
  assert.notEqual(functionIndex, -1);
  assert.notEqual(scheduleIndex, -1);
  assert.equal(functionIndex < scheduleIndex, true);
});

test("cleanup schedule enables pg_cron and fails closed when dependencies are unavailable", async () => {
  const sql = await readMigration();
  assert.match(sql, /create extension if not exists pg_cron;/u);
  assert.match(sql, /to_regnamespace\('cron'\) is null/u);
  assert.match(sql, /to_regclass\('cron\.job'\) is null/u);
  assert.match(sql, /to_regprocedure\('cron\.schedule\(text,text,text\)'\) is null/u);
  assert.match(sql, /to_regprocedure\('public\.cleanup_expired_live_state\(\)'\) is null/u);
  assert.match(sql, /has_function_privilege\([\s\S]*current_user[\s\S]*cron\.schedule\(text,text,text\)[\s\S]*EXECUTE/u);
  assert.match(sql, /LIVE_CLEANUP_CRON_UNAVAILABLE/u);
  assert.match(sql, /LIVE_CLEANUP_FUNCTION_UNAVAILABLE/u);
  assert.match(sql, /LIVE_CLEANUP_CRON_FORBIDDEN/u);
});

test("the named cleanup job is atomically upserted every five minutes", async () => {
  const sql = await readMigration();
  assert.match(
    sql,
    /cron\.schedule\([\s\S]*'realtime-noel-live-cleanup',[\s\S]*'\*\/5 \* \* \* \*',[\s\S]*'select public\.cleanup_expired_live_state\(\);'/u,
  );
  assert.match(sql, /job_row\.jobid = cleanup_job_id/u);
  assert.match(sql, /job_row\.jobname = 'realtime-noel-live-cleanup'/u);
  assert.match(sql, /btrim\(job_row\.schedule\) = '\*\/5 \* \* \* \*'/u);
  assert.match(sql, /btrim\(job_row\.command\) = 'select public\.cleanup_expired_live_state\(\);'/u);
  assert.match(sql, /job_row\.active is true/u);
  assert.match(sql, /LIVE_CLEANUP_CRON_NOT_READY/u);
});

test("migration is rerunnable and does not mutate differently named cron jobs", async () => {
  const sql = await readMigration();
  assert.match(sql, /create extension if not exists pg_cron/u);
  assert.equal((sql.match(/cleanup_job_id := cron\.schedule\(/gu) ?? []).length, 1);
  assert.doesNotMatch(sql, /cron\.unschedule|delete from cron\.job|update cron\.job/iu);
  assert.doesNotMatch(sql, /drop extension|drop schema|truncate/iu);
});
