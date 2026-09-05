const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const failure = (code) => ({ ok: false, code });

export function registerSpeakerRosterIpc({ ipcMain, isAllowedSender, ensureHostSession, workspaceUrl, request, fetch }) {
  function handle(channel, action) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isAllowedSender(event, channel)) return failure("FORBIDDEN");
      try {
        return await action(...args);
      } catch { return failure("NETWORK_UNAVAILABLE"); }
    });
  }
  async function authorize(sessionId) {
    if (typeof sessionId !== "string" || !UUID.test(sessionId)) return failure("INVALID_SESSION_ID");
    return ensureHostSession();
  }
  const route = (id) => `/api/live-sessions/${encodeURIComponent(id)}/speakers`;
  handle("live-call:speakers-get", async (sessionId) => {
    const login = await authorize(sessionId);
    return login.ok ? request(route(sessionId), { method: "GET" }) : login;
  });
  handle("live-call:speakers-save", async (sessionId, body) => {
    const login = await authorize(sessionId);
    if (!login.ok) return login;
    if (!body || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
      || !Array.isArray(body.speakers) || body.speakers.length > 30
      || JSON.stringify(body).length > 64 * 1024) return failure("INVALID_SPEAKER_ROSTER");
    return request(route(sessionId), { method: "PUT", body });
  });
  handle("live-call:speakers-participants", async (sessionId) => {
    const login = await authorize(sessionId);
    if (!login.ok) return login;
    const result = await request(`/api/live-sessions/${encodeURIComponent(sessionId)}/participants`, { method: "GET" });
    if (!result.ok) return result;
    // 2026-09-05 feat: Mapping needs identity and presence only; emails and speech history never cross this IPC.
    const participants = Array.isArray(result.data?.participants) ? result.data.participants : [];
    return { ok: true, data: { participants: participants.filter(value => UUID.test(value?.participantId)).slice(0, 200)
      .map(value => ({ participantId: value.participantId, displayName: String(value.displayName ?? "").slice(0, 100), isPresent: value.isPresent === true })) } };
  });
  handle("live-call:speakers-photo-upload", async (sessionId, photo) => {
    const login = await authorize(sessionId);
    if (!login.ok) return login;
    if (!PHOTO_TYPES.has(photo?.contentType) || !(photo?.bytes instanceof Uint8Array)
      || photo.bytes.byteLength < 1 || photo.bytes.byteLength > MAX_PHOTO_BYTES) return failure("INVALID_SPEAKER_PHOTO");
    const response = await fetch(new URL(`${route(sessionId)}/photos`, workspaceUrl).href, {
      method: "POST", credentials: "include", redirect: "error",
      headers: { "content-type": photo.contentType, origin: new URL(workspaceUrl).origin },
      body: photo.bytes, signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || !UUID.test(payload.data?.photoAssetId)) {
      return failure(typeof payload?.code === "string" ? payload.code : "PHOTO_UPLOAD_FAILED");
    }
    return { ok: true, data: { photoAssetId: payload.data.photoAssetId } };
  });
  handle("live-call:speakers-photo-read", async (input) => {
    const login = await authorize(input?.sessionId);
    if (!login.ok) return login;
    if (typeof input?.photoAssetId !== "string" || !UUID.test(input.photoAssetId)) return failure("INVALID_SPEAKER_PHOTO");
    const response = await fetch(new URL(`${route(input.sessionId)}/photos/${encodeURIComponent(input.photoAssetId)}`, workspaceUrl).href, {
      method: "GET", credentials: "include", redirect: "error", signal: AbortSignal.timeout(15000),
    });
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (!response.ok || !PHOTO_TYPES.has(contentType) || Number(response.headers.get("content-length")) > MAX_PHOTO_BYTES) return failure("PHOTO_READ_FAILED");
    const reader = response.body?.getReader();
    if (!reader) return failure("PHOTO_READ_FAILED");
    const chunks = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_PHOTO_BYTES) { await reader.cancel(); return failure("PHOTO_READ_FAILED"); }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { reader.releaseLock(); }
    return { ok: true, data: { contentType, imageBase64: Buffer.concat(chunks).toString("base64") } };
  });
}
