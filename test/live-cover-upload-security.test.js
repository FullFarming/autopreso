import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const routeSource = read("webapp/app/api/live-sessions/[id]/cover/route.ts");
const storageSource = read("webapp/lib/live/cover-storage.ts");
const migrationSource = read("supabase/migrations/20260727011000_live_cover_20mb.sql");

test("cover prepare is small JSON, owner/status gated, and returns a random session-scoped signed upload", () => {
  assert.doesNotMatch(routeSource, /request\.arrayBuffer\(\)|request\.body\.getReader\(\)/u);
  assert.match(routeSource, /action:\s*z\.literal\("prepare"\)/u);
  assert.match(routeSource, /size:\s*z\.number\(\)\.int\(\)\.positive\(\)\.max\(MAX_COVER_IMAGE_BYTES\)/u);
  assert.match(routeSource, /contentType:\s*z\.enum\(\["image\/jpeg", "image\/png", "image\/webp"\]\)/u);
  const ownership = routeSource.indexOf("session.hostId !== hostId");
  const status = routeSource.indexOf('session.status === "stopped"');
  const signing = routeSource.indexOf("createCoverSignedUploadUrl(");
  const rateLimit = routeSource.indexOf("enforceCoverUploadRateLimit(hostId, sessionId");
  assert.ok(ownership >= 0 && ownership < signing);
  assert.ok(status >= 0 && status < signing);
  assert.ok(ownership < rateLimit && rateLimit < signing);
  assert.match(routeSource, /randomUUID\(\)\.replaceAll\("-", ""\)/u);
  assert.match(routeSource, /pendingCoverImagePath\(sessionId/u);
  assert.match(routeSource, /return apiSuccess\(\{ uploadUrl, storageOrigin, objectPath, uploadTicket \}\)/u);
});

test("cover finalize only accepts same-session pending paths and downloads with a hard cap before marking the session", () => {
  assert.match(routeSource, /action:\s*z\.literal\("finalize"\)/u);
  assert.match(routeSource, /isPendingCoverImagePath\(sessionId, objectPath/u);
  const fetch = routeSource.indexOf("fetchCoverObjectBounded(");
  const structure = routeSource.indexOf("validateCoverImage(bytes)");
  const move = routeSource.indexOf("moveCoverObject(");
  const mark = routeSource.indexOf("setCoverImage(hostId, sessionId, finalPath, expectedCurrentPath)");
  const oldDelete = routeSource.lastIndexOf("deleteCoverObject(coverImagePath(");
  assert.ok(fetch >= 0 && fetch < structure);
  assert.ok(structure < move && move < mark && mark < oldDelete);
  assert.match(routeSource, /actualContentType !== contentType/u);
  assert.match(routeSource, /bytes\.byteLength !== size/u);
  assert.match(routeSource, /hmacHex\(LIVE_ADMISSION_PEPPER, `cover-upload\\0\$\{encoded\}`\)/u);
  assert.match(routeSource, /timingSafeEqual\(signature, expected\)/u);
  assert.match(routeSource, /parsed\.data\.sessionId !== sessionId/u);
  assert.match(routeSource, /parsed\.data\.objectPath !== objectPath/u);
  assert.match(routeSource, /parsed\.data\.expiresAt < Date\.now\(\)/u);
  assert.match(routeSource, /const expectedCurrentPath = session\.coverImageVersion/u);
  assert.match(routeSource, /setCoverImage\(hostId, sessionId, finalPath, expectedCurrentPath\)/u);
  assert.match(routeSource, /if \(finalPath\) await deleteCoverObject\(finalPath\)/u);
});

test("prepare alone consumes the persistent host-session cover rate bucket", () => {
  assert.match(routeSource, /parsed\.data\.action === "prepare"\)[\s\S]*enforceCoverUploadRateLimit/u);
  assert.match(routeSource, /error instanceof LiveAdmissionError/u);
  const limiterSource = read("webapp/lib/security/live-rate-limit.ts");
  assert.match(limiterSource, /scope: "cover-upload-host-session"/u);
  assert.match(limiterSource, /limit: 12/u);
  assert.match(limiterSource, /windowSeconds: 60 \* 60/u);
  assert.match(limiterSource, /"COVER_UPLOAD_RATE_LIMITED",\s*429/u);
});

test("every failed finalize removes pending storage and no function receives upload bytes", () => {
  assert.match(routeSource, /catch \(error: unknown\) \{[\s\S]*await deleteCoverObject\(objectPath\)/u);
  assert.doesNotMatch(storageSource, /uploadCoverObject|body:\s*bytes/u);
  assert.match(storageSource, /response\.body\.getReader\(\)/u);
  assert.match(storageSource, /receivedLength > MAX_COVER_IMAGE_BYTES/u);
  assert.match(storageSource, /await reader\.cancel\(\)/u);
});

test("storage signs upload/download URLs, moves validated objects, and never exposes service credentials", () => {
  assert.match(storageSource, /object\/upload\/sign/u);
  assert.match(storageSource, /object\/sign/u);
  assert.match(storageSource, /object\/move/u);
  assert.match(storageSource, /supabaseAdminHeaders\(credential\)/u);
  assert.match(storageSource, /COVER_SIGNING_FAILED/u);
  assert.match(storageSource, /COVER_STORAGE_RESPONSE_INVALID/u);
  assert.match(storageSource, /storageOrigin: new URL\(baseUrl\)\.origin/u);
  assert.doesNotMatch(routeSource, /credential|service_role|SUPABASE_SECRET_KEY/u);
});

test("private live-covers bucket is raised to exactly 20 MiB with the same image allowlist", () => {
  assert.match(migrationSource, /update storage\.buckets/u);
  assert.match(migrationSource, /file_size_limit\s*=\s*20971520/u);
  assert.match(migrationSource, /public\s*=\s*false/u);
  for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
    assert.match(migrationSource, new RegExp(contentType.replace("/", "\\/"), "u"));
  }
  assert.match(migrationSource, /where id = 'live-covers'/u);
});
