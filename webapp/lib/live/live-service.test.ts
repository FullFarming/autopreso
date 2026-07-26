import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LiveSecurityConfigurationError } from "../security/config";
import { LiveSessionService } from "./service";
import { getLiveStoreConfig } from "./config";
import { toLiveFailure } from "./errors";
import { MemoryLiveSessionStore, SupabaseLiveSessionStore } from "./store";
import { parseLanguages, parseScheduledAt, parseSessionId, parseTitle } from "./validation";

test("session ids reject malformed external path input", () => {
  assert.equal(parseSessionId("0192d0f4-9f72-7a36-91f5-6a76ef736f41"), "0192d0f4-9f72-7a36-91f5-6a76ef736f41");
  assert.throws(() => parseSessionId("not-a-uuid"), /올바르지/);
});

test("service language parsing canonicalizes ingress aliases and rejects canonical duplicates", () => {
  assert.deepEqual(parseLanguages(["en-US", "ko-KR", "zh-CN"]), ["en", "ko", "zh-Hans"]);
  assert.throws(() => parseLanguages(["en-US", "en"]), /올바르지/u);
  assert.throws(() => parseLanguages(["th"]), /올바르지/u);
  assert.throws(() => parseLanguages(["en", "ko", "ja", "fr"]), /1개 이상 3개 이하/u);
});

test("session metadata normalizes safe titles and ISO schedules", () => {
  assert.equal(parseTitle("  Global   Earnings Call  "), "Global Earnings Call");
  assert.equal(parseTitle("회의"), "회의");
  assert.throws(() => parseTitle("<script>"), /120자/u);
  assert.equal(parseScheduledAt("2026-07-24T09:00:00+09:00"), "2026-07-24T00:00:00.000Z");
  assert.throws(() => parseScheduledAt("2026-07-24 09:00"), /올바르지/u);
});

test("session create validates one to three languages and expires after six hours", async () => {
  const now = Date.UTC(2026, 6, 19);
  const service = new LiveSessionService(new MemoryLiveSessionStore(() => now), () => now);
  const session = await service.create("host-1", { sessionType: "presentation", languages: ["en-US", "ko-KR"] });
  assert.deepEqual(session.languages, ["en", "ko"]);
  assert.equal(session.version, 1);
  assert.equal(session.outputMode, "captions");
  assert.equal(session.voiceProvider, "gemini");
  assert.equal(session.maxViewers, 50);
  assert.equal(session.glossaryPack, "general_cre");
  assert.equal(session.viewerCount, 0);
  assert.equal(session.title, "Live Session");
  assert.equal(session.scheduledAt, null);
  assert.equal(session.expiresAt, new Date(now + 6 * 60 * 60 * 1_000).toISOString());
  await assert.rejects(() => service.create("host-1", { sessionType: "meeting", languages: [] }), /1개 이상/);
});

test("scheduled session expires six hours after schedule and rejects more than 30 days ahead", async () => {
  const now = Date.UTC(2026, 6, 23);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const scheduledAt = new Date(now + 7 * 24 * 60 * 60 * 1_000).toISOString();
  const session = await service.create("host-1", {
    title: "Investor Briefing",
    scheduledAt,
    sessionType: "meeting",
    languages: ["ko", "en"],
  });
  assert.equal(session.title, "Investor Briefing");
  assert.equal(session.scheduledAt, scheduledAt);
  assert.equal(session.expiresAt, new Date(Date.parse(scheduledAt) + 6 * 60 * 60 * 1_000).toISOString());
  await assert.rejects(
    service.create("host-1", {
      title: "Too far",
      scheduledAt: new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString(),
      sessionType: "meeting",
      languages: ["ko"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SCHEDULE_TOO_FAR",
  );
});

test("OpenAI voice is presentation-only and remains independent from Gemini captions", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const presentation = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "captions_audio",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  assert.equal(presentation.voiceProvider, "openai");
  await assert.rejects(
    service.create("host-1", {
      sessionType: "meeting",
      outputMode: "captions_audio",
      voiceProvider: "openai",
      languages: ["ko"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OPENAI_VOICE_OUTPUT_ONLY",
  );
  await assert.rejects(
    service.create("host-1", {
      sessionType: "presentation",
      outputMode: "audio",
      voiceProvider: "openai",
      languages: ["th"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_LANGUAGES",
  );
  await assert.rejects(
    service.create("host-1", {
      sessionType: "presentation",
      outputMode: "captions",
      voiceProvider: "openai",
      languages: ["ko"],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OPENAI_VOICE_OUTPUT_ONLY",
  );
});

test("changing an OpenAI presentation to meeting resets voice output provider to Gemini", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "audio",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  const updated = await service.update("host-1", created.id, { version: 1, sessionType: "meeting" });
  assert.equal(updated.voiceProvider, "gemini");
  const second = await service.create("host-1", {
    sessionType: "presentation",
    outputMode: "audio",
    voiceProvider: "openai",
    languages: ["ko"],
  });
  const captionsOnly = await service.update("host-1", second.id, { version: 1, outputMode: "captions" });
  assert.equal(captionsOnly.voiceProvider, "gemini");
});

test("session update uses optimistic versioning and preserves host ownership", async () => {
  const now = Date.UTC(2026, 6, 19);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", { sessionType: "presentation", languages: ["en"] });
  const updated = await service.update("host-1", created.id, { version: 1, sessionType: "meeting", languages: ["ko"] });
  assert.equal(updated.version, 2);
  assert.equal(updated.outputMode, "captions");
  await assert.rejects(() => service.update("host-1", created.id, { version: 1, languages: ["ja"] }), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "VERSION_CONFLICT";
  });
  await assert.rejects(() => service.update("other-host", created.id, { version: 2, languages: ["ja"] }), /찾을 수 없습니다/);
});

test("host start uses one guarded preparing-to-live transition", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", {
    title: "Live Translation",
    sessionType: "meeting",
    languages: ["ko", "en"],
  });
  const started = await service.start("host-1", created.id, created.version);
  assert.equal(started.status, "live");
  assert.equal(started.version, created.version + 1);
  assert.deepEqual(await service.start("host-1", created.id, created.version), started);
  await assert.rejects(
    service.start("other-host", created.id, started.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
});

test("session languages always include both ko and en caption lanes", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const koOnly = await service.create("host-1", { sessionType: "meeting", languages: ["ko"] });
  assert.deepEqual(koOnly.languages, ["ko", "en"]);
  const jaOnly = await service.create("host-1", { sessionType: "meeting", languages: ["ja"] });
  assert.deepEqual(jaOnly.languages, ["ja", "ko", "en"]);
  // The union never exceeds the 3-language cap: extras beyond capacity drop.
  const crowded = await service.create("host-1", { sessionType: "meeting", languages: ["ja", "fr", "ko"] });
  assert.deepEqual(crowded.languages, ["ja", "ko", "en"]);
  const updated = await service.update("host-1", koOnly.id, { version: 1, languages: ["ja"] });
  assert.deepEqual(updated.languages, ["ja", "ko", "en"]);
});

test("pause and resume are guarded versioned transitions between live and paused", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"] });

  await assert.rejects(
    service.pause("host-1", created.id, created.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_PAUSABLE",
  );

  const started = await service.start("host-1", created.id, created.version);
  const paused = await service.pause("host-1", created.id, started.version);
  assert.equal(paused.status, "paused");
  assert.equal(paused.version, started.version + 1);
  // Idempotent retry with the stale version returns the paused session.
  assert.deepEqual(await service.pause("host-1", created.id, started.version), paused);
  await assert.rejects(
    service.pause("other-host", created.id, paused.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
  await assert.rejects(
    service.start("host-1", created.id, paused.version),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_PAUSED",
  );

  const resumed = await service.resume("host-1", created.id, paused.version);
  assert.equal(resumed.status, "live");
  assert.equal(resumed.version, paused.version + 1);
  assert.deepEqual(await service.resume("host-1", created.id, paused.version), resumed);
  // Resuming an already-live session stays idempotent instead of failing.
  assert.deepEqual(await service.resume("host-1", created.id, resumed.version), resumed);

  await service.end("host-1", created.id);
  await assert.rejects(
    service.pause("host-1", created.id, resumed.version + 1),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_PAUSABLE",
  );
});

test("host recovery lists only the host's active sessions", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const preparing = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"], title: "Preparing" });
  const live = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"], title: "Live" });
  await service.start("host-1", live.id, live.version);
  const pausedSession = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"], title: "Paused" });
  const pausedStarted = await service.start("host-1", pausedSession.id, pausedSession.version);
  await service.pause("host-1", pausedSession.id, pausedStarted.version);
  const ended = await service.create("host-1", { sessionType: "meeting", languages: ["ko", "en"], title: "Ended" });
  await service.end("host-1", ended.id);
  await service.create("host-2", { sessionType: "meeting", languages: ["ko", "en"], title: "Other host" });

  const mine = await service.listActive("host-1");
  assert.deepEqual(
    mine.map((session) => [session.title, session.status]).sort(),
    [["Live", "live"], ["Paused", "paused"], ["Preparing", "preparing"]],
  );
  assert.ok(mine.every((session) => session.hostId === "host-1"));
  assert.deepEqual([preparing.id, live.id, pausedSession.id].sort(), mine.map((session) => session.id).sort());
});

test("only explicit host end terminates a live session", async () => {
  const store = new MemoryLiveSessionStore();
  const service = new LiveSessionService(store);
  const created = await service.create("host-1", {
    title: "Persistent live call",
    sessionType: "meeting",
    languages: ["ko", "en"],
  });
  const started = await service.start("host-1", created.id, created.version);

  // Desktop caption pause/restart does not cross the LiveSessionService
  // boundary, so the session, participants, invite credentials, and transcript
  // remain attached to the same session id.
  assert.equal((await store.get(started.id))?.status, "live");
  await assert.rejects(
    service.end("other-host", started.id),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
  assert.equal((await store.get(started.id))?.status, "live");

  await service.end("host-1", started.id);
  const ended = await store.get(started.id);
  assert.equal(ended?.status, "stopped");
  assert.ok(ended?.endedAt);
});

test("session type, output, capacity, and glossary update atomically", async () => {
  const now = Date.UTC(2026, 6, 19);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", { sessionType: "meeting", languages: ["ko"] });
  const updated = await service.update("host-1", created.id, {
    version: 1,
    sessionType: "meeting",
    outputMode: "captions_audio",
    languages: ["ko", "en"],
    maxViewers: 24,
    glossaryPack: "hotel",
  });
  assert.deepEqual(
    {
      sessionType: updated.sessionType,
      outputMode: updated.outputMode,
      languages: updated.languages,
      maxViewers: updated.maxViewers,
      glossaryPack: updated.glossaryPack,
      version: updated.version,
    },
    {
      sessionType: "meeting",
      outputMode: "captions_audio",
      languages: ["ko", "en"],
      maxViewers: 24,
      glossaryPack: "hotel",
      version: 2,
    },
  );
  const audioOnly = await service.update("host-1", created.id, { version: 2, outputMode: "audio" });
  assert.equal(audioOnly.outputMode, "audio");
});

test("legacy townhall input maps to meeting audio for one release", async () => {
  const service = new LiveSessionService(new MemoryLiveSessionStore());
  const session = await service.create("host-1", { mode: "townhall", languages: ["ko"], voiceOutputMode: "auto_voice" });
  assert.equal(session.sessionType, "meeting");
  assert.equal(session.outputMode, "audio");
});

test("Supabase snapshot maps persisted speaker voice status", async () => {
  const sessionRow = {
    id: "session-1", host_id: "host-1", mode: "townhall", voice_output_mode: "auto_voice",
    status: "live", languages: ["ko"], viewer_count: 1, version: 1, voice_provider: "gemini",
    admission_open_until: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const speaker = {
    speakerId: "speaker-1", label: "Speaker 1", colorToken: "speaker-1",
    voiceName: "Achernar", voiceStatus: "ready", lastSeenAt: new Date().toISOString(),
  };
  const secretKey = `sb_secret_${"a".repeat(24)}`;
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: secretKey, kind: "secret" }, async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), secretKey);
    assert.equal(headers.has("authorization"), false);
    if (String(url).includes("session_speakers")) return Response.json([speaker]);
    if (String(url).includes("live_snapshots")) return Response.json([]);
    return Response.json([sessionRow]);
  });
  const snapshot = await store.getSnapshot("session-1", "ko");
  assert.equal(snapshot?.speakers[0]?.voiceStatus, "ready");
});

test("getSnapshot rehydrates the full caption history from live_utterances", async () => {
  // live_snapshots.captions holds only the LATEST caption by design
  // (jsonb_build_array of one event, replaced on conflict). The durable record
  // is live_utterances. A viewer that joins, reconnects, or switches language
  // clears its in-memory captions and repopulates from this snapshot, so if the
  // snapshot serves one caption the entire visible history is destroyed — which
  // is exactly what participants saw when toggling EN -> KO -> EN.
  const sessionRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "meeting", output_mode: "captions",
    max_viewers: 50, glossary_pack: "general_cre", title: "Townhall",
    status: "live", languages: ["ko", "en"], viewer_count: 1, version: 1, voice_provider: "gemini",
    admission_open_until: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const emittedAt = new Date().toISOString();
  const utteranceRows = [3, 2, 1].map((seq) => ({
    seq,
    speaker_label: "speaker-1",
    speaker_name: "Noel Kim",
    text: `번역된 문장 ${seq}`,
    source_text: `source sentence ${seq}`,
    source_language: "en",
    source_ended_at: emittedAt,
    emitted_at: emittedAt,
  }));
  const secretKey = `sb_secret_${"b".repeat(24)}`;
  let utterancesQuery = "";
  const store = new SupabaseLiveSessionStore("https://dev-ref.supabase.co", { key: secretKey, kind: "secret" }, async (url) => {
    const target = String(url);
    if (target.includes("session_speakers")) return Response.json([]);
    if (target.includes("live_utterances")) {
      utterancesQuery = target;
      return Response.json(utteranceRows);
    }
    if (target.includes("live_snapshots")) {
      return Response.json([{ last_seq: 3, captions: [], speaker_legend: [] }]);
    }
    return Response.json([sessionRow]);
  });

  const snapshot = await store.getSnapshot("session-1", "ko");

  assert.equal(snapshot?.captions.length, 3, "the whole history must be replayed, not just the latest caption");
  assert.deepEqual(snapshot?.captions.map((caption) => caption.seq), [1, 2, 3]);
  assert.equal(snapshot?.lastSeq, 3);
  // Only this language's rows, oldest-first, so seq ordering is preserved.
  assert.match(utterancesQuery, /language=eq\.ko/u);
  // The oldest bounded window is followed by gateway keyset replay, avoiding
  // both a five-second giant snapshot and a gap before the live edge.
  assert.match(utterancesQuery, /order=seq\.asc/u);
  // The viewer contract validates every SpeakerAssignment field and silently
  // drops captions whose speaker shape is partial.
  const speaker = snapshot?.captions[0]?.speaker;
  assert.equal(speaker?.speakerId, "speaker-1");
  assert.equal(speaker?.label, "Noel Kim");
  assert.equal(typeof speaker?.colorToken, "string");
  assert.equal(speaker?.voiceStatus, "disabled");
  assert.equal(speaker?.voiceName, null);
  assert.equal(typeof speaker?.lastSeenAt, "string");
  // 원문보기 disclosure has to survive rehydration too.
  assert.equal(snapshot?.captions[0]?.sourceText, "source sentence 1");
  assert.equal(snapshot?.captions[0]?.isFinal, true);
});

test("getSnapshot preserves source-lane provenance from live_utterances", async () => {
  const sessionRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "meeting", output_mode: "captions",
    max_viewers: 50, glossary_pack: "general_cre", title: "Townhall", status: "live",
    languages: ["ko", "en"], viewer_count: 1, version: 1, voice_provider: "gemini",
    admission_open_until: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const emittedAt = new Date().toISOString();
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
    async (url) => {
      const target = String(url);
      if (target.includes("session_speakers")) return Response.json([]);
      if (target.includes("live_utterances")) return Response.json([{
        seq: 1, speaker_label: null, speaker_name: null, text: "원문입니다.",
        source_text: null, source_language: "ko", origin: "source",
        utterance_key: "session-1:input:1", source_ended_at: emittedAt, emitted_at: emittedAt,
      }]);
      if (target.includes("live_snapshots")) return Response.json([]);
      return Response.json([sessionRow]);
    },
  );
  const snapshot = await store.getSnapshot("session-1", "ko");
  assert.equal(snapshot?.captions[0]?.origin, "source");
  assert.equal(snapshot?.captions[0]?.utteranceKey, "session-1:input:1");
});

test("getSnapshot serves a bounded oldest window whose lastSeq resumes gateway paging", async () => {
  const sessionRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "meeting", output_mode: "captions",
    max_viewers: 50, glossary_pack: "general_cre", title: "Long call", status: "live",
    languages: ["ko"], viewer_count: 1, version: 1, voice_provider: "gemini",
    admission_open_until: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const emittedAt = new Date().toISOString();
  const allRows = Array.from({ length: 200 }, (_, index) => ({
    seq: index + 1, speaker_label: null, speaker_name: null, text: `line ${index + 1}`,
    source_text: "source", source_language: "en", origin: null, utterance_key: `u-${index + 1}`,
    source_ended_at: emittedAt, emitted_at: emittedAt,
  }));
  const utteranceQueries: string[] = [];
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"b".repeat(24)}`, kind: "secret" },
    async (url) => {
      const target = String(url);
      if (target.includes("session_speakers")) return Response.json([]);
      if (target.includes("live_snapshots")) return Response.json([{ last_seq: 450, captions: [], speaker_legend: [] }]);
      if (target.includes("live_utterances")) {
        utteranceQueries.push(target);
        return Response.json(allRows);
      }
      return Response.json([sessionRow]);
    },
  );
  const snapshot = await store.getSnapshot("session-1", "ko");
  assert.equal(snapshot?.captions.length, 200);
  assert.equal(snapshot?.lastSeq, 200, "the snapshot-row live edge must not skip gateway replay pages");
  assert.equal(utteranceQueries.length, 1);
  assert.match(utteranceQueries[0], /order=seq\.asc/u);
});

test("Supabase rows reject unknown or meeting-scoped OpenAI voice providers", async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "presentation", output_mode: "audio",
    status: "live", languages: ["ko"], viewer_count: 0, max_viewers: 50, version: 1,
    glossary_pack: "general_cre", admission_open_until: null, expires_at: expiresAt,
  };
  for (const row of [
    { ...baseRow, voice_provider: undefined },
    { ...baseRow, voice_provider: "unknown" },
    { ...baseRow, session_type: "meeting", voice_provider: "openai" },
    { ...baseRow, output_mode: "captions", voice_provider: "openai" },
  ]) {
    const store = new SupabaseLiveSessionStore(
      "https://dev-ref.supabase.co",
      { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      async () => Response.json([row]),
    );
    await assert.rejects(
      store.get(baseRow.id),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_STORED_SESSION",
    );
  }
});

test("Supabase session rows fail closed on noncanonical, duplicate, or oversized language sets", async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseRow = {
    id: crypto.randomUUID(), host_id: "host-1", session_type: "presentation", output_mode: "captions",
    voice_provider: "gemini", status: "live", viewer_count: 0, max_viewers: 50, version: 1,
    glossary_pack: "general_cre", admission_open_until: null, expires_at: expiresAt,
  };
  for (const languages of [[], ["en-US"], ["th"], ["en", "en"], ["en", "ko", "ja", "fr"]]) {
    const store = new SupabaseLiveSessionStore(
      "https://dev-ref.supabase.co",
      { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
      async () => Response.json([{ ...baseRow, languages }]),
    );
    await assert.rejects(
      store.get(baseRow.id),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_STORED_SESSION",
    );
  }
});

test("Supabase session writes use atomic canonical RPC contracts", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const row = {
    id: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    host_id: "host-1",
    session_type: "presentation",
    output_mode: "captions_audio",
    status: "preparing",
    languages: ["ko"],
    viewer_count: 0,
    max_viewers: 24,
    version: 1,
    glossary_pack: "hotel",
    voice_provider: "openai",
    admission_open_until: null,
    expires_at: expiresAt,
  };
  const store = new SupabaseLiveSessionStore(
    "https://dev-ref.supabase.co",
    { key: `sb_secret_${"a".repeat(24)}`, kind: "secret" },
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json([{ ...row, version: requests.length }]);
    },
  );
  await store.create({
    id: row.id,
    hostId: row.host_id,
    title: "Investor Call",
    scheduledAt: null,
    sessionType: "presentation",
    outputMode: "captions_audio",
    status: "preparing",
    languages: ["ko"],
    viewerCount: 0,
    maxViewers: 24,
    version: 1,
    glossaryPack: "hotel",
    voiceProvider: "openai",
    admissionOpenUntil: null,
    expiresAt,
  });
  await store.updateOwned(row.id, row.host_id, 1, {
    title: "Investor Call",
    scheduledAt: null,
    sessionType: "meeting",
    outputMode: "audio",
    languages: ["ko"],
    maxViewers: 20,
    glossaryPack: "fnb",
    voiceProvider: "gemini",
  });
  assert.match(requests[0]?.url ?? "", /\/rpc\/create_live_session$/u);
  assert.deepEqual(requests[0]?.body, {
    p_session_id: row.id,
    p_host_id: row.host_id,
    p_title: "Investor Call",
    p_scheduled_at: null,
    p_session_type: "presentation",
    p_output_mode: "captions_audio",
    p_languages: ["ko"],
    p_max_viewers: 24,
    p_glossary_pack: "hotel",
    p_voice_provider: "openai",
    p_expires_at: expiresAt,
  });
  assert.match(requests[1]?.url ?? "", /\/rpc\/update_live_session$/u);
  assert.equal(requests[1]?.body.p_expected_version, 1);
  assert.equal(requests[1]?.body.p_title, "Investor Call");
  assert.equal(requests[1]?.body.p_scheduled_at, null);
  assert.equal(requests[1]?.body.p_output_mode, "audio");
  assert.equal(requests[1]?.body.p_max_viewers, 20);
  assert.equal(requests[1]?.body.p_glossary_pack, "fnb");
  assert.equal(requests[1]?.body.p_voice_provider, "gemini");
});

test("live store config uses the exact development project boundary", () => {
  const secretKey = `sb_secret_${"a".repeat(24)}`;
  const config = getLiveStoreConfig({
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "approved-dev-ref",
    SUPABASE_URL: "https://approved-dev-ref.supabase.co",
    SUPABASE_SECRET_KEY: secretKey,
  });
  assert.deepEqual(config, {
    baseUrl: "https://approved-dev-ref.supabase.co",
    credential: { key: secretKey, kind: "secret" },
  });
  assert.throws(() => getLiveStoreConfig({
    LIVE_EXTERNAL_ENV: "development",
    LIVE_ALLOWED_SUPABASE_REF: "approved-dev-ref",
    SUPABASE_URL: "https://different-ref.supabase.co",
    SUPABASE_SECRET_KEY: secretKey,
  }));
});

test("expired sessions reject host updates even before database cleanup", async () => {
  const store = new MemoryLiveSessionStore();
  const expiredSessionId = crypto.randomUUID();
  await store.create({
    id: expiredSessionId, hostId: "host-1", title: "Expired", scheduledAt: null,
    sessionType: "presentation", outputMode: "captions",
    voiceProvider: "gemini", maxViewers: 50, glossaryPack: "general_cre",
    status: "live", languages: ["en"], viewerCount: 0, version: 1,
    admissionOpenUntil: null, expiresAt: new Date(0).toISOString(),
  });
  const service = new LiveSessionService(store);
  await assert.rejects(
    service.update("host-1", expiredSessionId, { version: 1, languages: ["ko"] }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND",
  );
});

test("removed language snapshots fail explicitly", async () => {
  const now = Date.UTC(2026, 6, 19);
  const store = new MemoryLiveSessionStore(() => now);
  const service = new LiveSessionService(store, () => now);
  const created = await service.create("host-1", { sessionType: "meeting", languages: ["en"] });
  await assert.rejects(() => service.snapshot(created.id, "ja"), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "LANGUAGE_REMOVED";
  });
});

test("live APIs map missing server configuration to one safe actionable failure", () => {
  const failure = toLiveFailure(new LiveSecurityConfigurationError("SUPABASE_SECRET_KEY must never reach clients"));

  assert.deepEqual(failure, {
    status: 503,
    body: {
      ok: false,
      error: "라이브 서버 연결이 아직 설정되지 않았습니다.",
      code: "SECURITY_NOT_CONFIGURED",
    },
  });
  assert.equal(JSON.stringify(failure).includes("SUPABASE_SECRET_KEY"), false);
});

test("host session GET validates authentication, id, ownership, and safe error mapping", () => {
  const route = readFileSync(new URL("../../app/api/live-sessions/[id]/route.ts", import.meta.url), "utf8");
  const getStart = route.indexOf("export async function GET");
  const patchStart = route.indexOf("export async function PATCH");
  assert.notEqual(getStart, -1);
  assert.notEqual(patchStart, -1);
  const getHandler = route.slice(getStart, patchStart);

  assert.ok(getHandler.indexOf("requireHost(request)") < getHandler.indexOf("getLiveSessionStore().get(id)"));
  assert.ok(getHandler.indexOf("parseSessionId(params.id)") < getHandler.indexOf("getLiveSessionStore().get(id)"));
  assert.match(getHandler, /!session \|\| session\.hostId !== hostId/u);
  assert.match(getHandler, /"SESSION_NOT_FOUND", 404/u);
  assert.match(getHandler, /return apiSuccess\(session\)/u);
  assert.match(getHandler, /error instanceof AuthenticationError/u);
  assert.match(getHandler, /const failure = toLiveFailure\(error\)/u);
});
