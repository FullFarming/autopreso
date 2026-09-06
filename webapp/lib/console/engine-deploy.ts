import { EngineSelectionError, validateEngineForLanguages } from "../../../packages/caption-core/caption-engine-catalog.js";
import { createAdminGatewayToken } from "../auth/live-auth";
import { type EnginePushResult, pushEngineToGateway } from "../live/gateway-engine-push";
import { type ActiveSessionRow, ConsoleStoreError, type EngineDeploySummary, type SupabaseConsoleStore } from "./console-store";
import type { EngineSelection } from "./engine-defaults";

/** One row of the console's per-session results (spec §9), now shown under the user row. */
export interface EngineDeploySessionResult { sessionId: string; result: EnginePushResult["result"]; code?: string }
export interface EngineDeployOutcome { results: EngineDeploySessionResult[]; summary: EngineDeploySummary }

/** At most this many sessions are switched at once; each push has its own 8 s timeout. */
export const ENGINE_DEPLOY_CONCURRENCY = 4;
/**
 * The gateway refuses a second switch of the same session within its 2 s cooldown
 * (`ENGINE_SWITCH_RATE_LIMITED`, HTTP 429). One retry after the cooldown plus margin covers the
 * operator who re-assigns quickly or the deploy that follows another admin's.
 */
export const ENGINE_SWITCH_RETRY_DELAY_MS = 2_200;
export const ENGINE_SWITCH_RATE_LIMITED_CODE = "ENGINE_SWITCH_RATE_LIMITED";

/**
 * Codes that mean "the gateway did not evaluate the request", not "the gateway refused it":
 * no URL to push to, no token to sign, the socket never connected, timed out, the gateway
 * answered 5xx / is shutting down. The DB write already happened, so these rows are `queued`.
 */
const TRANSPORT_FAILURE_CODES = new Set(["GATEWAY_UNREACHABLE", "GATEWAY_TIMEOUT", "LIVE_GATEWAY_URL_MISSING", "ADMIN_TOKEN_UNAVAILABLE", "GATEWAY_SHUTTING_DOWN"]);
const GATEWAY_5XX = /^GATEWAY_HTTP_5\d\d$/u;

/** `queued` for a transport-class failure (convergence is guaranteed, see the module doc); `failed` otherwise. */
export function classifyPushFailure(code: string): EnginePushResult["result"] {
  return TRANSPORT_FAILURE_CODES.has(code) || GATEWAY_5XX.test(code) ? "queued" : "failed";
}

type PushEngine = typeof pushEngineToGateway;
type MintToken = (input: { hostId: string; sessionId: string }) => Promise<{ token: string }>;
type Sleep = (ms: number) => Promise<void>;
type DeployStore = Pick<SupabaseConsoleStore, "listActiveSessionsForHost" | "setSessionEngineAsAdmin">;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The gateway the push targets: the server-only `LIVE_GATEWAY_URL` first, then the
 * public one the viewer bundle already carries. `null` when neither is set - the DB
 * write still happens and every push is reported `queued` / `LIVE_GATEWAY_URL_MISSING`.
 */
export function readDeployGatewayUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.LIVE_GATEWAY_URL ?? env.NEXT_PUBLIC_LIVE_GATEWAY_URL;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function summarize(results: readonly EngineDeploySessionResult[]): EngineDeploySummary {
  const summary: EngineDeploySummary = { switched: 0, queued: 0, failed: 0 };
  for (const row of results) summary[row.result] += 1;
  return summary;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function withCode(sessionId: string, result: EnginePushResult["result"], code?: string): EngineDeploySessionResult {
  return code === undefined ? { sessionId, result } : { sessionId, result, code };
}

/**
 * D1 (2026-09-05): after `set_profile_voice_provider_v3` reported a change, rewrite every
 * `preparing`/`live` session **of that user** through the admin RPC (pinning the profile's
 * `assignmentRevision` on the record, inside the byte budget) and tell the gateway to swap
 * pipelines. Per session, in order: the catalog language guard (1-3 distinct caption languages -
 * refused before any write), the DB write (authoritative; `null` = the session stopped meanwhile),
 * then the push with a fresh session-bound ADMIN token. Nothing here throws for one session: a
 * dead session, a throwing RPC, or a downed gateway all become a row and the loop continues, so
 * the DB write completes for the other sessions regardless. The token is minted per push and
 * never returned or stored.
 *
 * ### Result classes and the convergence path (I2)
 *
 * The database is the authority; the gateway push is an accelerator. Once the session record
 * carries the new engine, a gateway that never applied it still converges without operator
 * action: the gateway's periodic host lease (`authorizeHost`, engine parity against the DB
 * record) finds the running engine no longer matches and closes the host socket with
 * `SESSION_REVOKED`; the host client (desktop `refreshLiveCallEngineFromSession`, web
 * `refreshSettings`) reconnects, re-reads `modelPreferences` from the session record and
 * re-pins the engine in its `start`, and the gateway opens the pipeline with the new engine. So:
 *
 * - `switched` - the gateway swapped the running pipeline (contract C1 kept).
 * - `queued`   - the DB is written and convergence is guaranteed, only not immediate: the gateway
 *   holds no warm pipeline for the session (its own `queued`), the push never reached a verdict
 *   (`GATEWAY_UNREACHABLE`, `GATEWAY_TIMEOUT`, `GATEWAY_HTTP_5xx`, `GATEWAY_SHUTTING_DOWN`,
 *   `LIVE_GATEWAY_URL_MISSING`, `ADMIN_TOKEN_UNAVAILABLE`), or the cooldown refused it twice
 *   (`ENGINE_SWITCH_RATE_LIMITED` after one retry). The console shows "호스트 재접속 시 적용됩니다".
 * - `failed`   - nothing was written for that session, or the gateway evaluated and refused:
 *   the language guard, a stopped session, a throwing RPC, a 4xx verdict (`MEDIA_DRAINING`,
 *   `ENGINE_SELECTION_INVALID`, ...). These need the operator to look.
 *
 * `ENGINE_SWITCH_RATE_LIMITED` (429) is retried exactly once after `ENGINE_SWITCH_RETRY_DELAY_MS`
 * with a fresh token; `sleep` is injectable so tests never wait.
 */
export async function deployEngineToHostSessions({
  store,
  actorId,
  actorHostId,
  hostId,
  engine,
  assignmentRevision,
  gatewayUrl,
  pushEngine = pushEngineToGateway,
  mintToken = createAdminGatewayToken,
  sleep = defaultSleep,
  concurrency = ENGINE_DEPLOY_CONCURRENCY,
}: {
  store: DeployStore;
  actorId: string;
  actorHostId: string;
  hostId: string;
  engine: EngineSelection;
  assignmentRevision: string;
  gatewayUrl: string | null;
  pushEngine?: PushEngine;
  mintToken?: MintToken;
  sleep?: Sleep;
  concurrency?: number;
}): Promise<EngineDeployOutcome> {
  const sessions = await store.listActiveSessionsForHost(hostId);
  const pushOnce = async (sessionId: string): Promise<EngineDeploySessionResult> => {
    if (!gatewayUrl) return withCode(sessionId, "queued", "LIVE_GATEWAY_URL_MISSING");
    let token: string;
    try {
      ({ token } = await mintToken({ hostId: actorHostId, sessionId }));
    } catch {
      return withCode(sessionId, "queued", "ADMIN_TOKEN_UNAVAILABLE");
    }
    const pushed = await pushEngine({ gatewayUrl, sessionId, engine, token });
    if (pushed.result !== "failed" || pushed.code === undefined) return withCode(sessionId, pushed.result, pushed.code);
    return withCode(sessionId, classifyPushFailure(pushed.code), pushed.code);
  };
  const results = await mapWithConcurrency(sessions, Math.max(1, concurrency), async (session: ActiveSessionRow): Promise<EngineDeploySessionResult> => {
    const sessionId = session.id;
    try {
      validateEngineForLanguages(engine, session.languages);
    } catch (error: unknown) {
      if (error instanceof EngineSelectionError) return withCode(sessionId, "failed", "ENGINE_LANGUAGE_COUNT_INVALID");
      throw error;
    }
    try {
      const written = await store.setSessionEngineAsAdmin({ actorId, sessionId, engine, assignmentRevision });
      if (!written) return withCode(sessionId, "failed", "SESSION_NOT_ACTIVE");
    } catch (error: unknown) {
      return withCode(sessionId, "failed", error instanceof ConsoleStoreError ? error.code : "SESSION_SWITCH_FAILED");
    }
    const first = await pushOnce(sessionId);
    if (first.code !== ENGINE_SWITCH_RATE_LIMITED_CODE) return first;
    await sleep(ENGINE_SWITCH_RETRY_DELAY_MS);
    const second = await pushOnce(sessionId);
    if (second.code !== ENGINE_SWITCH_RATE_LIMITED_CODE) return second;
    // Still inside someone's cooldown: the record is written, the host converges on its next lease.
    return withCode(sessionId, "queued", ENGINE_SWITCH_RATE_LIMITED_CODE);
  });
  return { results, summary: summarize(results) };
}
