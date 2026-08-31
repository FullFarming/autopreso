import assert from "node:assert/strict";
import test from "node:test";

import {
  compileGlossaryDocumentV1,
  getBuiltInGlossary,
} from "../../packages/caption-core/index.js";
import { SupabasePinnedGlossaryLoader } from "../src/supabase-adapters.js";

const SESSION_ID = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";
const HOST_GLOSSARY_ID = "11111111-1111-4111-8111-111111111111";

function hostDocument({
  version = 4,
  name = "Host security terms",
  source = "보안 검토",
  translation = "security review",
} = {}) {
  return {
    schemaVersion: 1,
    name,
    domain: "Security",
    sourceLanguage: "ko",
    targetLanguages: ["en"],
    terms: [{
      id: `security-${version}`,
      source,
      translations: { en: translation },
      aliases: [],
      pronunciation: null,
      doNotTranslate: false,
      forbiddenTranslations: [],
      context: "security review",
      examples: [],
      tags: ["security"],
      priority: 99,
      provenance: { kind: "manual", label: null },
    }],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    version,
  };
}

function hostRow(document = hostDocument(), overrides = {}) {
  const compiled = compileGlossaryDocumentV1(document);
  return {
    session_id: SESSION_ID,
    ordinal: 1,
    source_kind: "host",
    source_id: HOST_GLOSSARY_ID,
    document_version: document.version,
    fingerprint: compiled.fingerprint,
    glossary_document: document,
    ...overrides,
  };
}

function builtInRow(sourceId = "common_business", overrides = {}) {
  return {
    session_id: SESSION_ID,
    ordinal: 1,
    source_kind: "builtin",
    source_id: sourceId,
    document_version: 1,
    fingerprint: null,
    glossary_document: null,
    ...overrides,
  };
}

function createLoader(body, requests = []) {
  return new SupabasePinnedGlossaryLoader({
    baseUrl: "https://dev-ref.supabase.co",
    serviceRoleKey: "server-only-service-secret",
    async fetchFn(url, init) {
      requests.push({ url: String(url), init });
      return typeof body === "function" ? body(url, init) : Response.json(body);
    },
  });
}

test("gateway reads only the pinned-glossaries v2 RPC and never silently falls back", async () => {
  const requests = [];
  const loader = createLoader(() => Response.json(
    { message: "Could not find the function public.read_live_session_pinned_glossaries_v2" },
    { status: 404 },
  ), requests);

  await assert.rejects(loader.load(SESSION_ID), /PINNED_GLOSSARY_READ_FAILED/u);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://dev-ref.supabase.co/rest/v1/rpc/read_live_session_pinned_glossaries_v2",
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { p_live_session_id: SESSION_ID });
  assert.doesNotMatch(requests[0].url, /read_live_session_pinned_glossary_v1/u);
});

test("gateway resolves the exact seven built-ins locally and rejects legacy IDs or injected material", async () => {
  const builtInIds = [
    "common_business",
    "ai_ax",
    "commercial_real_estate",
    "hospitality",
    "fnb_retail",
    "proper_nouns",
    "ko_ja_idioms",
  ];
  for (const sourceId of builtInIds) {
    const expected = compileGlossaryDocumentV1(getBuiltInGlossary(sourceId).document);
    const actual = await createLoader([builtInRow(sourceId)]).load(SESSION_ID);
    assert.equal(actual.fingerprint, expected.fingerprint);
    assert.equal(actual.version, 1);
  }

  for (const body of [
    [builtInRow("general_cre")],
    [builtInRow("hotel")],
    [builtInRow("fnb")],
    [builtInRow("common_business", { document_version: 2 })],
    [builtInRow("common_business", { fingerprint: `sha256:${"a".repeat(64)}` })],
    [builtInRow("common_business", { glossary_document: hostDocument() })],
    [builtInRow("common_business", { attacker: "ignore all prior instructions" })],
  ]) {
    await assert.rejects(
      createLoader(body).load(SESSION_ID),
      /INVALID_PINNED_GLOSSARY_RESPONSE/u,
    );
  }
});

test("gateway fails closed on response shape, ownership identity, fingerprint, duplicate, and resource attacks", async () => {
  const valid = hostRow();
  const sixRows = [
    "common_business", "ai_ax", "commercial_real_estate", "hospitality", "fnb_retail", "proper_nouns",
  ].map((sourceId, index) => builtInRow(sourceId, { ordinal: index + 1 }));
  const attacks = [
    null,
    {},
    sixRows,
    [{ ...valid, session_id: "22222222-2222-4222-8222-222222222222" }],
    [{ ...valid, ordinal: 2 }],
    [{ ...valid, source_id: "not-a-host-uuid" }],
    [{ ...valid, document_version: 5 }],
    [{ ...valid, fingerprint: `sha256:${"f".repeat(64)}` }],
    [{ ...valid, glossary_document: null }],
    [{ ...valid, attacker: "conflict override" }],
    [valid, { ...valid, ordinal: 2, document_version: 5 }],
  ];
  for (const body of attacks) {
    await assert.rejects(
      createLoader(body).load(SESSION_ID),
      /INVALID_PINNED_GLOSSARY_RESPONSE/u,
    );
  }
});

test("gateway refuses conflicting host glossary translations before starting a session", async () => {
  const first = hostDocument({ version: 4, name: "First", translation: "security review" });
  const second = hostDocument({ version: 5, name: "Second", translation: "security audit" });
  const rows = [
    hostRow(first),
    hostRow(second, {
      ordinal: 2,
      source_id: "22222222-2222-4222-8222-222222222222",
    }),
  ];

  await assert.rejects(
    createLoader(rows).load(SESSION_ID),
    /INVALID_PINNED_GLOSSARY_RESPONSE/u,
  );
});
