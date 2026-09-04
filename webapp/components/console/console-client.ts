import type { ApiResponse } from "@/lib/live-contract";
import { CONSOLE_ERROR_MESSAGE_KEYS } from "@/lib/system-language/console-messages";

/** A `/api/console/*` failure envelope surfaced to the panels; `code` selects the console copy. */
export class ConsoleRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ConsoleRequestError";
    this.code = code;
    this.status = status;
  }
}

/** Same-origin JSON call with the `{ ok, data }` envelope unwrapped; every write sends `Content-Type: application/json`. */
export async function consoleFetch<T>(url: string, init: { method?: "GET" | "PATCH" | "PUT"; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let payload: ApiResponse<T> | null = null;
  try { payload = await response.json() as ApiResponse<T>; } catch { payload = null; }
  if (!payload || typeof payload !== "object") throw new ConsoleRequestError("invalid response", "INVALID_RESPONSE", response.status);
  if (!payload.ok) throw new ConsoleRequestError(payload.error, payload.code, response.status);
  return payload.data;
}

/** Console message key for a failed request: a known server code wins, otherwise the panel's fallback copy. */
export function consoleErrorKey(error: unknown, fallbackKey: string): string {
  if (error instanceof ConsoleRequestError && Object.hasOwn(CONSOLE_ERROR_MESSAGE_KEYS, error.code)) return CONSOLE_ERROR_MESSAGE_KEYS[error.code];
  return fallbackKey;
}
