import assert from "node:assert/strict";
import test from "node:test";

import { buildParticipantActivity, buildParticipantRoster } from "./activity";

test("participant activity joins retained identity with speaker-attributed utterances", async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/rpc/read_live_participant_roster")) {
      return Response.json([{
        participant_id: "grant-1",
        display_name: "n***@example.com",
        email: "noel@example.com",
        company: "Cushman",
        summary_consent_at: "2026-07-23T00:00:00.000Z",
        department: "Strategy",
        job_title: "Director",
        joined_at: "2026-07-23T00:00:00.000Z",
        last_seen_at: "2026-07-23T00:10:00.000Z",
        left_at: null,
        utterance_count: 2,
        speaking_seconds: 7,
        last_spoke_at: "2026-07-23T00:00:11.000Z",
      }]);
    }
    if (url.includes("/live_utterances?")) {
      return Response.json([
        {
          seq: 1,
          participant_id: "grant-1",
          speaker_label: "participant:grant-1",
          speaker_name: "Noel Kim",
          text: "First point",
          source_started_at: "2026-07-23T00:00:01.000Z",
          source_ended_at: "2026-07-23T00:00:05.000Z",
          emitted_at: "2026-07-23T00:00:05.100Z",
        },
        {
          seq: 2,
          participant_id: "grant-1",
          speaker_label: "participant:grant-1",
          speaker_name: "Noel Kim",
          text: "Second point",
          source_started_at: "2026-07-23T00:00:08.000Z",
          source_ended_at: "2026-07-23T00:00:11.000Z",
          emitted_at: "2026-07-23T00:00:11.100Z",
        },
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const activity = await buildParticipantActivity(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    "host-1",
    "en",
    fetchFn,
    {
      baseUrl: "https://dev-ref.supabase.co",
      credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    },
  );

  assert.deepEqual(activity.participants, [{
    participantId: "grant-1",
    displayName: "n***@example.com",
    email: "noel@example.com",
    company: "Cushman",
    summaryConsentAt: "2026-07-23T00:00:00.000Z",
    department: "Strategy",
    jobTitle: "Director",
    joinedAt: "2026-07-23T00:00:00.000Z",
    lastSeenAt: "2026-07-23T00:10:00.000Z",
    isPresent: true,
    utteranceCount: 2,
    speakingSeconds: 7,
    lastSpokeAt: "2026-07-23T00:00:11.000Z",
  }]);
  assert.equal(activity.recentSpeeches.length, 2);
  assert.equal(activity.recentSpeeches[1]?.department, "Strategy");
  assert.equal(activity.recentSpeeches[1]?.jobTitle, "Director");
  assert.equal(JSON.stringify(activity.recentSpeeches).includes("noel@example.com"), false);
});

test("participant duration rejects invalid or implausibly long timestamp ranges", async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/rpc/read_live_participant_roster")) {
      return Response.json([{
        participant_id: "grant-1",
        display_name: "Noel Kim",
        email: null,
        company: null,
        summary_consent_at: null,
        department: "Strategy",
        job_title: "Director",
        joined_at: "2026-07-23T00:00:00.000Z",
        last_seen_at: "2026-07-23T00:10:00.000Z",
        left_at: "2026-07-23T00:10:00.000Z",
        utterance_count: 1,
        speaking_seconds: 0,
        last_spoke_at: "2026-07-23T00:00:00.000Z",
      }]);
    }
    return Response.json([{
      seq: 1,
      participant_id: "grant-1",
      speaker_label: "participant:grant-1",
      speaker_name: "Noel Kim",
      text: "Point",
      source_started_at: "2026-07-22T00:00:00.000Z",
      source_ended_at: "2026-07-23T00:00:00.000Z",
      emitted_at: "2026-07-23T00:00:00.100Z",
    }]);
  };

  const activity = await buildParticipantActivity(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    "host-1",
    "en",
    fetchFn,
    {
      baseUrl: "https://dev-ref.supabase.co",
      credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    },
  );
  assert.equal(activity.participants[0]?.speakingSeconds, 0);
  assert.equal(activity.participants[0]?.isPresent, false);
});

test("participant activity accepts nullable optional identity and a 100 character job title", async () => {
  const longJobTitle = "D".repeat(100);
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/rpc/read_live_participant_roster")) {
      return Response.json([
        {
          participant_id: "grant-1",
          display_name: "Noel Kim",
          email: null,
          company: null,
          summary_consent_at: null,
          department: null,
          job_title: null,
          joined_at: "2026-07-23T00:00:00.000Z",
          last_seen_at: "2026-07-23T00:10:00.000Z",
          left_at: null,
          utterance_count: 0,
          speaking_seconds: 0,
          last_spoke_at: null,
        },
        {
          participant_id: "grant-2",
          display_name: "Mina Lee",
          email: null,
          company: null,
          summary_consent_at: null,
          department: "Strategy",
          job_title: longJobTitle,
          joined_at: "2026-07-23T00:00:00.000Z",
          last_seen_at: "2026-07-23T00:10:00.000Z",
          left_at: null,
          utterance_count: 0,
          speaking_seconds: 0,
          last_spoke_at: null,
        },
      ]);
    }
    return Response.json([]);
  };

  const activity = await buildParticipantActivity(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    "host-1",
    "en",
    fetchFn,
    {
      baseUrl: "https://dev-ref.supabase.co",
      credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    },
  );

  assert.equal(activity.participants.length, 2);
  assert.equal(activity.participants[0]?.department, "");
  assert.equal(activity.participants[0]?.jobTitle, "");
  assert.equal(activity.participants[0]?.email, null);
  assert.equal(activity.participants[0]?.company, null);
  assert.equal(activity.participants[0]?.summaryConsentAt, null);
  assert.equal(activity.participants[1]?.jobTitle, longJobTitle);
});

test("participant activity rejects malformed host-only email without leaking it into speech events", async () => {
  const fetchFn: typeof fetch = async (input) => String(input).includes("/rpc/read_live_participant_roster")
    ? Response.json([{
        participant_id: "grant-1",
        display_name: "forged-label",
        email: "private@example.com",
        company: "Cushman",
        summary_consent_at: null,
        department: null,
        job_title: null,
        joined_at: "2026-07-23T00:00:00.000Z",
        last_seen_at: "2026-07-23T00:10:00.000Z",
        left_at: null,
        utterance_count: 0,
        speaking_seconds: 0,
        last_spoke_at: null,
      }])
    : Response.json([]);

  const activity = await buildParticipantActivity(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    "host-1",
    "en",
    fetchFn,
    {
      baseUrl: "https://dev-ref.supabase.co",
      credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    },
  );
  assert.deepEqual(activity.participants, []);
  assert.equal(JSON.stringify(activity).includes("private@example.com"), false);
});

test("participant roster reads only the bounded host roster without duplicating utterance reads", async () => {
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.signal instanceof AbortSignal, true);
    if (url.includes("/rpc/read_live_participant_roster")) {
      return Response.json([{
        participant_id: "grant-1",
        display_name: "n***@example.com",
        email: "noel@example.com",
        company: "Cushman",
        summary_consent_at: "2026-07-23T00:00:00.000Z",
        department: "Strategy",
        job_title: "Director",
        joined_at: "2026-07-23T00:00:00.000Z",
        last_seen_at: "2026-07-23T00:10:00.000Z",
        left_at: null,
        utterance_count: 2,
        speaking_seconds: 7,
        last_spoke_at: "2026-07-23T00:00:11.000Z",
      }]);
    }
    throw new Error(`Unexpected duplicate read: ${url}`);
  };

  const participants = await buildParticipantRoster(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    "host-1",
    fetchFn,
    {
      baseUrl: "https://dev-ref.supabase.co",
      credential: { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    },
    { signal: new AbortController().signal },
  );

  assert.equal(participants.length, 1);
  assert.equal(participants[0]?.displayName, "n***@example.com");
});
