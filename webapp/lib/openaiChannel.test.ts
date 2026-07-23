import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

import { buildInterpreterSession, mintClientSecret } from "./openaiChannel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test("mintClientSecret accepts only the standard success envelope", async () => {
  globalThis.fetch = async () => Response.json({
    ok: true,
    data: { value: "ek_ephemeral-client-secret", expires_at: 1_800_000_000 },
  });
  assert.equal(await mintClientSecret(), "ek_ephemeral-client-secret");

  for (const legacyOrMalformed of [
    { value: "legacy-top-level-secret", expires_at: 1_800_000_000 },
    { ok: true, data: { expires_at: 1_800_000_000 } },
    { ok: true, data: { value: "", expires_at: 1_800_000_000 } },
    { ok: true, data: { value: "ek_secret", expires_at: { unsafe: true } } },
  ]) {
    globalThis.fetch = async () => Response.json(legacyOrMalformed);
    await assert.rejects(
      mintClientSecret(),
      /OpenAI 토큰 응답이 올바르지 않습니다/,
    );
  }
});

test("mintClientSecret reads a bounded Korean error and safe code from the error envelope", async () => {
  globalThis.fetch = async () => Response.json({
    ok: false,
    error: "OpenAI 임시 토큰 기능이 설정되지 않았습니다.",
    code: "OPENAI_TOKEN_NOT_CONFIGURED",
  }, { status: 503 });

  await assert.rejects(
    mintClientSecret(),
    (error: unknown) => error instanceof Error
      && error.message === "OpenAI 임시 토큰 기능이 설정되지 않았습니다. (OPENAI_TOKEN_NOT_CONFIGURED)",
  );
});

test("mintClientSecret never reflects malformed JSON or unsafe error fields", async () => {
  const unsafe = "<script>provider secret</script>";
  const responses = [
    new Response("not-json", { status: 502 }),
    Response.json({ ok: false, error: unsafe, code: "OPENAI_TOKEN_PROVIDER_ERROR" }, { status: 502 }),
    Response.json({ ok: false, error: "안전해 보이는 오류", code: "BAD CODE<script>" }, { status: 502 }),
  ];

  for (const response of responses) {
    globalThis.fetch = async () => response.clone();
    await assert.rejects(
      mintClientSecret(),
      (error: unknown) => error instanceof Error
        && error.message === "OpenAI 토큰 발급에 실패했습니다. (502)"
        && !error.message.includes(unsafe),
    );
  }
});

test("general realtime interpreter prompt treats each VAD turn as a fresh language decision", () => {
  const session = buildInterpreterSession("ko");
  assert.match(session.instructions, /Detect the spoken language independently for every VAD turn/);
  assert.match(session.instructions, /immediate English↔Korean switches/);
  assert.match(session.instructions, /Names and acronyms may remain in their original script/);
});
