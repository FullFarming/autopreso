import assert from "node:assert/strict";
import { test } from "node:test";

import { startServer } from "../src/server.js";


function createReadyTranscription() {
  return {
    ready: async () => {},
    sendAudio: () => {},
    stop: () => {},
    close: () => {},
  };
}

test("NOVA does not expose the retired Meeting Coach or canvas pages", async () => {
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
      assert.equal(response.status, 404, asset);
    }

    const unrelated = await fetch(`${url}/app.js`);
    assert.equal(unrelated.status, 404);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
