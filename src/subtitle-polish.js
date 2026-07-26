// Business-register polish for committed subtitle lines.
//
// P0: this NEVER touches live partials and NEVER blocks or drops a subtitle.
// It rewrites a single already-finalized translation into a professional
// business register; on any error or timeout it returns the raw text unchanged.

const DEFAULT_TIMEOUT_MS = 6000;
const MIN_POLISH_CHARS = 2;
const MAX_POLISH_CHARS = 2000;
const MAX_SELECTED_GLOSSARY_CHARS = 6_000;
const MAX_GLOBAL_GLOSSARY_CHARS = 1_800;
const MAX_MATCHED_GLOSSARY_LINES = 32;

function normalizeGlossaryMatchText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function compactGlossaryMatchText(value) {
  return normalizeGlossaryMatchText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function glossaryPhraseMatches(candidate, compactQuery, queryTokens) {
  const normalized = normalizeGlossaryMatchText(candidate)
    .replace(/^[-*•]\s*/u, "")
    .replace(/\([^)]*\)/gu, " ")
    .replace(/["'“”‘’]/gu, "")
    .trim();
  if (normalized.length < 2) return false;
  const compact = compactGlossaryMatchText(normalized);
  const minimumLength = /^[a-z0-9]+$/u.test(compact) ? 4 : 2;
  if (compact.length >= minimumLength && compactQuery.includes(compact)) return true;
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length < 3) return false;
  const matched = tokens.filter((token) => queryTokens.has(token)).length;
  return matched / tokens.length >= 0.75;
}

function glossaryLineMatches(line, compactQuery, queryTokens) {
  const fragments = String(line)
    .split(/\s*(?:=|->|→|↔)\s*|\s+\/\s+|\s*,\s*/u)
    .flatMap((fragment) => [fragment, fragment.replace(/\([^)]*\)/gu, " ")]);
  return fragments.some((fragment) => glossaryPhraseMatches(fragment, compactQuery, queryTokens));
}

function appendGlossaryLine(lines, line, maxChars) {
  const normalized = String(line ?? "").trim();
  if (!normalized || lines.includes(normalized)) return;
  const nextLength = lines.join("\n").length + (lines.length > 0 ? 1 : 0) + normalized.length;
  if (nextLength <= maxChars) lines.push(normalized);
}

/**
 * @param {unknown} glossary
 * @param {{sourceText?: unknown, translatedText?: unknown}} [context]
 */
function selectRelevantGlossary(glossary, { sourceText, translatedText } = {}) {
  const glossaryText = String(glossary ?? "").normalize("NFC").trim();
  if (!glossaryText) return "";
  const query = normalizeGlossaryMatchText(`${sourceText ?? ""}\n${translatedText ?? ""}`);
  const compactQuery = compactGlossaryMatchText(query);
  const queryTokens = new Set(query.match(/[\p{L}\p{N}]+/gu) ?? []);
  const sections = [];
  let current = { header: "", lines: [] };
  for (const rawLine of glossaryText.split(/\r?\n/u)) {
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

  const globalLines = [];
  for (const section of sections) {
    if (!/(?:규칙|주의|rules?|instructions?|guidelines?)/iu.test(section.header)) continue;
    appendGlossaryLine(globalLines, section.header, MAX_GLOBAL_GLOSSARY_CHARS);
    for (const line of section.lines) {
      appendGlossaryLine(globalLines, line, MAX_GLOBAL_GLOSSARY_CHARS);
    }
  }

  const matchedLines = [];
  let matchCount = 0;
  for (const section of sections) {
    const matches = section.lines.filter((line) => glossaryLineMatches(
      line,
      compactQuery,
      queryTokens,
    ));
    if (matches.length === 0) continue;
    appendGlossaryLine(matchedLines, section.header, MAX_SELECTED_GLOSSARY_CHARS);
    for (const line of matches) {
      if (matchCount >= MAX_MATCHED_GLOSSARY_LINES) break;
      appendGlossaryLine(matchedLines, line, MAX_SELECTED_GLOSSARY_CHARS);
      matchCount += 1;
    }
    if (matchCount >= MAX_MATCHED_GLOSSARY_LINES) break;
  }

  const selected = [...globalLines];
  for (const line of matchedLines) appendGlossaryLine(selected, line, MAX_SELECTED_GLOSSARY_CHARS);
  return selected.join("\n");
}

const LANGUAGE_STYLE = {
  ko: "Write the result in Korean formal business honorifics (격식체 존댓말, 합니다체).",
  en: "Write the result in professional business English.",
  ja: "Write the result in polite Japanese business register (ビジネス敬語、です・ます調). Use appropriate 謙譲語/尊敬語 where natural, without over-formal stiffness.",
};

/** @param {string} targetLanguage @param {any} options */
function buildPolishSystemPrompt(targetLanguage, { tone, glossary, domain, hasConfiguredGlossary } = {}) {
  const domainText = String(domain ?? "").trim();
  const glossaryText = String(glossary ?? "").trim();

  // Explicit decision hierarchy: glossary/domain rules bind only where they
  // actually apply; everyday speech falls through to a plain translation.
  const lines = [
    "You are the second-pass finalizer for a live subtitle stream.",
    "The live stream may be fast, provisional, fragmented, or a placeholder. Your job is to turn the committed cue into the final subtitle line.",
    "APPLICATION ORDER — apply these rules in priority order:",
    "1. MEANING (always): preserve the exact meaning. Do not add, remove, or infer information. Keep proper nouns (people, companies, products, place names) untranslated and unchanged.",
    "2. COMPLETION (committed subtitle only): produce one complete, display-ready subtitle cue. If the live draft is an ellipsis, placeholder, or obvious trailing fragment while the original source has enough content, translate from the source and complete the cue. Never output only ellipses. If the source itself is incomplete, stay faithful and do not invent missing content.",
  ];

  if (hasConfiguredGlossary ?? Boolean(glossaryText)) {
    lines.push(
      "3. TERMINOLOGY (mandatory, bidirectional): check the glossary before finalizing; the glossary lists symmetric term pairs.",
      "PROPER-NOUN REPAIR: live speech-to-text garbles company/brand/person names badly — it drops connectors, fuses words, or invents phonetic spellings (e.g. 'Cushman & Wakefield' → 'Kushima is why Field', 'Kushimanend Wakefield', 'K-Field'). When a garbled fragment is clearly meant to be a glossary/registered name, REPLACE it with the exact registered form; never pass a mangled proper noun through.",
      "Whenever either side of a pair appears in the source, render it with its exact counterpart — the SAME pairs govern both KO→EN and EN→KO.",
      "Treat full-sentence or clause-level pairs as TRANSLATION MEMORY: when the live source is identical or a close variant, mirror the paired wording, terminology, and sentence structure instead of inventing a fresh translation.",
      "Acronyms marked verbatim stay unchanged in both languages.",
      "Glossary renderings bind only where their terms actually appear — never inject domain jargon into sentences that do not contain them.",
    );
  }
  if (domainText) {
    lines.push(
      `4. DOMAIN: ${domainText}`,
      "Resolve ambiguous words within this domain, choosing the rendering a domain expert would use (business 'conversion'/'operator' senses, never everyday senses).",
    );
  }

  lines.push(
    "5. IDIOMS: figurative or idiomatic source expressions are rendered sense-for-sense (by meaning), never word-for-word — e.g. Korean 현주소 means the current state/landscape of a topic, never a physical address (and never 住所 in Japanese); Korean 숙제 in business contexts means a remaining challenge, never 宿題/homework.",
    "When the target language has an equivalent idiom, prefer idiom-for-idiom over a flat paraphrase, in every direction across ko/en/ja (옥석 가리기 ↔ separating the wheat from the chaff ↔ 玉石の選別, soft landing ↔ 연착륙 ↔ 軟着陸, 그림의 떡 ↔ pie in the sky ↔ 絵に描いた餅, 일석이조 ↔ kill two birds with one stone ↔ 一石二鳥). Use a plain rendering only when no natural target idiom exists.",
    "Japanese set phrases that signal stance rather than content (持ち帰って検討します, 前向きに検討します, 落とし所) carry their business sense, not their literal words.",
  );

  lines.push(
    "6. NUMBERS: never restate a figure in the source language's counting system — convert the SCALE, never the currency, and never apply an exchange rate.",
    "Korean counts in myriads (만 10^4, 억 10^8, 조 10^12); English counts in million/billion/trillion; Japanese keeps 万/億/兆.",
    "English output: 3,000억 원 → KRW 300 billion; 300억 원 → KRW 30 billion; 1조 5,000억 원 → KRW 1.5 trillion; 5,000만 원 → KRW 50 million. Never write '3,000억' or 'hundred million' in English output.",
    "Korean output: KRW 300 billion → 3,000억 원; 1.5 trillion won → 1조 5,000억 원; USD 30 million → 3,000만 달러. Never leave 'billion'/'million' untranslated in Korean output.",
    "Keep the magnitude identical, keep the currency the speaker used, and leave percentages, years, quarters, floor areas, and counts exactly as spoken.",
  );
  lines.push("7. STYLE: preserve the live draft's wording when it is already correct, but finish it into a natural, idiomatic final subtitle rather than literal translation, and keep terminology consistent.");
  if (targetLanguage === "ko") {
    // EN->KO is the direction most prone to translationese; force a rewrite
    // into native Korean rather than English-shaped Korean.
    lines.push(
      "Korean output must read like it was originally written in Korean — no translationese (번역투 금지):",
      "restructure English word order into natural Korean order; drop subjects and pronouns Korean naturally omits;",
      "avoid carried-over passives and patterns like '~에 대하여'/'~를 가지고 있다'; use idiomatic Korean phrasing throughout.",
    );
  }
  if (tone === "business") {
    lines.push(LANGUAGE_STYLE[targetLanguage] ?? "Write the result in a professional business register.");
  }

  lines.push(
    "8. RESTRAINT (default for everything else): everyday or conversational lines — greetings, logistics, asides, small talk — get a plain, faithful translation with minimal edits.",
    "Do not formalize, embellish, or rewrite beyond what the rules above require; when no rule applies, the basic natural translation is the correct output.",
  );

  if (glossaryText) lines.push("GLOSSARY:", glossaryText);
  lines.push("Output ONLY the rewritten line, with no quotes, labels, or commentary.");
  return lines.join("\n");
}

function buildPolishUserPrompt({ text, sourceText, targetLanguage, tone }) {
  const task = tone === "business"
    ? `Rewrite this ${targetLanguage} translation in a business register:`
    : `Refine this ${targetLanguage} live subtitle translation for terminology, meaning, and natural phrasing:`;
  const lines = [task, text];
  if (isEllipsisPlaceholder(text) && sourceText) {
    lines.push(`The draft translation is only an ellipsis/placeholder. Check the glossary and use this original source to produce the final complete ${targetLanguage} subtitle instead. Do not output ellipses: ${sourceText}`);
  } else if (sourceText) {
    lines.push(`(Original source, for context only — do not translate this line again unless the draft is an ellipsis/placeholder: ${sourceText})`);
  }
  return lines.join("\n");
}

function isEllipsisPlaceholder(value) {
  return /^\s*(?:\.{2,}|…+)\s*$/.test(String(value ?? ""));
}

/** @param {any} options */
export function createSubtitlePolisher({ generateText, model, timeoutMs = DEFAULT_TIMEOUT_MS, log = console } = {}) {
  /** @param {any} args */
  async function polish({ translatedText, sourceText = "", targetLanguage, tone, glossary = "", domain = "", signal } = {}) {
    const text = String(translatedText ?? "").trim();
    const source = String(sourceText ?? "").trim();
    const selectedGlossary = selectRelevantGlossary(glossary, { sourceText: source, translatedText: text });
    const shouldRecoverPlaceholder = isEllipsisPlaceholder(text) && source.length >= MIN_POLISH_CHARS;
    // Polish runs for the business register, or whenever a glossary/domain is
    // set — terminology and domain correctness matter regardless of tone. It
    // also recovers live-model placeholders such as "..." after a source turn
    // has committed; Gemini uses the same project key for this finalizer.
    if (tone !== "business" && !String(glossary ?? "").trim() && !String(domain ?? "").trim() && !shouldRecoverPlaceholder) return translatedText;
    if (typeof generateText !== "function" || !model) return translatedText;

    if (text.length < MIN_POLISH_CHARS && !shouldRecoverPlaceholder) return translatedText;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return translatedText;
      signal.addEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await generateText({
        model,
        system: buildPolishSystemPrompt(targetLanguage, {
          tone,
          glossary: selectedGlossary,
          domain,
          hasConfiguredGlossary: Boolean(String(glossary ?? "").trim()),
        }),
        prompt: buildPolishUserPrompt({ text: text.slice(0, MAX_POLISH_CHARS), sourceText, targetLanguage, tone }),
        abortSignal: controller.signal,
      });
      const polished = String(result?.text ?? "").trim();
      return polished || translatedText;
    } catch (error) {
      log.warn?.(`[subtitle] tone polish failed, using raw translation: ${error?.message ?? error}`);
      return translatedText;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  return { polish };
}
