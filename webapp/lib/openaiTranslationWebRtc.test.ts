import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAITranslationWebRtc,
  handleOpenAITranslationEvent,
  mintTranslationClientSecret,
  type OpenAITranslationEventState,
} from "./openaiTranslationWebRtc";
import type { EngineEvent } from "./types";

test("translation token request binds the ephemeral secret to its target language", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const secret = await mintTranslationClientSecret("en", async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, data: { value: "ek_translation", expires_at: 1_800_000_000 } });
  });
  assert.equal(secret, "ek_translation");
  assert.deepEqual(requests, [{ url: "/api/openai-token", body: { targetLanguage: "en" } }]);
});

test("OpenAI provider boundary maps both canonical Chinese scripts to its shared zh output", async () => {
  const targets: string[] = [];
  for (const language of ["zh-Hans", "zh-Hant"] as const) {
    await mintTranslationClientSecret(language, async (_input, init) => {
      targets.push(JSON.parse(String(init?.body)).targetLanguage);
      return Response.json({ ok: true, data: { value: "ek_translation", expires_at: 1_800_000_000 } });
    });
  }
  assert.deepEqual(targets, ["zh", "zh"]);
});

test("translation transcript deltas map to EngineEvent without sending response.create", () => {
  const events: EngineEvent[] = [];
  const sent: string[] = [];
  const state: OpenAITranslationEventState = { sourceText: "", translatedText: "" };
  const context = {
    source: "mic" as const,
    targetLanguage: "ko" as const,
    emit: (event: EngineEvent) => events.push(event),
    scheduleCommit: () => undefined,
    commit: () => undefined,
    send: (payload: string) => sent.push(payload),
  };

  handleOpenAITranslationEvent(JSON.stringify({ type: "session.input_transcript.delta", delta: "Good " }), state, context);
  handleOpenAITranslationEvent(JSON.stringify({ type: "session.output_transcript.delta", delta: "좋은 " }), state, context);
  handleOpenAITranslationEvent(JSON.stringify({ type: "session.input_transcript.delta", delta: "morning" }), state, context);
  handleOpenAITranslationEvent(JSON.stringify({ type: "session.output_transcript.delta", delta: "아침입니다" }), state, context);

  assert.deepEqual(events.at(-1), {
    type: "partial",
    source: "mic",
    targetLanguage: "ko",
    sourceText: "Good morning",
    translatedText: "좋은 아침입니다",
  });
  assert.deepEqual(sent, [], "dedicated translation sessions must never use response.create");
});

test("same-target source speech may stay silent without becoming an error", () => {
  const events: EngineEvent[] = [];
  const state: OpenAITranslationEventState = { sourceText: "", translatedText: "" };
  const context = {
    source: "mic" as const,
    targetLanguage: "ko" as const,
    emit: (event: EngineEvent) => events.push(event),
    scheduleCommit: () => undefined,
    commit: () => undefined,
    send: () => undefined,
  };
  handleOpenAITranslationEvent(JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕하세요", language: "ko" }), state, context);
  handleOpenAITranslationEvent(JSON.stringify({ type: "session.output_transcript.delta", delta: "안녕하세요" }), state, context);
  handleOpenAITranslationEvent(JSON.stringify({ type: "session.input_transcript.done", transcript: "안녕하세요", language: "ko" }), state, context);
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.some((event) => event.type === "partial"), false);
});

test("script evidence overrides a contradictory provider hint and transcript buffers stay bounded", () => {
  const events: EngineEvent[] = [];
  const state: OpenAITranslationEventState = { sourceText: "", translatedText: "" };
  const context = {
    source: "mic" as const,
    targetLanguage: "ko" as const,
    emit: (event: EngineEvent) => events.push(event),
    scheduleCommit: () => undefined,
    commit: () => undefined,
  };

  handleOpenAITranslationEvent(JSON.stringify({
    type: "session.input_transcript.delta",
    delta: `한국어 문장${"가".repeat(40_000)}`,
    language: "en",
  }), state, context);
  handleOpenAITranslationEvent(JSON.stringify({
    type: "session.output_transcript.delta",
    delta: `반복되면 안 됩니다${"나".repeat(40_000)}`,
  }), state, context);

  assert.equal(state.sourceText.length, 32_768);
  assert.equal(state.translatedText, "", "strong Korean script evidence suppresses a Korean target echo");
  assert.equal(events.some((event) => event.type === "partial"), false);
});

test("WebRTC uses the source track directly, translation calls endpoint, and user-authorized playback", async () => {
  const sourceTrack = { enabled: true } as unknown as MediaStreamTrack;
  const sourceStream = { getAudioTracks: () => [sourceTrack] } as unknown as MediaStream;
  const addedTracks: MediaStreamTrack[] = [];
  const fetches: Array<{ url: string; authorization: string; contentType: string; body: unknown }> = [];
  let played = 0;
  let autoplay = true;
  let onTrack: ((event: RTCTrackEvent) => void) | null = null;
  const channel = {
    addEventListener: () => undefined,
    close: () => undefined,
  } as unknown as RTCDataChannel;
  const peer = {
    addTrack: (track: MediaStreamTrack) => { addedTracks.push(track); },
    createDataChannel: () => channel,
    createOffer: async () => ({ type: "offer", sdp: "offer-sdp" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async () => undefined,
    close: () => undefined,
    set ontrack(value: ((event: RTCTrackEvent) => void) | null) { onTrack = value; },
    get ontrack() { return onTrack; },
  } as unknown as RTCPeerConnection;
  const audio = {
    get autoplay() { return autoplay; },
    set autoplay(value: boolean) { autoplay = value; },
    setAttribute: () => undefined,
    srcObject: null,
    play: async () => { played += 1; },
    pause: () => undefined,
  } as unknown as HTMLAudioElement;

  const session = createOpenAITranslationWebRtc({
    source: "tab",
    targetLanguage: "en",
    stream: sourceStream,
    emit: () => undefined,
    fetcher: async (input, init) => {
      const url = String(input);
      fetches.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        contentType: new Headers(init?.headers).get("content-type") ?? "",
        body: init?.body ?? null,
      });
      if (url === "/api/openai-token") {
        return Response.json({ ok: true, data: { value: "ek_translation", expires_at: 1_800_000_000 } });
      }
      return new Response("answer-sdp");
    },
    createPeerConnection: () => peer,
    createAudioElement: () => audio,
  });

  session.allowPlayback();
  await session.start();
  assert.deepEqual(addedTracks, [sourceTrack], "the original MediaStreamTrack is reused without cloning");
  assert.equal(autoplay, true, "the user-authorized start enables the official WebRTC autoplay path");
  assert.deepEqual(fetches.map(({ url, authorization, contentType }) => ({ url, authorization, contentType })), [
    { url: "/api/openai-token", authorization: "", contentType: "application/json" },
    {
      url: "https://api.openai.com/v1/realtime/translations/calls",
      authorization: "Bearer ek_translation",
      contentType: "application/sdp",
    },
  ]);
  assert.equal(fetches[1]?.body, "offer-sdp");
  assert.ok(onTrack);
  const remoteStream = {} as MediaStream;
  const triggerTrack = onTrack as unknown as (event: RTCTrackEvent) => void;
  triggerTrack({ streams: [remoteStream] } as unknown as RTCTrackEvent);
  await Promise.resolve();
  assert.equal(audio.srcObject, remoteStream);
  assert.equal(played, 1);
  await session.close();
});
