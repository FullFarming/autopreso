export type AiHealthState = "healthy" | "working" | "degraded" | "unavailable";
export type AiHealthId = "source" | "translation" | "topic" | "recap";

export interface AiHealthRow {
  id: AiHealthId;
  label: string;
  state: AiHealthState;
  stateLabel: string;
  actionLabel?: string;
  onAction?: () => void;
}

export type HostAiHealthRows = readonly [AiHealthRow, AiHealthRow, AiHealthRow, AiHealthRow];

const REQUIRED_HEALTH_IDS: readonly AiHealthId[] = ["source", "translation", "topic", "recap"];

export function validateHostAiHealthRows(rows: readonly AiHealthRow[]): HostAiHealthRows {
  const ids = new Set(rows.map((row) => row.id));
  const hasExactRows = rows.length === REQUIRED_HEALTH_IDS.length
    && REQUIRED_HEALTH_IDS.every((id) => ids.has(id));
  const hasAccessibleActions = rows.every((row) => Boolean(row.actionLabel?.trim()) === Boolean(row.onAction));
  if (!hasExactRows || !hasAccessibleActions) throw new Error("Host AI health rows are invalid.");
  return rows as HostAiHealthRows;
}
