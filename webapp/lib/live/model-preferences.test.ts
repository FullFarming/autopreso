import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_ENGINE_SELECTION, engineSelectionKey } from "../../../packages/caption-core/caption-engine-catalog.js";
import {
  MAX_ENGINE_HISTORY_ENTRIES, applyEngineSelection, liveModelPreferencesSchema, readLiveModelPreferences, readNewLiveModelPreferences,
  type LiveModelPreferences,
} from "./model-preferences";
import { formatEngineLabel } from "./engine-label";
import { LiveSessionService } from "./service";
import { MemoryLiveSessionStore, SupabaseLiveSessionStore } from "./store";
import { createLiveSessionInputSchema, updateLiveSessionInputSchema } from "../security/live-input-validation";

const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const gemini37 = { ...DEFAULT_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.7-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } };
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
  assert.deepEqual(plain(readNewLiveModelPreferences({ engine: { translation: { provider: "gemini", model: "gemini-3.7-flash" } } })),
    { engine: { ...plain(DEFAULT_ENGINE_SELECTION), translation: { provider: "gemini", model: "gemini-3.7-flash" } } });
  // Old desktop builds: `{ source, summary }` → the engine they meant (retired live-translate source → Transcribe Live).
  const legacy = readNewLiveModelPreferences({ source: "gemini-3.5-live-translate-preview", summary: "gemini-3.7-flash" });
  assert.deepEqual(plain(legacy.engine), { ...plain(DEFAULT_ENGINE_SELECTION), summary: { provider: "gemini", model: "gemini-3.7-flash" } });
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
  for (const [source, summary, expectedSummary] of [
    ["gemini-3.5-live-translate-preview", "gemini-3.6-flash", "gemini-3.6-flash"],
    ["gemini-3.5-transcribe-live", "gemini-3.7-flash", "gemini-3.7-flash"],
    ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.6-flash"],
  ] as const) {
    const migrated = readLiveModelPreferences({ source, summary });
    assert.equal(migrated.engine.stt.model, "gemini-3.5-transcribe-live", source);
    assert.equal(migrated.engine.summary.model, expectedSummary, summary);
    assert.deepEqual(migrated.engineHistory, []);
  }
  for (const invalid of [null, [], "x", {}, { engine: null }, { engine: { stt: { provider: "attacker", model: "x", languageMode: "auto" } } },
    { engine: DEFAULT_ENGINE_SELECTION, source: "gemini-3.5-transcribe-live" }, { engine: DEFAULT_ENGINE_SELECTION, model: "x" },
    { source: "unknown-model", summary: "gemini-3.6-flash" }, { source: "gemini-3.5-transcribe-live" },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: "none" },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "yesterday", byHostId: "h" }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "2026-09-04T09:00:00.000Z" }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ engine: DEFAULT_ENGINE_SELECTION, changedAt: "2026-09-04T09:00:00.000Z", byHostId: "h", extra: 1 }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [{ engine: { stt: { provider: "nope", model: "x" } }, changedAt: "2026-09-04T09:00:00.000Z", byHostId: "h" }] },
    { engine: DEFAULT_ENGINE_SELECTION, engineHistory: Array.from({ length: MAX_ENGINE_HISTORY_ENTRIES + 1 }, () => history[0]) }]) {
    assert.throws(() => readLiveModelPreferences(invalid), /엔진/u, JSON.stringify(invalid));
  }
});

test("applyEngineSelection appends one history entry per change and keeps the newest 64", () => {
  const change = { changedAt: "2026-09-04T09:00:00.000Z", byHostId: "admin-1" };
  const initial: LiveModelPreferences = { engine: DEFAULT_ENGINE_SELECTION, engineHistory: [] };
  assert.deepEqual(applyEngineSelection(initial, { ...DEFAULT_ENGINE_SELECTION }, change), initial, "an equal engine changes nothing");
  const switched = applyEngineSelection(initial, soniox, change);
  assert.deepEqual(plain(switched), { engine: soniox, engineHistory: [{ engine: soniox, ...change }] });
  let rolling = switched;
  for (let index = 0; index < 70; index += 1) {
    rolling = applyEngineSelection(rolling, index % 2 === 0 ? gemini37 : soniox, { changedAt: `2026-09-04T10:${String(index).padStart(2, "0")}:00.000Z`, byHostId: `host-${index}` });
  }
  assert.equal(rolling.engineHistory.length, MAX_ENGINE_HISTORY_ENTRIES);
  assert.equal(rolling.engineHistory.at(-1)?.byHostId, "host-69");
  assert.equal(rolling.engineHistory[0]?.byHostId, "host-6", "the oldest entries fall off first");
  sameEngine(rolling.engine, soniox);
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
  sameEngine(direct.modelPreferences?.engine, soniox, );
  assert.deepEqual(plain((await service.create("host-1", base)).modelPreferences), { engine: plain(DEFAULT_ENGINE_SELECTION), engineHistory: [] });
  await assert.rejects(service.create("host-1", { ...base, modelPreferences: { engine: { stt: { provider: "nope", model: "x" } } } }, { engineDefaults: gemini37, isAdmin: true }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_ENGINE_SELECTION");
  // Soniox two-way translation needs exactly two caption languages: refused at create, not at go-live.
  await assert.rejects(service.create("host-1", { ...base, languages: ["ko", "en", "ja"] }, { engineDefaults: soniox }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENGINE_LANGUAGE_COUNT_INVALID");
});

test("update: the engine may change while live, each change appends engineHistory, and non-admin engines are replaced by the global default", async () => {
  let now = Date.UTC(2026, 8, 4, 9, 0, 0);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", { title: "Engine", sessionType: "meeting", languages: ["ko"], ticker: "NOVA" }, { engineDefaults: DEFAULT_ENGINE_SELECTION });
  const edited = await service.update("host-1", created.id, { version: created.version, title: "Renamed" });
  assert.deepEqual(plain(edited.modelPreferences), { engine: plain(DEFAULT_ENGINE_SELECTION), engineHistory: [] }, "an unrelated edit keeps the engine and appends nothing");
  assert.equal(edited.ticker, "NOVA");
  const started = await store.startOwned(created.id, "host-1", edited.version);
  assert.equal(started?.status, "live");
  now += 60_000;
  const adminSwitch = await service.update("admin-1", created.id, { version: started!.version, modelPreferences: { engine: soniox } }, { engineDefaults: DEFAULT_ENGINE_SELECTION, isAdmin: true })
    .catch(() => null);
  assert.equal(adminSwitch, null, "the session is owned by host-1; another host id cannot update it");
  const hostSwitch = await service.update("host-1", created.id, { version: started!.version, modelPreferences: { engine: soniox } }, { engineDefaults: gemini37, isAdmin: true });
  assert.equal(hostSwitch.status, "live");
  assert.deepEqual(plain(hostSwitch.modelPreferences), { engine: soniox, engineHistory: [{ engine: soniox, changedAt: "2026-09-04T09:01:00.000Z", byHostId: "host-1" }] });
  now += 60_000;
  const nonAdmin = await service.update("host-1", created.id, { version: hostSwitch.version, modelPreferences: { engine: DEFAULT_ENGINE_SELECTION } }, { engineDefaults: gemini37 });
  assert.deepEqual(plain(nonAdmin.modelPreferences), { engine: gemini37, engineHistory: [
    { engine: soniox, changedAt: "2026-09-04T09:01:00.000Z", byHostId: "host-1" },
    { engine: gemini37, changedAt: "2026-09-04T09:02:00.000Z", byHostId: "host-1" },
  ] }, "a non-admin engine is replaced by the global default, and that replacement is what the history records");
  const sameAgain = await service.update("host-1", created.id, { version: nonAdmin.version, modelPreferences: { engine: gemini37 } }, { engineDefaults: gemini37 });
  assert.equal(sameAgain.modelPreferences?.engineHistory.length, 2, "re-sending the current engine appends nothing");
  await assert.rejects(service.update("host-1", created.id, { version: sameAgain.version, languages: ["ko", "en", "ja"], modelPreferences: { engine: soniox } }, { engineDefaults: soniox }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENGINE_LANGUAGE_COUNT_INVALID");
});

test("the Supabase store writes the service's preferences and keeps the stored ones when a patch carries none", async () => {
  const stored = readLiveModelPreferences({ source: "gemini-3.6-flash", summary: "gemini-3.5-flash" });
  const session = await new LiveSessionService(new MemoryLiveSessionStore()).create("host", { title: "Pinned", sessionType: "meeting", languages: ["ko"] });
  const metadata = { modelPreferences: { source: "gemini-3.6-flash", summary: "gemini-3.5-flash" }, integration: { externalReference: "retained" }, ticker: "NOVA" };
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
  const switched = applyEngineSelection(stored, soniox, { changedAt: "2026-09-04T09:00:00.000Z", byHostId: "admin-1" });
  const replaced = await store.updateOwned(session.id, "host", 1, { ...session, modelPreferences: switched });
  assert.deepEqual(plain((writes[1].p_event_metadata as Record<string, unknown>).modelPreferences), plain(switched), "the store writes exactly what the service decided, history included");
  assert.deepEqual(plain(replaced?.modelPreferences), plain(switched));
  await assert.rejects(store.updateOwned(session.id, "host", 1, { ...session, modelPreferences: { engine: { stt: { provider: "nope", model: "x" } } } as never }), /엔진/u);
  assert.equal(writes.length, 2);
});

test("engine labels come from the catalog; a combined engine shows one provider", () => {
  assert.equal(formatEngineLabel(DEFAULT_ENGINE_SELECTION), "Gemini 3.5 Transcribe Live · Gemini 3.6 Flash");
  assert.equal(formatEngineLabel(gemini37), "Gemini 3.5 Transcribe Live · Gemini 3.7 Flash");
  assert.equal(formatEngineLabel(soniox), "Soniox stt-rt-v5");
  assert.equal(formatEngineLabel({ stt: { provider: "nope", model: "x" } }), "—");
});

test("routes: the service is the engine authority, /api/live-config publishes availability booleans only, and the host UI is read-only", () => {
  const create = readFileSync(new URL("../../app/api/live-sessions/route.ts", import.meta.url), "utf8");
  const patch = readFileSync(new URL("../../app/api/live-sessions/[id]/route.ts", import.meta.url), "utf8");
  for (const source of [create, patch]) {
    assert.match(source, /resolveEngineDefaultsOrFallback\(\), isAdminRequest\(request\)/u);
    assert.match(source, /\{ engineDefaults, isAdmin \}/u);
  }
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
