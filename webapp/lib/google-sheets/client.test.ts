import assert from "node:assert/strict";
import test from "node:test";

import { getGoogleSheetsConfig } from "../live/config";
import {
  GOOGLE_SHEETS_SCOPE,
  GoogleSheetsRequestError,
  createGoogleAuthOptions,
  createGoogleSheetsClient,
} from "./index";

const CONFIG_ENV = {
  GOOGLE_SHEETS_SYNC_ENABLED: "true",
  GOOGLE_SHEETS_WORKBOOK_ID: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  GOOGLE_SHEETS_SESSION_INDEX_SHEET_ID: "7",
  GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: "nova-sheets@example-project.iam.gserviceaccount.com",
  GOOGLE_SHEETS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nprivate-material\\n-----END PRIVATE KEY-----\\n",
};

test("Sheets config is disabled by default and fail-fast validates every server secret when enabled", () => {
  assert.deepEqual(getGoogleSheetsConfig({}), { enabled: false });
  assert.throws(() => getGoogleSheetsConfig({ GOOGLE_SHEETS_SYNC_ENABLED: "yes" }), /true 또는 false/u);
  for (const key of Object.keys(CONFIG_ENV)) {
    if (key === "GOOGLE_SHEETS_SYNC_ENABLED") continue;
    assert.throws(() => getGoogleSheetsConfig({ ...CONFIG_ENV, [key]: "" }), /Google Sheets/u);
  }
  const config = getGoogleSheetsConfig(CONFIG_ENV);
  assert.equal(config.enabled, true);
  if (!config.enabled) throw new Error("test config must be enabled");
  assert.equal(config.privateKey.includes("\\n"), false);
  assert.equal(config.sessionIndexSheetId, 7);
});

test("service-account auth options use only the fixed Sheets scope and no delegated subject", () => {
  const config = getGoogleSheetsConfig(CONFIG_ENV);
  if (!config.enabled) throw new Error("test config must be enabled");
  assert.deepEqual(createGoogleAuthOptions(config), {
    credentials: { client_email: config.clientEmail, private_key: config.privateKey },
    scopes: [GOOGLE_SHEETS_SCOPE],
  });
  assert.equal(Object.hasOwn(createGoogleAuthOptions(config), "subject"), false);
});

test("one batch uses the fixed Sheets origin, bearer token, private fetch, and never retries a failure", async () => {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const client = createGoogleSheetsClient({
    workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    async getAccessToken() { return "access-token"; },
    async fetchFn(input, init) {
      calls.push({ input: String(input), init: init ?? {} });
      return new Response(null, { status: 429 });
    },
  });
  await assert.rejects(
    client.batchUpdate([{ updateCells: { fields: "userEnteredValue" } }]),
    (error: unknown) => error instanceof GoogleSheetsRequestError && error.code === "SHEETS_RATE_LIMITED",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "https://sheets.googleapis.com/v4/spreadsheets/workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ:batchUpdate");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer access-token");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.equal(calls[0]?.init.cache, "no-store");
  assert.equal(calls[0]?.init.redirect, "error");
});

test("payloads at the 2 MB boundary fail before auth or fetch", async () => {
  let authCount = 0;
  let fetchCount = 0;
  const client = createGoogleSheetsClient({
    workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    async getAccessToken() { authCount += 1; return "access-token"; },
    async fetchFn() { fetchCount += 1; return new Response(null, { status: 200 }); },
  });
  await assert.rejects(
    client.batchUpdate([{ updateCells: { value: "x".repeat(2_000_000) } }]),
    (error: unknown) => error instanceof GoogleSheetsRequestError && error.code === "SHEETS_PAYLOAD_TOO_LARGE",
  );
  assert.equal(authCount, 0);
  assert.equal(fetchCount, 0);
});

test("abort bounds a stalled token lookup and prevents any Sheets dispatch", async () => {
  let fetchCount = 0;
  const controller = new AbortController();
  const client = createGoogleSheetsClient({
    workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    async getAccessToken() { return new Promise<string>(() => undefined); },
    async fetchFn() { fetchCount += 1; return new Response(null, { status: 200 }); },
  });
  const request = client.batchUpdate([{ updateCells: {} }], { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof GoogleSheetsRequestError
    && error.code === "SHEETS_ABORTED");
  assert.equal(fetchCount, 0);
});

test("one workbook serializes physical requests and exposes no raw provider error", async () => {
  const resolvers: Array<() => void> = [];
  let active = 0;
  let maximumActive = 0;
  let fetchCount = 0;
  const client = createGoogleSheetsClient({
    workbookId: "workbook_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    async getAccessToken() { return "access-token"; },
    async fetchFn() {
      fetchCount += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (fetchCount === 2) throw new Error("private@example.com credential=secret");
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
      return new Response("{}", { status: 200 });
    },
  });
  const first = client.batchUpdate([{ updateCells: {} }]);
  const second = client.batchUpdate([{ updateCells: {} }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  resolvers.shift()?.();
  await first;
  await assert.rejects(second, (error: unknown) => error instanceof GoogleSheetsRequestError
    && error.code === "SHEETS_PROVIDER_FAILED"
    && !error.message.includes("private@example.com"));
  assert.equal(maximumActive, 1);
  assert.equal(fetchCount, 2);
});
