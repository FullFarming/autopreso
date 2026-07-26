import { normalizeLiveLanguage } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic glossary enforcement — EXACT port of the desktop subtitle
// pipeline's applyGlossaryCorrections (src/subtitle-realtime.js). The Gemini
// Live Translate API has no glossary support (official docs), so this pass is
// the desktop's — and now the gateway's — terminology guarantee on every
// committed caption. Behavioral equivalence with the desktop implementation
// is pinned by test/live-glossary-parity.test.js at the repo root; change the
// two copies together.
// ─────────────────────────────────────────────────────────────────────────────

export function applyGlossaryCorrections(text, { glossary = "", targetLanguage = "ko", sourceText = "" } = {}) {
  const raw = String(text ?? "");
  if (!raw) return raw;
  const normalizedTargetLanguage = normalizeLanguageCode(targetLanguage);
  if (!normalizedTargetLanguage) return raw;
  // Number notation is arithmetic, not terminology — it applies to every
  // committed line whether or not the session picked a glossary preset.
  if (!String(glossary ?? "").trim()) {
    return normalizeBusinessNumberNotation(raw, normalizedTargetLanguage);
  }

  let corrected = applySourceGlossaryMemory(raw, {
    glossary,
    targetLanguage: normalizedTargetLanguage,
    sourceText,
  });
  const replacements = cachedGlossaryReplacementRules(glossary, normalizedTargetLanguage);
  for (const { from, to } of replacements) {
    if (!from || !to || from === to) continue;
    corrected = replaceGlossaryTerm(corrected, from, to);
  }
  corrected = normalizeCushmanWakefield(corrected, normalizedTargetLanguage, glossary);
  corrected = normalizeBusinessNumberNotation(corrected, normalizedTargetLanguage);
  return fixKoreanObjectParticles(corrected);
}

function normalizeLanguageCode(value) {
  return normalizeLiveLanguage(value);
}

// Pattern-based normalization for the "Cushman & Wakefield" company name, which
// the live model mangles in endless ways the glossary cannot enumerate
// term-by-term. Scoped to glossaries that actually reference the company.
const CW_FULL_PATTERN =
  /\b(?:cushmann?|kushmann?|kushiman|kusiman|kushi)\s*(?:&|and|end|n|앤드)?\s*wakefield(\s+korea)?/gi;
const CW_GARBLE_PATTERN =
  /\b(?:kushiman|kushima|kushmann?|kusiman|kushi)\w*(?:\s+\w+){0,3}?\s+(?:wake\s*)?field(\s+korea)?/gi;
const CW_KFIELD_PATTERN = /\bk-?field(\s+korea)?/gi;
const CW_KO_PATTERN = /쿠[시쉬][먼만]?(?:앤드|앤|엔드|언드|드)?\s*웨이크\s*필드(\s*코리아)?/g;

function glossaryReferencesCushmanWakefield(glossary) {
  return /cushman|wakefield|쿠시먼|쿠쉬먼|c&w|k-?field|웨이크\s*필드/i.test(String(glossary ?? ""));
}

function normalizeCushmanWakefield(text, targetLanguage, glossary) {
  const value = String(text ?? "");
  if (!value || !glossaryReferencesCushmanWakefield(glossary)) return value;
  const isKorean = targetLanguage === "ko";
  const canonical = isKorean ? "쿠시먼앤드웨이크필드" : "Cushman & Wakefield";
  const koreaSuffix = isKorean ? " 코리아" : " Korea";
  const withKorea = (korea) => `${canonical}${korea ? koreaSuffix : ""}`;
  return value
    .replace(CW_FULL_PATTERN, (_match, korea) => withKorea(korea))
    .replace(CW_GARBLE_PATTERN, (_match, korea) => withKorea(korea))
    .replace(CW_KFIELD_PATTERN, (_match, korea) => withKorea(korea))
    .replace(CW_KO_PATTERN, (_match, korea) => withKorea(korea));
}

// Parsing + sorting the glossary into replacement rules is pure for a given
// (glossary, targetLanguage) but runs on EVERY committed line — cache it.
const glossaryRuleCache = new Map();
const GLOSSARY_RULE_CACHE_MAX = 16;
function cachedGlossaryReplacementRules(glossary, targetLanguage) {
  const key = `${targetLanguage}\u0000${glossary}`;
  const cached = glossaryRuleCache.get(key);
  if (cached) return cached;
  const rules = parseGlossaryReplacementRules(glossary, targetLanguage)
    .sort((a, b) => b.from.length - a.from.length);
  glossaryRuleCache.set(key, rules);
  if (glossaryRuleCache.size > GLOSSARY_RULE_CACHE_MAX) {
    glossaryRuleCache.delete(glossaryRuleCache.keys().next().value);
  }
  return rules;
}

function parseGlossaryReplacementRules(glossary, targetLanguage) {
  const rules = [];
  for (const line of String(glossary ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("-") || trimmed.startsWith("※")) continue;
    if (!trimmed.includes("=")) continue;
    const [leftRaw, ...rightParts] = trimmed.split("=");
    const rightRaw = rightParts.join("=").trim();
    const leftTerms = [...splitGlossaryAlternatives(leftRaw), ...extractNeverTerms(leftRaw)];
    const rightTerms = [...splitGlossaryAlternatives(rightRaw), ...extractNeverTerms(rightRaw)];
    if (!leftTerms.length || !rightTerms.length) continue;
    const alignedRules = buildAlignedGlossaryRules(leftTerms, rightTerms, targetLanguage);
    if (alignedRules.length) {
      rules.push(...alignedRules);
      continue;
    }

    const rightTarget = rightTerms.find((term) => detectTermLanguage(term) === targetLanguage);
    const leftTarget = leftTerms.find((term) => detectTermLanguage(term) === targetLanguage);
    const canonical = rightTarget || leftTarget;
    if (!canonical) continue;
    for (const term of [...leftTerms, ...rightTerms]) {
      if (term !== canonical) rules.push({ from: term, to: canonical });
    }
  }
  return dedupeReplacementRules(rules);
}

function applySourceGlossaryMemory(text, { glossary, targetLanguage, sourceText }) {
  const source = normalizeMemoryText(sourceText);
  if (!source) return text;
  const matches = parseGlossarySourceMemoryRules(glossary, targetLanguage)
    .filter((rule) => sourceContainsMemoryTerm(source, rule))
    .sort((a, b) => b.from.length - a.from.length);
  return matches[0]?.to ?? text;
}

function parseGlossarySourceMemoryRules(glossary, targetLanguage) {
  const rules = [];
  let isTranslationMemorySection = false;
  for (const line of String(glossary ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      isTranslationMemorySection = /번역 메모리|translation memory|문장 매칭/i.test(trimmed);
      continue;
    }
    if (!trimmed || trimmed.startsWith("-") || trimmed.startsWith("※")) continue;
    if (!trimmed.includes("=")) continue;
    const [leftRaw, ...rightParts] = trimmed.split("=");
    const rightRaw = rightParts.join("=").trim();
    const leftTerms = splitGlossaryAlternatives(leftRaw);
    const rightTerms = splitGlossaryAlternatives(rightRaw);
    if (!leftTerms.length || !rightTerms.length) continue;
    const alignedRules = buildAlignedGlossaryRules(leftTerms, rightTerms, targetLanguage, { allowEmbedded: isTranslationMemorySection });
    if (alignedRules.length) {
      rules.push(...alignedRules);
      continue;
    }

    const rightTarget = rightTerms.find((term) => detectTermLanguage(term) === targetLanguage);
    const leftTarget = leftTerms.find((term) => detectTermLanguage(term) === targetLanguage);
    const canonical = rightTarget || leftTarget;
    if (!canonical) continue;

    for (const term of [...leftTerms, ...rightTerms]) {
      if (term === canonical) continue;
      if (detectTermLanguage(term) === targetLanguage) continue;
      rules.push({ from: term, to: canonical, allowEmbedded: isTranslationMemorySection });
    }
  }
  return dedupeReplacementRules(rules);
}

function buildAlignedGlossaryRules(leftTerms, rightTerms, targetLanguage, options = {}) {
  if (leftTerms.length < 2 || leftTerms.length !== rightTerms.length) return [];
  const rules = [];
  for (let index = 0; index < leftTerms.length; index += 1) {
    const left = leftTerms[index];
    const right = rightTerms[index];
    const leftLanguage = detectTermLanguage(left);
    const rightLanguage = detectTermLanguage(right);
    if (leftLanguage === rightLanguage) return [];
    const target = leftLanguage === targetLanguage ? left : rightLanguage === targetLanguage ? right : "";
    const source = leftLanguage === targetLanguage ? right : rightLanguage === targetLanguage ? left : "";
    if (!target || !source || target === source) return [];
    rules.push({ from: source, to: target, ...(options.allowEmbedded ? { allowEmbedded: true } : {}) });
  }
  return rules;
}

function sourceContainsMemoryTerm(source, rule) {
  const normalizedTerm = normalizeMemoryText(rule.from);
  if (!normalizedTerm) return false;
  if (source === normalizedTerm) return true;
  if (!rule.allowEmbedded) return false;
  if (!source.includes(normalizedTerm)) return false;
  const sourceChars = source.replace(/\s/g, "").length;
  const termChars = normalizedTerm.replace(/\s/g, "").length;
  return termChars >= 8 && termChars / Math.max(sourceChars, 1) >= 0.72;
}

function splitGlossaryAlternatives(value) {
  return String(value ?? "")
    .split(/\s+\/\s+/)
    .map((term) => normalizeGlossaryTerm(term))
    .filter((term) => term.length >= 2);
}

function normalizeGlossaryTerm(value) {
  return String(value ?? "")
    .replace(/\s*\([^)]*(?:NEVER|never|호텔 객실 수 단위|현재 상황|브랜드|고유명사)[^)]*\)\s*/g, "")
    .trim();
}

function extractNeverTerms(value) {
  return [...String(value ?? "").matchAll(/NEVER\s+"([^"]+)"/gi)]
    .map((match) => normalizeGlossaryTerm(match[1]))
    .filter((term) => term.length >= 2);
}

function normalizeMemoryText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[“”"'.:,;!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const KOREAN_CHAR = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const JAPANESE_CHAR = /[ぁ-んァ-ヶーｱ-ﾝ一-龯々]/;
const ENGLISH_CHAR = /[A-Za-z]/;

function detectTermLanguage(term) {
  const text = String(term ?? "");
  if (KOREAN_CHAR.test(text)) return "ko";
  if (JAPANESE_CHAR.test(text)) return "ja";
  if (ENGLISH_CHAR.test(text)) return "en";
  return "unknown";
}

function dedupeReplacementRules(rules) {
  const seen = new Set();
  const result = [];
  for (const rule of rules) {
    const key = `${rule.from}\u0000${rule.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rule);
  }
  return result;
}

function replaceGlossaryTerm(text, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasLatinEdge = /^[A-Za-z0-9&+.-]/.test(from) || /[A-Za-z0-9&+.-]$/.test(from);
  const pattern = hasLatinEdge
    ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi")
    : new RegExp(escaped, "g");
  return text.replace(pattern, to);
}

function fixKoreanObjectParticles(text) {
  return String(text ?? "")
    .replace(/([가-힣])를/g, (_match, char) => `${char}${hasKoreanFinalConsonant(char) ? "을" : "를"}`)
    .replace(/([가-힣])을/g, (_match, char) => `${char}${hasKoreanFinalConsonant(char) ? "을" : "를"}`);
}

function hasKoreanFinalConsonant(char) {
  const code = char.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Business number notation — deterministic, because it is arithmetic.
//
// Korean counts in myriads (만 10^4 / 억 10^8 / 조 10^12); English business
// speech counts in million/billion/trillion. A live model asked to "translate"
// 3,000억 원 will happily emit "3,000 hundred million won" or leave the 억
// glyph in English output, so the scale is converted here instead: 3,000억 원 →
// KRW 300 billion, and 300 billion won → 3,000억 원. This runs on every
// committed caption and therefore on every recorded transcript line.
//
// Safety rules: a figure is only rewritten when a scale word is attached to a
// number, the conversion is applied at the SAME magnitude (no FX, ever), and a
// value that cannot be expressed exactly in the target scale falls back to
// comma-grouped digits rather than inventing precision.
// ─────────────────────────────────────────────────────────────────────────────

const NUMBER = "\\d[\\d,]*(?:\\.\\d+)?";
const MYRIAD_UNIT_VALUES = { 조: 1e12, 兆: 1e12, 억: 1e8, 億: 1e8, 만: 1e4, 万: 1e4 };
const MYRIAD_PREFIX_VALUES = { 천: 1e3, 千: 1e3, 백: 1e2, 百: 1e2 };
const MYRIAD_GROUP = `${NUMBER}\\s*[천백千百]?\\s*[조억만兆億万]`;
const WESTERN_SCALE_VALUES = { "hundred million": 1e8, trillion: 1e12, billion: 1e9, million: 1e6 };
const WESTERN_SCALE = "hundred\\s+million|trillion|billion|million";
const CURRENCY_BEFORE = "KRW|USD|JPY|EUR|₩|\\$|¥|€";
const CURRENCY_AFTER =
  "원화|원|달러|엔|円|유로|ウォン|ドル|ユーロ|won|dollars?|yen|euros?|KRW|USD|JPY|EUR";

// A myriad amount, optionally compound (1조 5,000억), optionally with a sub-만
// remainder that only counts when a currency token closes the figure, plus a
// currency on either side.
const MYRIAD_AMOUNT_PATTERN = new RegExp(
  `(?:(${CURRENCY_BEFORE})\\s*)?(${MYRIAD_GROUP}(?:\\s*${MYRIAD_GROUP})*)` +
    `(?:\\s*(${NUMBER})(?=\\s*(?:${CURRENCY_AFTER})(?![A-Za-z])))?` +
    `(?:\\s*(${CURRENCY_AFTER})(?![A-Za-z]))?`,
  "gi",
);

const WESTERN_AMOUNT_PATTERN = new RegExp(
  `(?:(${CURRENCY_BEFORE})\\s*)?(${NUMBER})\\s*(${WESTERN_SCALE})(?![A-Za-z-])` +
    `(?:\\s*(${CURRENCY_AFTER})(?![A-Za-z]))?`,
  "gi",
);

// "667K USD" / "USD 641K" — the thousands shorthand these decks quote fees in.
// A bare K is NOT a money scale (K-Pop, K-Beauty, 4K video), so a currency has
// to sit on one side of it before this fires.
const THOUSANDS_SHORTHAND_PATTERN = new RegExp(
  `(?:(${CURRENCY_BEFORE})\\s*)?(${NUMBER})\\s*K(?![A-Za-z0-9-])` +
    `(?:\\s*(${CURRENCY_AFTER})(?![A-Za-z]))?`,
  "gi",
);

// "hundred million" is the literal shadow of 억 and shows up in English output
// even when the rest of the line is clean English.
const LITERAL_HUNDRED_MILLION_PATTERN = new RegExp(
  `(?:(${CURRENCY_BEFORE})\\s*)?(${NUMBER})\\s*hundred\\s+million(?![A-Za-z-])` +
    `(?:\\s*(${CURRENCY_AFTER})(?![A-Za-z]))?`,
  "gi",
);

const CURRENCY_IDS = new Map([
  ["원", "KRW"], ["원화", "KRW"], ["won", "KRW"], ["krw", "KRW"], ["₩", "KRW"], ["ウォン", "KRW"],
  ["달러", "USD"], ["dollar", "USD"], ["dollars", "USD"], ["usd", "USD"], ["$", "USD"], ["ドル", "USD"],
  ["엔", "JPY"], ["円", "JPY"], ["yen", "JPY"], ["jpy", "JPY"], ["¥", "JPY"],
  ["유로", "EUR"], ["euro", "EUR"], ["euros", "EUR"], ["eur", "EUR"], ["€", "EUR"], ["ユーロ", "EUR"],
]);

const CURRENCY_OUTPUT = {
  en: { KRW: "KRW", USD: "USD", JPY: "JPY", EUR: "EUR" },
  ko: { KRW: "원", USD: "달러", JPY: "엔", EUR: "유로" },
  ja: { KRW: "ウォン", USD: "ドル", JPY: "円", EUR: "ユーロ" },
};

/** @type {Record<string, Array<[number, string]>>} */
const MYRIAD_OUTPUT_UNITS = {
  ko: [[1e12, "조"], [1e8, "억"], [1e4, "만"]],
  ja: [[1e12, "兆"], [1e8, "億"], [1e4, "万"]],
};

/** @type {Array<[number, string]>} */
const WESTERN_OUTPUT_SCALES = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"]];

// Units that follow a figure but are not money: the number is still fixed, the
// unit is left exactly as spoken (33,000㎡, never "33 thousand㎡").
const NON_CURRENCY_UNIT_START = /^[㎡평명개실동층%°]/u;

/**
 * Rewrites monetary/quantity scales into the notation the target language's
 * business register uses. Never converts currencies, only scale words.
 * @param {string} text @param {string} targetLanguage
 */
export function normalizeBusinessNumberNotation(text, targetLanguage) {
  const raw = String(text ?? "");
  if (!raw) return raw;
  const language = String(targetLanguage ?? "").toLowerCase();
  if (language === "en") return toWesternNotation(raw);
  if (language === "ko" || language === "ja") return toMyriadNotation(raw, language);
  return raw;
}

function toWesternNotation(text) {
  return text
    .replace(MYRIAD_AMOUNT_PATTERN, (match, before, groups, remainder, after, offset, whole) => {
      const value = parseMyriadAmount(groups, remainder);
      if (value === null) return match;
      return renderWestern(value, resolveCurrency(before, after), followedByNonCurrencyUnit(whole, offset + match.length));
    })
    .replace(LITERAL_HUNDRED_MILLION_PATTERN, (match, before, number, after, offset, whole) => {
      const value = parseNumber(number);
      if (value === null) return match;
      return renderWestern(value * 1e8, resolveCurrency(before, after), followedByNonCurrencyUnit(whole, offset + match.length));
    });
}

function toMyriadNotation(text, language) {
  return text
    .replace(WESTERN_AMOUNT_PATTERN, (match, before, number, scale, after) => {
      const parsed = parseNumber(number);
      const unit = WESTERN_SCALE_VALUES[scale.replace(/\s+/gu, " ").toLowerCase()];
      if (parsed === null || !unit) return match;
      return renderMyriad(parsed * unit, resolveCurrency(before, after), language);
    })
    .replace(THOUSANDS_SHORTHAND_PATTERN, (match, before, number, after) => {
      const currency = resolveCurrency(before, after);
      const parsed = parseNumber(number);
      if (!currency || parsed === null) return match;
      return renderMyriad(parsed * 1e3, currency, language);
    });
}

/** Sums a compound myriad expression such as "1조 5,000억" plus any sub-만 tail. */
function parseMyriadAmount(groups, remainder) {
  let total = 0;
  let matched = false;
  const pattern = new RegExp(`(${NUMBER})\\s*([천백千百]?)\\s*([조억만兆億万])`, "gu");
  for (const group of String(groups ?? "").matchAll(pattern)) {
    const parsed = parseNumber(group[1]);
    if (parsed === null) return null;
    const prefix = group[2] ? MYRIAD_PREFIX_VALUES[group[2]] : 1;
    total += parsed * prefix * MYRIAD_UNIT_VALUES[group[3]];
    matched = true;
  }
  if (!matched) return null;
  if (remainder) {
    const tail = parseNumber(remainder);
    if (tail === null) return null;
    total += tail;
  }
  return total;
}

function parseNumber(value) {
  const cleaned = String(value ?? "").replace(/,/gu, "").trim();
  if (!cleaned || !/^\d+(?:\.\d+)?$/u.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveCurrency(before, after) {
  const token = String(after ?? before ?? "").trim().toLowerCase();
  return CURRENCY_IDS.get(token) ?? "";
}

function followedByNonCurrencyUnit(whole, index) {
  return NON_CURRENCY_UNIT_START.test(String(whole ?? "").slice(index, index + 1));
}

function renderWestern(value, currency, plainDigitsOnly) {
  const prefix = currency ? `${CURRENCY_OUTPUT.en[currency]} ` : "";
  if (plainDigitsOnly) return `${prefix}${formatDigits(value)}`;
  for (const [scaleValue, scaleName] of WESTERN_OUTPUT_SCALES) {
    if (value < scaleValue) continue;
    const scaled = Number((value / scaleValue).toFixed(4));
    // Refuse to invent precision: an amount that does not land cleanly on the
    // scale is reported as digits instead of a rounded-off approximation.
    if (Math.abs(scaled * scaleValue - value) >= 0.5) break;
    return `${prefix}${formatDigits(scaled)} ${scaleName}`;
  }
  return `${prefix}${formatDigits(value)}`;
}

function renderMyriad(value, currency, language) {
  const suffix = currency ? ` ${CURRENCY_OUTPUT[language][currency]}` : "";
  const parts = [];
  let remaining = value;
  for (const [unitValue, unitName] of MYRIAD_OUTPUT_UNITS[language]) {
    const count = Math.floor(remaining / unitValue);
    if (count <= 0) continue;
    parts.push(`${formatDigits(count)}${unitName}`);
    remaining -= count * unitValue;
  }
  // Sub-만 remainders (and amounts below 만) stay plain digits.
  if (remaining >= 0.5 || !parts.length) parts.push(formatDigits(remaining || value));
  return `${parts.join(" ")}${suffix}`;
}

function formatDigits(value) {
  const rounded = Number(Number(value).toFixed(4));
  const [integerPart, decimalPart] = String(rounded).split(".");
  const grouped = integerPart.replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
  return decimalPart ? `${grouped}.${decimalPart}` : grouped;
}
