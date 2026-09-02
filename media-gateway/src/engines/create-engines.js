/**
 * The only place that maps a catalog engine selection to gateway adapters.
 * `LiveMediaPipeline` consumes the results through its existing `speechToText`
 * and `textTranslate` dependency contracts; nothing else may pick a provider.
 */
import {
  engineRequiredApiKeys,
  findEngineEntry,
  isCombinedEngine,
  normalizeEngineSelection,
} from "../../../packages/caption-core/caption-engine-catalog.js";
import { GeminiLiveTranscriptionAdapter, GeminiTextTranslateAdapter } from "../google-provider-adapters.js";
import { SonioxRealtimeAdapter } from "./soniox-realtime-adapter.js";

const ENV_KEY_BY_PROVIDER_KEY = Object.freeze({ gemini: "GEMINI_API_KEY", soniox: "SONIOX_API_KEY" });

export { isCombinedEngine };

/** Catalog errors already carry code ENGINE_SELECTION_INVALID; surface that
 *  code as the message so `assert.throws(/ENGINE_SELECTION_INVALID/)` and the
 *  gateway's safe error identifiers both see one stable token. */
function normalizeOrThrow(engine) {
  try {
    return normalizeEngineSelection(engine);
  } catch (error) {
    if (error?.code === "ENGINE_SELECTION_INVALID") throw new Error("ENGINE_SELECTION_INVALID");
    throw error;
  }
}

/**
 * Rejects a selection whose provider key is absent from the environment before
 * any pipeline (or any paid connection) is created. Key values are only tested
 * for presence and never copied, logged, or returned.
 */
export function assertEngineKeys(engine, environment = process.env) {
  const selection = normalizeOrThrow(engine);
  for (const key of engineRequiredApiKeys(selection)) {
    const envName = ENV_KEY_BY_PROVIDER_KEY[key];
    if (!envName || !String(environment?.[envName] ?? "").trim()) throw new Error("ENGINE_KEY_MISSING");
  }
  return selection;
}

export function createSpeechToText({
  engine,
  liveClient,
  sonioxApiKey = "",
  languageCodes = [],
  compiledGlossary = null,
  glossaryText = "",
  domainText = "",
  translationLanguages = [],
}) {
  const selection = normalizeOrThrow(engine);
  if (selection.stt.provider === "gemini") {
    return new GeminiLiveTranscriptionAdapter({ client: liveClient, model: selection.stt.model, languageCodes, compiledGlossary });
  }
  if (selection.stt.provider === "soniox") {
    if (!String(sonioxApiKey ?? "").trim()) throw new Error("ENGINE_KEY_MISSING");
    return new SonioxRealtimeAdapter({
      apiKey: sonioxApiKey,
      languageMode: selection.stt.languageMode,
      translation: isCombinedEngine(selection),
      translationLanguages,
      glossaryText,
      domainText,
    });
  }
  throw new Error("ENGINE_SELECTION_INVALID");
}

/**
 * Returns `null` for a combined engine: the STT adapter then owns translation
 * and the pipeline skips its text-translation step.
 */
export function createTextTranslate({ engine, geminiRuntime, sessionId }) {
  const selection = normalizeOrThrow(engine);
  if (isCombinedEngine(selection)) return null;
  if (selection.translation.provider !== "gemini") throw new Error("ENGINE_SELECTION_INVALID");
  const entry = findEngineEntry("translation", "gemini", selection.translation.model);
  const fallbackModels = [...(entry?.fallbackModels ?? [])];
  // The session runtime rejects a `model` field on generateContent requests, so
  // every model in the chain is bound to its own session client here.
  return new GeminiTextTranslateAdapter({
    client: geminiRuntime.createSessionClient(sessionId, "translation", { model: selection.translation.model }),
    model: selection.translation.model,
    fallbackModels,
    fallbackClients: fallbackModels.map((model) => geminiRuntime.createSessionClient(sessionId, "translation", { model })),
  });
}
