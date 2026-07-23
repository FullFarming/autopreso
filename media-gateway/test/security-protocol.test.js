import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { encodeAudioFrame } from "../src/binary-audio.js";
import { verifyLiveToken } from "../src/token-verifier.js";

function sign(claims, secret) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

test("gateway tokens are audience-bound, time-limited, and tamper evident", () => {
  const now = Date.UTC(2026, 6, 19);
  const token = sign({ role: "HOST", sub: "host-1", sessionId: "s1", aud: "media-gateway", iat: now / 1_000, exp: now / 1_000 + 900 }, "gateway-secret");
  assert.equal(verifyLiveToken(token, { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", now: () => now }).sessionId, "s1");
  assert.throws(() => verifyLiveToken(`${token.slice(0, -1)}0`, { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", now: () => now }), /UNAUTHORIZED/);
  assert.throws(() => verifyLiveToken(token, { gatewaySecret: "gateway-secret", viewerSecret: "viewer-secret", now: () => now + 900_000 }), /UNAUTHORIZED/);
});

test("townhall audio uses length-prefixed JSON followed by raw PCM", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const header = { type: "audio-chunk", seq: 1, sessionId: "s1", language: "ko", sampleRate: 24_000 };
  const frame = encodeAudioFrame(header, pcm);
  const headerLength = frame.readUInt32BE(0);
  assert.deepEqual(JSON.parse(frame.subarray(4, 4 + headerLength).toString("utf8")), header);
  assert.deepEqual(frame.subarray(4 + headerLength), pcm);
});
