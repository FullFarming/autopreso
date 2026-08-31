import { createHash } from "node:crypto";

import { CAPTION_LANGUAGE_CODES } from "./languages.js";

export const GLOSSARY_DOCUMENT_V1_LIMITS = Object.freeze({
  documentCodepoints: 2_000_000,
  legacyTextCodepoints: 40_000,
  terms: 10_000,
  targetLanguages: 13,
  idCodepoints: 80,
  nameCodepoints: 120,
  termCodepoints: 240,
  domainCodepoints: 1_000,
  contextCodepoints: 1_000,
  provenanceLabelCodepoints: 240,
  aliases: 16,
  forbiddenTranslations: 16,
  examples: 8,
  tags: 16,
});

const DOCUMENT_KEYS = new Set([
  "createdAt", "domain", "name", "schemaVersion", "sourceLanguage", "targetLanguages", "terms", "updatedAt", "version",
]);
const TERM_KEYS = new Set([
  "aliases", "context", "doNotTranslate", "examples", "forbiddenTranslations", "id", "priority", "pronunciation",
  "provenance", "source", "tags", "translations",
]);
const PROVENANCE_KEYS = new Set(["kind", "label"]);
const PROVENANCE_KINDS = new Set(["ai_extracted", "import", "legacy", "manual"]);
const LANGUAGE_ORDER = new Map(CAPTION_LANGUAGE_CODES.map((language, index) => [language, index]));
const EXECUTABLE_CONTENT_PATTERN = /(?:javascript|vbscript)\s*:|data\s*:\s*text\/html|(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions?|system\s+prompt|\$\{|\{\{/iu;

export class GlossaryDocumentValidationError extends Error {
  constructor(diagnostic) {
    super("INVALID_GLOSSARY_DOCUMENT");
    this.name = "GlossaryDocumentValidationError";
    this.code = "INVALID_GLOSSARY_DOCUMENT";
    this.diagnostics = Object.freeze([Object.freeze(diagnostic)]);
  }
}

export function validateGlossaryDocumentV1(input) {
  try {
    const document = parseGlossaryDocumentV1(input);
    return Object.freeze({ ok: true, document, fingerprint: fingerprintCanonicalDocument(document) });
  } catch (error) {
    if (!(error instanceof GlossaryDocumentValidationError)) throw error;
    return Object.freeze({ ok: false, diagnostics: error.diagnostics });
  }
}

export function parseGlossaryDocumentV1(input) {
  const value = parseInput(input);
  assertPlainObject(value, "$", "INVALID_DOCUMENT");
  assertExactKeys(value, DOCUMENT_KEYS, "$", [
    "schemaVersion", "name", "domain", "sourceLanguage", "targetLanguages", "terms", "createdAt", "updatedAt", "version",
  ]);
  if (value.schemaVersion !== 1) fail("INVALID_SCHEMA_VERSION", "$.schemaVersion", "schemaVersion must be 1.");
  const name = parseText(value.name, "$.name", GLOSSARY_DOCUMENT_V1_LIMITS.nameCodepoints);
  const domain = parseText(value.domain, "$.domain", GLOSSARY_DOCUMENT_V1_LIMITS.domainCodepoints);
  const sourceLanguage = parseLanguage(value.sourceLanguage, "$.sourceLanguage");
  const targetLanguages = parseTargetLanguages(value.targetLanguages, sourceLanguage);
  if (!Array.isArray(value.terms) || value.terms.length < 1 || value.terms.length > GLOSSARY_DOCUMENT_V1_LIMITS.terms) {
    fail("INVALID_TERMS", "$.terms", `terms must contain 1-${GLOSSARY_DOCUMENT_V1_LIMITS.terms} entries.`);
  }
  const terms = value.terms.map((term, index) => parseTerm(term, index, targetLanguages));
  assertUniqueTerms(terms);
  terms.sort((left, right) => compareText(left.id, right.id));
  const createdAt = parseTimestamp(value.createdAt, "$.createdAt");
  const updatedAt = parseTimestamp(value.updatedAt, "$.updatedAt");
  if (updatedAt < createdAt) fail("INVALID_TIMESTAMP_ORDER", "$.updatedAt", "updatedAt cannot precede createdAt.");
  if (!Number.isSafeInteger(value.version) || value.version < 1 || value.version > 2_147_483_647) {
    fail("INVALID_VERSION", "$.version", "version must be a positive 32-bit integer.");
  }
  const document = deepFreeze({
    schemaVersion: 1,
    name,
    domain,
    sourceLanguage,
    targetLanguages,
    terms,
    createdAt,
    updatedAt,
    version: value.version,
  });
  if (codepointLength(JSON.stringify(createSemanticPayload(document))) > GLOSSARY_DOCUMENT_V1_LIMITS.documentCodepoints) {
    fail("DOCUMENT_TOO_LARGE", "$", "Canonical glossary document exceeds the codepoint limit.");
  }
  return document;
}

export function fingerprintGlossaryDocumentV1(input) {
  return fingerprintCanonicalDocument(parseGlossaryDocumentV1(input));
}

export function compileGlossaryDocumentV1(input) {
  const document = parseGlossaryDocumentV1(input);
  const lookupEntries = [];
  const translationRules = [];
  const doNotTranslate = [];
  const contextEntries = [];
  for (const term of document.terms) {
    lookupEntries.push(createLookupEntry(term, "source", term.source));
    for (const alias of term.aliases) lookupEntries.push(createLookupEntry(term, "alias", alias));
    for (const targetLanguage of document.targetLanguages) {
      const target = term.translations[targetLanguage];
      if (target) {
        translationRules.push({
          termId: term.id,
          source: term.source,
          targetLanguage,
          target,
          forbiddenTranslations: term.forbiddenTranslations,
          priority: term.priority,
        });
      }
    }
    if (term.doNotTranslate) {
      doNotTranslate.push({
        termId: term.id,
        value: term.source,
        normalizedValue: normalizeComparison(term.source),
        priority: term.priority,
      });
    }
    const tokens = contextTokens([document.domain, term.context, ...term.examples, ...term.tags].filter(Boolean).join(" "));
    contextEntries.push({ termId: term.id, tokens });
  }
  lookupEntries.sort(compareCompiledEntry);
  translationRules.sort((left, right) => compareText(left.termId, right.termId)
    || compareText(left.targetLanguage, right.targetLanguage));
  doNotTranslate.sort((left, right) => compareText(left.termId, right.termId));
  contextEntries.sort((left, right) => compareText(left.termId, right.termId));
  return deepFreeze({
    schemaVersion: 1,
    fingerprint: fingerprintCanonicalDocument(document),
    version: document.version,
    sourceLanguage: document.sourceLanguage,
    targetLanguages: document.targetLanguages,
    domain: document.domain,
    terms: document.terms,
    lookupEntries,
    translationRules,
    doNotTranslate,
    contextEntries,
  });
}

export function mergeCompiledGlossariesV1(inputs, { selectionLimit = 5 } = {}) {
  if (!Array.isArray(inputs)) throw new GlossaryDocumentMergeError("INVALID_GLOSSARY_SELECTIONS", []);
  if (inputs.length < 1) return null;
  if (inputs.length > selectionLimit) throw new GlossaryDocumentMergeError("TOO_MANY_GLOSSARY_SELECTIONS", []);

  const documents = inputs.map((input) => isCompiledGlossaryDocumentV1(input) ? input : compileGlossaryDocumentV1(input));
  const sourceLanguages = new Set(documents.map((document) => document.sourceLanguage));
  if (sourceLanguages.size !== 1) {
    throw new GlossaryDocumentMergeError("INCOMPATIBLE_GLOSSARY_LANGUAGES", [...sourceLanguages].sort());
  }

  const selections = documents.map((document, selectionIndex) => ({ document, selectionIndex }));
  const targetLanguages = [...new Set(selections.flatMap(({ document }) => document.targetLanguages))]
    .sort((left, right) => LANGUAGE_ORDER.get(left) - LANGUAGE_ORDER.get(right));
  const termsByKey = new Map();
  const conflicts = [];

  for (const { document, selectionIndex } of selections) {
    for (const term of document.terms) {
      const key = normalizeMergeKey(term.source);
      const current = termsByKey.get(key);
      if (!current) {
        termsByKey.set(key, cloneMergeTerm(term, document, selectionIndex));
        continue;
      }
      mergeTermInto(current, term, document, selectionIndex, conflicts);
    }
  }

  if (conflicts.length > 0) throw new GlossaryDocumentMergeError("GLOSSARY_TRANSLATION_CONFLICT", conflicts);

  const terms = [...termsByKey.values()]
    .map(({ term }) => term)
    .sort((left, right) => compareText(left.source, right.source) || compareText(left.id, right.id))
    .map((term, index) => ({
      ...term,
      id: `merged-${String(index + 1).padStart(5, "0")}`,
      aliases: sortUniqueText(term.aliases),
      forbiddenTranslations: sortUniqueText(term.forbiddenTranslations),
      examples: sortUniqueText(term.examples),
      tags: sortUniqueText(term.tags),
    }));

  return compileGlossaryDocumentV1({
    schemaVersion: 1,
    name: documents.length === 1 ? documents[0].domain || "Session glossary" : `Merged session glossary (${documents.length})`,
    domain: mergeUniqueText(documents.map((document) => document.domain).filter(Boolean), [], 5).join(" / "),
    sourceLanguage: documents[0].sourceLanguage,
    targetLanguages,
    terms,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    version: 1,
  });
}

export class GlossaryDocumentMergeError extends Error {
  constructor(code, conflicts) {
    super(code);
    this.name = "GlossaryDocumentMergeError";
    this.code = code;
    this.conflicts = deepFreeze(conflicts);
  }
}

function isCompiledGlossaryDocumentV1(value) {
  return value
    && typeof value === "object"
    && value.schemaVersion === 1
    && typeof value.fingerprint === "string"
    && /^sha256:[a-f0-9]{64}$/u.test(value.fingerprint)
    && Number.isSafeInteger(value.version)
    && typeof value.sourceLanguage === "string"
    && Array.isArray(value.targetLanguages)
    && Array.isArray(value.terms)
    && Array.isArray(value.lookupEntries)
    && Array.isArray(value.translationRules)
    && Array.isArray(value.doNotTranslate)
    && Array.isArray(value.contextEntries);
}

export function convertLegacyGlossaryTextToDocumentV1(text, metadata) {
  if (typeof text !== "string" || codepointLength(text) < 1
    || codepointLength(text) > GLOSSARY_DOCUMENT_V1_LIMITS.legacyTextCodepoints
    || /[\p{Cf}]/u.test(text)) throw new Error("INVALID_LEGACY_GLOSSARY");
  assertPlainObject(metadata, "$metadata", "INVALID_LEGACY_GLOSSARY");
  const allowedMetadata = new Set(["createdAt", "domain", "name", "sourceLanguage", "targetLanguage", "updatedAt", "version"]);
  if (Object.keys(metadata).some((key) => !allowedMetadata.has(key))) throw new Error("INVALID_LEGACY_GLOSSARY");
  const lines = text.normalize("NFC").split(/\r?\n/u);
  const terms = [];
  let section = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/u);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const pair = line.match(/^(.+?)\s*(?:=|->|→|↔)\s*(.+)$/u);
    if (!pair) throw new Error("INVALID_LEGACY_GLOSSARY");
    terms.push({
      id: `legacy-${String(terms.length + 1).padStart(4, "0")}`,
      source: pair[1].trim(),
      translations: { [metadata.targetLanguage]: pair[2].trim() },
      aliases: [],
      pronunciation: null,
      doNotTranslate: false,
      forbiddenTranslations: [],
      context: section,
      examples: [],
      tags: [],
      priority: 50,
      provenance: { kind: "legacy", label: `legacy-line-${index + 1}` },
    });
  }
  if (terms.length < 1) throw new Error("INVALID_LEGACY_GLOSSARY");
  try {
    return parseGlossaryDocumentV1({
      schemaVersion: 1,
      name: metadata.name,
      domain: metadata.domain,
      sourceLanguage: metadata.sourceLanguage,
      targetLanguages: [metadata.targetLanguage],
      terms,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      version: metadata.version,
    });
  } catch {
    throw new Error("INVALID_LEGACY_GLOSSARY");
  }
}

function parseInput(input) {
  if (typeof input !== "string") return input;
  if (codepointLength(input) > GLOSSARY_DOCUMENT_V1_LIMITS.documentCodepoints) {
    fail("DOCUMENT_TOO_LARGE", "$", "Glossary JSON exceeds the codepoint limit.");
  }
  let parsed;
  try { parsed = JSON.parse(input); } catch { fail("INVALID_JSON", "$", "Glossary input must be valid JSON."); }
  assertNoDuplicateJsonKeys(input);
  return parsed;
}

function parseTargetLanguages(value, sourceLanguage) {
  if (!Array.isArray(value) || value.length < 1 || value.length > GLOSSARY_DOCUMENT_V1_LIMITS.targetLanguages) {
    fail("INVALID_TARGET_LANGUAGES", "$.targetLanguages", "targetLanguages has an invalid size.");
  }
  const languages = value.map((language, index) => {
    const parsed = parseLanguage(language, `$.targetLanguages[${index}]`);
    if (parsed === sourceLanguage) fail("CONFLICTING_LANGUAGE", `$.targetLanguages[${index}]`, "A target language cannot equal sourceLanguage.");
    return parsed;
  });
  if (new Set(languages).size !== languages.length) fail("DUPLICATE_LANGUAGE", "$.targetLanguages", "Target languages must be unique.");
  return languages.sort((left, right) => LANGUAGE_ORDER.get(left) - LANGUAGE_ORDER.get(right));
}

export function normalizeMergeKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[‐‑‒–—―-]/gu, " ")
    .replace(/[“”‘’"'`]/gu, "")
    .replace(/[^\p{L}\p{N}&+.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cloneMergeTerm(term, document, selectionIndex) {
  return {
    priority: term.priority,
    selectionIndex,
    term: {
      ...term,
      id: term.id,
      translations: { ...term.translations },
      aliases: [...term.aliases],
      forbiddenTranslations: [...term.forbiddenTranslations],
      examples: [...term.examples],
      tags: [...term.tags],
      context: term.context ?? document.domain,
      provenance: { kind: "manual", label: `merged:${document.fingerprint}:${term.id}` },
    },
  };
}

function mergeTermInto(current, incoming, incomingDocument, selectionIndex, conflicts) {
  current.term.aliases = mergeUniqueText(current.term.aliases, incoming.aliases, GLOSSARY_DOCUMENT_V1_LIMITS.aliases);
  current.term.forbiddenTranslations = mergeUniqueText(
    current.term.forbiddenTranslations,
    incoming.forbiddenTranslations,
    GLOSSARY_DOCUMENT_V1_LIMITS.forbiddenTranslations,
  );
  current.term.examples = mergeUniqueText(current.term.examples, incoming.examples, GLOSSARY_DOCUMENT_V1_LIMITS.examples);
  current.term.tags = mergeUniqueText(current.term.tags, incoming.tags, GLOSSARY_DOCUMENT_V1_LIMITS.tags);
  current.term.context = mergeUniqueParagraphs([current.term.context, incoming.context, incomingDocument.domain]);
  current.term.doNotTranslate = current.term.doNotTranslate && incoming.doNotTranslate;
  current.term.priority = Math.max(current.term.priority, incoming.priority);
  for (const [language, target] of Object.entries(incoming.translations)) {
    const existing = current.term.translations[language];
    if (!existing) {
      current.term.translations[language] = target;
      continue;
    }
    if (normalizeComparison(existing) === normalizeComparison(target)) continue;
    if (incoming.priority > current.priority) {
      current.term.translations[language] = target;
      current.priority = incoming.priority;
      current.selectionIndex = selectionIndex;
      continue;
    }
    if (incoming.priority === current.priority) {
      conflicts.push({ source: current.term.source, targetLanguage: language, left: existing, right: target });
    }
  }
}

function mergeUniqueText(left, right, maximumItems) {
  const values = [];
  const seen = new Set();
  for (const value of [...left, ...right]) {
    const text = String(value ?? "").trim();
    const key = normalizeComparison(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    values.push(text);
  }
  return values.slice(0, maximumItems);
}

function mergeUniqueParagraphs(values) {
  const text = mergeUniqueText(values.filter(Boolean), [], 3).join(" / ");
  return text ? text.slice(0, GLOSSARY_DOCUMENT_V1_LIMITS.contextCodepoints) : null;
}

function parseTerm(value, index, targetLanguages) {
  const path = `$.terms[${index}]`;
  assertPlainObject(value, path, "INVALID_TERM");
  assertExactKeys(value, TERM_KEYS, path, ["id", "source", "translations", "provenance"]);
  const id = parseIdentifier(value.id, `${path}.id`);
  const source = parseText(value.source, `${path}.source`, GLOSSARY_DOCUMENT_V1_LIMITS.termCodepoints);
  const translations = parseTranslations(value.translations, `${path}.translations`, targetLanguages);
  const aliases = parseTextArray(value.aliases ?? [], `${path}.aliases`, GLOSSARY_DOCUMENT_V1_LIMITS.aliases, GLOSSARY_DOCUMENT_V1_LIMITS.termCodepoints);
  const pronunciation = parseNullableText(value.pronunciation, `${path}.pronunciation`, GLOSSARY_DOCUMENT_V1_LIMITS.termCodepoints);
  const doNotTranslate = value.doNotTranslate ?? false;
  if (typeof doNotTranslate !== "boolean") fail("INVALID_DO_NOT_TRANSLATE", `${path}.doNotTranslate`, "doNotTranslate must be boolean.");
  const forbiddenTranslations = parseTextArray(value.forbiddenTranslations ?? [], `${path}.forbiddenTranslations`,
    GLOSSARY_DOCUMENT_V1_LIMITS.forbiddenTranslations, GLOSSARY_DOCUMENT_V1_LIMITS.termCodepoints);
  const context = parseNullableText(value.context, `${path}.context`, GLOSSARY_DOCUMENT_V1_LIMITS.contextCodepoints);
  const examples = parseTextArray(value.examples ?? [], `${path}.examples`, GLOSSARY_DOCUMENT_V1_LIMITS.examples, GLOSSARY_DOCUMENT_V1_LIMITS.contextCodepoints);
  const tags = parseTextArray(value.tags ?? [], `${path}.tags`, GLOSSARY_DOCUMENT_V1_LIMITS.tags, 64);
  const priority = value.priority ?? 50;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) fail("INVALID_PRIORITY", `${path}.priority`, "priority must be an integer from 0 to 100.");
  const provenance = parseProvenance(value.provenance, `${path}.provenance`);
  if (doNotTranslate && Object.keys(translations).length > 0) {
    fail("DO_NOT_TRANSLATE_CONFLICT", `${path}.doNotTranslate`, "doNotTranslate terms cannot define translations.");
  }
  const approved = new Set(Object.values(translations).map(normalizeComparison));
  if (forbiddenTranslations.some((translation) => approved.has(normalizeComparison(translation)))) {
    fail("CONFLICTING_TRANSLATION", `${path}.forbiddenTranslations`, "An approved translation cannot also be forbidden.");
  }
  return {
    id,
    source,
    translations,
    aliases: sortUniqueText(aliases),
    pronunciation,
    doNotTranslate,
    forbiddenTranslations: sortUniqueText(forbiddenTranslations),
    context,
    examples,
    tags: sortUniqueText(tags),
    priority,
    provenance,
  };
}

function parseTranslations(value, path, targetLanguages) {
  assertPlainObject(value, path, "INVALID_TRANSLATIONS");
  const allowed = new Set(targetLanguages);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("UNSUPPORTED_LANGUAGE", `${path}.${key}`, "Translation language must be declared in targetLanguages.");
  }
  const translations = {};
  for (const language of targetLanguages) {
    if (Object.hasOwn(value, language)) translations[language] = parseText(value[language], `${path}.${language}`, GLOSSARY_DOCUMENT_V1_LIMITS.termCodepoints);
  }
  return translations;
}

function parseProvenance(value, path) {
  assertPlainObject(value, path, "INVALID_PROVENANCE");
  assertExactKeys(value, PROVENANCE_KEYS, path, ["kind"]);
  if (!PROVENANCE_KINDS.has(value.kind)) fail("INVALID_PROVENANCE", `${path}.kind`, "Unsupported provenance kind.");
  return { kind: value.kind, label: parseNullableText(value.label, `${path}.label`, GLOSSARY_DOCUMENT_V1_LIMITS.provenanceLabelCodepoints) };
}

function assertUniqueTerms(terms) {
  const ids = new Set();
  const sources = new Set();
  const lookups = new Map();
  for (const term of terms) {
    const id = normalizeComparison(term.id);
    if (ids.has(id)) fail("DUPLICATE_TERM_ID", "$.terms", "Term IDs must be unique.");
    ids.add(id);
    const source = normalizeComparison(term.source);
    if (sources.has(source)) fail("DUPLICATE_TERM", "$.terms", "Normalized source terms must be unique.");
    sources.add(source);
    for (const [kind, value] of [["source", term.source], ...term.aliases.map((alias) => ["alias", alias])]) {
      const key = normalizeComparison(value);
      const existing = lookups.get(key);
      if (existing && existing.termId !== term.id) {
        fail(kind === "alias" ? "CONFLICTING_ALIAS" : "DUPLICATE_TERM", "$.terms", "Sources and aliases cannot resolve to different terms.");
      }
      if (existing) fail("DUPLICATE_ALIAS", "$.terms", "A source or alias is duplicated.");
      lookups.set(key, { termId: term.id, kind });
    }
  }
}

function parseTextArray(value, path, maximumItems, maximumCodepoints) {
  if (!Array.isArray(value) || value.length > maximumItems) fail("ARRAY_TOO_LARGE", path, `Array may contain at most ${maximumItems} entries.`);
  return value.map((item, index) => parseText(item, `${path}[${index}]`, maximumCodepoints));
}

function parseNullableText(value, path, maximumCodepoints) {
  return value === undefined || value === null ? null : parseText(value, path, maximumCodepoints);
}

function parseText(value, path, maximumCodepoints) {
  if (typeof value !== "string") fail("INVALID_TEXT", path, "Expected text.");
  const nfcValue = value.normalize("NFC");
  if (/[<>\p{Cc}\p{Cf}]/u.test(nfcValue) || hasUnpairedSurrogate(nfcValue)) {
    fail("UNSAFE_TEXT", path, "Text contains markup, control, directional, or invalid Unicode characters.");
  }
  const normalized = nfcValue.trim().replace(/\s+/gu, " ");
  if (!normalized) fail("INVALID_TEXT", path, "Text cannot be empty.");
  if (codepointLength(normalized) > maximumCodepoints) fail("TEXT_TOO_LONG", path, `Text exceeds ${maximumCodepoints} codepoints.`);
  if (EXECUTABLE_CONTENT_PATTERN.test(normalized)) fail("EXECUTABLE_CONTENT", path, "Executable-looking instructions are not allowed.");
  return normalized;
}

function parseIdentifier(value, path) {
  const id = parseText(value, path, GLOSSARY_DOCUMENT_V1_LIMITS.idCodepoints);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(id)) fail("INVALID_ID", path, "Term ID contains unsupported characters.");
  return id;
}

function parseLanguage(value, path) {
  if (typeof value !== "string" || !LANGUAGE_ORDER.has(value)) fail("UNSUPPORTED_LANGUAGE", path, "Unsupported caption language.");
  return value;
}

function parseTimestamp(value, path) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail("INVALID_TIMESTAMP", path, "Timestamp must be canonical UTC ISO-8601.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail("INVALID_TIMESTAMP", path, "Timestamp is invalid.");
  return value;
}

function assertExactKeys(value, allowed, path, required) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail("UNKNOWN_KEY", path, `Unknown key: ${unknown}.`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) fail("MISSING_KEY", `${path}.${missing}`, `Missing key: ${missing}.`);
}

function assertPlainObject(value, path, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    if (code === "INVALID_LEGACY_GLOSSARY") throw new Error(code);
    fail(code, path, "Expected a plain object.");
  }
}

function fingerprintCanonicalDocument(document) {
  return `sha256:${createHash("sha256").update(JSON.stringify(createSemanticPayload(document)), "utf8").digest("hex")}`;
}

function createSemanticPayload(document) {
  return {
    schemaVersion: document.schemaVersion,
    name: document.name,
    domain: document.domain,
    sourceLanguage: document.sourceLanguage,
    targetLanguages: document.targetLanguages,
    terms: document.terms.map((term) => {
      const semanticTerm = {
        id: term.id,
        source: term.source,
        translations: term.translations,
        provenance: term.provenance.label === null ? { kind: term.provenance.kind } : term.provenance,
      };
      if (term.aliases.length > 0) semanticTerm.aliases = term.aliases;
      if (term.pronunciation !== null) semanticTerm.pronunciation = term.pronunciation;
      if (term.doNotTranslate) semanticTerm.doNotTranslate = true;
      if (term.forbiddenTranslations.length > 0) semanticTerm.forbiddenTranslations = term.forbiddenTranslations;
      if (term.context !== null) semanticTerm.context = term.context;
      if (term.examples.length > 0) semanticTerm.examples = term.examples;
      if (term.tags.length > 0) semanticTerm.tags = term.tags;
      if (term.priority !== 50) semanticTerm.priority = term.priority;
      return semanticTerm;
    }),
  };
}

function createLookupEntry(term, kind, value) {
  return { termId: term.id, kind, value, normalizedValue: normalizeComparison(value), priority: term.priority };
}

function compareCompiledEntry(left, right) {
  return compareText(left.termId, right.termId) || compareText(left.kind, right.kind) || compareText(left.normalizedValue, right.normalizedValue);
}

function contextTokens(value) {
  return [...new Set((String(value).normalize("NFC").toLocaleLowerCase("und").match(/[\p{L}\p{N}][\p{L}\p{N}&+.-]*/gu) ?? []))]
    .sort(compareText);
}

function sortUniqueText(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = normalizeComparison(value);
    if (seen.has(key)) fail("DUPLICATE_VALUE", "$.terms", "Normalized array values must be unique.");
    seen.add(key);
    output.push(value);
  }
  return output.sort(compareText);
}

function normalizeComparison(value) {
  return String(value).normalize("NFC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codepointLength(value) {
  return Array.from(value).length;
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

function assertNoDuplicateJsonKeys(source) {
  let index = 0;
  const skipWhitespace = () => { while (/\s/u.test(source[index] ?? "")) index += 1; };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === '"') { index += 1; return JSON.parse(source.slice(start, index)); }
      index += 1;
    }
    fail("INVALID_JSON", "$", "Glossary input must be valid JSON.");
  };
  const readValue = (depth) => {
    if (depth > 32) fail("JSON_TOO_DEEP", "$", "Glossary JSON nesting is too deep.");
    skipWhitespace();
    if (source[index] === "{") {
      index += 1;
      const keys = new Set();
      skipWhitespace();
      while (source[index] !== "}") {
        const key = readString().normalize("NFC");
        if (keys.has(key)) fail("DUPLICATE_JSON_KEY", "$", "JSON object keys must be unique.");
        keys.add(key);
        skipWhitespace();
        index += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (source[index] === ",") { index += 1; skipWhitespace(); } else break;
      }
      index += 1;
      return;
    }
    if (source[index] === "[") {
      index += 1;
      skipWhitespace();
      while (source[index] !== "]") {
        readValue(depth + 1);
        skipWhitespace();
        if (source[index] === ",") { index += 1; skipWhitespace(); } else break;
      }
      index += 1;
      return;
    }
    if (source[index] === '"') { readString(); return; }
    while (index < source.length && !/[\s,}\]]/u.test(source[index])) index += 1;
  };
  readValue(0);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(code, path, message) {
  throw new GlossaryDocumentValidationError({ code, path, message });
}
