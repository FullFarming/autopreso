import { localTermRetrievalContract } from "./local-term-retrieval.js";
import { CAPTION_LANGUAGE_CODES, normalizeCaptionLanguage } from "./languages.js";
import { captionPolishContract } from "./polish-policy.js";
import { GEMINI_ENGINE_SELECTION, migrateLegacyEngineSelection, normalizeEngineSelection } from "./caption-engine-catalog.js";

const MAX_GLOSSARY_CHARACTERS = localTermRetrievalContract.maximumGlossaryCharacters;
const MAX_DOMAIN_CHARACTERS = 2_000;
const MAX_PRESET_ID_CHARACTERS = 128;
const MAX_PRESET_NAME_CHARACTERS = 80;
const DEFAULT_TRANSCRIPTION_MODEL = GEMINI_ENGINE_SELECTION.stt.model;
const DEFAULT_POLISH_MODEL = "gemini-3.7-flash";
const DEFAULT_ANALYSIS_MODEL = GEMINI_ENGINE_SELECTION.summary.model;
const DEFAULT_PARTIAL_STABILITY_MILLISECONDS = 140;
const DEFAULT_PARTIAL_MAX_HOLD_MILLISECONDS = 500;
const DEFAULT_COMMIT_SILENCE_MILLISECONDS = 1_200;
const DEFAULT_INPUT_SAMPLE_RATE = 16_000;
const VALID_POLISH_POLICIES = new Set(["off", "selective", "full"]);

export const GEMINI_WORKLOAD_MODEL_MATRIX = deepFreeze({
  transcription: DEFAULT_TRANSCRIPTION_MODEL,
  source: DEFAULT_TRANSCRIPTION_MODEL,
  glossaryExtraction: DEFAULT_POLISH_MODEL,
  topic: DEFAULT_ANALYSIS_MODEL,
  translation: GEMINI_ENGINE_SELECTION.translation.model,
  polish: DEFAULT_POLISH_MODEL,
  recap: DEFAULT_ANALYSIS_MODEL,
});

export const GEMINI_CAPTION_ENGINE_CONTRACT = deepFreeze({
  version: 5,
  provider: "gemini",
  voiceProvider: null,
  workloadModels: GEMINI_WORKLOAD_MODEL_MATRIX,
  maximumGlossaryCharacters: MAX_GLOSSARY_CHARACTERS,
  maximumDomainCharacters: MAX_DOMAIN_CHARACTERS,
  transcription: {
    model: DEFAULT_TRANSCRIPTION_MODEL,
    responseModalities: ["TEXT"],
    interimField: "interimInputTranscription",
    authoritativeField: "inputTranscription",
    inputMimeType: "audio/pcm;rate=16000",
  },
  retrieval: {
    engine: "local-session-index",
    maximumPromptCharacters: localTermRetrievalContract.maximumPromptCharacters,
    maximumResultLines: localTermRetrievalContract.maximumResultLines,
    fuzzyMinimumSimilarity: localTermRetrievalContract.fuzzyMinimumSimilarity,
  },
  polish: {
    provider: "gemini",
    committedOnly: true,
    failOpenToGeminiDraft: true,
    timeoutMilliseconds: captionPolishContract.timeoutMilliseconds,
    maximumSelectedGlossaryCharacters: captionPolishContract.maximumSelectedGlossaryCharacters,
    maximumMatchedGlossaryLines: captionPolishContract.maximumMatchedGlossaryLines,
  },
  deterministic: {
    committedOnly: true,
    fullGlossary: true,
    bidirectionalPairs: true,
  },
  fallback: {
    translationProvider: null,
    voiceProvider: null,
  },
  streaming: {
    inputSampleRate: DEFAULT_INPUT_SAMPLE_RATE,
    partialStabilityMilliseconds: DEFAULT_PARTIAL_STABILITY_MILLISECONDS,
    partialMaximumHoldMilliseconds: DEFAULT_PARTIAL_MAX_HOLD_MILLISECONDS,
    commitSilenceMilliseconds: DEFAULT_COMMIT_SILENCE_MILLISECONDS,
  },
});

/**
 * Canonical, immutable configuration shared by Caption Only and Live Call.
 * Desktop and gateway field aliases are accepted at this single boundary;
 * downstream code reads only the canonical names.
 */
export function createGeminiCaptionConfig(input = {}) {
  assertAllowedModelInput(input);
  const engine = input.engine !== undefined
    ? normalizeEngineSelection(input.engine)
    : migrateLegacyEngineSelection({
      geminiTranscribeModel: input.geminiTranscribeModel ?? input.transcriptionModel ?? input.transcribeModel ?? input.models?.transcription,
      geminiSummaryModel: input.geminiSummaryModel ?? input.summaryModel ?? input.models?.summary,
      geminiPolishModel: input.geminiPolishModel ?? input.polishModel ?? input.models?.polish,
    });
  const glossary = normalizedBoundedString(
    input.glossary ?? input.glossaryText,
    MAX_GLOSSARY_CHARACTERS,
    "GLOSSARY_TOO_LARGE",
  );
  const domain = normalizedBoundedString(
    input.translationDomain ?? input.domainText ?? input.domain,
    MAX_DOMAIN_CHARACTERS,
    "DOMAIN_TOO_LARGE",
  );
  const languages = normalizeLanguages(input.translationLanguages ?? input.languages);
  const tone = ["natural", "business"].includes(input.tone ?? input.translationTone)
    ? (input.tone ?? input.translationTone)
    : "natural";
  const requestedPolishPolicy = input.captionPolishPolicy ?? input.polishPolicy?.mode;
  const polishPolicy = VALID_POLISH_POLICIES.has(requestedPolishPolicy)
    ? requestedPolishPolicy
    : "selective";
  const config = {
    contractVersion: GEMINI_CAPTION_ENGINE_CONTRACT.version,
    provider: GEMINI_CAPTION_ENGINE_CONTRACT.provider,
    voiceProvider: GEMINI_CAPTION_ENGINE_CONTRACT.voiceProvider,
    outputMode: normalizeOutputMode(input.outputMode),
    engine,
    models: {
      transcription: engine.stt.model,
      summary: engine.summary.model,
      polish: fixedModel(input.geminiPolishModel ?? input.polishModel ?? input.models?.polish, DEFAULT_POLISH_MODEL),
    },
    preset: {
      id: boundedMetadata(input.glossaryPresetId ?? input.presetId ?? input.glossaryPack ?? input.preset?.id, MAX_PRESET_ID_CHARACTERS),
      name: boundedMetadata(input.glossaryPresetName ?? input.presetName ?? input.preset?.name, MAX_PRESET_NAME_CHARACTERS),
    },
    glossary,
    domain,
    tone,
    languages,
    directions: buildDirections(languages),
    retrievalPolicy: { ...GEMINI_CAPTION_ENGINE_CONTRACT.retrieval },
    polishPolicy: {
      ...GEMINI_CAPTION_ENGINE_CONTRACT.polish,
      mode: polishPolicy,
    },
    deterministicPolicy: { ...GEMINI_CAPTION_ENGINE_CONTRACT.deterministic },
    fallbackPolicy: { ...GEMINI_CAPTION_ENGINE_CONTRACT.fallback },
    streamingPolicy: {
      inputSampleRate: positiveInteger(input.inputSampleRate ?? input.streamingPolicy?.inputSampleRate, DEFAULT_INPUT_SAMPLE_RATE),
      partialStabilityMilliseconds: positiveInteger(input.partialStabilityMilliseconds ?? input.streamingPolicy?.partialStabilityMilliseconds, DEFAULT_PARTIAL_STABILITY_MILLISECONDS),
      partialMaximumHoldMilliseconds: positiveInteger(input.partialMaximumHoldMilliseconds ?? input.streamingPolicy?.partialMaximumHoldMilliseconds, DEFAULT_PARTIAL_MAX_HOLD_MILLISECONDS),
      commitSilenceMilliseconds: positiveInteger(input.commitSilenceMilliseconds ?? input.streamingPolicy?.commitSilenceMilliseconds, DEFAULT_COMMIT_SILENCE_MILLISECONDS),
    },
  };
  return deepFreeze(config);
}

function assertAllowedModelInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_GEMINI_CAPTION_CONFIG");
  if (Object.hasOwn(input, "model") && typeof input.model !== "string") throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
  if (input.models !== undefined && (!input.models || typeof input.models !== "object" || Array.isArray(input.models)
    || Object.keys(input.models).some((key) => !["transcription", "polish", "summary"].includes(key)))) {
    throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
  }
  if (input.engine !== undefined && (!input.engine || typeof input.engine !== "object")) throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
  for (const key of ["topicModel", "translationModel", "recapModel", "geminiTextModel"]) {
    if (Object.hasOwn(input, key)) throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
  }
}

export function geminiCaptionConfigFingerprint(configOrInput = {}) {
  const config = isCanonicalConfig(configOrInput) ? configOrInput : createGeminiCaptionConfig(configOrInput);
  const serialized = stableSerialize(config);
  // FNV-1a 64-bit is deterministic in both Electron and the gateway without a
  // runtime-specific crypto dependency. This is an identity check, not a secret.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(serialized)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `gemini-caption-v${config.contractVersion}-${hash.toString(16).padStart(16, "0")}`;
}

function normalizeLanguages(value) {
  const languages = Array.from(new Set((Array.isArray(value) ? value : ["en", "ko"])
    .map(normalizeCaptionLanguage)
    .filter((language) => CAPTION_LANGUAGE_CODES.includes(language))));
  if (languages.length < 1 || languages.length > 3) throw new Error("INVALID_CAPTION_LANGUAGES");
  return languages;
}

function buildDirections(languages) {
  return languages.flatMap((sourceLanguage) => languages
    .filter((targetLanguage) => targetLanguage !== sourceLanguage)
    .map((targetLanguage) => ({ sourceLanguage, targetLanguage })));
}

function normalizeOutputMode(value) {
  return "captions";
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizedBoundedString(value, maximumCharacters, errorCode) {
  const normalized = String(value ?? "").normalize("NFC").trim();
  if (normalized.length > maximumCharacters) throw new Error(errorCode);
  return normalized;
}

function boundedMetadata(value, maximumCharacters) {
  return String(value ?? "").normalize("NFC").trim().slice(0, maximumCharacters);
}

function fixedModel(value, fallback) {
  const normalized = String(value ?? "").trim();
  if (normalized && normalized !== fallback) throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
  return fallback;
}

export function redactGeminiSensitiveText(value) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFC");
  if (/^\s*\d{6}\s*$/u.test(normalized)) return "[CODE]";
  return normalized
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, "[URL]")
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, "[EMAIL]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[TOKEN]")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, "[UUID]")
    .replace(/\bgrant(?:[_:-][A-Za-z0-9_-]+)+\b/giu, "[GRANT]")
    .replace(/(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/gu, "[TOKEN]")
    .replace(/\b[A-Za-z0-9_-]{43,}\b/gu, "[TOKEN]")
    .replace(/(?<![A-Za-z0-9_-])(?:code|access|invite)(?:\s+code)?\s*[:#-]?\s*\d{6}\b/giu, "[CODE]")
    .replace(/(?:인증(?:\s*코드)?|초대(?:\s*코드)?|참여\s*코드)\s*[:#-]?\s*\d{6}/gu, "[CODE]");
}

function isCanonicalConfig(value) {
  return value?.contractVersion === GEMINI_CAPTION_ENGINE_CONTRACT.version
    && value?.provider === "gemini"
    && Array.isArray(value?.directions);
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
