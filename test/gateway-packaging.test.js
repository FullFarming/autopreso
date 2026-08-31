import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Cloud Run and published packages include canonical caption and Gemini server runtimes", async () => {
  const [dockerfile, dockerIgnore, cloudBuild, packageManifest, gatewayReadme] = await Promise.all([
    read("../media-gateway/Dockerfile"),
    read("../.dockerignore"),
    read("../cloudbuild.media-gateway.yaml"),
    read("../package.json"),
    read("../media-gateway/README.md"),
  ]);
  const manifest = JSON.parse(packageManifest);

  assert.match(dockerfile, /COPY packages\/caption-core \/app\/packages\/caption-core/u);
  assert.match(dockerfile, /COPY packages\/gemini-server \/app\/packages\/gemini-server/u);
  assert.match(cloudBuild, /media-gateway\/Dockerfile/u);
  assert.equal(dockerIgnore.startsWith("**\n"), true);
  assert.match(dockerIgnore, /!packages\/caption-core\/\*\*/u);
  assert.match(dockerIgnore, /!packages\/gemini-server\/\*\*/u);
  assert.equal(manifest.files.includes("packages/caption-core/"), true);
  assert.equal(manifest.files.includes("packages/gemini-server/"), true);
  assert.equal(manifest.build.files.includes("packages/caption-core/**"), true);
  assert.match(gatewayReadme, /request-based billing/u);
  assert.match(gatewayReadme, /revision-level minScale/u);
  assert.match(gatewayReadme, /traffic tag/u);
  assert.match(gatewayReadme, /--cpu-throttling/u);
  assert.match(gatewayReadme, /--min 0/u);
  assert.match(gatewayReadme, /--max 1/u);
  assert.match(gatewayReadme, /--concurrency 256/u);
  assert.match(gatewayReadme, /HOST 1명, VIEWER 최대 200명/u);
  assert.match(gatewayReadme, /--timeout 3600/u);
  assert.match(gatewayReadme, /--cpu-boost/u);
});
