import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../webapp/app/api/live-sessions/[id]/glossary/route.ts", import.meta.url);
const validationUrl = new URL("../webapp/lib/live/validation.ts", import.meta.url);
const serviceUrl = new URL("../webapp/lib/live/service.ts", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/202608270001_live_session_multi_glossary_pins.sql", import.meta.url);

function requireOrdered(source, tokens) {
  let previous = -1;
  for (const token of tokens) {
    const offset = source.indexOf(token);
    assert.ok(offset > previous, `${token} must follow the previous security boundary`);
    previous = offset;
  }
}

test("glossary mutation is strict-origin, host-only, rate-limited, bounded, and validated before storage", async () => {
  const [route, validation, service] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(validationUrl, "utf8"),
    readFile(serviceUrl, "utf8"),
  ]);

  const postRoute = route.slice(route.indexOf("export async function POST"));
  requireOrdered(postRoute, [
    "assertStrictOrigin(request)",
    "requireHost(request)",
    "parseSessionId(",
    "enforceGlossarySelectionRateLimit(",
    "readBoundedJsonBody(request)",
    ".replaceGlossaryPins(hostId, sessionId, input)",
  ]);
  assert.match(validation, /from ["']\.\.\/security\/glossary-selection-validation["']/u);
  assert.match(validation, /parseGlossarySelections\(record\.glossaries\)/u);
  const pluralParser = validation.slice(
    validation.indexOf("export function parseLiveGlossaryPinsInput"),
    validation.indexOf("function invalidGlossaryPin"),
  );
  assert.match(pluralParser, /keys\.length\s*!==\s*2/u);
  assert.match(pluralParser, /Number\(record\.expectedVersion\)\s*>\s*2_147_483_647/u);
  assert.doesNotMatch(pluralParser, /parseLiveGlossaryPinInput\(/u);
  requireOrdered(service.slice(service.indexOf("async replaceGlossaryPins")), [
    "parseLiveGlossaryPinsInput(input)",
    "this.store.replaceGlossaryPinsOwned(",
  ]);
  assert.doesNotMatch(route, /request[^\n]*hostId|record\.hostId|body\.hostId/u);
  assert.match(route, /privateNoStoreHeaders\(\)/u);
});

test("multi-glossary SQL is owner-scoped, optimistic, exact, and service-role only", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.replace_live_session_glossary_pins_v2\s*\(/u);
  assert.match(sql, /jsonb_typeof\(p_glossaries\)\s*<>\s*'array'[\s\S]*jsonb_array_length\(p_glossaries\)\s+not between 1 and 5/iu);
  assert.match(sql, /jsonb_typeof\(glossary_item\)\s*<>\s*'object'[\s\S]*glossary_item\s*-\s*array\['source_kind',\s*'source_id',\s*'document_version'\]\s*<>\s*'\{\}'::jsonb/iu);
  assert.match(sql, /source_kind[\s\S]*(?:builtin|host)[\s\S]*source_id[\s\S]*document_version/iu);
  for (const builtin of [
    "common_business", "ai_ax", "commercial_real_estate", "hospitality",
    "fnb_retail", "proper_nouns", "ko_ja_idioms",
  ]) assert.match(sql, new RegExp(`\\b${builtin}\\b`, "u"));
  assert.doesNotMatch(sql, /\b(?:general_cre|hotel|fnb)\b/u);

  assert.match(sql, /where candidate_session\.id\s*=\s*p_session_id[\s\S]*candidate_session\.host_id\s*=\s*clean_host_id[\s\S]*for update/iu);
  assert.match(sql, /session_row\.version\s*<>\s*p_expected_session_version[\s\S]*LIVE_SESSION_VERSION_CONFLICT/iu);
  assert.match(sql, /session_row\.status\s*<>\s*'preparing'[\s\S]*ACTIVE_SESSION_GLOSSARY_IMMUTABLE/iu);
  assert.match(sql, /version_row\.host_id\s*=\s*preset_row\.host_id[\s\S]*preset_row\.host_id\s*=\s*clean_host_id/iu);
  assert.match(sql, /create unique index live_session_glossary_pins_builtin_unique[\s\S]*\(session_id,\s*builtin_id\)[\s\S]*where source_kind\s*=\s*'builtin'/iu);
  assert.match(sql, /create unique index live_session_glossary_pins_host_unique[\s\S]*\(session_id,\s*host_preset_id\)[\s\S]*where source_kind\s*=\s*'host'/iu);
  assert.match(sql, /PINNED_GLOSSARY_VERSION_MISMATCH|PINNED_GLOSSARY_FINGERPRINT_MISMATCH/iu);

  assert.match(sql, /revoke all on (?:table|function)[\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.replace_live_session_glossary_pins_v2[\s\S]*to service_role/iu);
  assert.doesNotMatch(sql, /execute\s+format\s*\(|\|\|\s*p_(?:host_id|session_id|glossaries)/iu);
});

test("foreign references and stale fingerprints abort the atomic replacement function", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const deleteOffset = sql.indexOf("delete from public.live_session_glossary_pins");
  assert.ok(deleteOffset > 0);
  for (const guard of [
    "LIVE_SESSION_NOT_FOUND",
    "LIVE_SESSION_VERSION_CONFLICT",
    "ACTIVE_SESSION_GLOSSARY_IMMUTABLE",
  ]) {
    const guardOffset = sql.indexOf(guard);
    assert.ok(guardOffset > 0 && guardOffset < deleteOffset, `${guard} must fail before replacing pins`);
  }
  assert.match(sql, /preset_row\.host_id\s*=\s*clean_host_id[\s\S]*ACTIVE_GLOSSARY_DOCUMENT_VERSION_NOT_FOUND/iu);
  assert.match(sql, /version_row\.fingerprint\s*=\s*pin_row\.host_document_fingerprint[\s\S]*PINNED_GLOSSARY_VERSION_MISMATCH/iu);
  assert.doesNotMatch(sql, /exception\s+when[\s\S]*(?:commit|return)/iu);
  assert.doesNotMatch(sql, /http|net\.|dblink|pg_notify/iu);
});
