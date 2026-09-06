import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationName = "202608150007_live_plpgsql_ambiguity_repair.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const topicsUrl = new URL("../supabase/migrations/202608150002_live_semantic_topics.sql", import.meta.url);
const recordsUrl = new URL("../supabase/migrations/202608150005_live_records_sheets_outbox.sql", import.meta.url);
const readinessUrl = new URL("../supabase/migrations/202608150006_live_gateway_readiness_start.sql", import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

const repairedFunctions = [
  "apply_live_topic_transition",
  "complete_idle_live_topic",
  "complete_live_topics_on_session_end",
  "claim_live_sheet_sync_job_v1",
  "complete_live_sheet_sync_job_v1",
  "fail_live_sheet_sync_job_v1",
  "soft_delete_owned_live_record_v1",
  "restore_owned_live_record_v1",
  "read_owned_live_record_purge_eligibility_v1",
  "activate_live_session_after_gateway_ready_v1",
];

function extractFunction(sql, functionName) {
  const match = sql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "iu"));
  assert.ok(match, `${functionName} body exists`);
  return match[0];
}

function flexibleSignature(signature) {
  return signature
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll(", ", ",\\s*")
    .replace("\\(", "\\(\\s*")
    .replace("\\)", "\\s*\\)");
}

test("ambiguity repair is a forward migration after every affected schema", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const repairIndex = migrations.indexOf(migrationName);
  assert.notEqual(repairIndex, -1);
  assert.ok(migrations.indexOf("202608150002_live_semantic_topics.sql") < repairIndex);
  assert.ok(migrations.indexOf("202608150005_live_records_sheets_outbox.sql") < repairIndex);
  assert.ok(migrations.indexOf("202608150006_live_gateway_readiness_start.sql") < repairIndex);
});

test("repair preserves each public function body except for an explicit PL/pgSQL conflict policy", async () => {
  const [repair, topics, records, readiness] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(topicsUrl, "utf8"),
    readFile(recordsUrl, "utf8"),
    readFile(readinessUrl, "utf8"),
  ]);

  for (const functionName of repairedFunctions) {
    const repairedFunction = extractFunction(repair, functionName);
    const originalSource = functionName === "activate_live_session_after_gateway_ready_v1"
      ? readiness
      : functionName.includes("topic") && !functionName.includes("sheet")
        ? topics
        : records;
    const originalFunction = extractFunction(originalSource, functionName);
    assert.equal(
      repairedFunction.replace(/#variable_conflict use_column\n/gu, ""),
      originalFunction.replace(/#variable_conflict use_column\n/gu, ""),
      `${functionName} retains its released behavior`,
    );
    assert.equal(repairedFunction.match(/#variable_conflict use_column/gu)?.length ?? 0, 1);
  }
});

test("repair keeps all callable functions service-role-only", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const signature of [
    "apply_live_topic_transition(uuid, text, text, bigint, text, uuid, integer, text, text, text, boolean)",
    "complete_idle_live_topic(uuid, text, uuid, integer)",
    "complete_live_topics_on_session_end(uuid)",
    "claim_live_sheet_sync_job_v1(uuid)",
    "complete_live_sheet_sync_job_v1(uuid, uuid, bigint, integer)",
    "fail_live_sheet_sync_job_v1(uuid, uuid, text)",
    "soft_delete_owned_live_record_v1(text, uuid)",
    "restore_owned_live_record_v1(text, uuid)",
    "read_owned_live_record_purge_eligibility_v1(text, uuid)",
    "activate_live_session_after_gateway_ready_v1(uuid, text, integer, uuid, text, text, text, text, text[], integer, text, text)",
  ]) {
    const escaped = flexibleSignature(signature);
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "iu"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "iu"));
  }
});

test("fresh-project bootstrap mirrors the forward repair exactly", async () => {
  const [migration, bootstrap] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  const block = bootstrap.match(
    new RegExp(`-- supabase/migrations/${migrationName}\\n([\\s\\S]*?)(?=\\n-- supabase/migrations/|$)`, "u"),
  );
  assert.ok(block, "bootstrap contains the ambiguity repair");
  assert.equal(block[1].trim(), migration.trim());
});
