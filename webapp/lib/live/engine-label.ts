import { findEngineEntry, isCombinedEngine, normalizeEngineSelection } from "../../../packages/caption-core/caption-engine-catalog.js";

/**
 * Human label for an engine selection, e.g. "Gemini 3.5 Transcribe Live · Gemini 3.6 Flash"
 * or just "Soniox stt-rt-v5" for a combined STT+translation engine. Client-safe:
 * depends on the catalog only. Unreadable input renders as an em dash instead of throwing.
 */
export function formatEngineLabel(engine: unknown): string {
  try {
    const selection = normalizeEngineSelection(engine);
    const label = (role: "stt" | "translation", entry: { provider: string; model: string }) =>
      findEngineEntry(role, entry.provider, entry.model)?.label ?? `${entry.provider} ${entry.model}`;
    const stt = label("stt", selection.stt);
    return isCombinedEngine(selection) ? stt : `${stt} · ${label("translation", selection.translation)}`;
  } catch {
    return "—";
  }
}
