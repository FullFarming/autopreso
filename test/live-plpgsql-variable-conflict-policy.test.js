import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 2026-09-06 incident: the 17-argument persist_live_final_caption_if_active declared
// `source_row public.live_source_utterances%rowtype` AND aliased the table as `source_row`
// in the same SELECT. PL/pgSQL (variable_conflict = error) rejected `source_row.id` with
// SQLSTATE 42702 on every final caption, the gateway treated the failed persist as fatal
// and closed the host socket, and Live Calls could neither keep captions nor end.
// 202608150007 fixed the same class of bug by pinning `#variable_conflict use_column`;
// 202608220001 reintroduced it. This test pins the policy over the final definitions.

const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);
const repairMigration = "202609060001_live_source_transcript_variable_conflict.sql";

function finalFunctionDefinitions(sql) {
  const blocks = sql.match(/create or replace function public\.[a-z0-9_]+\s*\([\s\S]*?\s\$\$;/giu) ?? [];
  const byIdentity = new Map();
  for (const block of blocks) {
    const header = block.match(/^create or replace function public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns/iu);
    if (!header) continue;
    const args = header[2].replace(/\s+/gu, " ").replace(/\bdefault\b[^,]*/giu, "").trim().toLowerCase();
    byIdentity.set(`${header[1].toLowerCase()}(${args})`, block);
  }
  return byIdentity;
}

export function findAliasCollisions(block) {
  if (!/language\s+plpgsql/iu.test(block)) return [];
  if (/#\s*variable_conflict\s+use_column/iu.test(block)) return [];
  const declare = block.match(/\bdeclare\b([\s\S]*?)\bbegin\b/iu)?.[1] ?? "";
  const variables = [...declare.matchAll(/(?:^|;|\s)([a-z_][a-z0-9_]*)\s+(?:public\.[a-z_]+%rowtype|[a-z_]+%rowtype|record)\b/giu)]
    .map((m) => m[1].toLowerCase());
  const collisions = [];
  for (const variable of new Set(variables)) {
    const statements = block.match(new RegExp(`(?:from|join|update|delete\\s+from)\\s+public\\.[a-z_]+\\s+(?:as\\s+)?${variable}\\b[^;]*`, "giu")) ?? [];
    if (statements.some((statement) => new RegExp(`\\b${variable}\\.[a-z_]+`, "iu").test(statement))) collisions.push(variable);
  }
  return collisions;
}

test("every final plpgsql definition that aliases a table as one of its row variables pins #variable_conflict use_column", async () => {
  const bootstrap = await readFile(bootstrapUrl, "utf8");
  const offenders = [];
  for (const [identity, block] of finalFunctionDefinitions(bootstrap)) {
    const collisions = findAliasCollisions(block);
    if (collisions.length > 0) offenders.push(`${identity} -> ${collisions.join(",")}`);
  }
  assert.deepEqual(offenders, [], `ambiguous alias/variable pairs without the compiler directive:\n${offenders.join("\n")}`);
});

test("the detector recognises the incident shape and the repaired shape", () => {
  const broken = `create or replace function public.f(p uuid) returns boolean language plpgsql as $$
declare source_row public.live_source_utterances%rowtype;
begin
  select * into source_row from public.live_source_utterances source_row where source_row.id = p;
  return found;
end;
$$;`;
  assert.deepEqual(findAliasCollisions(broken), ["source_row"]);
  assert.deepEqual(findAliasCollisions(broken.replace("as $$\n", "as $$\n#variable_conflict use_column\n")), []);
  assert.deepEqual(findAliasCollisions(broken.replace(/source_row where source_row\./u, "src where src.")), []);
});

test("the repair migration is additive, mirrored byte-for-byte into the bootstrap, and covers the three 202608220001 functions", async () => {
  const [sql, bootstrap] = await Promise.all([
    readFile(new URL(`../supabase/migrations/${repairMigration}`, import.meta.url), "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\btruncate\b/iu);
  assert.equal(bootstrap.split(`-- supabase/migrations/${repairMigration}`).length - 1, 1);
  assert.ok(bootstrap.includes(`-- supabase/migrations/${repairMigration}\n\n${sql}`));
  for (const name of ["persist_authoritative_live_source_utterance_v1", "persist_live_final_caption_if_active", "append_owned_live_source_correction_v1"]) {
    const block = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\s\\$\\$;`, "iu"))?.[0];
    assert.ok(block, `${name} is redefined`);
    assert.match(block, /as \$\$\n#variable_conflict use_column\n/u);
    assert.deepEqual(findAliasCollisions(block), []);
  }
  assert.match(sql, /p_authoritative_source_id uuid\s*\)/u, "the 17-argument overload is the one the gateway calls");
});

test("202609060002 strips the wire-only provenance keys before the durable snapshot validator and is mirrored", async () => {
  const name = "202609060002_live_final_caption_wire_keys.sql";
  const [sql, bootstrap] = await Promise.all([
    readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"),
    readFile(bootstrapUrl, "utf8"),
  ]);
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\btruncate\b/iu);
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  const block = sql.match(/create or replace function public\.persist_live_final_caption_if_active\([\s\S]*?\s\$\$;/iu)?.[0];
  assert.ok(block);
  assert.match(block, /p_authoritative_source_id uuid\s*\)/u);
  assert.match(block, /#variable_conflict use_column/u);
  assert.match(block, /p_event - array\['authoritativeSourceId', 'sourceSequence'\]::text\[\]/u);
  assert.deepEqual(findAliasCollisions(block), []);
});
