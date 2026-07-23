import { NextRequest, NextResponse } from "next/server";

// Business-register polish for committed subtitle lines.
//
// P0: this NEVER touches live partials and NEVER blocks or drops a subtitle.
// It rewrites a single already-finalized translation into a professional
// business register; on any error or timeout it returns the raw text unchanged.
// Ported verbatim from autopreso/src/subtitle-polish.js (buildPolishSystemPrompt).

const DEFAULT_TIMEOUT_MS = 4000;
const MIN_POLISH_CHARS = 2;
const MAX_POLISH_CHARS = 2000;
const POLISH_MODEL = "gpt-4o-mini";

const LANGUAGE_STYLE: Record<string, string> = {
  ko: "Write the result in Korean formal business honorifics (격식체 존댓말, 합니다체).",
  en: "Write the result in professional business English.",
  ja: "Write the result in polite Japanese business register (ビジネス敬語、です・ます調). Use appropriate 謙譲語/尊敬語 where natural, without over-formal stiffness.",
};

function buildPolishSystemPrompt(
  targetLanguage: string,
  { tone, glossary, domain }: { tone?: string; glossary?: string; domain?: string } = {},
): string {
  const domainText = String(domain ?? "").trim();
  const glossaryText = String(glossary ?? "").trim();

  // Explicit decision hierarchy: glossary/domain rules bind only where they
  // actually apply; everyday speech falls through to a plain translation.
  const lines = [
    "You refine an existing machine translation of live speech.",
    "APPLICATION ORDER — apply these rules in priority order:",
    "1. MEANING (always): preserve the exact meaning. Do not add, remove, or infer information. Keep proper nouns (people, companies, products, place names) untranslated and unchanged.",
  ];

  if (glossaryText) {
    lines.push(
      "2. TERMINOLOGY (mandatory, bidirectional): the glossary lists symmetric term pairs.",
      "Whenever either side of a pair appears in the source, render it with its exact counterpart — the SAME pairs govern both KO→EN and EN→KO.",
      "Acronyms marked verbatim stay unchanged in both languages.",
      "Glossary renderings bind only where their terms actually appear — never inject domain jargon into sentences that do not contain them.",
    );
  }
  if (domainText) {
    lines.push(
      `3. DOMAIN: ${domainText}`,
      "Resolve ambiguous words within this domain, choosing the rendering a domain expert would use (business 'conversion'/'operator' senses, never everyday senses).",
    );
  }

  lines.push(
    "4. IDIOMS: figurative or idiomatic source expressions are rendered sense-for-sense (by meaning), never word-for-word — e.g. Korean 현주소 means the current state/landscape of a topic, never a physical address.",
    "When the target language has an equivalent idiom, prefer idiom-for-idiom over a flat paraphrase, in both directions (옥석 가리기 ↔ separating the wheat from the chaff, soft landing ↔ 연착륙, dry powder ↔ 대기 자금). Use a plain rendering only when no natural target idiom exists.",
  );

  lines.push("5. STYLE: use natural, idiomatic phrasing rather than literal translation, and keep terminology consistent.");
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
    "6. RESTRAINT (default for everything else): everyday or conversational lines — greetings, logistics, asides, small talk — get a plain, faithful translation with minimal edits.",
    "Do not formalize, embellish, or rewrite beyond what the rules above require; when no rule applies, the basic natural translation is the correct output.",
  );

  if (glossaryText) lines.push("GLOSSARY:", glossaryText);
  lines.push("Output ONLY the rewritten line, with no quotes, labels, or commentary.");
  return lines.join("\n");
}

function buildPolishUserPrompt({
  text,
  sourceText,
  targetLanguage,
}: {
  text: string;
  sourceText?: string;
  targetLanguage: string;
}): string {
  const lines = [`Rewrite this ${targetLanguage} translation in a business register:`, text];
  if (sourceText) lines.push(`(Original source, for context only — do not translate this line again: ${sourceText})`);
  return lines.join("\n");
}

export async function POST(request: NextRequest) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ translatedText: "" });
  }

  const translatedText = String(body?.translatedText ?? "");
  const sourceText = String(body?.sourceText ?? "");
  const targetLanguage = String(body?.targetLanguage ?? "ko");
  const tone = String(body?.tone ?? "natural");
  const glossary = String(body?.glossary ?? "");
  const domain = String(body?.domain ?? "");

  // Polish runs for the business register, or whenever a glossary/domain is
  // set — terminology and domain correctness matter regardless of tone.
  if (tone !== "business" && !glossary.trim() && !domain.trim()) {
    return NextResponse.json({ translatedText });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const text = translatedText.trim();
  if (!apiKey || text.length < MIN_POLISH_CHARS) {
    return NextResponse.json({ translatedText });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: POLISH_MODEL,
        messages: [
          { role: "system", content: buildPolishSystemPrompt(targetLanguage, { tone, glossary, domain }) },
          {
            role: "user",
            content: buildPolishUserPrompt({ text: text.slice(0, MAX_POLISH_CHARS), sourceText, targetLanguage }),
          },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json({ translatedText });
    }
    const data: any = await response.json();
    const polished = String(data?.choices?.[0]?.message?.content ?? "").trim();
    return NextResponse.json({ translatedText: polished || translatedText });
  } catch {
    // Timeout or network failure: the raw translation is always good enough.
    return NextResponse.json({ translatedText });
  } finally {
    clearTimeout(timer);
  }
}
