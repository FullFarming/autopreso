import { DEFAULT_ENGINE_SELECTION, captionEngineCatalogForClient, normalizeEngineSelection } from "../../../packages/caption-core/caption-engine-catalog.js";
import { LiveSecurityConfigurationError } from "../security/config";
import type { EngineRoleSelection, EngineSelection, SttEngineSelection } from "../live/model-preferences";
import { __onConsoleStoreSwapped, getConsoleStore, type ConsoleSettings } from "./console-store";

// The engine types live with the session's `modelPreferences` (lib/live/model-preferences.ts)
// so the client-side Live Call code can import them without pulling the console store in.
export type { EngineRoleSelection, EngineSelection, SttEngineSelection };

/** Stored engine defaults re-validated against the catalog; anything unreadable is the catalog default. */
export function readStoredEngineDefaults(value: unknown): EngineSelection {
  try {
    return normalizeEngineSelection(value ?? DEFAULT_ENGINE_SELECTION) as EngineSelection;
  } catch {
    return normalizeEngineSelection(DEFAULT_ENGINE_SELECTION) as EngineSelection;
  }
}

/**
 * Catalog view for clients (`/api/live-config.captionEngines`): every entry with
 * `available` = whether this server holds that provider's key. Booleans only -
 * key values never leave the server.
 */
export function captionEngineAvailability(environment: Readonly<Record<string, string | undefined>> = process.env): ReturnType<typeof captionEngineCatalogForClient> {
  return captionEngineCatalogForClient({
    hasApiKeys: { gemini: Boolean(environment.GEMINI_API_KEY), soniox: Boolean(environment.SONIOX_API_KEY) },
  });
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

/**
 * Same, but a cold console outage (store configured yet unreachable, nothing memoized) yields the
 * catalog default instead of throwing: engine defaults are advisory, and neither go-live
 * (`/api/live-config`) nor session creation may be blocked by the console being down.
 */
export async function resolveEngineDefaultsOrFallback(): Promise<EngineSelection> {
  try { return await resolveEngineDefaults(); }
  catch { return readStoredEngineDefaults(null); }
}

/** A fresh server lookup at each new session; an unavailable policy never changes providers. */
export async function resolveHostEngineAssignment(hostId: string): Promise<{ engine: EngineSelection; assignmentRevision: string }> {
  const assignment = await getConsoleStore().readHostVoiceAssignment(hostId);
  const engine = normalizeEngineSelection({
    stt: assignment.provider === "soniox"
      ? { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" }
      : { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: assignment.provider === "soniox"
      ? { provider: "soniox", model: "stt-rt-v5" }
      : { provider: "gemini", model: "gemini-3.6-flash" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  }) as EngineSelection;
  return { engine, assignmentRevision: assignment.revision };
}
