/**
 * Single source of truth for caption engine providers and models.
 * Desktop, gateway, and webapp all read this; nothing else may hard-code a
 * provider/model pair. Capabilities describe what the API contract allows,
 * not measured quality.
 */
export const ENGINE_ROLES = Object.freeze(["stt", "translation", "summary"]);
export const LANGUAGE_MODES = Object.freeze(["auto", "ko", "en"]);

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

const GEMINI_TRANSCRIBE = {
  provider: "gemini", model: "gemini-3.5-transcribe-live", label: "Gemini 3.5 Transcribe Live", requiredApiKey: "gemini",
  capability: { canRestrictSource: false, combinedSttTranslation: false, maxSessionMs: 600_000, vocabularyLimit: 1_000, languageModes: ["auto"] },
};
const SONIOX_RT = {
  provider: "soniox", model: "stt-rt-v5", label: "Soniox stt-rt-v5", requiredApiKey: "soniox",
  capability: { canRestrictSource: true, combinedSttTranslation: true, maxSessionMs: 18_000_000, vocabularyLimit: 10_000, languageModes: ["auto", "ko", "en"] },
};
const flash = (model, label, fallbackModels) => ({
  provider: "gemini", model, label, requiredApiKey: "gemini", fallbackModels,
  capability: { canRestrictSource: false, combinedSttTranslation: false, maxSessionMs: 0, vocabularyLimit: 0, languageModes: [] },
});

export const CAPTION_ENGINE_CATALOG = deepFreeze({
  stt: [GEMINI_TRANSCRIBE, SONIOX_RT],
  translation: [
    flash("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", ["gemini-3.6-flash"]),
    flash("gemini-3.6-flash", "Gemini 3.6 Flash", ["gemini-3.5-flash-lite"]),
    flash("gemini-3.7-flash", "Gemini 3.7 Flash", ["gemini-3.6-flash", "gemini-3.5-flash-lite"]),
    { ...SONIOX_RT, label: "Soniox stt-rt-v5 (STT 결합)", requiresSttProvider: "soniox" },
  ],
  summary: [
    flash("gemini-3.6-flash", "Gemini 3.6 Flash", ["gemini-3.7-flash"]),
    flash("gemini-3.7-flash", "Gemini 3.7 Flash", ["gemini-3.6-flash"]),
  ],
});

export const DEFAULT_ENGINE_SELECTION = deepFreeze({
  stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
  translation: { provider: "gemini", model: "gemini-3.6-flash" },
  summary: { provider: "gemini", model: "gemini-3.6-flash" },
});

export class EngineSelectionError extends Error {
  constructor(message = "지원하지 않는 엔진 조합입니다. 설정에서 모델을 다시 선택해 주세요.") {
    super(message);
    this.name = "EngineSelectionError";
    this.code = "ENGINE_SELECTION_INVALID";
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function findEngineEntry(role, provider, model) {
  const entries = CAPTION_ENGINE_CATALOG[role];
  if (!entries) return null;
  return entries.find((entry) => entry.provider === provider && entry.model === model) ?? null;
}

function normalizeRole(role, value) {
  if (value === undefined) return DEFAULT_ENGINE_SELECTION[role];
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") throw new EngineSelectionError();
  const allowedKeys = role === "stt" ? ["provider", "model", "languageMode"] : ["provider", "model"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new EngineSelectionError();
  const entry = findEngineEntry(role, value.provider, value.model);
  if (!entry) throw new EngineSelectionError();
  if (role !== "stt") return { provider: entry.provider, model: entry.model };
  const languageMode = value.languageMode === undefined ? "auto" : value.languageMode;
  if (!LANGUAGE_MODES.includes(languageMode) || !entry.capability.languageModes.includes(languageMode)) throw new EngineSelectionError();
  return { provider: entry.provider, model: entry.model, languageMode };
}

/**
 * @param {unknown} input
 * @returns {{stt:{provider:string,model:string,languageMode:string},translation:{provider:string,model:string},summary:{provider:string,model:string}}}
 */
export function normalizeEngineSelection(input) {
  if (input === undefined || input === null) return DEFAULT_ENGINE_SELECTION;
  if (!isRecord(input) || Object.keys(input).some((key) => !ENGINE_ROLES.includes(key))) throw new EngineSelectionError();
  const record = /** @type {{stt?: unknown, translation?: unknown, summary?: unknown}} */ (input);
  const stt = normalizeRole("stt", record.stt);
  const translation = normalizeRole("translation", record.translation);
  const summary = normalizeRole("summary", record.summary);
  const translationEntry = findEngineEntry("translation", translation.provider, translation.model);
  if (translationEntry.requiresSttProvider && translationEntry.requiresSttProvider !== stt.provider) throw new EngineSelectionError();
  return deepFreeze({ stt, translation, summary });
}

const LEGACY_SOURCE_TO_STT = Object.freeze({
  "gemini-3.5-transcribe-live": "gemini-3.5-transcribe-live",
  "gemini-3.5-live-translate-preview": "gemini-3.5-transcribe-live",
});
const LEGACY_FLASH = Object.freeze(["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash"]);

/**
 * Historical settings stored per-role Gemini model ids. An explicit `engine`
 * always wins; otherwise known legacy values are mapped and unknown values
 * fall back to defaults (never to a paid path the user did not choose).
 */
export function migrateLegacyEngineSelection(input = {}) {
  if (!isRecord(input)) return DEFAULT_ENGINE_SELECTION;
  if (input.engine !== undefined) return normalizeEngineSelection(input.engine);
  const sttModel = LEGACY_SOURCE_TO_STT[input.geminiTranscribeModel] ?? DEFAULT_ENGINE_SELECTION.stt.model;
  const translationModel = LEGACY_FLASH.includes(input.geminiPolishModel) ? input.geminiPolishModel : DEFAULT_ENGINE_SELECTION.translation.model;
  const summaryModel = LEGACY_FLASH.includes(input.geminiSummaryModel) && input.geminiSummaryModel !== "gemini-3.5-flash-lite"
    ? input.geminiSummaryModel : DEFAULT_ENGINE_SELECTION.summary.model;
  return normalizeEngineSelection({
    stt: { provider: "gemini", model: sttModel, languageMode: "auto" },
    translation: { provider: "gemini", model: translationModel },
    summary: { provider: "gemini", model: summaryModel },
  });
}

export function isCombinedEngine(engine) {
  const selection = normalizeEngineSelection(engine);
  const entry = findEngineEntry("stt", selection.stt.provider, selection.stt.model);
  return Boolean(entry?.capability.combinedSttTranslation) && selection.translation.provider === selection.stt.provider;
}

export function engineRequiredApiKeys(engine) {
  const selection = normalizeEngineSelection(engine);
  const keys = [];
  for (const role of ENGINE_ROLES) {
    const key = findEngineEntry(role, selection[role].provider, selection[role].model).requiredApiKey;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function engineSelectionKey(engine) {
  const selection = normalizeEngineSelection(engine);
  return JSON.stringify({
    stt: [selection.stt.provider, selection.stt.model, selection.stt.languageMode],
    translation: [selection.translation.provider, selection.translation.model],
    summary: [selection.summary.provider, selection.summary.model],
  });
}

/** Settings UI payload: never includes key values, only availability. */
export function captionEngineCatalogForClient({ hasApiKeys = {} } = {}) {
  const view = {};
  for (const role of ENGINE_ROLES) {
    view[role] = CAPTION_ENGINE_CATALOG[role].map((entry) => ({
      provider: entry.provider, model: entry.model, label: entry.label, requiredApiKey: entry.requiredApiKey,
      available: hasApiKeys[entry.requiredApiKey] === true,
      languageModes: [...entry.capability.languageModes],
      ...(entry.requiresSttProvider ? { requiresSttProvider: entry.requiresSttProvider } : {}),
    }));
  }
  view.defaults = DEFAULT_ENGINE_SELECTION;
  return view;
}
