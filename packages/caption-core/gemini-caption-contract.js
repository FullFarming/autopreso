import { localTermRetrievalContract } from "./local-term-retrieval.js";
import { CAPTION_LANGUAGE_CODES, normalizeCaptionLanguage } from "./languages.js";
import { captionPolishContract } from "./polish-policy.js";

const MAX_GLOSSARY_CHARACTERS = localTermRetrievalContract.maximumGlossaryCharacters;
const MAX_DOMAIN_CHARACTERS = 2_000;
const MAX_PRESET_ID_CHARACTERS = 128;
const MAX_PRESET_NAME_CHARACTERS = 80;
const DEFAULT_LIVE_MODEL = "gemini-3.5-live-translate-preview";
const DEFAULT_POLISH_MODEL = "gemini-3.6-flash";
const DEFAULT_PARTIAL_STABILITY_MILLISECONDS = 140;
const DEFAULT_PARTIAL_MAX_HOLD_MILLISECONDS = 500;
const DEFAULT_COMMIT_SILENCE_MILLISECONDS = 1_200;
const DEFAULT_INPUT_SAMPLE_RATE = 16_000;
const DEFAULT_OUTPUT_SAMPLE_RATE = 24_000;
const VALID_POLISH_POLICIES = new Set(["off", "selective", "full"]);

export const GEMINI_CAPTION_ENGINE_CONTRACT = deepFreeze({
  version: 1,
  provider: "gemini",
  voiceProvider: "gemini",
  maximumGlossaryCharacters: MAX_GLOSSARY_CHARACTERS,
  maximumDomainCharacters: MAX_DOMAIN_CHARACTERS,
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
    outputSampleRate: DEFAULT_OUTPUT_SAMPLE_RATE,
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
    audioLanguage: normalizeAudioLanguage(input.audioLanguage, languages),
    models: {
      live: normalizedModel(input.geminiModel ?? input.liveModel ?? input.models?.live, DEFAULT_LIVE_MODEL),
      polish: normalizedModel(input.geminiPolishModel ?? input.polishModel ?? input.models?.polish, DEFAULT_POLISH_MODEL),
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
      outputSampleRate: positiveInteger(input.outputSampleRate ?? input.streamingPolicy?.outputSampleRate, DEFAULT_OUTPUT_SAMPLE_RATE),
      partialStabilityMilliseconds: positiveInteger(input.partialStabilityMilliseconds ?? input.streamingPolicy?.partialStabilityMilliseconds, DEFAULT_PARTIAL_STABILITY_MILLISECONDS),
      partialMaximumHoldMilliseconds: positiveInteger(input.partialMaximumHoldMilliseconds ?? input.streamingPolicy?.partialMaximumHoldMilliseconds, DEFAULT_PARTIAL_MAX_HOLD_MILLISECONDS),
      commitSilenceMilliseconds: positiveInteger(input.commitSilenceMilliseconds ?? input.streamingPolicy?.commitSilenceMilliseconds, DEFAULT_COMMIT_SILENCE_MILLISECONDS),
    },
  };
  return deepFreeze(config);
}

export function geminiCaptionConfigFingerprint(configOrInput = {}) {
  const config = isCanonicalConfig(configOrInput)
    ? configOrInput
    : createGeminiCaptionConfig(configOrInput);
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
  if (value === "audio" || value === "captions_audio") return value;
  return "captions";
}

function normalizeAudioLanguage(value, languages) {
  const language = normalizeCaptionLanguage(value);
  return languages.includes(language) ? language : languages[0];
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

function normalizedModel(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
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
