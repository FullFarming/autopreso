import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSummaryPrompt,
  fetchUtterances,
  generateMeetingSummary,
  parseMeetingSummary,
  SummaryError,
  type MeetingUtterance,
} from "./summary";

async function withSupabaseTestEnvironment<T>(callback: () => Promise<T>): Promise<T> {
  const keys = [
    "LIVE_EXTERNAL_ENV",
    "LIVE_ALLOWED_SUPABASE_REF",
    "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "dev-ref",
    SUPABASE_URL: "https://dev-ref.supabase.co",
    NEXT_PUBLIC_SUPABASE_URL: "https://dev-ref.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnop",
  });
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function utteranceRow(seq: number) {
  return {
    seq,
    participant_id: `participant-${seq % 3}`,
    speaker_name: `Speaker ${seq % 3}`,
    speaker_label: `participant:participant-${seq % 3}`,
    text: `utterance ${seq}`,
    source_started_at: "2026-07-24T00:00:00.000Z",
    source_ended_at: "2026-07-24T00:00:01.000Z",
    emitted_at: "2026-07-24T00:00:01.100Z",
  };
}

const utterances: MeetingUtterance[] = [{
  seq: 1,
  participantId: "grant-1",
  speakerName: "Noel Kim",
  speakerLabel: "participant:grant-1",
  speakerDepartment: "Strategy",
  speakerJobTitle: "Director",
  text: "We approved the launch and Mina will prepare the rollout plan.",
  sourceStartedAt: "2026-07-23T00:00:00.000Z",
  sourceEndedAt: "2026-07-23T00:00:08.000Z",
  emittedAt: "2026-07-23T00:00:08.100Z",
}];

const structuredSummary = {
  title: "Launch decision",
  overview: "The team approved the launch.",
  chapters: [{ title: "Decision", summary: "The launch was approved." }],
  decisions: ["Proceed with the launch."],
  actionItems: [{ description: "Mina prepares the rollout plan.", owner: "Mina", due: "미정" }],
  speakerHighlights: [{ speaker: "Noel Kim", highlight: "Confirmed the decision." }],
  participationStats: [{
    speaker: "Noel Kim",
    department: "Strategy",
    jobTitle: "Director",
    utteranceCount: 1,
    speakingSeconds: 8,
  }],
};

test("meeting summary parser preserves participant statistics", () => {
  assert.deepEqual(parseMeetingSummary(structuredSummary), structuredSummary);
});

test("action items default missing owner and due to 미정 and accept legacy strings", () => {
  const parsed = parseMeetingSummary({
    ...structuredSummary,
    actionItems: [
      { description: "Prepare the deck", owner: "", due: "" },
      { description: "Send the recap", owner: "Noel", due: "2026-07-30" },
      "Legacy stored follow-up",
      { description: "   " },
    ],
  });
  assert.deepEqual(parsed.actionItems, [
    { description: "Prepare the deck", owner: "미정", due: "미정" },
    { description: "Send the recap", owner: "Noel", due: "2026-07-30" },
    { description: "Legacy stored follow-up", owner: "미정", due: "미정" },
  ]);
});

test("summary prompt carries participant identity without asking the model to invent facts", () => {
  const prompt = buildSummaryPrompt(utterances, "en");
  assert.match(prompt, /Noel Kim · Strategy · Director/u);
  assert.match(prompt, /Do not invent facts/u);
  assert.match(prompt, /Return empty arrays/u);
  assert.match(prompt, /미정/u);
});

test("Responses API uses strict Structured Outputs and parses output_text", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(structuredSummary) }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const generated = await generateMeetingSummary(
    utterances,
    "en",
    fetchFn,
    { apiKey: "sk-test", model: "gpt-5.6-luna" },
  );

  assert.deepEqual(generated.summary, structuredSummary);
  assert.equal(generated.model, "gpt-5.6-luna");
  assert.equal(requests[0]?.url, "https://api.openai.com/v1/responses");
  const request = requests[0];
  assert.ok(request);
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer sk-test");
  const body: unknown = JSON.parse(String(request.init.body));
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
  const record = body as Record<string, unknown>;
  assert.equal(record.store, false);
  assert.deepEqual(record.reasoning, { effort: "none" });
  const text = record.text as { format?: Record<string, unknown> };
  assert.equal(text.format?.type, "json_schema");
  assert.equal(text.format?.strict, true);
  const schema = text.format?.schema as { required?: string[]; additionalProperties?: boolean };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "title",
    "overview",
    "chapters",
    "decisions",
    "actionItems",
    "speakerHighlights",
    "participationStats",
  ]);
  const properties = (text.format?.schema as { properties?: Record<string, unknown> }).properties;
  const actionItems = properties?.actionItems as { items?: { required?: string[]; additionalProperties?: boolean } };
  assert.deepEqual(actionItems.items?.required, ["description", "owner", "due"]);
  assert.equal(actionItems.items?.additionalProperties, false);
});

test("Responses API refusals are surfaced without attempting JSON parsing", async () => {
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
    status: "completed",
    output: [{
      type: "message",
      content: [{ type: "refusal", refusal: "Unable to summarize." }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  await assert.rejects(
    generateMeetingSummary(utterances, "en", fetchFn, { apiKey: "sk-test", model: "gpt-5.6-luna" }),
    (error: unknown) => error instanceof SummaryError && error.code === "SUMMARY_REFUSED",
  );
});

test("utterance retrieval keyset-pages beyond the former 5,000 row limit without gaps", async () => {
  const requests: URL[] = [];
  const rows = Array.from({ length: 5_001 }, (_, index) => utteranceRow(index + 1));
  const fetchFn: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const afterSeq = Number(url.searchParams.get("seq")?.replace("gt.", "") ?? 0);
    const limit = Number(url.searchParams.get("limit"));
    return Response.json(rows.filter((row) => row.seq > afterSeq).slice(0, limit));
  };

  const result = await withSupabaseTestEnvironment(
    () => fetchUtterances("session-1", "ko", fetchFn),
  );

  assert.equal(result.length, 5_001);
  assert.deepEqual([result[0]?.seq, result.at(-1)?.seq], [1, 5_001]);
  assert.equal(requests.length, 6);
  assert.match(requests[0]?.searchParams.get("select") ?? "", /participant_id/u);
  assert.match(requests[0]?.searchParams.get("select") ?? "", /source_text,source_language,origin,utterance_key,translation_status/u);
  assert.deepEqual(
    requests.map((url) => [url.searchParams.get("limit"), url.searchParams.get("seq")]),
    [
      ["1000", null],
      ["1000", "gt.1000"],
      ["1000", "gt.2000"],
      ["1000", "gt.3000"],
      ["1000", "gt.4000"],
      ["1000", "gt.5000"],
    ],
  );
});

test("utterance retrieval preserves optional replay provenance", async () => {
  const row = {
    ...utteranceRow(1),
    source_text: "original",
    source_language: "en",
    origin: null,
    utterance_key: "session-1:input:1",
    translation_status: "translated",
  };
  const result = await withSupabaseTestEnvironment(
    () => fetchUtterances("session-1", "ko", async () => Response.json([row])),
  );
  assert.deepEqual({
    participantId: result[0]?.participantId,
    sourceText: result[0]?.sourceText,
    sourceLanguage: result[0]?.sourceLanguage,
    origin: result[0]?.origin,
    utteranceKey: result[0]?.utteranceKey,
    translationStatus: result[0]?.translationStatus,
  }, {
    participantId: "participant-1",
    sourceText: "original",
    sourceLanguage: "en",
    origin: null,
    utteranceKey: "session-1:input:1",
    translationStatus: "translated",
  });
});

test("utterance retrieval excludes failed translation rows from minutes and summaries", async () => {
  const rows = [
    { ...utteranceRow(1), translation_status: "failed" },
    { ...utteranceRow(2), translation_status: "translated" },
  ];
  const result = await withSupabaseTestEnvironment(
    () => fetchUtterances("session-1", "ko", async () => Response.json(rows)),
  );
  assert.deepEqual(result.map((utterance) => utterance.seq), [2]);
});

test("utterance pagination fails closed on a later page error without retrying", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(Array.from({ length: 1_000 }, (_, index) => utteranceRow(index + 1)));
    }
    return new Response("", { status: 503 });
  };

  await withSupabaseTestEnvironment(async () => {
    await assert.rejects(
      fetchUtterances("session-1", "ko", fetchFn),
      (error: unknown) => error instanceof SummaryError && error.code === "UTTERANCES_READ_FAILED",
    );
  });
  assert.equal(calls, 2, "a failed page must not be retried automatically");
});
