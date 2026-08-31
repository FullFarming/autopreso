import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the reusable post-deploy Cloud Run gate is OIDC-only and read-only", () => {
  const workflow = read(".github/workflows/verify-media-gateway-deployment.yml");
  const readme = read("media-gateway/README.md");

  assert.match(workflow, /workflow_call:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  for (const input of ["project_id", "region", "service", "workload_identity_provider", "service_account"]) {
    assert.match(workflow, new RegExp(`${input}:`, "u"));
  }
  assert.match(workflow, /permissions:\s*\n\s+contents: read\s*\n\s+id-token: write/u);
  assert.match(workflow, /google-github-actions\/auth@v3/u);
  assert.match(workflow, /google-github-actions\/setup-gcloud@v3/u);
  assert.match(workflow, /node \.\/scripts\/verify-cloud-run-scale-zero\.mjs/u);
  assert.doesNotMatch(workflow, /gcloud\s+run\s+(?:deploy|services\s+(?:update|delete))|--apply|GOOGLE_APPLICATION_CREDENTIALS/u);
  assert.match(readme, /\.\/\.github\/workflows\/verify-media-gateway-deployment\.yml/u);
  assert.match(readme, /roles\/run\.viewer/u);
});

test("Dependabot covers every npm lockfile and GitHub Actions weekly", () => {
  const config = read(".github/dependabot.yml");
  assert.match(config, /package-ecosystem: "npm"/u);
  for (const directory of ["/", "/webapp", "/media-gateway"]) {
    assert.match(config, new RegExp(`- "${directory.replaceAll("/", "\\/")}"`, "u"));
  }
  assert.match(config, /package-ecosystem: "github-actions"/u);
  assert.equal((config.match(/interval: "weekly"/gu) ?? []).length, 2);
});
