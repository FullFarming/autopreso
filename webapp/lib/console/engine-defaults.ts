import { DEFAULT_ENGINE_SELECTION, normalizeEngineSelection } from "../../../packages/caption-core/caption-engine-catalog.js";
import { readGeminiSelectedModel } from "../../../packages/caption-core/gemini-model-catalog.js";
import { LiveSecurityConfigurationError } from "../security/config";
import { __onConsoleStoreSwapped, getConsoleStore, type ConsoleSettings } from "./console-store";

// Mirrors the shape `normalizeEngineSelection` returns (caption-engine-catalog.js):
// roles stt / translation / summary, only stt carries languageMode.
export interface EngineRoleSelection { provider: string; model: string }
export interface SttEngineSelection extends EngineRoleSelection { languageMode: string }
export interface EngineSelection { stt: SttEngineSelection; translation: EngineRoleSelection; summary: EngineRoleSelection }

/** Stored engine defaults re-validated against the catalog; anything unreadable is the catalog default. */
export function readStoredEngineDefaults(value: unknown): EngineSelection {
  try {
    return normalizeEngineSelection(value ?? DEFAULT_ENGINE_SELECTION) as EngineSelection;
  } catch {
    return normalizeEngineSelection(DEFAULT_ENGINE_SELECTION) as EngineSelection;
  }
}

/**
 * Seed for a new Live Call session's `modelPreferences` (webapp/lib/live/model-preferences.ts):
 * a Gemini stt model is the `source`; any other stt provider maps to the catalog's default
 * Gemini source because the session runtime only understands Gemini model ids there.
 */
export function engineDefaultsToModelPreferences(engine: EngineSelection): { source: string; summary: string } {
  const fallback = { source: readGeminiSelectedModel("source", undefined), summary: readGeminiSelectedModel("summary", undefined) };
  try {
    const source = engine.stt.provider === "gemini" ? engine.stt.model : fallback.source;
    return { source: readGeminiSelectedModel("source", source), summary: readGeminiSelectedModel("summary", engine.summary.model) };
  } catch {
    return fallback;
  }
}

/** What an unconfigured or unmigrated project behaves like: legacy login stays on, no engine override. */
export const CONSOLE_SETTINGS_FALLBACK: Readonly<ConsoleSettings> = Object.freeze({
  legacyPasswordLoginEnabled: true, engine: null, engineUpdatedAt: null, engineUpdatedByEmail: null,
});

const DEFAULT_TTL_MS = 60_000;

export interface ConsoleSettingsCache { get(): Promise<ConsoleSettings>; invalidate(): void }

export function createConsoleSettingsCache(opts: { read: () => Promise<ConsoleSettings>; ttlMs?: number; now?: () => number }): ConsoleSettingsCache {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  let entry: { value: ConsoleSettings; expiresAt: number } | null = null;
  let inflight: Promise<ConsoleSettings> | null = null;
  const refresh = async (): Promise<ConsoleSettings> => {
    try {
      const value = await opts.read();
      entry = { value, expiresAt: now() + ttl };
      return value;
    } catch (error) {
      // No Supabase server credentials: there is no console to consult, so behave as before the
      // console existed. Cached for the TTL so a request storm does not re-evaluate the env each time.
      if (error instanceof LiveSecurityConfigurationError) {
        entry = { value: CONSOLE_SETTINGS_FALLBACK, expiresAt: now() + ttl };
        return CONSOLE_SETTINGS_FALLBACK;
      }
      // Store outage: keep serving the last known settings instead of failing every login.
      if (entry) return entry.value;
      throw error;
    }
  };
  return {
    async get() {
      if (entry && entry.expiresAt > now()) return entry.value;
      inflight ??= refresh().finally(() => { inflight = null; });
      return inflight;
    },
    invalidate() { entry = null; },
  };
}

/** Module singleton (60 s). Route handlers that write settings must call `invalidate()` afterwards. */
export const consoleSettingsCache: ConsoleSettingsCache = createConsoleSettingsCache({ read: () => getConsoleStore().readSettings() });
__onConsoleStoreSwapped(() => consoleSettingsCache.invalidate());

/** Global engine defaults as the catalog-validated selection (never throws on stored garbage). */
export async function resolveEngineDefaults(): Promise<EngineSelection> {
  return readStoredEngineDefaults((await consoleSettingsCache.get()).engine);
}
