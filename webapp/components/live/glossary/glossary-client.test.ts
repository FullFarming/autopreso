import assert from "node:assert/strict";
import test from "node:test";

import {
  activateGlossaryVersion,
  extractGlossaryCandidates,
  listGlossaryPresets,
  pinSessionGlossary,
  validateGlossaryImport,
} from "./glossary-client";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("glossary client uses the frozen same-origin routes and strict success envelopes", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith("/activate")) return response({ ok: true, data: { activation: {
      presetId: "preset", presetVersion: 3, activeDocumentVersion: 2,
      activeDocumentFingerprint: "fingerprint", updatedAt: "2026-08-15T00:00:00Z",
    } } });
    return response({ ok: true, data: { presets: [] } });
  };
  assert.deepEqual(await listGlossaryPresets(fetcher), []);
  await activateGlossaryVersion(fetcher, "preset", 2, 1);
  assert.equal(calls[0]?.input, "/api/glossary-presets");
  assert.equal(calls[1]?.input, "/api/glossary-presets/preset/activate");
  assert.equal(calls[1]?.init?.method, "POST");
  assert.equal(calls[1]?.init?.body, JSON.stringify({ presetVersion: 1, documentVersion: 2 }));
});

test("invalid envelopes and server details become bounded Korean UI errors", async () => {
  await assert.rejects(
    () => listGlossaryPresets(async () => response({ ok: true, data: { presets: [], leaked: "secret" } })),
    /용어집 응답을 확인할 수 없습니다/u,
  );
  await assert.rejects(
    () => validateGlossaryImport(async () => response({ ok: false, error: "SQL secret", code: "INTERNAL" }, 500), "{}"),
    /용어집을 처리할 수 없습니다/u,
  );
});

test("PDF extraction sends candidates for review without activation or document persistence", async () => {
  let request: RequestInit | undefined;
  const candidates = await extractGlossaryCandidates(async (_input, init) => {
    request = init;
    return response({ ok: true, data: { candidates: [] } });
  }, new File(["%PDF-1\n%%EOF"], "terms.pdf", { type: "application/pdf" }), {
    sourceLanguage: "ko", targetLanguages: ["en"], domain: "상업용 부동산",
  });
  assert.deepEqual(candidates, []);
  assert.equal(request?.method, "POST");
  assert.ok(request?.body instanceof FormData);
  assert.equal((request?.body as FormData).get("sourceLanguage"), "ko");
  assert.equal((request?.body as FormData).get("targetLanguages"), "en");
});

test("session pin uses the optimistic version and accepts only the frozen response shape", async () => {
  let body = "";
  const pinned = await pinSessionGlossary(async (input, init) => {
    assert.equal(String(input), "/api/live-sessions/session/glossary");
    body = String(init?.body);
    return response({ ok: true, data: {
      sessionId: "session", version: 8, glossaries: [{ sourceKind: "host", sourceId: "preset", documentVersion: 2, ordinal: 1, fingerprint: "fingerprint" }],
      updatedAt: "2026-08-15T00:00:00Z",
    } });
  }, "session", 7, "preset", 2);
  assert.equal(body, JSON.stringify({ expectedVersion: 7, glossaries: [{ sourceKind: "host", sourceId: "preset", documentVersion: 2 }] }));
  assert.equal(pinned.version, 8);
  await assert.rejects(() => pinSessionGlossary(async () => response({ ok: true, data: {
    sessionId: "session", version: 8, glossaries: [{ sourceKind: "host", sourceId: "preset", documentVersion: 2, ordinal: 1, fingerprint: "fingerprint" }],
    updatedAt: "2026-08-15T00:00:00Z", leaked: true,
  } }), "session", 7, "preset", 2), /응답을 확인할 수 없습니다/u);
});
