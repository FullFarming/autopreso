// Matches MAX_SUBTITLE_GLOSSARY_CHARS in src/settings-store.js. At 24_000 the
// largest shipped preset (~27.5k) was truncated on the Live Call path only.
const DEFAULT_MAX_LIVE_CALL_GLOSSARY_CHARS = 40_000;

// Idioms and translation memory are NOT excluded: the polish prompt shared with
// the captions path instructs the model to use them ("Treat full-sentence or
// clause-level pairs as TRANSLATION MEMORY"), so stripping them left Live Call
// with the instruction and none of the data. Only genuinely local-only
// sections stay out.
const EXCLUDED_SECTION = /(?:영어\s*슬로건|영어\s*라벨)/iu;
const CORE_RULE_SECTION = /(?:숫자|약어|중의어|rules?|instructions?)/iu;
const PROPER_NOUN_SECTION = /(?:고유명사|회사|기관|브랜드|자산|프로젝트|고객사|투자자|proper\s*noun|brand)/iu;
const CRE_TERM_SECTION = /(?:상업용\s*부동산|캐피탈|임차인|임대차|오피스|투자|자본시장|개발|인허가|호텔|리빙|리테일|거래|자금조달|딜\s*소싱|운영|계약|수요|시장|리스크|거버넌스|service\s*line|capital\s*market|commercial\s*real\s*estate)/iu;
const ESSENTIAL_RULE_LINE = /(?:대칭\s*용어쌍|약어|acronym|숫자|자릿수|통화|환율|고유명사|회사|브랜드|음차|표기)/iu;

function parseGlossarySections(glossary) {
  const sections = [];
  let current = { header: "", lines: [] };
  for (const rawLine of String(glossary ?? "").normalize("NFC").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\[[^\]]+\]$/u.test(line)) {
      if (current.header || current.lines.length > 0) sections.push(current);
      current = { header: line, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.header || current.lines.length > 0) sections.push(current);
  return sections;
}

function classifySection(section) {
  const header = section.header;
  if (EXCLUDED_SECTION.test(header)) return null;
  if (PROPER_NOUN_SECTION.test(header)) return { priority: 1, lines: section.lines };
  if (CORE_RULE_SECTION.test(header)) return { priority: 0, lines: section.lines };
  if (CRE_TERM_SECTION.test(header)) return { priority: 2, lines: section.lines };
  if (!header) {
    const lines = section.lines.filter((line) => ESSENTIAL_RULE_LINE.test(line));
    return lines.length > 0 ? { priority: 0, lines } : null;
  }
  if (/^\[규칙\]$/u.test(header)) {
    const lines = section.lines.filter((line) => ESSENTIAL_RULE_LINE.test(line));
    return lines.length > 0 ? { priority: 0, lines } : null;
  }
  return null;
}

/** Build the glossary sent to the Live Call gateway without mutating the
 * captions-only glossary. It carries the same identity, CRE terminology, idioms
 * and translation memory the captions path uses -- the gateway runs the identical
 * polish prompt and its own selectRelevantGlossary narrows per line, so sending
 * less here only starved the model. */
export function buildLiveCallGlossary(glossary, { maxChars = DEFAULT_MAX_LIVE_CALL_GLOSSARY_CHARS } = {}) {
  const boundedMax = Number.isSafeInteger(maxChars) && maxChars > 0
    ? Math.min(maxChars, DEFAULT_MAX_LIVE_CALL_GLOSSARY_CHARS)
    : DEFAULT_MAX_LIVE_CALL_GLOSSARY_CHARS;
  const selected = parseGlossarySections(glossary)
    .map((section, sourceIndex) => ({ section, sourceIndex, selection: classifySection(section) }))
    .filter((entry) => entry.selection)
    .sort((left, right) => left.selection.priority - right.selection.priority || left.sourceIndex - right.sourceIndex);
  const output = [];
  let length = 0;
  for (const { section, selection } of selected) {
    const blockLines = [section.header, ...selection.lines].filter(Boolean);
    const accepted = [];
    for (const line of blockLines) {
      const added = line.length + (length > 0 || accepted.length > 0 ? 1 : 0);
      if (length + accepted.join("\n").length + added > boundedMax) break;
      accepted.push(line);
    }
    if (accepted.length === 0 || (section.header && accepted.length === 1 && selection.lines.length > 0)) continue;
    const block = accepted.join("\n");
    output.push(block);
    length += block.length + (output.length > 1 ? 1 : 0);
    if (length >= boundedMax) break;
  }
  return output.join("\n").slice(0, boundedMax).trim();
}

export const liveCallGlossaryPolicy = Object.freeze({
  maxChars: DEFAULT_MAX_LIVE_CALL_GLOSSARY_CHARS,
});
