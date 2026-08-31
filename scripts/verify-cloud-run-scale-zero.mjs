#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONTRACT = Object.freeze({
  serviceMin: 0,
  serviceMax: 1,
  revisionMin: 0,
  revisionMax: 1,
  concurrency: 256,
  timeoutSeconds: 3_600,
  cpu: "1",
  memory: "1Gi",
});

function result(name, status, message) {
  return { name, status, message };
}

function annotation(value, name) {
  return value?.metadata?.annotations?.[name];
}

function integerEquals(value, expected) {
  return Number(value) === expected && Number.isFinite(Number(value));
}

function isZeroOrUnset(value) {
  return value === undefined || value === null || value === "" || integerEquals(value, 0);
}

function normalizeCpu(value) {
  if (value === "1000m") return "1";
  return String(value ?? "");
}

function revisionMinimum(revision) {
  return annotation(revision, "autoscaling.knative.dev/minScale");
}

function revisionContractViolations(revision) {
  const annotations = revision?.metadata?.annotations ?? {};
  const spec = revision?.spec ?? {};
  const container = Array.isArray(spec.containers) ? spec.containers[0] : undefined;
  const limits = container?.resources?.limits ?? {};
  const violations = [];
  if (!isZeroOrUnset(revisionMinimum(revision))) violations.push("minimum");
  if (!integerEquals(annotations["autoscaling.knative.dev/maxScale"], CONTRACT.revisionMax)) violations.push("maximum");
  if (annotations["run.googleapis.com/cpu-throttling"] !== undefined
    && annotations["run.googleapis.com/cpu-throttling"] !== "true") violations.push("billing");
  if (annotations["run.googleapis.com/startup-cpu-boost"] !== "true") violations.push("startup-boost");
  if (!integerEquals(spec.containerConcurrency, CONTRACT.concurrency)) violations.push("concurrency");
  if (!integerEquals(spec.timeoutSeconds, CONTRACT.timeoutSeconds)) violations.push("timeout");
  if (normalizeCpu(limits.cpu) !== CONTRACT.cpu || limits.memory !== CONTRACT.memory) violations.push("resources");
  return violations;
}

function addressableTraffic(service) {
  return Array.isArray(service?.status?.traffic)
    ? service.status.traffic.filter((entry) => Number(entry?.percent ?? 0) > 0 || typeof entry?.tag === "string")
    : [];
}

export function evaluateCloudRunScaleZeroContract({ service, revisions }) {
  const results = [];
  const serviceAnnotations = service?.metadata?.annotations ?? {};
  const template = service?.spec?.template ?? {};
  const templateAnnotations = template?.metadata?.annotations ?? {};
  const templateSpec = template?.spec ?? {};
  const container = Array.isArray(templateSpec.containers) ? templateSpec.containers[0] : undefined;
  const limits = container?.resources?.limits ?? {};

  const serviceMin = serviceAnnotations["run.googleapis.com/minScale"];
  results.push(isZeroOrUnset(serviceMin)
    ? result("service-min", "PASS", "service-level minimum permits zero instances")
    : result("service-min", "FAIL", "service-level minimum must be zero or unset"));

  const serviceMax = serviceAnnotations["run.googleapis.com/maxScale"];
  results.push(integerEquals(serviceMax, CONTRACT.serviceMax)
    ? result("service-max", "PASS", "service-level maximum is one instance")
    : result("service-max", "FAIL", "service-level maximum must be explicitly set to one"));

  const revisionMin = templateAnnotations["autoscaling.knative.dev/minScale"];
  results.push(isZeroOrUnset(revisionMin)
    ? result("revision-min", "PASS", "new revisions permit zero instances")
    : result("revision-min", "FAIL", "revision-level minimum must be zero or unset"));

  const revisionMax = templateAnnotations["autoscaling.knative.dev/maxScale"];
  results.push(integerEquals(revisionMax, CONTRACT.revisionMax)
    ? result("revision-max", "PASS", "new revisions are capped at one instance")
    : result("revision-max", "FAIL", "revision-level maximum must be explicitly set to one"));

  const cpuThrottling = templateAnnotations["run.googleapis.com/cpu-throttling"];
  results.push(cpuThrottling === undefined || cpuThrottling === "true"
    ? result("request-billing", "PASS", "request-based CPU billing is enabled")
    : result("request-billing", "FAIL", "instance-based CPU billing is not allowed"));

  results.push(templateAnnotations["run.googleapis.com/startup-cpu-boost"] === "true"
    ? result("startup-boost", "PASS", "startup CPU boost is enabled")
    : result("startup-boost", "FAIL", "startup CPU boost must be enabled"));

  results.push(integerEquals(templateSpec.containerConcurrency, CONTRACT.concurrency)
    ? result("concurrency", "PASS", "container concurrency is 256")
    : result("concurrency", "FAIL", "container concurrency must be 256"));

  results.push(integerEquals(templateSpec.timeoutSeconds, CONTRACT.timeoutSeconds)
    ? result("timeout", "PASS", "request timeout is 3600 seconds")
    : result("timeout", "FAIL", "request timeout must be 3600 seconds"));

  const resourcesMatch = normalizeCpu(limits.cpu) === CONTRACT.cpu && limits.memory === CONTRACT.memory;
  results.push(resourcesMatch
    ? result("resources", "PASS", "container resources are 1 CPU and 1 GiB")
    : result("resources", "FAIL", "container resources must be 1 CPU and 1 GiB"));

  const ready = Array.isArray(service?.status?.conditions)
    && service.status.conditions.some((condition) => condition?.type === "Ready" && condition?.status === "True");
  results.push(ready
    ? result("service-ready", "PASS", "service reports Ready=True")
    : result("service-ready", "FAIL", "service must report Ready=True"));

  const revisionList = Array.isArray(revisions) ? revisions : [];
  const revisionsByName = new Map(revisionList.map((revision) => [revision?.metadata?.name, revision]));
  const traffic = addressableTraffic(service);
  const unsafeTargets = [];
  for (const entry of traffic) {
    const revisionName = entry?.revisionName;
    const revision = revisionsByName.get(revisionName);
    if (typeof revisionName !== "string" || !revision) {
      unsafeTargets.push("unresolved-target");
      continue;
    }
    if (revisionContractViolations(revision).length > 0) unsafeTargets.push(revisionName);
  }
  results.push(traffic.length > 0 && unsafeTargets.length === 0
    ? result("traffic-revisions", "PASS", "all traffic-addressable revisions preserve the single-instance runtime contract")
    : result("traffic-revisions", "FAIL", traffic.length === 0
      ? "no resolved traffic target was found"
      : `${unsafeTargets.length} traffic-addressable revision target(s) violate or hide the runtime contract`));

  return {
    contract: CONTRACT,
    isReady: results.every((entry) => entry.status === "PASS"),
    results,
  };
}

export function formatCloudRunScaleZeroReport(report) {
  const lines = report.results.map((entry) => `${entry.status} ${entry.name}: ${entry.message}`);
  lines.push(report.isReady ? "PASS Cloud Run scale-to-zero contract" : "FAIL Cloud Run scale-to-zero contract");
  return lines.join("\n");
}

function readNamedArgument(argumentsList, name) {
  const equalsPrefix = `${name}=`;
  const equalsValue = argumentsList.find((value) => value.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : undefined;
}

export function parseCloudRunTarget(argumentsList) {
  const project = readNamedArgument(argumentsList, "--project")?.trim() ?? "";
  const region = readNamedArgument(argumentsList, "--region")?.trim() ?? "";
  const service = readNamedArgument(argumentsList, "--service")?.trim() ?? "";
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)) throw new Error("--project must be an explicit Google Cloud project id");
  if (!/^[a-z]+-[a-z]+[0-9]$/u.test(region)) throw new Error("--region must be an explicit Google Cloud region");
  if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(service)) throw new Error("--service must be an explicit Cloud Run service name");
  return { project, region, service };
}

function runGcloudJson(argumentsList) {
  const command = spawnSync("gcloud", argumentsList, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  if (command.status !== 0 || typeof command.stdout !== "string") {
    throw new Error("gcloud read failed; no remote settings were changed");
  }
  try {
    return JSON.parse(command.stdout);
  } catch {
    throw new Error("gcloud returned an unreadable JSON response");
  }
}

async function main() {
  const target = parseCloudRunTarget(process.argv.slice(2));
  const common = ["--project", target.project, "--region", target.region, "--platform", "managed", "--format=json"];
  const service = runGcloudJson(["run", "services", "describe", target.service, ...common]);
  const revisions = runGcloudJson(["run", "revisions", "list", "--service", target.service, ...common]);
  const report = evaluateCloudRunScaleZeroContract({ service, revisions });
  process.stdout.write(`${formatCloudRunScaleZeroReport(report)}\n`);
  if (!report.isReady) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`FAIL Cloud Run scale-to-zero verification: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
