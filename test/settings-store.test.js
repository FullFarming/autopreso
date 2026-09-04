import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_SETTINGS,
  MAX_AGENT_INSTRUCTIONS_CHARS,
  MAX_SUBTITLE_GLOSSARY_CHARS,
  migrateSettingsFile,
  validateApiKeys,
  validateSubtitleSettings,
} from "../src/settings-store.js";

async function tempPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "realtime-noel-settings-"));
  return path.join(dir, "settings.json");
}

const noCodexAuth = () => null;

test("engine selection survives unrelated saves and a fresh disk reload", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.save({ subtitle: { engine: {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.6-flash" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  } } });
  await store.save({ subtitle: { tone: "business" } });
  const reloaded = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(reloaded.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
  assert.equal(reloaded.subtitle.engine.summary.model, "gemini-3.7-flash");
  assert.equal(reloaded.subtitle.tone, "business");
});

test("concurrent first saves preserve engine selection details and unrelated caption choices", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await Promise.all([
    store.save({ subtitle: { engine: { stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" } }, tone: "business" } }),
    store.save({ subtitle: { engine: { summary: { provider: "gemini", model: "gemini-3.7-flash" } }, inputMode: "mic" } }),
  ]);
  const reloaded = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(reloaded.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
  assert.equal(reloaded.subtitle.engine.summary.model, "gemini-3.7-flash");
  assert.equal(reloaded.subtitle.tone, "business");
  assert.equal(reloaded.subtitle.inputMode, "mic");
});

test("legacy per-role gemini model fields fall back to defaults on load and are rejected on save", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({ subtitle: { geminiTranscribeModel: "unlisted", geminiSummaryModel: "unlisted" } }));
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  // Unknown legacy values never crash the load and never fall back to a paid
  // path the user did not choose -- they resolve to the catalog default.
  assert.equal(settings.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
  assert.equal(settings.subtitle.engine.summary.model, "gemini-3.6-flash");
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
  for (const legacyPatch of [
    { geminiTranscribeModel: "gemini-3.5-transcribe-live" },
    { geminiSummaryModel: "gemini-3.6-flash" },
    { geminiPolishModel: "gemini-3.7-flash" },
  ]) {
    await assert.rejects(store.save({ subtitle: legacyPatch }), /subtitle\.engine/u);
  }
});

test("createSettingsStore returns defaults when file is missing and env is empty", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(settings.agent.codex.model, "gpt-5.5-fast");
  assert.deepEqual(settings.subtitle, DEFAULT_SUBTITLE_SETTINGS);
  assert.equal(settings.subtitle.fontFamily, "Arial, Helvetica, sans-serif");
  assert.equal(settings.subtitle.displayMode, "translation_only");
  assert.equal(settings.subtitle.maxSubtitleLines, 2);
  assert.equal(settings.subtitle.micDeviceId, "");
  assert.equal(settings.subtitle.overlayEnabled, true);
  assert.equal(settings.subtitle.showSourceText, false);
  assert.equal(settings.subtitle.translateAllLanguages, false);
  assert.deepEqual(settings.subtitle.translationLanguages, ["en", "ko"]);
  assert.equal(settings.subtitle.outputMode, "captions");
  assert.deepEqual(settings.subtitle.engine, {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.6-flash" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  });
  for (const retiredKey of [
    "audioLanguage", "audioVolume", "voiceProvider", "model", "geminiModel",
    "geminiTranscribeModel", "geminiSummaryModel", "geminiPolishModel",
  ]) {
    assert.equal(Object.hasOwn(settings.subtitle, retiredKey), false);
  }
  assert.equal(settings.subtitle.recordProvider, "ollama");
  assert.equal(settings.subtitle.ollamaModel, "gemma3n:e2b");
  assert.equal(settings.subtitle.tone, "natural");
  assert.equal(Object.hasOwn(settings.apiKeys, "openaiSecondary"), false);
  // The second Gemini project key is a first-class slot (parallel 3-language
  // translation), so it defaults to an empty string rather than being absent.
  assert.equal(settings.apiKeys.geminiSecondary, "");
});

test("createSettingsStore normalizes retired interpreted audio settings to captions", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({
    subtitle: {
      translationLanguages: ["en", "ko", "ja"],
      outputMode: "audio",
      audioLanguage: "ja",
      audioVolume: 0.35,
    },
  }));
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });

  const saved = await store.load();
  assert.equal(saved.subtitle.outputMode, "captions");
  assert.equal(Object.hasOwn(saved.subtitle, "audioLanguage"), false);
  assert.equal(Object.hasOwn(saved.subtitle, "audioVolume"), false);

  await assert.rejects(
    () => store.save({ subtitle: { outputMode: "video" } }),
    /outputMode/,
  );
  await assert.rejects(
    () => store.save({ subtitle: { audioVolume: 1.01 } }),
    /audioVolume/,
  );
});

test("createSettingsStore persists and validates subtitle tone", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ subtitle: { tone: "business" } });

  const reloaded = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await reloaded.load();
  assert.equal(settings.subtitle.tone, "business");

  await assert.rejects(
    () => store.save({ subtitle: { tone: "casual" } }),
    /tone must be natural or business/,
  );
});

test("createSettingsStore accepts Japanese language pairs", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();

  await store.save({ subtitle: { languagePair: { a: "ko", b: "ja" } } });
  await store.save({ subtitle: { languagePair: { a: "ja", b: "ko" } } });
  await store.save({ subtitle: { languagePair: { a: "en", b: "ja" } } });

  await assert.rejects(
    () => store.save({ subtitle: { languagePair: { a: "ja", b: "ja" } } }),
    /languagePair/,
  );
  // zh is now a supported registry language; only genuinely unknown codes reject.
  await store.save({ subtitle: { languagePair: { a: "ko", b: "zh" } } });
  await assert.rejects(
    () => store.save({ subtitle: { languagePair: { a: "ko", b: "xx" } } }),
    /languagePair/,
  );
});

test("createSettingsStore persists source display and all-language subtitle options", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ subtitle: { showSourceText: true, translateAllLanguages: true } });

  const reloaded = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await reloaded.load();
  assert.equal(settings.subtitle.showSourceText, true);
  assert.equal(settings.subtitle.translateAllLanguages, true);

  await assert.rejects(
    () => store.save({ subtitle: { showSourceText: "yes" } }),
    /showSourceText/,
  );
  await assert.rejects(
    () => store.save({ subtitle: { translateAllLanguages: "yes" } }),
    /translateAllLanguages/,
  );
});

test("createSettingsStore persists and validates selected subtitle translation languages", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ subtitle: { translationLanguages: ["ko", "ja", "en"], translateAllLanguages: true } });

  const reloaded = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await reloaded.load();
  assert.deepEqual(settings.subtitle.translationLanguages, ["ko", "ja", "en"]);

  await assert.rejects(
    () => store.save({ subtitle: { translationLanguages: ["ko"] } }),
    /translationLanguages/,
  );
  await assert.rejects(
    () => store.save({ subtitle: { translationLanguages: ["ko", "ko"] } }),
    /translationLanguages/,
  );
  // zh is now a supported registry language; only genuinely unknown codes reject.
  await store.save({ subtitle: { translationLanguages: ["ko", "zh"] } });
  await assert.rejects(
    () => store.save({ subtitle: { translationLanguages: ["ko", "xx"] } }),
    /translationLanguages/,
  );
});

test("createSettingsStore persists and validates the vertical offset and domain", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.subtitle.verticalOffset, 48);
  assert.equal(settings.subtitle.translationDomain, DEFAULT_SUBTITLE_SETTINGS.translationDomain);

  await store.save({ subtitle: { verticalOffset: 120, translationDomain: "Commercial real estate hospitality" } });
  const reloaded = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const saved = await reloaded.load();
  assert.equal(saved.subtitle.verticalOffset, 120);
  assert.match(saved.subtitle.translationDomain, /hospitality/);

  await assert.rejects(
    () => store.save({ subtitle: { verticalOffset: 9000 } }),
    /verticalOffset/,
  );
  await assert.rejects(
    () => store.save({ subtitle: { translationDomain: "x".repeat(2001) } }),
    /translationDomain/,
  );
});

test("createSettingsStore persists and validates the subtitle glossary", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.subtitle.glossary, DEFAULT_SUBTITLE_SETTINGS.glossary);

  await store.save({ subtitle: { glossary: "MRG -> keep verbatim\n운영사 -> operator" } });
  const reloaded = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  assert.match((await reloaded.load()).subtitle.glossary, /operator/);

  // The realtime prompt cap is shared with synchronized custom presets. Shipped
  // presets are compacted at complete section boundaries and pinned against the
  // same exported constant in test/glossary-presets.test.js.
  await store.save({ subtitle: { glossary: "y".repeat(MAX_SUBTITLE_GLOSSARY_CHARS) } });
  await assert.rejects(
    () => store.save({ subtitle: { glossary: "x".repeat(MAX_SUBTITLE_GLOSSARY_CHARS + 1) } }),
    /glossary/,
  );
});

test("createSettingsStore keeps legacy 19k glossary and 701-char domain valid for Live Call", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const glossary = "x".repeat(19_719);

  await store.load();
  await store.save({ subtitle: { glossary, translationDomain: "d".repeat(701) } });

  assert.equal((await store.load()).subtitle.glossary.length, 19_719);
  assert.equal((await store.load()).subtitle.translationDomain.length, 701);
});

test("createSettingsStore retains a synchronized custom preset snapshot for offline reuse", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ subtitle: {
    glossaryPresetId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    glossaryPresetName: "Board terms",
    glossary: "수임 = mandate",
    translationDomain: "CRE board meeting",
  } });

  const reopened = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const saved = await reopened.load();
  assert.equal(saved.subtitle.glossaryPresetId, "0192d0f4-9f72-7a36-91f5-6a76ef736f41");
  assert.equal(saved.subtitle.glossaryPresetName, "Board terms");
  assert.equal(saved.subtitle.glossary, "수임 = mandate");
  assert.equal(saved.subtitle.translationDomain, "CRE board meeting");

  await store.save({ subtitle: {
    glossaryPresetId: "",
    glossaryPresetName: "",
    glossary: "수동 = manual",
  } });
  assert.equal((await store.load()).subtitle.glossaryPresetId, "");
  assert.equal((await store.load()).subtitle.glossaryPresetName, "");
});

test("createSettingsStore persists the exact plural glossary pin contract and rejects unsafe selections", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  const glossaries = [
    { sourceKind: "builtin", sourceId: "common_business" },
    { sourceKind: "host", sourceId: "0192d0f4-9f72-7a36-91f5-6a76ef736f41", documentVersion: 2 },
  ];
  assert.deepEqual((await store.save({ subtitle: { glossaries } })).subtitle.glossaries, glossaries);
  await assert.rejects(() => store.save({ subtitle: { glossaries: [] } }), /between 1 and 5/u);
  await assert.rejects(() => store.save({ subtitle: { glossaries: Array.from({ length: 6 }, () => ({ sourceKind: "builtin", sourceId: "common_business" })) } }), /between 1 and 5/u);
  await assert.rejects(() => store.save({ subtitle: { glossaries: [{ sourceKind: "builtin", sourceId: "unknown" }] } }), /valid glossary selections/u);
});

test("createSettingsStore migrates legacy voice settings while keeping direct translation caption-only", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({
    subtitle: { translationProvider: "openai", voiceProvider: "openai" },
  }));
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.subtitle.translationProvider, "gemini");
  assert.equal(settings.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
  assert.equal(Object.hasOwn(settings.subtitle, "geminiModel"), false);
  assert.equal(Object.hasOwn(settings.subtitle, "voiceProvider"), false);
  await assert.rejects(() => store.save({ subtitle: { voiceProvider: "gemini" } }), /retired/u);
  assert.equal(settings.subtitle.engine.translation.model, "gemini-3.6-flash");

  await assert.rejects(() => store.save({ subtitle: { translationProvider: "openai" } }), /translationProvider/u);

  await assert.rejects(() => store.save({ subtitle: { translationProvider: "claude" } }), /translationProvider/u);
});

// geminiPolishModel and geminiModel are retired: the polish step is now a fixed
// internal model, not a user-selectable field, and geminiModel never fed the
// engine either. A stored file carrying them must load without crashing and
// come out with those keys gone and the engine catalog default intact.
test("legacy geminiModel and geminiPolishModel fields are dropped from disk without crashing load", async () => {
  for (const geminiPolishModel of ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash"]) {
    const filePath = await tempPath();
    await fs.writeFile(filePath, JSON.stringify({
      subtitle: {
        geminiModel: "gemini-3.5-live-translate-preview",
        geminiPolishModel,
      },
    }));

    const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
    const settings = await store.load();
    assert.equal(settings.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
    assert.equal(Object.hasOwn(settings.subtitle, "geminiModel"), false);
    assert.equal(Object.hasOwn(settings.subtitle, "geminiPolishModel"), false);
    assert.equal((await store.load()).subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
  }
});

test("getSanitized strips the gemini key but reports registration status", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ apiKeys: { gemini: "AIza-test-key", geminiSecondary: "AIza-test-key-2" } });

  const sanitized = await store.getSanitized();
  assert.equal(sanitized.apiKeys, undefined);
  assert.equal(sanitized.hasGeminiKey, true);
  // The second Gemini key is now persisted and reported (parallel 3-language
  // translation), while the raw key is still stripped from sanitized output.
  assert.equal(sanitized.hasGeminiSecondaryKey, true);
  assert.equal(sanitized.hasOpenAIKey, false);
  assert.equal(JSON.stringify(sanitized).includes("AIza-test-key"), false);
  assert.equal(JSON.stringify(sanitized).includes("AIza-test-key-2"), false);
  assert.equal((await store.load()).apiKeys.geminiSecondary, "AIza-test-key-2");
});

test("getSanitized exposes only the primary OpenAI key registration status", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ apiKeys: { openai: "sk-primary" } });

  const sanitized = await store.getSanitized();
  assert.equal(sanitized.apiKeys, undefined);
  assert.equal(sanitized.hasOpenAIKey, true);
  assert.equal(Object.hasOwn(sanitized, "hasOpenAISecondaryKey"), false);
  assert.equal(JSON.stringify(sanitized).includes("sk-primary"), false);
});

test("an obsolete secondary OpenAI key on disk is discarded without exposing it", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({ apiKeys: { openai: "sk-primary", openaiSecondary: "sk-obsolete" } }));
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });

  const settings = await store.load();
  const sanitized = await store.getSanitized();

  assert.equal(settings.apiKeys.openai, "sk-primary");
  assert.equal(Object.hasOwn(settings.apiKeys, "openaiSecondary"), false);
  assert.equal(Object.hasOwn(sanitized, "hasOpenAISecondaryKey"), false);
  assert.equal(JSON.stringify(sanitized).includes("sk-obsolete"), false);
});

test("createSettingsStore.save persists subtitle settings", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({
    subtitle: {
      inputMode: "system_mic",
      micDeviceId: "input-device-1",
      translationFontSize: 44,
      sourceFontSize: 42,
      position: "bottom-center",
    },
  });

  const reloaded = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await reloaded.load();
  assert.equal(settings.subtitle.inputMode, "system_mic");
  assert.equal(settings.subtitle.micDeviceId, "input-device-1");
  assert.equal(settings.subtitle.translationFontSize, 44);
  assert.equal(settings.subtitle.sourceFontSize, 42);
  assert.deepEqual(settings.subtitle.engine, DEFAULT_SUBTITLE_SETTINGS.engine);
  assert.equal(settings.subtitle.displayMode, "translation_only");
  assert.equal(settings.subtitle.overlayEnabled, true);
});

test("createSettingsStore migrates old subtitle source display to translation only", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({
    ...DEFAULT_SETTINGS,
    subtitle: {
      ...DEFAULT_SUBTITLE_SETTINGS,
      displayMode: "translation_source",
    },
  }));

  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.subtitle.displayMode, "translation_only");
});

test("migrateSettingsFile copies legacy settings only when the new file is missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "realtime-noel-migrate-"));
  const legacyPath = path.join(dir, "legacy", "settings.json");
  const nextPath = path.join(dir, "next", "settings.json");
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, JSON.stringify({ apiKeys: { openai: "sk-test" } }));

  await migrateSettingsFile({ fromPath: legacyPath, toPath: nextPath });
  assert.equal(JSON.parse(await fs.readFile(nextPath, "utf8")).apiKeys.openai, "sk-test");

  await fs.writeFile(nextPath, JSON.stringify({ apiKeys: { openai: "sk-existing" } }));
  await migrateSettingsFile({ fromPath: legacyPath, toPath: nextPath });
  assert.equal(JSON.parse(await fs.readFile(nextPath, "utf8")).apiKeys.openai, "sk-existing");
});

test("createSettingsStore.save rejects invalid subtitle settings", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();

  await assert.rejects(
    store.save({ subtitle: { inputMode: "speaker" } }),
    /Subtitle input mode must be system, mic, or system_mic\./,
  );
  await assert.rejects(
    store.save({ subtitle: { maxSubtitleLines: 9 } }),
    /Subtitle maxSubtitleLines must be between 1 and 8\./,
  );
  await assert.rejects(
    store.save({ subtitle: { ollamaBaseURL: "https://example.com:11434" } }),
    /Subtitle ollamaBaseURL must point to localhost\./,
  );
  await assert.rejects(
    store.save({ subtitle: { micDeviceId: 12 } }),
    /Subtitle micDeviceId must be a string\./,
  );
  await assert.rejects(
    store.save({ subtitle: { overlayEnabled: "yes" } }),
    /Subtitle overlayEnabled must be a boolean\./,
  );
});

test("createSettingsStore seeds settings from environment on first run", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: {
      OPENAI_API_KEY: "sk-env",
      OPENAI_SECONDARY_API_KEY: "sk-env-secondary",
      GEMINI_API_KEY: "AIza-env",
      OPENAI_MODEL: "gpt-5-pro",
      OPENAI_BASE_URL: "https://gateway.example.test/v1",
      OPENAI_REASONING_EFFORT: "high",
      OLLAMA_MODEL: "llama3",
      OLLAMA_BASE_URL: "http://localhost:1234/v1",
    },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.apiKeys.openai, "sk-env");
  assert.equal(Object.hasOwn(settings.apiKeys, "openaiSecondary"), false);
  assert.equal(settings.apiKeys.gemini, "AIza-env");
  // The second Gemini key is a first-class slot; with no env value it defaults
  // to an empty string rather than being absent.
  assert.equal(settings.apiKeys.geminiSecondary, "");
  assert.equal(settings.agent.openai.model, "gpt-5-pro");
  assert.equal(settings.agent.openai.baseURL, "https://gateway.example.test/v1");
  assert.equal(settings.agent.openai.reasoningEffort, "high");
  assert.equal(settings.agent.ollama.model, "llama3");
  assert.equal(settings.agent.ollama.baseURL, "http://localhost:1234/v1");
});

test("createSettingsStore picks ollama agent when OLLAMA_MODEL is set without other auth", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OLLAMA_MODEL: "llama3" },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "ollama");
});

test("createSettingsStore picks openai agent and transcription when key is in env", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENAI_API_KEY: "sk-env" },
    readCodexAuth: noCodexAuth,
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "openai");
  assert.equal(settings.transcription.provider, "openai");
});

test("createSettingsStore prefers Codex agent whenever Codex CLI auth is available", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENAI_API_KEY: "sk-env", OLLAMA_MODEL: "llama3" },
    readCodexAuth: () => ({ tokens: {}, accessToken: "codex-token", refreshToken: null, accountId: null }),
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "codex");
  assert.equal(settings.transcription.provider, "openai");
});

test("createSettingsStore tolerates Codex auth read errors and falls back to other providers", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENAI_API_KEY: "sk-env" },
    readCodexAuth: () => { throw new Error("boom"); },
  });
  const settings = await store.load();
  assert.equal(settings.agent.provider, "openai");
});

test("createSettingsStore falls back to moonshine transcription without OPENAI_API_KEY", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.transcription.provider, "moonshine");
});

test("createSettingsStore.save deep-merges and persists to disk", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ transcription: { provider: "openai", openai: { model: "gpt-realtime-whisper" } } });

  const reloaded = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await reloaded.load();
  assert.equal(settings.transcription.provider, "openai");
  assert.equal(settings.transcription.openai.model, "gpt-realtime-whisper");
  assert.equal(settings.transcription.moonshine.model, DEFAULT_SETTINGS.transcription.moonshine.model);
});

test("createSettingsStore.save rejects oversized agent instructions", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();

  await assert.rejects(
    store.save({ agentInstructions: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1) }),
    /Agent instructions must be 100000 characters or fewer\./,
  );
});

test("createSettingsStore.save writes the file with 0600 permissions", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ apiKeys: { openai: "sk-secret" } });

  const stat = await fs.stat(filePath);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("createSettingsStore.getSanitized strips api keys and reports hasOpenAIKey", async () => {
  const store = createSettingsStore({
    filePath: await tempPath(),
    env: { OPENAI_API_KEY: "sk-env" },
    readCodexAuth: noCodexAuth,
  });
  await store.load();
  const sanitized = await store.getSanitized();
  assert.equal(sanitized.apiKeys, undefined);
  assert.equal(sanitized.hasOpenAIKey, true);
  assert.equal(sanitized.agent.provider, "openai");
});

test("createSettingsStore.getSanitized reports false when no openai key is set", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  const sanitized = await store.getSanitized();
  assert.equal(sanitized.hasOpenAIKey, false);
});

test("createSettingsStore preserves previously-saved values across reloads, ignoring env defaults", async () => {
  const filePath = await tempPath();
  const first = createSettingsStore({
    filePath,
    env: { OPENAI_API_KEY: "sk-original" },
    readCodexAuth: noCodexAuth,
  });
  await first.load();
  await first.save({ agent: { openai: { model: "gpt-5-mini" } } });

  const second = createSettingsStore({
    filePath,
    env: { OPENAI_API_KEY: "sk-different", OPENAI_MODEL: "gpt-different" },
    readCodexAuth: noCodexAuth,
  });
  const settings = await second.load();
  assert.equal(settings.agent.openai.model, "gpt-5-mini");
  assert.equal(settings.apiKeys.openai, "sk-original");
});

// ---- N-language expansion: validation accepts the full registry ----

test("validateSubtitleSettings accepts new registry languages", () => {
  validateSubtitleSettings({ translationLanguages: ["ko", "zh"] });
  validateSubtitleSettings({ translationLanguages: ["en", "zh-Hans", "zh-Hant"] });
  validateSubtitleSettings({ languagePair: { a: "es", b: "ko" } });
  validateSubtitleSettings({ subtitlePositions: { "zh-Hant": "top-center" } });
});

test("validateSubtitleSettings still rejects unsupported languages and oversized lists", () => {
  assert.throws(() => validateSubtitleSettings({ translationLanguages: ["en", "klingon"] }));
  assert.throws(() => validateSubtitleSettings({ translationLanguages: ["en"] }));
  assert.throws(() => validateSubtitleSettings({ translationLanguages: ["en", "ko", "ja", "es"] }));
  assert.throws(() => validateSubtitleSettings({ languagePair: { a: "xx", b: "ko" } }));
  assert.throws(() => validateSubtitleSettings({ subtitlePositions: { xx: "top-center" } }));
});

// ── Malformed settings.json must never brick the app ───────────────────────
// migrateSettings assigned straight into `settings.subtitle`, so a file holding
// `{"subtitle": null}` (or a string, or a number) threw
// `TypeError: Cannot set properties of null` out of readFromDisk. On the
// desktop that rejected createApp(): no window, no dialog, just a dock icon.

test("a non-object subtitle section on disk resets to defaults instead of throwing", async () => {
  for (const raw of ['{"subtitle": null}', '{"subtitle": "boom"}', '{"subtitle": 5}', '{"subtitle": []}', '{"subtitle": true}']) {
    const filePath = await tempPath();
    await fs.writeFile(filePath, raw);
    const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
    const settings = await store.load();
    assert.equal(Array.isArray(settings.subtitle), false, raw);
    assert.deepEqual(settings.subtitle, DEFAULT_SUBTITLE_SETTINGS, raw);
    // The rest of the file must still merge normally.
    assert.deepEqual(settings.apiKeys, DEFAULT_SETTINGS.apiKeys, raw);
  }
});

test("an unrelated key alongside a broken subtitle section is preserved", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, '{"subtitle": null, "agentInstructions": "keep me"}');
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.agentInstructions, "keep me");
  assert.deepEqual(settings.subtitle, DEFAULT_SUBTITLE_SETTINGS);
});

// `"subtitle": []` used to be accepted end to end: an array is truthy, every
// field of validateSubtitleSettings read `undefined`, and deepMerge preserved
// the array shape. JSON.stringify then dropped every string key assigned to it,
// so the file kept `"subtitle": []` and EVERY later save silently no-opped.
test("an array subtitle section on disk no longer kills settings persistence", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, '{"subtitle": []}');
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ subtitle: { translationFontSize: 44 } });
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(Array.isArray(onDisk.subtitle), false);
  assert.equal(onDisk.subtitle.translationFontSize, 44, "the save must actually reach the disk");

  const reopened = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  assert.equal((await reopened.load()).subtitle.translationFontSize, 44);
});

test("save rejects a subtitle patch that is not a plain object", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  for (const bad of [[], ["en"], "boom", 5, true, null]) {
    await assert.rejects(() => store.save({ subtitle: bad }), /plain object/u, JSON.stringify(bad));
  }
  // A real patch still lands.
  const saved = await store.save({ subtitle: { translationFontSize: 40 } });
  assert.equal(saved.subtitle.translationFontSize, 40);
});

test("validateSubtitleSettings rejects arrays and other non-objects", () => {
  assert.throws(() => validateSubtitleSettings([]), /plain object/u);
  assert.throws(() => validateSubtitleSettings(["en", "ko"]), /plain object/u);
  assert.throws(() => validateSubtitleSettings("boom"), /plain object/u);
  assert.throws(() => validateSubtitleSettings(5), /plain object/u);
  // undefined/null stay no-ops: callers pass an absent section freely.
  assert.doesNotThrow(() => validateSubtitleSettings(undefined));
  assert.doesNotThrow(() => validateSubtitleSettings(null));
});

// ── apiKeys had no validation at all ──────────────────────────────────────
// `save({ apiKeys: { openai: { evil: 1 } } })` persisted and then made
// getSanitized() report hasOpenAIKey: true for a key no provider call can use.

test("save validates apiKeys types and slot names", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();

  await assert.rejects(() => store.save({ apiKeys: { openai: { evil: 1 } } }), /must be a string/u);
  await assert.rejects(() => store.save({ apiKeys: { openai: 12345 } }), /must be a string/u);
  await assert.rejects(() => store.save({ apiKeys: { openai: ["sk-a"] } }), /must be a string/u);
  await assert.rejects(() => store.save({ apiKeys: { openai: null } }), /must be a string/u);
  await assert.rejects(() => store.save({ apiKeys: { hackerKey: "sk-a" } }), /Unknown API key slot/u);
  await assert.rejects(() => store.save({ apiKeys: [] }), /plain object/u);
  await assert.rejects(() => store.save({ apiKeys: { openai: "s".repeat(501) } }), /characters or fewer/u);

  // The bogus save must not have leaked onto disk or into hasOpenAIKey.
  assert.equal((await store.getSanitized()).hasOpenAIKey, false);
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).apiKeys.openai, "");

  // Real keys still round-trip, and getSanitized still strips them.
  const saved = await store.save({ apiKeys: { openai: "sk-real", geminiSecondary: "gm-real" } });
  assert.equal(saved.apiKeys.openai, "sk-real");
  const sanitized = await store.getSanitized();
  assert.equal(sanitized.apiKeys, undefined);
  assert.equal(sanitized.hasOpenAIKey, true);
  assert.equal(sanitized.hasGeminiSecondaryKey, true);
});

// ── fontFamily had no type validation ─────────────────────────────────────
// deepMerge spread a non-string default into per-index keys
// ({"0":"A","1":"r",...}), which later reached
// setProperty("--subtitle-font-family", ...).

test("save rejects a non-string fontFamily", async () => {
  const store = createSettingsStore({ filePath: await tempPath(), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  for (const bad of [{ 0: "X" }, ["A", "r"], 42, true]) {
    await assert.rejects(() => store.save({ subtitle: { fontFamily: bad } }), /fontFamily/u, JSON.stringify(bad));
  }
  await assert.rejects(() => store.save({ subtitle: { fontFamily: "x".repeat(401) } }), /fontFamily/u);
  const saved = await store.save({ subtitle: { fontFamily: "Helvetica, sans-serif" } });
  assert.equal(saved.subtitle.fontFamily, "Helvetica, sans-serif");
});

test("a fontFamily already poisoned on disk self-heals to the default", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, '{"subtitle": {"fontFamily": {"0": "A", "1": "r"}}}');
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const settings = await store.load();
  assert.equal(settings.subtitle.fontFamily, DEFAULT_SUBTITLE_SETTINGS.fontFamily);
});

test("validateApiKeys accepts an absent section and active slots only", () => {
  assert.doesNotThrow(() => validateApiKeys(undefined));
  assert.doesNotThrow(() => validateApiKeys({}));
  assert.doesNotThrow(() => validateApiKeys({ openai: "", gemini: "b", geminiSecondary: "c" }));
  assert.throws(() => validateApiKeys({ openaiSecondary: "obsolete" }), /Unknown API key slot: openaiSecondary/u);
});


// Mixed caption+audio output is retired: one output per session. Rejecting it on
// write is not enough on its own -- an existing settings.json may already hold
// it, and throwing on load would brick the file (a failure this store has had
// before), so the read path migrates instead.
test("the retired captions_audio output mode is rejected on write", () => {
  assert.throws(
    () => validateSubtitleSettings({ outputMode: "captions_audio" }),
    /outputMode must be captions/u,
  );
  validateSubtitleSettings({ outputMode: "captions" });
  assert.throws(
    () => validateSubtitleSettings({ outputMode: "audio" }),
    /outputMode must be captions/u,
  );
});

test("an existing audio settings file migrates to the current caption contract instead of failing to load", async () => {
  const filePath = await tempPath();
  await fs.writeFile(filePath, JSON.stringify({
    subtitle: { outputMode: "captions_audio", translationLanguages: ["en", "ko"], audioLanguage: "ko" },
  }));

  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const loaded = await store.load();
  assert.equal(loaded.subtitle.outputMode, "captions", "the mixed mode degrades to captions, the safe half");
  assert.equal(loaded.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
  assert.equal(Object.hasOwn(loaded.subtitle, "audioLanguage"), false);

  // And the migration is durable: saving afterwards must not throw on the value
  // it just read.
  await store.save({ subtitle: { translationLanguages: ["en", "ko"] } });
  const reloaded = await store.load();
  assert.equal(reloaded.subtitle.outputMode, "captions");
});

test("subtitle.engine defaults, migrates legacy gemini model fields, and rewrites the file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-engine-"));
  const filePath = path.join(dir, "settings.json");
  await fs.writeFile(filePath, JSON.stringify({ subtitle: {
    geminiTranscribeModel: "gemini-3.5-live-translate-preview", geminiSummaryModel: "gemini-3.7-flash", geminiPolishModel: "gemini-3.7-flash",
  } }));
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: () => null });
  const loaded = await store.load();
  assert.deepEqual(loaded.subtitle.engine, {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.7-flash" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  });
  for (const legacy of ["geminiTranscribeModel", "geminiSummaryModel", "geminiPolishModel", "geminiModel"]) {
    assert.equal(Object.hasOwn(loaded.subtitle, legacy), false, legacy);
  }
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(onDisk.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
});

test("save validates engine selections and soniox key slot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-engine-"));
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {}, readCodexAuth: () => null });
  await store.load();
  await assert.rejects(store.save({ subtitle: { engine: { stt: { provider: "soniox", model: "nope", languageMode: "auto" } } } }), /엔진 조합/u);
  await assert.rejects(store.save({ subtitle: { geminiTranscribeModel: "gemini-3.5-transcribe-live" } }), /subtitle\.engine/u);
  await store.save({ apiKeys: { soniox: "fixture-key" }, subtitle: { engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "en" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  } } });
  const saved = await store.load();
  assert.equal(saved.subtitle.engine.stt.languageMode, "en");
  const sanitized = await store.getSanitized();
  assert.equal(sanitized.hasSonioxKey, true);
  assert.equal(Object.hasOwn(sanitized, "apiKeys"), false);
});

// Fix round 1: a partial `engine` patch that only names one role must be
// merged over the CURRENTLY SAVED engine before validation, not validated in
// isolation -- otherwise the omitted roles normalize to the Gemini defaults
// and a combo check (Soniox translation's requiresSttProvider) fails against
// a phantom default stt role the caller never touched.
test("a partial engine patch merges over the current selection instead of validating in isolation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-engine-"));
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {}, readCodexAuth: () => null });
  await store.load();

  const fullSonioxCombo = {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  };
  await store.save({ apiKeys: { soniox: "fixture-key" }, subtitle: { engine: fullSonioxCombo } });

  // A translation-only patch must not be validated as if stt/summary were
  // absent (which would normalize stt to the Gemini default and break the
  // Soniox translation entry's requiresSttProvider check).
  const afterPartial = await store.save({ subtitle: { engine: {
    translation: { provider: "soniox", model: "stt-rt-v5" },
  } } });
  assert.deepEqual(afterPartial.subtitle.engine, fullSonioxCombo);
  const reloaded = await store.load();
  assert.deepEqual(reloaded.subtitle.engine, fullSonioxCombo);

  // A partial patch that DOES make the merged combo invalid must still fail
  // closed with the engine-combination error, not silently succeed.
  await assert.rejects(
    store.save({ subtitle: { engine: {
      stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    } } }),
    /엔진 조합/u,
  );
  // The rejected patch must not have mutated the stored engine.
  assert.deepEqual((await store.load()).subtitle.engine, fullSonioxCombo);
});

// Fix round 2 (I3): a partial engine patch must never silently fall back to the
// catalog defaults. deepMerge re-attached the SAVED stt languageMode ("ko") to
// a patched Gemini stt that only allows "auto", migrateSettings caught the
// resulting EngineSelectionError, and save() persisted the defaults while
// returning 200 - the user's whole engine choice replaced by a shrug.
test("a partial engine patch preserves untouched roles and never falls back to the defaults", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-engine-strict-"));
  const filePath = path.join(dir, "settings.json");
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ apiKeys: { soniox: "fixture-key" }, subtitle: { engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  } } });

  const saved = await store.save({ subtitle: { engine: {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live" },
    translation: { provider: "gemini", model: "gemini-3.7-flash" },
  } } });
  const expected = {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.7-flash" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  };
  assert.deepEqual(saved.subtitle.engine, expected);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")).subtitle.engine, expected);
  assert.deepEqual((await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load()).subtitle.engine, expected);
});

test("a patched stt keeps its saved languageMode when the provider and model are unchanged", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-engine-mode-"));
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ apiKeys: { soniox: "fixture-key" }, subtitle: { engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "en" },
    translation: { provider: "gemini", model: "gemini-3.5-flash-lite" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  } } });
  // Re-stating the same stt without a languageMode is not a request to reset
  // the input language to auto.
  const same = await store.save({ subtitle: { engine: { stt: { provider: "soniox", model: "stt-rt-v5" } } } });
  assert.equal(same.subtitle.engine.stt.languageMode, "en");
  // Changing the stt engine does drop the old mode to the default, and leaves
  // the roles the patch never named exactly as they were.
  const switched = await store.save({ subtitle: { engine: { stt: { provider: "gemini", model: "gemini-3.5-transcribe-live" } } } });
  assert.equal(switched.subtitle.engine.stt.languageMode, "auto");
  assert.equal(switched.subtitle.engine.translation.model, "gemini-3.5-flash-lite");
  assert.equal(switched.subtitle.engine.summary.model, "gemini-3.7-flash");
});

test("save rejects a merged engine combination the catalog refuses", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-engine-invalid-"));
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  await store.save({ apiKeys: { soniox: "fixture-key" }, subtitle: { engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  } } });
  // An stt that cannot restrict the input language may not inherit "ko".
  await assert.rejects(store.save({ subtitle: { engine: {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "ko" },
  } } }), /엔진 조합/u);
  assert.equal((await store.load()).subtitle.engine.stt.provider, "soniox");
});

// Fix round 2 (I4): Soniox's two-way translation only exists for a language
// PAIR, so saving it alongside 1 or 3 caption languages produced a selection
// that could only fail when the provider socket opened.
test("save refuses soniox translation unless exactly two caption languages are selected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-engine-langs-"));
  const store = createSettingsStore({ filePath: path.join(dir, "settings.json"), env: {}, readCodexAuth: noCodexAuth });
  await store.load();
  const combined = {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  };
  await store.save({ apiKeys: { soniox: "fixture-key" }, subtitle: { translationLanguages: ["en", "ko"], engine: combined } });
  await assert.rejects(
    store.save({ subtitle: { translationLanguages: ["en", "ko", "ja"] } }),
    /자막 언어가 정확히 2개/u,
    "a third caption language must not strand the combined engine",
  );
  assert.deepEqual((await store.load()).subtitle.translationLanguages, ["en", "ko"]);
  // The same rule applies when the engine is the field being changed.
  await store.save({ subtitle: { engine: { translation: { provider: "gemini", model: "gemini-3.6-flash" } } } });
  await store.save({ subtitle: { translationLanguages: ["en", "ko", "ja"] } });
  await assert.rejects(store.save({ subtitle: { engine: { translation: { provider: "soniox", model: "stt-rt-v5" } } } }),
    /자막 언어가 정확히 2개/u);
});

// Fix round 2 (I5): the migration rewrite is an optimization. A read-only
// config directory must not turn load() into a rejected promise - which on the
// desktop means no window, no dialog, just a dock icon.
test("load survives a failed migration rewrite and keeps the migrated engine in memory", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root bypasses directory permissions");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-readonly-"));
  const filePath = path.join(dir, "settings.json");
  await fs.writeFile(filePath, JSON.stringify({ subtitle: { geminiPolishModel: "gemini-3.7-flash", tone: "business" } }), "utf8");
  await fs.chmod(dir, 0o500);
  t.after(async () => {
    await fs.chmod(dir, 0o700);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const loaded = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(loaded.subtitle.engine.translation.model, "gemini-3.7-flash");
  assert.equal(loaded.subtitle.tone, "business");
  assert.equal(Object.hasOwn(loaded.subtitle, "geminiPolishModel"), false);
  // The file itself is untouched: nothing was written.
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(filePath, "utf8")).subtitle, "geminiPolishModel"), true);
});

// A file written BEFORE the language-count rule existed can hold a combined
// engine next to three caption languages. The load path has to repair that the
// same way it repairs an unknown model - otherwise every later save is rejected
// and the user is locked out of their own settings screen.
test("load repairs a stored combined engine that no longer matches the caption-language count", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-engine-repair-"));
  const filePath = path.join(dir, "settings.json");
  await fs.writeFile(filePath, JSON.stringify({
    apiKeys: { soniox: "fixture-key" },
    subtitle: {
      translationLanguages: ["en", "ko", "ja"],
      engine: {
        stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
        translation: { provider: "soniox", model: "stt-rt-v5" },
        summary: { provider: "gemini", model: "gemini-3.7-flash" },
      },
    },
  }), "utf8");
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  const loaded = await store.load();
  assert.deepEqual(loaded.subtitle.engine, {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
    translation: DEFAULT_SUBTITLE_SETTINGS.engine.translation,
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  }, "only the role that cannot be honoured falls back");
  // The repair is persisted, and unrelated saves keep working.
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")).subtitle.engine.translation,
    DEFAULT_SUBTITLE_SETTINGS.engine.translation);
  const after = await store.save({ subtitle: { tone: "business" } });
  assert.equal(after.subtitle.tone, "business");
});

// Plan B Task 5: the console's global engine default is remembered as
// `subtitle.engineDefaultsSeen` so a new Live Call can tell "the host still
// follows the global default" from "the host customised the engine".
test("subtitle.engineDefaultsSeen is optional, normalized on save, and dropped when the stored value is unusable", async () => {
  const filePath = await tempPath();
  const store = createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth });
  assert.equal((await store.load()).subtitle.engineDefaultsSeen, undefined);
  const seen = {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.6-flash" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  };
  await store.save({ subtitle: { engineDefaultsSeen: seen } });
  const reloaded = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.deepEqual(reloaded.subtitle.engineDefaultsSeen, seen);
  assert.equal(reloaded.subtitle.engine.summary.model, "gemini-3.6-flash", "remembering a default never changes the active engine");
  await assert.rejects(store.save({ subtitle: { engineDefaultsSeen: { stt: { provider: "nope", model: "x", languageMode: "auto" } } } }), /엔진 조합/u);
  assert.throws(() => validateSubtitleSettings({ engineDefaultsSeen: [] }), /엔진 조합/u);
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  onDisk.subtitle.engineDefaultsSeen = { summary: { provider: "gemini", model: "retired-model" } };
  await fs.writeFile(filePath, JSON.stringify(onDisk));
  const repaired = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(repaired.subtitle.engineDefaultsSeen, undefined);
  assert.equal(repaired.subtitle.engine.stt.model, "gemini-3.5-transcribe-live");
});
