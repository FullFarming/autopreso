export const MAX_LIVE_JSON_BODY_BYTES = 16_384;

interface JsonBodyRequest {
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

export class BoundedJsonBodyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "BoundedJsonBodyError";
    this.code = code;
    this.status = status;
  }
}

const EXACT_JSON_CONTENT_TYPE = /^application\/json(?:;\s*charset=utf-8)?$/iu;

export async function readBoundedJsonBody(
  request: JsonBodyRequest,
  maximumBytes = MAX_LIVE_JSON_BODY_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw invalidBody();
  }

  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!EXACT_JSON_CONTENT_TYPE.test(contentType)) {
    throw new BoundedJsonBodyError(
      "JSON 형식의 요청만 사용할 수 있습니다.",
      "LIVE_JSON_CONTENT_TYPE_REQUIRED",
      415,
    );
  }

  const declaredLength = parseDeclaredLength(request.headers.get("content-length"), maximumBytes);
  if (request.body === null) throw invalidBody();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (receivedBytes === 0 || (declaredLength !== null && declaredLength !== receivedBytes)) {
    throw invalidBody();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidBody();
  }
}

function parseDeclaredLength(raw: string | null, maximumBytes: number): number | null {
  if (raw === null) return null;
  if (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new BoundedJsonBodyError(
      "요청 크기가 올바르지 않습니다.",
      "INVALID_LIVE_JSON_CONTENT_LENGTH",
      400,
    );
  }
  const length = Number(raw);
  if (length > maximumBytes) throw tooLarge();
  return length;
}

function invalidBody(): BoundedJsonBodyError {
  return new BoundedJsonBodyError(
    "요청 형식이 올바르지 않습니다.",
    "INVALID_JSON",
    400,
  );
}

function tooLarge(): BoundedJsonBodyError {
  return new BoundedJsonBodyError(
    "요청 본문이 너무 큽니다.",
    "LIVE_JSON_BODY_TOO_LARGE",
    413,
  );
}
