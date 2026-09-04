import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ENGINE_SELECTION } from "../../../packages/caption-core/caption-engine-catalog.js";
import { LiveSecurityConfigurationError } from "../security/config";
import { ConsoleStoreError, SupabaseConsoleStore, __setConsoleStoreForTests, type ConsoleSettings } from "./console-store";
import {
  CONSOLE_SETTINGS_FALLBACK, consoleSettingsCache, createConsoleSettingsCache,
  readStoredEngineDefaults, resolveEngineDefaults,
} from "./engine-defaults";

const settings = (engine: unknown): ConsoleSettings => ({ legacyPasswordLoginEnabled: false, engine, engineUpdatedAt: "2026-09-03T00:00:00+00:00", engineUpdatedByEmail: "a@x.io" });

test("readStoredEngineDefaults(null) is the catalog default and a valid Gemini selection round-trips", () => {
  assert.deepEqual(readStoredEngineDefaults(null), DEFAULT_ENGINE_SELECTION);
  assert.deepEqual(readStoredEngineDefaults(undefined), DEFAULT_ENGINE_SELECTION);
  const gemini = { stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" }, translation: { provider: "gemini", model: "gemini-3.7-flash" }, summary: { provider: "gemini", model: "gemini-3.7-flash" } };
  assert.deepEqual(readStoredEngineDefaults(gemini), gemini);
  // A partial stored object is completed from the defaults (stt languageMode, missing roles).
  assert.deepEqual(readStoredEngineDefaults({ translation: { provider: "gemini", model: "gemini-3.5-flash-lite" } }), {
    ...DEFAULT_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.5-flash-lite" },
  });
});

test("garbage stored values fall back to the default without throwing", () => {
  for (const garbage of ["gemini", 42, [], { stt: { provider: "gemini", model: "nope" } }, { bogus: true }, { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "fr" } }]) {
    assert.deepEqual(readStoredEngineDefaults(garbage), DEFAULT_ENGINE_SELECTION, JSON.stringify(garbage));
  }
});

test("createConsoleSettingsCache memoizes for 60 s, dedupes concurrent reads, and invalidates", async () => {
  let now = 0; let reads = 0;
  const cache = createConsoleSettingsCache({ read: async () => { reads++; return settings(null); }, now: () => now });
  await Promise.all([cache.get(), cache.get()]);
  await cache.get();
  assert.equal(reads, 1);
  now = 60_001; await cache.get();
  assert.equal(reads, 2);
  cache.invalidate(); await cache.get();
  assert.equal(reads, 3);
});

test("the cache returns the fail-open fallback when Supabase is unconfigured and serves the last value across an outage", async () => {
  const unconfigured = createConsoleSettingsCache({ read: async () => { throw new LiveSecurityConfigurationError("no env"); } });
  assert.deepEqual(await unconfigured.get(), CONSOLE_SETTINGS_FALLBACK);
  assert.deepEqual(CONSOLE_SETTINGS_FALLBACK, { legacyPasswordLoginEnabled: true, engine: null, engineUpdatedAt: null, engineUpdatedByEmail: null });

  let fail = false; let now = 0;
  const flaky = createConsoleSettingsCache({ read: async () => { if (fail) throw new ConsoleStoreError("down", "CONSOLE_STORE_UNAVAILABLE", 503); return settings(DEFAULT_ENGINE_SELECTION); }, now: () => now });
  assert.deepEqual(await flaky.get(), settings(DEFAULT_ENGINE_SELECTION));
  fail = true; now = 120_000;
  assert.deepEqual(await flaky.get(), settings(DEFAULT_ENGINE_SELECTION));

  const cold = createConsoleSettingsCache({ read: async () => { throw new ConsoleStoreError("down", "CONSOLE_STORE_UNAVAILABLE", 503); } });
  await assert.rejects(cold.get(), (e: ConsoleStoreError) => e.code === "CONSOLE_STORE_UNAVAILABLE");
});

test("the module singleton reads through getConsoleStore(), the store seam invalidates it, and resolveEngineDefaults normalizes the stored engine", async () => {
  const fake = new SupabaseConsoleStore({
    fetchFn: async () => new Response(JSON.stringify([{ legacy_password_login_enabled: false, engine: { translation: { provider: "gemini", model: "gemini-3.7-flash" } }, engine_updated_at: null, engine_updated_by_email: null }]), { status: 200 }),
    getServerAccess: () => ({ url: "https://project.supabase.test", credential: { key: "fixture-secret", kind: "secret" as const } }),
  });
  try {
    __setConsoleStoreForTests(fake);
    const value = await consoleSettingsCache.get();
    assert.equal(value.legacyPasswordLoginEnabled, false);
    assert.deepEqual(await resolveEngineDefaults(), { ...DEFAULT_ENGINE_SELECTION, translation: { provider: "gemini", model: "gemini-3.7-flash" } });
    const broken = new SupabaseConsoleStore({ fetchFn: async () => new Response("{}", { status: 500 }), getServerAccess: fake["getServerAccess"] });
    __setConsoleStoreForTests(broken);
    // Swapping the store dropped the memo: the broken store is consulted and, with no previous value, its error surfaces.
    await assert.rejects(consoleSettingsCache.get(), (e: ConsoleStoreError) => e.code === "CONSOLE_STORE_UNAVAILABLE");
  } finally {
    __setConsoleStoreForTests(null);
  }
});
