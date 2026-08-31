// Local term retrieval for realtime captions. The provider cannot accept a
// speech-recognition glossary, so registered names are recovered after ASR and
// only the relevant glossary slice is sent to the optional final polisher.

const MAX_PROMPT_CHARACTERS = 2_000;
const MAX_RESULT_LINES = 12;
const MAX_GLOBAL_RULE_CHARACTERS = 600;
const TARGET_LOOKUP_MILLISECONDS = 30;
const MAX_QUERY_CHARACTERS = 4_096;
const MAX_GLOSSARY_CHARACTERS = 40_000;
const FUZZY_MINIMUM_CHARACTERS = 5;
const FUZZY_MINIMUM_SIMILARITY = 0.75;
const FUZZY_MINIMUM_MARGIN = 0.05;
const MAX_REPAIRS = 4;
const MAX_QUERY_CACHE_ENTRIES = 64;
const MAX_COMPILED_SESSION_ENTRIES = 64;
const MAX_COMPILED_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_COMPILED_TERMS = 10_000;
const COMPILED_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

const HEADER_PATTERN = /^\[[^\]]+\]$/u;
const NUMERIC_SECTION_PATTERN = /숫자|number\s*(?:notation|format|scale)|numeric|currency\s*scale/iu;
const PROPER_NOUN_SECTION_PATTERN = /고유명사|회사|기관|브랜드|자산|프로젝트|인명|proper\s*noun|compan(?:y|ies)|brand|institution|asset|project|person/iu;
const PAIR_SEPARATOR_PATTERN = /\s*(?:=|->|→|↔)\s*/u;
const LATIN_OR_NUMBER_PATTERN = /[A-Za-z0-9]/u;
const LETTER_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;

export const localTermRetrievalContract = Object.freeze({
  maximumPromptCharacters: MAX_PROMPT_CHARACTERS,
  maximumResultLines: MAX_RESULT_LINES,
  targetLookupMilliseconds: TARGET_LOOKUP_MILLISECONDS,
  maximumQueryCharacters: MAX_QUERY_CHARACTERS,
  maximumGlossaryCharacters: MAX_GLOSSARY_CHARACTERS,
  maximumQueryCacheEntries: MAX_QUERY_CACHE_ENTRIES,
  maximumCompiledSessionEntries: MAX_COMPILED_SESSION_ENTRIES,
  maximumCompiledCacheBytes: MAX_COMPILED_CACHE_BYTES,
  fuzzyMinimumCharacters: FUZZY_MINIMUM_CHARACTERS,
  fuzzyMinimumSimilarity: FUZZY_MINIMUM_SIMILARITY,
  fuzzyMinimumMargin: FUZZY_MINIMUM_MARGIN,
});

const compiledSessionIndexes = new Map();
const compiledCacheRecords = new Set();
let compiledCacheBytes = 0;

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[“”‘’"'`]/gu, "")
    .replace(/[^\p{L}\p{N}&+.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function searchTokens(value) {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function detectTermLanguage(value) {
  const text = String(value ?? "");
  const hangul = (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/gu) ?? []).length;
  const kana = (text.match(/[ぁ-んァ-ヶーｱ-ﾝ]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length;
  if (hangul > kana && hangul >= latin) return "ko";
  if (kana > hangul && kana >= latin) return "ja";
  if (latin > 0) return "en";
  return "unknown";
}

function stripAnnotation(value) {
  return String(value ?? "")
    .replace(/^[-*•]\s*/u, "")
    .replace(/\([^)]*\)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function splitVariants(value) {
  return stripAnnotation(value)
    .split(/\s+\/\s+|\s*,\s*/u)
    .map((term) => term.trim())
    .filter((term) => compactText(term).length >= 2);
}

function parsePair(line) {
  const parts = String(line ?? "").split(PAIR_SEPARATOR_PATTERN);
  if (parts.length < 2) return null;
  const left = splitVariants(parts.shift());
  const right = splitVariants(parts.join(" = "));
  if (left.length === 0 || right.length === 0) return null;
  return { left, right };
}

function isLikelyRegisteredNamePair(pair) {
  const terms = [...pair.left, ...pair.right];
  const languages = new Set(terms.map(detectTermLanguage).filter((language) => language !== "unknown"));
  if (languages.size !== 1) return false;
  return terms.some((term) => /(?:^|\s)[A-Z][A-Za-z]*|&|[A-Z]{2,}/u.test(term))
    && terms.some((term) => searchTokens(term).length >= 2 || /&/u.test(term));
}

function parseRegisteredAliasRule(line) {
  if (!/회사명\s*동일\s*지칭|registered\s+(?:company\s+)?aliases?/iu.test(line)) return [];
  const body = String(line).replace(/^[-*•]\s*/u, "").split(":").slice(1).join(":");
  if (!body) return [];
  return body
    .split(/\s+\/\s+/u)
    .map((term) => term.replace(/\s*(?:는|은)\s*모두.*$/u, "").trim())
    .filter((term) => compactText(term).length >= 2);
}

function phraseIsContained(query, phrase) {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  if (!LATIN_OR_NUMBER_PATTERN.test(normalizedPhrase)) return query.includes(normalizedPhrase);
  let offset = query.indexOf(normalizedPhrase);
  while (offset >= 0) {
    const before = query[offset - 1] ?? "";
    const after = query[offset + normalizedPhrase.length] ?? "";
    // Korean particles may immediately follow a registered English term
    // ("Cap Rate를"). Only Latin/digit adjacency indicates a substring such
    // as operator inside cooperator.
    if (!/[A-Za-z0-9]/u.test(before) && !/[A-Za-z0-9]/u.test(after)) return true;
    offset = query.indexOf(normalizedPhrase, offset + 1);
  }
  return false;
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left, right) {
  const a = compactText(left);
  const b = compactText(right);
  const length = Math.max(a.length, b.length);
  if (!length) return 0;
  return 1 - levenshteinDistance(a, b) / length;
}

function candidateWindows(value, tokenCount) {
  const matches = [...String(value ?? "").matchAll(/[\p{L}\p{N}][\p{L}\p{N}&+.'’-]*/gu)];
  const windows = [];
  for (const size of new Set([tokenCount, Math.max(1, tokenCount - 1), tokenCount + 1])) {
    for (let index = 0; index + size <= matches.length; index += 1) {
      const first = matches[index];
      const last = matches[index + size - 1];
      windows.push({
        start: first.index,
        end: last.index + last[0].length,
        text: String(value).slice(first.index, last.index + last[0].length),
      });
    }
  }
  return windows;
}

function fuzzyPhraseScore(query, phrase) {
  const compactPhrase = compactText(phrase);
  if (compactPhrase.length < FUZZY_MINIMUM_CHARACTERS || /\d/u.test(compactPhrase)) return 0;
  const phraseLanguage = detectTermLanguage(phrase);
  const phraseTokenCount = Math.max(1, searchTokens(phrase).length);
  let best = 0;
  for (const window of candidateWindows(query, phraseTokenCount)) {
    if (detectTermLanguage(window.text) !== phraseLanguage) continue;
    const compactWindow = compactText(window.text);
    const distance = levenshteinDistance(compactWindow, compactPhrase);
    const maximumDistance = compactPhrase.length <= 8 ? 1 : 2;
    if (distance <= maximumDistance) best = Math.max(best, similarity(window.text, phrase));
  }
  return best;
}

function contextualScore(queryTokens, phrase) {
  const tokens = [...new Set(searchTokens(phrase))];
  if (tokens.length < 2) return 0;
  const matched = tokens.filter((token) => queryTokens.has(token)).length;
  if (matched < 2) return 0;
  const coverage = matched / tokens.length;
  return coverage >= 0.6 ? coverage : 0;
}

function addRepairMapping(map, alias, canonical, isProperNoun) {
  const from = String(alias ?? "").trim();
  const to = String(canonical ?? "").trim();
  if (!isProperNoun || !from || !to || normalizeText(from) === normalizeText(to)) return;
  const language = detectTermLanguage(from);
  if (language === "unknown" || detectTermLanguage(to) !== language) return;
  if (/\d/u.test(from) || /\d/u.test(to)) return;
  const key = `${language}\u0000${normalizeText(from)}`;
  if (!map.has(key)) map.set(key, { from, to, language });
}

function groupTermsByLanguage(terms) {
  const groups = new Map();
  for (const term of terms) {
    const language = detectTermLanguage(term);
    const group = groups.get(language) ?? [];
    group.push(term);
    groups.set(language, group);
  }
  return groups;
}

function addCanonicalCandidate(canonicalCandidates, term, language) {
  if (!term || language === "unknown" || /\d/u.test(term)) return;
  canonicalCandidates.push({ term, language });
}

function collectRepairMappings(pair, isProperNoun, repairMap, canonicalCandidates) {
  const leftByLanguage = groupTermsByLanguage(pair.left);
  const rightByLanguage = groupTermsByLanguage(pair.right);
  for (const language of new Set([...leftByLanguage.keys(), ...rightByLanguage.keys()])) {
    if (language === "unknown") continue;
    const left = leftByLanguage.get(language) ?? [];
    const right = rightByLanguage.get(language) ?? [];
    if (isProperNoun && left.length > 0 && right.length > 0) {
      const canonical = right[0];
      for (const alias of [...left, ...right.slice(1)]) addRepairMapping(repairMap, alias, canonical, true);
      addCanonicalCandidate(canonicalCandidates, canonical, language);
      continue;
    }
    const variants = left.length > 0 ? left : right;
    if (isProperNoun && variants.length > 0) {
      const canonical = variants[0];
      for (const alias of variants.slice(1)) addRepairMapping(repairMap, alias, canonical, true);
      addCanonicalCandidate(canonicalCandidates, canonical, language);
    }
    const otherVariants = left.length > 0 && right.length > 0 ? right : [];
    if (isProperNoun && otherVariants.length > 0) {
      const canonical = otherVariants[0];
      for (const alias of otherVariants.slice(1)) addRepairMapping(repairMap, alias, canonical, true);
      addCanonicalCandidate(canonicalCandidates, canonical, language);
    }
  }
}

function parseGlossary(glossary) {
  const entries = [];
  const globalRules = [];
  const repairMap = new Map();
  const canonicalCandidates = [];
  let header = "";
  let isNumericSection = false;
  let isProperNoun = false;
  for (const rawLine of String(glossary ?? "").normalize("NFC").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (HEADER_PATTERN.test(line)) {
      header = line;
      isNumericSection = NUMERIC_SECTION_PATTERN.test(header);
      isProperNoun = PROPER_NOUN_SECTION_PATTERN.test(header);
      continue;
    }
    if (isNumericSection) continue;
    const registeredRuleAliases = parseRegisteredAliasRule(line);
    if (registeredRuleAliases.length > 0) {
      entries.push({ header, line, phrases: registeredRuleAliases, isProperNoun: true });
      continue;
    }
    if (/^\[(?:규칙|rules?)\]$/iu.test(header) && /^[-*•]/u.test(line)) {
      globalRules.push(line);
      continue;
    }
    if (/^[-*•※]/u.test(line)) continue;
    const pair = parsePair(line);
    if (!pair) continue;
    const phrases = [...new Set([...pair.left, ...pair.right])];
    const isRegisteredName = isProperNoun || isLikelyRegisteredNamePair(pair);
    entries.push({ header, line, phrases, isProperNoun: isRegisteredName });
    collectRepairMappings(pair, isRegisteredName, repairMap, canonicalCandidates);
  }
  const repairs = [...repairMap.values()].sort((a, b) => b.from.length - a.from.length);
  const canonical = [...new Map(canonicalCandidates.map((candidate) => [
    `${candidate.language}\u0000${normalizeText(candidate.term)}`,
    candidate,
  ])).values()];
  return {
    entries,
    globalRules,
    repairs,
    canonicalCandidates: canonical,
    exactRepairs: [
      ...repairs,
      ...canonical.map((candidate) => ({
        from: candidate.term,
        to: candidate.term,
        language: candidate.language,
      })),
    ],
  };
}

function emptyGlossaryIndex() {
  return {
    entries: [],
    globalRules: [],
    repairs: [],
    canonicalCandidates: [],
    exactRepairs: [],
  };
}

function appendBounded(lines, value, maximumCharacters) {
  const line = String(value ?? "").trim();
  if (!line || lines.includes(line)) return false;
  const nextLength = lines.join("\n").length + (lines.length ? 1 : 0) + line.length;
  if (nextLength > maximumCharacters) return false;
  lines.push(line);
  return true;
}

function normalizedMatchView(value) {
  const original = String(value ?? "");
  let normalized = "";
  const spans = [];
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  for (const segment of segmenter.segment(original)) {
    const start = segment.index;
    const end = start + segment.segment.length;
    const piece = segment.segment.normalize("NFKC").toLocaleLowerCase();
    normalized += piece;
    for (let index = 0; index < piece.length; index += 1) spans.push({ start, end });
  }
  return { original, normalized, spans };
}

function replaceExactAlias(text, mapping) {
  const view = normalizedMatchView(text);
  const needle = String(mapping.from).normalize("NFKC").toLocaleLowerCase();
  const canonical = String(mapping.to).normalize("NFKC").toLocaleLowerCase();
  if (!needle) return text;
  const matches = [];
  let offset = view.normalized.indexOf(needle);
  while (offset >= 0) {
    const before = view.normalized[offset - 1] ?? "";
    const after = view.normalized[offset + needle.length] ?? "";
    const hasLatinEdge = LATIN_OR_NUMBER_PATTERN.test(needle[0] ?? "")
      || LATIN_OR_NUMBER_PATTERN.test(needle.at(-1) ?? "");
    if (!hasLatinEdge || (!/[a-z0-9]/iu.test(before) && !/[a-z0-9]/iu.test(after))) {
      const firstSpan = view.spans[offset];
      let normalizedEnd = offset + needle.length;
      // A provider can emit a registered alias followed by the canonical
      // tail. Consume that existing tail so replacement cannot duplicate it,
      // while leaving an attached Korean particle outside the replaced span.
      for (let canonicalOffset = 1; canonicalOffset < canonical.length; canonicalOffset += 1) {
        const canonicalTail = canonical.slice(canonicalOffset);
        if (compactText(canonicalTail).length < 3) continue;
        if (view.normalized.startsWith(canonicalTail, normalizedEnd)) {
          normalizedEnd += canonicalTail.length;
          break;
        }
      }
      const lastSpan = view.spans[normalizedEnd - 1];
      if (firstSpan && lastSpan) matches.push({ start: firstSpan.start, end: lastSpan.end });
    }
    offset = view.normalized.indexOf(needle, offset + 1);
  }
  if (matches.length === 0) return text;
  let result = view.original;
  for (const match of matches.reverse()) {
    result = `${result.slice(0, match.start)}${mapping.to}${result.slice(match.end)}`;
  }
  return result;
}

function replaceFusedAlias(value, mapping) {
  const aliasTokens = searchTokens(mapping.from);
  const canonicalTokens = searchTokens(mapping.to);
  const tail = canonicalTokens.at(-1);
  if (aliasTokens.length !== 1 || canonicalTokens.length < 2 || !tail) return value;
  const alias = mapping.from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedTail = tail.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${alias}(?:and|end|n)?(?:\\s+[\\p{L}]+){0,2}\\s+${escapedTail}(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return value.replace(pattern, mapping.to);
}

function repairFuzzyAlias(value, mappings, language) {
  // Hangul is agglutinative: a token window includes particles/endings, so a
  // fuzzy whole-token replacement can silently delete "가/는/에서". Korean
  // registered variants still use the exact alias path; fuzzy repair is kept
  // to space-delimited English ASR variants where the replaced span is safe.
  if (language !== "en") return value;
  let text = value;
  let repairCount = 0;
  while (repairCount < MAX_REPAIRS) {
    let best = null;
    let secondBestScore = 0;
    for (const mapping of mappings) {
      if (mapping.language !== language) continue;
      const compactCandidate = compactText(mapping.from);
      if (compactCandidate.length < FUZZY_MINIMUM_CHARACTERS || /\d/u.test(compactCandidate)) continue;
      if (phraseIsContained(normalizeText(text), mapping.from)) continue;
      const tokenCount = Math.max(1, searchTokens(mapping.from).length);
      for (const window of candidateWindows(text, tokenCount)) {
        if (detectTermLanguage(window.text) !== language) continue;
        const distance = levenshteinDistance(compactText(window.text), compactCandidate);
        const maximumDistance = compactCandidate.length <= 8 ? 1 : 2;
        if (distance > maximumDistance) continue;
        const score = similarity(window.text, mapping.from);
        if (!best || score > best.score) {
          secondBestScore = best?.score ?? secondBestScore;
          best = { ...window, score, replacement: mapping.to };
        } else if (score > secondBestScore) {
          secondBestScore = score;
        }
      }
    }
    if (!best || best.score < FUZZY_MINIMUM_SIMILARITY) break;
    if (secondBestScore > 0 && best.score - secondBestScore < FUZZY_MINIMUM_MARGIN) break;
    if (normalizeText(best.text) === normalizeText(best.replacement)) break;
    text = `${text.slice(0, best.start)}${best.replacement}${text.slice(best.end)}`;
    repairCount += 1;
  }
  return text;
}

function validCompiledGlossary(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) return false;
  if (!COMPILED_FINGERPRINT_PATTERN.test(String(value.fingerprint ?? ""))) return false;
  if (!Number.isSafeInteger(value.version) || value.version < 1) return false;
  if (typeof value.sourceLanguage !== "string" || !value.sourceLanguage.trim()) return false;
  if (!Array.isArray(value.targetLanguages) || !Array.isArray(value.terms)
    || !Array.isArray(value.lookupEntries) || !Array.isArray(value.translationRules)
    || !Array.isArray(value.doNotTranslate) || !Array.isArray(value.contextEntries)) return false;
  if (value.terms.length > MAX_COMPILED_TERMS || value.targetLanguages.length > 13
    || value.lookupEntries.length > value.terms.length * 17
    || value.translationRules.length > value.terms.length * 13
    || value.doNotTranslate.length > value.terms.length
    || value.contextEntries.length > value.terms.length) return false;
  const termIds = new Set();
  for (const term of value.terms) {
    if (!term || typeof term !== "object" || typeof term.id !== "string" || !term.id
      || typeof term.source !== "string" || !term.source || termIds.has(term.id)
      || !Array.isArray(term.aliases) || term.aliases.length > 16
      || !Array.isArray(term.forbiddenTranslations) || term.forbiddenTranslations.length > 16
      || !Array.isArray(term.examples) || term.examples.length > 8
      || !Array.isArray(term.tags) || term.tags.length > 16
      || !term.translations || typeof term.translations !== "object") return false;
    termIds.add(term.id);
  }
  for (const entries of [value.lookupEntries, value.translationRules, value.doNotTranslate, value.contextEntries]) {
    if (!entries.every((entry) => entry && typeof entry === "object" && termIds.has(entry.termId))) return false;
  }
  if (value.translationRules.some((rule) => !Array.isArray(rule.forbiddenTranslations)
    || rule.forbiddenTranslations.length > 16)) return false;
  return value.contextEntries.every((entry) => Array.isArray(entry.tokens));
}

function compiledCacheKey(compiledGlossary) {
  return `${compiledGlossary.version}\u0000${compiledGlossary.fingerprint}`;
}

function addToMapList(map, key, value) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function compiledLanguage(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sortSpecificRepairMappings(mappings) {
  return mappings
    .map((mapping, index) => ({ mapping, index }))
    .sort((left, right) => (
      compactText(right.mapping.from).length - compactText(left.mapping.from).length
      || (right.mapping.priority ?? 0) - (left.mapping.priority ?? 0)
      || left.index - right.index
    ))
    .map(({ mapping }) => mapping);
}

function expandComposedTargetMappings(mappings) {
  const exactMappings = new Map();
  for (const mapping of mappings) {
    addToMapList(exactMappings, normalizeText(mapping.from), mapping);
  }
  const composed = [];
  const seen = new Set(mappings.map((mapping) => `${normalizeText(mapping.from)}\u0000${normalizeText(mapping.to)}`));
  for (const mapping of mappings) {
    if (mapping.kind !== "forbidden") continue;
    const tokens = searchTokens(mapping.from);
    const embedded = new Set();
    for (let start = 0; start < tokens.length; start += 1) {
      for (let size = 1; size <= 8 && start + size <= tokens.length; size += 1) {
        for (const candidate of exactMappings.get(normalizeText(tokens.slice(start, start + size).join(" "))) ?? []) {
          if (candidate === mapping
            || compactText(candidate.from).length >= compactText(mapping.from).length
            || normalizeText(candidate.to) === normalizeText(mapping.to)) continue;
          embedded.add(candidate);
        }
      }
    }
    let from = mapping.from;
    for (const candidate of sortSpecificRepairMappings([...embedded])) {
      from = replaceExactAlias(from, candidate);
    }
    const key = `${normalizeText(from)}\u0000${normalizeText(mapping.to)}`;
    if (normalizeText(from) === normalizeText(mapping.from) || seen.has(key)) continue;
    seen.add(key);
    composed.push({ ...mapping, from, kind: "composed" });
  }
  return sortSpecificRepairMappings([...mappings, ...composed]);
}

function compileRepairMatcher(mappings) {
  const buckets = new Map();
  const seenNeedles = new Set();
  let rank = 0;
  for (const mapping of sortSpecificRepairMappings(mappings)) {
    const needle = String(mapping.from ?? "").normalize("NFKC").toLocaleLowerCase();
    if (!needle || seenNeedles.has(needle)) continue;
    seenNeedles.add(needle);
    const firstCharacter = needle[0];
    const bucket = buckets.get(firstCharacter) ?? { lengths: new Set(), byNeedle: new Map() };
    bucket.lengths.add(needle.length);
    bucket.byNeedle.set(needle, {
      mapping,
      needle,
      canonical: String(mapping.to ?? "").normalize("NFKC").toLocaleLowerCase(),
      rank,
    });
    buckets.set(firstCharacter, bucket);
    rank += 1;
  }
  for (const bucket of buckets.values()) {
    bucket.lengths = [...bucket.lengths].sort((left, right) => right - left);
  }
  return { buckets };
}

function repairWithCompiledMatcher(value, matcher) {
  if (!matcher || matcher.buckets.size === 0) return value;
  const view = normalizedMatchView(value);
  const candidates = [];
  for (let offset = 0; offset < view.normalized.length; offset += 1) {
    const bucket = matcher.buckets.get(view.normalized[offset]);
    if (!bucket) continue;
    for (const length of bucket.lengths) {
      if (offset + length > view.normalized.length) continue;
      const entry = bucket.byNeedle.get(view.normalized.slice(offset, offset + length));
      if (!entry) continue;
      const before = view.normalized[offset - 1] ?? "";
      const after = view.normalized[offset + entry.needle.length] ?? "";
      const hasLatinEdge = LATIN_OR_NUMBER_PATTERN.test(entry.needle[0] ?? "")
        || LATIN_OR_NUMBER_PATTERN.test(entry.needle.at(-1) ?? "");
      if (hasLatinEdge && (/[a-z0-9]/iu.test(before) || /[a-z0-9]/iu.test(after))) continue;
      let normalizedEnd = offset + entry.needle.length;
      for (let canonicalOffset = 1; canonicalOffset < entry.canonical.length; canonicalOffset += 1) {
        const canonicalTail = entry.canonical.slice(canonicalOffset);
        if (compactText(canonicalTail).length < 3) continue;
        if (view.normalized.startsWith(canonicalTail, normalizedEnd)) {
          normalizedEnd += canonicalTail.length;
          break;
        }
      }
      const firstSpan = view.spans[offset];
      const lastSpan = view.spans[normalizedEnd - 1];
      if (firstSpan && lastSpan) {
        candidates.push({
          start: firstSpan.start,
          end: lastSpan.end,
          rank: entry.rank,
          replacement: entry.mapping.to,
        });
      }
    }
  }
  if (candidates.length === 0) return value;
  candidates.sort((left, right) => left.rank - right.rank || left.start - right.start || right.end - left.end);
  const occupied = new Uint8Array(view.original.length);
  const accepted = [];
  for (const candidate of candidates) {
    let hasOverlap = false;
    for (let index = candidate.start; index < candidate.end; index += 1) {
      if (occupied[index] === 1) {
        hasOverlap = true;
        break;
      }
    }
    if (hasOverlap) continue;
    occupied.fill(1, candidate.start, candidate.end);
    accepted.push(candidate);
  }
  let repaired = view.original;
  accepted.sort((left, right) => right.start - left.start || right.end - left.end);
  for (const match of accepted) {
    repaired = `${repaired.slice(0, match.start)}${match.replacement}${repaired.slice(match.end)}`;
  }
  return repaired;
}

function repairCompiledFuzzyAlias(value, runtime, language) {
  if (language !== "en") return value;
  let text = value;
  let repairCount = 0;
  while (repairCount < MAX_REPAIRS) {
    let best = null;
    let secondBestScore = 0;
    const normalizedText = normalizeText(text);
    for (const tokenCount of runtime.fuzzyTokenCounts) {
      for (const window of candidateWindows(text, tokenCount)) {
        if (detectTermLanguage(window.text) !== language) continue;
        const compactWindow = compactText(window.text);
        if (compactWindow.length < FUZZY_MINIMUM_CHARACTERS || /\d/u.test(compactWindow)) continue;
        for (let length = compactWindow.length - 2; length <= compactWindow.length + 2; length += 1) {
          for (const entry of runtime.fuzzyLookup.get(`${compactWindow[0]}\u0000${length}`) ?? []) {
            if (phraseIsContained(normalizedText, entry.value)) continue;
            const distance = levenshteinDistance(compactWindow, compactText(entry.value));
            const maximumDistance = compactText(entry.value).length <= 8 ? 1 : 2;
            if (distance > maximumDistance) continue;
            const score = similarity(window.text, entry.value);
            const replacement = runtime.sourceEntryByTermId.get(entry.termId)?.value;
            if (!replacement) continue;
            if (!best || score > best.score) {
              secondBestScore = best?.score ?? secondBestScore;
              best = { ...window, score, replacement };
            } else if (score > secondBestScore) {
              secondBestScore = score;
            }
          }
        }
      }
    }
    if (!best || best.score < FUZZY_MINIMUM_SIMILARITY) break;
    if (secondBestScore > 0 && best.score - secondBestScore < FUZZY_MINIMUM_MARGIN) break;
    if (normalizeText(best.text) === normalizeText(best.replacement)) break;
    text = `${text.slice(0, best.start)}${best.replacement}${text.slice(best.end)}`;
    repairCount += 1;
  }
  return text;
}

function compileRuntimeIndex(compiledGlossary) {
  const termById = new Map(compiledGlossary.terms.map((term) => [term.id, term]));
  const sourceEntryByTermId = new Map();
  const lookupByTermId = new Map();
  const exactLookup = new Map();
  const initialLookup = new Map();
  const fuzzyLookup = new Map();
  const fuzzyTokenCounts = new Set();
  const contextByToken = new Map();
  const contextTokensByTermId = new Map();
  const translationByTermAndLanguage = new Map();
  const doNotTranslateIds = new Set(compiledGlossary.doNotTranslate.map((entry) => entry.termId));
  const sourceLanguage = compiledLanguage(compiledGlossary.sourceLanguage);

  for (const entry of compiledGlossary.lookupEntries) {
    if (typeof entry.value !== "string" || !entry.value.trim()
      || !["source", "alias"].includes(entry.kind)) continue;
    const normalizedValue = normalizeText(entry.normalizedValue || entry.value);
    if (!normalizedValue) continue;
    const runtimeEntry = Object.freeze({
      termId: entry.termId,
      kind: entry.kind,
      value: entry.value,
      normalizedValue,
      priority: Number.isFinite(entry.priority) ? entry.priority : 50,
    });
    addToMapList(lookupByTermId, entry.termId, runtimeEntry);
    addToMapList(exactLookup, normalizedValue, runtimeEntry);
    addToMapList(initialLookup, compactText(normalizedValue)[0] ?? "", runtimeEntry);
    const compactValue = compactText(normalizedValue);
    if (compactValue.length >= FUZZY_MINIMUM_CHARACTERS && !/\d/u.test(compactValue)) {
      addToMapList(fuzzyLookup, `${compactValue[0]}\u0000${compactValue.length}`, runtimeEntry);
      fuzzyTokenCounts.add(Math.max(1, searchTokens(entry.value).length));
    }
    if (entry.kind === "source" && !sourceEntryByTermId.has(entry.termId)) {
      sourceEntryByTermId.set(entry.termId, runtimeEntry);
    }
  }
  for (const rule of compiledGlossary.translationRules) {
    if (typeof rule.targetLanguage !== "string" || typeof rule.target !== "string" || !rule.target.trim()) continue;
    translationByTermAndLanguage.set(
      `${rule.termId}\u0000${compiledLanguage(rule.targetLanguage)}`,
      rule,
    );
  }
  for (const entry of compiledGlossary.contextEntries) {
    if (!Array.isArray(entry.tokens)) continue;
    const tokens = [...new Set(entry.tokens.map(normalizeText).filter(Boolean))];
    contextTokensByTermId.set(entry.termId, tokens);
    for (const token of tokens) addToMapList(contextByToken, token, entry.termId);
  }

  const sourceRepairs = [];
  const targetRepairs = new Map();
  for (const term of compiledGlossary.terms) {
    const sourceEntry = sourceEntryByTermId.get(term.id);
    if (!sourceEntry) continue;
    sourceRepairs.push({ from: sourceEntry.value, to: sourceEntry.value, language: sourceLanguage });
    for (const lookup of lookupByTermId.get(term.id) ?? []) {
      if (lookup.kind === "alias") {
        sourceRepairs.push({ from: lookup.value, to: sourceEntry.value, language: sourceLanguage });
      }
    }
    for (const targetLanguage of compiledGlossary.targetLanguages) {
      const language = compiledLanguage(targetLanguage);
      const rule = translationByTermAndLanguage.get(`${term.id}\u0000${language}`);
      if (!rule) continue;
      const mappings = targetRepairs.get(language) ?? [];
      const variants = [
        { from: sourceEntry.value, kind: "source" },
        ...(term.aliases ?? []).map((from) => ({ from, kind: "alias" })),
        ...(rule.forbiddenTranslations ?? []).map((from) => ({ from, kind: "forbidden" })),
      ];
      const seenVariants = new Set();
      for (const { from, kind } of variants) {
        const normalizedVariant = normalizeText(from);
        if (!normalizedVariant || seenVariants.has(normalizedVariant)) continue;
        seenVariants.add(normalizedVariant);
        mappings.push({
          from,
          to: rule.target,
          language,
          priority: rule.priority ?? term.priority ?? 50,
          kind,
        });
      }
      targetRepairs.set(language, mappings);
    }
  }
  for (const [language, mappings] of targetRepairs) {
    targetRepairs.set(language, expandComposedTargetMappings(mappings));
  }
  const targetRepairMatchers = new Map();
  for (const [language, mappings] of targetRepairs) {
    targetRepairMatchers.set(language, compileRepairMatcher(mappings));
  }

  return {
    termById,
    sourceEntryByTermId,
    exactLookup,
    initialLookup,
    fuzzyLookup,
    fuzzyTokenCounts,
    contextByToken,
    contextTokensByTermId,
    translationByTermAndLanguage,
    doNotTranslateIds,
    sourceLanguage,
    sourceRepairMatcher: compileRepairMatcher(sourceRepairs),
    targetRepairMatchers,
    queryCache: new Map(),
  };
}

function compiledTextBytes(value) {
  return typeof value === "string" ? value.length * 2 : 0;
}

function estimateCompiledIndexBytes(compiledGlossary) {
  let bytes = 64 * 1024;
  const termsById = new Map();
  for (const term of compiledGlossary.terms) {
    termsById.set(term.id, term);
    bytes += 384 + compiledTextBytes(term.id) + compiledTextBytes(term.source)
      + compiledTextBytes(term.context) + compiledTextBytes(term.pronunciation);
    for (const value of [...term.aliases, ...term.forbiddenTranslations, ...term.examples, ...term.tags]) {
      bytes += 48 + compiledTextBytes(value);
    }
    for (const [language, target] of Object.entries(term.translations)) {
      bytes += 64 + compiledTextBytes(language) + compiledTextBytes(target);
    }
  }
  for (const entry of compiledGlossary.lookupEntries) {
    bytes += 160 + compiledTextBytes(entry.termId) + compiledTextBytes(entry.value)
      + compiledTextBytes(entry.normalizedValue);
  }
  for (const rule of compiledGlossary.translationRules) {
    const term = termsById.get(rule.termId);
    const repairEntries = 1 + (term?.aliases.length ?? 0) + (rule.forbiddenTranslations.length * 2);
    bytes += 192 + compiledTextBytes(rule.termId) + compiledTextBytes(rule.targetLanguage)
      + compiledTextBytes(rule.target) + repairEntries * 144;
    for (const forbidden of rule.forbiddenTranslations) bytes += 48 + compiledTextBytes(forbidden);
  }
  for (const entry of compiledGlossary.contextEntries) {
    bytes += 128 + compiledTextBytes(entry.termId);
    for (const token of entry.tokens) bytes += 32 + compiledTextBytes(token);
  }
  bytes += compiledGlossary.doNotTranslate.length * 128;
  for (const term of compiledGlossary.terms) bytes += (1 + term.aliases.length) * 144;
  return bytes;
}

function removeCompiledRecord(record) {
  if (!record || !compiledCacheRecords.delete(record)) return;
  if (compiledSessionIndexes.get(record.sessionId) === record) {
    compiledSessionIndexes.delete(record.sessionId);
  }
  compiledCacheBytes = Math.max(0, compiledCacheBytes - record.bytes);
}

function evictInactiveCompiledRecords(requiredBytes) {
  if (requiredBytes > MAX_COMPILED_CACHE_BYTES) return false;
  while (compiledCacheRecords.size >= MAX_COMPILED_SESSION_ENTRIES
    || compiledCacheBytes + requiredBytes > MAX_COMPILED_CACHE_BYTES) {
    let oldestInactive = null;
    for (const record of compiledSessionIndexes.values()) {
      if (record.references === 0) {
        oldestInactive = record;
        break;
      }
    }
    if (!oldestInactive) return false;
    removeCompiledRecord(oldestInactive);
  }
  return true;
}

function acquireCompiledIndex(sessionId, compiledGlossary) {
  const normalizedSessionId = String(sessionId ?? "").trim();
  if (!normalizedSessionId || normalizedSessionId.length > 128 || !validCompiledGlossary(compiledGlossary)) return null;
  const fence = compiledCacheKey(compiledGlossary);
  const existing = compiledSessionIndexes.get(normalizedSessionId);
  if (existing?.fence === fence) {
    existing.references += 1;
    compiledSessionIndexes.delete(normalizedSessionId);
    compiledSessionIndexes.set(normalizedSessionId, existing);
    return existing;
  }
  if (existing?.references === 0) removeCompiledRecord(existing);
  const estimatedBytes = estimateCompiledIndexBytes(compiledGlossary);
  if (!evictInactiveCompiledRecords(estimatedBytes)) return null;
  let index;
  try {
    index = compileRuntimeIndex(compiledGlossary);
  } catch {
    return null;
  }
  const record = {
    sessionId: normalizedSessionId,
    fence,
    references: 1,
    bytes: estimatedBytes,
    index,
  };
  compiledCacheRecords.add(record);
  compiledCacheBytes += estimatedBytes;
  compiledSessionIndexes.set(normalizedSessionId, record);
  return record;
}

function isActiveCompiledRecord(record) {
  return Boolean(record && record.references > 0 && compiledSessionIndexes.get(record.sessionId) === record);
}

function releaseCompiledIndex(record) {
  if (!record || record.references < 1) return;
  record.references -= 1;
  if (record.references === 0 && compiledSessionIndexes.get(record.sessionId) !== record) removeCompiledRecord(record);
}

function queryNgrams(rawQuery) {
  const tokens = searchTokens(rawQuery);
  const values = new Set();
  for (let start = 0; start < tokens.length; start += 1) {
    for (let size = 1; size <= 8 && start + size <= tokens.length; size += 1) {
      values.add(normalizeText(tokens.slice(start, start + size).join(" ")));
    }
  }
  return { tokens, values };
}

function rankCompiledEntries(runtime, rawQuery) {
  const normalizedQuery = normalizeText(rawQuery);
  const { tokens, values } = queryNgrams(rawQuery);
  const queryTokenSet = new Set(tokens.map(normalizeText));
  const rankedByTermId = new Map();
  const note = (entry, matchClass, matchScore = 0) => {
    const classScore = matchClass === "exact" ? (entry.kind === "source" ? 4 : 3)
      : matchClass === "context" ? 2 : 1;
    const candidate = {
      termId: entry.termId,
      classScore,
      matchScore,
      priority: entry.priority,
    };
    const previous = rankedByTermId.get(entry.termId);
    if (!previous || candidate.classScore > previous.classScore
      || (candidate.classScore === previous.classScore && candidate.matchScore > previous.matchScore)) {
      rankedByTermId.set(entry.termId, candidate);
    }
  };

  for (const value of values) {
    for (const entry of runtime.exactLookup.get(value) ?? []) note(entry, "exact", value.length);
  }
  for (const token of tokens) {
    const initial = compactText(token)[0] ?? "";
    for (const entry of runtime.initialLookup.get(initial) ?? []) {
      if (phraseIsContained(normalizedQuery, entry.normalizedValue)) note(entry, "exact", entry.normalizedValue.length);
    }
  }
  const contextCounts = new Map();
  for (const token of queryTokenSet) {
    for (const termId of runtime.contextByToken.get(token) ?? []) {
      contextCounts.set(termId, (contextCounts.get(termId) ?? 0) + 1);
    }
  }
  for (const [termId, count] of contextCounts) {
    const contextTokens = runtime.contextTokensByTermId.get(termId) ?? [];
    const coverage = contextTokens.length > 0 ? count / contextTokens.length : 0;
    if (count >= 2 && coverage >= 0.6) {
      const entry = runtime.sourceEntryByTermId.get(termId);
      if (entry) note(entry, "context", coverage);
    }
  }

  const fuzzyByWindow = new Map();
  for (const tokenCount of runtime.fuzzyTokenCounts) {
    for (const window of candidateWindows(rawQuery, tokenCount)) {
      const compactWindow = compactText(window.text);
      if (compactWindow.length < FUZZY_MINIMUM_CHARACTERS || /\d/u.test(compactWindow)) continue;
      const windowKey = `${window.start}\u0000${window.end}`;
      const candidates = fuzzyByWindow.get(windowKey) ?? new Map();
      for (let length = compactWindow.length - 2; length <= compactWindow.length + 2; length += 1) {
        for (const entry of runtime.fuzzyLookup.get(`${compactWindow[0]}\u0000${length}`) ?? []) {
          if (rankedByTermId.has(entry.termId)) continue;
          const score = similarity(window.text, entry.value);
          if (score < FUZZY_MINIMUM_SIMILARITY) continue;
          const previous = candidates.get(entry.termId);
          if (!previous || score > previous.score) candidates.set(entry.termId, { entry, score });
        }
      }
      if (candidates.size > 0) fuzzyByWindow.set(windowKey, candidates);
    }
  }
  for (const candidates of fuzzyByWindow.values()) {
    const ordered = [...candidates.values()].sort((left, right) => (
      right.score - left.score || right.entry.priority - left.entry.priority
    ));
    if (ordered[1] && ordered[0].score - ordered[1].score < FUZZY_MINIMUM_MARGIN) continue;
    note(ordered[0].entry, "fuzzy", ordered[0].score);
  }

  return [...rankedByTermId.values()].sort((left, right) => (
    right.classScore - left.classScore
    || right.matchScore - left.matchScore
    || right.priority - left.priority
    || left.termId.localeCompare(right.termId)
  ));
}

function renderCompiledSelection(runtime, ranked, targetLanguage) {
  const language = compiledLanguage(targetLanguage);
  const lines = [];
  for (const candidate of ranked) {
    if (lines.length >= MAX_RESULT_LINES) break;
    const source = runtime.sourceEntryByTermId.get(candidate.termId)?.value;
    if (!source) continue;
    const target = runtime.doNotTranslateIds.has(candidate.termId)
      ? source
      : runtime.translationByTermAndLanguage.get(`${candidate.termId}\u0000${language}`)?.target;
    if (!target) continue;
    appendBounded(lines, `${source} = ${target}`, MAX_PROMPT_CHARACTERS);
  }
  return lines.join("\n");
}

/**
 * Builds one in-memory index for a session glossary. No network, database, or
 * model call occurs in this layer.
 * @param {unknown} glossary
 */
export function createLocalTermRetriever(glossary, { sessionId = "", compiledGlossary = null } = {}) {
  const glossaryText = String(glossary ?? "");
  const index = glossaryText.length <= MAX_GLOSSARY_CHARACTERS
    ? parseGlossary(glossaryText)
    : emptyGlossaryIndex();
  const queryCache = new Map();
  const registeredAliases = new Set(index.repairs.map((mapping) => normalizeText(mapping.from)));
  const hasCompiledInput = compiledGlossary !== null && compiledGlossary !== undefined;
  const compiledRecord = hasCompiledInput ? acquireCompiledIndex(sessionId, compiledGlossary) : null;
  let isReleased = false;
  const hasActiveCompiledIndex = () => !isReleased && isActiveCompiledRecord(compiledRecord);

  function rankEntries(rawQuery) {
    const query = normalizeText(rawQuery);
    const tokens = new Set(searchTokens(query));
    const ranked = [];
    for (let indexPosition = 0; indexPosition < index.entries.length; indexPosition += 1) {
      const entry = index.entries[indexPosition];
      let exactScore = 0;
      let fuzzyScore = 0;
      let contextScore = 0;
      for (const phrase of entry.phrases) {
        if (phraseIsContained(query, phrase)) exactScore = Math.max(exactScore, 100 + compactText(phrase).length);
        else contextScore = Math.max(contextScore, contextualScore(tokens, phrase));
        if (entry.isProperNoun && registeredAliases.has(normalizeText(phrase))) {
          fuzzyScore = Math.max(fuzzyScore, fuzzyPhraseScore(rawQuery, phrase));
        }
      }
      const hasExact = exactScore > 0;
      const hasFuzzy = fuzzyScore >= FUZZY_MINIMUM_SIMILARITY;
      const hasContext = contextScore >= 0.75;
      if (hasExact || hasFuzzy || hasContext) {
        const score = exactScore || (hasFuzzy ? 80 + fuzzyScore : 60 + contextScore);
        ranked.push({ entry, score, indexPosition });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.indexPosition - b.indexPosition);
    return ranked;
  }

  function buildSelection(ranked) {
    const lines = [];
    if (index.globalRules.length > 0) {
      appendBounded(lines, "[규칙]", MAX_GLOBAL_RULE_CHARACTERS);
      for (const rule of index.globalRules) appendBounded(lines, rule, MAX_GLOBAL_RULE_CHARACTERS);
    }
    let resultCount = 0;
    let previousHeader = "";
    for (const { entry } of ranked) {
      if (resultCount >= MAX_RESULT_LINES) break;
      const beforeHeader = lines.length;
      if (entry.header && entry.header !== previousHeader) {
        appendBounded(lines, entry.header, MAX_PROMPT_CHARACTERS);
      }
      if (!appendBounded(lines, entry.line, MAX_PROMPT_CHARACTERS)) {
        if (lines.length > beforeHeader && lines.at(-1) === entry.header) lines.pop();
        continue;
      }
      previousHeader = entry.header;
      resultCount += 1;
    }
    return lines.join("\n");
  }

  function retrieve({ sourceText = "", translatedText = "", targetLanguage = "", isFinal = true } = {}) {
    const rawQuery = `${sourceText ?? ""}\n${translatedText ?? ""}`.trim();
    if (rawQuery.length > MAX_QUERY_CHARACTERS) return "";
    if (hasCompiledInput) {
      if (isFinal !== true || !hasActiveCompiledIndex()) return "";
      const language = compiledLanguage(targetLanguage);
      const cacheKey = `${language}\u0000${rawQuery.normalize("NFC")}`;
      if (compiledRecord.index.queryCache.has(cacheKey)) return compiledRecord.index.queryCache.get(cacheKey);
      const result = renderCompiledSelection(
        compiledRecord.index,
        rankCompiledEntries(compiledRecord.index, rawQuery),
        language,
      );
      compiledRecord.index.queryCache.set(cacheKey, result);
      if (compiledRecord.index.queryCache.size > MAX_QUERY_CACHE_ENTRIES) {
        compiledRecord.index.queryCache.delete(compiledRecord.index.queryCache.keys().next().value);
      }
      return result;
    }
    const cacheKey = rawQuery.normalize("NFC");
    if (queryCache.has(cacheKey)) return queryCache.get(cacheKey);
    const result = buildSelection(rankEntries(rawQuery));
    queryCache.set(cacheKey, result);
    if (queryCache.size > MAX_QUERY_CACHE_ENTRIES) queryCache.delete(queryCache.keys().next().value);
    return result;
  }

  function repair(value, { language = "", isFinal = true } = {}) {
    const raw = String(value ?? "");
    if (!raw || raw.length > MAX_QUERY_CHARACTERS || !LETTER_OR_NUMBER_PATTERN.test(raw)) return raw;
    const normalizedLanguage = String(language ?? "").trim().toLowerCase();
    if (!new Set(["en", "ko", "ja"]).has(normalizedLanguage)) return raw;
    let repaired = raw;
    for (const mapping of index.exactRepairs) {
      if (mapping.language !== normalizedLanguage) continue;
      repaired = replaceFusedAlias(repaired, mapping);
      repaired = replaceExactAlias(repaired, mapping);
    }
    repaired = isFinal ? repairFuzzyAlias(repaired, index.repairs, normalizedLanguage) : repaired;
    if (!isFinal || !hasCompiledInput || !hasActiveCompiledIndex()) return repaired;
    const runtime = compiledRecord.index;
    const matcher = normalizedLanguage === runtime.sourceLanguage
      ? runtime.sourceRepairMatcher
      : runtime.targetRepairMatchers.get(normalizedLanguage);
    repaired = repairWithCompiledMatcher(repaired, matcher);
    if (normalizedLanguage === runtime.sourceLanguage) {
      repaired = repairCompiledFuzzyAlias(repaired, runtime, normalizedLanguage);
    }
    return repaired;
  }

  /**
   * Reports whether a source-side glossary match still lacks a target-language
   * rendering after deterministic repair. This is evidence for the optional
   * text model, never a reason to send an entire glossary or an ordinary cue.
   */
  function assess({ sourceText = "", translatedText = "", targetLanguage = "" } = {}) {
    const source = String(sourceText ?? "").trim();
    const translated = String(translatedText ?? "").trim();
    const language = String(targetLanguage ?? "").trim().toLowerCase();
    if (!source || source.length > MAX_QUERY_CHARACTERS || translated.length > MAX_QUERY_CHARACTERS) {
      return Object.freeze({ selectedGlossary: "", hasSourceTerm: false, isTargetSatisfied: false, hasUnresolvedTerm: false });
    }
    if (hasCompiledInput) {
      if (!hasActiveCompiledIndex()) {
        return Object.freeze({ selectedGlossary: "", hasSourceTerm: false, isTargetSatisfied: false, hasUnresolvedTerm: false });
      }
      const sourceMatches = rankCompiledEntries(compiledRecord.index, source);
      const selectedGlossary = renderCompiledSelection(compiledRecord.index, sourceMatches, language);
      const normalizedTranslation = normalizeText(translated);
      let isTargetSatisfied = false;
      let hasUnresolvedTerm = false;
      for (const match of sourceMatches.slice(0, MAX_RESULT_LINES)) {
        const target = compiledRecord.index.doNotTranslateIds.has(match.termId)
          ? compiledRecord.index.sourceEntryByTermId.get(match.termId)?.value
          : compiledRecord.index.translationByTermAndLanguage.get(`${match.termId}\u0000${language}`)?.target;
        if (!target) continue;
        const satisfied = phraseIsContained(normalizedTranslation, target);
        isTargetSatisfied ||= satisfied;
        hasUnresolvedTerm ||= !satisfied;
      }
      return Object.freeze({
        selectedGlossary,
        hasSourceTerm: Boolean(selectedGlossary),
        isTargetSatisfied,
        hasUnresolvedTerm,
      });
    }
    const sourceMatches = rankEntries(source);
    const selectedGlossary = buildSelection(sourceMatches);
    let hasSourceTerm = false;
    let isTargetSatisfied = false;
    let hasUnresolvedTerm = false;
    const normalizedTranslation = normalizeText(translated);
    for (const { entry } of sourceMatches.slice(0, MAX_RESULT_LINES)) {
      const targetPhrases = entry.phrases.filter((phrase) => {
        const phraseLanguage = detectTermLanguage(phrase);
        return phraseLanguage === language || phraseLanguage === "unknown";
      });
      if (targetPhrases.length === 0) continue;
      hasSourceTerm = true;
      const entrySatisfied = targetPhrases.some((phrase) => phraseIsContained(normalizedTranslation, phrase));
      isTargetSatisfied ||= entrySatisfied;
      hasUnresolvedTerm ||= !entrySatisfied;
    }
    return Object.freeze({ selectedGlossary, hasSourceTerm, isTargetSatisfied, hasUnresolvedTerm });
  }

  function release() {
    if (isReleased) return;
    isReleased = true;
    releaseCompiledIndex(compiledRecord);
  }

  function getProtectedTerms({ translatedText = "", targetLanguage = "" } = {}) {
    const text = String(translatedText ?? "").normalize("NFC");
    if (isReleased || !text || text.length > MAX_QUERY_CHARACTERS) return [];
    const terms = new Set();
    const include = (value) => {
      if (typeof value !== "string") return;
      const term = value.normalize("NFC").trim();
      if (!term || term.length > text.length) return;
      if (/\p{Script=Latin}/u.test(term) && text.includes(term)) terms.add(term);
    };
    if (hasCompiledInput) {
      if (!hasActiveCompiledIndex()) return [];
      const runtime = compiledRecord.index;
      const language = compiledLanguage(targetLanguage);
      for (const [termId, term] of runtime.termById) {
        include(runtime.doNotTranslateIds.has(termId) ? term.source
          : runtime.translationByTermAndLanguage.get(`${termId}\u0000${language}`)?.target);
      }
    } else {
      // Untyped legacy pairs cannot establish target-language semantics.
      // An exact identity pair is the only explicit preservation instruction.
      for (const entry of index.entries) {
        const pair = parsePair(entry.line);
        if (pair?.left.length === 1 && pair.right.length === 1 && pair.left[0] === pair.right[0]) include(pair.left[0]);
      }
    }
    return [...terms];
  }

  return Object.freeze({ retrieve, repair, assess, getProtectedTerms, release, isReady: !hasCompiledInput || Boolean(compiledRecord) });
}
