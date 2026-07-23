import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, afterEach, beforeEach } from "node:test";

import { POST } from "./route";
import { consumeOpenAiTranslationRateLimit } from "../../../lib/security/openai-translation-security";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-server-long-lived-secret";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  globalThis.fetch = originalFetch;
});

function request(targetLanguage: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/openai-token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ targetLanguage }),
  });
}

test("openai-token remains behind strict-origin and authenticated middleware", () => {
  const middlewareSource = readFileSync(new URL("../../../middleware.ts", import.meta.url), "utf8");
  const csrfGuardIndex = middlewareSource.indexOf("assertStrictOrigin(request)");
  const publicRouteIndex = middlewareSource.indexOf("isPublicUnauthenticatedPath(pathname)");
  const authenticationIndex = middlewareSource.indexOf("verifySessionToken(token)");

  assert.ok(csrfGuardIndex >= 0 && csrfGuardIndex < publicRouteIndex);
  assert.ok(authenticationIndex > publicRouteIndex);
  assert.doesNotMatch(middlewareSource, /["']\/api\/openai-token["']/u);
});

test("openai-token mints a dedicated translation secret and returns only the standard envelope", async () => {
  const requests: Array<{ url: string; authorization: string; hasAbortSignal: boolean; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      hasAbortSignal: init?.signal instanceof AbortSignal,
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({ client_secret: { value: "ek_ephemeral-client-secret", expires_at: 1_800_000_000 } });
  };

  const response = await POST(request("ko"));
  const body: unknown = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    data: { value: "ek_ephemeral-client-secret", expires_at: 1_800_000_000 },
  });
  assert.deepEqual(requests, [{
    url: "https://api.openai.com/v1/realtime/translations/client_secrets",
    authorization: "Bearer sk-server-long-lived-secret",
    hasAbortSignal: true,
    body: {
      session: {
        model: "gpt-realtime-translate",
        audio: {
          input: { transcription: { model: "gpt-realtime-whisper" } },
          output: { language: "ko" },
        },
      },
    },
  }]);
  assert.equal(JSON.stringify(body).includes("sk-server-long-lived-secret"), false);
});

test("openai-token hides provider response bodies and exception messages", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("provider-secret-body", { status: 429 });
  };
  const providerFailure = await POST(request("en"));
  const providerBody: unknown = await providerFailure.json();
  assert.equal(providerFailure.status, 502);
  assert.deepEqual(providerBody, {
    ok: false,
    error: "OpenAI 임시 토큰을 발급할 수 없습니다.",
    code: "OPENAI_TOKEN_PROVIDER_ERROR",
  });
  assert.equal(JSON.stringify(providerBody).includes("provider-secret-body"), false);
  assert.equal(attempts, 1, "translation secret minting fails closed without a general-realtime fallback");

  globalThis.fetch = async () => {
    throw new Error("network exception containing sk-sensitive-secret");
  };
  const networkFailure = await POST(request("en"));
  const networkBody: unknown = await networkFailure.json();
  assert.equal(networkFailure.status, 502);
  assert.deepEqual(networkBody, {
    ok: false,
    error: "OpenAI 임시 토큰을 발급할 수 없습니다.",
    code: "OPENAI_TOKEN_REQUEST_FAILED",
  });
  assert.equal(JSON.stringify(networkBody).includes("sk-sensitive-secret"), false);
});

test("openai-token maps provider aborts safely", async () => {
  globalThis.fetch = async () => {
    const error = new Error("provider abort body must stay private");
    error.name = "AbortError";
    throw error;
  };
  const timeoutResponse = await POST(request("ja"));
  assert.equal(timeoutResponse.status, 504);
  assert.deepEqual(await timeoutResponse.json(), {
    ok: false,
    error: "OpenAI 임시 토큰 발급 요청 시간이 초과되었습니다.",
    code: "OPENAI_TOKEN_TIMEOUT",
  });
});

test("openai-token rejects malformed JSON, invalid shapes, and a reflected server key", async () => {
  const invalidResponses = [
    new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    Response.json({ client_secret: { expires_at: 1_800_000_000 } }),
    Response.json({ value: "sk-server-long-lived-secret" }),
    Response.json({ value: "ek_invalid\nsecret", expires_at: 1_800_000_000 }),
    Response.json({ value: `ek_${"x".repeat(8_192)}`, expires_at: 1_800_000_000 }),
    Response.json({ value: "ek_invalid-expiry", expires_at: Number.POSITIVE_INFINITY }),
  ];

  for (const providerResponse of invalidResponses) {
    globalThis.fetch = async () => providerResponse.clone();
    const response = await POST(request("ko"));
    const body: unknown = await response.json();
    assert.equal(response.status, 502);
    assert.deepEqual(body, {
      ok: false,
      error: "OpenAI 임시 토큰 응답이 올바르지 않습니다.",
      code: "OPENAI_TOKEN_INVALID_RESPONSE",
    });
    assert.equal(JSON.stringify(body).includes("sk-server-long-lived-secret"), false);
  }
});

test("openai-token fails closed when the server key is missing", async () => {
  delete process.env.OPENAI_API_KEY;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ value: "unexpected" });
  };

  const response = await POST(request("ko"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "OpenAI 임시 토큰 기능이 설정되지 않았습니다.",
    code: "OPENAI_TOKEN_NOT_CONFIGURED",
  });
  assert.equal(called, false);
});

test("openai-token normalizes all supported spoken outputs and rejects unsupported targets", async () => {
  const providerLanguages: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { session: { audio: { output: { language: string } } } };
    providerLanguages.push(body.session.audio.output.language);
    return Response.json({ value: `ek_${providerLanguages.length}`, expires_at: 1_800_000_000 });
  };
  for (const targetLanguage of [
    "en", "es", "pt", "fr", "ja", "ru", "zh-Hans", "zh-Hant", "de", "ko", "hi", "id", "vi", "it",
  ]) {
    const response = await POST(request(targetLanguage, { "x-vercel-forwarded-for": `198.51.100.${providerLanguages.length + 1}` }));
    assert.equal(response.status, 200);
  }
  assert.equal(new Set(providerLanguages).size, 13);
  assert.deepEqual(providerLanguages.slice(6, 8), ["zh", "zh"]);
  for (const [alias, expected] of [["KO", "ko"], ["zh-TW", "zh"]] as const) {
    const response = await POST(request(alias, { "x-vercel-forwarded-for": `203.0.113.${providerLanguages.length + 1}` }));
    assert.equal(response.status, 200);
    assert.equal(providerLanguages.at(-1), expected);
  }

  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ value: "unexpected" });
  };

  const invalidRequests = [
    request("th"),
    new Request("http://localhost/api/openai-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    }),
  ];
  for (const invalidRequest of invalidRequests) {
    const response = await POST(invalidRequest);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "지원하지 않는 OpenAI 번역 대상 언어입니다.",
      code: "OPENAI_TARGET_LANGUAGE_INVALID",
    });
  }
  assert.equal(called, false);
});

test("openai-token rejects oversized bodies and unsafe server keys before provider IO", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ value: "unexpected" });
  };

  const oversized = new Request("http://localhost/api/openai-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetLanguage: "ko", padding: "x".repeat(2_000) }),
  });
  const oversizedResponse = await POST(oversized);
  assert.equal(oversizedResponse.status, 400);
  assert.deepEqual(await oversizedResponse.json(), {
    ok: false,
    error: "OpenAI 번역 요청이 올바르지 않습니다.",
    code: "OPENAI_TOKEN_REQUEST_INVALID",
  });

  process.env.OPENAI_API_KEY = "sk-valid-prefix\nInjected: value";
  const unsafeKeyResponse = await POST(request("ko"));
  assert.equal(unsafeKeyResponse.status, 503);
  assert.deepEqual(await unsafeKeyResponse.json(), {
    ok: false,
    error: "OpenAI 임시 토큰 기능이 설정되지 않았습니다.",
    code: "OPENAI_TOKEN_NOT_CONFIGURED",
  });
  assert.equal(called, false);
});

test("openai-token rate limits repeated secret minting without leaking provider data", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ value: `ek_ephemeral-${calls}`, expires_at: 1_800_000_000 });
  };
  const headers = { "x-vercel-forwarded-for": "203.0.113.73" };

  for (let index = 0; index < 12; index += 1) {
    const response = await POST(request("en", headers));
    assert.equal(response.status, 200);
  }
  const blocked = await POST(request("en", headers));
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), {
    ok: false,
    error: "OpenAI 번역 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    code: "OPENAI_TOKEN_RATE_LIMITED",
  });
  assert.equal(calls, 12);
  assert.match(blocked.headers.get("retry-after") ?? "", /^\d+$/u);
});

test("production OpenAI token limits use the persistent opaque IP bucket", async () => {
  const calls: Array<{ scope: string; keyHash: string; limit: number; windowSeconds: number }> = [];
  const headers = new Headers({ "x-vercel-forwarded-for": "203.0.113.91" });
  const decision = await consumeOpenAiTranslationRateLimit(headers, {
    environment: { NODE_ENV: "production" },
    store: {
      async consumeRateLimit(input) {
        calls.push(input);
        return false;
      },
    },
  });
  assert.deepEqual(decision, { isAllowed: false, retryAfterSeconds: 60 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "openai-translation-token-ip");
  assert.match(calls[0].keyHash, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(calls).includes("203.0.113.91"), false);
  assert.deepEqual({ limit: calls[0].limit, windowSeconds: calls[0].windowSeconds }, { limit: 12, windowSeconds: 60 });
});
