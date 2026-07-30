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

test("ready and non-reclaimable claims never invoke OpenAI generation", async () => {
  for (const status of ["ready", "running", "exhausted", "permanent_failed"] as const) {
    let generationCalls = 0;
    const outcome = await generateSummaryForLanguage("session-1", "host-1", "ko", {
      claim: async () => ({ status }),
      read: async () => status === "ready" ? { summary: storedSummary, model: "gpt-5.6-luna", createdAt: "now" } : null,
      generate: async () => {
        generationCalls += 1;
        throw new Error("OpenAI must not run");
      },
    });
    assert.equal(outcome.status, status === "ready" || status === "running" ? status : "failed");
    assert.equal(generationCalls, 0);
  }
});

test("one transient provider failure retries inside the same generation claim", async () => {
  let claimCalls = 0;
  let generationCalls = 0;
  let completeCalls = 0;
  let failCalls = 0;
  const outcome = await generateSummaryForLanguage("session-1", "host-1", "ko", {
    claim: async () => {
      claimCalls += 1;
      return { status: "claimed", generationToken: "token-1" };
    },
    fetchUtterances: async () => [{
      seq: 1,
      participantId: null,
      speakerName: "Speaker",
      speakerLabel: null,
      speakerDepartment: null,
      speakerJobTitle: null,
      text: "Agenda",
      sourceStartedAt: null,
      sourceEndedAt: "2026-07-28T00:00:01.000Z",
      emittedAt: "2026-07-28T00:00:01.000Z",
    }],
    buildActivity: async () => ({ participants: [], recentSpeeches: [] }),
    generate: async () => {
      generationCalls += 1;
      if (generationCalls === 1) {
        throw new SummaryError("temporary", "SUMMARY_PROVIDER_UNAVAILABLE", 502);
      }
      return { summary: storedSummary, model: "gpt-5.6-luna" };
    },
    complete: async (_sessionId, _language, generationToken) => {
      assert.equal(generationToken, "token-1");
      completeCalls += 1;
      return true;
    },
    fail: async () => {
      failCalls += 1;
      return true;
    },
    sleep: async () => {},
  });
  assert.equal(outcome.status, "saved");
  assert.equal(claimCalls, 1);
  assert.equal(generationCalls, 2);
  assert.equal(completeCalls, 1);
  assert.equal(failCalls, 0);
});

test("non-transient provider failure is recorded without retry", async () => {
  let generationCalls = 0;
  let failedCode = "";
  await assert.rejects(
    generateSummaryForLanguage("session-1", "host-1", "ko", {
      claim: async () => ({ status: "claimed", generationToken: "token-1" }),
      fetchUtterances: async () => [{
        seq: 1,
        participantId: null,
        speakerName: "Speaker",
        speakerLabel: null,
        speakerDepartment: null,
        speakerJobTitle: null,
        text: "Agenda",
        sourceStartedAt: null,
        sourceEndedAt: "2026-07-28T00:00:01.000Z",
        emittedAt: "2026-07-28T00:00:01.000Z",
      }],
      buildActivity: async () => ({ participants: [], recentSpeeches: [] }),
      generate: async () => {
        generationCalls += 1;
        throw new SummaryError("invalid", "SUMMARY_PARSE_FAILED", 502);
      },
      fail: async (_sessionId, _language, _generationToken, errorCode) => {
        failedCode = errorCode;
        return true;
      },
      sleep: async () => {},
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "SUMMARY_PARSE_FAILED",
  );
  assert.equal(generationCalls, 1);
  assert.equal(failedCode, "SUMMARY_PARSE_FAILED");
});

test("a persistent transient provider failure retries once then records failure", async () => {
  let generationCalls = 0;
  let failCalls = 0;
  await assert.rejects(
    generateSummaryForLanguage("session-1", "host-1", "ko", {
      claim: async () => ({ status: "claimed", generationToken: "token-1" }),
      fetchUtterances: async () => [{
        seq: 1,
        participantId: null,
        speakerName: "Speaker",
        speakerLabel: null,
        speakerDepartment: null,
        speakerJobTitle: null,
        text: "Agenda",
        sourceStartedAt: null,
        sourceEndedAt: "2026-07-28T00:00:01.000Z",
        emittedAt: "2026-07-28T00:00:01.000Z",
      }],
      buildActivity: async () => ({ participants: [], recentSpeeches: [] }),
      generate: async () => {
        generationCalls += 1;
        throw new SummaryError("timeout", "SUMMARY_TIMEOUT", 504);
      },
      fail: async (_sessionId, _language, generationToken, errorCode) => {
        assert.equal(generationToken, "token-1");
        assert.equal(errorCode, "SUMMARY_TIMEOUT");
        failCalls += 1;
        return true;
      },
      sleep: async () => {},
    }),
    (error: unknown) => error instanceof SummaryError && error.code === "SUMMARY_TIMEOUT",
  );
  assert.equal(generationCalls, 2);
  assert.equal(failCalls, 1);
});

test("post-session summaries run languages concurrently exactly once", async () => {
  const calls: string[] = [];
  let active = 0;
  let peakActive = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const result = await generateSessionSummariesAfterEnd("session-1", "host-1", ["ko", "en", "ja"], {
    log: () => {},
    generateForLanguage: async (_sessionId, _hostId, language) => {
      calls.push(language);
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (calls.length === 3) release?.();
      await barrier;
      active -= 1;
      if (language === "ko") return {
        status: "saved" as const,
        summary: storedSummary,
        model: "gpt-5.6-luna",
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
  assert.equal(peakActive, 3);
});

test("session end route attaches summary lifecycle with Next after instead of a detached promise", async () => {
  const source = await readFile(new URL("../../app/api/live-sessions/[id]/route.ts", import.meta.url), "utf8");
  assert.match(source, /import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*["']next\/server["']/u);
  assert.match(source, /after\(async\s*\(\)\s*=>/u);
  assert.doesNotMatch(source, /void\s+generateSessionSummariesAfterEnd/u);
});
