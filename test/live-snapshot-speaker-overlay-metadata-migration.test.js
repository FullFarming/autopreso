import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260726203000_live_snapshot_speaker_overlay_metadata.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

test("speaker overlay migration follows reconciliation and remains additive", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url))).sort();
  assert.ok(migrations.indexOf("20260726201500_live_caption_lane_reconciliation.sql") < migrations.indexOf(migrationName));
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter function public\.persist_live_snapshot_if_active\(uuid, text, jsonb\)[\s\S]*rename to persist_live_snapshot_if_active_20260726061310/iu);
  assert.doesNotMatch(sql, /drop\s+(?:function|column|table)/iu);
});

test("production speaker overlay fields are the only top-level keys removed before the exact sanitizer", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const productionFinal = {
    speakerRole: "participant",
    speakerName: "Noel Kim",
    speakerDepartment: "CRE Advisory",
    speakerJobTitle: "Director",
  };
  for (const key of Object.keys(productionFinal)) {
    assert.match(sql, new RegExp(`p_event \\? '${key}'`, "u"), `${key} presence must be validated`);
    assert.match(sql, new RegExp(`p_event ->> '${key}'`, "u"), `${key} value must be validated`);
  }
  assert.match(
    sql,
    /public\.persist_live_snapshot_if_active_20260726061310\([\s\S]*p_event - array\[\s*'speakerRole', 'speakerName', 'speakerDepartment', 'speakerJobTitle'\s*\]::text\[\]/iu,
    "only the four reviewed fields may be removed before the prior exact allowlist",
  );
  assert.doesNotMatch(sql, /unexpectedSpeakerField|jsonb_object_keys|-\s*\(select/iu);
});

test("speaker overlay values are bounded, coherent, and preserved in the stored snapshot", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /speakerRole'[\s\S]*not in \('host', 'participant'\)/iu);
  assert.match(sql, /char_length\(btrim\(p_event ->> 'speakerName'\)\) not between 1 and 40/iu);
  assert.match(sql, /speakerDepartment'[\s\S]*char_length[\s\S]*> 80/iu);
  assert.match(sql, /speakerJobTitle'[\s\S]*char_length[\s\S]*> 100/iu);
  assert.equal(sql.includes("~ '[[:cntrl:]]'"), true);
  assert.equal(sql.includes("~ '[<>]'"), true);
  assert.match(sql, /jsonb_build_object\([\s\S]*'speakerRole'[\s\S]*'speakerName'[\s\S]*'speakerDepartment'[\s\S]*'speakerJobTitle'/iu);
  assert.match(sql, /update public\.live_snapshots[\s\S]*captions = jsonb_build_array\(stored_event\)/iu);
});

test("speaker overlay wrapper and its private delegate remain service-role isolated", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /security definer[\s\S]*set search_path = ''/iu);
  assert.match(sql, /revoke all on function public\.persist_live_snapshot_if_active_20260726061310\(uuid, text, jsonb\)[\s\S]*from public, anon, authenticated, service_role/iu);
  assert.match(sql, /revoke all on function public\.persist_live_snapshot_if_active\(uuid, text, jsonb\)[\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.persist_live_snapshot_if_active\(uuid, text, jsonb\)[\s\S]*to service_role/iu);
});

test("fresh-project bootstrap contains the speaker overlay migration byte-for-byte", async () => {
  const [sql, bootstrap] = await Promise.all([readFile(migrationUrl, "utf8"), readFile(bootstrapUrl, "utf8")]);
  const marker = `-- ${migrationName}`;
  const sectionStart = bootstrap.lastIndexOf(marker);
  assert.notEqual(sectionStart, -1);
  const contentStart = sectionStart + marker.length + 1;
  const nextSection = bootstrap.indexOf("\n-- 20", contentStart);
  const section = nextSection === -1
    ? bootstrap.slice(contentStart)
    : bootstrap.slice(contentStart, nextSection);
  assert.equal(section, sql);
});
