#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MINIMUM_NODE_MAJOR = 24;

/**
 * @typedef {(command: string, commandArguments: string[], options: import("node:child_process").SpawnSyncOptionsWithBufferEncoding) => import("node:child_process").SpawnSyncReturns<Buffer>} BinarySpawn
 */

function result(name, status, message) {
  return { name, status, message };
}

function parseSupabaseOrigin(value, allowedProjectRef) {
  try {
    const parsed = new URL(value);
    if (!/^[a-z0-9-]+$/u.test(allowedProjectRef)
      || parsed.protocol !== "https:"
      || parsed.hostname !== `${allowedProjectRef}.supabase.co`
      || parsed.username
      || parsed.password
      || parsed.port
      || (parsed.pathname !== "/" && parsed.pathname !== "")
      || parsed.search
      || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function probeCleanupSchedule(environment, supabaseOrigin, fetchFn) {
  const secretKey = environment.SUPABASE_SECRET_KEY?.trim() ?? "";
  const legacyServiceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const apiKey = secretKey || legacyServiceRoleKey;
  if (!apiKey) return result("cleanup-schedule", "FAIL", "cleanup query requires the server-only Supabase credential");
  const headers = {
    apikey: apiKey,
    "content-type": "application/json",
    ...(secretKey ? {} : { authorization: `Bearer ${legacyServiceRoleKey}` }),
  };
  try {
    const response = await fetchFn(`${supabaseOrigin}/rest/v1/rpc/verify_live_cleanup_schedule`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
      headers,
      body: "{}",
    });
    const verified = response.ok && await response.json().catch(() => false) === true;
    return verified
      ? result("cleanup-schedule", "PASS", "active cleanup schedule confirmed by read-only query")
      : result("cleanup-schedule", "FAIL", "active cleanup schedule was not confirmed");
  } catch {
    return result("cleanup-schedule", "FAIL", "cleanup schedule query failed");
  }
}

function probeApplicationDefaultCredentials(spawnSyncFn) {
  const probe = spawnSyncFn("gcloud", ["auth", "application-default", "print-access-token", "--quiet"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  const hasToken = probe.status === 0 && probe.stdout instanceof Uint8Array && probe.stdout.byteLength > 1;
  if (probe.stdout instanceof Uint8Array) probe.stdout.fill(0);
  if (probe.stderr instanceof Uint8Array) probe.stderr.fill(0);
  return hasToken
    ? result("adc", "PASS", "Application Default Credentials probe succeeded")
    : result("adc", "FAIL", "Application Default Credentials probe failed");
}

export async function evaluateLiveDeploymentReadiness({
  environment = process.env,
  arguments: commandArguments = process.argv.slice(2),
  nodeVersion = process.versions.node,
  fetchFn = fetch,
  spawnSyncFn = /** @type {BinarySpawn} */ ((command, commandArguments, options) => spawnSync(command, commandArguments, options)),
} = {}) {
  const results = [];
  const nodeMajor = Number.parseInt(String(nodeVersion).replace(/^v/u, "").split(".")[0], 10);
  results.push(nodeMajor >= MINIMUM_NODE_MAJOR
    ? result("node", "PASS", "Node.js runtime meets the minimum version")
    : result("node", "FAIL", "Node.js 24 or newer is required"));

  const externalEnvironment = environment.LIVE_EXTERNAL_ENV?.trim() ?? "";
  results.push(externalEnvironment === "development"
    ? result("external-environment", "PASS", "external services are restricted to development")
    : result("external-environment", "FAIL", "LIVE_EXTERNAL_ENV must equal development"));

  const projectId = environment.GOOGLE_CLOUD_PROJECT?.trim() ?? "";
  const allowedProjectId = environment.LIVE_ALLOWED_GCP_PROJECT?.trim() ?? "";
  results.push(projectId && projectId === allowedProjectId
    ? result("gcp-project", "PASS", "Google Cloud development project matches its allowlist")
    : result("gcp-project", "FAIL", "Google Cloud project allowlist mismatch"));

  const allowedProjectRef = environment.LIVE_ALLOWED_SUPABASE_REF?.trim() ?? "";
  const supabaseOrigin = parseSupabaseOrigin(environment.SUPABASE_URL?.trim() ?? "", allowedProjectRef);
  results.push(supabaseOrigin
    ? result("supabase-project", "PASS", "Supabase development project matches its allowlist")
    : result("supabase-project", "FAIL", "Supabase project allowlist mismatch"));

  if (commandArguments.includes("--probe-adc")) {
    try {
      results.push(probeApplicationDefaultCredentials(spawnSyncFn));
    } catch {
      results.push(result("adc", "FAIL", "Application Default Credentials probe failed"));
    }
  } else {
    results.push(result("adc", "FAIL", "explicit --probe-adc is required"));
  }

  if (commandArguments.includes("--probe-cleanup-schedule")) {
    results.push(supabaseOrigin
      ? await probeCleanupSchedule(environment, supabaseOrigin, fetchFn)
      : result("cleanup-schedule", "FAIL", "cleanup query requires a valid allowlisted Supabase project"));
  } else {
    results.push(result("cleanup-schedule", "FAIL", "explicit --probe-cleanup-schedule is required"));
  }

  return { isReady: results.every((entry) => entry.status !== "FAIL"), results };
}

export function formatLiveDeploymentReadiness(report) {
  const lines = report.results.map((entry) => `${entry.status} ${entry.name}: ${entry.message}`);
  lines.push(report.isReady ? "PASS live deployment readiness" : "FAIL live deployment readiness");
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await evaluateLiveDeploymentReadiness();
  process.stdout.write(`${formatLiveDeploymentReadiness(report)}\n`);
  if (!report.isReady) process.exitCode = 1;
}
