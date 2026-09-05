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

/**
 * Why an entry exists: `admin` — an admin (webapp PATCH or the console RPC)
 * chose this engine; `server-default` — a non-admin's request was replaced by
 * the global engine (spec §9). Optional on read: rows written before Task 4
 * fix A carry no reason.
 */
export type EngineHistoryReason = "admin" | "server-default";
const ENGINE_HISTORY_REASONS: readonly EngineHistoryReason[] = ["admin", "server-default"];

/** One engine change on a session: who switched it to what, when, and why. */
export interface EngineHistoryEntry { engine: EngineSelection; changedAt: string; byHostId: string; reason?: EngineHistoryReason }

/**
 * `event_metadata.modelPreferences` (Plan 2 Task 4). The engine is the only
 * runtime selection; `engineHistory` is appended whenever the stored engine
 * changes (spec §9: the admin console deploys the global engine into running
 * sessions, and this is the audit trail Task 5 / Plan B Task 6 read).
 *
 * Contract: a stored `modelPreferences` is either absent (`undefined` →
 * catalog default) or an object. `modelPreferences: null` is malformed —
 * nothing ever writes it, so a reader must fail closed rather than default it.
 */
export interface LiveModelPreferences { engine: EngineSelection; engineHistory: EngineHistoryEntry[]; assignmentRevision?: string }

/** Client input shape: only the engine. History is server-owned. */
export interface LiveModelPreferencesInput { engine: EngineSelection }

/**
 * History cap on write. `live_sessions.event_metadata` is rejected above
 * 4096 bytes by the deployed `normalize_live_session_event_metadata`, and one
 * entry is ~300–390 bytes, so the cap alone cannot guarantee a fit: the store
 * additionally trims the serialized body to `EVENT_METADATA_BYTE_BUDGET`
 * (`fitEventMetadataToByteBudget`). The console RPC
 * `set_live_session_engine_admin_v1` applies the same two rules.
 */
export const MAX_ENGINE_HISTORY_ENTRIES = 8;
/** Serialized `p_event_metadata` bytes the store keeps under (headroom below the 4096 check). */
export const EVENT_METADATA_BYTE_BUDGET = 3800;
/** Read ceiling: rows written under the former 64-entry cap must still parse; the next write trims them. */
export const MAX_STORED_ENGINE_HISTORY_ENTRIES = 64;
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
  if (!Array.isArray(value) || value.length > MAX_STORED_ENGINE_HISTORY_ENTRIES) throw invalidEngine();
  return value.map((entry): EngineHistoryEntry => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["engine", "changedAt", "byHostId", "reason"].includes(key))) throw invalidEngine();
    const { changedAt, byHostId, reason } = entry;
    if (typeof changedAt !== "string" || !Number.isFinite(Date.parse(changedAt))
      || typeof byHostId !== "string" || byHostId.length < 1 || byHostId.length > MAX_HOST_ID_CHARACTERS) throw invalidEngine();
    if (reason !== undefined && !ENGINE_HISTORY_REASONS.includes(reason as EngineHistoryReason)) throw invalidEngine();
    const parsed: EngineHistoryEntry = { engine: toEngine(entry.engine), changedAt, byHostId };
    if (reason !== undefined) parsed.reason = reason as EngineHistoryReason;
    return parsed;
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
  if (!keys.includes("engine") || keys.some((key) => key !== "engine" && key !== "engineHistory" && key !== "assignmentRevision")) throw invalidEngine();
  const revision = value.assignmentRevision;
  if (revision !== undefined && (typeof revision !== "string" || !/^[1-9][0-9]{0,18}$/u.test(revision))) throw invalidEngine();
  return { engine: toEngine(value.engine), engineHistory: readEngineHistory(value.engineHistory), ...(revision === undefined ? {} : { assignmentRevision: revision }) };
}

/**
 * Applies an engine to stored preferences. An unchanged engine keeps the
 * history as is; a change appends one entry and keeps the newest
 * `MAX_ENGINE_HISTORY_ENTRIES`. The byte budget is enforced by the store on
 * the full serialized body (`fitEventMetadataToByteBudget`).
 */
export function applyEngineSelection(
  current: LiveModelPreferences,
  engine: EngineSelection,
  change: { changedAt: string; byHostId: string; reason: EngineHistoryReason },
): LiveModelPreferences {
  if (isSameEngineSelection(current.engine, engine)) return { ...current, engine: current.engine, engineHistory: [...current.engineHistory] };
  const entry: EngineHistoryEntry = { engine, changedAt: change.changedAt, byHostId: change.byHostId, reason: change.reason };
  return { engine, engineHistory: [...current.engineHistory, entry].slice(-MAX_ENGINE_HISTORY_ENTRIES) };
}

/**
 * The `p_event_metadata` body as it goes over the wire (ticker / eventType /
 * agenda / modelPreferences plus any foreign keys already stored on the row).
 * Drops the oldest `engineHistory` entries — never anything else — until the
 * serialized body is within `EVENT_METADATA_BYTE_BUDGET`. Bodies that already
 * fit are returned as given.
 */
export function fitEventMetadataToByteBudget<T extends Record<string, unknown>>(body: T, budget = EVENT_METADATA_BYTE_BUDGET): T {
  const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (byteLength(body) <= budget) return body;
  const preferences = body.modelPreferences;
  if (!isRecord(preferences) || !Array.isArray(preferences.engineHistory)) return body;
  let history = preferences.engineHistory.slice(-MAX_ENGINE_HISTORY_ENTRIES);
  let fitted: T = { ...body, modelPreferences: { ...preferences, engineHistory: history } };
  while (history.length > 0 && byteLength(fitted) > budget) {
    history = history.slice(1);
    fitted = { ...body, modelPreferences: { ...preferences, engineHistory: history } };
  }
  return fitted;
}
