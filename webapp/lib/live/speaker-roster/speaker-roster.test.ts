import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { NextRequest } from "next/server.js";
import { readFileSync } from "node:fs";
import { normalizeSpeakerProfile, buildSpeakerPhotoUrl } from "../../../../packages/caption-core/speaker-profile.js";
import { createSpeakerRosterHandlers } from "./handlers";
import { speakerRosterReplaceSchema, type SpeakerRosterState, type SpeakerRosterReplace } from "./validation";
import { SupabaseSpeakerRosterStore, type SpeakerRosterStore, type SpeakerPhoto } from "./store";
import { normalizeSpeakerPhoto, readSpeakerPhotoBody } from "./photo";
import { LiveSessionError } from "../errors";
import { AuthenticationError, AuthorizationError, createViewerGrantToken, VIEWER_GRANT_COOKIE } from "../../auth/live-auth";
import { SupabaseLiveAdmissionStore } from "../../security/live-admission-store";
import { authorizeSpeakerPhoto } from "./authorization";
import { isViewerSnapshotPath, assertStrictOrigin } from "../../security/csrf";

const sessionId = "12345678-1234-4234-8234-123456789001";
const speakerId = "12345678-1234-4234-8234-123456789002";
const photoId = "12345678-1234-4234-8234-123456789003";
const foreignId = "12345678-1234-4234-8234-123456789004";
const member = { id: speakerId, version: 1, displayName: "김민지", company: "NOVA", department: "개발", photoAssetId: null, participantId: null };

function fixture() {
  let state: SpeakerRosterState = { sessionId, revision: 0, appliedRevision: 0, activeOnsiteSpeakerId: null, speakers: [] };
  let ended = false;
  const photos = new Map<string, SpeakerPhoto>();
  const assertOwner = (session: string, owner: string) => {
    if (session !== sessionId || owner !== "owner") throw new LiveSessionError("없음", "SPEAKER_ROSTER_FORBIDDEN", 404);
  };
  const store: SpeakerRosterStore = {
    async get(session, owner) { assertOwner(session, owner); return structuredClone(state); },
    async replace(session, owner, input) {
      assertOwner(session, owner);
      if (ended) throw new LiveSessionError("종료", "SPEAKER_ROSTER_TERMINAL", 409);
      if (state.revision !== input.expectedRevision) throw new LiveSessionError("충돌", "SPEAKER_ROSTER_CONFLICT", 409);
      if (input.speakers.some(item => item.photoAssetId && !photos.has(item.photoAssetId))) {
        throw new LiveSessionError("사진없음", "SPEAKER_ROSTER_PHOTO", 404);
      }
      state = { ...state, revision: state.revision + 1, activeOnsiteSpeakerId: input.activeOnsiteSpeakerId,
        speakers: input.speakers.map(item => ({ ...item, version: 1 })) };
      return structuredClone(state);
    },
    async createPhoto(session, owner, id, photo) {
      assertOwner(session, owner);
      if (ended) throw new LiveSessionError("종료", "SPEAKER_ROSTER_TERMINAL", 409);
      photos.set(id, photo); return { photoAssetId: id };
    },
    async getPhoto(session, id) {
      const photo = photos.get(id);
      if (session !== sessionId || !photo) throw new LiveSessionError("사진없음", "SPEAKER_ROSTER_PHOTO", 404);
      return photo;
    },
  };
  const handlers = createSpeakerRosterHandlers({ store,
    async requireHost(request: Request) {
      const role = request.headers.get("x-test-role");
      if (role === "owner" || role === "other") return { hostId: role };
      throw new AuthenticationError("로그인 필요");
    },
    async authorizePhoto(request: Request, session) {
      const role = request.headers.get("x-test-role");
      if (session === sessionId && (role === "owner" || role === "viewer")) return;
      throw new AuthorizationError("이 회의의 권한 필요");
    }, async rateLimit() {},
  });
  return { handlers, photos, end: () => { ended = true; } };
}
function request(role = "owner", body?: unknown) {
  return new Request("http://localhost/api", { method: body ? "PUT" : "GET", headers: {
    "x-test-role": role, "content-type": "application/json",
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const replacement = (extra = {}) => ({ expectedRevision: 0, speakers: [member], activeOnsiteSpeakerId: speakerId, ...extra });

test("shared snapshot normalizes Unicode and optional fields and freezes only validated identity", () => {
  const profile = normalizeSpeakerProfile({ id: speakerId.toUpperCase(), version: 2, displayName: "  가  " });
  assert.equal(profile.displayName, "가"); assert.equal(profile.company, ""); assert.ok(Object.isFrozen(profile));
  for (const value of [null, {}, { ...member, version: 0 }, { ...member, displayName: "\n" }, { ...member, photoAssetId: "javascript:bad" }]) {
    assert.throws(() => normalizeSpeakerProfile(value), TypeError);
  }
  assert.equal(buildSpeakerPhotoUrl(sessionId, photoId), `/api/live-sessions/${sessionId}/speakers/photos/${photoId}`);
  assert.throws(() => buildSpeakerPhotoUrl("../escape", photoId), TypeError);
});

test("roster rejects duplicate participant IDs, unknown active ID and excessive members", () => {
  for (const value of [replacement({ activeOnsiteSpeakerId: foreignId }), replacement({ speakers: Array(31).fill(member) }),
    replacement({ expectedRevision: Number.MAX_SAFE_INTEGER }),
    replacement({ speakers: [{ ...member, participantId: photoId }, { ...member, id: foreignId, participantId: photoId }] }),
    replacement({ speakers: [{ ...member, company: "가".repeat(81) }] })]) assert.equal(speakerRosterReplaceSchema.safeParse(value).success, false);
});

test("owner roster is private while unrelated host and viewer cannot read or mutate", async () => {
  const { handlers } = fixture();
  assert.equal((await handlers.get(request(), sessionId)).status, 200);
  assert.equal((await handlers.get(request("other"), sessionId)).status, 404);
  assert.equal((await handlers.put(request("viewer", replacement()), sessionId)).status, 401);
  assert.equal((await handlers.put(request("other", replacement()), sessionId)).status, 404);
});

test("two concurrent edits with identical revision return one success and one conflict", async () => {
  const { handlers } = fixture();
  const responses = await Promise.all([handlers.put(request("owner", replacement()), sessionId), handlers.put(request("owner", replacement()), sessionId)]);
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
});

test("terminal session and foreign immutable photo cannot be attached", async () => {
  const state = fixture();
  assert.equal((await state.handlers.put(request("owner", replacement({ speakers: [{ ...member, photoAssetId: foreignId }] })), sessionId)).status, 404);
  state.end();
  assert.equal((await state.handlers.put(request("owner", replacement()), sessionId)).status, 409);
});

test("photo requires scoped authorization before reading an immutable image", async () => {
  const { handlers, photos } = fixture();
  photos.set(photoId, { contentType: "image/webp", bytesBase64: "UklGRg==" });
  assert.equal((await handlers.getPhoto(request("viewer"), sessionId, photoId)).status, 200);
  assert.equal((await handlers.getPhoto(request("other"), sessionId, photoId)).status, 403);
  assert.equal((await handlers.getPhoto(request("viewer"), foreignId, photoId)).status, 403);
  assert.equal((await handlers.getPhoto(request("owner"), sessionId, foreignId)).status, 404);
  assert.equal((await handlers.getPhoto(request("owner"), sessionId, photoId)).headers.get("cache-control"), "private, no-store");
});

test("image normalizer decodes raster and removes metadata rather than trusting MIME", async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().withMetadata().toBuffer();
  const output = await normalizeSpeakerPhoto(png, "image/png");
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "webp"); assert.equal(metadata.exif, undefined); assert.ok(output.length <= 256 * 1024);
  await assert.rejects(normalizeSpeakerPhoto(png, "image/jpeg"), { code: "SPEAKER_PHOTO_INVALID" });
  await assert.rejects(normalizeSpeakerPhoto(Buffer.from('<svg onload="alert(1)"></svg>'), "image/png"), { code: "SPEAKER_PHOTO_INVALID" });
  await assert.rejects(normalizeSpeakerPhoto(new Uint8Array(2 * 1024 * 1024 + 1), "image/png"), { code: "SPEAKER_PHOTO_TOO_LARGE" });
});

test("streaming photo request cannot hide excess bytes behind absent length", async () => {
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); } });
  await assert.rejects(readSpeakerPhotoBody({ body, headers: new Headers({ "content-type": "image/png" }) }), { code: "SPEAKER_PHOTO_TOO_LARGE" });
});

test("Supabase store uses owner-scoped RPC and never submits client profile version", async () => {
  const bodies: Record<string, unknown>[] = [];
  const store = new SupabaseSpeakerRosterStore({ baseUrl: "https://project.supabase.co", credential: { kind: "secret", key: "test" } }, async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
    return Response.json({ sessionId, revision: 1, appliedRevision: 0, activeOnsiteSpeakerId: speakerId, speakers: [member] });
  });
  const input: SpeakerRosterReplace = speakerRosterReplaceSchema.parse(replacement({ speakers: [{ ...member, version: 999 }] }));
  await store.replace(sessionId, "owner", input);
  assert.equal(bodies[0].p_host_id, "owner");
  assert.equal(Object.hasOwn((bodies[0].p_speakers as object[])[0], "version"), false);
});

test("photo authorization validates a real signed viewer cookie and current database grant", async () => {
  const queries: URL[] = [];
  let revoked = false;
  const store = new SupabaseLiveAdmissionStore({
    getServerAccess: () => ({ url: "https://project.supabase.co", credential: { kind: "secret", key: "test" } }),
    fetchFn: async url => {
      const parsed = new URL(String(url)); queries.push(parsed);
      return Response.json(parsed.pathname.endsWith("/live_sessions")
        ? [{ id: sessionId, host_id: "owner", status: "live" }]
        : revoked ? [] : [{ id: photoId }]);
    },
  });
  const token = await createViewerGrantToken({ sessionId, grantId: photoId, userId: foreignId });
  const viewer = new NextRequest("http://localhost/api", { headers: { cookie: `${VIEWER_GRANT_COOKIE}=${token.token}` } });
  const absentHost = async () => { throw new AuthenticationError("no host"); };
  await authorizeSpeakerPhoto(viewer, sessionId, store, absentHost);
  const query = queries.find(url => url.pathname.endsWith("/viewer_grants"));
  assert.equal(query?.searchParams.get("session_id"), `eq.${sessionId}`);
  assert.equal(query?.searchParams.get("revoked_at"), "is.null");
  assert.equal(query?.searchParams.get("user_id"), `eq.${foreignId}`);
  await assert.rejects(authorizeSpeakerPhoto(viewer, foreignId, store, absentHost), AuthorizationError);
  revoked = true;
  await assert.rejects(authorizeSpeakerPhoto(viewer, sessionId, store, absentHost), { code: "RECAP_FORBIDDEN" });
  const tampered = new NextRequest("http://localhost/api", { headers: { cookie: `${VIEWER_GRANT_COOKIE}=${token.token}bad` } });
  await assert.rejects(authorizeSpeakerPhoto(tampered, sessionId, store, absentHost), AuthenticationError);
});

test("photo route exception admits only scoped GET/HEAD while mutating requests keep strict origin", () => {
  const path = buildSpeakerPhotoUrl(sessionId, photoId);
  assert.equal(isViewerSnapshotPath(path, "GET"), true);
  assert.equal(isViewerSnapshotPath(path, "HEAD"), true);
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal(isViewerSnapshotPath(path, method), false);
  assert.equal(isViewerSnapshotPath(`${path}/extra`, "GET"), false);
  assert.equal(isViewerSnapshotPath(`/api/live-sessions/${sessionId}/speakers`, "GET"), false);
  assert.throws(() => assertStrictOrigin({ headers: new Headers() }));
  assert.throws(() => assertStrictOrigin({ headers: new Headers({ origin: "http://localhost:3318.evil.com" }) }));
  const route = readFileSync("app/api/live-sessions/[id]/speakers/photos/[photoId]/route.ts", "utf8");
  assert.match(route, /speakerRosterHandlers\(\)\.getPhoto\(request, id, photoId\)/u);
  assert.doesNotMatch(route, /create.*Signed|redirect\(/u);
});

test("Supabase absent or foreign photo returns a bounded 404 rather than exposing an asset", async () => {
  const store = new SupabaseSpeakerRosterStore({ baseUrl: "https://project.supabase.co", credential: { kind: "secret", key: "test" } }, async () => Response.json(null));
  await assert.rejects(store.getPhoto(sessionId, foreignId), { code: "SPEAKER_ROSTER_PHOTO", status: 404 });
});

// 2026-09-06 incident: GET /api/live-sessions/[id]/speakers answered 500 on Vercel because
// photo.ts imported `sharp` at module load and the linux-x64 libvips shared object was not in
// the traced function bundle (ERR_DLOPEN_FAILED). The roster read path never touches an image,
// so the native module must load lazily inside normalizeSpeakerPhoto, and the @img binaries
// must be traced into the function that does need them.
test("sharp is loaded lazily by the photo normalizer, never at module load", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./photo.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import\s+sharp\s+from\s+"sharp";?$/mu);
  assert.match(source, /await import\("sharp"\)/u);
  const config = await readFile(new URL("../../../next.config.mjs", import.meta.url), "utf8");
  assert.match(config, /outputFileTracingIncludes[\s\S]*@img/u);
});
