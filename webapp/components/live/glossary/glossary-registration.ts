import type { GlossaryDocumentTermV1, GlossaryDocumentV1 } from "@/lib/glossary-presets/types";
import type { CanonicalLanguageCode } from "@/lib/languageDetect";
import {
  CAPTION_LANGUAGE_CODES,
  normalizeCaptionLanguage,
} from "../../../../packages/caption-core/languages.js";

function toCanonical(value: string): CanonicalLanguageCode | "" {
  return normalizeCaptionLanguage(value) as CanonicalLanguageCode | "";
}

// AI 툴(클로드·코덱스 등)에 문서를 붙여 넣어 용어를 추출하게 하는 등록 플로우의
// 순수 로직: 추출 프롬프트 생성과, AI가 돌려준 JSON/Markdown 결과의 정규화.
// 네트워크·검증의 최종 권위는 기존 /api/glossary-presets/import 경로가 가진다.

export const GLOSSARY_REGISTRATION_LANGUAGES: readonly string[] = CAPTION_LANGUAGE_CODES;

const MAX_REGISTRATION_TERMS = 2_000;
const MAX_PASTE_CODEPOINTS = 400_000;

export class GlossaryRegistrationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "GlossaryRegistrationError";
    this.code = code;
  }
}

export interface GlossaryRegistrationRequest {
  readonly name: string;
  readonly domain: string;
  readonly sourceLanguage: string;
  readonly targetLanguages: readonly string[];
}

function normalizeLanguages(sourceLanguage: string, targetLanguages: readonly string[]): { source: CanonicalLanguageCode; targets: CanonicalLanguageCode[] } {
  const source = toCanonical(sourceLanguage);
  if (!source) throw new GlossaryRegistrationError("지원하지 않는 원문 언어입니다.", "UNSUPPORTED_SOURCE_LANGUAGE");
  const targets: CanonicalLanguageCode[] = [];
  for (const language of targetLanguages) {
    const normalized = toCanonical(language);
    if (!normalized) throw new GlossaryRegistrationError(`지원하지 않는 번역 언어입니다: ${language}`, "UNSUPPORTED_TARGET_LANGUAGE");
    if (normalized === source) throw new GlossaryRegistrationError("번역 언어는 원문 언어와 달라야 합니다.", "CONFLICTING_LANGUAGE");
    if (!targets.includes(normalized)) targets.push(normalized);
  }
  if (targets.length === 0) throw new GlossaryRegistrationError("번역 언어를 1개 이상 선택해 주세요.", "TARGET_LANGUAGE_REQUIRED");
  return { source, targets };
}

export function buildGlossaryExtractionPrompt(request: GlossaryRegistrationRequest): string {
  const { source, targets } = normalizeLanguages(request.sourceLanguage, request.targetLanguages);
  const name = request.name.normalize("NFC").trim() || "새 용어집";
  const domain = request.domain.normalize("NFC").trim();
  const targetsJson = targets.map((language) => `"${language}"`).join(", ");
  const exampleTranslations = targets.map((language) => `"${language}": "..."`).join(", ");
  const tableHeader = `| 원문 | ${targets.join(" | ")} | 비고 |`;
  const tableDivider = `|---|${targets.map(() => "---|").join("")}---|`;
  return [
    "당신은 실시간 통역·자막 서비스의 전문 용어집을 만드는 용어 추출가입니다.",
    "아래에 첨부하는 문서를 분석해서, 통역 중 오역되기 쉬운 특수 용어만 뽑아 용어집을 만들어 주세요.",
    "",
    "[추출 규칙]",
    "1. 기본 어휘·일반적인 단어는 제외합니다. 고유명사(회사·제품·인명·지명), 도메인 전문용어, 약어, 관용 표현처럼 번역이 고정되어야 하는 항목만 수록합니다.",
    "2. 같은 의미의 중복 항목은 하나로 합치고, 표기 변형은 aliases에 넣습니다.",
    `3. 원문 언어는 ${source}, 번역 언어는 ${targets.join(", ")} 입니다. 각 용어마다 선택된 모든 번역 언어의 번역을 적습니다(모르면 해당 언어는 비워 둡니다).`,
    "4. 번역은 실제 발표·통역 문맥에 맞는 업계 표준 표현을 사용합니다. 직역하지 않습니다.",
    `5. 용어 수는 ${MAX_REGISTRATION_TERMS}개를 넘지 않게, 중요도 순으로 추립니다.`,
    domain ? `6. 이 용어집의 도메인: ${domain}` : "",
    "",
    "[출력 형식 1 — JSON (권장)]",
    "아래 구조의 JSON만 코드 블록으로 출력하세요. 다른 설명은 붙이지 마세요.",
    "```",
    "{",
    `  "name": "${name}",`,
    `  "domain": "${domain}",`,
    `  "sourceLanguage": "${source}",`,
    `  "targetLanguages": [${targetsJson}],`,
    "  \"terms\": [",
    `    { "source": "원문 용어", "translations": { ${exampleTranslations} }, "aliases": [], "context": "문맥 메모" }`,
    "  ]",
    "}",
    "```",
    "",
    "[출력 형식 2 — Markdown 표]",
    "JSON이 어려우면 아래 형식의 Markdown을 출력해도 됩니다.",
    "```",
    `# 용어집: ${name}`,
    `- source-language: ${source}`,
    `- target-languages: ${targets.join(", ")}`,
    domain ? `- domain: ${domain}` : "- domain: ",
    "",
    tableHeader,
    tableDivider,
    "| 예시 용어 | " + targets.map(() => "translation | ").join("") + "메모 |",
    "```",
    "",
    "[분석할 문서]",
    "(여기에 문서를 붙여 넣으세요)",
  ].filter((line) => line !== "").join("\n");
}

interface RawTermInput {
  readonly source: string;
  readonly translations: Record<string, string>;
  readonly aliases?: readonly string[];
  readonly context?: string | null;
}

export function parsePastedGlossary(text: string, now: string): GlossaryDocumentV1 {
  const trimmed = stripCodeFence(String(text ?? "")).trim();
  if (!trimmed) throw new GlossaryRegistrationError("등록할 JSON 또는 Markdown 내용을 붙여 넣어 주세요.", "PASTE_REQUIRED");
  if ([...trimmed].length > MAX_PASTE_CODEPOINTS) {
    throw new GlossaryRegistrationError("붙여 넣은 내용이 너무 큽니다. 용어 수를 줄여 주세요.", "PASTE_TOO_LARGE");
  }
  const raw = trimmed.startsWith("{") ? parseJsonInput(trimmed) : parseMarkdownInput(trimmed);
  return normalizeRegistrationDocument(raw, now);
}

export function presentGlossaryLanguageTags(document: Pick<GlossaryDocumentV1, "sourceLanguage" | "targetLanguages">): string[] {
  return [`원문 ${document.sourceLanguage}`, ...document.targetLanguages];
}

interface RawRegistrationInput {
  readonly name: string;
  readonly domain: string;
  readonly sourceLanguage: string;
  readonly targetLanguages: readonly string[];
  readonly terms: readonly RawTermInput[];
}

function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/u);
  return match ? match[1] : text;
}

function parseJsonInput(text: string): RawRegistrationInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GlossaryRegistrationError("JSON을 해석할 수 없습니다. 프롬프트가 안내한 구조인지 확인해 주세요.", "INVALID_JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GlossaryRegistrationError("JSON 최상위는 객체여야 합니다.", "INVALID_JSON");
  }
  const record = parsed as Record<string, unknown>;
  const terms = Array.isArray(record.terms) ? record.terms : null;
  if (!terms) throw new GlossaryRegistrationError("terms 배열이 필요합니다.", "TERMS_REQUIRED");
  return {
    name: typeof record.name === "string" ? record.name : "",
    domain: typeof record.domain === "string" ? record.domain : "",
    sourceLanguage: typeof record.sourceLanguage === "string" ? record.sourceLanguage : "",
    targetLanguages: Array.isArray(record.targetLanguages) ? record.targetLanguages.filter((item): item is string => typeof item === "string") : [],
    terms: terms.flatMap((item): RawTermInput[] => {
      if (typeof item !== "object" || item === null) return [];
      const termRecord = item as Record<string, unknown>;
      const translations = typeof termRecord.translations === "object" && termRecord.translations !== null && !Array.isArray(termRecord.translations)
        ? Object.fromEntries(Object.entries(termRecord.translations as Record<string, unknown>).filter(([, value]) => typeof value === "string") as [string, string][])
        : {};
      return [{
        source: typeof termRecord.source === "string" ? termRecord.source : "",
        translations,
        aliases: Array.isArray(termRecord.aliases) ? termRecord.aliases.filter((alias): alias is string => typeof alias === "string") : [],
        context: typeof termRecord.context === "string" ? termRecord.context : null,
      }];
    }),
  };
}

function parseMarkdownInput(text: string): RawRegistrationInput {
  const lines = text.split(/\r?\n/u);
  let name = "";
  let domain = "";
  let sourceLanguage = "";
  let declaredTargets: string[] = [];
  let headerColumns: string[] | null = null;
  const terms: RawTermInput[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,3}\s*(?:용어집\s*[:：]\s*)?(.+)$/u);
    if (heading && !name) { name = heading[1].trim(); continue; }
    const bullet = line.match(/^[-*]\s*([\w가-힣 -]+?)\s*[:：]\s*(.*)$/u);
    if (bullet) {
      const key = bullet[1].toLowerCase().replace(/\s+/gu, "-");
      if (/source|원문/u.test(key)) sourceLanguage = bullet[2].trim();
      else if (/target|번역|대상/u.test(key)) declaredTargets = bullet[2].split(/[,·]/u).map((item) => item.trim()).filter(Boolean);
      else if (/domain|도메인|분야/u.test(key)) domain = bullet[2].trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell) || cell === "")) continue;
    if (!headerColumns) { headerColumns = cells; continue; }
    const [source, ...rest] = cells;
    const translations: Record<string, string> = {};
    let context: string | null = null;
    for (const [index, value] of rest.entries()) {
      const column = headerColumns[index + 1] ?? "";
      if (!value) continue;
      const language = normalizeCaptionLanguage(column);
      if (language) translations[language] = value;
      else if (/비고|메모|context|note/iu.test(column)) context = value;
    }
    terms.push({ source: source ?? "", translations, context });
  }
  if (!headerColumns) {
    throw new GlossaryRegistrationError("Markdown에서 용어 표를 찾지 못했습니다. `| 원문 | en | ... |` 표 형식인지 확인해 주세요.", "MARKDOWN_TABLE_REQUIRED");
  }
  return { name, domain, sourceLanguage, targetLanguages: declaredTargets, terms };
}

function normalizeRegistrationDocument(raw: RawRegistrationInput, now: string): GlossaryDocumentV1 {
  const sourceLanguage = toCanonical(raw.sourceLanguage) || ("ko" as CanonicalLanguageCode);
  const declaredTargets = raw.targetLanguages
    .map((language) => toCanonical(language))
    .filter((language) => language && language !== sourceLanguage);
  const seenSources = new Set<string>();
  const targetSet = new Set<CanonicalLanguageCode>(declaredTargets.filter((language): language is CanonicalLanguageCode => language !== ""));
  const terms: GlossaryDocumentTermV1[] = [];
  for (const rawTerm of raw.terms) {
    const source = rawTerm.source.normalize("NFC").trim();
    if (!source) continue;
    const key = source.toLocaleLowerCase("und");
    if (seenSources.has(key)) continue;
    const translations: Record<string, string> = {};
    for (const [language, value] of Object.entries(rawTerm.translations)) {
      const normalizedLanguage = toCanonical(language);
      const normalizedValue = value.normalize("NFC").trim();
      if (!normalizedLanguage || normalizedLanguage === sourceLanguage || !normalizedValue) continue;
      translations[normalizedLanguage] = normalizedValue;
      targetSet.add(normalizedLanguage);
    }
    if (Object.keys(translations).length === 0) continue;
    seenSources.add(key);
    terms.push({
      id: `term-${String(terms.length + 1).padStart(5, "0")}`,
      source,
      translations,
      aliases: (rawTerm.aliases ?? []).map((alias) => alias.normalize("NFC").trim()).filter(Boolean).slice(0, 16),
      pronunciation: null,
      doNotTranslate: false,
      forbiddenTranslations: [],
      context: rawTerm.context?.normalize("NFC").trim() || null,
      examples: [],
      tags: [],
      priority: 60,
      provenance: { kind: "import", label: "ai-registration" },
    });
    if (terms.length >= MAX_REGISTRATION_TERMS) break;
  }
  if (terms.length === 0) {
    throw new GlossaryRegistrationError("등록할 용어를 찾지 못했습니다. 원문과 번역이 채워진 항목이 필요합니다.", "TERMS_REQUIRED");
  }
  const order = new Map(GLOSSARY_REGISTRATION_LANGUAGES.map((language, index) => [language, index]));
  const targetLanguages = [...targetSet].sort((left, right) => (order.get(left) ?? 99) - (order.get(right) ?? 99));
  if (targetLanguages.length === 0) {
    throw new GlossaryRegistrationError("번역 언어를 확인할 수 없습니다.", "TARGET_LANGUAGE_REQUIRED");
  }
  return {
    schemaVersion: 1,
    name: raw.name.normalize("NFC").trim().slice(0, 120) || "새 용어집",
    domain: raw.domain.normalize("NFC").trim().slice(0, 600),
    sourceLanguage,
    targetLanguages,
    terms,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}
