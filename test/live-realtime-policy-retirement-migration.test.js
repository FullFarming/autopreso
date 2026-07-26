import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const policyNames = [
  "live_broadcast_viewer_receive",
  "live_broadcast_host_receive",
  "live_broadcast_host_send",
];
const voiceMigrationUrl = new URL("../supabase/migrations/202607190002_live_voice_output.sql", import.meta.url);
const pauseMigrationUrl = new URL("../supabase/migrations/202607240001_live_session_pause.sql", import.meta.url);
const preparingMigrationUrl = new URL("../supabase/migrations/202607240003_live_viewer_preparing_access.sql", import.meta.url);
const convergenceName = "202607260002_drop_legacy_realtime_policies.sql";
const convergenceUrl = new URL(`../supabase/migrations/${convergenceName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

test("fresh migration replay never alters a realtime policy retired by the gateway migration", async () => {
  const [voiceSql, pauseSql, preparingSql] = await Promise.all([
    readFile(voiceMigrationUrl, "utf8"),
    readFile(pauseMigrationUrl, "utf8"),
    readFile(preparingMigrationUrl, "utf8"),
  ]);
  for (const policyName of policyNames) {
    assert.match(voiceSql, new RegExp(`drop policy if exists ${policyName} on realtime\\.messages`, "iu"));
    assert.doesNotMatch(pauseSql, new RegExp(`(?:alter|create) policy ${policyName}`, "iu"));
    assert.doesNotMatch(preparingSql, new RegExp(`(?:alter|create) policy ${policyName}`, "iu"));
  }
  assert.match(pauseSql, /media-gateway became the\s*--\s*only caption transport/iu);
  assert.match(preparingSql, /Direct realtime\.messages policies stay retired/iu);
});

test("the final convergence migration follows caption provenance and retires all legacy policies idempotently", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202607260001_live_caption_identity_provenance.sql") < migrations.indexOf(convergenceName));
  const sql = await readFile(convergenceUrl, "utf8");
  for (const policyName of policyNames) {
    assert.match(sql, new RegExp(`drop policy if exists ${policyName} on realtime\\.messages`, "iu"));
    assert.doesNotMatch(sql, new RegExp(`(?:alter|create) policy ${policyName}`, "iu"));
  }
  assert.doesNotMatch(sql, /drop\s+(?:table|column|function|type)|truncate/iu);
});

test("fresh-project bootstrap contains no policy resurrection and embeds convergence SQL in order", async () => {
  const [bootstrap, convergence] = await Promise.all([
    readFile(bootstrapUrl, "utf8"),
    readFile(convergenceUrl, "utf8"),
  ]);
  const afterVoiceRetirement = bootstrap.slice(bootstrap.indexOf("supabase/migrations/202607190002_live_voice_output.sql"));
  for (const policyName of policyNames) {
    assert.doesNotMatch(afterVoiceRetirement, new RegExp(`(?:alter|create) policy ${policyName}`, "iu"));
  }
  const marker = "-- 2026-07-26 security: Converge every database";
  const sectionStart = bootstrap.lastIndexOf(marker);
  const nextSection = bootstrap.indexOf("\n-- ===================================================================", sectionStart);
  assert.equal(bootstrap.slice(sectionStart, nextSection).trimEnd(), convergence.trimEnd());
});
