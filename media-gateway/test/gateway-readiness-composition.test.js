import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createGatewayServer } from "../src/gateway-server.js";
import { SupabaseHostAuthorizer } from "../src/supabase-adapters.js";
import { createGeminiCaptionConfig } from "../../packages/caption-core/gemini-caption-contract.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const activationKey = "22222222-2222-4222-8222-222222222222";

function token() {
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(JSON.stringify({ role: "HOST", sub: "fixture-host", sessionId,
    aud: "media-gateway", iat: now, exp: now + 60 })).toString("base64url");
  return `${claims}.${createHmac("sha256", "fixture-secret").update(claims).digest("hex")}`;
}

function nextMessage(socket, types) {
  // A persistent listener: the gateway sends engine-status frames in the same
  // tick as the ACK, and a re-armed once() would miss the frame that follows.
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (!types.includes(message.type)) return;
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

for (const sessionType of ["meeting", "presentation"]) {
  test(`actual ${sessionType} captions settings activate with DB-compatible metadata while the media runtime stays voiceless`, { timeout: 5000 }, async (context) => {
    const requests = [], pipelineSettings = [];
    let providerStarts = 0;
    let status = "preparing";
    // A stored legacy source pin is one of the two Live ids (a flash id was never a source; Task 4 fix M1).
    const sourceModel = "gemini-3.5-live-translate-preview";
    const summaryModel = "gemini-3.6-flash";
    const languages = ["en", "ko"];
    const authorizer = new SupabaseHostAuthorizer({ baseUrl: "https://fixture.invalid", serviceRoleKey: "fixture",
      async fetchFn(url, options) {
        if (url.includes("/live_sessions?")) return Response.json([{ id: sessionId, host_id: "fixture-host", status,
          version: status === "preparing" ? 3 : 4, session_type: sessionType, output_mode: "captions", voice_provider: "gemini",
          languages, max_viewers: 200, pinned_glossary_fingerprint: null,
          event_metadata: { modelPreferences: { source: sourceModel, summary: summaryModel } } }]);
        assert.match(url, /\/rpc\/activate_live_session_after_gateway_ready_v1$/u);
        const input = JSON.parse(options.body); requests.push(input);
        // The existing SQL rejects NULL voice_provider before touching a session.
        if (input.p_voice_provider == null || !["gemini", "openai"].includes(input.p_voice_provider)) {
          return Response.json({ code: "22023", message: "INVALID_GATEWAY_READINESS_INPUT" }, { status: 400 });
        }
        status = "live";
        return Response.json([{ session_id: sessionId, status, version: 4 }]);
      },
    });
    const gateway = createGatewayServer({ gatewaySecret: "fixture-secret", viewerSecret: "fixture-viewer", hostAuthorizer: authorizer,
      viewerAuthorizer: { async authorize() { return false; }, async authorizeBatch() { return new Map(); } },
      async pipelineFactory(settings) {
        pipelineSettings.push(settings);
        return { async start() { providerStarts += 1; }, async tick() {}, async acceptAudio() {}, async close() {} };
      },
    });
    await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    context.after(() => gateway.close());
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/live`);
    context.after(() => socket.terminate());
    await once(socket, "open");
    let response = nextMessage(socket, ["authenticated", "error"]);
    socket.send(JSON.stringify({ type: "authenticate", token: token() }));
    assert.equal((await response).type, "authenticated");
    response = nextMessage(socket, ["started", "error"]);
    socket.send(JSON.stringify({ type: "start", sessionId, version: 3, activationKey, sessionType,
      languages, maxViewers: 200, outputMode: "captions", glossaryPack: "general_cre",
      captionConfig: createGeminiCaptionConfig({ languages, geminiTranscribeModel: sourceModel, geminiSummaryModel: summaryModel }),
    }));
    assert.equal((await response).type, "started");
    assert.equal(providerStarts, 1);
    assert.equal(requests.length, 1, "readiness validation must not retry provider starts");
    assert.equal(pipelineSettings[0].voiceProvider, null);
    assert.equal(pipelineSettings[0].captionConfig.models.transcription, "gemini-3.5-transcribe-live",
      "a legacy Flash source pin migrates to the catalog's Transcribe Live engine before activation");
    assert.equal(pipelineSettings[0].captionConfig.engine.stt.model, "gemini-3.5-transcribe-live");
    assert.equal(pipelineSettings[0].captionConfig.models.summary, summaryModel);
    assert.equal(requests[0].p_voice_provider, "gemini");
    const canonical = JSON.stringify({ sessionType, outputMode: "captions", voiceProvider: "gemini", languages,
      maxViewers: 200, glossaryPack: "general_cre", pinnedGlossaryFingerprint: null });
    assert.equal(requests[0].p_gateway_settings_fingerprint, `sha256:${createHash("sha256").update(canonical).digest("hex")}`);
  });
}
