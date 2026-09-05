import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_ENGINE_SELECTION, engineSelectionKey } from "../../../packages/caption-core/caption-engine-catalog.js";
import {
  EVENT_METADATA_BYTE_BUDGET, MAX_ENGINE_HISTORY_ENTRIES, MAX_STORED_ENGINE_HISTORY_ENTRIES, applyEngineSelection, fitEventMetadataToByteBudget,
  liveModelPreferencesSchema, readLiveModelPreferences, readNewLiveModelPreferences,
  type LiveModelPreferences,
} from "./model-preferences";
import { formatEngineLabel } from "./engine-label";
import { LiveSessionService } from "./service";
import { MemoryLiveSessionStore, SupabaseLiveSessionStore } from "./store";
import { createLiveSessionInputSchema, liveSessionInputErrorCode, updateLiveSessionInputSchema } from "../security/live-input-validation";

const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const gemini37 = { ...DEFAULT_ENGINE_SELECTION, stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" }, translation: { provider: "gemini", model: "gemini-3.7-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } };
const soniox = {
  stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
  translation: { provider: "soniox", model: "stt-rt-v5" },
  summary: { provider: "gemini", model: "gemini-3.7-flash" },
};
const sameEngine = (left: unknown, right: unknown) => assert.equal(engineSelectionKey(left), engineSelectionKey(right));

test("client input is `{ engine }` validated by the catalog; the legacy per-role pin migrates; nothing else passes", () => {
  assert.deepEqual(plain(readNewLiveModelPreferences(undefined)), { engine: plain(DEFAULT_ENGINE_SELECTION) });
  assert.deepEqual(plain(readNewLiveModelPreferences({ engine: soniox })), { engine: soniox });
  // Partial engines complete from the catalog defaults (stt languageMode, missing roles).
  assert.deepEqual(plain(readNewLiveModelPreferences({ engine: { stt: gemini37.stt, translation: { provider: "gemini", model: "gemini-3.7-flash" } } })),
    { engine: { ...plain(DEFAULT_ENGINE_SELECTION), stt: gemini37.stt, translation: { provider: "gemini", model: "gemini-3.7-flash" } } });
  // Old desktop builds: `{ source, summary }` → the engine they meant (retired live-translate source → Transcribe Live).
  const legacy = readNewLiveModelPreferences({ source: "gemini-3.5-live-translate-preview", summary: "gemini-3.7-flash" });
  assert.deepEqual(plain(legacy.engine), { ...plain(DEFAULT_ENGINE_SELECTION), stt: gemini37.stt, translation: { provider: "gemini", model: "gemini-3.6-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } });
  assert.equal(readNewLiveModelPreferences({ source: "gemini-3.5-transcribe-live", summary: "gemini-3.5-flash" }).engine.summary.model, "gemini-3.6-flash",
    "a retired summary id maps to the catalog default, never to a model outside the summary role");
  for (const invalid of [null, {}, [], "gemini", { engine: null }, { engine: "gemini" }, { engine: [] },
    { engine: { stt: { provider: "attacker", model: "x", languageMode: "auto" } } },
    { engine: { stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "ko" } } },
    { engine: { ...soniox, stt: { ...soniox.stt, provider: "gemini", model: "gemini-3.5-transcribe-live" } } },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] }, { engine: DEFAULT_ENGINE_SELECTION, apiKey: "private" },
    { source: "gemini-3.5-transcribe-live" }, { source: "unlisted-model", summary: "gemini-3.6-flash" },
    { source: "gemini-3.5-transcribe-live", summary: "https://169.254.169.254/model" },
    { source: "gemini-3.5-transcribe-live", summary: "gemini-3.6-flash", engine: DEFAULT_ENGINE_SELECTION }]) {
    assert.throws(() => readNewLiveModelPreferences(invalid), (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_ENGINE_SELECTION", JSON.stringify(invalid));
    assert.equal(liveModelPreferencesSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
});

test("HTTP create and update validate the same nested engine shape, not arbitrary provider configuration", () => {
  assert.deepEqual(createLiveSessionInputSchema.parse({ sessionType: "meeting" }).languages, ["ko", "en"]);
  assert.deepEqual(createLiveSessionInputSchema.parse({ sessionType: "meeting", languages: ["ja", "zh-Hans", "en"] }).languages, ["ja", "zh-Hans", "en"]);
  for (const modelPreferences of [{ engine: DEFAULT_ENGINE_SELECTION }, { engine: soniox }, { source: "gemini-3.5-transcribe-live", summary: "gemini-3.6-flash" }]) {
    const created = createLiveSessionInputSchema.safeParse({ sessionType: "meeting", languages: ["ko"], modelPreferences });
    assert.equal(created.success, true, JSON.stringify(modelPreferences));
    assert.deepEqual(Object.keys(created.data?.modelPreferences ?? {}), ["engine"], "history is server-owned and never parsed from a client");
    assert.equal(updateLiveSessionInputSchema.safeParse({ version: 1, modelPreferences }).success, true);
  }
  assert.equal(createLiveSessionInputSchema.safeParse({ sessionType: "meeting", languages: ["ko"], modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, apiKey: "private" } }).success, false);
  assert.equal(createLiveSessionInputSchema.safeParse({ sessionType: "meeting", languages: ["ko"], modelPreferences: { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] } }).success, false);
  assert.equal(updateLiveSessionInputSchema.safeParse({ version: 1, modelPreferences: { engine: { stt: { provider: "gemini", model: "nope" } } } }).success, false);
});

test("stored preferences read back as `{ engine, engineHistory }`; legacy rows migrate; malformed rows fail closed", () => {
  assert.deepEqual(plain(readLiveModelPreferences(undefined)), { engine: plain(DEFAULT_ENGINE_SELECTION), engineHistory: [] });
  const history = [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "2026-09-04T09:00:00.000Z", byHostId: "admin-1" }];
  assert.deepEqual(plain(readLiveModelPreferences({ engine: soniox, engineHistory: history })), { engine: soniox, engineHistory: plain(history) });
  assert.deepEqual(plain(readLiveModelPreferences({ engine: soniox })), { engine: soniox, engineHistory: [] });
  // `reason` (Task 4 fix M4) is optional on read: rows written before it exist.
  for (const reason of ["admin", "server-default"] as const) {
    const entry = { ...history[0], reason };
    assert.deepEqual(plain(readLiveModelPreferences({ engine: soniox, engineHistory: [entry] })), { engine: soniox, engineHistory: [plain(entry)] });
  }
  // Rows written under the former 64-entry cap still read; the write path trims them to MAX_ENGINE_HISTORY_ENTRIES.
  assert.equal(readLiveModelPreferences({ engine: soniox, engineHistory: Array.from({ length: MAX_STORED_ENGINE_HISTORY_ENTRIES }, () => history[0]) }).engineHistory.length, MAX_STORED_ENGINE_HISTORY_ENTRIES);
  for (const [source, summary, expectedSummary] of [
    ["gemini-3.5-live-translate-preview", "gemini-3.6-flash", "gemini-3.6-flash"],
    ["gemini-3.5-transcribe-live", "gemini-3.7-flash", "gemini-3.7-flash"],
    ["gemini-3.5-transcribe-live", "gemini-3.5-flash", "gemini-3.6-flash"],
  ] as const) {
    const migrated = readLiveModelPreferences({ source, summary });
    assert.equal(migrated.engine.stt.model, "gemini-3.5-transcribe-live", source);
    assert.equal(migrated.engine.summary.model, expectedSummary, summary);
    assert.deepEqual(migrated.engineHistory, []);
  }
  for (const invalid of [null, [], "x", {}, { engine: null }, { engine: { stt: { provider: "attacker", model: "x", languageMode: "auto" } } },
    { engine: DEFAULT_ENGINE_SELECTION, source: "gemini-3.5-transcribe-live" }, { engine: DEFAULT_ENGINE_SELECTION, model: "x" },
    { source: "unknown-model", summary: "gemini-3.6-flash" }, { source: "gemini-3.5-transcribe-live" },
    { source: "gemini-3.6-flash", summary: "gemini-3.6-flash" }, { source: "gemini-3.7-flash", summary: "gemini-3.5-flash" },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: "none" },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "yesterday", byHostId: "h" }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "2026-09-04T09:00:00.000Z" }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "2026-09-04T09:00:00.000Z", byHostId: "h", extra: 1 }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ engine: { stt: { provider: "nope", model: "x" } }, changedAt: "2026-09-04T09:00:00.000Z", byHostId: "h" }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ ...history[0], reason: "host" }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: Array.from({ length: MAX_STORED_ENGINE_HISTORY_ENTRIES + 1 }, () => history[0]) }]) {
    assert.throws(() => readLiveModelPreferences(invalid), /엔진/u, JSON.stringify(invalid));
  }
});

test("applyEngineSelection appends one history entry per change (with its reason) and keeps the newest 8", () => {
  assert.equal(MAX_ENGINE_HISTORY_ENTRIES, 8);
  const change = { changedAt: "2026-09-04T09:00:00.000Z", byHostId: "admin-1", reason: "admin" as const };
  const initial: LiveModelPreferences = { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] };
  assert.deepEqual(applyEngineSelection(initial, { ...DEFAULT_ENGINE_SELECTION }, change), initial, "an equal engine changes nothing");
  const switched = applyEngineSelection(initial, soniox, change);
  assert.deepEqual(plain(switched), { engine: soniox, engineHistory: [{ engine: soniox, ...change }] });
  let rolling = switched;
  for (let index = 0; index < 70; index += 1) {
    rolling = applyEngineSelection(rolling, index % 2 === 0 ? gemini37 : soniox,
      { changedAt: `2026-09-04T10:${String(index).padStart(2, "0")}:00.000Z`, byHostId: `host-${index}`, reason: index % 2 === 0 ? "server-default" : "admin" });
  }
  assert.equal(rolling.engineHistory.length, MAX_ENGINE_HISTORY_ENTRIES);
  assert.equal(rolling.engineHistory.at(-1)?.byHostId, "host-69");
  assert.equal(rolling.engineHistory.at(-1)?.reason, "admin");
  assert.equal(rolling.engineHistory[0]?.byHostId, "host-62", "the oldest entries fall off first");
  sameEngine(rolling.engine, soniox);
  // A 64-entry row read from storage is trimmed to the cap on the next change.
  const legacyWide: LiveModelPreferences = { engine: DEFAULT_ENGINE_SELECTION, engineHistory: Array.from({ length: 64 }, (_, index) => ({ engine: gemini37, changedAt: change.changedAt, byHostId: `old-${index}` })) };
  const trimmed = applyEngineSelection(legacyWide, soniox, change);
  assert.equal(trimmed.engineHistory.length, MAX_ENGINE_HISTORY_ENTRIES);
  assert.equal(trimmed.engineHistory[0]?.byHostId, "old-57");
  assert.equal(trimmed.engineHistory.at(-1)?.byHostId, "admin-1");
});

test("event_metadata byte budget: history is dropped oldest-first until the serialized body fits 3800 bytes (Task 4 fix I1)", () => {
  assert.equal(EVENT_METADATA_BYTE_BUDGET, 3800);
  const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const hostId = "h".repeat(128);
  // 20 × 120 ASCII-ish labels: the largest agenda the input schema admits (~2.9 KB serialized).
  const agenda = Array.from({ length: 20 }, (_, index) => ({ ordinal: index + 1, label: "a".repeat(120) }));
  let preferences: LiveModelPreferences = { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] };
  for (let index = 0; index < 30; index += 1) {
    preferences = applyEngineSelection(preferences, index % 2 === 0 ? soniox : gemini37,
      { changedAt: `2026-09-04T10:${String(index).padStart(2, "0")}:00.000Z`, byHostId: hostId, reason: "admin" });
    const body = fitEventMetadataToByteBudget({ ticker: "NOVA", eventType: "earnings_call", agenda, modelPreferences: preferences });
    assert.ok(byteLength(body) <= EVENT_METADATA_BYTE_BUDGET, `${index}: ${byteLength(body)} bytes`);
    const history = (body.modelPreferences as LiveModelPreferences).engineHistory;
    assert.ok(history.length >= 1, "the newest change always survives");
    assert.equal(history.at(-1)?.changedAt, preferences.engineHistory.at(-1)?.changedAt, "newest entries are the ones kept");
    assert.deepEqual(history, preferences.engineHistory.slice(-history.length));
    assert.deepEqual(plain(body.agenda), agenda, "the budget only touches history, never the agenda");
    assert.equal(body.ticker, "NOVA");
  }
  // A body that already fits is returned unchanged; a huge foreign key is left alone (only history shrinks).
  const small = { ticker: null, eventType: null, agenda: [], modelPreferences: preferences };
  assert.deepEqual(fitEventMetadataToByteBudget(small), small);
  const foreign = { ticker: null, eventType: null, agenda: [], integration: { blob: "x".repeat(3900) }, modelPreferences: preferences };
  assert.deepEqual((fitEventMetadataToByteBudget(foreign).modelPreferences as LiveModelPreferences).engineHistory, []);
  assert.equal(fitEventMetadataToByteBudget(foreign).integration, foreign.integration);
});

test("create: non-admins get the global engine (a sent engine is replaced, not rejected); admins may set one; the console default seeds it", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const base = { sessionType: "meeting", languages: ["ko"] };
  const seeded = await service.create("host-1", base, { engineDefaults: gemini37 });
  assert.deepEqual(plain(seeded.modelPreferences), { engine: gemini37, engineHistory: [] });
  const replaced = await service.create("host-1", { ...base, modelPreferences: { engine: soniox } }, { engineDefaults: gemini37 });
  sameEngine(replaced.modelPreferences?.engine, gemini37);
  const legacyReplaced = await service.create("host-1", { ...base, modelPreferences: { source: "gemini-3.5-transcribe-live", summary: "gemini-3.6-flash" } }, { engineDefaults: gemini37 });
  sameEngine(legacyReplaced.modelPreferences?.engine, gemini37);
  const admin = await service.create("host-1", { ...base, modelPreferences: { engine: soniox } }, { engineDefaults: gemini37, isAdmin: true });
  sameEngine(admin.modelPreferences?.engine, soniox);
  const adminUnspecified = await service.create("host-1", base, { engineDefaults: gemini37, isAdmin: true });
  sameEngine(adminUnspecified.modelPreferences?.engine, gemini37);
  const direct = await service.create("host-1", { ...base, modelPreferences: { engine: soniox } });
  sameEngine(direct.modelPreferences?.engine, DEFAULT_ENGINE_SELECTION);
  assert.equal(direct.modelPreferences?.engine.stt.provider, "soniox", "no console defaults and no admin → the catalog default, never the host's request (fix M3)");
  assert.deepEqual(plain((await service.create("host-1", base)).modelPreferences), { engine: plain(DEFAULT_ENGINE_SELECTION), engineHistory: [] });
  await assert.rejects(service.create("host-1", { ...base, modelPreferences: { engine: { stt: { provider: "nope", model: "x" } } } }, { engineDefaults: gemini37, isAdmin: true }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_ENGINE_SELECTION");
  const three = await service.create("host-1", { ...base, languages: ["ko", "en", "ja"] }, { engineDefaults: soniox });
  assert.deepEqual(three.languages, ["ko", "en", "ja"]);
});

test("session assignment is pinned across admin changes, edits and reconnect reads", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", { sessionType: "meeting", languages: ["ko","en","ja"], modelPreferences: { engine: gemini37 } }, { engineDefaults: soniox, assignmentRevision: "7", isAdmin: true });
  sameEngine(created.modelPreferences?.engine, soniox);
  assert.equal(created.modelPreferences?.assignmentRevision,"7");
  const changed = await service.update("host-1", created.id, { version: created.version, title: "New title", modelPreferences: { engine: gemini37 } }, {engineDefaults:gemini37, assignmentRevision:"8",isAdmin:true});
  assert.deepEqual(changed.modelPreferences,created.modelPreferences);
  assert.deepEqual((await store.getOwned(created.id,"host-1"))?.modelPreferences,created.modelPreferences);
  const next = await service.create("host-1", {sessionType:"meeting",languages:["ko","en"]}, {engineDefaults:gemini37,assignmentRevision:"8"});
  sameEngine(next.modelPreferences?.engine,gemini37);
  assert.equal(next.modelPreferences?.assignmentRevision,"8");
});

test("the Supabase store writes the service's preferences and keeps the stored ones when a patch carries none", async () => {
  const stored = readLiveModelPreferences({ source: "gemini-3.5-live-translate-preview", summary: "gemini-3.5-flash" });
  const session = await new LiveSessionService(new MemoryLiveSessionStore()).create("host", { title: "Pinned", sessionType: "meeting", languages: ["ko"] });
  const metadata = { modelPreferences: { source: "gemini-3.5-live-translate-preview", summary: "gemini-3.5-flash" }, integration: { externalReference: "retained" }, ticker: "NOVA" };
  const writes: Record<string, unknown>[] = [];
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: "sb_secret_test", kind: "secret" }, async (url, init) => {
    if (init?.method === "GET") {
      const query = new URL(String(url)).searchParams;
      assert.equal(query.get("host_id"), "eq.host");
      assert.equal(query.get("version"), "eq.1");
      return Response.json([{ event_metadata: metadata }]);
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    writes.push(body);
    return Response.json([{
      id: session.id, host_id: "host", session_type: "meeting", output_mode: "captions",
      title: body.p_title, status: "preparing", languages: ["ko"], viewer_count: 0,
      max_viewers: 50, version: 2, glossary_pack: "general_cre", voice_provider: "gemini",
      participant_speaking_enabled: false, admission_open_until: null, expires_at: session.expiresAt,
      event_metadata: body.p_event_metadata,
    }]);
  });
  const edited = await store.updateOwned(session.id, "host", 1, { ...session, title: "Edited", modelPreferences: undefined });
  assert.deepEqual(plain(edited?.modelPreferences), plain(stored), "no preferences in the patch → the stored (migrated) engine survives");
  assert.deepEqual((writes[0].p_event_metadata as Record<string, unknown>).integration, metadata.integration);
  assert.equal(writes[0].p_expected_version, 1);
  const switched = applyEngineSelection(stored, soniox, { changedAt: "2026-09-04T09:00:00.000Z", byHostId: "admin-1", reason: "admin" });
  const replaced = await store.updateOwned(session.id, "host", 1, { ...session, modelPreferences: switched });
  assert.deepEqual(plain((writes[1].p_event_metadata as Record<string, unknown>).modelPreferences), plain(switched), "the store writes exactly what the service decided, history included");
  assert.deepEqual(plain(replaced?.modelPreferences), plain(switched));
  await assert.rejects(store.updateOwned(session.id, "host", 1, { ...session, modelPreferences: { engine: { stt: { provider: "nope", model: "x" } } } as never }), /엔진/u);
  assert.equal(writes.length, 2);
  // The byte budget is applied to the real merged body (existing keys + patch), so the RPC never sees > 3800 bytes.
  const wide = Array.from({ length: 64 }, (_, index) => ({ engine: gemini37, changedAt: "2026-09-04T09:00:00.000Z", byHostId: `old-${index}`.padEnd(128, "h") }));
  const agenda = Array.from({ length: 20 }, (_, index) => ({ ordinal: index + 1, label: "a".repeat(120) }));
  await store.updateOwned(session.id, "host", 1, { ...session, agenda, modelPreferences: { engine: soniox, engineHistory: wide } });
  const body = writes[2].p_event_metadata as { modelPreferences: LiveModelPreferences; agenda: unknown };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= EVENT_METADATA_BYTE_BUDGET, String(Buffer.byteLength(JSON.stringify(body))));
  assert.ok(body.modelPreferences.engineHistory.length >= 1);
  assert.equal(body.modelPreferences.engineHistory.at(-1)?.byHostId, wide.at(-1)?.byHostId, "newest kept");
  assert.deepEqual(plain(body.agenda), agenda);
});

test("stored modelPreferences of a listed session is parsed per row: one poisoned row is skipped and logged by code + id, not the whole list (Task 4 fix I3)", async () => {
  const base = { host_id: "owner", title: "Saved", scheduled_at: null, session_type: "meeting", output_mode: "captions",
    voice_provider: "gemini", status: "preparing", languages: ["ko"], viewer_count: 0, version: 1,
    admission_state: "uninitialized", admission_open_until: null, expires_at: "2020-01-01T00:00:00Z" };
  const rows = [
    { ...base, id: "session-good-1", event_metadata: { modelPreferences: { engine: soniox, engineHistory: [] } } },
    { ...base, id: "session-poisoned", event_metadata: { modelPreferences: { engine: { stt: { provider: "attacker", model: "x" } } } } },
    { ...base, id: "session-good-2", event_metadata: { modelPreferences: { source: "gemini-3.5-transcribe-live", summary: "gemini-3.7-flash" } } },
    { ...base, id: "session-bad-agenda", event_metadata: { agenda: [{ ordinal: 2, label: "x" }] } },
  ];
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: "sb_secret_test", kind: "secret" }, async () => Response.json(rows));
  const logged: string[] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const listed = await store.listOwnedActive("owner");
    assert.deepEqual(listed.map((session) => session.id), ["session-good-1", "session-good-2"]);
    sameEngine(listed[1]?.modelPreferences?.engine, { ...DEFAULT_ENGINE_SELECTION, stt: gemini37.stt, translation: { provider: "gemini", model: "gemini-3.6-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } });
    assert.equal(logged.length, 2);
    assert.match(logged[0], /INVALID_STORED_SESSION/u);
    assert.match(logged[0], /session-poisoned/u);
    assert.match(logged[1], /session-bad-agenda/u);
    assert.doesNotMatch(logged.join("\n"), /attacker|Saved|owner/u, "only the code and the session id are logged");
    // get / getOwned keep failing closed on the same row.
    const single = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: "sb_secret_test", kind: "secret" }, async () => Response.json([rows[1]]));
    await assert.rejects(single.getOwned("session-poisoned", "owner"), (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_STORED_SESSION");
  } finally {
    console.error = previous;
  }
});

test("HTTP input: a malformed engine is its own 400 code (INVALID_ENGINE_SELECTION), other shape errors stay INVALID_REQUEST (Task 4 fix M2)", () => {
  const engineFailure = createLiveSessionInputSchema.safeParse({ sessionType: "meeting", languages: ["ko"], modelPreferences: { engine: { stt: { provider: "nope", model: "x" } } } });
  assert.equal(engineFailure.success, false);
  if (!engineFailure.success) assert.equal(liveSessionInputErrorCode(engineFailure.error), "INVALID_ENGINE_SELECTION");
  const legacyFailure = updateLiveSessionInputSchema.safeParse({ version: 1, modelPreferences: { source: "gemini-3.7-flash", summary: "gemini-3.6-flash" } });
  assert.equal(legacyFailure.success, false);
  if (!legacyFailure.success) assert.equal(liveSessionInputErrorCode(legacyFailure.error), "INVALID_ENGINE_SELECTION");
  const other = createLiveSessionInputSchema.safeParse({ sessionType: "meeting", languages: ["xx"] });
  assert.equal(other.success, false);
  if (!other.success) assert.equal(liveSessionInputErrorCode(other.error), "INVALID_REQUEST");
  const both = createLiveSessionInputSchema.safeParse({ sessionType: "nope", languages: ["ko"], modelPreferences: { engine: "gemini" } });
  assert.equal(both.success, false);
  if (!both.success) assert.equal(liveSessionInputErrorCode(both.error), "INVALID_REQUEST", "an engine error beside other errors is a malformed request as a whole");
  for (const route of ["../../app/api/live-sessions/route.ts", "../../app/api/live-sessions/[id]/route.ts"]) {
    const source = readFileSync(new URL(route, import.meta.url), "utf8");
    assert.match(source, /liveSessionInputErrorCode\(parsed\.error\)/u, route);
  }
});

test("engine labels come from the catalog; a combined engine shows one provider", () => {
  assert.equal(formatEngineLabel(DEFAULT_ENGINE_SELECTION), "Soniox stt-rt-v5");
  assert.equal(formatEngineLabel(gemini37), "Gemini 3.5 Transcribe Live · Gemini 3.7 Flash");
  assert.equal(formatEngineLabel(soniox), "Soniox stt-rt-v5");
  assert.equal(formatEngineLabel({ stt: { provider: "nope", model: "x" } }), "—");
});

test("routes: the service is the engine authority, /api/live-config publishes availability booleans only, and the host UI is read-only", () => {
  const create = readFileSync(new URL("../../app/api/live-sessions/route.ts", import.meta.url), "utf8");
  const patch = readFileSync(new URL("../../app/api/live-sessions/[id]/route.ts", import.meta.url), "utf8");
  assert.match(create, /resolveHostEngineAssignment\(hostId\)/u);
  assert.match(create, /\{ engineDefaults, assignmentRevision \}/u);
  assert.doesNotMatch(patch, /resolveEngineDefaults|resolveHostEngineAssignment/u);
  const liveConfig = readFileSync(new URL("../../app/api/live-config/route.ts", import.meta.url), "utf8");
  assert.match(liveConfig, /captionEngines: captionEngineAvailability\(\)/u);
  assert.doesNotMatch(liveConfig, /process\.env\.(?:GEMINI|SONIOX)_API_KEY/u, "the route never touches key values");
  const engineDefaults = readFileSync(new URL("../console/engine-defaults.ts", import.meta.url), "utf8");
  assert.match(engineDefaults, /hasApiKeys: \{ gemini: Boolean\(environment\.GEMINI_API_KEY\), soniox: Boolean\(environment\.SONIOX_API_KEY\) \}/u);
  const dashboard = readFileSync(new URL("../../components/live/LiveHostDashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /fetch\("\/api\/live-config"/u);
  assert.match(dashboard, /formatEngineLabel\(/u);
  assert.match(dashboard, /t\("관리자 지정"\)/u);
  assert.doesNotMatch(dashboard, /name="engine|<select[^>]*engine/u, "hosts get a status line, never an engine picker");
  const messages = readFileSync(new URL("../system-language/host-messages.ts", import.meta.url), "utf8");
  assert.match(messages, /\["관리자 지정", "Set by admin", "管理者指定"\]/u);
  assert.match(messages, /\["자막 엔진", "Caption engine", "字幕エンジン"\]/u);
});
