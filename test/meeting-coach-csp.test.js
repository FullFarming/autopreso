import assert from "node:assert/strict";
import { test } from "node:test";

import { startServer } from "../src/server.js";

const EXPECTED_MEETING_COACH_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

function createReadyTranscription() {
  return {
    ready: async () => {},
    sendAudio: () => {},
    stop: () => {},
    close: () => {},
  };
}

test("Meeting Coach static HTML receives a scoped CSP without changing unrelated assets", async () => {
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: createReadyTranscription,
  });

  try {
    for (const asset of [
      "meeting-coach-prep.html",
      "meeting-coach-record.html",
      "meeting-coach-response.html",
    ]) {
      const response = await fetch(`${url}/${asset}`);
      assert.equal(response.status, 200, asset);
      assert.equal(response.headers.get("content-security-policy"), EXPECTED_MEETING_COACH_CSP, asset);
    }

    const unrelated = await fetch(`${url}/app.js`);
    assert.equal(unrelated.status, 200);
    assert.equal(unrelated.headers.get("content-security-policy"), null);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
