import type { NextRequest } from "next/server";

import { AuthenticationError, requireHost } from "@/lib/auth/live-auth";
import {
  CandidateExtractionError,
  assertGlossaryMultipartContentType,
  assertGlossaryMultipartContentLength,
  extractGlossaryCandidates,
  parseGlossaryCandidateExtractionMetadata,
  readBoundedGlossaryMultipartFormData,
  withGlossaryExtractionAdmission,
} from "@/lib/glossary-presets/candidate-extraction";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { assertStrictOrigin, CsrfError } from "@/lib/security/csrf";
import {
  assertGlossaryCandidatePdf,
  HostGlossaryPresetValidationError,
} from "@/lib/security/host-glossary-preset-validation";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { enforceGlossaryCandidateExtractionRateLimit } from "@/lib/security/live-rate-limit";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";

export async function POST(request: NextRequest) {
  try {
    assertStrictOrigin(request);
    const { hostId } = await requireHost(request);
    const store = new SupabaseLiveAdmissionStore();
    await enforceGlossaryCandidateExtractionRateLimit(hostId, store);
    assertGlossaryMultipartContentType(request.headers);
    const contentLength = assertGlossaryMultipartContentLength(request.headers);
    return await withGlossaryExtractionAdmission(contentLength, request.signal, async (signal) => {
      const formData = await readBoundedGlossaryMultipartFormData(request, contentLength, signal);
      const { file, metadata } = parseMultipartForm(formData);
      const pdfBytes = new Uint8Array(await file.arrayBuffer());
      assertGlossaryCandidatePdf(file.type, pdfBytes);
      const candidates = await extractGlossaryCandidates({ hostId, pdfBytes, ...metadata, signal });
      return apiSuccess({ candidates }, { headers: privateNoStoreHeaders() });
    });
  } catch (error: unknown) {
    if (error instanceof CsrfError) return failure(error.message, "INVALID_ORIGIN", 403);
    if (error instanceof AuthenticationError) return failure(error.message, "HOST_LOGIN_REQUIRED", 401);
    if (error instanceof LiveAdmissionError) return failure(error.message, error.code, error.status);
    if (error instanceof HostGlossaryPresetValidationError) return failure(error.message, error.code, error.status);
    if (error instanceof CandidateExtractionError) return failure(error.message, error.code, error.status);
    if (error instanceof DOMException && error.name === "AbortError") {
      return failure("PDF 용어 추출 시간이 초과되었습니다.", "GLOSSARY_EXTRACTION_TIMEOUT", 504);
    }
    return failure("PDF에서 용어를 추출할 수 없습니다.", "GLOSSARY_EXTRACTION_FAILED", 500);
  }
}

function parseMultipartForm(formData: FormData): {
  file: File;
  metadata: ReturnType<typeof parseGlossaryCandidateExtractionMetadata>;
} {
  const allowedKeys = new Set(["domain", "file", "sourceLanguage", "targetLanguages"]);
  if ([...formData.keys()].some((key) => !allowedKeys.has(key))) invalidMultipartInput();
  const files = formData.getAll("file");
  const sourceLanguages = formData.getAll("sourceLanguage");
  const domains = formData.getAll("domain");
  const targetLanguages = formData.getAll("targetLanguages");
  if (files.length !== 1 || !(files[0] instanceof File)
    || sourceLanguages.length !== 1 || typeof sourceLanguages[0] !== "string"
    || domains.length !== 1 || typeof domains[0] !== "string"
    || targetLanguages.some((language) => typeof language !== "string")) invalidMultipartInput();
  return {
    file: files[0],
    metadata: parseGlossaryCandidateExtractionMetadata({
      sourceLanguage: sourceLanguages[0],
      targetLanguages,
      domain: domains[0],
    }),
  };
}

function invalidMultipartInput(): never {
  throw new CandidateExtractionError(
    "PDF 용어 추출 입력이 올바르지 않습니다.",
    "INVALID_GLOSSARY_EXTRACTION_INPUT",
    400,
  );
}

function failure(error: string, code: string, status: number) {
  return apiError(error, code, status, privateNoStoreHeaders());
}
