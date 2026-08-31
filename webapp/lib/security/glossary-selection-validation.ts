const MAXIMUM_SELECTIONS = 5;
const MAXIMUM_SOURCE_ID_CODEPOINTS = 128;
const MAXIMUM_SOURCE_ID_UTF8_BYTES = 512;
const MAXIMUM_DOCUMENT_VERSION = 2_147_483_647;

const DISALLOWED_IDENTIFIER_CHARACTERS = /[<>\p{Cc}\p{Cf}]/u;
const HOST_GLOSSARY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const BUILTIN_GLOSSARY_SOURCE_IDS = Object.freeze([
  "common_business",
  "ai_ax",
  "commercial_real_estate",
  "hospitality",
  "fnb_retail",
  "proper_nouns",
  "ko_ja_idioms",
] as const);

const BUILTIN_GLOSSARY_SOURCE_ID_SET = new Set<string>(BUILTIN_GLOSSARY_SOURCE_IDS);

export const glossarySelectionContract = Object.freeze({
  maximumSelections: MAXIMUM_SELECTIONS,
  maximumSourceIdCodepoints: MAXIMUM_SOURCE_ID_CODEPOINTS,
  maximumSourceIdUtf8Bytes: MAXIMUM_SOURCE_ID_UTF8_BYTES,
  maximumDocumentVersion: MAXIMUM_DOCUMENT_VERSION,
  builtinDocumentVersion: 1,
});

export type BuiltinGlossarySourceId = typeof BUILTIN_GLOSSARY_SOURCE_IDS[number];

export type GlossarySelection = Readonly<{
  sourceKind: "builtin";
  sourceId: BuiltinGlossarySourceId;
  documentVersion: 1;
}> | Readonly<{
  sourceKind: "host";
  sourceId: string;
  documentVersion: number;
}>;

export class GlossarySelectionValidationError extends Error {
  readonly code = "INVALID_GLOSSARY_SELECTION";
  readonly status = 400;

  constructor() {
    super("용어집 선택이 올바르지 않습니다.");
    this.name = "GlossarySelectionValidationError";
  }
}

/**
 * Validates the API `glossaries` array and returns immutable canonical refs.
 * Builtin versions are catalog-owned and therefore never accepted from input.
 */
export function parseGlossarySelections(value: unknown): readonly GlossarySelection[] {
  if (!isDenseArray(value)
    || value.length < 1
    || value.length > MAXIMUM_SELECTIONS) throw invalidSelection();

  const selections: GlossarySelection[] = [];
  const sourceIdentities = new Set<string>();
  for (const item of value) {
    const selection = parseSelection(item);
    const identity = `${selection.sourceKind}\u0000${selection.sourceId}`;
    if (sourceIdentities.has(identity)) throw invalidSelection();
    sourceIdentities.add(identity);
    selections.push(selection);
  }
  return Object.freeze(selections);
}

function parseSelection(value: unknown): GlossarySelection {
  if (!isPlainDataObject(value)) throw invalidSelection();
  const sourceKindDescriptor = Object.getOwnPropertyDescriptor(value, "sourceKind");
  if (sourceKindDescriptor === undefined
    || !Object.hasOwn(sourceKindDescriptor, "value")
    || sourceKindDescriptor.enumerable !== true) throw invalidSelection();
  const sourceKind = sourceKindDescriptor.value;
  if (sourceKind === "builtin") {
    if (!hasExactDataKeys(value, ["sourceKind", "sourceId"])) throw invalidSelection();
    const sourceId = parseSourceId(value.sourceId);
    if (!BUILTIN_GLOSSARY_SOURCE_ID_SET.has(sourceId)) throw invalidSelection();
    return Object.freeze({
      sourceKind,
      sourceId: sourceId as BuiltinGlossarySourceId,
      documentVersion: 1 as const,
    });
  }
  if (sourceKind === "host") {
    if (!hasExactDataKeys(value, ["sourceKind", "sourceId", "documentVersion"])) throw invalidSelection();
    const sourceId = parseSourceId(value.sourceId).toLowerCase();
    if (!HOST_GLOSSARY_UUID.test(sourceId)) throw invalidSelection();
    const documentVersion = value.documentVersion;
    if (!Number.isSafeInteger(documentVersion)
      || Number(documentVersion) < 1
      || Number(documentVersion) > MAXIMUM_DOCUMENT_VERSION) throw invalidSelection();
    return Object.freeze({ sourceKind, sourceId, documentVersion: Number(documentVersion) });
  }
  throw invalidSelection();
}

function parseSourceId(value: unknown): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > MAXIMUM_SOURCE_ID_CODEPOINTS * 2
    || value.normalize("NFC") !== value
    || DISALLOWED_IDENTIFIER_CHARACTERS.test(value)
    || Array.from(value).length > MAXIMUM_SOURCE_ID_CODEPOINTS
    || new TextEncoder().encode(value).byteLength > MAXIMUM_SOURCE_ID_UTF8_BYTES) {
    throw invalidSelection();
  }
  return value;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Object.keys(value);
  return keys.length === value.length
    && keys.every((key, index) => key === String(index));
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.enumerable === true;
  });
}

function invalidSelection(): GlossarySelectionValidationError {
  return new GlossarySelectionValidationError();
}
