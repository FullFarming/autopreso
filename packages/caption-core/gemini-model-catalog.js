// Compatibility shim over caption-engine-catalog.js. Plan 2 replaces callers
// (gateway, webapp, electron) with the engine catalog and deletes this file.
import { CAPTION_ENGINE_CATALOG, DEFAULT_ENGINE_SELECTION, migrateLegacyEngineSelection } from "./caption-engine-catalog.js";

const sttModels = Object.freeze(CAPTION_ENGINE_CATALOG.stt.filter((entry) => entry.provider === "gemini").map((entry) => Object.freeze({ id: entry.model, label: entry.label })));
const summaryModels = Object.freeze(CAPTION_ENGINE_CATALOG.summary.map((entry) => Object.freeze({ id: entry.model, label: entry.label })));
export const GEMINI_MODEL_CATALOG = Object.freeze({ translation: sttModels, source: sttModels, summary: summaryModels });
export const DEFAULT_GEMINI_MODEL_SELECTION = Object.freeze({
  translation: DEFAULT_ENGINE_SELECTION.stt.model, source: DEFAULT_ENGINE_SELECTION.stt.model, summary: DEFAULT_ENGINE_SELECTION.summary.model,
});
export class GeminiModelSelectionError extends Error {
  constructor(message = "지원하지 않는 모델입니다. 설정에서 모델을 다시 선택해 주세요.") {
    super(message);
    this.code = "INVALID_GEMINI_MODEL_SELECTION";
  }
}
const allowed = (role) => (role === "summary" ? summaryModels : sttModels).map((entry) => entry.id);
export function readGeminiSelectedModel(role, value) {
  if (!["source", "summary", "translation"].includes(role)) throw new GeminiModelSelectionError();
  if (value === undefined) return DEFAULT_GEMINI_MODEL_SELECTION[role];
  if (typeof value === "string" && allowed(role).includes(value)) return value;
  throw new GeminiModelSelectionError();
}
/** Historical metadata is evidence of the old model, not a runtime override.
 *  Each role accepts only the ids that role ever stored: a flash id was never
 *  a source (STT) model, so it is refused there instead of migrating silently. */
export function readStoredGeminiModelSelection(role, value) {
  if (role === "source") {
    if (["gemini-3.5-transcribe-live", "gemini-3.5-live-translate-preview"].includes(value)) return value;
    throw new GeminiModelSelectionError();
  }
  if (role === "summary" && ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"].includes(value)) return value;
  throw new GeminiModelSelectionError();
}
export function migrateLegacyGeminiModelSelection(role, value) {
  if (role === "source" || role === "translation") {
    return migrateLegacyEngineSelection({ geminiTranscribeModel: value }).stt.model;
  }
  if (role === "summary") return migrateLegacyEngineSelection({ geminiSummaryModel: value }).summary.model;
  throw new GeminiModelSelectionError();
}
