import { z } from "zod";
import {
  engineSelectionKey,
  migrateLegacyEngineSelection,
  normalizeEngineSelection,
} from "../../../packages/caption-core/caption-engine-catalog.js";
import { readStoredGeminiModelSelection } from "../../../packages/caption-core/gemini-model-catalog.js";
import { LiveSessionError } from "./errors";

// Mirrors the shape `normalizeEngineSelection` returns (caption-engine-catalog.js):
// roles stt / translation / summary, only stt carries languageMode.
export interface EngineRoleSelection { provider: string; model: string }
export interface SttEngineSelection extends EngineRoleSelection { languageMode: string }
export interface EngineSelection { stt: SttEngineSelection; translation: EngineRoleSelection; summary: EngineRoleSelection }

/** One engine change on a session: who switched it to what, and when. */
export interface EngineHistoryEntry { engine: EngineSelection; changedAt: string; byHostId: string }

/**
 * `event_metadata.modelPreferences` (Plan 2 Task 4). The engine is the only
 * runtime selection; `engineHistory` is appended whenever the stored engine
 * changes (spec §9: the admin console deploys the global engine into running
 * sessions, and this is the audit trail Task 5 / Plan B Task 6 read).
 */
export interface LiveModelPreferences { engine: EngineSelection; engineHistory: EngineHistoryEntry[] }

/** Client input shape: only the engine. History is server-owned. */
export interface LiveModelPreferencesInput { engine: EngineSelection }

export const MAX_ENGINE_HISTORY_ENTRIES = 64;
const MAX_HOST_ID_CHARACTERS = 128;

function invalidEngine(): LiveSessionError {
  return new LiveSessionError("자막 엔진 선택이 올바르지 않습니다.", "INVALID_ENGINE_SELECTION", 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Catalog validation; `null`/`undefined` are NOT an engine here (the catalog would default them). */
function toEngine(value: unknown): EngineSelection {
  if (!isRecord(value)) throw invalidEngine();
  try {
    return normalizeEngineSelection(value) as EngineSelection;
  } catch {
    throw invalidEngine();
  }
}

export function defaultEngineSelection(): EngineSelection {
  return normalizeEngineSelection(undefined) as EngineSelection;
}

export function isSameEngineSelection(left: EngineSelection, right: EngineSelection): boolean {
  return engineSelectionKey(left) === engineSelectionKey(right);
}

function isKnownLegacyModel(role: "source" | "summary", value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return readStoredGeminiModelSelection(role, value) === value;
  } catch {
    return false;
  }
}

/** Pre-Plan-2 rows and old desktop builds stored per-role Gemini model ids. */
function migrateLegacyPreferences(source: string, summary: string): EngineSelection {
  return normalizeEngineSelection(migrateLegacyEngineSelection({ geminiTranscribeModel: source, geminiSummaryModel: summary })) as EngineSelection;
}

const engineInputSchema = z.record(z.string(), z.unknown()).transform((value, context) => {
  try {
    return toEngine(value);
  } catch {
    context.addIssue({ code: "custom", message: "자막 엔진 선택이 올바르지 않습니다." });
    return z.NEVER;
  }
});

const legacyModelSchema = (role: "source" | "summary") => z.string().max(80).refine((value) => isKnownLegacyModel(role, value));

// Old desktop builds still send `{ source, summary }`; they migrate to the
// engine they meant. Unknown ids are refused rather than silently defaulted.
const legacyInputSchema = z.object({ source: legacyModelSchema("source"), summary: legacyModelSchema("summary") }).strict()
  .transform(({ source, summary }): LiveModelPreferencesInput => ({ engine: migrateLegacyPreferences(source, summary) }));

export const liveModelPreferencesSchema = z.union([
  z.object({ engine: engineInputSchema }).strict(),
  legacyInputSchema,
]);

/** Client-supplied preferences for a new or edited session; `undefined` means the catalog default. */
export function readNewLiveModelPreferences(value: unknown): LiveModelPreferencesInput {
  if (value === undefined) return { engine: defaultEngineSelection() };
  const parsed = liveModelPreferencesSchema.safeParse(value);
  if (!parsed.success) throw invalidEngine();
  return parsed.data;
}

function readEngineHistory(value: unknown): EngineHistoryEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENGINE_HISTORY_ENTRIES) throw invalidEngine();
  return value.map((entry): EngineHistoryEntry => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["engine", "changedAt", "byHostId"].includes(key))) throw invalidEngine();
    const { changedAt, byHostId } = entry;
    if (typeof changedAt !== "string" || !Number.isFinite(Date.parse(changedAt))
      || typeof byHostId !== "string" || byHostId.length < 1 || byHostId.length > MAX_HOST_ID_CHARACTERS) throw invalidEngine();
    return { engine: toEngine(entry.engine), changedAt, byHostId };
  });
}

/**
 * Stored `modelPreferences`. Accepts the current `{ engine, engineHistory? }`
 * shape and the legacy `{ source, summary }` pin (read back as the migrated
 * engine with an empty history). Anything else fails closed.
 */
export function readLiveModelPreferences(value: unknown): LiveModelPreferences {
  if (value === undefined) return { engine: defaultEngineSelection(), engineHistory: [] };
  if (!isRecord(value)) throw invalidEngine();
  const keys = Object.keys(value);
  if (keys.length === 2 && keys.includes("source") && keys.includes("summary")) {
    if (!isKnownLegacyModel("source", value.source) || !isKnownLegacyModel("summary", value.summary)) throw invalidEngine();
    return { engine: migrateLegacyPreferences(value.source, value.summary), engineHistory: [] };
  }
  if (!keys.includes("engine") || keys.some((key) => key !== "engine" && key !== "engineHistory")) throw invalidEngine();
  return { engine: toEngine(value.engine), engineHistory: readEngineHistory(value.engineHistory) };
}

/**
 * Applies an engine to stored preferences. An unchanged engine keeps the
 * history as is; a change appends one entry and keeps the newest
 * `MAX_ENGINE_HISTORY_ENTRIES`.
 */
export function applyEngineSelection(
  current: LiveModelPreferences,
  engine: EngineSelection,
  change: { changedAt: string; byHostId: string },
): LiveModelPreferences {
  if (isSameEngineSelection(current.engine, engine)) return { engine: current.engine, engineHistory: [...current.engineHistory] };
  const entry: EngineHistoryEntry = { engine, changedAt: change.changedAt, byHostId: change.byHostId };
  return { engine, engineHistory: [...current.engineHistory, entry].slice(-MAX_ENGINE_HISTORY_ENTRIES) };
}
