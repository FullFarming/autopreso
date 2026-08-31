import { z } from "zod";

import {
  GlossaryDocumentValidationError,
  parseGlossaryDocumentV1,
} from "../../../packages/caption-core/index.js";
import { LANGUAGE_CODES, normalizeLanguageCode } from "../languageDetect";

export const MAX_GLOSSARY_PRESET_NAME_CHARS = 80;
export const MAX_GLOSSARY_PRESET_DOMAIN_CHARS = 600;
export const MAX_GLOSSARY_PRESET_GLOSSARY_CHARS = 16_000;
export const MAX_GLOSSARY_PRESETS_PER_HOST = 50;
export const MAX_GLOSSARY_IMPORT_BYTES = 5_000_000;
export const MAX_GLOSSARY_CANDIDATE_PDF_BYTES = 10_000_000;

type GlossaryDocumentDiagnostic = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export class HostGlossaryPresetValidationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly diagnostics: readonly GlossaryDocumentDiagnostic[];

  constructor(
    message: string,
    code: string,
    status: number,
    diagnostics: readonly GlossaryDocumentDiagnostic[] = [],
  ) {
    super(message);
    this.name = "HostGlossaryPresetValidationError";
    this.code = code;
    this.status = status;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

interface HeaderReader {
  get(name: string): string | null;
}

const exactJsonContentType = /^\s*application\/json\s*(?:;\s*charset\s*=\s*utf-8\s*)?$/iu;

export function assertGlossaryJsonContentType(headers: HeaderReader): void {
  const contentType = headers.get("content-type") ?? "";
  if (!exactJsonContentType.test(contentType)) {
    throw new HostGlossaryPresetValidationError(
      "JSON 형식의 용어집만 가져올 수 있습니다.",
      "GLOSSARY_CONTENT_TYPE_REQUIRED",
      415,
    );
  }
}

export function assertGlossaryJsonContentLength(headers: HeaderReader): void {
  const raw = headers.get("content-length");
  if (raw === null) {
    throw new HostGlossaryPresetValidationError(
      "용어집 요청 크기를 확인할 수 없습니다.",
      "GLOSSARY_CONTENT_LENGTH_REQUIRED",
      411,
    );
  }
  if (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HostGlossaryPresetValidationError(
      "용어집 요청 크기가 올바르지 않습니다.",
      "INVALID_GLOSSARY_CONTENT_LENGTH",
      400,
    );
  }
  if (Number(raw) > MAX_GLOSSARY_IMPORT_BYTES) {
    throw new HostGlossaryPresetValidationError(
      "용어집 파일은 5MB 이하여야 합니다.",
      "GLOSSARY_IMPORT_TOO_LARGE",
      413,
    );
  }
}

const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const pdfEndMarker = new Uint8Array([0x25, 0x25, 0x45, 0x4f, 0x46]);

function isAsciiPdfTrailingWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function hasBytesAt(body: Uint8Array, expected: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + expected.length > body.length) return false;
  return expected.every((byte, index) => body[offset + index] === byte);
}

export function assertGlossaryCandidatePdf(contentType: string | null, body: Uint8Array): void {
  if (body.byteLength > MAX_GLOSSARY_CANDIDATE_PDF_BYTES) {
    throw new HostGlossaryPresetValidationError(
      "PDF 파일은 10MB 이하여야 합니다.",
      "GLOSSARY_PDF_TOO_LARGE",
      413,
    );
  }

  let endMarkerOffset = -1;
  const earliestEndMarkerOffset = Math.max(0, body.length - 1_024);
  for (let offset = body.length - pdfEndMarker.length; offset >= earliestEndMarkerOffset; offset -= 1) {
    if (hasBytesAt(body, pdfEndMarker, offset)) {
      endMarkerOffset = offset;
      break;
    }
  }
  const suffixStart = endMarkerOffset + pdfEndMarker.length;
  const hasOnlyTrailingWhitespace = endMarkerOffset >= 0
    && body.slice(suffixStart).every(isAsciiPdfTrailingWhitespace);
  if (
    contentType !== "application/pdf"
    || body.byteLength === 0
    || !hasBytesAt(body, pdfMagic, 0)
    || !hasOnlyTrailingWhitespace
  ) {
    throw new HostGlossaryPresetValidationError(
      "PDF 파일 형식이 올바르지 않습니다.",
      "INVALID_GLOSSARY_PDF",
      400,
    );
  }
}

function decodeGlossaryImportBody(rawBody: string | Uint8Array): string {
  const byteLength = typeof rawBody === "string"
    ? new TextEncoder().encode(rawBody).byteLength
    : rawBody.byteLength;
  if (byteLength > MAX_GLOSSARY_IMPORT_BYTES) {
    throw new HostGlossaryPresetValidationError(
      "용어집 파일은 5MB 이하여야 합니다.",
      "GLOSSARY_IMPORT_TOO_LARGE",
      413,
    );
  }
  if (typeof rawBody === "string") return rawBody;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    throw new HostGlossaryPresetValidationError(
      "용어집 파일은 UTF-8 형식이어야 합니다.",
      "INVALID_GLOSSARY_ENCODING",
      400,
    );
  }
}

export function parseGlossaryDocumentImportBody(rawBody: string | Uint8Array): unknown {
  const text = decodeGlossaryImportBody(rawBody);
  try {
    return parseGlossaryDocumentV1(text);
  } catch (error) {
    if (!(error instanceof GlossaryDocumentValidationError)) throw error;
    const diagnostics = error instanceof Error
      && "diagnostics" in error
      && Array.isArray(error.diagnostics)
      ? error.diagnostics.filter((diagnostic): diagnostic is GlossaryDocumentDiagnostic => (
        typeof diagnostic === "object"
        && diagnostic !== null
        && "code" in diagnostic
        && typeof diagnostic.code === "string"
        && "path" in diagnostic
        && typeof diagnostic.path === "string"
        && "message" in diagnostic
        && typeof diagnostic.message === "string"
      ))
      : [];
    if (diagnostics.some((diagnostic) => diagnostic.code === "INVALID_JSON")) {
      throw new HostGlossaryPresetValidationError(
        "용어집 JSON 형식이 올바르지 않습니다.",
        "INVALID_GLOSSARY_JSON",
        400,
      );
    }
    throw new HostGlossaryPresetValidationError(
      "용어집 내용이 올바르지 않습니다.",
      "INVALID_GLOSSARY_DOCUMENT",
      400,
      diagnostics,
    );
  }
}

const disallowedSingleLineCharacters = /[<>]|\p{Cc}|\p{Cf}/u;
const disallowedGlossaryCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cf}/u;

function normalizeNfcAndTrim(value: string): string {
  return value.normalize("NFC").trim();
}

function hasLengthBetween(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

const languageSchema = z.preprocess(
  (value) => normalizeLanguageCode(value),
  z.enum(LANGUAGE_CODES),
);
const presetVersionSchema = z.number().int().min(1).max(2_147_483_647);

export const hostGlossaryPresetHostIdSchema = z
  .string()
  .transform(normalizeNfcAndTrim)
  .refine((value) => hasLengthBetween(value, 1, 100) && !disallowedSingleLineCharacters.test(value));

export const glossaryPresetIdSchema = z.string().uuid();

const presetNameSchema = z
  .string()
  .transform(normalizeNfcAndTrim)
  .refine((value) => hasLengthBetween(value, 1, MAX_GLOSSARY_PRESET_NAME_CHARS)
    && !disallowedSingleLineCharacters.test(value));

const presetDomainSchema = z
  .string()
  .transform(normalizeNfcAndTrim)
  .refine((value) => hasLengthBetween(value, 0, MAX_GLOSSARY_PRESET_DOMAIN_CHARS)
    && !disallowedSingleLineCharacters.test(value));

const presetGlossarySchema = z
  .string()
  .transform(normalizeNfcAndTrim)
  .refine((value) => hasLengthBetween(value, 1, MAX_GLOSSARY_PRESET_GLOSSARY_CHARS)
    && !disallowedGlossaryCharacters.test(value));

const languagePairSchema = z.object({
  a: languageSchema,
  b: languageSchema,
}).strict().refine(
  ({ a, b }) => a !== b,
  { path: ["b"], message: "서로 다른 두 언어를 선택해 주세요." },
);

const presetFieldsSchema = z.object({
  name: presetNameSchema,
  domain: presetDomainSchema,
  glossary: presetGlossarySchema,
  languagePair: languagePairSchema,
}).strict();

export const createGlossaryPresetInputSchema = presetFieldsSchema;

export const updateGlossaryPresetBodySchema = presetFieldsSchema.extend({
  version: presetVersionSchema,
});

export const deleteGlossaryPresetBodySchema = z.object({
  version: presetVersionSchema,
}).strict();

export type CreateGlossaryPresetInput = z.infer<typeof createGlossaryPresetInputSchema>;
export type UpdateGlossaryPresetBody = z.infer<typeof updateGlossaryPresetBodySchema>;
export type DeleteGlossaryPresetBody = z.infer<typeof deleteGlossaryPresetBodySchema>;
