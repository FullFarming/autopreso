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
  validateEngineForLanguages,
} from "../../../packages/caption-core/caption-engine-catalog.js";
import { GeminiLiveTranscriptionAdapter, GeminiTextTranslateAdapter } from "../google-provider-adapters.js";
import { SonioxFanoutAdapter } from "./soniox-fanout-adapter.js";
import { SonioxRealtimeAdapter } from "./soniox-realtime-adapter.js";

const ENV_KEY_BY_PROVIDER_KEY = Object.freeze({ gemini: "GEMINI_API_KEY", soniox: "SONIOX_API_KEY" });

export { isCombinedEngine };

/** Every factory error is a stable token in BOTH `message` and `code`: the
 *  message keeps `assert.throws(/CODE/)` and safe log identifiers working, and
 *  gateway-server maps `.code` to a client-facing rejection. */
function codedError(code) {
  return Object.assign(new Error(code), { code });
}

/** The catalog's EngineSelectionError carries a Korean UI message; re-key it to
 *  the machine token here so the gateway never has to parse prose. */
function normalizeOrThrow(engine) {
  try {
    return normalizeEngineSelection(engine);
  } catch (error) {
    if (error?.code === "ENGINE_SELECTION_INVALID") throw codedError("ENGINE_SELECTION_INVALID");
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
    if (!envName || !String(environment?.[envName] ?? "").trim()) throw codedError("ENGINE_KEY_MISSING");
  }
  return selection;
}

/**
 * Rejects unsupported language selections before any adapter exists.
 * The settings store enforces the same rule at save time; this is the gateway's
 * own check so a stale or forged session config cannot dead-end at the socket.
 */
export function assertEngineForLanguages(engine, translationLanguages) {
  try {
    return validateEngineForLanguages(engine, translationLanguages);
  } catch (error) {
    if (error?.code === "ENGINE_SELECTION_INVALID") throw codedError("ENGINE_SELECTION_INVALID");
    throw error;
  }
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
    if (!String(sonioxApiKey ?? "").trim()) throw codedError("ENGINE_KEY_MISSING");
    const Adapter = isCombinedEngine(selection) && translationLanguages.length === 3 ? SonioxFanoutAdapter : SonioxRealtimeAdapter;
    return new Adapter({
      apiKey: sonioxApiKey,
      languageMode: selection.stt.languageMode,
      translation: isCombinedEngine(selection),
      translationLanguages,
      glossaryText,
      domainText,
    });
  }
  throw codedError("ENGINE_SELECTION_INVALID");
}

/**
 * Returns `null` for a combined engine: the STT adapter then owns translation
 * and the pipeline skips its text-translation step.
 */
export function createTextTranslate({ engine, geminiRuntime, sessionId }) {
  const selection = normalizeOrThrow(engine);
  if (isCombinedEngine(selection)) return null;
  if (selection.translation.provider !== "gemini") throw codedError("ENGINE_SELECTION_INVALID");
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
