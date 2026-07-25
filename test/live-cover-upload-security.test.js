import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSource = readFileSync(
  new URL("../webapp/app/api/live-sessions/[id]/cover/route.ts", import.meta.url),
  "utf8",
);

test("cover upload never buffers an unbounded request body", () => {
  assert.doesNotMatch(routeSource, /request\.arrayBuffer\(\)/u);
  assert.match(routeSource, /request\.body\.getReader\(\)/u);
  assert.match(routeSource, /receivedLength > MAX_COVER_IMAGE_BYTES/u);
  assert.match(routeSource, /await reader\.cancel\(\)/u);
});

test("cover upload validates integer Content-Length against actual streamed bytes", () => {
  assert.match(routeSource, /Number\.isSafeInteger\(declaredLength\)/u);
  assert.match(routeSource, /receivedLength > declaredLength/u);
  assert.match(routeSource, /receivedLength !== declaredLength/u);
  assert.match(routeSource, /COVER_LENGTH_MISMATCH/u);
});

test("bounded bytes are assembled only after ownership and length checks", () => {
  const ownership = routeSource.indexOf("session.hostId !== hostId");
  const declaredLength = routeSource.indexOf("const declaredLength");
  const boundedRead = routeSource.indexOf("readBoundedCoverBody(request, declaredLength)");
  const upload = routeSource.indexOf("uploadCoverObject(path, bytes");
  assert.ok(ownership >= 0 && ownership < declaredLength);
  assert.ok(declaredLength < boundedRead && boundedRead < upload);
  assert.match(routeSource, /const bytes = new Uint8Array\(receivedLength\)/u);
});
