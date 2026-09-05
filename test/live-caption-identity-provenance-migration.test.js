import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202607260001_live_caption_identity_provenance.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);
const gatewayAdapterUrl = new URL("../media-gateway/src/supabase-adapters.js", import.meta.url);
const webStoreUrl = new URL("../webapp/lib/live/store.ts", import.meta.url);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("caption identity provenance follows the deployed snapshot sanitizer and stays non-destructive", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202607250002_live_snapshot_caption_provenance.sql") < migrations.indexOf(migrationName));

  const sql = await readMigration();
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\btruncate\b/iu);
  assert.match(sql, /add column if not exists origin text/iu);
  assert.match(sql, /add column if not exists utterance_key text/iu);
  assert.match(sql, /Existing rows remain valid with null provenance/iu);
});

test("snapshot wrapper validates, strips, and restores only canonical identity fields", async () => {
  const sql = await readMigration();
  assert.match(sql, /rename to persist_live_snapshot_if_active_20260725/iu);
  assert.match(sql, /p_event ->> 'origin' <> 'source'/iu);
  assert.match(sql, /char_length\(p_event ->> 'utteranceKey'\) not between 1 and 200/iu);
  assert.match(sql, /octet_length\(p_event ->> 'utteranceKey'\) > 600/iu);
  assert.match(sql, /p_event - array\['origin', 'utteranceKey'\]::text\[\]/iu);
  assert.match(sql, /jsonb_build_object\('origin', p_event ->> 'origin'\)/iu);
  assert.match(sql, /jsonb_build_object\('utteranceKey', p_event ->> 'utteranceKey'\)/iu);
  assert.match(sql, /if not \(stored_event \? 'origin'\)[\s\S]*jsonb_build_object\('origin'/iu);
  assert.match(sql, /if not \(stored_event \? 'utteranceKey'\)[\s\S]*jsonb_build_object\('utteranceKey'/iu);
  assert.match(sql, /revoke all on function public\.persist_live_snapshot_if_active_20260725[\s\S]*service_role/iu);
  // The 20260725 helper owns the active-session/language/seq validation. The
  // wrapper must not patch any JSON unless that guard explicitly accepted it.
  assert.match(
    sql,
    /stored := public\.persist_live_snapshot_if_active_20260725\([\s\S]*?\);\s*if not stored then\s*return false;\s*end if;[\s\S]*?select snapshot_row\.captions/iu,
  );
});

test("utterance provenance overload delegates to the prior guarded overload", async () => {
  const sql = await readMigration();
  const overload = sql.match(
    /create or replace function public\.persist_live_utterance_if_active\([\s\S]*?\n\$\$;/iu,
  )?.[0] ?? "";
  assert.match(overload, /p_source_language text,\s*p_origin text,\s*p_utterance_key text/iu);
  assert.match(
    overload,
    /stored := public\.persist_live_utterance_if_active\([\s\S]*?p_source_text, p_source_language\s*\)/iu,
  );
  assert.match(overload, /if not stored then\s*return false;\s*end if;[\s\S]*?update public\.live_utterances/iu);
  assert.match(overload, /set origin = coalesce\(origin, clean_origin\),\s*utterance_key = coalesce\(utterance_key, clean_utterance_key\)/iu);
  assert.match(sql, /check \(origin is null or origin = 'source'\)/iu);
  assert.match(sql, /char_length\(utterance_key\) between 1 and 200/iu);
});

test("same-seq retries preserve the first non-null canonical identity", async () => {
  const sql = await readMigration();
  // Snapshot JSON concatenation is safe only behind field-absence guards;
  // jsonb `||` otherwise lets a conflicting retry overwrite the first value.
  assert.doesNotMatch(sql, /if jsonb_typeof\(p_event -> 'origin'\) = 'string' then\s*stored_event := stored_event/iu);
  assert.doesNotMatch(sql, /if jsonb_typeof\(p_event -> 'utteranceKey'\) = 'string' then\s*stored_event := stored_event/iu);
  // SQL coalesce must put the stored column first. Reversing these operands
  // mutates provenance for an already-committed unique row.
  assert.match(sql, /origin = coalesce\(origin, clean_origin\)/iu);
  assert.match(sql, /utterance_key = coalesce\(utterance_key, clean_utterance_key\)/iu);
  assert.doesNotMatch(sql, /coalesce\(clean_(?:origin|utterance_key), (?:origin|utterance_key)\)/iu);
});

test("new public RPCs stay service-role-only and reach fresh-project bootstrap", async () => {
  const [sql, bootstrap] = await Promise.all([readMigration(), readFile(bootstrapUrl, "utf8")]);
  assert.match(
    sql,
    /revoke all on function public\.persist_live_snapshot_if_active\(uuid, text, jsonb\)[\s\S]*from public, anon, authenticated/iu,
  );
  assert.match(
    sql,
    /grant execute on function public\.persist_live_utterance_if_active\([\s\S]*?text, text\s*\) to service_role/iu,
  );
  assert.match(bootstrap, new RegExp(`supabase/migrations/${migrationName}`, "u"));
  assert.match(bootstrap, /add column if not exists utterance_key text/iu);
  const marker = `-- 2026-07-26 fix: Preserve canonical source-lane`;
  const sectionStart = bootstrap.lastIndexOf(marker);
  const nextSection = bootstrap.indexOf("-- ===================================================================", sectionStart + marker.length);
  assert.equal(
    bootstrap.slice(sectionStart, nextSection).trimEnd() + "\n",
    sql,
    "fresh-project bootstrap must contain the migration byte-for-byte",
  );
});

test("publisher and both replay readers use the additive provenance contract", async () => {
  const [gateway, webStore] = await Promise.all([
    readFile(gatewayAdapterUrl, "utf8"),
    readFile(webStoreUrl, "utf8"),
  ]);
  assert.match(gateway, /p_origin: event\.origin \?\? null,\s*p_utterance_key: event\.utteranceKey \?\? null/iu);
  assert.match(gateway, /select: "seq,participant_id,speaker_label,speaker_name,text,source_text,source_language,origin,utterance_key,translation_status,/u);
  assert.match(gateway, /row\.origin === "source" \? \{ origin: "source" \} : \{\}/u);
  assert.match(gateway, /row\.utterance_key[\s\S]*?\{ utteranceKey: row\.utterance_key \}/u);
  assert.match(webStore, /origin: string \| null;\s*utterance_key: string \| null;\s*translation_status: "verbatim" \| "translated" \| "failed" \| null;/u);
  assert.match(webStore, /if \(row\.origin === "source"\) caption\.origin = "source";/u);
  assert.match(webStore, /if \(row\.utterance_key\) caption\.utteranceKey = row\.utterance_key;/u);
  assert.match(webStore, /select: "seq,participant_id,speaker_label,speaker_name,text,source_text,source_language,source_started_at,origin,utterance_key,translation_status,source_ended_at,emitted_at,authoritative_source_id,translation_capture"/u);
});
