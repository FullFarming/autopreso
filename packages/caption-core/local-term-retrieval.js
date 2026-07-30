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
  fuzzyMinimumCharacters: FUZZY_MINIMUM_CHARACTERS,
  fuzzyMinimumSimilarity: FUZZY_MINIMUM_SIMILARITY,
  fuzzyMinimumMargin: FUZZY_MINIMUM_MARGIN,
});

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

/**
 * Builds one in-memory index for a session glossary. No network, database, or
 * model call occurs in this layer.
 * @param {unknown} glossary
 */
export function createLocalTermRetriever(glossary) {
  const glossaryText = String(glossary ?? "");
  const index = glossaryText.length <= MAX_GLOSSARY_CHARACTERS
    ? parseGlossary(glossaryText)
    : emptyGlossaryIndex();
  const queryCache = new Map();
  const registeredAliases = new Set(index.repairs.map((mapping) => normalizeText(mapping.from)));

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

  function retrieve({ sourceText = "", translatedText = "" } = {}) {
    const rawQuery = `${sourceText ?? ""}\n${translatedText ?? ""}`.trim();
    if (rawQuery.length > MAX_QUERY_CHARACTERS) return "";
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
    return isFinal ? repairFuzzyAlias(repaired, index.repairs, normalizedLanguage) : repaired;
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

  return Object.freeze({ retrieve, repair, assess });
}
