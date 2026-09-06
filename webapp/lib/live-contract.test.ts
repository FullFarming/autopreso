import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeAudioChunk,
  encodeAudioChunk,
  type JoinLiveSessionInput,
  type LiveAttendeeSelfProfile,
  type LiveAgendaItem,
  type LiveEventType,
  type LiveHostParticipantActivity,
  type LiveSnapshot,
  type LiveSession,
  type LiveSessionSection,
  type LiveTopicPublicMetadata,
} from "./live-contract";

test("live contract re-exports the validated topic contract and carries topic truth in snapshots", () => {
  const topic = {
    id: "0192d0f4-9f72-7a36-91f5-6a76ef736f43",
    sessionId: "0192d0f4-9f72-7a36-91f5-6a76ef736f42",
    ordinal: 1,
    title: "Revenue outlook",
    summary: null,
    status: "active",
    completionReason: null,
    detectorHealth: "healthy",
    startedAt: "2026-08-15T00:00:00.000Z",
    completedAt: null,
    version: 1,
  } satisfies LiveTopicPublicMetadata;
  const snapshotTopics = {
    topics: [topic],
    topicMemberships: [{
      sessionId: topic.sessionId,
      topicId: topic.id,
      utteranceKey: "gateway:source:1",
      position: 1,
    }],
  } satisfies Pick<LiveSnapshot, "topics" | "topicMemberships">;

  assert.equal(snapshotTopics.topics[0]?.title, "Revenue outlook");
});

test("attendee and host-only contracts keep full email outside participant-visible identity", () => {
  const self = {
    email: "viewer@example.com",
    displayName: "Noel Kim",
    company: "Cushman",
    department: "Strategy",
    jobTitle: "Director",
    summaryConsent: true,
  } satisfies LiveAttendeeSelfProfile;
  const join = {
    ...self,
    accessCode: "123456",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
  } satisfies JoinLiveSessionInput;
  const hostParticipant = {
    participantId: "participant-1",
    displayName: "Noel Kim",
    email: "viewer@example.com",
    company: "Cushman",
    summaryConsentAt: "2026-08-15T00:00:00.000Z",
    department: "Strategy",
    jobTitle: "Director",
    joinedAt: "2026-08-15T00:00:00.000Z",
    lastSeenAt: "2026-08-15T00:01:00.000Z",
    isPresent: true,
    utteranceCount: 0,
    speakingSeconds: 0,
    lastSpokeAt: null,
  } satisfies LiveHostParticipantActivity;

  assert.equal(join.email, "viewer@example.com");
  assert.equal(hostParticipant.displayName, "Noel Kim");
});

test("earnings-call event metadata and section contract are public, ordered, and free of participant PII", () => {
  const agenda = [
    { ordinal: 1, label: "Prepared remarks" },
    { ordinal: 2, label: "Q&A" },
  ] satisfies LiveAgendaItem[];
  const eventType: LiveEventType = "earnings_call";
  const activeSection: LiveSessionSection = "prepared_remarks";
  const session = {
    id: "session-1",
    hostId: "host-1",
    title: "Q2 2026 Earnings Call",
    scheduledAt: null,
    sessionType: "meeting",
    outputMode: "captions",
    voiceProvider: "gemini",
    maxViewers: 50,
    glossaryPack: "general_cre",
    status: "live",
    languages: ["ko"],
    viewerCount: 10,
    version: 3,
    participantSpeakingEnabled: false,
    admissionOpenUntil: null,
    expiresAt: "2026-08-15T06:00:00.000Z",
    companyName: "Cushman & Wakefield",
    ticker: "CWK",
    fiscalPeriod: "Q2 2026",
    eventType,
    agenda,
    activeSection,
    sectionStartedAt: "2026-08-15T00:05:00.000Z",
  } satisfies LiveSession;
  const snapshot = {
    session,
    language: "ko",
    lastSeq: 0,
    captions: [],
    speakers: [],
    topics: [],
    topicMemberships: [],
  } satisfies LiveSnapshot;

  assert.deepEqual(snapshot.session.agenda?.map((item) => item.ordinal), [1, 2]);
  assert.equal(snapshot.session.activeSection, "prepared_remarks");
  assert.doesNotMatch(JSON.stringify(snapshot), /email|summaryConsent|grant|accessCode|inviteToken|viewer@example\.com/iu);
});

test("audio chunk decoder accepts bounded PCM16 and rejects invalid sequence numbers", () => {
  const valid = encodeAudioChunk({
    header: {
      type: "audio-chunk",
      seq: 1,
      sessionId: "session-1",
      language: "ko",
      speaker: null,
      sampleRate: 24_000,
    },
    pcm: new Uint8Array([1, 0, 2, 0]).buffer,
  });
  assert.equal(decodeAudioChunk(valid).pcm.byteLength, 4);

  const invalidSequence = encodeAudioChunk({
    header: {
      type: "audio-chunk",
      seq: -1,
      sessionId: "session-1",
      language: "ko",
      speaker: null,
      sampleRate: 24_000,
    },
    pcm: new Uint8Array([1, 0]).buffer,
  });
  assert.throws(() => decodeAudioChunk(invalidSequence), /헤더/);
});

test("audio chunk decoder bounds header and PCM payload sizes", () => {
  const oversizedHeader = new ArrayBuffer(8);
  new DataView(oversizedHeader).setUint32(0, 4_097, false);
  assert.throws(() => decodeAudioChunk(oversizedHeader), /헤더/);

  const oversizedPcm = encodeAudioChunk({
    header: {
      type: "audio-chunk",
      seq: 2,
      sessionId: "session-1",
      language: "ko",
      speaker: null,
      sampleRate: 24_000,
    },
    pcm: new Uint8Array(256 * 1_024 + 2).buffer,
  });
  assert.throws(() => decodeAudioChunk(oversizedPcm), /PCM/);
});
