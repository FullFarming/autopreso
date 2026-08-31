import { GoogleSheetsRequestError } from "./errors";

export const GOOGLE_SHEETS_API_ORIGIN = "https://sheets.googleapis.com";
export const GOOGLE_SHEETS_MAX_BATCH_BYTES = 2_000_000;

export type GoogleSheetBatchRequest = Readonly<Record<string, unknown>>;

export interface GoogleSheetsClient {
  batchUpdate(requests: readonly GoogleSheetBatchRequest[], options?: { signal?: AbortSignal }): Promise<void>;
}

interface GoogleSheetsClientOptions {
  workbookId: string;
  getAccessToken: () => Promise<string>;
  fetchFn?: typeof fetch;
}

export function createGoogleSheetsClient({
  workbookId,
  getAccessToken,
  fetchFn = fetch,
}: GoogleSheetsClientOptions): GoogleSheetsClient {
  if (!/^[A-Za-z0-9_-]{20,200}$/u.test(workbookId)) {
    throw new GoogleSheetsRequestError("SHEETS_INVALID_REQUEST");
  }
  let requestTail: Promise<void> = Promise.resolve();

  const dispatch = async (
    requests: readonly GoogleSheetBatchRequest[],
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 1_000) {
      throw new GoogleSheetsRequestError("SHEETS_INVALID_REQUEST");
    }
    const body = JSON.stringify({ requests, includeSpreadsheetInResponse: false });
    if (new TextEncoder().encode(body).byteLength >= GOOGLE_SHEETS_MAX_BATCH_BYTES) {
      throw new GoogleSheetsRequestError("SHEETS_PAYLOAD_TOO_LARGE");
    }
    if (signal?.aborted) throw new GoogleSheetsRequestError("SHEETS_ABORTED");
    let token: string;
    try {
      token = await withAbort(getAccessToken(), signal);
    } catch {
      if (signal?.aborted) throw new GoogleSheetsRequestError("SHEETS_ABORTED");
      throw new GoogleSheetsRequestError("SHEETS_AUTH_FAILED");
    }
    if (signal?.aborted) throw new GoogleSheetsRequestError("SHEETS_ABORTED");
    let response: Response;
    try {
      response = await fetchFn(
        `${GOOGLE_SHEETS_API_ORIGIN}/v4/spreadsheets/${encodeURIComponent(workbookId)}:batchUpdate`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal,
        },
      );
    } catch (error: unknown) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new GoogleSheetsRequestError("SHEETS_ABORTED");
      }
      throw new GoogleSheetsRequestError("SHEETS_PROVIDER_FAILED");
    }
    if (!response.ok) throw new GoogleSheetsRequestError(codeForStatus(response.status));
  };

  return {
    batchUpdate(requests, options = {}) {
      const operation = requestTail.then(() => dispatch(requests, options.signal));
      requestTail = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new GoogleSheetsRequestError("SHEETS_ABORTED"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new GoogleSheetsRequestError("SHEETS_ABORTED"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
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

function codeForStatus(status: number) {
  if (status === 401) return "SHEETS_AUTH_FAILED" as const;
  if (status === 403) return "SHEETS_FORBIDDEN" as const;
  if (status === 404) return "SHEETS_NOT_FOUND" as const;
  if (status === 409) return "SHEETS_CONFLICT" as const;
  if (status === 429) return "SHEETS_RATE_LIMITED" as const;
  if (status >= 500) return "SHEETS_UNAVAILABLE" as const;
  return "SHEETS_PROVIDER_FAILED" as const;
}
