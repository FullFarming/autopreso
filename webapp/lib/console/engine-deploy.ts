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

type PushEngine = typeof pushEngineToGateway;
type MintToken = (input: { hostId: string; sessionId: string }) => Promise<{ token: string }>;
type DeployStore = Pick<SupabaseConsoleStore, "listActiveSessionsForHost" | "setSessionEngineAsAdmin">;

/**
 * The gateway the push targets: the server-only `LIVE_GATEWAY_URL` first, then the
 * public one the viewer bundle already carries. `null` when neither is set - the DB
 * write still happens and every push is reported `failed` / `LIVE_GATEWAY_URL_MISSING`.
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

/**
 * D1 (2026-09-05): after `set_profile_voice_provider_v2` succeeded, rewrite every
 * `preparing`/`live` session **of that user** through the admin RPC (pinning the profile's
 * `assignmentRevision` on the record) and tell the gateway to swap pipelines. Per session,
 * in order: the catalog language guard (1-3 distinct caption languages - refused before
 * any write), the DB write (authoritative; `null` = the session stopped meanwhile), then
 * the push with a fresh session-bound ADMIN token. Nothing here throws for one session:
 * a dead session, a throwing RPC, or a downed gateway all become a `failed` row and the
 * loop continues, so the DB write completes for the other sessions regardless. The token
 * is minted per push and never returned or stored.
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
  concurrency?: number;
}): Promise<EngineDeployOutcome> {
  const sessions = await store.listActiveSessionsForHost(hostId);
  const results = await mapWithConcurrency(sessions, Math.max(1, concurrency), async (session: ActiveSessionRow): Promise<EngineDeploySessionResult> => {
    const sessionId = session.id;
    try {
      validateEngineForLanguages(engine, session.languages);
    } catch (error: unknown) {
      if (error instanceof EngineSelectionError) return { sessionId, result: "failed", code: "ENGINE_LANGUAGE_COUNT_INVALID" };
      throw error;
    }
    try {
      const written = await store.setSessionEngineAsAdmin({ actorId, sessionId, engine, assignmentRevision });
      if (!written) return { sessionId, result: "failed", code: "SESSION_NOT_ACTIVE" };
    } catch (error: unknown) {
      return { sessionId, result: "failed", code: error instanceof ConsoleStoreError ? error.code : "SESSION_SWITCH_FAILED" };
    }
    if (!gatewayUrl) return { sessionId, result: "failed", code: "LIVE_GATEWAY_URL_MISSING" };
    let token: string;
    try {
      ({ token } = await mintToken({ hostId: actorHostId, sessionId }));
    } catch {
      return { sessionId, result: "failed", code: "ADMIN_TOKEN_UNAVAILABLE" };
    }
    const pushed = await pushEngine({ gatewayUrl, sessionId, engine, token });
    return pushed.code === undefined ? { sessionId, result: pushed.result } : { sessionId, result: pushed.result, code: pushed.code };
  });
  return { results, summary: summarize(results) };
}
