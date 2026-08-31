import { createHash } from "node:crypto";

import { createGeminiPdfGlossaryExtractor as createUntypedGeminiPdfGlossaryExtractor } from "../../../packages/gemini-server/index.js";
import { parseGlossaryDocumentV1 } from "../../../packages/caption-core/index.js";
import { LANGUAGE_CODES } from "../languageDetect";
import { getMeetingSummaryConfig } from "../live/config";

export const MAX_GLOSSARY_MULTIPART_BYTES = 10_100_000;
const MAX_DOMAIN_CODEPOINTS = 1_000;
const MAX_CANDIDATES = 200;
const MAX_CONCURRENT_EXTRACTIONS = 2;
const EXTRACTION_TIMEOUT_MILLISECONDS = 45_000;
const executableContentPattern = /(?:javascript|vbscript|data)\s*:|(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions?|system\s+prompt|\$\{|\{\{/iu;

export type CandidateExtractionErrorCode =
  | "GLOSSARY_CONTENT_LENGTH_REQUIRED"
  | "INVALID_GLOSSARY_EXTRACTION_INPUT"
  | "GLOSSARY_EXTRACTION_RESULT_INVALID"
  | "GLOSSARY_EXTRACTION_TOO_LARGE"
  | "GLOSSARY_EXTRACTION_RATE_LIMITED"
  | "GLOSSARY_EXTRACTION_BUSY"
  | "GLOSSARY_EXTRACTION_TIMEOUT"
  | "GLOSSARY_EXTRACTION_FAILED";

export class CandidateExtractionError extends Error {
  readonly code: CandidateExtractionErrorCode;
  readonly status: number;

  constructor(message: string, code: CandidateExtractionErrorCode, status: number) {
    super(message);
    this.name = "CandidateExtractionError";
    this.code = code;
    this.status = status;
  }
}

export interface GlossaryCandidateExtractionMetadata {
  readonly sourceLanguage: string;
  readonly targetLanguages: readonly string[];
  readonly domain: string;
}

export interface GlossaryTermCandidate {
  readonly id: string;
  readonly source: string;
  readonly translations: Readonly<Record<string, string>>;
  readonly aliases: readonly string[];
  readonly pronunciation: string | null;
  readonly doNotTranslate: boolean;
  readonly forbiddenTranslations: readonly string[];
  readonly context: string | null;
  readonly examples: readonly string[];
  readonly tags: readonly string[];
  readonly priority: number;
  readonly provenance: Readonly<{ kind: "ai_extracted"; label: string | null }>;
}

interface CandidateExtractor {
  extract(input: {
    requestId: string;
    pdfBytes: Uint8Array;
    sourceLanguage: string;
    targetLanguages: readonly string[];
    domain: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

interface CandidateExtractorInput extends GlossaryCandidateExtractionMetadata {
  readonly hostId: string;
  readonly pdfBytes: Uint8Array;
  readonly signal?: AbortSignal;
}

interface GlossaryExtractionAdmissionLease {
  readonly signal: AbortSignal;
  release(): void;
}

export interface GlossaryExtractionAdmissionGate {
  acquire(contentLength: number, requestSignal: AbortSignal, timeoutMilliseconds: number): GlossaryExtractionAdmissionLease;
}

interface GlossaryExtractionAdmissionOptions {
  readonly gate?: GlossaryExtractionAdmissionGate;
  readonly timeoutMilliseconds?: number;
}

interface GlossaryMultipartRequest {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: Pick<Headers, "get">;
}

type GeminiPdfGlossaryExtractorFactory = (options: { apiKey: string }) => CandidateExtractor;
const createGeminiPdfGlossaryExtractor = createUntypedGeminiPdfGlossaryExtractor as unknown as GeminiPdfGlossaryExtractorFactory;

export function parseGlossaryCandidateExtractionMetadata(input: unknown): GlossaryCandidateExtractionMetadata {
  if (!isRecord(input) || !hasExactKeys(input, ["domain", "sourceLanguage", "targetLanguages"])) invalidInput();
  if (typeof input.sourceLanguage !== "string" || !LANGUAGE_CODES.includes(input.sourceLanguage as typeof LANGUAGE_CODES[number])) {
    invalidInput();
  }
  if (!Array.isArray(input.targetLanguages)
    || input.targetLanguages.length < 1
    || input.targetLanguages.length > 13
    || input.targetLanguages.some((language) => typeof language !== "string"
      || !LANGUAGE_CODES.includes(language as typeof LANGUAGE_CODES[number])
      || language === input.sourceLanguage)
    || new Set(input.targetLanguages).size !== input.targetLanguages.length) invalidInput();
  if (typeof input.domain !== "string") invalidInput();
  const domain = input.domain.normalize("NFC").trim();
  if (Array.from(domain).length > MAX_DOMAIN_CODEPOINTS || /[<>\p{Cc}\p{Cf}]/u.test(domain)
    || executableContentPattern.test(domain)) invalidInput();
  return Object.freeze({
    sourceLanguage: input.sourceLanguage,
    targetLanguages: Object.freeze([...input.targetLanguages].sort((left, right) => (
      LANGUAGE_CODES.indexOf(left as typeof LANGUAGE_CODES[number])
      - LANGUAGE_CODES.indexOf(right as typeof LANGUAGE_CODES[number])
    ))) as readonly string[],
    domain,
  });
}

export function assertGlossaryMultipartContentLength(headers: Pick<Headers, "get">): number {
  const raw = headers.get("content-length");
  if (raw === null) {
    throw new CandidateExtractionError(
      "PDF 용어 추출 요청 크기를 확인할 수 없습니다.",
      "GLOSSARY_CONTENT_LENGTH_REQUIRED",
      411,
    );
  }
  if (!/^[1-9]\d*$/u.test(raw)) invalidInput();
  const contentLength = Number(raw);
  if (!Number.isSafeInteger(contentLength)) invalidInput();
  if (contentLength > MAX_GLOSSARY_MULTIPART_BYTES) {
    throw new CandidateExtractionError(
      "PDF 용어 추출 요청은 10MB 이하여야 합니다.",
      "GLOSSARY_EXTRACTION_TOO_LARGE",
      413,
    );
  }
  return contentLength;
}

export function assertGlossaryMultipartContentType(headers: Pick<Headers, "get">): void {
  const contentType = headers.get("content-type") ?? "";
  if (!/^multipart\/form-data; boundary=[A-Za-z0-9_-]{1,70}$/u.test(contentType)) invalidInput();
}

export async function readBoundedGlossaryMultipartFormData(
  request: GlossaryMultipartRequest,
  contentLength: number,
  signal: AbortSignal,
): Promise<FormData> {
  if (!request.body || !Number.isSafeInteger(contentLength)
    || contentLength < 1 || contentLength > MAX_GLOSSARY_MULTIPART_BYTES) invalidInput();
  const contentType = request.headers.get("content-type");
  if (!contentType) invalidInput();

  const reader = request.body.getReader();
  const bytes = new Uint8Array(contentLength);
  let offset = 0;
  let isComplete = false;
  try {
    while (true) {
      const part = await awaitWithAbort(reader.read(), signal);
      if (part.done) {
        isComplete = true;
        break;
      }
      if (!(part.value instanceof Uint8Array) || offset + part.value.byteLength > contentLength) invalidInput();
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (offset !== contentLength) invalidInput();
    const bufferedRequest = new Request("http://localhost/internal-glossary-upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes,
      signal,
    });
    return await awaitWithAbort(bufferedRequest.formData(), signal);
  } catch (error) {
    if (error instanceof CandidateExtractionError || isAbortError(error)) throw error;
    return invalidInput();
  } finally {
    if (!isComplete) void reader.cancel(signal.reason).catch(() => undefined);
  }
}

export function createGlossaryExtractionAdmissionGate(
  maxConcurrent: number = MAX_CONCURRENT_EXTRACTIONS,
): GlossaryExtractionAdmissionGate {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError("INVALID_EXTRACTION_ADMISSION_LIMIT");
  let activeCount = 0;
  return Object.freeze({
    acquire(contentLength: number, requestSignal: AbortSignal, timeoutMilliseconds: number) {
      if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_GLOSSARY_MULTIPART_BYTES) {
        invalidInput();
      }
      if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) invalidInput();
      if (activeCount >= maxConcurrent) {
        throw new CandidateExtractionError(
          "PDF 용어 추출이 혼잡합니다. 잠시 후 다시 시도해 주세요.",
          "GLOSSARY_EXTRACTION_BUSY",
          503,
        );
      }

      activeCount += 1;
      const deadlineController = new AbortController();
      const timeout = setTimeout(() => {
        deadlineController.abort(new DOMException("PDF glossary extraction deadline exceeded", "AbortError"));
      }, timeoutMilliseconds);
      const signal = AbortSignal.any([requestSignal, deadlineController.signal]);
      let isReleased = false;
      return Object.freeze({
        signal,
        release() {
          if (isReleased) return;
          isReleased = true;
          clearTimeout(timeout);
          activeCount -= 1;
        },
      });
    },
  });
}

const glossaryExtractionAdmissionGate = createGlossaryExtractionAdmissionGate();

export async function withGlossaryExtractionAdmission<T>(
  contentLength: number,
  requestSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
  options: GlossaryExtractionAdmissionOptions = {},
): Promise<T> {
  const lease = (options.gate ?? glossaryExtractionAdmissionGate).acquire(
    contentLength,
    requestSignal,
    options.timeoutMilliseconds ?? EXTRACTION_TIMEOUT_MILLISECONDS,
  );
  try {
    return await operation(lease.signal);
  } finally {
    lease.release();
  }
}

export async function extractGlossaryCandidates(
  input: CandidateExtractorInput,
  extractor: CandidateExtractor = getCachedCandidateExtractor(),
): Promise<readonly GlossaryTermCandidate[]> {
  const metadata = parseGlossaryCandidateExtractionMetadata({
    sourceLanguage: input.sourceLanguage,
    targetLanguages: input.targetLanguages,
    domain: input.domain,
  });
  if (typeof input.hostId !== "string" || !input.hostId || !(input.pdfBytes instanceof Uint8Array)) invalidInput();
  const requestId = `host-${createHash("sha256").update(input.hostId).digest("hex")}`;
  const inFlightKey = createHash("sha256")
    .update(input.hostId)
    .update("\0")
    .update(input.pdfBytes)
    .update("\0")
    .update(metadata.sourceLanguage)
    .update("\0")
    .update(metadata.targetLanguages.join(","))
    .update("\0")
    .update(metadata.domain)
    .digest("hex");
  const inFlight = getCandidateExtractorInFlightMap(extractor);
  const existing = inFlight.get(inFlightKey);
  if (existing) return awaitWithAbort(existing, input.signal);

  const extraction = runCandidateExtraction(input, metadata, requestId, extractor);
  if (inFlight.size < MAX_CONCURRENT_EXTRACTIONS) {
    inFlight.set(inFlightKey, extraction);
    void extraction.then(
      () => { if (inFlight.get(inFlightKey) === extraction) inFlight.delete(inFlightKey); },
      () => { if (inFlight.get(inFlightKey) === extraction) inFlight.delete(inFlightKey); },
    );
  }
  return awaitWithAbort(extraction, input.signal);
}

const candidateExtractorInFlight = new WeakMap<CandidateExtractor, Map<string, Promise<readonly GlossaryTermCandidate[]>>>();

function getCandidateExtractorInFlightMap(
  extractor: CandidateExtractor,
): Map<string, Promise<readonly GlossaryTermCandidate[]>> {
  const existing = candidateExtractorInFlight.get(extractor);
  if (existing) return existing;
  const created = new Map<string, Promise<readonly GlossaryTermCandidate[]>>();
  candidateExtractorInFlight.set(extractor, created);
  return created;
}

async function runCandidateExtraction(
  input: CandidateExtractorInput,
  metadata: GlossaryCandidateExtractionMetadata,
  requestId: string,
  extractor: CandidateExtractor,
): Promise<readonly GlossaryTermCandidate[]> {
  let result: unknown;
  try {
    result = await extractor.extract({ requestId, pdfBytes: input.pdfBytes, ...metadata, signal: input.signal });
  } catch (error) {
    throw mapProviderError(error);
  }
  return validateCandidateResult(result, metadata);
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function validateCandidateResult(
  result: unknown,
  metadata: GlossaryCandidateExtractionMetadata,
): readonly GlossaryTermCandidate[] {
  if (!isRecord(result) || !hasExactKeys(result, ["candidates"]) || !Array.isArray(result.candidates)
    || result.candidates.length > MAX_CANDIDATES) invalidResult();
  if (result.candidates.length === 0) return Object.freeze([]);
  try {
    const document = parseGlossaryDocumentV1({
      schemaVersion: 1,
      name: "AI glossary candidates",
      domain: metadata.domain,
      sourceLanguage: metadata.sourceLanguage,
      targetLanguages: metadata.targetLanguages,
      terms: result.candidates,
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      version: 1,
    });
    if (document.terms.some((term: { id: unknown; provenance: { kind?: unknown } }) => (
      typeof term.id !== "string"
      || !/^candidate-\d{4}$/u.test(term.id)
      || term.provenance.kind !== "ai_extracted"
    ))) invalidResult();
    return document.terms as readonly GlossaryTermCandidate[];
  } catch (error) {
    if (error instanceof CandidateExtractionError) throw error;
    return invalidResult();
  }
}

function mapProviderError(error: unknown): CandidateExtractionError {
  const code = error instanceof Error ? error.message : "";
  if (code === "GEMINI_PROVIDER_RATE_LIMITED") {
    return new CandidateExtractionError(
      "PDF 용어 추출 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      "GLOSSARY_EXTRACTION_RATE_LIMITED",
      429,
    );
  }
  if (code === "GEMINI_GLOSSARY_OUTPUT_INVALID") {
    return new CandidateExtractionError(
      "PDF 용어 추출 결과가 올바르지 않습니다.",
      "GLOSSARY_EXTRACTION_RESULT_INVALID",
      502,
    );
  }
  if (code === "AbortError" || (error instanceof Error && error.name === "AbortError")) {
    return new CandidateExtractionError(
      "PDF 용어 추출 시간이 초과되었습니다.",
      "GLOSSARY_EXTRACTION_TIMEOUT",
      504,
    );
  }
  return new CandidateExtractionError(
    "PDF에서 용어를 추출할 수 없습니다.",
    "GLOSSARY_EXTRACTION_FAILED",
    502,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function invalidInput(): never {
  throw new CandidateExtractionError(
    "PDF 용어 추출 입력이 올바르지 않습니다.",
    "INVALID_GLOSSARY_EXTRACTION_INPUT",
    400,
  );
}

function invalidResult(): never {
  throw new CandidateExtractionError(
    "PDF 용어 추출 결과가 올바르지 않습니다.",
    "GLOSSARY_EXTRACTION_RESULT_INVALID",
    502,
  );
}

let cachedExtractor: { keyHash: string; extractor: CandidateExtractor } | null = null;

function getCachedCandidateExtractor(): CandidateExtractor {
  const { apiKey } = getMeetingSummaryConfig();
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  if (!cachedExtractor || cachedExtractor.keyHash !== keyHash) {
    cachedExtractor = { keyHash, extractor: createGeminiPdfGlossaryExtractor({ apiKey }) };
  }
  return cachedExtractor.extractor;
}
