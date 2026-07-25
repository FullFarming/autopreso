import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLiveDeploymentReadiness,
  formatLiveDeploymentReadiness,
} from "../scripts/live-deployment-readiness.mjs";

function readyEnvironment() {
  return {
    LIVE_EXTERNAL_ENV: "development",
    GOOGLE_CLOUD_PROJECT: "noel-dev",
    LIVE_ALLOWED_GCP_PROJECT: "noel-dev",
    SUPABASE_URL: "https://dev-ref.supabase.co",
    LIVE_ALLOWED_SUPABASE_REF: "dev-ref",
    SUPABASE_SECRET_KEY: "sb_secret_server-never-print",
  };
}

test("offline readiness fails closed until both explicit read-only probes run", async () => {
  const report = await evaluateLiveDeploymentReadiness({
    environment: readyEnvironment(),
    nodeVersion: "24.1.0",
  });
  assert.equal(report.isReady, false);
  assert.deepEqual(
    report.results.filter((entry) => entry.status === "FAIL").map((entry) => entry.name).sort(),
    ["adc", "cleanup-schedule"],
  );
});

test("readiness fails closed on project mismatch and unsafe URL", async () => {
  const report = await evaluateLiveDeploymentReadiness({
    environment: {
      ...readyEnvironment(),
      GOOGLE_CLOUD_PROJECT: "production-project",
      SUPABASE_URL: "https://dev-ref.supabase.co.evil.example",
    },
    nodeVersion: "23.9.0",
  });
  assert.equal(report.isReady, false);
  assert.deepEqual(
    report.results.filter((entry) => entry.status === "FAIL").map((entry) => entry.name).sort(),
    ["adc", "cleanup-schedule", "gcp-project", "node", "supabase-project"],
  );
});

test("explicit ADC and cleanup probes are read-only and never print credentials", async () => {
  const standardOutput = Buffer.from("temporary-access-token\n");
  const standardError = Buffer.from("provider detail must remain private");
  /** @type {{ url: string, init: RequestInit } | undefined} */
  let cleanupRequest;
  const report = await evaluateLiveDeploymentReadiness({
    environment: {
      ...readyEnvironment(),
      SUPABASE_SERVICE_ROLE_KEY: "legacy-must-not-be-used",
    },
    arguments: ["--probe-adc", "--probe-cleanup-schedule"],
    nodeVersion: "24.0.0",
    spawnSyncFn(command, args, options) {
      assert.equal(command, "gcloud");
      assert.deepEqual(args, ["auth", "application-default", "print-access-token", "--quiet"]);
      assert.equal(options.shell, false);
      return {
        pid: 123,
        output: [null, standardOutput, standardError],
        stdout: standardOutput,
        stderr: standardError,
        status: 0,
        signal: null,
      };
    },
    async fetchFn(url, init) {
      cleanupRequest = { url, init };
      return new Response("true", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(report.isReady, true);
  assert.ok(cleanupRequest);
  assert.equal(cleanupRequest.url, "https://dev-ref.supabase.co/rest/v1/rpc/verify_live_cleanup_schedule");
  assert.equal(cleanupRequest.init.method, "POST");
  const cleanupHeaders = new Headers(cleanupRequest.init.headers);
  assert.equal(cleanupHeaders.get("apikey"), "sb_secret_server-never-print");
  assert.equal(cleanupHeaders.has("authorization"), false);
  assert.equal(standardOutput.every((byte) => byte === 0), true);
  assert.equal(standardError.every((byte) => byte === 0), true);
  const output = formatLiveDeploymentReadiness(report);
  assert.equal(output.includes("temporary-access-token"), false);
  assert.equal(output.includes("sb_secret_server-never-print"), false);
  assert.equal(output.includes("legacy-must-not-be-used"), false);
  assert.equal(output.includes("provider detail"), false);
});

test("requested probes fail closed without credentials or verified cleanup state", async () => {
  const environment = readyEnvironment();
  delete environment.SUPABASE_SECRET_KEY;
  const report = await evaluateLiveDeploymentReadiness({
    environment,
    arguments: ["--probe-adc", "--probe-cleanup-schedule"],
    nodeVersion: "24.0.0",
    spawnSyncFn() {
      const stdout = Buffer.alloc(0);
      const stderr = Buffer.from("secret error");
      return {
        pid: 124,
        output: [null, stdout, stderr],
        stdout,
        stderr,
        status: 1,
        signal: null,
      };
    },
  });
  assert.equal(report.isReady, false);
  assert.deepEqual(
    report.results.filter((entry) => entry.status === "FAIL").map((entry) => entry.name).sort(),
    ["adc", "cleanup-schedule"],
  );
});

test("readiness temporarily accepts a legacy service-role key with Bearer authorization", async () => {
  const environment = readyEnvironment();
  delete environment.SUPABASE_SECRET_KEY;
  environment.SUPABASE_SERVICE_ROLE_KEY = "legacy-server-secret-never-print";
  /** @type {Headers | undefined} */
  let requestHeaders;
  const report = await evaluateLiveDeploymentReadiness({
    environment,
    arguments: ["--probe-adc", "--probe-cleanup-schedule"],
    nodeVersion: "24.0.0",
    spawnSyncFn() {
      return { pid: 1, output: [null, Buffer.from("token"), Buffer.alloc(0)], stdout: Buffer.from("token"), stderr: Buffer.alloc(0), status: 0, signal: null };
    },
    async fetchFn(_url, init) {
      requestHeaders = new Headers(init.headers);
      return Response.json(true);
    },
  });
  assert.equal(report.isReady, true);
  assert.ok(requestHeaders instanceof Headers);
  assert.equal(requestHeaders.get("apikey"), "legacy-server-secret-never-print");
  assert.equal(requestHeaders.get("authorization"), "Bearer legacy-server-secret-never-print");
  assert.equal(formatLiveDeploymentReadiness(report).includes("legacy-server-secret-never-print"), false);
});
