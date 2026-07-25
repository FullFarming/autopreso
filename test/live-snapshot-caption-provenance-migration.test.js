import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "202607250002_live_snapshot_caption_provenance.sql";
const migrationUrl = new URL(`../supabase/migrations/${migrationName}`, import.meta.url);
const bootstrapUrl = new URL("../supabase/bootstrap-new-project.sql", import.meta.url);

const REQUIRED_KEYS = [
  "type", "seq", "sessionId", "language", "speaker", "text",
  "isFinal", "sourceEndedAt", "emittedAt",
];
const OPTIONAL_KEYS = ["sourceStartedAt", "sourceText", "sourceLanguage", "translationStatus"];
const SPEAKER_REQUIRED = ["speakerId", "label", "colorToken", "voiceName", "voiceStatus", "lastSeenAt"];
const SPEAKER_OPTIONAL = ["name", "department", "jobTitle"];

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("snapshot provenance migration follows the utterance source-text migration and stays additive", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.indexOf("202607250001_live_utterance_source_text.sql") < migrations.indexOf(migrationName));

  const sql = await readMigration();
  assert.doesNotMatch(sql, /\bdrop\s+(column|table|type|function)\b|\btruncate\b/iu);
  assert.match(sql, /create or replace function public\.persist_live_snapshot_if_active\(\s*p_session_id uuid,\s*p_language text,\s*p_event jsonb\s*\)/iu);
  assert.match(sql, /security definer[\s\S]*set search_path = ''/iu);
});

test("the event key allowlist accepts the fields the pipeline actually publishes", async () => {
  const sql = await readMigration();
  // The gateway has always sent sourceStartedAt (resolveSourceStartedAt returns
  // null, never undefined, so the key is always serialized) and now also sends
  // the three provenance fields. An exact-key allowlist that omits them makes
  // this function return false for EVERY finalized caption, which the publisher
  // escalates to SESSION_STOPPED.
  for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
    assert.match(sql, new RegExp(`'${key}'`, "u"), `${key} must appear in the allowlist`);
  }
  // Required keys are still mandatory.
  assert.match(sql, /not \(p_event \?& array\[/iu);
  // Unknown keys are still rejected — widening must not become "accept anything".
  assert.match(sql, /\(p_event - array\[[\s\S]*?\]::text\[\]\) <> '\{\}'::jsonb/iu);
  const strippedGuard = sql.match(/\(p_event - array\[([\s\S]*?)\]::text\[\]\) <> '\{\}'::jsonb/iu)?.[1] ?? "";
  for (const key of OPTIONAL_KEYS) {
    assert.match(strippedGuard, new RegExp(`'${key}'`, "u"), `${key} must be subtracted before the unknown-key check`);
  }
});

test("each newly accepted field is type and size validated", async () => {
  const sql = await readMigration();
  // sourceText is bounded exactly like text, so one caption cannot smuggle an
  // arbitrarily large second payload into the snapshot row.
  assert.match(sql, /length\(btrim\(p_event ->> 'sourceText'\)\) not between 1 and 8000/iu);
  assert.match(sql, /octet_length\(p_event ->> 'sourceText'\) > 24000/iu);
  assert.match(sql, /p_event ->> 'sourceLanguage'\) !~ '\^\[A-Za-z\]\{2,3\}\(-\[A-Za-z0-9\]\{2,8\}\)\*\$'/u);
  assert.match(sql, /p_event ->> 'translationStatus' not in \(\s*'verbatim', 'translated', 'failed'\s*\)/iu);
  assert.match(sql, /p_event ->> 'sourceStartedAt'\) !~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}T/u);
  // The overall byte cap must leave room for text AND sourceText.
  const cap = Number(sql.match(/octet_length\(p_event::text\) > (\d+)/u)?.[1] ?? 0);
  assert.ok(cap >= 24000 * 2, `event byte cap ${cap} must fit both text and sourceText`);
});

test("participant speakers are accepted instead of silently rejected", async () => {
  const sql = await readMigration();
  const speakerGuard = sql.match(/\(\(p_event -> 'speaker'\) - array\[([\s\S]*?)\]::text\[\]\) <> '\{\}'::jsonb/iu)?.[1] ?? "";
  assert.notEqual(speakerGuard, "", "speaker unknown-key guard must still exist");
  for (const key of [...SPEAKER_REQUIRED, ...SPEAKER_OPTIONAL]) {
    assert.match(speakerGuard, new RegExp(`'${key}'`, "u"), `speaker key ${key} must be subtracted`);
  }
  // Identity fields carry the same bounds the participant tables enforce.
  assert.match(sql, /p_event -> 'speaker' ->> 'name'\)\) not between 1 and 40/iu);
  assert.match(sql, /p_event -> 'speaker' ->> 'department'\)\) not between 1 and 80/iu);
  assert.match(sql, /p_event -> 'speaker' ->> 'jobTitle'\)\) not between 1 and 100/iu);
});

test("the sanitized event and speaker actually carry provenance to the viewer", async () => {
  const sql = await readMigration();
  // A widened allowlist that still rebuilds only the old nine keys would accept
  // the caption and then drop the originals on the way into the snapshot, so
  // reconnecting viewers would lose 원문보기 for their replayed history.
  const sanitizedEvent = sql.match(/sanitized_event := jsonb_build_object\(([\s\S]*?)\n  \);/u)?.[1] ?? "";
  assert.notEqual(sanitizedEvent, "", "sanitized_event must be built");
  for (const key of OPTIONAL_KEYS) {
    assert.match(sanitizedEvent, new RegExp(`'${key}'`, "u"), `${key} must survive into the stored snapshot`);
  }
  assert.match(sql, /sanitized_speaker := jsonb_build_object\(/u, "sanitized_speaker must be built");
  // voiceName must stay raw jsonb so a null survives: the viewer's isSpeaker
  // validator requires the key to be present as string-or-null.
  assert.match(sql, /'voiceName', p_event -> 'speaker' -> 'voiceName'/u);
  for (const key of SPEAKER_OPTIONAL) {
    assert.match(
      sql,
      new RegExp(`sanitized_speaker\\s*\\|\\|\\s*jsonb_build_object\\('${key}'`, "u"),
      `speaker ${key} must survive into the stored snapshot`,
    );
  }
});

test("the replacement stays service-role-only and reaches fresh projects", async () => {
  const [sql, bootstrap] = await Promise.all([readMigration(), readFile(bootstrapUrl, "utf8")]);
  const signature = "persist_live_snapshot_if_active\\(\\s*uuid,\\s*text,\\s*jsonb\\s*\\)";
  assert.match(sql, new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*from public, anon, authenticated`, "iu"));
  assert.match(sql, new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*to service_role`, "iu"));
  assert.match(bootstrap, new RegExp(`supabase/migrations/${migrationName}`, "u"));
});
