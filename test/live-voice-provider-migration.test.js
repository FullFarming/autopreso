import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/202607220001_live_voice_provider.sql",
  import.meta.url,
);

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

test("voice provider migration is additive, bounded, and defaults existing sessions to Gemini", async () => {
  const sql = await readMigration();
  assert.match(sql, /add column voice_provider text not null default 'gemini'/u);
  assert.match(sql, /voice_provider in \('gemini', 'openai'\)/u);
  assert.match(sql, /voice_provider <> 'openai'[\s\S]*session_type = 'presentation'[\s\S]*output_mode in \('captions_audio', 'audio'\)/u);
  assert.doesNotMatch(sql, /drop (column|table)|alter type[\s\S]*drop value/iu);
});

test("voice provider create and update RPC overloads remain service-role only", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.create_live_session\([\s\S]*p_voice_provider text/u);
  assert.match(sql, /create or replace function public\.update_live_session\([\s\S]*p_voice_provider text/u);
  assert.match(sql, /p_voice_provider not in \('gemini', 'openai'\)/u);
  assert.equal(
    (sql.match(/p_voice_provider = 'openai'[\s\S]*?p_session_type <> 'presentation'[\s\S]*?p_output_mode not in \('captions_audio', 'audio'\)/gu) ?? []).length,
    2,
  );
  assert.match(sql, /session_row\.version = p_expected_version/u);
  assert.match(sql, /voice_provider := updated_session\.voice_provider/u);
  assert.match(sql, /revoke all on function public\.create_live_session\(uuid, text, text, text, text\[\], integer, text, text, timestamptz\)[\s\S]*from public, anon, authenticated/u);
  assert.match(sql, /grant execute on function public\.update_live_session\(uuid, text, integer, text, text, text\[\], integer, text, text\)[\s\S]*to service_role/u);
});

test("named viewer redemption RPCs return voice provider without removing legacy overloads", async () => {
  const sql = await readMigration();
  for (const name of ["redeem_live_admission", "redeem_live_invite"]) {
    const fiveArgumentSignature = `${name}(text, text, text, timestamptz, text)`;
    assert.match(sql, new RegExp(`drop function public\\.${fiveArgumentSignature.replace(/[()[\]]/gu, "\\$&")}`, "u"));
    assert.match(sql, new RegExp(`revoke all on function public\\.${fiveArgumentSignature.replace(/[()[\]]/gu, "\\$&")}[\\s\\S]*?from public, anon, authenticated`, "u"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fiveArgumentSignature.replace(/[()[\]]/gu, "\\$&")}[\\s\\S]*?to service_role`, "u"));

    const recreated = sql.match(
      new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?p_display_name text[\\s\\S]*?\\n\\$\\$;`, "u"),
    )?.[0];
    assert.ok(recreated);
    assert.match(recreated, /voice_provider text/u);
    assert.match(recreated, /voice_provider := session_row\.voice_provider/u);
  }
  assert.doesNotMatch(sql, /drop function public\.redeem_live_(admission|invite)\(text, text, text, timestamptz\);/u);
});

test("voice provider is exposed through authenticated session reads", async () => {
  const sql = await readMigration();
  assert.match(sql, /grant select \(voice_provider\)[\s\S]*on public\.live_sessions to authenticated/u);
  assert.match(sql, /voice_provider text,[\s\S]*admission_open_until timestamptz/u);
});
