export const AUDIO_CONFIG = Object.freeze({
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
  channels: 1,
  chunkMilliseconds: 40,
  prerollMilliseconds: 300,
  vadSilenceMilliseconds: 600,
  staleFrameMilliseconds: 750,
  streamEndAfterMilliseconds: 1_000,
});

export const STT_CONFIG = Object.freeze({
  rolloverMilliseconds: 270_000,
  overlapMilliseconds: 2_000,
  minSpeakers: 2,
  maxSpeakers: 6,
});

export const SESSION_TYPES = Object.freeze(["presentation", "meeting"]);
export const OUTPUT_MODES = Object.freeze(["captions", "captions_audio", "audio"]);
export const VOICE_PROVIDERS = Object.freeze(["gemini", "openai"]);
export const LIVE_TRANSLATION_LANGUAGES = Object.freeze([
  "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt", "fr", "de", "ru", "hi", "id", "vi", "it",
]);
export const OPENAI_REALTIME_TRANSLATION_LANGUAGES = Object.freeze(["en", "es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it"]);
export const GLOSSARY_PACKS = Object.freeze(["general_cre", "hotel", "fnb"]);

/** @type {Array<[string, string]>} */
const LIVE_LANGUAGE_ALIAS_ENTRIES = [
  ["en-us", "en"], ["en-gb", "en"], ["en-au", "en"], ["en-ca", "en"],
  ["ko-kr", "ko"], ["ja-jp", "ja"],
  ["zh", "zh-Hans"], ["zh-cn", "zh-Hans"], ["zh-sg", "zh-Hans"], ["cmn-hans-cn", "zh-Hans"],
  ["zh-tw", "zh-Hant"], ["zh-hk", "zh-Hant"], ["zh-mo", "zh-Hant"], ["cmn-hant-tw", "zh-Hant"],
  ["es-es", "es"], ["es-mx", "es"], ["pt-br", "pt"], ["pt-pt", "pt"],
  ["fr-fr", "fr"], ["fr-ca", "fr"], ["de-de", "de"], ["ru-ru", "ru"],
  ["hi-in", "hi"], ["id-id", "id"], ["vi-vn", "vi"], ["it-it", "it"],
];
const LIVE_LANGUAGE_ALIASES = new Map();
for (const language of LIVE_TRANSLATION_LANGUAGES) LIVE_LANGUAGE_ALIASES.set(language.toLowerCase(), language);
for (const [alias, language] of LIVE_LANGUAGE_ALIAS_ENTRIES) LIVE_LANGUAGE_ALIASES.set(alias, language);

export function normalizeLiveLanguage(value) {
  return LIVE_LANGUAGE_ALIASES.get(String(value ?? "").trim().toLowerCase()) ?? "";
}

function toOpenAiLanguage(language) {
  return language === "zh-Hans" || language === "zh-Hant" ? "zh" : language;
}

export function validateLiveSettings(value) {
  if (!value || typeof value !== "object") throw new Error("라이브 설정이 필요합니다.");
  const isLegacyTownhall = value.mode === "townhall";
  const sessionType = value.sessionType ?? (isLegacyTownhall ? "meeting" : value.mode);
  if (!SESSION_TYPES.includes(sessionType)) throw new Error("지원하지 않는 라이브 모드입니다.");
  if (!Array.isArray(value.languages) || value.languages.length < 1) throw new Error("언어는 1개 이상 선택해야 합니다.");
  if (value.languages.length > 3) throw new Error("언어는 3개 이하로 선택해야 합니다.");
  const languages = value.languages.map(normalizeLiveLanguage);
  if (languages.some((language) => !language)) throw new Error("언어 코드가 올바르지 않습니다.");
  if (new Set(languages).size !== languages.length) throw new Error("중복 언어를 선택할 수 없습니다.");
  let outputMode = value.outputMode;
  if (outputMode === undefined) {
    if (isLegacyTownhall || value.voiceOutputMode === "fixed_voice" || value.voiceOutputMode === "auto_voice") outputMode = "audio";
    else outputMode = "captions";
  }
  if (!OUTPUT_MODES.includes(outputMode)) throw new Error("지원하지 않는 음성 출력 모드입니다.");
  const requestedVoiceProvider = value.voiceProvider ?? "gemini";
  if (!VOICE_PROVIDERS.includes(requestedVoiceProvider)) throw new Error("지원하지 않는 음성 공급자입니다.");
  if (requestedVoiceProvider === "openai" && (sessionType !== "presentation" || !hasAudioOutput(outputMode))) {
    throw new Error("OpenAI 음성은 프레젠테이션 음성 출력 모드에서만 사용할 수 있습니다.");
  }
  const voiceProvider = requestedVoiceProvider;
  if (voiceProvider === "openai") {
    const unsupported = languages.find((language) => !OPENAI_REALTIME_TRANSLATION_LANGUAGES.includes(toOpenAiLanguage(language)));
    if (unsupported) throw new Error(`OpenAI 실시간 음성이 지원하지 않는 언어입니다: ${unsupported}`);
  }
  const maxViewers = value.maxViewers ?? 50;
  if (!Number.isSafeInteger(maxViewers) || maxViewers < 1 || maxViewers > 50) throw new Error("최대 시청자는 1명 이상 50명 이하여야 합니다.");
  const glossaryPack = value.glossaryPack ?? "general_cre";
  if (!GLOSSARY_PACKS.includes(glossaryPack)) throw new Error("지원하지 않는 용어집입니다.");
  // Free-form glossary text mirrored from the desktop subtitle settings so
  // Live Call translation uses the exact same terminology as local captions.
  // Optional and never persisted/compared server-side.
  if (value.glossaryText !== undefined && typeof value.glossaryText !== "string") {
    throw new Error("용어집 텍스트가 올바르지 않습니다.");
  }
  // 40k, not 16k: the shipped presets run to 27.5k, and slicing one mid-file
  // drops its trailing sections (proper nouns, place names) without any signal.
  const glossaryText = String(value.glossaryText ?? "").trim().slice(0, 40_000);
  // Tone + domain mirror the desktop subtitle settings so the second-pass
  // polish behaves identically for web viewers.
  const translationTone = value.translationTone ?? "natural";
  if (!["natural", "business"].includes(translationTone)) throw new Error("지원하지 않는 번역 톤입니다.");
  if (value.domainText !== undefined && typeof value.domainText !== "string") {
    throw new Error("도메인 텍스트가 올바르지 않습니다.");
  }
  const domainText = String(value.domainText ?? "").trim().slice(0, 2_000);
  return { sessionType, languages, outputMode, voiceProvider, maxViewers, glossaryPack, glossaryText, translationTone, domainText };
}

export function readGatewayEnvironment(environment = process.env) {
  const required = [
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_LIVE_MODEL",
    "GOOGLE_CLOUD_PROJECT",
    "SUPABASE_URL",
    "LIVE_GATEWAY_TOKEN_SECRET",
    "LIVE_VIEWER_TOKEN_SECRET",
    "LIVE_EXTERNAL_ENV",
    "LIVE_ALLOWED_GCP_PROJECT",
  ];
  for (const name of required) {
    if (typeof environment[name] !== "string" || !environment[name].trim()) {
      throw new Error(`${name} 환경변수가 필요합니다.`);
    }
  }
  const supabaseSecretKey = typeof environment.SUPABASE_SECRET_KEY === "string"
    ? environment.SUPABASE_SECRET_KEY.trim()
    : "";
  const legacyServiceRoleKey = typeof environment.SUPABASE_SERVICE_ROLE_KEY === "string"
    ? environment.SUPABASE_SERVICE_ROLE_KEY.trim()
    : "";
  if (!supabaseSecretKey && !legacyServiceRoleKey) {
    throw new Error("SUPABASE_SECRET_KEY 또는 SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  }
  for (const name of ["LIVE_GATEWAY_TOKEN_SECRET", "LIVE_VIEWER_TOKEN_SECRET"]) {
    if (environment[name].trim().length < 32) throw new Error(`${name}은 32자 이상이어야 합니다.`);
  }
  if (environment.LIVE_EXTERNAL_ENV.trim() !== "development") throw new Error("외부 AI 연결은 개발 환경에서만 허용됩니다.");
  if (environment.GOOGLE_CLOUD_PROJECT.trim() !== environment.LIVE_ALLOWED_GCP_PROJECT.trim()) {
    throw new Error("허용된 개발 Google Cloud 프로젝트와 일치하지 않습니다.");
  }
  let supabaseUrl;
  try {
    supabaseUrl = new URL(environment.SUPABASE_URL);
  } catch {
    throw new Error("Supabase URL이 올바르지 않습니다.");
  }
  const hasRootPath = supabaseUrl.pathname === "/" || supabaseUrl.pathname === "";
  const isExactLocalSupabase = supabaseUrl.protocol === "http:"
    && (supabaseUrl.hostname === "127.0.0.1" || supabaseUrl.hostname === "localhost")
    && supabaseUrl.port === "54321"
    && !supabaseUrl.username
    && !supabaseUrl.password
    && hasRootPath
    && !supabaseUrl.search
    && !supabaseUrl.hash;
  const canUseLocalSupabase = environment.NODE_ENV !== "production"
    && String(environment.LIVE_ALLOW_LOCAL_SUPABASE ?? "").trim() === "true";
  const allowedSupabaseRef = String(environment.LIVE_ALLOWED_SUPABASE_REF ?? "").trim();
  const isAllowedHostedSupabase = /^[a-z0-9-]+$/u.test(allowedSupabaseRef)
    && supabaseUrl.protocol === "https:"
    && supabaseUrl.hostname === `${allowedSupabaseRef}.supabase.co`
    && !supabaseUrl.username
    && !supabaseUrl.password
    && !supabaseUrl.port
    && !supabaseUrl.search
    && !supabaseUrl.hash
    && hasRootPath;
  if (!(isExactLocalSupabase && canUseLocalSupabase) && !isAllowedHostedSupabase) {
    throw new Error("허용된 개발 Supabase 프로젝트와 일치하지 않습니다.");
  }
  const sttLanguageCodes = String(environment.STT_LANGUAGE_CODES ?? "ko-KR,en-US,ja-JP").split(",").map((value) => value.trim()).filter(Boolean);
  if (sttLanguageCodes.length < 1 || sttLanguageCodes.length > 3) throw new Error("STT_LANGUAGE_CODES는 1개 이상 3개 이하여야 합니다.");
  const hostReconnectGraceMilliseconds = Number(environment.LIVE_HOST_RECONNECT_GRACE_MS ?? 90_000);
  if (!Number.isFinite(hostReconnectGraceMilliseconds) || hostReconnectGraceMilliseconds < 0) {
    throw new Error("LIVE_HOST_RECONNECT_GRACE_MS가 올바르지 않습니다.");
  }
  const readPolishWeight = (name, fallback) => {
    const raw = environment[name] ?? String(fallback);
    if (!/^\d+$/u.test(String(raw))) throw new Error(`${name} 환경변수가 올바르지 않습니다.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new Error(`${name} 환경변수가 올바르지 않습니다.`);
    return value;
  };
  const captionPolishPolicyWeights = {
    off: readPolishWeight("LIVE_CAPTION_POLISH_OFF_BPS", 0),
    selective: readPolishWeight("LIVE_CAPTION_POLISH_SELECTIVE_BPS", 10_000),
    full: readPolishWeight("LIVE_CAPTION_POLISH_FULL_BPS", 0),
  };
  if (Object.values(captionPolishPolicyWeights).reduce((sum, value) => sum + value, 0) > 10_000) {
    throw new Error("LIVE_CAPTION_POLISH 정책 비율 합계는 10000 이하여야 합니다.");
  }
  return {
    port: Number(environment.PORT ?? 8080),
    host: isExactLocalSupabase && canUseLocalSupabase ? "127.0.0.1" : "0.0.0.0",
    geminiApiKey: environment.GEMINI_API_KEY,
    geminiLiveModel: environment.GEMINI_LIVE_MODEL,
    geminiTextModel: String(environment.GEMINI_TEXT_MODEL ?? "gemini-3.5-flash").trim() || "gemini-3.5-flash",
    openaiRealtimeTranslateModel: String(environment.OPENAI_REALTIME_TRANSLATE_MODEL ?? "gpt-realtime-translate").trim() || "gpt-realtime-translate",
    openaiApiKey: environment.OPENAI_API_KEY.trim(),
    projectId: environment.GOOGLE_CLOUD_PROJECT,
    baseUrl: supabaseUrl.origin,
    supabaseApiKey: supabaseSecretKey || legacyServiceRoleKey,
    supabaseKeyType: supabaseSecretKey ? "secret" : "legacy-service-role",
    gatewaySecret: environment.LIVE_GATEWAY_TOKEN_SECRET.trim(),
    viewerSecret: environment.LIVE_VIEWER_TOKEN_SECRET.trim(),
    sttLanguageCodes,
    hostReconnectGraceMilliseconds,
    captionPolishPolicyWeights,
    externalEnvironment: "development",
  };
}

function hasAudioOutput(outputMode) {
  return outputMode === "captions_audio" || outputMode === "audio";
}

/** Script-level plausibility check: does this text look like it is written in
 *  the given language? Used to gate verbatim source-lane passthrough and to
 *  validate LLM translation output, because per-result STT language detection
 *  (and an echoing LLM) must never surface raw Korean on a Latin-script lane. */
export function textPlausiblyInLanguage(text, language) {
  const base = String(language ?? "").trim().toLowerCase().split("-")[0];
  if (!base) return false;
  const letters = String(text ?? "").replace(/[^\p{L}\p{M}]/gu, "");
  if (!letters) return true; // digits/punctuation are language-neutral
  const hangul = /[가-힯ᄀ-ᇿ㄰-㆏]/u.test(letters);
  const kana = /[぀-ヿ]/u.test(letters);
  const han = /[一-鿿㐀-䶿]/u.test(letters);
  const cyrillic = /[Ѐ-ӿ]/u.test(letters);
  const arabic = /[؀-ۿݐ-ݿ]/u.test(letters);
  const thai = /[฀-๿]/u.test(letters);
  switch (base) {
    case "ko": return hangul;
    case "ja": return kana || (han && !hangul);
    case "zh": case "cmn": case "yue": return han && !kana && !hangul;
    case "ru": case "uk": return cyrillic;
    case "ar": return arabic;
    case "th": return thai;
    default: return !hangul && !kana && !han && !cyrillic && !arabic && !thai;
  }
}
