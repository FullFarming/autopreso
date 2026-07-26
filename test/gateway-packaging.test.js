import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Cloud Run and Electron packages include the canonical caption core", async () => {
  const [dockerfile, dockerIgnore, cloudBuild, packageManifest] = await Promise.all([
    read("../media-gateway/Dockerfile"),
    read("../.dockerignore"),
    read("../cloudbuild.media-gateway.yaml"),
    read("../package.json"),
  ]);
  const manifest = JSON.parse(packageManifest);

  assert.match(dockerfile, /COPY packages\/caption-core \/app\/packages\/caption-core/u);
  assert.match(cloudBuild, /media-gateway\/Dockerfile/u);
  assert.equal(dockerIgnore.startsWith("**\n"), true);
  assert.match(dockerIgnore, /!packages\/caption-core\/\*\*/u);
  assert.equal(manifest.files.includes("packages/caption-core/"), true);
  assert.equal(manifest.build.files.includes("packages/caption-core/**"), true);
});
