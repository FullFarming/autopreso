import type { EngineSelection } from "./model-preferences";

/** Outcome of one admin engine push (auth console spec §9). Never thrown. */
export interface EnginePushResult {
  result: "switched" | "queued" | "failed";
  code?: string;
}

export const ENGINE_PUSH_TIMEOUT_MS = 8_000;
const RESULT_VALUES = new Set(["switched", "queued", "failed"]);
const CODE_PATTERN = /^[A-Z0-9_]{1,80}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * HTTP origin of the gateway's internal engine endpoint, derived from the WS
 * gateway URL the desktop/web hosts already use (`wss://host/live` →
 * `https://host/internal/sessions/:id/engine`). Plain `ws://` maps to `http://`
 * for local gateways. Credentials, query strings, and fragments are refused.
 */
export function getGatewayEngineEndpoint(gatewayUrl: string, sessionId: string): string {
  if (!UUID_PATTERN.test(sessionId)) throw new Error("INVALID_SESSION_ID");
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    throw new Error("INVALID_LIVE_GATEWAY_URL");
  }
  if (!["wss:", "ws:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("INVALID_LIVE_GATEWAY_URL");
  }
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = `/internal/sessions/${sessionId}/engine`;
  return parsed.toString();
}

function readResult(value: unknown): EnginePushResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.result !== "string" || !RESULT_VALUES.has(body.result)) return null;
  if (body.code !== undefined && (typeof body.code !== "string" || !CODE_PATTERN.test(body.code))) return null;
  return body.code === undefined
    ? { result: body.result as EnginePushResult["result"] }
    : { result: body.result as EnginePushResult["result"], code: body.code };
}

/**
 * Pushes the admin-deployed engine to one running (or cold) gateway session.
 * Resolves to `{ result, code? }` for every outcome, including transport
 * failures; it never throws and never logs the token.
 */
export async function pushEngineToGateway({
  gatewayUrl,
  sessionId,
  engine,
  token,
  fetchFn = fetch,
  timeoutMs = ENGINE_PUSH_TIMEOUT_MS,
}: {
  gatewayUrl: string;
  sessionId: string;
  engine: EngineSelection;
  token: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<EnginePushResult> {
  let endpoint: string;
  try {
    endpoint = getGatewayEngineEndpoint(gatewayUrl, sessionId);
  } catch (error) {
    return { result: "failed", code: error instanceof Error && CODE_PATTERN.test(error.message) ? error.message : "INVALID_LIVE_GATEWAY_URL" };
  }
  if (typeof token !== "string" || token.length === 0) return { result: "failed", code: "ADMIN_TOKEN_MISSING" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("GATEWAY_TIMEOUT")), timeoutMs);
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ engine }),
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    const outcome = readResult(parsed);
    if (outcome) return outcome;
    return { result: "failed", code: response.ok ? "INVALID_GATEWAY_RESPONSE" : `GATEWAY_HTTP_${response.status}` };
  } catch {
    return { result: "failed", code: controller.signal.aborted ? "GATEWAY_TIMEOUT" : "GATEWAY_UNREACHABLE" };
  } finally {
    clearTimeout(timeout);
  }
}
