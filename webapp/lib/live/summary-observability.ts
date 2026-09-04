import { readGeminiSelectedModel } from "../../../packages/caption-core/gemini-model-catalog.js";
import type { EngineSelection } from "./model-preferences";

export interface GeminiSummaryMetricEvent {
  workload: "recap";
  model: EngineSelection["summary"]["model"];
  result: "ok" | "error";
  latencyMilliseconds: number;
  usageKnown: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

let lastGeminiSummaryMetric: GeminiSummaryMetricEvent | null = null;

export function recordGeminiSummaryMetric(event: unknown): void {
  const metric = parseGeminiSummaryMetric(event);
  if (!metric) return;
  lastGeminiSummaryMetric = metric;
}

export function getGeminiSummaryMetricSnapshotForTests(): GeminiSummaryMetricEvent | null {
  return lastGeminiSummaryMetric ? { ...lastGeminiSummaryMetric } : null;
}

export function resetGeminiSummaryMetricsForTests(): void {
  lastGeminiSummaryMetric = null;
}

function parseGeminiSummaryMetric(event: unknown): GeminiSummaryMetricEvent | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  if (!hasExactKeys(record, [
    "name", "workload", "model", "result", "latencyMilliseconds", "inputTokens", "outputTokens", "totalTokens",
    ...(Object.hasOwn(record, "usageKnown") ? ["usageKnown"] : []),
  ])) return null;
  if (record.name !== "live.summary.gemini"
    || record.workload !== "recap"
    || typeof record.model !== "string"
    || record.result !== "ok" && record.result !== "error"
    || record.usageKnown !== undefined && typeof record.usageKnown !== "boolean") return null;
  let model;
  try { model = readGeminiSelectedModel("summary", record.model); } catch { return null; }
  const latencyMilliseconds = safeMetricNumber(record.latencyMilliseconds);
  const usageKnown = record.usageKnown === true;
  const inputTokens = usageKnown ? safeTokenCount(record.inputTokens) : null;
  const outputTokens = usageKnown ? safeTokenCount(record.outputTokens) : null;
  const totalTokens = usageKnown ? safeTokenCount(record.totalTokens) : null;
  if (latencyMilliseconds === null || usageKnown && (inputTokens === null || outputTokens === null || totalTokens === null)) return null;
  return {
    workload: "recap",
    model,
    result: record.result,
    latencyMilliseconds,
    usageKnown,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function safeTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeMetricNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}
