import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202607260003_live_utterance_replay_provenance.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);
const transcriptRouteUrl = new URL("../webapp/app/api/live-sessions/[id]/transcript/route.ts", import.meta.url);

test("replay provenance migration is additive and follows caption identity", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url))).sort();
  assert.ok(migrations.indexOf("202607260001_live_caption_identity_provenance.sql") < migrations.indexOf(migrationName));
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\btruncate\b/iu);
  assert.match(sql, /add column if not exists translation_status text/iu);
  assert.match(sql, /translation_status is null or translation_status in \('verbatim', 'translated', 'failed'\)/iu);
  assert.match(sql, /Existing rows remain null/iu);
  const bootstrap = await readFile(bootstrapUrl, "utf8");
  assert.match(bootstrap, new RegExp(migrationName.replaceAll(".", "\\."), "u"));
  assert.match(bootstrap, /add column if not exists translation_status text/iu);
});

test("transcript response keeps its legacy fields and adds optional provenance", async () => {
  const route = await readFile(transcriptRouteUrl, "utf8");
  for (const field of ["seq", "speaker", "text", "emittedAt"]) {
    assert.match(route, new RegExp(`${field}: utterance\\.`, "u"));
  }
  for (const field of ["participantId", "sourceText", "sourceLanguage", "origin", "utteranceKey", "translationStatus"]) {
    assert.match(route, new RegExp(`utterance\\.${field} \\? \\{ ${field}: utterance\\.${field} \\}`, "u"));
  }
});

test("new overload delegates every existing gate and preserves first-write status", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /p_utterance_key text,\s*p_translation_status text/iu);
  assert.match(sql, /p_source_text, p_source_language, p_origin, p_utterance_key\s*\)/iu);
  assert.match(sql, /translation_status = coalesce\(translation_status, clean_translation_status\)/iu);
  assert.doesNotMatch(sql, /coalesce\(clean_translation_status, translation_status\)/iu);
  assert.match(sql, /revoke all on function public\.persist_live_utterance_if_active\([\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.persist_live_utterance_if_active\([\s\S]*to service_role/iu);
});
