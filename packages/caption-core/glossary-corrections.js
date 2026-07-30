import { normalizeCaptionLanguage } from "./languages.js";

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
  if (!String(glossary ?? "").trim()) return raw;

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
  return fixKoreanObjectParticles(corrected);
}

function normalizeLanguageCode(value) {
  return normalizeCaptionLanguage(value);
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
