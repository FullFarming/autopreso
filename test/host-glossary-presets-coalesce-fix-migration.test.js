import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const baseMigrationName = "20260727012000_host_glossary_presets.sql";
const repairMigrationName = "20260727013000_host_glossary_presets_coalesce_fix.sql";
const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);

async function readMigration(name) {
  return readFile(new URL(name, migrationsUrl), "utf8");
}

test("coalesce repair is a forward-only migration after the applied glossary schema", async () => {
  const migrations = (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.indexOf(baseMigrationName) < migrations.indexOf(repairMigrationName));

  const [baseSql, repairSql] = await Promise.all([
    readMigration(baseMigrationName),
    readMigration(repairMigrationName),
  ]);
  assert.match(baseSql, /pg_catalog\.coalesce\(/u, "the applied migration must remain immutable");
  assert.doesNotMatch(repairSql, /pg_catalog\.coalesce\(/u);
  assert.match(repairSql, /pg_catalog\.btrim\(coalesce\(/u);
  assert.doesNotMatch(repairSql, /\b(?:create|alter|drop|truncate)\s+(?:table|index|type)\b/iu);
});

test("all four repaired RPCs preserve definer and service-role-only boundaries", async () => {
  const sql = await readMigration(repairMigrationName);
  const signatures = [
    "list_host_glossary_presets(text)",
    "create_host_glossary_preset(text, text, text, text, text, text)",
    "update_host_glossary_preset(uuid, text, integer, text, text, text, text, text)",
    "delete_host_glossary_preset(uuid, text, integer)",
  ];

  assert.equal((sql.match(/create or replace function public\.(?:list|create|update|delete)_host_glossary_preset(?:s)?\(/giu) ?? []).length, 4);
  assert.equal((sql.match(/security definer/giu) ?? []).length, 4);
  assert.equal((sql.match(/set search_path = ''/giu) ?? []).length, 4);
  for (const signature of signatures) {
    const escaped = signature.replace(/[()[\]]/gu, "\\$&");
    assert.match(sql, new RegExp("revoke all on function public\\." + escaped + "[\\s\\S]*?from public, anon, authenticated", "iu"));
    assert.match(sql, new RegExp("grant execute on function public\\." + escaped + "[\\s\\S]*?to service_role", "iu"));
  }
});

test("repair changes only coalesce resolution while retaining capacity and version guards", async () => {
  const sql = await readMigration(repairMigrationName);
  assert.match(sql, /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(clean_host_id, 0\)\)/iu);
  assert.match(sql, /preset_count >= 50[\s\S]*GLOSSARY_PRESET_LIMIT_REACHED/iu);
  assert.match(sql, /where preset_row\.id = p_id[\s\S]*preset_row\.host_id = clean_host_id[\s\S]*preset_row\.version = p_expected_version/iu);
  assert.equal((sql.match(/GET DIAGNOSTICS affected_count = ROW_COUNT/gu) ?? []).length, 2);
  for (const errorCode of [
    "INVALID_HOST_GLOSSARY_PRESET_INPUT",
    "GLOSSARY_PRESET_NAME_CONFLICT",
    "GLOSSARY_PRESET_VERSION_CONFLICT",
    "GLOSSARY_PRESET_NOT_FOUND",
  ]) assert.match(sql, new RegExp(errorCode, "u"));
});
