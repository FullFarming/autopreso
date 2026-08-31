import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_GLOSSARY_PRESET_ID,
  GLOSSARY_PRESETS,
} from "../src/glossary-presets.js";
import {
  MAX_SUBTITLE_DOMAIN_CHARS,
  MAX_SUBTITLE_GLOSSARY_CHARS,
  createSettingsStore,
} from "../src/settings-store.js";
import { normalizeSubtitleSettings } from "../src/subtitle-realtime.js";

const noCodexAuth = () => null;

function fingerprint(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function settingsPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "realtime-noel-glossary-preset-"));
  return path.join(directory, "settings.json");
}

test("built-in glossary presets identify their local source and designated default", () => {
  const preset = GLOSSARY_PRESETS.find((entry) => entry.id === DEFAULT_GLOSSARY_PRESET_ID);
  assert.ok(preset);
  assert.equal(DEFAULT_GLOSSARY_PRESET_ID, "default-cre-ai-en-ko");
  assert.equal(preset.source, "built-in");
  assert.ok(preset.glossary.length <= MAX_SUBTITLE_GLOSSARY_CHARS);
  assert.ok(preset.domain.length <= MAX_SUBTITLE_DOMAIN_CHARS);
  assert.equal(GLOSSARY_PRESETS.every((entry) => entry.source === "built-in"), true);
  assert.equal(GLOSSARY_PRESETS.every((entry) => entry.glossary.length <= MAX_SUBTITLE_GLOSSARY_CHARS), true);
  assert.equal(GLOSSARY_PRESETS.every((entry) => entry.domain.length <= MAX_SUBTITLE_DOMAIN_CHARS), true);
});

test("fresh and empty settings receive the actual default glossary while custom text is preserved", async () => {
  const defaultPreset = GLOSSARY_PRESETS.find((entry) => entry.id === DEFAULT_GLOSSARY_PRESET_ID);
  assert.ok(defaultPreset);

  const freshStore = createSettingsStore({ filePath: await settingsPath(), env: {}, readCodexAuth: noCodexAuth });
  const fresh = await freshStore.load();
  assert.equal(fresh.subtitle.glossaryPresetId, DEFAULT_GLOSSARY_PRESET_ID);
  assert.equal(fresh.subtitle.glossaryPresetName, "");
  assert.equal(fresh.subtitle.glossary, defaultPreset.glossary);
  assert.equal(fresh.subtitle.translationDomain, defaultPreset.domain);

  const emptyPath = await settingsPath();
  await fs.writeFile(emptyPath, JSON.stringify({ subtitle: { glossary: "", translationDomain: "" } }));
  const empty = await createSettingsStore({ filePath: emptyPath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(empty.subtitle.glossaryPresetId, DEFAULT_GLOSSARY_PRESET_ID);
  assert.equal(empty.subtitle.glossary, defaultPreset.glossary);
  assert.equal(empty.subtitle.translationDomain, defaultPreset.domain);

  const exactPath = await settingsPath();
  await fs.writeFile(exactPath, JSON.stringify({
    subtitle: {
      languagePair: defaultPreset.languagePair,
      glossary: defaultPreset.glossary,
      translationDomain: defaultPreset.domain,
    },
  }));
  const exact = await createSettingsStore({ filePath: exactPath, env: {}, readCodexAuth: noCodexAuth }).load();
  assert.equal(exact.subtitle.glossaryPresetId, DEFAULT_GLOSSARY_PRESET_ID);

  const customPath = await settingsPath();
  await fs.writeFile(customPath, JSON.stringify({
    subtitle: {
      glossary: "회사 고유 용어 = Company term",
      translationDomain: "Private board meeting",
    },
  }));
  const customStore = createSettingsStore({ filePath: customPath, env: {}, readCodexAuth: noCodexAuth });
  const custom = await customStore.load();
  assert.equal(custom.subtitle.glossaryPresetId, "");
  assert.equal(custom.subtitle.glossaryPresetName, "");
  assert.equal(custom.subtitle.glossary, "회사 고유 용어 = Company term");
  assert.equal(custom.subtitle.translationDomain, "Private board meeting");
  await assert.rejects(
    customStore.save({ subtitle: { glossaryPresetId: "x".repeat(129) } }),
    /glossaryPresetId/u,
  );
  await assert.rejects(
    customStore.save({ subtitle: { glossaryPresetName: "x".repeat(81) } }),
    /glossaryPresetName/u,
  );
});

test("Caption-only and Live host resolve the exact same built-in preset fingerprint", async () => {
  const preset = GLOSSARY_PRESETS.find((entry) => entry.id === DEFAULT_GLOSSARY_PRESET_ID);
  assert.ok(preset);
  const captionOnly = normalizeSubtitleSettings({});
  const liveSettings = await createSettingsStore({
    filePath: await settingsPath(),
    env: {},
    readCodexAuth: noCodexAuth,
  }).load();

  const expectedFingerprint = fingerprint(`${preset.glossary}\u0000${preset.domain}`);
  assert.equal(fingerprint(`${captionOnly.glossary}\u0000${captionOnly.translationDomain}`), expectedFingerprint);
  assert.equal(fingerprint(`${liveSettings.subtitle.glossary}\u0000${liveSettings.subtitle.translationDomain}`), expectedFingerprint);

  const electronMain = await fs.readFile(new URL("../electron/main.js", import.meta.url), "utf8");
  assert.match(electronMain, /liveCaptionConfig = createGeminiCaptionConfig\(/u);
  assert.match(electronMain, /glossaryText: liveCaptionConfig\?\.glossary \?\? ""/u);
  assert.match(electronMain, /domainText: liveCaptionConfig\?\.domain \?\? ""/u);
});

test("editing one character of the current default converts it to Custom without overwriting it", async () => {
  const preset = GLOSSARY_PRESETS.find((entry) => entry.id === DEFAULT_GLOSSARY_PRESET_ID);
  assert.ok(preset);
  const editedGlossary = `${preset.glossary}!`;
  const filePath = await settingsPath();
  await fs.writeFile(filePath, JSON.stringify({
    subtitle: {
      languagePair: preset.languagePair,
      glossaryPresetId: DEFAULT_GLOSSARY_PRESET_ID,
      glossaryPresetName: "",
      glossary: editedGlossary,
      translationDomain: preset.domain,
    },
  }));

  const settings = await createSettingsStore({ filePath, env: {}, readCodexAuth: noCodexAuth }).load();

  assert.equal(settings.subtitle.glossaryPresetId, "");
  assert.equal(settings.subtitle.glossaryPresetName, "");
  assert.equal(settings.subtitle.glossary, editedGlossary);
  assert.equal(settings.subtitle.translationDomain, preset.domain);
});

test("Electron exposes cookie-authenticated custom preset CRUD without renderer secrets", async () => {
  const main = await fs.readFile(new URL("../electron/main.js", import.meta.url), "utf8");
  const preload = await fs.readFile(new URL("../electron/preload.js", import.meta.url), "utf8");

  for (const contract of [
    /listGlossaryPresets: \(\) => ipcRenderer\.invoke\("glossary-presets:list"\)/u,
    /createGlossaryPreset: \(input\) => ipcRenderer\.invoke\("glossary-presets:create", input\)/u,
    /updateGlossaryPreset: \(input\) => ipcRenderer\.invoke\("glossary-presets:update", input\)/u,
    /deleteGlossaryPreset: \(input\) => ipcRenderer\.invoke\("glossary-presets:delete", input\)/u,
  ]) assert.match(preload, contract);

  const handlers = main.slice(
    main.indexOf('ipcMain.handle("glossary-presets:list"'),
    main.indexOf('ipcMain.handle("live-call:get-state"'),
  );
  assert.match(handlers, /liveCallApiWithHostSession\(liveWorkspaceUrl, "\/api\/glossary-presets", \{ method: "GET" \}\)/u);
  const authenticatedApi = main.slice(
    main.indexOf("async function liveCallApiWithHostSession"),
    main.indexOf("function sanitizeLiveCallDraft"),
  );
  assert.match(authenticatedApi, /ensureDesktopHostSession\(baseUrl\)/u);
  assert.doesNotMatch(authenticatedApi, /silentHostLogin|\/api\/login|retry/u);
  assert.equal((authenticatedApi.match(/liveCallApi\(baseUrl, pathname, options\)/gu) ?? []).length, 1);
  assert.match(handlers, /method: "POST"/u);
  // Update is document-v1 now: save a new version then activate it — the
  // webapp rejects the legacy PATCH with 405.
  assert.doesNotMatch(handlers, /method: "PATCH"/u);
  assert.match(handlers, /\/versions\?presetVersion=/u);
  assert.match(handlers, /\/activate/u);
  assert.match(handlers, /method: "DELETE"/u);
  // Delete body uses the exact-keys webapp schema { presetVersion }.
  assert.match(handlers, /body: \{ presetVersion: value\.version \}/u);
  // Both create and update convert the flat desktop input into a
  // glossary-document/v1 body before POSTing.
  assert.match(main, /function buildGlossaryDocumentFromLegacyInput/u);
  assert.match(main, /convertLegacyGlossaryTextToDocumentV1/u);
  assert.equal((handlers.match(/buildGlossaryDocumentFromLegacyInput\(/gu) ?? []).length, 2);
  assert.match(handlers, /NETWORK_UNAVAILABLE/u);
  assert.match(handlers, /code: "FORBIDDEN"/u);
  assert.doesNotMatch(handlers, /hostPassword|password/u);
  assert.match(handlers, /isAllowedOrigin\(event\.sender\.getURL\(\), new Set\(\[localAppOrigin\]\)\)/u);

  const liveSettingsStart = main.indexOf("let liveCaptionConfig");
  const liveSettings = main.slice(
    liveSettingsStart,
    main.indexOf("clearLiveBridgeAlert()", liveSettingsStart),
  );
  assert.match(liveSettings, /createGeminiCaptionConfig/u);
  assert.match(liveSettings, /savedSettings\?\.subtitle/u);
  assert.doesNotMatch(liveSettings, /buildLiveCallGlossary/u);
});
