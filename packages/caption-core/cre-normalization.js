// Deterministic CRE notation for committed captions only.

const DECIMAL_PLACES = 4;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_PLACES);
const MAX_ABSOLUTE_VALUE = 10n ** 18n;
const MAX_ABSOLUTE_SCALED = MAX_ABSOLUTE_VALUE * DECIMAL_FACTOR;
const MAX_SHORT_SCALE_DECIMALS = 3;

const UNSIGNED_NUMBER = "(?:0|[1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d*)(?:\\.\\d{1,4})?";
const KOREAN_GROUP = `${UNSIGNED_NUMBER}\\s*(?:천|백)?\\s*(?:조|억|만)`;
const CURRENCY = "KRW|USD|JPY|EUR|₩|\\$|¥|€|원화|원|달러|엔|유로|won|dollars?|yen|euros?";
const WESTERN_SCALE = "hundred\\s+million|trillion|billion|million|thousand|tn|bn|mil|mn|m|k";

const KOREAN_AMOUNT_PATTERN = new RegExp(
  `(?:(?<signBefore>-)?(?<currencyBefore>${CURRENCY})\\s*)?`
    + `(?<amountSign>-)?(?<groups>${KOREAN_GROUP}(?:\\s*${KOREAN_GROUP})*)`
    + `(?:\\s*(?<currencyAfter>${CURRENCY}))?`,
  "giu",
);

const WESTERN_AMOUNT_PATTERN = new RegExp(
  `(?:(?<signBefore>-)?(?<currencyBefore>${CURRENCY})\\s*)?`
    + `(?<amountSign>-)?(?<number>${UNSIGNED_NUMBER})\\s*(?<scale>${WESTERN_SCALE})(?![A-Za-z])`
    + `(?:\\s*(?<currencyAfter>${CURRENCY})(?![A-Za-z]))?`,
  "giu",
);

const PERCENT_PATTERN = new RegExp(
  `(?<number>-?${UNSIGNED_NUMBER})\\s*(?:퍼센트|percent|per\\s+cent|％)(?![A-Za-z])`,
  "giu",
);

const KOREAN_UNIT_VALUES = new Map([
  ["조", 10n ** 12n],
  ["억", 10n ** 8n],
  ["만", 10n ** 4n],
]);

const KOREAN_PREFIX_VALUES = new Map([
  ["", 1n],
  ["백", 100n],
  ["천", 1_000n],
]);

const WESTERN_SCALE_VALUES = new Map([
  ["trillion", 10n ** 12n],
  ["tn", 10n ** 12n],
  ["billion", 10n ** 9n],
  ["bn", 10n ** 9n],
  ["million", 10n ** 6n],
  ["mil", 10n ** 6n],
  ["mn", 10n ** 6n],
  ["m", 10n ** 6n],
  ["hundred million", 10n ** 8n],
  ["thousand", 10n ** 3n],
  ["k", 10n ** 3n],
]);

const CURRENCY_IDS = new Map([
  ["krw", "KRW"], ["₩", "KRW"], ["원", "KRW"], ["원화", "KRW"], ["won", "KRW"],
  ["usd", "USD"], ["$", "USD"], ["달러", "USD"], ["dollar", "USD"], ["dollars", "USD"],
  ["jpy", "JPY"], ["¥", "JPY"], ["엔", "JPY"], ["yen", "JPY"],
  ["eur", "EUR"], ["€", "EUR"], ["유로", "EUR"], ["euro", "EUR"], ["euros", "EUR"],
]);

const KOREAN_CURRENCY_LABELS = new Map([
  ["KRW", "원"],
  ["USD", "달러"],
  ["JPY", "엔"],
  ["EUR", "유로"],
]);

/** @type {Array<[bigint, string]>} */
const ENGLISH_SHORT_SCALES = [
  [10n ** 12n, "tn"],
  [10n ** 9n, "bn"],
  [10n ** 6n, "m"],
  [10n ** 3n, "k"],
];

/** @type {Array<[bigint, string]>} */
const KOREAN_OUTPUT_UNITS = [
  [10n ** 12n, "조"],
  [10n ** 8n, "억"],
  [10n ** 4n, "만"],
];

const CRE_ACRONYMS = new Map([
  ["adr", "ADR"],
  ["capex", "CAPEX"],
  ["dscr", "DSCR"],
  ["esg", "ESG"],
  ["ff&e", "FF&E"],
  ["gfa", "GFA"],
  ["gop", "GOP"],
  ["goppar", "GOPPAR"],
  ["irr", "IRR"],
  ["ltv", "LTV"],
  ["mrg", "MRG"],
  ["nla", "NLA"],
  ["noi", "NOI"],
  ["occ", "OCC"],
  ["opex", "OPEX"],
  ["os&e", "OS&E"],
  ["pfv", "PFV"],
  ["reit", "REIT"],
  ["revpar", "RevPAR"],
  ["spc", "SPC"],
  ["wale", "WALE"],
]);

export const creNormalizationContract = Object.freeze({
  maximumAbsoluteValue: MAX_ABSOLUTE_VALUE.toString(),
  maximumInputDecimalPlaces: DECIMAL_PLACES,
  maximumShortScaleDecimalPlaces: MAX_SHORT_SCALE_DECIMALS,
  committedOnly: true,
});

/**
 * Normalizes exact CRE notation after a caption is committed. Live partials are
 * returned byte-for-byte so an unfinished number never jumps between scales.
 *
 * @param {{text?: unknown, targetLanguage?: unknown, isFinal?: unknown}} input
 */
export function normalizeCommittedCreCaption({ text, targetLanguage, isFinal } = {}) {
  const raw = String(text ?? "");
  if (!raw || isFinal !== true) return raw;
  const language = String(targetLanguage ?? "").trim().toLowerCase();
  if (language !== "en" && language !== "ko") return raw;

  let normalized = language === "en"
    ? normalizeKoreanAmounts(raw)
    : normalizeWesternAmounts(raw, language);
  if (language === "en") normalized = normalizeWesternAmounts(normalized, language);
  normalized = normalizePercentNotation(normalized);
  normalized = normalizeCreAcronyms(normalized);
  return normalizeRegisteredNames(normalized, language);
}

function normalizeKoreanAmounts(text) {
  return text.replace(KOREAN_AMOUNT_PATTERN, (match, ...args) => {
    const replacement = replacementContext(args);
    if (!replacement || hasUnsafeNumberBoundary(replacement.whole, replacement.offset, match.length)) return match;
    const { signBefore, amountSign, currencyBefore, currencyAfter, groups } = replacement.groups;
    if (signBefore && amountSign) return match;
    const currency = resolveCurrency(currencyBefore, currencyAfter);
    if (currency === null) return match;

    const parsed = parseKoreanGroups(groups);
    if (!parsed) return match;
    const isNegative = Boolean(signBefore || amountSign);
    const tail = replacement.whole.slice(replacement.offset + match.length);
    const areaUnit = /^\s*(㎡|m²|평)/u.exec(tail)?.[1] ?? "";
    const followingUnit = /^\s*(㎡|m²|평|명|개|실|동|층)/u.exec(tail)?.[1] ?? "";
    if (!currency && followingUnit && !areaUnit) return match;
    if (areaUnit) {
      if (currency || parsed.scaledValue % DECIMAL_FACTOR !== 0n) return match;
      return `${isNegative ? "-" : ""}${formatInteger(parsed.scaledValue / DECIMAL_FACTOR)}`;
    }
    return renderEnglishAmount(parsed.scaledValue, currency, isNegative, match);
  });
}

function normalizeWesternAmounts(text, targetLanguage) {
  return text.replace(WESTERN_AMOUNT_PATTERN, (match, ...args) => {
    const replacement = replacementContext(args);
    if (!replacement || hasUnsafeNumberBoundary(replacement.whole, replacement.offset, match.length)) return match;
    const { signBefore, amountSign, currencyBefore, currencyAfter, number, scale } = replacement.groups;
    if (signBefore && amountSign) return match;
    const currency = resolveCurrency(currencyBefore, currencyAfter);
    // Short scale letters are ambiguous without a currency (5m can be length),
    // while the full words carry an unambiguous numeric scale on their own.
    const normalizedScale = String(scale).replace(/\s+/gu, " ").toLowerCase();
    if (!currency && /^(?:tn|bn|mil|mn|m|k)$/u.test(normalizedScale)) return match;
    const coefficient = parseDecimalScaled(number);
    const scaleValue = WESTERN_SCALE_VALUES.get(normalizedScale);
    if (coefficient === null || !scaleValue) return match;
    const scaledValue = coefficient * scaleValue;
    if (!isWithinMagnitudeLimit(scaledValue)) return match;
    const isNegative = Boolean(signBefore || amountSign);
    return targetLanguage === "en"
      ? renderEnglishAmount(scaledValue, currency, isNegative, match)
      : renderKoreanAmount(scaledValue, currency, isNegative, match);
  });
}

function normalizePercentNotation(text) {
  return text.replace(PERCENT_PATTERN, (match, ...args) => {
    const replacement = replacementContext(args);
    if (!replacement || hasUnsafeNumberBoundary(replacement.whole, replacement.offset, match.length)) return match;
    const value = parseSignedDecimalScaled(replacement.groups.number);
    if (value === null || absolute(value) > 10_000n * DECIMAL_FACTOR) return match;
    return `${formatScaledDecimal(value)}%`;
  });
}

function normalizeCreAcronyms(text) {
  let normalized = text;
  for (const [variant, canonical] of CRE_ACRONYMS) {
    const escaped = escapeRegExp(variant);
    normalized = normalized.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "giu"), canonical);
  }
  return normalized.replace(/(?<![A-Za-z0-9])cap\s+rate(?![A-Za-z0-9])/giu, "Cap Rate");
}

function normalizeRegisteredNames(text, targetLanguage) {
  if (targetLanguage === "en") {
    return text.replace(/\bCushman\s+(?:and|&)\s+Wakefield(?:\s+Korea)?\b/giu, (match) => (
      /\sKorea$/iu.test(match) ? "Cushman & Wakefield Korea" : "Cushman & Wakefield"
    ));
  }
  return text.replace(/쿠시먼\s*(?:앤드|&)\s*웨이크\s*필드(?:\s*코리아)?/gu, (match) => (
    /코리아$/u.test(match.trim()) ? "쿠시먼앤드웨이크필드 코리아" : "쿠시먼앤드웨이크필드"
  ));
}

function replacementContext(args) {
  const groups = args.at(-1);
  const whole = args.at(-2);
  const offset = args.at(-3);
  if (!groups || typeof groups !== "object" || typeof whole !== "string" || !Number.isInteger(offset)) return null;
  return { groups, whole, offset };
}

function hasUnsafeNumberBoundary(whole, offset, length) {
  const before = whole.slice(Math.max(0, offset - 1), offset);
  const after = whole.slice(offset + length, offset + length + 1);
  const afterNext = whole.slice(offset + length + 1, offset + length + 2);
  if (/[A-Za-z0-9.,+\-]/u.test(before) || /[A-Za-z0-9]/u.test(after)) return true;
  if (/[.,]/u.test(after) && /\d/u.test(afterNext)) return true;
  // A valid compound matcher is greedy. Any numeric tail left behind means the
  // provider has emitted an unfinished or malformed amount such as `1조 5,`.
  return /^\s*\d/u.test(whole.slice(offset + length));
}

function parseKoreanGroups(value) {
  const input = String(value ?? "");
  const pattern = new RegExp(`(${UNSIGNED_NUMBER})\\s*(천|백)?\\s*(조|억|만)`, "gu");
  let scaledValue = 0n;
  let previousUnit = null;
  let consumedUntil = 0;
  for (const match of input.matchAll(pattern)) {
    if (input.slice(consumedUntil, match.index).trim()) return null;
    const coefficient = parseDecimalScaled(match[1]);
    const prefix = KOREAN_PREFIX_VALUES.get(match[2] ?? "");
    const unit = KOREAN_UNIT_VALUES.get(match[3]);
    if (coefficient === null || !prefix || !unit || (previousUnit !== null && unit >= previousUnit)) return null;
    scaledValue += coefficient * prefix * unit;
    if (!isWithinMagnitudeLimit(scaledValue)) return null;
    previousUnit = unit;
    consumedUntil = match.index + match[0].length;
  }
  if (input.slice(consumedUntil).trim() || previousUnit === null) return null;
  return { scaledValue };
}

function parseDecimalScaled(value) {
  const input = String(value ?? "");
  if (!new RegExp(`^${UNSIGNED_NUMBER}$`, "u").test(input)) return null;
  const [integerPart, fractionalPart = ""] = input.replace(/,/gu, "").split(".");
  const scaled = BigInt(integerPart) * DECIMAL_FACTOR
    + BigInt(fractionalPart.padEnd(DECIMAL_PLACES, "0"));
  return isWithinMagnitudeLimit(scaled) ? scaled : null;
}

function parseSignedDecimalScaled(value) {
  const input = String(value ?? "");
  const isNegative = input.startsWith("-");
  const parsed = parseDecimalScaled(isNegative ? input.slice(1) : input);
  return parsed === null ? null : isNegative ? -parsed : parsed;
}

function resolveCurrency(before, after) {
  const beforeId = currencyId(before);
  const afterId = currencyId(after);
  if (beforeId && afterId && beforeId !== afterId) return null;
  return beforeId || afterId || "";
}

function currencyId(value) {
  return CURRENCY_IDS.get(String(value ?? "").trim().toLowerCase()) ?? "";
}

function renderEnglishAmount(scaledValue, currency, isNegative, fallback) {
  if (!isWithinMagnitudeLimit(scaledValue)) return fallback;
  const notation = formatEnglishScale(scaledValue);
  if (!notation) return fallback;
  return `${isNegative ? "-" : ""}${currency ? `${currency} ` : ""}${notation}`;
}

function formatEnglishScale(scaledValue) {
  for (const [unit, suffix] of ENGLISH_SHORT_SCALES) {
    if (scaledValue < unit * DECIMAL_FACTOR) continue;
    if (scaledValue % unit !== 0n) continue;
    const coefficient = scaledValue / unit;
    if (fractionalLength(coefficient) > MAX_SHORT_SCALE_DECIMALS) continue;
    return `${formatScaledDecimal(coefficient)}${suffix}`;
  }
  if (scaledValue % DECIMAL_FACTOR !== 0n) return "";
  return formatInteger(scaledValue / DECIMAL_FACTOR);
}

function renderKoreanAmount(scaledValue, currency, isNegative, fallback) {
  if (!isWithinMagnitudeLimit(scaledValue) || scaledValue % DECIMAL_FACTOR !== 0n) return fallback;
  let remaining = scaledValue / DECIMAL_FACTOR;
  const parts = [];
  for (const [unit, suffix] of KOREAN_OUTPUT_UNITS) {
    const count = remaining / unit;
    if (count === 0n) continue;
    parts.push(`${formatInteger(count)}${suffix}`);
    remaining %= unit;
  }
  if (remaining > 0n || parts.length === 0) parts.push(formatInteger(remaining));
  const currencyLabel = currency ? KOREAN_CURRENCY_LABELS.get(currency) : "";
  if (currency && !currencyLabel) return fallback;
  return `${isNegative ? "-" : ""}${parts.join(" ")}${currencyLabel ? ` ${currencyLabel}` : ""}`;
}

function fractionalLength(scaledValue) {
  const fraction = String(absolute(scaledValue) % DECIMAL_FACTOR).padStart(DECIMAL_PLACES, "0").replace(/0+$/u, "");
  return fraction.length;
}

function formatScaledDecimal(scaledValue) {
  const sign = scaledValue < 0n ? "-" : "";
  const magnitude = absolute(scaledValue);
  const integer = magnitude / DECIMAL_FACTOR;
  const fraction = String(magnitude % DECIMAL_FACTOR).padStart(DECIMAL_PLACES, "0").replace(/0+$/u, "");
  return `${sign}${formatInteger(integer)}${fraction ? `.${fraction}` : ""}`;
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
}

function isWithinMagnitudeLimit(scaledValue) {
  return scaledValue >= 0n && scaledValue <= MAX_ABSOLUTE_SCALED;
}

function absolute(value) {
  return value < 0n ? -value : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
