import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateSessionSummariesAfterEnd, generateSummaryForLanguage } from "./post-session-summary";
import { SummaryError } from "./summary";

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
      read: async () => status === "ready" ? { summary: storedSummary, model: "gemini-3.7-flash", createdAt: "now" } : null,
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
    buildRoster: async () => [],
    generate: async (input) => {
      generationCalls += 1;
      assert.equal(input.sessionId, sessionId);
      assert.equal(input.topicSnapshot, topicSnapshot);
      assert.equal(input.utterances[0]?.utteranceKey, "utt-1");
      return { summary: storedSummary, model: "gemini-3.7-flash" };
    },
    complete: async (_sessionId, _language, _generationToken, _summary, model) => {
      completedModel = model;
      return true;
    },
  });
  assert.equal(outcome.status, "saved");
  assert.equal(generationCalls, 1);
  assert.equal(completedModel, "gemini-3.7-flash");
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
        model: "gemini-3.7-flash",
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
      buildRoster: async () => [],
      generate: async (input, language) => {
        generations.push(`${language}:${input.topicSnapshot === topicSnapshot}`);
        return { summary: storedSummary, model: "gemini-3.7-flash" };
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
      buildRoster: async (_sessionId, _hostId, options) => new Promise((resolve) => {
        signalSeen = signalSeen && options?.signal instanceof AbortSignal;
        options?.signal?.addEventListener("abort", () => resolve([]), { once: true });
      }),
      generate: async () => {
        generateCalls += 1;
        return { summary: storedSummary, model: "gemini-3.7-flash" };
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
