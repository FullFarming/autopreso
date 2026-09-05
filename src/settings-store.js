import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_GLOSSARY_PRESET_ID, GLOSSARY_PRESETS } from "./glossary-presets.js";
import { MAX_TRANSLATION_LANGUAGES, isSupportedSubtitleLanguage } from "./subtitle-languages.js";
import {
  DEFAULT_ENGINE_SELECTION,
  ENGINE_ROLES,
  engineSelectionKey,
  migrateLegacyEngineSelection,
  normalizeEngineSelection,
  validateEngineForLanguages,
} from "../packages/caption-core/caption-engine-catalog.js";


const DEFAULT_GLOSSARY_PRESET = GLOSSARY_PRESETS.find((preset) => preset.id === DEFAULT_GLOSSARY_PRESET_ID);
if (!DEFAULT_GLOSSARY_PRESET) throw new Error("Default glossary preset is missing.");
const BUILT_IN_GLOSSARY_IDS = new Set([
  "common_business", "ai_ax", "commercial_real_estate", "hospitality", "fnb_retail", "proper_nouns", "ko_ja_idioms",
]);
const GLOSSARY_PRESET_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Exact released defaults advance to the current full corpus. Matching both
// fields protects user-owned Custom text, while upgrading the previously
// focused presets ensures existing installs receive the restored terminology.
const LEGACY_DEFAULT_PRESET_FINGERPRINTS = Object.freeze([
  Object.freeze({
    glossary: "c60af3a907b01188a3ab6345d84d3ee2f27ce332af51ec0e6e230b270213561a",
    domain: "923ae9ab0dee73f2668e10ede1dd44d84f532c51bac39bf260568ad6437a277b",
  }),
  Object.freeze({
    glossary: "41ea50d2b39c30385192d59075ad69ffb921e45abb4dc02b722f2ded47649888",
    domain: "0554c8ec443eb21453209834e691e01d7f7c58c788827299929aeb0cc520dad4",
  }),
  Object.freeze({
    glossary: "563ab9e0966cf71073ab87ff43f4da9834f487d5c51a5747b5f953d0e295bf25",
    domain: "56a55879bb88fc3825e5a9b0bde0e13a54e04b795c0635a597ba84ab8c161897",
  }),
  Object.freeze({
    glossary: "fc870dbf9a375af759d4063eb446b81dd51836445719a37e6089506d4b767fd9",
    domain: "56a55879bb88fc3825e5a9b0bde0e13a54e04b795c0635a597ba84ab8c161897",
  }),
]);

export async function migrateSettingsFile({ fromPath, toPath }) {
  if (!fromPath || !toPath || fromPath === toPath) return;
  try {
    await fs.access(toPath);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  try {
    const legacySettings = await fs.readFile(fromPath, "utf8");
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.writeFile(toPath, legacySettings, { mode: 0o600 });
    try {
      await fs.chmod(toPath, 0o600);
    } catch {}
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export const DEFAULT_SUBTITLE_SETTINGS = Object.freeze({
  // 2026-08-22 비용 감사: system+mic 이중 캡처가 모든 유료 세션 비용을 2배로
  // 만들던 기본값. 행사 계약(마이크 또는 믹서 하나)과 정렬해 mic 단일이 기본.
  inputMode: "mic",
  micDeviceId: "",
  languagePair: { a: "en", b: "ko" },
  translationLanguages: ["en", "ko"],
  // Live Call publishes its own language set; [] means "inherit the subtitle
  // languages above" so existing settings files keep today's behavior.
  liveCallTranslationLanguages: [],
  outputMode: "captions",
  displayMode: "translation_only",
  showSourceText: false,
  translateAllLanguages: false,
  fontFamily: "Arial, Helvetica, sans-serif",
  translationFontSize: 38,
  sourceFontSize: 36,
  position: "bottom-center",
  // Per-language overlay position; a language falls back to `position` when
  // unset. Lets each translation language sit at its own spot (e.g. English
  // bottom, Japanese top) so simultaneous outputs don't overlap.
  subtitlePositions: { en: "bottom-center", ko: "bottom-center", ja: "top-center" },
  maxWidth: 1500,
  opacity: 0.92,
  maxSubtitleLines: 2,
  overlayEnabled: true,
  overlayDisplayId: "",
  overlayAllDisplays: true,
  overlayDisplayIds: null,
  recordProvider: "ollama",
  ollamaBaseURL: "http://127.0.0.1:11434",
  ollamaModel: "gemma3n:e2b",
  tone: "natural",
  tonePolishModel: "gpt-5.5",
  translationProvider: "gemini",
  engine: DEFAULT_ENGINE_SELECTION,
  glossaryPresetId: DEFAULT_GLOSSARY_PRESET_ID,
  glossaryPresetName: "",
  glossaries: Object.freeze([Object.freeze({ sourceKind: "builtin", sourceId: "common_business" })]),
  glossary: DEFAULT_GLOSSARY_PRESET.glossary,
  translationDomain: DEFAULT_GLOSSARY_PRESET.domain,
  verticalOffset: 48,
});

// 2026-07-27 fix: local settings written before the synchronized-preset feature
// legitimately exceed the remote preset's 16k storage cap. The gateway already
// accepts 40k and filters the polish prompt to relevant entries, so rejecting a
// 19k local glossary only bricked Live Call startup without reducing API work.
export const MAX_SUBTITLE_GLOSSARY_CHARS = 40_000;
// Local legacy domains may be more descriptive than synchronized preset
// metadata. Keep this aligned with the gateway's bounded 2k start contract.
export const MAX_SUBTITLE_DOMAIN_CHARS = 2_000;
export const MAX_SUBTITLE_VERTICAL_OFFSET = 600;
export const MAX_SUBTITLE_FONT_FAMILY_CHARS = 400;
export const MAX_API_KEY_CHARS = 500;
export const API_KEY_NAMES = Object.freeze(["openai", "gemini", "geminiSecondary", "soniox"]);

export const DEFAULT_SETTINGS = Object.freeze({
  apiKeys: {
    openai: "",
    gemini: "",
    geminiSecondary: "",
  },
  subtitle: DEFAULT_SUBTITLE_SETTINGS,
  subtitleHistory: {
    records: [],
  },
});

export function createSettingsStore({ filePath, env = process.env }) {
  let cached = null;
  let loadPromise = null;

  async function readFromDisk() {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const merged = deepMerge(cloneDefaults(), parsed);
      // deepMerge fills in the default `engine` even when the on-disk file never
      // had one, which would make migrateLegacyEngineSelection's "an explicit
      // engine always wins" rule silently mask legacy per-role model fields on
      // every disk load. Only carry `engine` into migration when the file itself
      // set it; otherwise let the legacy fields (or the true default) decide.
      if (isPlainObject(merged.subtitle) && !Object.hasOwn(parsed?.subtitle ?? {}, "engine")) {
        delete merged.subtitle.engine;
      }
      if (isPlainObject(merged.subtitle) && !Object.hasOwn(parsed?.subtitle ?? {}, "overlayAllDisplays") && parsed?.subtitle?.overlayDisplayId) {
        merged.subtitle.overlayAllDisplays = false;
      }
      const migrated = migrateSettings(merged);
      const legacyPresent = ["geminiTranscribeModel", "geminiSummaryModel", "geminiPolishModel", "geminiModel"].some((key) => Object.hasOwn(parsed?.subtitle ?? {}, key));
      let storedEngineKey;
      try {
        storedEngineKey = engineSelectionKey(parsed?.subtitle?.engine ?? DEFAULT_ENGINE_SELECTION);
      } catch {
        storedEngineKey = null;
      }
      if (legacyPresent || storedEngineKey !== engineSelectionKey(migrated.subtitle.engine)) {
        // The rewrite is an optimization: it stops the same migration running on
        // every boot. A read-only (or full) config directory must not turn
        // load() into a rejected promise — on the desktop that is no window, no
        // dialog, just a dock icon — so keep the migrated settings in memory.
        try {
          await writeToDisk(migrated);
        } catch {}
      }
      return migrated;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  // Writes are SERIALIZED (one at a time, in call order) and ATOMIC (temp file
  // + rename). save() is called concurrently at runtime — e.g. every committed
  // subtitle line persists history — and two interleaved fs.writeFile calls to
  // the same path can corrupt settings.json, which then fails to load and takes
  // the whole app down with it.
  let writeChain = Promise.resolve();
  function writeToDisk(settings) {
    const serialized = JSON.stringify(settings, null, 2);
    const run = async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, serialized, { mode: 0o600 });
      await fs.rename(tempPath, filePath);
      try {
        await fs.chmod(filePath, 0o600);
      } catch {}
    };
    writeChain = writeChain.then(run, run);
    return writeChain;
  }

  async function load() {
    if (cached) return cached;
    // 2026-09-01 fix: Concurrent first saves must merge against one initialized settings snapshot.
    if (!loadPromise) loadPromise = (async () => {
      const fromDisk = await readFromDisk();
      if (fromDisk) {
        cached = fromDisk;
        return cached;
      }
      const seeded = seedFromEnv(cloneDefaults(), env);
      await writeToDisk(seeded);
      cached = seeded;
      return cached;
    })();
    const pending = loadPromise;
    try { return await pending; }
    finally { if (loadPromise === pending) loadPromise = null; }
  }

  async function save(partial) {
    if (!cached) await load();
    if (!isPlainObject(partial) || Object.keys(partial).some((key) => !["apiKeys", "subtitle", "subtitleHistory"].includes(key))) {
      throw new Error("NOVA 설정 항목만 저장할 수 있습니다.");
    }
    // Shape-check the patch BEFORE merging. `"subtitle": []` used to slip
    // through here (an array is truthy, every field reads undefined so the
    // field validators all passed) and deepMerge preserved the array shape —
    // after which JSON.stringify dropped every string key, so the file kept
    // `"subtitle": []` and every later save silently no-opped forever.
    if (partial?.subtitle !== undefined && !isPlainObject(partial.subtitle)) {
      throw new Error("Subtitle settings must be a plain object.");
    }
    // A partial `engine` patch may only name the role the caller actually
    // changed (e.g. `{ translation: {...} }`). Validating that patch in
    // isolation would normalize the OMITTED roles to the Gemini defaults, and
    // a combo check (Soniox translation's requiresSttProvider) can then fail
    // against a phantom default stt role the caller never touched. Merge the
    // patch role-by-role over the CURRENTLY SAVED engine before any
    // validation or persistence sees it, so "change translation only" reads
    // as exactly that, not as "reset every other role to its default too."
    if (isPlainObject(partial?.subtitle) && isPlainObject(partial.subtitle.engine)) {
      partial = {
        ...partial,
        subtitle: {
          ...partial.subtitle,
          engine: mergeEnginePatch(cached.subtitle.engine, partial.subtitle.engine),
        },
      };
    }
    if (partial?.subtitle) validateSubtitleSettings(partial.subtitle);
    validateApiKeys(partial?.apiKeys);
    // fontFamily is checked against the RAW patch: migrateSettings self-heals a
    // non-string value on the way in (so an already-poisoned file still boots),
    // which would otherwise hide bad input from the validator below.
    if (partial?.subtitle?.fontFamily !== undefined) {
      validateSubtitleSettings({ fontFamily: partial.subtitle.fontFamily });
    }
    if (partial?.subtitle?.glossaryPresetId !== undefined) {
      validateSubtitleSettings({ glossaryPresetId: partial.subtitle.glossaryPresetId });
    }
    if (partial?.subtitle?.glossaryPresetName !== undefined) {
      validateSubtitleSettings({ glossaryPresetName: partial.subtitle.glossaryPresetName });
    }
    if (partial?.subtitle?.translationProvider !== undefined && partial.subtitle.translationProvider !== "gemini") {
      throw new Error("Subtitle translationProvider must remain gemini.");
    }
    const retiredSubtitleKeys = ["audioLanguage", "audioVolume", "voiceProvider", "model"];
    const retiredSubtitleKey = retiredSubtitleKeys.find((key) => partial?.subtitle?.[key] !== undefined);
    if (retiredSubtitleKey) {
      throw new Error(`Subtitle ${retiredSubtitleKey} is retired in caption-only mode.`);
    }
    // strictEngine: the load path repairs an unusable stored engine by falling
    // back to the catalog defaults (a corrupt file must still boot). On the save
    // path that same fallback silently threw away the user's whole engine choice
    // and still answered 200, so here an unusable merged engine is an error.
    const candidate = migrateSettings(deepMerge(cached, partial), { strictEngine: true });
    if (partial?.subtitle) validateSubtitleSettings(candidate.subtitle);
    // Capability constraints span two fields (Soniox two-way translation needs
    // exactly two caption languages), so they are checked against the MERGED
    // settings — either field may be the one the patch moved.
    validateEngineForLanguages(candidate.subtitle.engine, candidate.subtitle.translationLanguages);
    cached = candidate;
    await writeToDisk(cached);
    return cached;
  }

  async function getSanitized() {
    const settings = await load();
    const { apiKeys, ...rest } = settings;
    return {
      ...rest,
      hasOpenAIKey: Boolean(apiKeys?.openai),
      hasGeminiKey: Boolean(apiKeys?.gemini),
      hasGeminiSecondaryKey: Boolean(apiKeys?.geminiSecondary),
      hasSonioxKey: Boolean(apiKeys?.soniox),
    };
  }

  return { load, save, getSanitized };
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;
  // An object patch is NEVER merged into an array (or a primitive) target: the
  // array shape survived the merge, and JSON.stringify then dropped every
  // string key assigned to it. A settings file holding `"subtitle": []` turned
  // every subsequent save into a silent no-op that only a hand-edit could undo.
  // Discard the non-object target instead of writing keys nobody can persist.
  const result = { ...(isPlainObject(target) ? target : {}) };
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value)) {
      result[key] = deepMerge(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Merges a partial `subtitle.engine` patch over the CURRENTLY SAVED engine and
 * validates the result strictly.
 *
 * Two rules the plain deep merge got wrong:
 *  - roles are replaced whole, never field-merged. A patched `stt` used to
 *    inherit the saved `languageMode` ("ko") from a Soniox engine onto a Gemini
 *    engine that only allows "auto" — an invalid combo the save path then
 *    "repaired" by resetting every role to its default.
 *  - a patched `stt` that names the SAME provider/model without a languageMode
 *    is not a request to reset the input language, so the saved mode is kept.
 *
 * Unknown keys and non-object roles are passed through untouched so
 * normalizeEngineSelection rejects them instead of this function guessing.
 *
 * @param {Record<string, any>} savedEngine
 * @param {Record<string, any>} patchEngine
 */
function mergeEnginePatch(savedEngine, patchEngine) {
  const merged = { ...savedEngine, ...patchEngine };
  const patchedStt = patchEngine.stt;
  const savedStt = savedEngine?.stt;
  if (isPlainObject(patchedStt) && patchedStt.languageMode === undefined && isPlainObject(savedStt)
    && patchedStt.provider === savedStt.provider && patchedStt.model === savedStt.model
    && typeof savedStt.languageMode === "string") {
    merged.stt = { ...patchedStt, languageMode: savedStt.languageMode };
  }
  for (const role of ENGINE_ROLES) {
    if (isPlainObject(merged[role])) merged[role] = { ...merged[role] };
  }
  // Throws EngineSelectionError on an unusable combination; the fully
  // normalized result then replaces the saved engine role for role, so a stale
  // field (a languageMode from the previous provider) cannot survive the merge.
  return normalizeEngineSelection(merged);
}

function migrateSettings(settings, { strictEngine = false } = {}) {
  // 2026-09-05 fix: Imported settings must not carry the separate canvas agent's context.
  settings = {
    apiKeys: settings.apiKeys,
    subtitle: settings.subtitle,
    subtitleHistory: settings.subtitleHistory,
  };
  // A hand-edited, truncated, or half-written settings.json can hold
  // `"subtitle": null`, `"subtitle": []`, `"subtitle": "boom"`, or a number.
  // Every migration below assumed a plain object, so the very first assignment
  // threw `TypeError: Cannot set properties of null`, which rejected the
  // desktop app's boot promise — no window, no dialog, just a dock icon.
  // Anything that is not a plain object is unrecoverable data, so reset it.
  if (!isPlainObject(settings.subtitle)) {
    settings.subtitle = JSON.parse(JSON.stringify(DEFAULT_SUBTITLE_SETTINGS));
  }
  if (isPlainObject(settings.apiKeys)) {
    settings.apiKeys = Object.fromEntries(
      Object.entries(settings.apiKeys).filter(([name]) => name !== "openaiSecondary"),
    );
  }
  // Self-heal a fontFamily that an earlier unvalidated save turned into an
  // object/array: deepMerge spread the default string into per-index keys
  // ({"0":"A","1":"r",...}) that later reached setProperty("--subtitle-font-family").
  if (typeof settings.subtitle.fontFamily !== "string") {
    settings.subtitle.fontFamily = DEFAULT_SUBTITLE_SETTINGS.fontFamily;
  }
  migrateGlossaryPresetSelection(settings.subtitle);
  if (!isValidGlossarySelections(settings.subtitle.glossaries)) {
    settings.subtitle.glossaries = DEFAULT_SUBTITLE_SETTINGS.glossaries.map((glossary) => ({ ...glossary }));
  }
  settings.subtitle.translationProvider = "gemini";
  settings.subtitle.outputMode = "captions";
  // 2026-09-02: per-role Gemini model fields are replaced by the engine catalog selection.
  let engine;
  const legacyEngineInput = {
    engine: settings.subtitle.engine,
    geminiTranscribeModel: settings.subtitle.geminiTranscribeModel,
    geminiSummaryModel: settings.subtitle.geminiSummaryModel,
    geminiPolishModel: settings.subtitle.geminiPolishModel,
  };
  if (strictEngine) engine = migrateLegacyEngineSelection(legacyEngineInput);
  else {
    try {
      engine = migrateLegacyEngineSelection(legacyEngineInput);
    } catch {
      engine = DEFAULT_ENGINE_SELECTION;
    }
  }
  settings.subtitle.engine = engine;
  // `engineDefaultsSeen` (852c486) is retired by spec §9: the Live Call engine
  // is the admin's global value and the desktop never remembers it.
  for (const retiredKey of ["geminiTranscribeModel", "geminiSummaryModel", "geminiPolishModel", "audioLanguage", "audioVolume", "voiceProvider", "model", "geminiModel", "engineDefaultsSeen"]) {
    delete settings.subtitle[retiredKey];
  }
  if (settings.subtitle?.tonePolishModel === "gpt-4o-mini") {
    settings.subtitle.tonePolishModel = DEFAULT_SUBTITLE_SETTINGS.tonePolishModel;
  }
  if (settings.subtitle?.displayMode === "translation_source") {
    settings.subtitle.displayMode = DEFAULT_SUBTITLE_SETTINGS.displayMode;
  }
  if (
    settings.subtitle?.translateAllLanguages === true
    && Array.isArray(settings.subtitle.translationLanguages)
    && settings.subtitle.translationLanguages.length === 2
    && settings.subtitle.translationLanguages[0] === "en"
    && settings.subtitle.translationLanguages[1] === "ko"
  ) {
    settings.subtitle.translationLanguages = ["en", "ko", "ja"];
  }
  if (settings.subtitle?.maxWidth === 1100) {
    settings.subtitle.maxWidth = DEFAULT_SUBTITLE_SETTINGS.maxWidth;
  }
  if (typeof settings.subtitle.overlayDisplayId !== "string"
    || settings.subtitle.overlayDisplayId.length > 64
    || /[\u0000-\u001f\u007f]/u.test(settings.subtitle.overlayDisplayId)) {
    settings.subtitle.overlayDisplayId = "";
  }
  if (typeof settings.subtitle.overlayAllDisplays !== "boolean") {
    settings.subtitle.overlayAllDisplays = !settings.subtitle.overlayDisplayId;
  }
  // A stored combination can be individually valid yet unusable together: a
  // file written before the caption-language rule existed can hold Soniox's
  // two-way translation next to three languages. The load path repairs that by
  // dropping the one role it cannot honour - leaving it in place would make
  // every later save (which validates strictly) fail, locking the user out of
  // the settings screen. strictEngine callers check this themselves.
  if (!strictEngine) {
    try {
      validateEngineForLanguages(settings.subtitle.engine, settings.subtitle.translationLanguages);
    } catch {
      // Nothing on this path may throw: it runs while the desktop app boots.
      let repaired = DEFAULT_ENGINE_SELECTION;
      try {
        repaired = validateEngineForLanguages(
          { ...settings.subtitle.engine, translation: DEFAULT_ENGINE_SELECTION.translation },
          settings.subtitle.translationLanguages,
        );
      } catch {}
      settings.subtitle.engine = repaired;
    }
  }
  return settings;
}

function migrateGlossaryPresetSelection(subtitle) {
  const glossary = typeof subtitle.glossary === "string" ? subtitle.glossary : "";
  const domain = typeof subtitle.translationDomain === "string" ? subtitle.translationDomain : "";
  if (!glossary.trim() && !domain.trim()) {
    subtitle.glossaryPresetId = DEFAULT_GLOSSARY_PRESET_ID;
    subtitle.glossaryPresetName = "";
    subtitle.glossary = DEFAULT_GLOSSARY_PRESET.glossary;
    subtitle.translationDomain = DEFAULT_GLOSSARY_PRESET.domain;
    return;
  }

  if (isReleasedDefaultGlossary(subtitle, glossary, domain)) {
    subtitle.glossaryPresetId = DEFAULT_GLOSSARY_PRESET_ID;
    subtitle.glossaryPresetName = "";
    subtitle.glossary = DEFAULT_GLOSSARY_PRESET.glossary;
    subtitle.translationDomain = DEFAULT_GLOSSARY_PRESET.domain;
    return;
  }

  const exactBuiltIn = GLOSSARY_PRESETS.find((preset) => preset.glossary === glossary
    && preset.domain === domain
    && hasSameLanguagePair(preset.languagePair, subtitle.languagePair));
  if (exactBuiltIn) {
    subtitle.glossaryPresetId = exactBuiltIn.id;
    subtitle.glossaryPresetName = "";
    return;
  }

  const currentId = typeof subtitle.glossaryPresetId === "string"
    ? subtitle.glossaryPresetId.trim().slice(0, 128)
    : "";
  const isKnownBuiltIn = GLOSSARY_PRESETS.some((preset) => preset.id === currentId);
  subtitle.glossaryPresetId = isKnownBuiltIn ? "" : currentId;
  subtitle.glossaryPresetName = subtitle.glossaryPresetId && typeof subtitle.glossaryPresetName === "string"
    ? subtitle.glossaryPresetName.trim().slice(0, 80)
    : "";
}

function isReleasedDefaultGlossary(subtitle, glossary, domain) {
  const presetId = typeof subtitle.glossaryPresetId === "string" ? subtitle.glossaryPresetId.trim() : "";
  const presetName = typeof subtitle.glossaryPresetName === "string" ? subtitle.glossaryPresetName.trim() : "";
  if (presetName || (presetId && presetId !== DEFAULT_GLOSSARY_PRESET_ID)) return false;
  if (!hasSameLanguagePair(DEFAULT_GLOSSARY_PRESET.languagePair, subtitle.languagePair)) return false;
  const glossaryFingerprint = fingerprintPresetText(glossary);
  const domainFingerprint = fingerprintPresetText(domain);
  return LEGACY_DEFAULT_PRESET_FINGERPRINTS.some((fingerprints) => (
    fingerprints.glossary === glossaryFingerprint && fingerprints.domain === domainFingerprint
  ));
}

function fingerprintPresetText(value) {
  const normalized = value.replace(/\r\n?/gu, "\n").replace(/\n$/u, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function hasSameLanguagePair(left, right) {
  if (!left || !right) return false;
  return new Set([left.a, left.b]).size === 2
    && new Set([left.a, left.b]).size === new Set([right.a, right.b]).size
    && [left.a, left.b].every((language) => new Set([right.a, right.b]).has(language));
}

function seedFromEnv(settings, env) {
  const next = settings;
  const openaiKey = trimOrEmpty(env.OPENAI_API_KEY);
  if (openaiKey) next.apiKeys.openai = openaiKey;
  const geminiKey = trimOrEmpty(env.GEMINI_API_KEY);
  if (geminiKey) next.apiKeys.gemini = geminiKey;
  const geminiSecondaryKey = trimOrEmpty(env.GEMINI_SECONDARY_API_KEY);
  if (geminiSecondaryKey) next.apiKeys.geminiSecondary = geminiSecondaryKey;
  const sonioxKey = trimOrEmpty(env.SONIOX_API_KEY);
  if (sonioxKey) next.apiKeys.soniox = sonioxKey;

  return next;
}

function trimOrEmpty(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

// API keys were persisted with no validation at all: `{ openai: { evil: 1 } }`
// was written straight to disk and then made getSanitized() report
// hasOpenAIKey: true for a "key" no provider call can ever use. Keys must be
// strings under one of the three known slots.
export function validateApiKeys(value) {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw new Error("apiKeys must be a plain object.");
  for (const [name, key] of Object.entries(value)) {
    if (!API_KEY_NAMES.includes(name)) {
      throw new Error(`Unknown API key slot: ${name}.`);
    }
    if (typeof key !== "string") {
      throw new Error(`API key ${name} must be a string.`);
    }
    if (key.length > MAX_API_KEY_CHARS) {
      throw new Error(`API key ${name} must be ${MAX_API_KEY_CHARS} characters or fewer.`);
    }
  }
}

export function validateSubtitleSettings(value) {
  if (value === undefined || value === null) return;
  // Arrays used to pass every check below (each field reads `undefined`), which
  // is how `"subtitle": []` reached the disk and bricked persistence.
  if (!isPlainObject(value)) throw new Error("Subtitle settings must be a plain object.");
  if (value.inputMode !== undefined && !["system", "mic", "system_mic"].includes(value.inputMode)) {
    throw new Error("Subtitle input mode must be system, mic, or system_mic.");
  }
  if (value.micDeviceId !== undefined && typeof value.micDeviceId !== "string") {
    throw new Error("Subtitle micDeviceId must be a string.");
  }
  // Live Call 중 로컬 Gemini 엔진 병행(hybrid) opt-in. 기본 false = 게이트웨이
  // 단일 정본 생산자(이중 번역 비용 방지).
  if (value.liveCallLocalEngine !== undefined && typeof value.liveCallLocalEngine !== "boolean") {
    throw new Error("Subtitle liveCallLocalEngine must be a boolean.");
  }
  if (value.displayMode !== undefined && !["translation_only", "translation_source"].includes(value.displayMode)) {
    throw new Error("Subtitle display mode must be translation_only or translation_source.");
  }
  if (value.showSourceText !== undefined && typeof value.showSourceText !== "boolean") {
    throw new Error("Subtitle showSourceText must be a boolean.");
  }
  if (value.translateAllLanguages !== undefined && typeof value.translateAllLanguages !== "boolean") {
    throw new Error("Subtitle translateAllLanguages must be a boolean.");
  }
  if (value.languagePair !== undefined) validateLanguagePair(value.languagePair);
  if (value.translationLanguages !== undefined) validateTranslationLanguages(value.translationLanguages);
  if (value.liveCallTranslationLanguages !== undefined) {
    validateLiveCallTranslationLanguages(value.liveCallTranslationLanguages);
  }
  // Mixed caption+audio output is retired: a session produces captions OR
  // interpreted audio, not both. A settings file written before this still holds
  // the old value, so the READ path migrates it (see migrateSettingsFile) rather
  // than throwing here, which would make the file unloadable.
  if (value.outputMode !== undefined && value.outputMode !== "captions") {
    throw new Error("Subtitle outputMode must be captions.");
  }
  for (const retiredKey of ["audioLanguage", "audioVolume", "voiceProvider", "model", "geminiModel"]) {
    if (value[retiredKey] !== undefined) throw new Error(`Subtitle ${retiredKey} is retired in caption-only mode.`);
  }
  if (value.position !== undefined && !["bottom-center", "top-center", "middle-center"].includes(value.position)) {
    throw new Error("Subtitle position must be bottom-center, top-center, or middle-center.");
  }
  if (value.subtitlePositions !== undefined) {
    if (typeof value.subtitlePositions !== "object" || value.subtitlePositions === null || Array.isArray(value.subtitlePositions)) {
      throw new Error("Subtitle subtitlePositions must be an object keyed by language.");
    }
    for (const [language, position] of Object.entries(value.subtitlePositions)) {
      if (!isSupportedSubtitleLanguage(language)) {
        throw new Error("Subtitle subtitlePositions keys must be supported language codes.");
      }
      if (!["bottom-center", "top-center", "middle-center"].includes(position)) {
        throw new Error("Subtitle subtitlePositions values must be bottom-center, top-center, or middle-center.");
      }
    }
  }
  if (value.translationFontSize !== undefined) validateFontSize(value.translationFontSize, "translationFontSize");
  if (value.sourceFontSize !== undefined) validateFontSize(value.sourceFontSize, "sourceFontSize");
  if (value.maxSubtitleLines !== undefined) {
    const lines = Number(value.maxSubtitleLines);
    if (!Number.isInteger(lines) || lines < 1 || lines > 8) {
      throw new Error("Subtitle maxSubtitleLines must be between 1 and 8.");
    }
  }
  if (value.recordProvider !== undefined && !["none", "ollama"].includes(value.recordProvider)) {
    throw new Error("Subtitle recordProvider must be none or ollama.");
  }
  if (value.tone !== undefined && !["natural", "business"].includes(value.tone)) {
    throw new Error("Subtitle tone must be natural or business.");
  }
  if (value.translationProvider !== undefined && value.translationProvider !== "gemini") {
    throw new Error("Subtitle translationProvider must remain gemini.");
  }
  if (value.glossary !== undefined) {
    if (typeof value.glossary !== "string" || value.glossary.length > MAX_SUBTITLE_GLOSSARY_CHARS) {
      throw new Error(`Subtitle glossary must be a string of ${MAX_SUBTITLE_GLOSSARY_CHARS} characters or fewer.`);
    }
  }
  if (value.glossaries !== undefined && !isValidGlossarySelections(value.glossaries)) {
    throw new Error("Subtitle glossaries must contain between 1 and 5 valid glossary selections.");
  }
  if (value.glossaryPresetId !== undefined) {
    if (typeof value.glossaryPresetId !== "string" || value.glossaryPresetId.length > 128) {
      throw new Error("Subtitle glossaryPresetId must be a string of 128 characters or fewer.");
    }
  }
  if (value.glossaryPresetName !== undefined) {
    if (typeof value.glossaryPresetName !== "string" || value.glossaryPresetName.length > 80) {
      throw new Error("Subtitle glossaryPresetName must be a string of 80 characters or fewer.");
    }
  }
  if (value.translationDomain !== undefined) {
    if (typeof value.translationDomain !== "string" || value.translationDomain.length > MAX_SUBTITLE_DOMAIN_CHARS) {
      throw new Error(`Subtitle translationDomain must be a string of ${MAX_SUBTITLE_DOMAIN_CHARS} characters or fewer.`);
    }
  }
  if (value.verticalOffset !== undefined) {
    const offset = Number(value.verticalOffset);
    if (!Number.isFinite(offset) || offset < 0 || offset > MAX_SUBTITLE_VERTICAL_OFFSET) {
      throw new Error(`Subtitle verticalOffset must be between 0 and ${MAX_SUBTITLE_VERTICAL_OFFSET}.`);
    }
  }
  if (value.fontFamily !== undefined) {
    if (typeof value.fontFamily !== "string" || value.fontFamily.length > MAX_SUBTITLE_FONT_FAMILY_CHARS) {
      throw new Error(`Subtitle fontFamily must be a string of ${MAX_SUBTITLE_FONT_FAMILY_CHARS} characters or fewer.`);
    }
  }
  for (const legacy of ["geminiTranscribeModel", "geminiSummaryModel", "geminiPolishModel", "geminiModel"]) {
    if (value[legacy] !== undefined) throw new Error("Subtitle model fields moved to subtitle.engine.");
  }
  if (value.engine !== undefined) normalizeEngineSelection(value.engine);
  if (value.tonePolishModel !== undefined && typeof value.tonePolishModel !== "string") {
    throw new Error("Subtitle tonePolishModel must be a string.");
  }
  if (value.overlayEnabled !== undefined && typeof value.overlayEnabled !== "boolean") {
    throw new Error("Subtitle overlayEnabled must be a boolean.");
  }
  if (value.overlayDisplayIds !== undefined && value.overlayDisplayIds !== null
    && (!Array.isArray(value.overlayDisplayIds) || value.overlayDisplayIds.length > 16
      || new Set(value.overlayDisplayIds).size !== value.overlayDisplayIds.length
      || value.overlayDisplayIds.some((id) => typeof id !== "string" || !id || id.length > 64 || /[\u0000-\u001f\u007f]/u.test(id)))) {
    throw new Error("Subtitle overlayDisplayIds must contain unique display IDs.");
  }
  if (value.overlayAllDisplays !== undefined && typeof value.overlayAllDisplays !== "boolean") {
    throw new Error("Subtitle overlayAllDisplays must be a boolean.");
  }
  if (value.overlayDisplayId !== undefined
    && (typeof value.overlayDisplayId !== "string"
      || value.overlayDisplayId.length > 64
      || /[\u0000-\u001f\u007f]/u.test(value.overlayDisplayId))) {
    throw new Error("Subtitle overlayDisplayId must be a valid display ID.");
  }
  if (value.ollamaBaseURL !== undefined) validateLocalOllamaBaseURL(value.ollamaBaseURL);
  if (value.ollamaModel !== undefined) {
    const model = trimOrEmpty(value.ollamaModel);
    if (!model || model.length > 120) throw new Error("Subtitle ollamaModel must be 1 to 120 characters.");
  }
  if (value.maxWidth !== undefined) {
    const maxWidth = Number(value.maxWidth);
    if (!Number.isFinite(maxWidth) || maxWidth < 320 || maxWidth > 3000) {
      throw new Error("Subtitle maxWidth must be between 320 and 3000.");
    }
  }
  if (value.opacity !== undefined) {
    const opacity = Number(value.opacity);
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new Error("Subtitle opacity must be between 0 and 1.");
    }
  }
}

function isValidGlossarySelections(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return false;
  const keys = new Set();
  for (const selection of value) {
    if (!isPlainObject(selection)) return false;
    const selectionKeys = Object.keys(selection);
    if (selection.sourceKind === "builtin") {
      if (selectionKeys.length !== 2 || !BUILT_IN_GLOSSARY_IDS.has(selection.sourceId)) return false;
    } else if (selection.sourceKind === "host") {
      if (selectionKeys.length !== 3 || typeof selection.sourceId !== "string"
        || !GLOSSARY_PRESET_UUID_PATTERN.test(selection.sourceId)
        || !Number.isSafeInteger(selection.documentVersion) || selection.documentVersion < 1) return false;
    } else return false;
    const key = `${selection.sourceKind}:${selection.sourceId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}


function validateFontSize(value, label) {
  const fontSize = Number(value);
  if (!Number.isFinite(fontSize) || fontSize < 14 || fontSize > 96) {
    throw new Error(`Subtitle ${label} must be between 14 and 96.`);
  }
}

function validateLanguagePair(value) {
  if (!value || typeof value !== "object") throw new Error("Subtitle languagePair must include a and b.");
  if (!isSupportedSubtitleLanguage(value.a) || !isSupportedSubtitleLanguage(value.b) || value.a === value.b) {
    throw new Error("Subtitle languagePair must be two different supported language codes.");
  }
}

function validateTranslationLanguages(value) {
  if (!Array.isArray(value)) throw new Error("Subtitle translationLanguages must be an array.");
  const unique = new Set(value);
  if (value.length < 1 || value.length > MAX_TRANSLATION_LANGUAGES || unique.size !== value.length
    || value.some((language) => !isSupportedSubtitleLanguage(language))) {
    throw new Error(`Subtitle translationLanguages must include 1-${MAX_TRANSLATION_LANGUAGES} different supported language codes.`);
  }
}

function validateLiveCallTranslationLanguages(value) {
  if (!Array.isArray(value)) throw new Error("Subtitle liveCallTranslationLanguages must be an array.");
  if (value.length === 0) return; // empty = inherit translationLanguages
  const unique = new Set(value);
  // Live Call sessions accept 1-3 languages (webapp schema min is 1), unlike
  // the local overlay which needs at least 2.
  if (value.length > MAX_TRANSLATION_LANGUAGES || unique.size !== value.length
    || value.some((language) => !isSupportedSubtitleLanguage(language))) {
    throw new Error(`Subtitle liveCallTranslationLanguages must include up to ${MAX_TRANSLATION_LANGUAGES} different supported language codes.`);
  }
}

function validateLocalOllamaBaseURL(value) {
  if (typeof value !== "string") throw new Error("Subtitle ollamaBaseURL must be a local HTTP URL.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Subtitle ollamaBaseURL must be a valid local HTTP URL.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!["http:", "https:"].includes(url.protocol) || !localHosts.has(url.hostname)) {
    throw new Error("Subtitle ollamaBaseURL must point to localhost.");
  }
}
