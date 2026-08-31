import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCloudRunScaleZeroContract,
  formatCloudRunScaleZeroReport,
  parseCloudRunTarget,
} from "../scripts/verify-cloud-run-scale-zero.mjs";

function compliantService() {
  return {
    metadata: {
      annotations: {
        "run.googleapis.com/minScale": "0",
        "run.googleapis.com/maxScale": "1",
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            "autoscaling.knative.dev/minScale": "0",
            "autoscaling.knative.dev/maxScale": "1",
            "run.googleapis.com/cpu-throttling": "true",
            "run.googleapis.com/startup-cpu-boost": "true",
          },
        },
        spec: {
          containerConcurrency: 256,
          timeoutSeconds: 3_600,
          containers: [{ resources: { limits: { cpu: "1", memory: "1Gi" } } }],
        },
      },
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      traffic: [{ revisionName: "gateway-00001-abc", percent: 100 }],
    },
  };
}

function revision(name, overrides = {}) {
  return {
    metadata: {
      name,
      annotations: {
        "autoscaling.knative.dev/minScale": "0",
        "autoscaling.knative.dev/maxScale": "1",
        "run.googleapis.com/cpu-throttling": "true",
        "run.googleapis.com/startup-cpu-boost": "true",
        ...overrides.annotations,
      },
    },
    spec: {
      containerConcurrency: overrides.containerConcurrency ?? 256,
      timeoutSeconds: overrides.timeoutSeconds ?? 3_600,
      containers: [{
        resources: {
          limits: overrides.limits ?? { cpu: "1", memory: "1Gi" },
        },
      }],
    },
  };
}

test("compliant request-billed service passes the scale-to-zero contract", () => {
  const report = evaluateCloudRunScaleZeroContract({
    service: compliantService(),
    revisions: [revision("gateway-00001-abc")],
  });
  assert.equal(report.isReady, true);
  assert.equal(report.results.every((entry) => entry.status === "PASS"), true);
  assert.match(formatCloudRunScaleZeroReport(report), /PASS Cloud Run scale-to-zero contract/u);
});

test("default zero-minimum and request billing annotations may be omitted", () => {
  const service = compliantService();
  delete service.metadata.annotations["run.googleapis.com/minScale"];
  delete service.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"];
  delete service.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"];
  service.spec.template.spec.containers[0].resources.limits.cpu = "1000m";
  const currentRevision = revision("gateway-00001-abc");
  delete currentRevision.metadata.annotations["autoscaling.knative.dev/minScale"];
  delete currentRevision.metadata.annotations["run.googleapis.com/cpu-throttling"];
  currentRevision.spec.containers[0].resources.limits.cpu = "1000m";
  const report = evaluateCloudRunScaleZeroContract({ service, revisions: [currentRevision] });
  assert.equal(report.isReady, true);
});

test("service-level drift and tagged min-one revisions fail closed", () => {
  const service = compliantService();
  service.metadata.annotations["run.googleapis.com/minScale"] = "1";
  service.metadata.annotations["run.googleapis.com/maxScale"] = "20";
  service.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"] = "1";
  service.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"] = "20";
  service.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"] = "false";
  service.spec.template.metadata.annotations["run.googleapis.com/startup-cpu-boost"] = "false";
  service.spec.template.spec.containerConcurrency = 80;
  service.spec.template.spec.timeoutSeconds = 300;
  service.spec.template.spec.containers[0].resources.limits = { cpu: "2", memory: "2Gi" };
  service.status.conditions = [{ type: "Ready", status: "False" }];
  service.status.traffic.push({ revisionName: "gateway-legacy", tag: "legacy", percent: 0 });

  const report = evaluateCloudRunScaleZeroContract({
    service,
    revisions: [
      revision("gateway-00001-abc"),
      revision("gateway-legacy", { annotations: { "autoscaling.knative.dev/minScale": "1" } }),
    ],
  });
  assert.equal(report.isReady, false);
  assert.deepEqual(
    report.results.filter((entry) => entry.status === "FAIL").map((entry) => entry.name).sort(),
    ["concurrency", "request-billing", "resources", "revision-max", "revision-min", "service-max", "service-min", "service-ready", "startup-boost", "timeout", "traffic-revisions"],
  );
  assert.equal(formatCloudRunScaleZeroReport(report).includes("gateway-legacy"), false);
});

test("every traffic-addressable revision must preserve the full single-instance runtime contract", () => {
  const service = compliantService();
  service.status.traffic.push({ revisionName: "gateway-tagged", tag: "rollback", percent: 0 });
  const driftCases = [
    { annotations: { "autoscaling.knative.dev/maxScale": "2" } },
    { annotations: { "run.googleapis.com/cpu-throttling": "false" } },
    { annotations: { "run.googleapis.com/startup-cpu-boost": "false" } },
    { containerConcurrency: 80 },
    { timeoutSeconds: 300 },
    { limits: { cpu: "2", memory: "2Gi" } },
  ];

  for (const drift of driftCases) {
    const report = evaluateCloudRunScaleZeroContract({
      service,
      revisions: [revision("gateway-00001-abc"), revision("gateway-tagged", drift)],
    });
    const trafficResult = report.results.find((entry) => entry.name === "traffic-revisions");
    assert.equal(trafficResult?.status, "FAIL", JSON.stringify(drift));
    assert.equal(report.isReady, false);
  }
});

test("unresolved or empty traffic targets cannot be approved", () => {
  const service = compliantService();
  let report = evaluateCloudRunScaleZeroContract({ service, revisions: [] });
  assert.equal(report.results.find((entry) => entry.name === "traffic-revisions")?.status, "FAIL");
  service.status.traffic = [];
  report = evaluateCloudRunScaleZeroContract({ service, revisions: [] });
  assert.equal(report.results.find((entry) => entry.name === "traffic-revisions")?.status, "FAIL");
});

test("verification requires explicit and syntactically bounded target identity", () => {
  assert.deepEqual(parseCloudRunTarget([
    "--project", "gen-lang-client-0321430669",
    "--region=asia-northeast3",
    "--service", "realtime-noel-media-gateway",
  ]), {
    project: "gen-lang-client-0321430669",
    region: "asia-northeast3",
    service: "realtime-noel-media-gateway",
  });
  assert.throws(() => parseCloudRunTarget(["--project", "unsafe/project", "--region", "asia-northeast3", "--service", "gateway"]));
  assert.throws(() => parseCloudRunTarget(["--project", "valid-project", "--region", "$(evil)", "--service", "gateway"]));
  assert.throws(() => parseCloudRunTarget(["--project", "valid-project", "--region", "asia-northeast3", "--service", "gateway;evil"]));
});
