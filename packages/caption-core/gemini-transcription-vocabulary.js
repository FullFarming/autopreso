const API_MAXIMUM_ENTRIES = 1_000;
const DEFAULT_MAXIMUM_ENTRIES = 100;
const MAXIMUM_COMPILED_TERMS = 10_000;
const MAXIMUM_ENTRY_CODEPOINTS = 240;
const MAXIMUM_ENTRY_UTF8_BYTES = 960;
const MAXIMUM_TOTAL_UTF8_BYTES = 64 * 1_024;
const MAXIMUM_LEGACY_CODEPOINTS = 40_000;
const MAXIMUM_LEGACY_UTF8_BYTES = 160_000;

const PRIORITIZED_TAGS = new Set([
  "asset",
  "brand",
  "company",
  "institution",
  "organization",
  "person",
  "product",
  "project",
  "proper name",
  "proper-name",
  "proper_name",
  "proper_noun",
  "ticker",
]);
const EXECUTABLE_CONTENT_PATTERN = /(?:javascript|vbscript)\s*:|data\s*:\s*text\/html|(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions?|system\s+prompt|\$\{|\{\{/iu;
const ACRONYM_PATTERN = /^(?=.{2,32}$)(?=(?:.*[A-Z]){2})[A-Z0-9][A-Z0-9.&+/_-]*(?:\s+[A-Z0-9][A-Z0-9.&+/_-]*)*$/u;
const LEGACY_HEADER_PATTERN = /^\[([^\]]+)\]$/u;
const LEGACY_EXCLUDED_SECTION_PATTERN = /규칙|rules?|번역\s*메모리|translation\s*memory|문장\s*매칭/iu;
const LEGACY_PROPER_SECTION_PATTERN = /고유명사|회사|기관|브랜드|자산|프로젝트|인명|proper\s*noun|compan(?:y|ies)|brand|institution|asset|project|person/iu;
const LEGACY_TERM_SECTION_PATTERN = /전문|용어|약어|technical|terminolog|glossary|acronym|ticker/iu;
const LEGACY_PAIR_SEPARATOR_PATTERN = /\s*(?:=|->|→|↔)\s*/u;
const SENTENCE_PATTERN = /(?:[.!?。！？]$|(?:다|요|니다|습니다|합니다|됩니다|입니다)$|(?:です|ます)$|\b(?:ignore|reveal|this|that|these|those|we|you|they|is|are|was|were|will|should|must|meets?)\b)/iu;

export const geminiTranscriptionVocabularyContract = Object.freeze({
  apiMaximumEntries: API_MAXIMUM_ENTRIES,
  recommendedMaximumEntries: DEFAULT_MAXIMUM_ENTRIES,
  defaultMaximumEntries: DEFAULT_MAXIMUM_ENTRIES,
  maximumEntryCodepoints: MAXIMUM_ENTRY_CODEPOINTS,
  maximumEntryUtf8Bytes: MAXIMUM_ENTRY_UTF8_BYTES,
  maximumTotalUtf8Bytes: MAXIMUM_TOTAL_UTF8_BYTES,
  maximumLegacyCodepoints: MAXIMUM_LEGACY_CODEPOINTS,
  maximumLegacyUtf8Bytes: MAXIMUM_LEGACY_UTF8_BYTES,
  candidateFields: Object.freeze(["source", "aliases"]),
});

/**
 * Selects a safe, deterministic source-recognition vocabulary from a compiled
 * glossary without modifying or reducing its translation and repair rules.
 *
 * @param {unknown} compiledGlossary
 * @param {{ maximumEntries?: number }} [options]
 * @returns {ReadonlyArray<string>}
 * @throws {Error} when the container or selection options are invalid.
 */
export function selectGeminiTranscriptionVocabulary(compiledGlossary, options = {}) {
  const terms = parseTerms(compiledGlossary);
  const maximumEntries = parseMaximumEntries(options);
  const candidates = [];

  for (const term of terms) {
    if (!term || typeof term !== "object" || Array.isArray(term)) continue;
    const tags = normalizeTags(term.tags);
    const priority = Number.isSafeInteger(term.priority) && term.priority >= 0 && term.priority <= 100
      ? term.priority
      : 50;
    addCandidate(candidates, term, term.source, "source", tags, priority);
    if (!Array.isArray(term.aliases) || term.aliases.length > 16) continue;
    for (const alias of term.aliases) addCandidate(candidates, term, alias, "alias", tags, priority);
  }

  return selectCandidates(candidates, maximumEntries);
}

/**
 * Compatibility selector for the legacy sectioned `left = right` glossary.
 * Both sides are eligible because legacy proper-name rows mix spoken aliases
 * and canonical spellings across the separator.
 *
 * @param {unknown} glossaryText
 * @param {{ maximumEntries?: number }} [options]
 * @returns {ReadonlyArray<string>}
 * @throws {Error} when the text or selection options are invalid.
 */
export function selectGeminiTranscriptionVocabularyFromLegacyText(glossaryText, options = {}) {
  if (typeof glossaryText !== "string" || glossaryText.length > MAXIMUM_LEGACY_CODEPOINTS * 2
    || hasUnpairedSurrogate(glossaryText)
    || Array.from(glossaryText).length > MAXIMUM_LEGACY_CODEPOINTS
    || Buffer.byteLength(glossaryText, "utf8") > MAXIMUM_LEGACY_UTF8_BYTES) {
    throw new Error("INVALID_LEGACY_TRANSCRIPTION_GLOSSARY");
  }
  const maximumEntries = parseMaximumEntries(options);
  const candidates = [];
  let section = "";
  let lineIndex = 0;
  for (const rawLine of glossaryText.normalize("NFC").split(/\r?\n/u)) {
    lineIndex += 1;
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.match(LEGACY_HEADER_PATTERN);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (LEGACY_EXCLUDED_SECTION_PATTERN.test(section) || /^[-*•※]/u.test(line)) continue;
    const pair = parseLegacyPair(line);
    if (!pair) continue;
    const isProperSection = LEGACY_PROPER_SECTION_PATTERN.test(section);
    const isTermSection = LEGACY_TERM_SECTION_PATTERN.test(section);
    const values = [...pair.left, ...pair.right].map(normalizeCandidate);
    if (values.some((value) => !value)) continue;
    if (!values.every((value) => isLegacyTerm(value, isProperSection || isTermSection))) continue;
    for (const value of values) {
      candidates.push({
        value,
        bytes: Buffer.byteLength(value, "utf8"),
        category: isProperSection ? 0 : ACRONYM_PATTERN.test(value) ? 1 : 3,
        priority: 50,
        kind: 0,
        termId: `legacy-${String(lineIndex).padStart(5, "0")}`,
      });
    }
  }
  return selectCandidates(candidates, maximumEntries);
}

function selectCandidates(candidates, maximumEntries) {
  candidates.sort(compareCandidates);
  const selected = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= maximumEntries) break;
    const key = candidate.value.toLocaleLowerCase("und");
    if (seen.has(key)) continue;
    seen.add(key);
    if (totalBytes + candidate.bytes > MAXIMUM_TOTAL_UTF8_BYTES) continue;
    selected.push(candidate.value);
    totalBytes += candidate.bytes;
  }
  return Object.freeze(selected);
}

function parseTerms(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray(value.terms) || value.terms.length > MAXIMUM_COMPILED_TERMS) {
    throw new Error("INVALID_COMPILED_GLOSSARY");
  }
  return value.terms;
}

function parseMaximumEntries(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("INVALID_TRANSCRIPTION_VOCABULARY_OPTIONS");
  }
  const value = Object.hasOwn(options, "maximumEntries")
    ? options.maximumEntries
    : DEFAULT_MAXIMUM_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAXIMUM_ENTRIES) {
    throw new Error("INVALID_TRANSCRIPTION_VOCABULARY_OPTIONS");
  }
  return value;
}

function parseLegacyPair(line) {
  const parts = line.split(LEGACY_PAIR_SEPARATOR_PATTERN);
  if (parts.length < 2) return null;
  const left = splitLegacyVariants(parts.shift());
  const right = splitLegacyVariants(parts.join(" = "));
  return left.length > 0 && right.length > 0 ? { left, right } : null;
}

function splitLegacyVariants(value) {
  return String(value ?? "")
    .replace(/\([^)]*\)/gu, " ")
    .split(/\s+\/\s+|\s*,\s*/u)
    .map((term) => term.trim())
    .filter(Boolean);
}

function isLegacyTerm(value, isDeclaredTermSection) {
  if (ACRONYM_PATTERN.test(value)) return true;
  const tokens = value.match(/[\p{L}\p{N}][\p{L}\p{N}&+.'’-]*/gu) ?? [];
  if (tokens.length < 1 || tokens.length > 8 || SENTENCE_PATTERN.test(value)) return false;
  return isDeclaredTermSection || /\p{Lu}[\p{Ll}\p{L}]+(?:\s|$)|[&+]|\d/u.test(value);
}

function addCandidate(candidates, term, input, kind, tags, priority) {
  const value = normalizeCandidate(input);
  if (!value) return;
  candidates.push({
    value,
    bytes: Buffer.byteLength(value, "utf8"),
    category: candidateCategory(value, term, tags),
    priority,
    kind: kind === "source" ? 0 : 1,
    termId: typeof term.id === "string" && term.id.length <= 160 ? term.id.normalize("NFC") : "",
  });
}

function normalizeCandidate(value) {
  if (typeof value !== "string" || value.length > MAXIMUM_ENTRY_CODEPOINTS * 2 || hasUnpairedSurrogate(value)) return "";
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized || /[<>\p{Cc}\p{Cf}]/u.test(normalized)
    || EXECUTABLE_CONTENT_PATTERN.test(normalized)
    || Array.from(normalized).length > MAXIMUM_ENTRY_CODEPOINTS
    || Buffer.byteLength(normalized, "utf8") > MAXIMUM_ENTRY_UTF8_BYTES) return "";
  return normalized;
}

function normalizeTags(value) {
  if (!Array.isArray(value) || value.length > 16) return new Set();
  return new Set(value
    .filter((tag) => typeof tag === "string" && tag.length <= 128)
    .map((tag) => tag.normalize("NFC").toLocaleLowerCase("und").trim()));
}

function candidateCategory(value, term, tags) {
  if ([...tags].some((tag) => PRIORITIZED_TAGS.has(tag))) return 0;
  if (ACRONYM_PATTERN.test(value)) return 1;
  if (term.doNotTranslate === true) return 2;
  return 3;
}

function compareCandidates(left, right) {
  return left.category - right.category
    || right.priority - left.priority
    || left.kind - right.kind
    || compareText(left.value.toLocaleLowerCase("und"), right.value.toLocaleLowerCase("und"))
    || compareText(left.value, right.value)
    || compareText(left.termId, right.termId);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}
