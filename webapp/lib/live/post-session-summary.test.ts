import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateSessionSummariesAfterEnd, generateSummaryForLanguage } from "./post-session-summary";
import { readLiveModelPreferences } from "./model-preferences";
import { SummaryError, type MeetingSummary } from "./summary";

// Session engine as the store returns it (Plan 2 Task 4): the summary role names the recap model.
const sessionEngine = (summary = "gemini-3.6-flash") => readLiveModelPreferences({
  engine: { stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.6-flash" }, summary: { provider: "gemini", model: summary } },
});

const storedSummary = {
  title: "Ready",
  overview: "Already generated.",
  chapters: [],
  decisions: [],
  actionItems: [],
  speakerHighlights: [],
  participationStats: [],
};

const sessionId = "11111111-1111-4111-8111-111111111111";
const topicSnapshot = {
  topics: [{
    id: "22222222-2222-4222-8222-222222222222",
    sessionId,
    ordinal: 1,
    title: "Agenda",
    summary: "",
    status: "completed" as const,
    completionReason: "session_end" as const,
    detectorHealth: "healthy" as const,
    startedAt: "2026-07-28T00:00:00.000Z",
    completedAt: "2026-07-28T00:01:00.000Z",
    version: 1,
  }],
  topicMemberships: [{
    sessionId,
    topicId: "22222222-2222-4222-8222-222222222222",
    utteranceKey: "utt-1",
    position: 1,
  }],
};

const testUtterance = {
  seq: 1,
  participantId: null,
  speakerName: "Speaker",
  speakerLabel: null,
  speakerDepartment: null,
  speakerJobTitle: null,
  text: "Agenda",
  utteranceKey: "utt-1",
  sourceStartedAt: null,
  sourceEndedAt: "2026-07-28T00:00:01.000Z",
  emittedAt: "2026-07-28T00:00:01.000Z",
};

test("ready and non-reclaimable claims never invoke Gemini generation", async () => {
  for (const status of ["ready", "running", "exhausted", "permanent_failed"] as const) {
    let generationCalls = 0;
    const outcome = await generateSummaryForLanguage("session-1", "host-1", "ko", {
      claim: async () => ({ status }),
      read: async () => status === "ready" ? { summary: storedSummary, model: "gemini-3.6-flash", createdAt: "now" } : null,
      generate: async () => {
        generationCalls += 1;
        throw new Error("Gemini must not run");
      },
    });
    assert.equal(outcome.status, status === "ready" || status === "running" ? status : "failed");
    assert.equal(generationCalls, 0);
  }
});

test("one transient provider failure is recorded without hidden retry", async () => {
  let claimCalls = 0;
  let generationCalls = 0;
  let completeCalls = 0;
  let failCalls = 0;
  await assert.rejects(
    generateSummaryForLanguage(sessionId, "host-1", "ko", {
      claim: async () => {
        claimCalls += 1;
        return { status: "claimed", generationToken: "token-1" };
      },
      fetchUtterances: async () => [testUtterance],
      fetchTopicTranscript: async () => topicSnapshot,
      fetchSessionContext: async () => ({ title: "Pinned", companyName: null, ticker: null, fiscalPeriod: null, eventType: null, agenda: [], modelPreferences: sessionEngine() }),
    buildRoster: async () => [],
      generate: async () => {
        generationCalls += 1;
        throw new SummaryError("temporary", "SUMMARY_PROVIDER_UNAVAILABLE", 502);
      },
      complete: async (_sessionId, _language, generationToken) => {
        assert.equal(generationToken, "token-1");
        completeCalls += 1;
        return true;
      },
      fail: async (_sessionId, _language, generationToken, errorCode) => {
        assert.equal(generationToken, "token-1");
        assert.equal(errorCode, "SUMMARY_PROVIDER_UNAVAILABLE");
        failCalls += 1;
        return true;
      },
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "SUMMARY_PROVIDER_UNAVAILABLE",
  );
  assert.equal(claimCalls, 1);
  assert.equal(generationCalls, 1);
  assert.equal(completeCalls, 0);
  assert.equal(failCalls, 1);
});

test("non-transient provider failure is recorded without retry", async () => {
  let generationCalls = 0;
  let failedCode = "";
  await assert.rejects(
    generateSummaryForLanguage("session-1", "host-1", "ko", {
      claim: async () => ({ status: "claimed", generationToken: "token-1" }),
      fetchUtterances: async () => [testUtterance],
      fetchTopicTranscript: async () => topicSnapshot,
      fetchSessionContext: async () => ({ title: "Pinned", companyName: null, ticker: null, fiscalPeriod: null, eventType: null, agenda: [], modelPreferences: sessionEngine() }),
    buildRoster: async () => [],
      generate: async () => {
        generationCalls += 1;
        throw new SummaryError("invalid", "SUMMARY_PARSE_FAILED", 502);
      },
      fail: async (_sessionId, _language, _generationToken, errorCode) => {
        failedCode = errorCode;
        return true;
      },
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "SUMMARY_PARSE_FAILED",
  );
  assert.equal(generationCalls, 1);
  assert.equal(failedCode, "SUMMARY_PARSE_FAILED");
});

test("successful generation uses authoritative topic transcript and session fence", async () => {
  let generationCalls = 0;
  let completedModel = "";
  const outcome = await generateSummaryForLanguage(sessionId, "host-1", "ko", {
    claim: async () => ({ status: "claimed", generationToken: "token-1" }),
    fetchUtterances: async () => [testUtterance],
    fetchTopicTranscript: async () => topicSnapshot,
    fetchSessionContext: async () => ({ title: "Pinned", companyName: null, ticker: null, fiscalPeriod: null, eventType: null, agenda: [], modelPreferences: sessionEngine() }),
    buildRoster: async () => [],
    generate: async (input) => {
      generationCalls += 1;
      assert.equal(input.sessionId, sessionId);
      assert.equal(input.topicSnapshot, topicSnapshot);
      assert.equal(input.utterances[0]?.utteranceKey, "utt-1");
      return { summary: storedSummary, model: "gemini-3.6-flash" };
    },
    complete: async (_sessionId, _language, _generationToken, _summary, model) => {
      completedModel = model;
      return true;
    },
  });
  assert.equal(outcome.status, "saved");
  assert.equal(generationCalls, 1);
  assert.equal(completedModel, "gemini-3.6-flash");
});

test("post-session summaries run languages with bounded concurrency exactly once", async () => {
  const calls: string[] = [];
  let active = 0;
  let peakActive = 0;
  let releaseFirstPair: (() => void) | undefined;
  const firstPairStarted = new Promise<void>((resolve) => { releaseFirstPair = resolve; });
  const result = await generateSessionSummariesAfterEnd("session-1", "host-1", ["ko", "en", "ja"], {
    log: () => {},
    generateForLanguage: async (_sessionId, _hostId, language) => {
      calls.push(language);
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (active === 2) releaseFirstPair?.();
      await firstPairStarted;
      active -= 1;
      if (language === "ko") return {
        status: "saved" as const,
        summary: storedSummary,
        model: "gemini-3.6-flash",
        utteranceCount: 1,
      };
      if (language === "en") return { status: "running" as const };
      throw new Error("failed once");
    },
  });
  assert.deepEqual(result.saved, ["ko"]);
  assert.deepEqual(result.running, ["en"]);
  assert.deepEqual(result.failed, ["ja"]);
  assert.deepEqual(calls.sort(), ["en", "ja", "ko"]);
  assert.equal(peakActive, 2);
});

test("post-session summaries share one bounded topic context read across languages", async () => {
  const claims: string[] = [];
  const topicReads: string[] = [];
  const generations: string[] = [];
  const result = await generateSessionSummariesAfterEnd(sessionId, "host-1", ["ko", "en", "ja"], {
    log: () => {},
    languageDependencies: {
      claim: async (_sessionId, language) => {
        claims.push(language);
        return { status: "claimed", generationToken: `token-${language}` };
      },
      fetchUtterances: async (_sessionId, language) => [{ ...testUtterance, text: `Agenda ${language}` }],
      fetchTopicTranscript: async (_sessionId, language) => {
        topicReads.push(language);
        return topicSnapshot;
      },
      fetchSessionContext: async () => ({ title: "Pinned", companyName: null, ticker: null, fiscalPeriod: null, eventType: null, agenda: [], modelPreferences: sessionEngine() }),
    buildRoster: async () => [],
      generate: async (input, language) => {
        generations.push(`${language}:${input.topicSnapshot === topicSnapshot}`);
        return { summary: storedSummary, model: "gemini-3.6-flash" };
      },
      complete: async () => true,
    },
  });

  assert.deepEqual(result.saved.sort(), ["en", "ja", "ko"]);
  assert.deepEqual(claims.sort(), ["en", "ja", "ko"]);
  assert.deepEqual(topicReads, ["ko"]);
  assert.deepEqual(generations.sort(), ["en:true", "ja:true", "ko:true"]);
});

test("post-session hung summary reads fail before provider dispatch or completion", async () => {
  let signalSeen = false;
  let generateCalls = 0;
  let completeCalls = 0;
  let failedCode = "";
  await assert.rejects(
    generateSummaryForLanguage(sessionId, "host-1", "ko", {
      claim: async () => ({ status: "claimed", generationToken: "token-1" }),
      readTimeoutMilliseconds: 1,
      fetchUtterances: async (_sessionId, _language, options) => new Promise((resolve) => {
        signalSeen = options?.signal instanceof AbortSignal;
        options?.signal?.addEventListener("abort", () => resolve([testUtterance]), { once: true });
      }),
      fetchTopicTranscript: async (_sessionId, _language, options) => new Promise((resolve) => {
        signalSeen = signalSeen && options?.signal instanceof AbortSignal;
        options?.signal?.addEventListener("abort", () => resolve(topicSnapshot), { once: true });
      }),
      fetchSessionContext: async () => ({ title: "Pinned", companyName: null, ticker: null, fiscalPeriod: null, eventType: null, agenda: [], modelPreferences: sessionEngine() }),
    buildRoster: async (_sessionId, _hostId, options) => new Promise((resolve) => {
        signalSeen = signalSeen && options?.signal instanceof AbortSignal;
        options?.signal?.addEventListener("abort", () => resolve([]), { once: true });
      }),
      generate: async () => {
        generateCalls += 1;
        return { summary: storedSummary, model: "gemini-3.6-flash" };
      },
      complete: async () => {
        completeCalls += 1;
        return true;
      },
      fail: async (_sessionId, _language, _generationToken, errorCode) => {
        failedCode = errorCode;
        return true;
      },
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "SUMMARY_READ_FAILED",
  );
  assert.equal(signalSeen, true);
  assert.equal(generateCalls, 0);
  assert.equal(completeCalls, 0);
  assert.equal(failedCode, "SUMMARY_READ_FAILED");
});

test("session end route attaches summary lifecycle with Next after instead of a detached promise", async () => {
  const source = await readFile(new URL("../../app/api/live-sessions/[id]/route.ts", import.meta.url), "utf8");
  assert.match(source, /import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*["']next\/server["']/u);
  assert.match(source, /after\(async\s*\(\)\s*=>/u);
  assert.doesNotMatch(source, /void\s+generateSessionSummariesAfterEnd/u);
  assert.equal(source.includes("summary scheduling failed (${id})"), false);
  assert.doesNotMatch(source, /console\.error\([^;]*,\s*summaryError/u);
  assert.match(source, /console\.error\(`live post-session summary scheduling failed \$\{safeSummarySchedulingCode\(summaryError\)\}`\)/u);
});

test("missing Gemini server configuration is recorded explicitly with no provider request or retry", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  let requests = 0;
  const failures: string[] = [];
  delete process.env.GEMINI_API_KEY;
  globalThis.fetch = async () => { requests++; throw new Error("must not call a provider"); };
  try {
    await assert.rejects(generateSummaryForLanguage(sessionId, "host-1", "ko", {
      claim: async () => ({ status: "claimed", generationToken: "token-1" }),
      fetchUtterances: async () => [testUtterance],
      fetchTopicTranscript: async () => topicSnapshot,
      fetchSessionContext: async () => ({ title: "Owned meeting", companyName: null, ticker: null, fiscalPeriod: null, eventType: null, agenda: [] }),
      buildRoster: async () => [],
      fail: async (_session, _language, _token, code) => { failures.push(code); return true; },
    }), (error: unknown) => error instanceof SummaryError && error.code === "SUMMARY_NOT_CONFIGURED" && error.status === 503);
    assert.deepEqual(failures, ["SUMMARY_NOT_CONFIGURED"]);
    assert.equal(requests, 0);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});

test("ended canonical source flows through real recap parsing, persists Gemini 3.6 and refresh reads without generation", async () => {
  const { generateMeetingSummary } = await import("./summary");
  const { createGeminiSummaryGenerator } = await import("./summary-gemini-adapter");
  let calls = 0;
  const config = { apiKey: ["synthetic", "ended", "source"].join("-"), model: "gemini-3.6-flash", maxOutputTokens: 2048, timeoutMilliseconds: 1000 };
  const generator = createGeminiSummaryGenerator(config, { fetchFn: async (url, init) => {
    calls += 1;
    assert.match(String(url), /gemini-3\.6-flash:generateContent$/u);
    const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
    assert.match(body.contents[0].parts[0].text, /실제로 확정된 원문/u);
    assert.doesNotMatch(body.contents[0].parts[0].text, /FAKE_TRANSLATION|Topic note/u);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
      title: "회의", overview: "실제로 확정된 원문", chapters: [], decisions: [], actionItems: [], speakerHighlights: [],
    }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } });
  } });
  let ready: { summary: MeetingSummary; model: string; createdAt: string } | null = null;
  const dependencies = {
    claim: async () => ready ? { status: "ready" as const } : { status: "claimed" as const, generationToken: "source-token" },
    fetchUtterances: async () => [{ ...testUtterance, utteranceKey: "authoritative-source:1", text: "실제로 확정된 원문" }],
    fetchTopicTranscript: async () => ({ topics: [], topicMemberships: [] }), buildRoster: async () => [],
    fetchSessionContext: async () => ({ title: "Meeting", companyName: null, ticker: null, fiscalPeriod: null, eventType: null, agenda: [],
      modelPreferences: sessionEngine("gemini-3.6-flash") }),
    generate: (input: Parameters<typeof generateMeetingSummary>[0], language: string) => generateMeetingSummary(input, language, generator, config),
    complete: async (_id: string, _language: string, token: string, summary: MeetingSummary, model: string) => {
      assert.equal(token, "source-token"); assert.equal(model, "gemini-3.6-flash");
      ready = { summary, model, createdAt: "2026-09-01T00:00:00Z" }; return true;
    },
    read: async () => ready,
    fail: async () => { throw new Error("unexpected summary failure"); },
  };
  assert.equal((await generateSummaryForLanguage(sessionId, "host-1", "ko", dependencies)).status, "saved");
  const reloaded = await generateSummaryForLanguage(sessionId, "host-1", "ko", dependencies);
  assert.equal(reloaded.status, "ready");
  assert.equal(calls, 1);
});

test("a session with no recorded speech ends as an empty record, never as a generation failure", async () => {
  let generationCalls = 0;
  const failures: string[] = [];
  const outcome = await generateSummaryForLanguage(sessionId, "host-1", "ko", {
    claim: async () => ({ status: "claimed", generationToken: "token-1" }),
    fetchUtterances: async () => [],
    fetchTopicTranscript: async () => topicSnapshot,
    fetchSessionContext: async () => ({ title: "Silent", companyName: null, ticker: null, fiscalPeriod: null, eventType: null, agenda: [] }),
    buildRoster: async () => [],
    generate: async () => { generationCalls += 1; throw new Error("Gemini must not run"); },
    fail: async (_session, _language, _token, code) => { failures.push(code); return true; },
  });
  assert.equal(outcome.status, "empty");
  assert.equal(generationCalls, 0);
  // The DB contract is unchanged: the job is still recorded as NO_UTTERANCES.
  assert.deepEqual(failures, ["NO_UTTERANCES"]);

  const summaries = await generateSessionSummariesAfterEnd(sessionId, "host-1", ["ko", "en"], {
    generateForLanguage: async () => ({ status: "empty" as const }),
  });
  assert.deepEqual(summaries, { saved: [], ready: [], running: [], empty: ["ko", "en"], failed: [] });
});

test("the summary API presents an empty record as an empty state and keeps generic failures recoverable", async () => {
  const source = await readFile(new URL("../../app/api/live-sessions/[id]/summary/route.ts", import.meta.url), "utf8");
  assert.match(source, /generation\.status === "empty"[\s\S]{0,200}"SUMMARY_NO_UTTERANCES", 404/u);
  assert.match(source, /기록된 발언이 없어 요약을 만들 수 없습니다\./u);
  assert.match(source, /"SUMMARY_NO_UTTERANCES", 404/u);
  // A host-authenticated reset is the only way to clear a dead job, and it
  // stays behind the existing per-host-session rate limit.
  const post = source.slice(source.indexOf("export async function POST"), source.indexOf("export async function GET"));
  assert.match(post, /resetMeetingSummaryGeneration\(sessionId, language, hostId\)/u);
  assert.ok(post.indexOf("enforceSummaryGenerationRateLimit") < post.indexOf("resetMeetingSummaryGeneration"),
    "the reset must never run before the summary generation rate limit");
  assert.ok(post.indexOf("resetMeetingSummaryGeneration") < post.indexOf("claimMeetingSummaryGeneration(sessionId, language)"),
    "a reset only makes the job claimable; the claim still decides what happens");
  assert.ok(post.indexOf("assertHostSessionOwnership") < post.indexOf("resetMeetingSummaryGeneration"),
    "only the verified owning host may reset a job");
  assert.match(source, /const shouldReset = [\s\S]{0,200}reset === true/u,
    "only an explicit boolean true may reset a job");
  const migration = await readFile(new URL("../../../supabase/migrations/202609020001_live_summary_generic_failure_retry.sql", import.meta.url), "utf8");
  assert.match(migration, /'SUMMARY_FAILED',\s*\n\s*'SUMMARY_READY_MISSING',\s*\n\s*'SUMMARY_COMPLETE_FAILED'/u);
});
