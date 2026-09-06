# Caption Engine Plan 1: Shared Catalog, Desktop Two-Stage Engine, Soniox Channel, Hot Swap, Spike

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop caption engine a provider/model catalog that the user can change in Settings and that takes effect immediately, restore the verified two-stage (STT → text translation) pipeline, and add a Soniox `stt-rt-v5` channel with a host language mode, plus a real-API spike script that decides the default provider.

**Architecture:** One shared catalog in `packages/caption-core` declares every allowed `{provider, model}` per role (stt / translation / summary) with capabilities. The desktop realtime manager is restored to HEAD `82db9e9`'s Transcribe-Live-transport + text-translation-lane design, then generalized so the transport is chosen from the catalog. Soniox is a "combined" provider: its channel emits both source and translation tokens, so lanes accept provider translations instead of calling Gemini Flash. Hot swap reuses `restartChannels`, now open-new-then-close-old, triggered by settings saves. Gateway and webapp changes are **Plan 2** (this plan keeps them compiling via the legacy `gemini-model-catalog.js` shim).

**Tech Stack:** Node 24, `node:test`, `ws`, existing `caption-core` package, Soniox WebSocket API (`wss://stt-rt.soniox.com/transcribe-websocket`), Gemini Live API Transcribe (`gemini-3.5-transcribe-live`).

**Spec:** `docs/superpowers/specs/2026-09-02-caption-engine-provider-hotswap-design.md`

## Global Constraints

- Root tests run with `npm test` (node:test, flat `test/*.test.js`); gateway with `npm --prefix media-gateway test`; typecheck `npm run typecheck`. All three must pass at the end of every task that touches shared code.
- Edit `public/` copies only for renderer files (root `subtitle-*.js` duplicates are dead; `test/session-transcripts.test.js` asserts byte-equality for `subtitle-dashboard.js`, `subtitle.html`, `subtitle.css` — mirror those three with `cp public/<f> <f>` after editing).
- No automatic provider/model substitution on provider failure (spec §0). Gemini text translation keeps the existing per-model one-attempt fallback chain only.
- API keys never appear in chat, logs, test fixtures (use `"fixture-key"`), or committed files. Desktop key slot is `apiKeys.soniox`; spike reads `~/.config/realtime-noel/soniox.env`.
- Live Call on the *installed* NOVA.app keeps working during this plan because nothing is reinstalled; `npm run desktop` Live Call against the deployed gateway is expected to be rejected (`SESSION_REVOKED`) until Plan 2 deploys the gateway. Local captions must work at every task boundary.
- Commit after each task with a conventional message; never `git add -A` (the tree has ~170 unrelated uncommitted files). Stage only the files named in the task.
- Korean UI copy: labels and values only, no explanatory paragraphs (project design rule).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/caption-core/caption-engine-catalog.js` (create) | SSOT: roles, providers, models, capabilities, defaults, `normalizeEngineSelection`, legacy migration, client view |
| `packages/caption-core/soniox-protocol.js` (create) | Pure Soniox wire helpers: config builder, token reducer (final append / non-final replace / `<end>` `<fin>` boundaries / segment ids), control payloads |
| `packages/caption-core/gemini-model-catalog.js` (modify) | Thin shim over the engine catalog so gateway/webapp/electron keep compiling until Plan 2; default source becomes `gemini-3.5-transcribe-live` |
| `packages/caption-core/gemini-caption-contract.js` (modify) | `createGeminiCaptionConfig` gains canonical `engine`; `models` derived from it; fingerprint covers `engine` |
| `packages/caption-core/index.js` (modify) | export new modules |
| `src/settings-store.js` (modify) | `subtitle.engine` default + validation + migration; `apiKeys.soniox`; `hasSonioxKey` |
| `src/subtitle-realtime.js` (rewrite from HEAD) | Manager + `createSourceTranscriptionClient` (transport-agnostic) + `createTextTranslationLane` (accepts provider translations) + open-new-first `restartChannels` |
| `src/caption-engine/create-stt-transport.js` (create) | picks Gemini Transcribe transport or Soniox transport from `engine.stt` |
| `src/caption-engine/soniox-transport.js` (create) | Soniox transport (same surface as `createGeminiTranscribeTransport`): binary audio, config first message, reducer → `onInterim`/`onFinal`/`onTranslation`/`onBoundary`, 1.5 s replay ring, keepalive |
| `src/server.js` (modify) | `/api/config.captionEngines`; settings save triggers `restartChannels` on engine/key change; remove idle guard; local start uses `engine` |
| `public/subtitle-model-settings.js`, `public/subtitle.html`, `public/subtitle-dashboard.js`, `public/subtitle-i18n.js`, `public/subtitle-i18n-ja.js` (modify) | Engine dropdowns (stt / language mode / translation / summary), Soniox key field |
| `scripts/engine-spike.mjs` (create) | Real-API comparison: Soniox auto/ko/en vs Gemini Transcribe on one WAV; prints metrics JSON |
| Delete | `src/gemini-live-translate.js`, `test/subtitle-direct-translation.test.js`, `test/direct-caption-model-contract.test.js`, `test/live-model-role-policy.test.js` (direct-translate pins), `packages/caption-core/gemini-source-audio.js`, `test/gemini-source-audio.test.js`, `packages/gemini-server/source-audio.test.js` |

---

### Task 1: Caption engine catalog (SSOT)

**Files:**
- Create: `packages/caption-core/caption-engine-catalog.js`
- Create: `test/caption-engine-catalog.test.js`
- Modify: `packages/caption-core/index.js`

**Interfaces:**
- Produces:
  - `CAPTION_ENGINE_CATALOG: { stt: EngineEntry[], translation: EngineEntry[], summary: EngineEntry[] }` where `EngineEntry = { provider, model, label, requiredApiKey, capability: { canRestrictSource, combinedSttTranslation, maxSessionMs, vocabularyLimit, languageModes }, fallbackModels?: string[], requiresSttProvider?: string }`
  - `DEFAULT_ENGINE_SELECTION: { stt: {provider, model, languageMode}, translation: {provider, model}, summary: {provider, model} }`
  - `normalizeEngineSelection(input): EngineSelection` (frozen canonical; throws `EngineSelectionError` code `ENGINE_SELECTION_INVALID`)
  - `migrateLegacyEngineSelection({ engine, geminiTranscribeModel, geminiSummaryModel, geminiPolishModel, geminiModel }): EngineSelection`
  - `isCombinedEngine(engine): boolean`
  - `engineRequiredApiKeys(engine): string[]`
  - `findEngineEntry(role, provider, model): EngineEntry | null`
  - `captionEngineCatalogForClient({ hasApiKeys }): { stt, translation, summary, defaults }` (adds `available: boolean` per entry)
  - `engineSelectionKey(engine): string` (stable JSON for change detection)

- [ ] **Step 1: Write the failing test**

```js
// test/caption-engine-catalog.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTION_ENGINE_CATALOG, DEFAULT_ENGINE_SELECTION, EngineSelectionError,
  captionEngineCatalogForClient, engineRequiredApiKeys, engineSelectionKey, findEngineEntry,
  isCombinedEngine, migrateLegacyEngineSelection, normalizeEngineSelection,
} from "../packages/caption-core/caption-engine-catalog.js";

test("default selection is Gemini Transcribe Live + Gemini 3.6 Flash + Gemini 3.6 Flash summary", () => {
  assert.deepEqual(DEFAULT_ENGINE_SELECTION, {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.6-flash" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  });
  assert.deepEqual(normalizeEngineSelection(undefined), DEFAULT_ENGINE_SELECTION);
  assert.ok(Object.isFrozen(normalizeEngineSelection(undefined)));
});

test("catalog entries carry capabilities and key requirements", () => {
  const soniox = findEngineEntry("stt", "soniox", "stt-rt-v5");
  assert.equal(soniox.requiredApiKey, "soniox");
  assert.equal(soniox.capability.canRestrictSource, true);
  assert.equal(soniox.capability.combinedSttTranslation, true);
  assert.deepEqual(soniox.capability.languageModes, ["auto", "ko", "en"]);
  const gemini = findEngineEntry("stt", "gemini", "gemini-3.5-transcribe-live");
  assert.equal(gemini.capability.canRestrictSource, false);
  assert.deepEqual(gemini.capability.languageModes, ["auto"]);
  assert.equal(findEngineEntry("stt", "gemini", "gemini-3.5-live-translate-preview"), null);
  assert.deepEqual(CAPTION_ENGINE_CATALOG.translation.map((entry) => `${entry.provider}:${entry.model}`),
    ["gemini:gemini-3.5-flash-lite", "gemini:gemini-3.6-flash", "gemini:gemini-3.7-flash", "soniox:stt-rt-v5"]);
});

test("normalize rejects unknown models, unknown modes, and soniox translation without soniox stt", () => {
  const base = DEFAULT_ENGINE_SELECTION;
  assert.throws(() => normalizeEngineSelection({ ...base, stt: { provider: "gemini", model: "gemini-9-flash", languageMode: "auto" } }),
    (error) => error instanceof EngineSelectionError && error.code === "ENGINE_SELECTION_INVALID");
  assert.throws(() => normalizeEngineSelection({ ...base, stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "ko" } }), EngineSelectionError);
  assert.throws(() => normalizeEngineSelection({ ...base, translation: { provider: "soniox", model: "stt-rt-v5" } }), EngineSelectionError);
  assert.throws(() => normalizeEngineSelection({ ...base, extra: 1 }), EngineSelectionError);
  const combined = normalizeEngineSelection({
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  });
  assert.equal(isCombinedEngine(combined), true);
  assert.equal(isCombinedEngine(DEFAULT_ENGINE_SELECTION), false);
  assert.deepEqual(engineRequiredApiKeys(combined), ["soniox", "gemini"]);
  assert.deepEqual(engineRequiredApiKeys(DEFAULT_ENGINE_SELECTION), ["gemini"]);
});

test("legacy Gemini fields migrate into engine and live-translate maps to transcribe", () => {
  const migrated = migrateLegacyEngineSelection({
    geminiTranscribeModel: "gemini-3.5-live-translate-preview",
    geminiSummaryModel: "gemini-3.7-flash",
    geminiPolishModel: "gemini-3.7-flash",
  });
  assert.deepEqual(migrated, {
    stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.7-flash" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  });
  const kept = migrateLegacyEngineSelection({ engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
    translation: { provider: "gemini", model: "gemini-3.5-flash-lite" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  }, geminiTranscribeModel: "gemini-3.5-live-translate-preview" });
  assert.equal(kept.stt.provider, "soniox", "explicit engine wins over legacy fields");
  assert.deepEqual(migrateLegacyEngineSelection({}), DEFAULT_ENGINE_SELECTION);
  assert.deepEqual(migrateLegacyEngineSelection({ geminiSummaryModel: "gemini-3.5-flash" }).summary,
    { provider: "gemini", model: "gemini-3.6-flash" }, "unknown legacy summary falls back to default");
});

test("client view marks entries unavailable when the key is missing", () => {
  const view = captionEngineCatalogForClient({ hasApiKeys: { gemini: true, soniox: false } });
  assert.equal(view.stt.find((entry) => entry.provider === "soniox").available, false);
  assert.equal(view.stt.find((entry) => entry.provider === "gemini").available, true);
  assert.deepEqual(view.defaults, DEFAULT_ENGINE_SELECTION);
  assert.equal(Object.hasOwn(view.stt[0], "requiredApiKey"), true);
});

test("selection key is stable across property order", () => {
  const a = engineSelectionKey({ summary: { model: "gemini-3.6-flash", provider: "gemini" }, translation: { provider: "gemini", model: "gemini-3.6-flash" }, stt: { languageMode: "auto", model: "gemini-3.5-transcribe-live", provider: "gemini" } });
  assert.equal(a, engineSelectionKey(DEFAULT_ENGINE_SELECTION));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/caption-engine-catalog.test.js`
Expected: FAIL with `Cannot find module '../packages/caption-core/caption-engine-catalog.js'`

- [ ] **Step 3: Write the catalog**

```js
// packages/caption-core/caption-engine-catalog.js
/**
 * Single source of truth for caption engine providers and models.
 * Desktop, gateway, and webapp all read this; nothing else may hard-code a
 * provider/model pair. Capabilities describe what the API contract allows,
 * not measured quality.
 */
export const ENGINE_ROLES = Object.freeze(["stt", "translation", "summary"]);
export const LANGUAGE_MODES = Object.freeze(["auto", "ko", "en"]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

const GEMINI_TRANSCRIBE = {
  provider: "gemini", model: "gemini-3.5-transcribe-live", label: "Gemini 3.5 Transcribe Live", requiredApiKey: "gemini",
  capability: { canRestrictSource: false, combinedSttTranslation: false, maxSessionMs: 600_000, vocabularyLimit: 1_000, languageModes: ["auto"] },
};
const SONIOX_RT = {
  provider: "soniox", model: "stt-rt-v5", label: "Soniox stt-rt-v5", requiredApiKey: "soniox",
  capability: { canRestrictSource: true, combinedSttTranslation: true, maxSessionMs: 18_000_000, vocabularyLimit: 10_000, languageModes: ["auto", "ko", "en"] },
};
const flash = (model, label, fallbackModels) => ({
  provider: "gemini", model, label, requiredApiKey: "gemini", fallbackModels,
  capability: { canRestrictSource: false, combinedSttTranslation: false, maxSessionMs: 0, vocabularyLimit: 0, languageModes: [] },
});

export const CAPTION_ENGINE_CATALOG = deepFreeze({
  stt: [GEMINI_TRANSCRIBE, SONIOX_RT],
  translation: [
    flash("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", ["gemini-3.6-flash"]),
    flash("gemini-3.6-flash", "Gemini 3.6 Flash", ["gemini-3.5-flash-lite"]),
    flash("gemini-3.7-flash", "Gemini 3.7 Flash", ["gemini-3.6-flash", "gemini-3.5-flash-lite"]),
    { ...SONIOX_RT, label: "Soniox stt-rt-v5 (STT 결합)", requiresSttProvider: "soniox" },
  ],
  summary: [
    flash("gemini-3.6-flash", "Gemini 3.6 Flash", ["gemini-3.7-flash"]),
    flash("gemini-3.7-flash", "Gemini 3.7 Flash", ["gemini-3.6-flash"]),
  ],
});

export const DEFAULT_ENGINE_SELECTION = deepFreeze({
  stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" },
  translation: { provider: "gemini", model: "gemini-3.6-flash" },
  summary: { provider: "gemini", model: "gemini-3.6-flash" },
});

export class EngineSelectionError extends Error {
  constructor(message = "지원하지 않는 엔진 조합입니다. 설정에서 모델을 다시 선택해 주세요.") {
    super(message);
    this.name = "EngineSelectionError";
    this.code = "ENGINE_SELECTION_INVALID";
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function findEngineEntry(role, provider, model) {
  const entries = CAPTION_ENGINE_CATALOG[role];
  if (!entries) return null;
  return entries.find((entry) => entry.provider === provider && entry.model === model) ?? null;
}

function normalizeRole(role, value) {
  if (value === undefined) return DEFAULT_ENGINE_SELECTION[role];
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") throw new EngineSelectionError();
  const allowedKeys = role === "stt" ? ["provider", "model", "languageMode"] : ["provider", "model"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new EngineSelectionError();
  const entry = findEngineEntry(role, value.provider, value.model);
  if (!entry) throw new EngineSelectionError();
  if (role !== "stt") return { provider: entry.provider, model: entry.model };
  const languageMode = value.languageMode === undefined ? "auto" : value.languageMode;
  if (!LANGUAGE_MODES.includes(languageMode) || !entry.capability.languageModes.includes(languageMode)) throw new EngineSelectionError();
  return { provider: entry.provider, model: entry.model, languageMode };
}

/** @param {unknown} input */
export function normalizeEngineSelection(input) {
  if (input === undefined || input === null) return DEFAULT_ENGINE_SELECTION;
  if (!isRecord(input) || Object.keys(input).some((key) => !ENGINE_ROLES.includes(key))) throw new EngineSelectionError();
  const stt = normalizeRole("stt", input.stt);
  const translation = normalizeRole("translation", input.translation);
  const summary = normalizeRole("summary", input.summary);
  const translationEntry = findEngineEntry("translation", translation.provider, translation.model);
  if (translationEntry.requiresSttProvider && translationEntry.requiresSttProvider !== stt.provider) throw new EngineSelectionError();
  return deepFreeze({ stt, translation, summary });
}

const LEGACY_SOURCE_TO_STT = Object.freeze({
  "gemini-3.5-transcribe-live": "gemini-3.5-transcribe-live",
  "gemini-3.5-live-translate-preview": "gemini-3.5-transcribe-live",
});
const LEGACY_FLASH = Object.freeze(["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash"]);

/**
 * Historical settings stored per-role Gemini model ids. An explicit `engine`
 * always wins; otherwise known legacy values are mapped and unknown values
 * fall back to defaults (never to a paid path the user did not choose).
 */
export function migrateLegacyEngineSelection(input = {}) {
  if (!isRecord(input)) return DEFAULT_ENGINE_SELECTION;
  if (input.engine !== undefined) return normalizeEngineSelection(input.engine);
  const sttModel = LEGACY_SOURCE_TO_STT[input.geminiTranscribeModel] ?? DEFAULT_ENGINE_SELECTION.stt.model;
  const translationModel = LEGACY_FLASH.includes(input.geminiPolishModel) ? input.geminiPolishModel : DEFAULT_ENGINE_SELECTION.translation.model;
  const summaryModel = LEGACY_FLASH.includes(input.geminiSummaryModel) && input.geminiSummaryModel !== "gemini-3.5-flash-lite"
    ? input.geminiSummaryModel : DEFAULT_ENGINE_SELECTION.summary.model;
  return normalizeEngineSelection({
    stt: { provider: "gemini", model: sttModel, languageMode: "auto" },
    translation: { provider: "gemini", model: translationModel },
    summary: { provider: "gemini", model: summaryModel },
  });
}

export function isCombinedEngine(engine) {
  const selection = normalizeEngineSelection(engine);
  const entry = findEngineEntry("stt", selection.stt.provider, selection.stt.model);
  return Boolean(entry?.capability.combinedSttTranslation) && selection.translation.provider === selection.stt.provider;
}

export function engineRequiredApiKeys(engine) {
  const selection = normalizeEngineSelection(engine);
  const keys = [];
  for (const role of ENGINE_ROLES) {
    const key = findEngineEntry(role, selection[role].provider, selection[role].model).requiredApiKey;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function engineSelectionKey(engine) {
  const selection = normalizeEngineSelection(engine);
  return JSON.stringify({
    stt: [selection.stt.provider, selection.stt.model, selection.stt.languageMode],
    translation: [selection.translation.provider, selection.translation.model],
    summary: [selection.summary.provider, selection.summary.model],
  });
}

/** Settings UI payload: never includes key values, only availability. */
export function captionEngineCatalogForClient({ hasApiKeys = {} } = {}) {
  const view = {};
  for (const role of ENGINE_ROLES) {
    view[role] = CAPTION_ENGINE_CATALOG[role].map((entry) => ({
      provider: entry.provider, model: entry.model, label: entry.label, requiredApiKey: entry.requiredApiKey,
      available: hasApiKeys[entry.requiredApiKey] === true,
      languageModes: [...entry.capability.languageModes],
      ...(entry.requiresSttProvider ? { requiresSttProvider: entry.requiresSttProvider } : {}),
    }));
  }
  view.defaults = DEFAULT_ENGINE_SELECTION;
  return view;
}
```

- [ ] **Step 4: Export from the package index**

Append to `packages/caption-core/index.js`:

```js
export {
  CAPTION_ENGINE_CATALOG, DEFAULT_ENGINE_SELECTION, ENGINE_ROLES, LANGUAGE_MODES, EngineSelectionError,
  captionEngineCatalogForClient, engineRequiredApiKeys, engineSelectionKey, findEngineEntry,
  isCombinedEngine, migrateLegacyEngineSelection, normalizeEngineSelection,
} from "./caption-engine-catalog.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/caption-engine-catalog.test.js`
Expected: 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/caption-core/caption-engine-catalog.js packages/caption-core/index.js test/caption-engine-catalog.test.js
git commit -m "feat(caption-core): add provider/model engine catalog as single source of truth"
```

---

### Task 2: Re-point the legacy Gemini model shim and caption config at the catalog

**Files:**
- Modify: `packages/caption-core/gemini-model-catalog.js`
- Modify: `packages/caption-core/gemini-caption-contract.js:1-60, 95-135, 140-160, 212-222`
- Modify: `test/caption-core-contract.test.js` (update expectations), Create: `test/caption-config-engine.test.js`

**Interfaces:**
- Consumes: `normalizeEngineSelection`, `migrateLegacyEngineSelection`, `DEFAULT_ENGINE_SELECTION`, `engineSelectionKey` (Task 1)
- Produces:
  - `createGeminiCaptionConfig(input)` returns `config.engine` (canonical selection) and `config.models = { transcription: engine.stt.model, summary: engine.summary.model, polish: "gemini-3.7-flash" }` (no `live`); accepts `input.engine` or legacy fields.
  - `readGeminiSelectedModel("source", v)` accepts only `"gemini-3.5-transcribe-live"`; `migrateLegacyGeminiModelSelection("source", "gemini-3.5-live-translate-preview")` returns `"gemini-3.5-transcribe-live"`; `DEFAULT_GEMINI_MODEL_SELECTION.source === "gemini-3.5-transcribe-live"`; `GEMINI_MODEL_CATALOG.source/translation` list the transcribe model. Summary API unchanged (`gemini-3.6-flash` default; `3.7` allowed via `readStoredGeminiModelSelection` and, new, via `readGeminiSelectedModel("summary","gemini-3.7-flash")`).

- [ ] **Step 1: Write the failing tests**

```js
// test/caption-config-engine.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint } from "../packages/caption-core/index.js";
import { DEFAULT_GEMINI_MODEL_SELECTION, migrateLegacyGeminiModelSelection, readGeminiSelectedModel } from "../packages/caption-core/gemini-model-catalog.js";

test("caption config carries a canonical engine and derives legacy models from it", () => {
  const config = createGeminiCaptionConfig({ translationLanguages: ["en", "ko"], engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.7-flash" },
  } });
  assert.equal(config.engine.stt.provider, "soniox");
  assert.equal(config.engine.stt.languageMode, "ko");
  assert.deepEqual(config.models, { transcription: "stt-rt-v5", summary: "gemini-3.7-flash", polish: "gemini-3.7-flash" });
  assert.equal(Object.hasOwn(config.models, "live"), false);
});

test("legacy live-translate settings migrate to Transcribe Live", () => {
  const config = createGeminiCaptionConfig({ translationLanguages: ["en", "ko"], geminiTranscribeModel: "gemini-3.5-live-translate-preview", geminiSummaryModel: "gemini-3.6-flash" });
  assert.deepEqual(config.engine.stt, { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" });
  assert.equal(config.models.transcription, "gemini-3.5-transcribe-live");
});

test("fingerprint changes when the engine changes", () => {
  const base = { translationLanguages: ["en", "ko"] };
  const a = geminiCaptionConfigFingerprint(createGeminiCaptionConfig(base));
  const b = geminiCaptionConfigFingerprint(createGeminiCaptionConfig({ ...base, engine: { ...createGeminiCaptionConfig(base).engine, stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" }, translation: { provider: "soniox", model: "stt-rt-v5" } } }));
  assert.notEqual(a, b);
});

test("legacy gemini model shim now defaults to Transcribe Live", () => {
  assert.equal(DEFAULT_GEMINI_MODEL_SELECTION.source, "gemini-3.5-transcribe-live");
  assert.equal(readGeminiSelectedModel("source", undefined), "gemini-3.5-transcribe-live");
  assert.equal(migrateLegacyGeminiModelSelection("source", "gemini-3.5-live-translate-preview"), "gemini-3.5-transcribe-live");
  assert.equal(readGeminiSelectedModel("summary", "gemini-3.7-flash"), "gemini-3.7-flash");
  assert.throws(() => readGeminiSelectedModel("source", "gemini-3.5-live-translate-preview"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/caption-config-engine.test.js`
Expected: FAIL (`config.engine` undefined; source default is live-translate)

- [ ] **Step 3: Rewrite `gemini-model-catalog.js` as a shim**

```js
// packages/caption-core/gemini-model-catalog.js
// Compatibility shim over caption-engine-catalog.js. Plan 2 replaces callers
// (gateway, webapp, electron) with the engine catalog and deletes this file.
import { CAPTION_ENGINE_CATALOG, DEFAULT_ENGINE_SELECTION, migrateLegacyEngineSelection } from "./caption-engine-catalog.js";

const sttModels = CAPTION_ENGINE_CATALOG.stt.filter((entry) => entry.provider === "gemini").map((entry) => ({ id: entry.model, label: entry.label }));
const summaryModels = CAPTION_ENGINE_CATALOG.summary.map((entry) => ({ id: entry.model, label: entry.label }));
export const GEMINI_MODEL_CATALOG = Object.freeze({ translation: sttModels, source: sttModels, summary: summaryModels });
export const DEFAULT_GEMINI_MODEL_SELECTION = Object.freeze({
  translation: DEFAULT_ENGINE_SELECTION.stt.model, source: DEFAULT_ENGINE_SELECTION.stt.model, summary: DEFAULT_ENGINE_SELECTION.summary.model,
});
export class GeminiModelSelectionError extends Error {
  constructor(message = "지원하지 않는 모델입니다. 설정에서 모델을 다시 선택해 주세요.") {
    super(message);
    this.code = "INVALID_GEMINI_MODEL_SELECTION";
  }
}
const allowed = (role) => (role === "summary" ? summaryModels : sttModels).map((entry) => entry.id);
export function readGeminiSelectedModel(role, value) {
  if (!["source", "summary", "translation"].includes(role)) throw new GeminiModelSelectionError();
  if (value === undefined) return DEFAULT_GEMINI_MODEL_SELECTION[role];
  if (typeof value === "string" && allowed(role).includes(value)) return value;
  throw new GeminiModelSelectionError();
}
/** Historical metadata is evidence of the old model, not a runtime override. */
export function readStoredGeminiModelSelection(role, value) {
  if (role !== "source" && role !== "summary") throw new GeminiModelSelectionError();
  if (role === "source" && ["gemini-3.5-transcribe-live", "gemini-3.5-live-translate-preview"].includes(value)) return value;
  if (["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"].includes(value)) return value;
  throw new GeminiModelSelectionError();
}
export function migrateLegacyGeminiModelSelection(role, value) {
  if (role === "source" || role === "translation") {
    return migrateLegacyEngineSelection({ geminiTranscribeModel: value }).stt.model;
  }
  if (role === "summary") return migrateLegacyEngineSelection({ geminiSummaryModel: value }).summary.model;
  throw new GeminiModelSelectionError();
}
```

- [ ] **Step 4: Update `createGeminiCaptionConfig`**

In `packages/caption-core/gemini-caption-contract.js`:

Replace the import line for the model catalog and the `DEFAULT_*_MODEL` constants:

```js
import { DEFAULT_ENGINE_SELECTION, migrateLegacyEngineSelection, normalizeEngineSelection } from "./caption-engine-catalog.js";
// ...
const DEFAULT_TRANSCRIPTION_MODEL = DEFAULT_ENGINE_SELECTION.stt.model;
const DEFAULT_POLISH_MODEL = "gemini-3.7-flash";
const DEFAULT_ANALYSIS_MODEL = DEFAULT_ENGINE_SELECTION.summary.model;
```

Replace `GEMINI_WORKLOAD_MODEL_MATRIX` and the `translation` block of `GEMINI_CAPTION_ENGINE_CONTRACT`:

```js
export const GEMINI_WORKLOAD_MODEL_MATRIX = deepFreeze({
  transcription: DEFAULT_TRANSCRIPTION_MODEL,
  source: DEFAULT_TRANSCRIPTION_MODEL,
  glossaryExtraction: DEFAULT_POLISH_MODEL,
  topic: DEFAULT_ANALYSIS_MODEL,
  translation: DEFAULT_ENGINE_SELECTION.translation.model,
  polish: DEFAULT_POLISH_MODEL,
  recap: DEFAULT_ANALYSIS_MODEL,
});

export const GEMINI_CAPTION_ENGINE_CONTRACT = deepFreeze({
  version: 5,
  provider: "gemini",
  voiceProvider: null,
  workloadModels: GEMINI_WORKLOAD_MODEL_MATRIX,
  maximumGlossaryCharacters: MAX_GLOSSARY_CHARACTERS,
  maximumDomainCharacters: MAX_DOMAIN_CHARACTERS,
  transcription: {
    model: DEFAULT_TRANSCRIPTION_MODEL,
    responseModalities: ["TEXT"],
    interimField: "interimInputTranscription",
    authoritativeField: "inputTranscription",
    inputMimeType: "audio/pcm;rate=16000",
  },
  // (keep retrieval / polish / deterministic / fallback / streaming blocks unchanged)
```

In `createGeminiCaptionConfig`, replace the `models:` block with:

```js
    engine,
    models: {
      transcription: engine.stt.model,
      summary: engine.summary.model,
      polish: fixedModel(input.geminiPolishModel ?? input.polishModel ?? input.models?.polish, DEFAULT_POLISH_MODEL),
    },
```

and, right after `assertAllowedModelInput(input);`, add:

```js
  const engine = input.engine !== undefined
    ? normalizeEngineSelection(input.engine)
    : migrateLegacyEngineSelection({
      geminiTranscribeModel: input.geminiTranscribeModel ?? input.transcriptionModel ?? input.transcribeModel ?? input.models?.transcription,
      geminiSummaryModel: input.geminiSummaryModel ?? input.summaryModel ?? input.models?.summary,
      geminiPolishModel: input.geminiPolishModel ?? input.polishModel ?? input.models?.polish,
    });
```

Replace `assertAllowedModelInput` body so it only rejects non-string `model`/non-object `models` (legacy live-translate values are now migrated, not rejected):

```js
function assertAllowedModelInput(input) {
  if (Object.hasOwn(input, "model") && typeof input.model !== "string") throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
  if (input.models !== undefined && (!input.models || typeof input.models !== "object" || Array.isArray(input.models)
    || Object.keys(input.models).some((key) => !["transcription", "polish", "summary"].includes(key)))) {
    throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
  }
  if (input.engine !== undefined && (!input.engine || typeof input.engine !== "object")) throw new Error("GEMINI_MODEL_OVERRIDE_FORBIDDEN");
}
```

In `geminiCaptionConfigFingerprint`, replace the canonical-config branch with `configOrInput` unchanged (the `engine` field is now part of the frozen config, so no re-migration is needed):

```js
  const config = isCanonicalConfig(configOrInput) ? configOrInput : createGeminiCaptionConfig(configOrInput);
```

Delete the now-unused `selectedModel` helper and the import of `readGeminiSelectedModel`/`GeminiModelSelectionError`/`migrateLegacyGeminiModelSelection` from this file.

- [ ] **Step 5: Run the new test and the contract tests**

Run: `node --test test/caption-config-engine.test.js test/caption-core-contract.test.js test/gemini-caption-contract.test.js`
Expected: new test PASS; fix any contract assertion that pinned `version: 4`, `models.live`, or the live-translate `translation` block by updating the expectation to the new shape (these are contract pins, not behaviour).

- [ ] **Step 6: Run whole root suite to see the blast radius**

Run: `npm test 2>&1 | grep -E "^not ok|✖" | head -40`
Expected: failures only in tests that pin `gemini-3.5-live-translate-preview` as the default source model (`test/direct-caption-model-contract.test.js`, `test/live-model-role-policy.test.js`, `test/subtitle-model-settings.test.js`, `test/desktop-live-model-preferences.test.js`, `test/server-model-selection-security.test.js`, `test/settings-store.test.js`, `test/subtitle-direct-translation.test.js`). Leave them failing for now; Tasks 3 and 4 replace them. Do NOT weaken tests unrelated to the model default.

- [ ] **Step 7: Commit**

```bash
git add packages/caption-core/gemini-model-catalog.js packages/caption-core/gemini-caption-contract.js test/caption-config-engine.test.js test/caption-core-contract.test.js test/gemini-caption-contract.test.js
git commit -m "feat(caption-core): canonical engine selection in caption config; transcribe-live is the gemini default again"
```

---

### Task 3: Settings store — `subtitle.engine`, `apiKeys.soniox`, migration

**Files:**
- Modify: `src/settings-store.js` (DEFAULT_SUBTITLE_SETTINGS ~L92-100, API_KEY_NAMES L119, `migrateSettings` ~L300-330, `validateSubtitleSettings` ~L595-610, `getSanitized` ~L243, `readFromDisk` ~L150)
- Modify: `test/settings-store.test.js`

**Interfaces:**
- Consumes: `normalizeEngineSelection`, `migrateLegacyEngineSelection`, `DEFAULT_ENGINE_SELECTION` (Task 1)
- Produces: `settings.subtitle.engine` (always present, canonical); `settings.apiKeys.soniox`; `getSanitized()` adds `hasSonioxKey`; legacy fields `geminiTranscribeModel`, `geminiSummaryModel`, `geminiPolishModel`, `geminiModel` removed from `subtitle` on load and rejected on save with `Subtitle model fields moved to subtitle.engine.`

- [ ] **Step 1: Write failing tests** (append to `test/settings-store.test.js`, using the file's existing `createTempStore`/tmp-dir helper; if the helper is named differently, reuse the one already in that file)

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern="engine" test/settings-store.test.js`
Expected: FAIL (`engine` undefined; `Unknown API key slot: soniox`)

- [ ] **Step 3: Implement**

In `src/settings-store.js`:

Imports: replace the two catalog imports with

```js
import { DEFAULT_ENGINE_SELECTION, engineSelectionKey, migrateLegacyEngineSelection, normalizeEngineSelection } from "../packages/caption-core/caption-engine-catalog.js";
```

`DEFAULT_SUBTITLE_SETTINGS`: remove `geminiTranscribeModel`, `geminiSummaryModel`, `geminiPolishModel`; add

```js
  engine: DEFAULT_ENGINE_SELECTION,
```

`API_KEY_NAMES`:

```js
export const API_KEY_NAMES = Object.freeze(["openai", "gemini", "geminiSecondary", "soniox"]);
```

`readFromDisk`: replace the rewrite condition with

```js
      const legacyPresent = ["geminiTranscribeModel", "geminiSummaryModel", "geminiPolishModel", "geminiModel"].some((key) => Object.hasOwn(parsed?.subtitle ?? {}, key));
      if (legacyPresent || engineSelectionKey(parsed?.subtitle?.engine ?? DEFAULT_ENGINE_SELECTION) !== engineSelectionKey(migrated.subtitle.engine)) await writeToDisk(migrated);
```

(`engineSelectionKey` throws on an invalid stored engine; wrap the left side in a try that treats a throw as "needs rewrite".)

`migrateSettings`: replace the block that assigns `geminiTranscribeModel`/`geminiSummaryModel`/`geminiPolishModel` with

```js
  // 2026-09-02: per-role Gemini model fields are replaced by the engine catalog selection.
  let engine;
  try {
    engine = migrateLegacyEngineSelection({
      engine: settings.subtitle.engine,
      geminiTranscribeModel: settings.subtitle.geminiTranscribeModel,
      geminiSummaryModel: settings.subtitle.geminiSummaryModel,
      geminiPolishModel: settings.subtitle.geminiPolishModel,
    });
  } catch {
    engine = DEFAULT_ENGINE_SELECTION;
  }
  settings.subtitle.engine = engine;
  for (const retiredKey of ["geminiTranscribeModel", "geminiSummaryModel", "geminiPolishModel", "audioLanguage", "audioVolume", "voiceProvider", "model", "geminiModel"]) {
    delete settings.subtitle[retiredKey];
  }
```

(Delete the older `retiredKey` loop and the `geminiPolishModel === "gemini-3.5-flash"` block that this replaces.)

`validateSubtitleSettings`: replace the `geminiTranscribeModel`/`geminiSummaryModel`/`geminiPolishModel` checks with

```js
  for (const legacy of ["geminiTranscribeModel", "geminiSummaryModel", "geminiPolishModel", "geminiModel"]) {
    if (value[legacy] !== undefined) throw new Error("Subtitle model fields moved to subtitle.engine.");
  }
  if (value.engine !== undefined) normalizeEngineSelection(value.engine);
```

`getSanitized`: add `hasSonioxKey: Boolean(apiKeys?.soniox),`.

`seedFromEnv`: add

```js
  const sonioxKey = trimOrEmpty(env.SONIOX_API_KEY);
  if (sonioxKey) next.apiKeys.soniox = sonioxKey;
```

- [ ] **Step 4: Run settings tests**

Run: `node --test test/settings-store.test.js`
Expected: PASS. Existing assertions that expected `subtitle.geminiTranscribeModel` to exist must be updated to assert `subtitle.engine` instead (search the file for `geminiTranscribeModel`).

- [ ] **Step 5: Commit**

```bash
git add src/settings-store.js test/settings-store.test.js
git commit -m "feat(settings): subtitle.engine selection with legacy migration and soniox key slot"
```

---

### Task 4: Restore the two-stage desktop engine from HEAD and adapt it to `engine`

**Files:**
- Rewrite: `src/subtitle-realtime.js` (from `git show HEAD:src/subtitle-realtime.js`)
- Restore: `test/subtitle-realtime-transcribe.test.js`, `test/subtitle-realtime.test.js`, `test/subtitle-direction-switch.test.js`, `test/subtitle-stop-clear.test.js`, `test/subtitle-restart-watchdog.test.js` from HEAD
- Delete: `src/gemini-live-translate.js`, `test/subtitle-direct-translation.test.js`, `test/direct-caption-model-contract.test.js`, `test/live-model-role-policy.test.js`, `packages/caption-core/gemini-source-audio.js`, `test/gemini-source-audio.test.js`, `packages/gemini-server/source-audio.test.js`
- Modify: `src/server.js` (local start settings block ~L1146-1162; `/api/config` ~L440-446; remove `assertModelSettingsChangeIsIdle` ~L735-760)

**Interfaces:**
- Consumes: `createGeminiCaptionConfig(...).engine` (Task 2)
- Produces: `createSubtitleRealtimeManager(options)` with the HEAD surface `{ start, sendAudio, stop, close, restartChannels, noteInputSignal, _state }`; `normalizeSubtitleSettings(settings)` returns `engine` (canonical) instead of `geminiTranscribeModel`/`geminiModel`; internal `createSourceTranscriptionClient({ transport, ... })` takes a **transport** instead of building the Gemini one (Task 5 supplies Soniox).

- [ ] **Step 1: Restore HEAD sources and tests**

```bash
git show HEAD:src/subtitle-realtime.js > src/subtitle-realtime.js
for f in subtitle-realtime-transcribe subtitle-realtime subtitle-direction-switch subtitle-stop-clear subtitle-restart-watchdog; do git show HEAD:test/$f.test.js > test/$f.test.js; done
git rm -q src/gemini-live-translate.js test/subtitle-direct-translation.test.js test/direct-caption-model-contract.test.js test/live-model-role-policy.test.js packages/caption-core/gemini-source-audio.js test/gemini-source-audio.test.js packages/gemini-server/source-audio.test.js
```

- [ ] **Step 2: Run the restored tests to see what the WT-side changes broke**

Run: `node --test test/subtitle-realtime-transcribe.test.js test/subtitle-realtime.test.js`
Expected: some FAIL because `normalizeSubtitleSettings` still emits `geminiTranscribeModel` and `createGeminiCaptionConfig` now reads `engine`; note the exact failures.

- [ ] **Step 3: Adapt `normalizeSubtitleSettings` and `normalizeRealtimeModel`**

In `src/subtitle-realtime.js`, add the import

```js
import { normalizeEngineSelection } from "../packages/caption-core/caption-engine-catalog.js";
```

In `normalizeSubtitleSettings`, replace `geminiTranscribeModel: "gemini-3.5-transcribe-live",` with

```js
    engine: normalizeEngineSelection(merged.engine),
```

and replace `normalizeRealtimeModel` with

```js
export function normalizeRealtimeModel(model) {
  void model;
  return normalizeEngineSelection(undefined).stt.model;
}
```

- [ ] **Step 4: Make `createSourceTranscriptionClient` transport-agnostic**

Change its signature/first lines from

```js
function createSourceTranscriptionClient({ source, settings, captionConfig, apiKey, createWebSocket, broadcast, log, polish, polishTimeoutMs, setupAckTimeoutMs, partialTranslationDebounceMs, transcribeRolloverMs, transcribeFinalDrainMs, reconnectBaseMs }) {
  const vocabulary = selectGeminiTranscriptionVocabularyFromLegacyText(settings.glossary);
  const transport = createGeminiTranscribeTransport({ apiKey, customVocabulary: vocabulary });
```

to

```js
function createSourceTranscriptionClient({ source, settings, captionConfig, transport, createWebSocket, broadcast, log, polish, polishTimeoutMs, setupAckTimeoutMs, partialTranslationDebounceMs, transcribeRolloverMs, transcribeFinalDrainMs, reconnectBaseMs }) {
  const providerLabel = transport.providerLabel ?? "Gemini Transcribe";
  const maximumSessionMs = transport.maximumSessionMilliseconds ?? geminiTranscribeContract.maximumSessionMilliseconds;
```

then: replace every `"Gemini Transcribe` inside broadcast messages of this function with `` `${providerLabel} `` (template string), replace `geminiTranscribeContract.maximumSessionMilliseconds - 1` with `maximumSessionMs - 1`, replace the `if (!String(apiKey ?? "").trim()) throw ...` line in `ensureSocket` with `if (typeof transport.assertReady === "function") transport.assertReady();`, and in the `message` handler add two optional callbacks after `onFinal`:

```js
        onTranslation: (event) => { for (const lane of lanes) if (lane.targetLanguage === event.targetLanguage) lane.acceptProviderTranslation(event); },
        onBoundary: (kind) => { for (const lane of lanes) lane.onProviderBoundary?.(kind); },
```

In `ensureClient` (manager), replace `apiKey: state.apiKeys.gemini,` with

```js
      transport: createSttTransport({ engine: state.settings.engine, settings: state.settings, apiKeys: state.apiKeys }),
```

and import `createSttTransport` from `./caption-engine/create-stt-transport.js` (created in Step 5). In `start()` and `restartChannels()`, replace the `if (!apiKeys.gemini) throw ...` / `if (!apiKey) throw ...` checks with

```js
    const missingKey = engineRequiredApiKeys(normalizedSettings.engine).find((name) => !apiKeys[name]);
    if (missingKey) throw new Error(`${missingKey} API key is required for the selected caption engine.`);
```

and read keys as

```js
    const apiKeys = {
      gemini: String(saved.apiKeys?.gemini || env.GEMINI_API_KEY || "").trim(),
      geminiSecondary: String(saved.apiKeys?.geminiSecondary || env.GEMINI_SECONDARY_API_KEY || "").trim(),
      soniox: String(saved.apiKeys?.soniox || env.SONIOX_API_KEY || "").trim(),
    };
```

(import `engineRequiredApiKeys` from the catalog; in `restartChannels` set `state.apiKeys = apiKeys` with all three slots.)

- [ ] **Step 5: Create the transport factory (Gemini only for now)**

```js
// src/caption-engine/create-stt-transport.js
import { createGeminiTranscribeTransport, geminiTranscribeContract } from "../gemini-live-transcribe.js";
import { selectGeminiTranscriptionVocabularyFromLegacyText } from "../../packages/caption-core/index.js";
import { normalizeEngineSelection } from "../../packages/caption-core/caption-engine-catalog.js";

/**
 * Picks the STT transport for the selected engine. Every transport exposes:
 * { requiresSetupAck, providerLabel, maximumSessionMilliseconds, assertReady(),
 *   connect({createWebSocket}), setupPayloads(), audioPayload(base64Pcm24k),
 *   handleMessage(raw, ctx), closePayload() }
 * ctx callbacks: onTransportReady, onInterim, onFinal, onTranslation?, onBoundary?, onServerGoAway, broadcast
 */
export function createSttTransport({ engine, settings, apiKeys, createSonioxTransportImpl }) {
  const selection = normalizeEngineSelection(engine);
  if (selection.stt.provider === "gemini") {
    const apiKey = apiKeys?.gemini ?? "";
    const transport = createGeminiTranscribeTransport({ apiKey, customVocabulary: selectGeminiTranscriptionVocabularyFromLegacyText(settings.glossary) });
    return Object.assign(transport, {
      providerLabel: "Gemini Transcribe",
      maximumSessionMilliseconds: geminiTranscribeContract.maximumSessionMilliseconds,
      assertReady() { if (!String(apiKey).trim()) throw new Error("Gemini API key is required for realtime subtitles."); },
    });
  }
  if (selection.stt.provider === "soniox") {
    if (typeof createSonioxTransportImpl !== "function") throw new Error("SONIOX_TRANSPORT_UNAVAILABLE");
    return createSonioxTransportImpl({ engine: selection, settings, apiKey: apiKeys?.soniox ?? "" });
  }
  throw new Error("ENGINE_SELECTION_INVALID");
}
```

- [ ] **Step 6: Give lanes the provider-translation entry point (no-op for Gemini)**

In `createTextTranslationLane`, add to the returned object `targetLanguage`, and two methods:

```js
    targetLanguage,
    acceptProviderTranslation(event) {
      // Combined providers (Soniox) deliver the translation themselves; the
      // Gemini text lane never receives this. Partial → preview text, final →
      // committed through the same finalizer so glossary repair still runs.
      if (closed) return;
      const sourceText = boundTranscript(event.sourceText ?? "").trim();
      const sourceLanguage = normalizeProviderLanguageCode(event.sourceLanguage) || resolveSourceLanguage({ text: sourceText, languageCode: event.sourceLanguage });
      const translationRole = resolveTranslationRole(sourceText || event.text, sourceLanguage);
      if (!translationRole) return;
      const corrected = stripSubtitlePrefix(termRetriever.repair(boundTranscript(event.text).normalize("NFC"), { language: targetLanguage, isFinal: event.isFinal }));
      if (!corrected || !isTargetOutputSupported(corrected)) return;
      if (!event.isFinal) {
        broadcast({ type: "subtitle:partial", source, targetLanguage, sourceLanguage, translationRole, translationProvider: event.provider,
          sourceText, translatedText: corrected, isAuthoritative: false, segmentId: event.segmentId });
        return;
      }
      invalidatePreview();
      broadcast({ type: "subtitle:committed", source, targetLanguage, sourceLanguage, translationRole, translationProvider: event.provider,
        sourceText, translatedText: applyGlossaryCorrections(corrected, { glossary: captionConfig.glossary, sourceText, targetLanguage }).trim(),
        isAuthoritative: true, segmentId: event.segmentId });
    },
    onProviderBoundary(kind) { if (kind === "interrupted") invalidatePreview(); },
```

Also change `commit(event)` so combined providers do not double-translate: at the top of `commitNow`, add

```js
    if (event.providerTranslated) return; // Soniox already committed this segment's translation via acceptProviderTranslation
```

(`providerTranslated` is set by the Soniox transport on its `onFinal` events, Task 5.) Add a lane-level test in `test/subtitle-realtime-transcribe.test.js`:

```js
test("a provider-delivered translation is committed without a text-translation call", async (t) => {
  const h = createHarness(t, { settings: { translationLanguages: ["en", "ko"] } });
  await h.manager.start({ sessionId: "fixture", settings: {} });
  const socket = h.sockets.at(-1); socket.ready();
  // simulate the transport surfacing a combined-provider translation
  h.manager._state.clients.get("mic")._lanesForTest?.(); // no-op guard if not exposed
  socket.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "안녕하세요", languageCode: "ko" } } }));
  await tick();
  assert.equal(h.textCalls(), 0);
});
```

(If the harness has no `textCalls` accessor, add `textCalls: () => textCalls` to its return value.)

- [ ] **Step 7: Update `src/server.js`**

Replace the local-start model pin block (the `readGeminiSelectedModel("source"...)` / `summaryModel` lines and the `startSettings = {...}` that spreads `geminiTranscribeModel`, `transcriptionModel`, …) with

```js
                  const saved = await options.settingsStore?.load();
                  if (client !== subtitleSessionProducer || subtitleSessionId !== requestedSessionId || isSubtitleSessionStopping) return;
                  // Local WS requests cannot override the saved engine selection.
                  startSettings = { ...(message.settings ?? {}), engine: saved?.subtitle?.engine };
```

Delete `assertModelSettingsChangeIsIdle` and its call in `saveSettingsPatch` (keep `saveSettingsPatch` as a plain pass-through to `options.settingsStore.save`; remove `pendingModelSettingsWrites` if nothing else reads it). Replace the `/api/config` `captionModels` line with

```js
      captionEngines: captionEngineCatalogForClient({ hasApiKeys: { gemini: Boolean(sanitized?.hasGeminiKey), soniox: Boolean(sanitized?.hasSonioxKey) } }),
```

and import `captionEngineCatalogForClient` from `../packages/caption-core/caption-engine-catalog.js`; remove the now-unused `DEFAULT_GEMINI_MODEL_SELECTION, GEMINI_MODEL_CATALOG, readGeminiSelectedModel` import.

- [ ] **Step 8: Run root suite and typecheck**

Run: `npm test 2>&1 | tail -8 && npm run typecheck`
Expected: PASS except tests that pin the old model UI (`test/subtitle-model-settings.test.js`, `test/server-model-selection-security.test.js`, `test/desktop-live-model-preferences.test.js`) — Task 7 handles those. Any other failure is a regression to fix here.

- [ ] **Step 9: Commit**

```bash
git add src/subtitle-realtime.js src/caption-engine/create-stt-transport.js src/server.js test/subtitle-realtime-transcribe.test.js test/subtitle-realtime.test.js test/subtitle-direction-switch.test.js test/subtitle-stop-clear.test.js test/subtitle-restart-watchdog.test.js
git commit -m "feat(desktop): restore two-stage caption engine and select the STT transport from the engine catalog"
```

---

### Task 5: Soniox protocol (pure) and desktop transport

**Files:**
- Create: `packages/caption-core/soniox-protocol.js`, `test/soniox-protocol.test.js`
- Create: `src/caption-engine/soniox-transport.js`, `test/soniox-transport.test.js`
- Modify: `packages/caption-core/index.js`, `src/caption-engine/create-stt-transport.js` (wire `createSonioxTransportImpl` default), `src/subtitle-realtime.js` (binary send)

**Interfaces:**
- Produces (protocol):
  - `buildSonioxConfig({ apiKey, model, languageMode, languages, translation, context, clientReferenceId })` → plain object (first WS message). `languageMode: "auto"` → `language_hints: ["ko","en"]`, `language_hints_strict: true`; `"ko"`/`"en"` → single hint, strict.
  - `createSonioxTokenReducer({ onSourcePartial, onSourceFinal, onTranslationPartial, onTranslationFinal, onBoundary })` → `{ apply(result), reset() }`. Events: `{ text, language, sourceLanguage, segmentId, startMs, endMs, isFinal }`.
  - `SONIOX_CONTROL = { finalize: '{"type":"finalize"}', keepalive: '{"type":"keepalive"}' }`, `SONIOX_ENDPOINTS = { us, jp }`.
- Produces (transport): `createSonioxTransport({ engine, settings, apiKey, endpoint = "us", now })` with the transport surface from Task 4 plus `binaryAudio: true` and `replayRingBytes = 48_000`.
- Consumes: transport surface from Task 4 (`onInterim`, `onFinal`, `onTranslation`, `onBoundary`).

- [ ] **Step 1: Write failing protocol tests**

```js
// test/soniox-protocol.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import { SONIOX_CONTROL, buildSonioxConfig, createSonioxTokenReducer } from "../packages/caption-core/soniox-protocol.js";

test("config: auto mode restricts to ko+en, single modes pin one language, two_way for two languages", () => {
  const auto = buildSonioxConfig({ apiKey: "fixture-key", languageMode: "auto", languages: ["en", "ko"], translation: true, context: { terms: ["NOVA"] }, clientReferenceId: "s1" });
  assert.equal(auto.model, "stt-rt-v5");
  assert.deepEqual([auto.audio_format, auto.sample_rate, auto.num_channels], ["pcm_s16le", 16000, 1]);
  assert.deepEqual(auto.language_hints, ["ko", "en"]);
  assert.equal(auto.language_hints_strict, true);
  assert.deepEqual(auto.translation, { type: "two_way", language_a: "ko", language_b: "en" });
  assert.equal(auto.enable_endpoint_detection, true);
  assert.equal(auto.max_endpoint_delay_ms, 2000);
  const ko = buildSonioxConfig({ apiKey: "fixture-key", languageMode: "ko", languages: ["en", "ko"], translation: true });
  assert.deepEqual(ko.language_hints, ["ko"]);
  const none = buildSonioxConfig({ apiKey: "fixture-key", languageMode: "auto", languages: ["en", "ko"], translation: false });
  assert.equal(Object.hasOwn(none, "translation"), false);
  assert.throws(() => buildSonioxConfig({ apiKey: "", languageMode: "auto", languages: ["en", "ko"] }), /SONIOX_API_KEY_REQUIRED/u);
  assert.throws(() => buildSonioxConfig({ apiKey: "k", languageMode: "auto", languages: ["en", "ko", "ja"], translation: true }), /SONIOX_TRANSLATION_PAIR/u);
});

test("reducer: finals append, non-finals replace, <end> commits a segment with timestamps", () => {
  const events = [];
  const reducer = createSonioxTokenReducer({
    onSourcePartial: (e) => events.push(["sp", e.text]),
    onSourceFinal: (e) => events.push(["sf", e.text, e.startMs, e.endMs, e.language]),
    onTranslationPartial: (e) => events.push(["tp", e.text, e.language]),
    onTranslationFinal: (e) => events.push(["tf", e.text, e.language, e.sourceLanguage]),
    onBoundary: (kind) => events.push(["b", kind]),
  });
  reducer.apply({ tokens: [
    { text: "안녕", is_final: true, translation_status: "original", language: "ko", start_ms: 600, end_ms: 800 },
    { text: "하세", is_final: false, translation_status: "original", language: "ko" },
  ] });
  reducer.apply({ tokens: [
    { text: "하세요", is_final: true, translation_status: "original", language: "ko", start_ms: 800, end_ms: 1040 },
    { text: "Hel", is_final: false, translation_status: "translation", language: "en", source_language: "ko" },
  ] });
  reducer.apply({ tokens: [
    { text: "Hello", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<end>", is_final: true },
  ] });
  assert.deepEqual(events, [
    ["sp", "안녕하세"],
    ["sp", "안녕하세요"],
    ["tp", "Hel", "en"],
    ["tp", "Hello", "en"],
    ["sf", "안녕하세요", 600, 1040, "ko"],
    ["tf", "Hello", "en", "ko"],
    ["b", "endpoint"],
  ]);
});

test("reducer: keeps Korean spacing (no trim/join), ignores <fin> text, same segmentId for source and translation", () => {
  const seen = [];
  const reducer = createSonioxTokenReducer({
    onSourcePartial() {}, onTranslationPartial() {},
    onSourceFinal: (e) => seen.push(["s", e.text, e.segmentId]),
    onTranslationFinal: (e) => seen.push(["t", e.text, e.segmentId]),
    onBoundary: (kind) => seen.push(["b", kind]),
  });
  reducer.apply({ tokens: [
    { text: "이번", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 200 },
    { text: " 분기", is_final: true, translation_status: "original", language: "ko", start_ms: 200, end_ms: 400 },
    { text: "This quarter", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<fin>", is_final: true },
  ] });
  assert.equal(seen[0][1], "이번 분기");
  assert.equal(seen[1][1], "This quarter");
  assert.equal(seen[0][2], seen[1][2]);
  assert.deepEqual(seen[2], ["b", "manual-finalize"]);
  assert.equal(SONIOX_CONTROL.keepalive, '{"type":"keepalive"}');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/soniox-protocol.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the protocol module**

```js
// packages/caption-core/soniox-protocol.js
// Pure Soniox wire helpers shared by the desktop transport and the gateway adapter.
// Source: soniox.com/docs/api-reference/stt/websocket-api, /docs/stt/rt/real-time-translation,
// /docs/stt/concepts/language-restrictions (fetched 2026-09-02).
export const SONIOX_MODEL = "stt-rt-v5";
export const SONIOX_ENDPOINTS = Object.freeze({
  us: "wss://stt-rt.soniox.com/transcribe-websocket",
  jp: "wss://stt-rt.jp.soniox.com/transcribe-websocket",
});
export const SONIOX_CONTROL = Object.freeze({ finalize: '{"type":"finalize"}', keepalive: '{"type":"keepalive"}' });
const AUTO_LANGUAGES = Object.freeze(["ko", "en"]);
const MAX_CONTEXT_CHARACTERS = 9_000; // documented cap ≈ 10,000 chars / 8,000 tokens; stay under it

function boundedTerms(values, limit) {
  const out = [];
  let used = 0;
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw ?? "").normalize("NFC").trim();
    if (!value || /[ -\p{Cf}]/u.test(value)) continue;
    if (used + value.length > limit) break;
    out.push(value); used += value.length;
  }
  return out;
}

export function buildSonioxConfig({ apiKey, model = SONIOX_MODEL, languageMode = "auto", languages = ["en", "ko"], translation = true, context = {}, clientReferenceId = "" } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("SONIOX_API_KEY_REQUIRED");
  if (model !== SONIOX_MODEL) throw new Error("SONIOX_MODEL_INVALID");
  const hints = languageMode === "auto" ? [...AUTO_LANGUAGES] : [languageMode];
  if (!hints.every((code) => AUTO_LANGUAGES.includes(code))) throw new Error("SONIOX_LANGUAGE_MODE_INVALID");
  const config = {
    api_key: apiKey, model, audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1,
    language_hints: hints, language_hints_strict: true, enable_language_identification: true,
    enable_speaker_diarization: false, enable_endpoint_detection: true,
    endpoint_latency_adjustment_level: 0, endpoint_sensitivity: 0.0, max_endpoint_delay_ms: 2000,
    ...(clientReferenceId ? { client_reference_id: String(clientReferenceId).slice(0, 128) } : {}),
  };
  const terms = boundedTerms(context.terms, MAX_CONTEXT_CHARACTERS / 2);
  const translationTerms = (Array.isArray(context.translationTerms) ? context.translationTerms : [])
    .filter((pair) => pair && typeof pair.source === "string" && typeof pair.target === "string" && pair.source.trim() && pair.target.trim())
    .slice(0, 200).map((pair) => ({ source: pair.source.trim(), target: pair.target.trim() }));
  const general = typeof context.domain === "string" && context.domain.trim() ? [{ key: "domain", value: context.domain.trim().slice(0, 500) }] : [];
  if (terms.length || translationTerms.length || general.length) config.context = { ...(general.length ? { general } : {}), ...(terms.length ? { terms } : {}), ...(translationTerms.length ? { translation_terms: translationTerms } : {}) };
  if (translation) {
    const targets = [...new Set(languages)];
    if (targets.length !== 2) throw new Error("SONIOX_TRANSLATION_PAIR_REQUIRED");
    const [a, b] = targets.includes("ko") ? ["ko", targets.find((code) => code !== "ko")] : targets;
    config.translation = { type: "two_way", language_a: a, language_b: b };
  }
  return config;
}

/**
 * Token reducer per Soniox semantics: final tokens append once; non-final
 * tokens are the current provisional suffix and replace the previous one;
 * `<end>` / `<fin>` close a segment. Tokens may be sub-words or spaces, so
 * text is concatenated verbatim (never trimmed or space-joined).
 */
export function createSonioxTokenReducer({ onSourcePartial, onSourceFinal, onTranslationPartial, onTranslationFinal, onBoundary, makeSegmentId = defaultSegmentId }) {
  let segmentId = makeSegmentId();
  let source = { committed: "", preview: "", language: null, startMs: null, endMs: null };
  const translations = new Map(); // language -> { committed, preview, sourceLanguage }
  const laneFor = (language) => {
    const key = language ?? "unknown";
    if (!translations.has(key)) translations.set(key, { committed: "", preview: "", sourceLanguage: null });
    return translations.get(key);
  };
  function emitSegment(kind) {
    if (source.committed.trim()) {
      onSourceFinal({ text: source.committed, language: source.language, sourceLanguage: null, segmentId, startMs: source.startMs, endMs: source.endMs, isFinal: true });
    }
    for (const [language, lane] of translations) {
      if (lane.committed.trim()) onTranslationFinal({ text: lane.committed, language, sourceLanguage: lane.sourceLanguage, segmentId, startMs: null, endMs: null, isFinal: true });
    }
    onBoundary(kind, { segmentId });
    reset();
  }
  function reset() {
    segmentId = makeSegmentId();
    source = { committed: "", preview: "", language: null, startMs: null, endMs: null };
    translations.clear();
  }
  return {
    reset,
    apply(result) {
      const tokens = Array.isArray(result?.tokens) ? result.tokens : [];
      let sourceChanged = false;
      const changedTranslations = new Set();
      let sourcePreview = "";
      const translationPreview = new Map();
      for (const token of tokens) {
        if (!token || typeof token.text !== "string") continue;
        if (token.text === "<end>") { emitSegment("endpoint"); continue; }
        if (token.text === "<fin>") { emitSegment("manual-finalize"); continue; }
        if (token.translation_status === "translation") {
          const lane = laneFor(token.language);
          lane.sourceLanguage = token.source_language ?? lane.sourceLanguage;
          if (token.is_final) lane.committed += token.text;
          else translationPreview.set(token.language ?? "unknown", (translationPreview.get(token.language ?? "unknown") ?? "") + token.text);
          changedTranslations.add(token.language ?? "unknown");
          continue;
        }
        source.language = token.language ?? source.language;
        if (token.is_final) {
          source.committed += token.text;
          if (Number.isFinite(token.start_ms)) source.startMs = source.startMs === null ? token.start_ms : Math.min(source.startMs, token.start_ms);
          if (Number.isFinite(token.end_ms)) source.endMs = source.endMs === null ? token.end_ms : Math.max(source.endMs, token.end_ms);
        } else {
          sourcePreview += token.text;
        }
        sourceChanged = true;
      }
      if (sourceChanged) {
        source.preview = sourcePreview;
        const text = source.committed + source.preview;
        if (text.trim()) onSourcePartial({ text, language: source.language, sourceLanguage: null, segmentId, startMs: source.startMs, endMs: source.endMs, isFinal: false });
      }
      for (const language of changedTranslations) {
        const lane = laneFor(language);
        lane.preview = translationPreview.get(language) ?? "";
        const text = lane.committed + lane.preview;
        if (text.trim()) onTranslationPartial({ text, language, sourceLanguage: lane.sourceLanguage, segmentId, startMs: null, endMs: null, isFinal: false });
      }
    },
  };
}

let segmentCounter = 0;
function defaultSegmentId() {
  segmentCounter = (segmentCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `sx-${Date.now().toString(36)}-${segmentCounter.toString(36)}`;
}
```

Export from `packages/caption-core/index.js`:

```js
export { SONIOX_CONTROL, SONIOX_ENDPOINTS, SONIOX_MODEL, buildSonioxConfig, createSonioxTokenReducer } from "./soniox-protocol.js";
```

- [ ] **Step 4: Run protocol tests**

Run: `node --test test/soniox-protocol.test.js`
Expected: 3 PASS. (Check the second test's expected event order against the implementation: partial events fire per `apply`, finals fire on `<end>`. If the order differs only because both source and translation partials fire in the same `apply`, adjust the expectation to the implementation's deterministic order — source first, then translations — not the other way round.)

- [ ] **Step 5: Write the failing transport test**

```js
// test/soniox-transport.test.js
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createSonioxTransport } from "../src/caption-engine/soniox-transport.js";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING; sent = []; bufferedAmount = 0;
  send(value) { this.sent.push(value); }
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close", 1000, Buffer.alloc(0)); }
}
const pcm24k = (value = 1) => Buffer.alloc(4_800, value).toString("base64");

test("first message is the config JSON, audio goes out as binary 16 kHz, replay ring resends on new socket", () => {
  const transport = createSonioxTransport({ engine: { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" }, translation: { provider: "soniox", model: "stt-rt-v5" }, summary: { provider: "gemini", model: "gemini-3.6-flash" } },
    settings: { translationLanguages: ["en", "ko"], glossary: "NOVA = 노바", translationDomain: "CRE" }, apiKey: "fixture-key", now: () => 1000 });
  assert.equal(transport.requiresSetupAck, false);
  assert.equal(transport.binaryAudio, true);
  const [setup] = transport.setupPayloads();
  const config = JSON.parse(setup);
  assert.deepEqual(config.language_hints, ["ko"]);
  assert.equal(config.translation.type, "two_way");
  assert.ok(config.context.terms.includes("NOVA"));
  assert.equal(setup.includes("fixture-key"), true, "api key travels only in the first message");
  const frame = transport.audioPayload(pcm24k());
  assert.ok(Buffer.isBuffer(frame));
  assert.equal(frame.length, 3_200, "4,800 bytes of 24 kHz PCM resample to 3,200 bytes at 16 kHz");
  const replay = transport.replayPayloads();
  assert.equal(replay.length, 1);
  assert.equal(replay[0].length, 3_200);
});

test("handleMessage maps tokens to onInterim/onFinal/onTranslation and marks finals providerTranslated", () => {
  const transport = createSonioxTransport({ engine: { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" }, translation: { provider: "soniox", model: "stt-rt-v5" }, summary: { provider: "gemini", model: "gemini-3.6-flash" } },
    settings: { translationLanguages: ["en", "ko"], glossary: "" }, apiKey: "fixture-key" });
  const seen = [];
  const ctx = {
    onTransportReady: () => seen.push(["ready"]),
    onInterim: (e) => seen.push(["interim", e.text, e.languageCode]),
    onFinal: (e) => seen.push(["final", e.text, e.languageCode, e.providerTranslated]),
    onTranslation: (e) => seen.push(["tr", e.targetLanguage, e.text, e.isFinal, e.provider]),
    onBoundary: (kind) => seen.push(["b", kind]),
    onError: (code) => seen.push(["err", code]),
  };
  transport.handleMessage(Buffer.from(JSON.stringify({ tokens: [
    { text: "안녕하세요", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 900 },
    { text: "Hello", is_final: false, translation_status: "translation", language: "en", source_language: "ko" },
  ] })), ctx);
  transport.handleMessage(Buffer.from(JSON.stringify({ tokens: [
    { text: "Hello", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<end>", is_final: true },
  ] })), ctx);
  assert.deepEqual(seen[0], ["ready"], "first result message doubles as readiness");
  assert.deepEqual(seen[1], ["interim", "안녕하세요", "ko"]);
  assert.deepEqual(seen[2], ["tr", "en", "Hello", false, "soniox"]);
  assert.deepEqual(seen[3], ["final", "안녕하세요", "ko", true]);
  assert.deepEqual(seen[4], ["tr", "en", "Hello", true, "soniox"]);
  assert.deepEqual(seen[5], ["b", "endpoint"]);
  transport.handleMessage(Buffer.from(JSON.stringify({ error_type: "unauthenticated", error_code: 401, request_id: "r1" })), ctx);
  assert.deepEqual(seen.at(-1), ["err", "SONIOX_UNAUTHENTICATED"]);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test test/soniox-transport.test.js`
Expected: FAIL (module not found)

- [ ] **Step 7: Implement the transport**

```js
// src/caption-engine/soniox-transport.js
import { createCaptionPcmResampler } from "../caption-pcm-resampler.js";
import { SONIOX_CONTROL, SONIOX_ENDPOINTS, buildSonioxConfig, createSonioxTokenReducer } from "../../packages/caption-core/soniox-protocol.js";
import { selectGeminiTranscriptionVocabularyFromLegacyText } from "../../packages/caption-core/index.js";

const REPLAY_RING_BYTES = 48_000; // 1.5 s of 16 kHz mono PCM16
const MAX_MESSAGE_BYTES = 1_048_576;
const ERROR_CODES = Object.freeze({
  invalid_request: "SONIOX_INVALID_REQUEST", unauthenticated: "SONIOX_UNAUTHENTICATED",
  temp_api_key_session_expired: "SONIOX_KEY_EXPIRED", limit_exceeded: "SONIOX_RATE_LIMITED",
  service_unavailable: "SONIOX_UNAVAILABLE", max_duration_reached: "SONIOX_MAX_DURATION",
});

/**
 * Same surface as createGeminiTranscribeTransport plus:
 *  binaryAudio: true            — audioPayload returns a Buffer to send as a binary frame
 *  requiresSetupAck: false      — Soniox has no setupComplete; first result = ready
 *  replayPayloads()             — last 1.5 s of already-resampled PCM for reconnect/mode switch
 *  keepalivePayload()           — JSON keepalive control message
 */
export function createSonioxTransport({ engine, settings, apiKey, endpoint = "us", now = Date.now }) {
  const resample = createCaptionPcmResampler();
  const languages = Array.isArray(settings.translationLanguages) ? settings.translationLanguages : ["en", "ko"];
  const translation = engine.translation.provider === "soniox";
  const glossaryTerms = selectGeminiTranscriptionVocabularyFromLegacyText(settings.glossary ?? "");
  const translationTerms = String(settings.glossary ?? "").split("\n")
    .map((line) => line.split("=").map((part) => part.trim()))
    .filter((parts) => parts.length === 2 && parts[0] && parts[1])
    .map(([source, target]) => ({ source, target }));
  const config = buildSonioxConfig({
    apiKey, languageMode: engine.stt.languageMode, languages, translation,
    context: { terms: glossaryTerms, translationTerms, domain: settings.translationDomain ?? "" },
    clientReferenceId: `nova-desktop-${now().toString(36)}`,
  });
  const ring = [];
  let ringBytes = 0;
  let announcedReady = false;
  let reducer = null;

  function makeReducer(ctx) {
    return createSonioxTokenReducer({
      onSourcePartial: (e) => ctx.onInterim?.({ text: e.text, languageCode: e.language ?? undefined, segmentId: e.segmentId }),
      onSourceFinal: (e) => ctx.onFinal?.({ text: e.text, languageCode: e.language ?? undefined, segmentId: e.segmentId, startMs: e.startMs, endMs: e.endMs, providerTranslated: translation }),
      onTranslationPartial: (e) => ctx.onTranslation?.({ targetLanguage: e.language, text: e.text, isFinal: false, sourceLanguage: e.sourceLanguage, segmentId: e.segmentId, provider: "soniox" }),
      onTranslationFinal: (e) => ctx.onTranslation?.({ targetLanguage: e.language, text: e.text, isFinal: true, sourceLanguage: e.sourceLanguage, segmentId: e.segmentId, provider: "soniox" }),
      onBoundary: (kind) => ctx.onBoundary?.(kind),
    });
  }

  return {
    requiresSetupAck: false,
    binaryAudio: true,
    providerLabel: "Soniox",
    maximumSessionMilliseconds: 18_000_000,
    replayRingBytes: REPLAY_RING_BYTES,
    assertReady() { if (!String(apiKey ?? "").trim()) throw new Error("Soniox API key is required for realtime subtitles."); },
    connect({ createWebSocket }) { return createWebSocket(SONIOX_ENDPOINTS[endpoint] ?? SONIOX_ENDPOINTS.us, undefined, {}); },
    setupPayloads() { announcedReady = false; reducer = null; return [JSON.stringify(config)]; },
    audioPayload(base64Pcm24k) {
      const pcm16k = resample(Buffer.from(base64Pcm24k, "base64"));
      ring.push(pcm16k); ringBytes += pcm16k.length;
      while (ringBytes > REPLAY_RING_BYTES && ring.length > 1) ringBytes -= ring.shift().length;
      return pcm16k;
    },
    replayPayloads() { return [...ring]; },
    keepalivePayload() { return SONIOX_CONTROL.keepalive; },
    finalizePayload() { return SONIOX_CONTROL.finalize; },
    closePayload() { return Buffer.alloc(0); }, // empty binary frame = end of audio
    handleMessage(raw, ctx = {}) {
      let message;
      try {
        const encoded = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        if (Buffer.byteLength(encoded, "utf8") > MAX_MESSAGE_BYTES) throw new Error("too large");
        message = JSON.parse(encoded);
      } catch { ctx.onError?.("SONIOX_MESSAGE_INVALID"); return; }
      if (message && typeof message.error_type === "string") {
        ctx.onError?.(ERROR_CODES[message.error_type] ?? "SONIOX_PROVIDER_FAILED", { requestId: message.request_id ?? null });
        return;
      }
      if (!announcedReady) { announcedReady = true; ctx.onTransportReady?.(); }
      if (!reducer) reducer = makeReducer(ctx);
      reducer.apply(message);
      if (message?.finished === true) ctx.onBoundary?.("stream-finished");
    },
  };
}
```

Wire it as the default in `create-stt-transport.js`: import `createSonioxTransport` and change the `soniox` branch to `return (createSonioxTransportImpl ?? createSonioxTransport)({ engine: selection, settings, apiKey: apiKeys?.soniox ?? "" });`.

- [ ] **Step 8: Teach the socket client about binary audio, no-ack transports, replay, keepalive**

In `src/subtitle-realtime.js` `createSourceTranscriptionClient`:

- In the `open` handler after sending setup payloads: `if (transport.requiresSetupAck === false) markTransportReady(openedSocket); else armSetupTimeout(openedSocket);`
- In `markTransportReady`, before flushing `pendingAudio`, add replay: `for (const payload of transport.replayPayloads?.() ?? []) openedSocket.send(payload, transport.binaryAudio ? { binary: true } : undefined);` — only when `replayOnNextOpen` is true (set it in `requestGracefulRollover` and in `scheduleReconnect`, clear it after replay).
- Every `openedSocket.send(transport.audioPayload(...))` becomes `sendAudioPayload(openedSocket, transport.audioPayload(...))` where `const sendAudioPayload = (ws, payload) => ws.send(payload, transport.binaryAudio ? { binary: true } : undefined);`. Same for `closePayload()`.
- Keepalive: after `markTransportReady`, if `typeof transport.keepalivePayload === "function"`, start `keepaliveTimer = setInterval(() => { if (socket === openedSocket && configured && Date.now() - lastAudioSentAt > 8_000) openedSocket.send(transport.keepalivePayload()); }, 4_000)`; track `lastAudioSentAt` in `sendAudio`; clear the interval on close/rollover. `unref()` the timer.
- `handleMessage` ctx gains `onError: (code, detail) => broadcast({ type: "subtitle:error", code, message: \`${providerLabel} 연결 오류: ${code}\`, source, requestId: detail?.requestId ?? null })` and, for `SONIOX_UNAUTHENTICATED`/`SONIOX_INVALID_REQUEST`, set `intentionalClose`-like `noReconnect = true` so `scheduleReconnect` is skipped (`if (noReconnect) return;` at its top).

Add a regression in `test/subtitle-realtime-transcribe.test.js`:

```js
test("soniox engine sends config first, binary audio frames, and commits provider translations without Gemini calls", async (t) => {
  const h = createHarness(t, { settings: { translationLanguages: ["en", "ko"], engine: {
    stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" },
    translation: { provider: "soniox", model: "stt-rt-v5" },
    summary: { provider: "gemini", model: "gemini-3.6-flash" },
  } }, apiKeys: { gemini: "fixture-key", soniox: "fixture-key" } });
  await h.manager.start({ sessionId: "fixture", settings: {} });
  const socket = h.sockets.at(-1); socket.open();
  assert.equal(JSON.parse(socket.sent[0]).model, "stt-rt-v5");
  h.send(1);
  await tick();
  assert.ok(Buffer.isBuffer(socket.sent.at(-1)), "audio is a binary frame");
  socket.emit("message", Buffer.from(JSON.stringify({ tokens: [
    { text: "안녕하세요", is_final: true, translation_status: "original", language: "ko", start_ms: 0, end_ms: 800 },
    { text: "Hello", is_final: true, translation_status: "translation", language: "en", source_language: "ko" },
    { text: "<end>", is_final: true },
  ] })));
  await tick();
  const committed = captions(h);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].targetLanguage, "en");
  assert.equal(committed[0].translatedText, "Hello");
  assert.equal(committed[0].translationProvider, "soniox");
  assert.equal(h.textCalls(), 0);
});
```

(The harness's `settingsStore.load` must merge `apiKeys` from the harness option: `apiKeys: { gemini: "fixture-key", ...options.apiKeys }`.)

- [ ] **Step 9: Run transport + realtime tests, then root suite**

Run: `node --test test/soniox-transport.test.js test/subtitle-realtime-transcribe.test.js && npm test 2>&1 | tail -6 && npm run typecheck`
Expected: PASS (except the three UI/model-pin tests deferred to Task 7)

- [ ] **Step 10: Commit**

```bash
git add packages/caption-core/soniox-protocol.js packages/caption-core/index.js src/caption-engine/soniox-transport.js src/caption-engine/create-stt-transport.js src/subtitle-realtime.js test/soniox-protocol.test.js test/soniox-transport.test.js test/subtitle-realtime-transcribe.test.js
git commit -m "feat(desktop): soniox stt-rt-v5 transport with two_way translation, strict language modes, replay ring"
```

---

### Task 6: Immediate hot swap on settings save (open-new-then-close-old)

**Files:**
- Modify: `src/subtitle-realtime.js` (`restartChannels`)
- Modify: `src/server.js` (`PUT /api/settings` and `settings:update` handlers)
- Test: `test/subtitle-restart-watchdog.test.js` (add), `test/server-startup.test.js` (add)

**Interfaces:**
- Consumes: `engineSelectionKey` (Task 1), `subtitles.restartChannels` (Task 4)
- Produces: `restartChannels({ reason })` opens replacement clients before closing the old ones; server calls `subtitles.restartChannels({ reason: "engine_change" })` when `engineSelectionKey` or any key in `engineRequiredApiKeys` changed and captions are active; broadcasts `subtitle:status { status: "recovering", reason: "engine_change" }` then `listening`.

- [ ] **Step 1: Write failing tests**

Append to `test/subtitle-restart-watchdog.test.js` (reuse its harness):

```js
test("restartChannels opens the replacement socket before closing the old one", async (t) => {
  const h = createHarness(t);
  await h.manager.start({ sessionId: "fixture", settings: {} });
  const first = h.sockets.at(-1); first.ready();
  const restart = h.manager.restartChannels({ reason: "engine_change" });
  await tick();
  assert.equal(h.sockets.length, 2, "a new socket was created");
  assert.equal(first.closeCalls, 0, "old socket still open while the new one connects");
  h.sockets.at(-1).ready();
  await restart;
  assert.equal(first.closeCalls, 1);
  const statuses = h.events.filter((e) => e.type === "subtitle:status").map((e) => `${e.status}:${e.reason ?? ""}`);
  assert.ok(statuses.includes("recovering:engine_change"));
  assert.equal(statuses.at(-1), "listening:");
});
```

Append to `test/server-startup.test.js` (use its `startServer` fake-injection pattern; inject `createSubtitleRealtimeManager` returning a spy):

```js
test("saving a different engine while captions run triggers an immediate channel restart", async (t) => {
  const calls = [];
  const fakeManager = { start: async () => {}, stop: async () => true, close() {}, sendAudio() {}, noteInputSignal() {},
    restartChannels: async (args) => { calls.push(args); return true; }, _state: { active: true } };
  const { server, port, settingsStore } = await startTestServer(t, { createSubtitleRealtimeManager: () => fakeManager });
  await settingsStore.save({ apiKeys: { soniox: "fixture-key" } });
  const response = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subtitle: { engine: { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "ko" }, translation: { provider: "soniox", model: "stt-rt-v5" }, summary: { provider: "gemini", model: "gemini-3.6-flash" } } } }) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ reason: "engine_change" }]);
  const again = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ subtitle: { fontSize: 40 } }) });
  assert.equal(again.status, 200);
  assert.equal(calls.length, 1, "unrelated settings do not restart the engine");
  server.close();
});
```

(`startTestServer` is whatever helper `test/server-startup.test.js` already uses to boot `startServer` with a temp settings store; adapt the name.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/subtitle-restart-watchdog.test.js test/server-startup.test.js`
Expected: FAIL (old socket closed first; no restart call)

- [ ] **Step 3: Implement open-new-first restart**

Replace the body of `restartChannels` in `src/subtitle-realtime.js` with:

```js
  async function restartChannels({ reason = "restart" } = {}) {
    if (!state.active || restartInFlight || !state.sessionId) return false;
    restartInFlight = true;
    const ownerSessionId = state.sessionId;
    try {
      const saved = settingsStore ? await settingsStore.load() : {};
      if (!state.active || state.sessionId !== ownerSessionId) return false;
      const normalizedSettings = normalizeSubtitleSettings({ ...(state.settings ?? {}), ...(saved.subtitle ?? {}), inputMode: state.settings.inputMode });
      const apiKeys = {
        gemini: String(saved.apiKeys?.gemini || env.GEMINI_API_KEY || "").trim(),
        geminiSecondary: String(saved.apiKeys?.geminiSecondary || env.GEMINI_SECONDARY_API_KEY || "").trim(),
        soniox: String(saved.apiKeys?.soniox || env.SONIOX_API_KEY || "").trim(),
      };
      const missingKey = engineRequiredApiKeys(normalizedSettings.engine).find((name) => !apiKeys[name]);
      if (missingKey) throw new Error(`${missingKey} API key is required for the selected caption engine.`);
      const previousClients = [...state.clients.values()];
      state.clients.clear();
      producerGeneration += 1;
      const replacementGeneration = producerGeneration;
      state.settings = normalizedSettings;
      state.captionConfig = createGeminiCaptionConfig(normalizedSettings);
      state.apiKeys = apiKeys;
      broadcast?.({ type: "subtitle:status", status: "recovering", reason });
      // Open replacements first so the caption gap is bounded by connect time, not by drain time.
      const replacements = sourcesForInputMode(normalizedSettings.inputMode).map((source) => ensureClient(source));
      for (const client of replacements) client.open();
      await Promise.all(replacements.map((client) => client.waitUntilReady(2_500).catch(() => undefined)));
      if (!state.active || state.sessionId !== ownerSessionId || producerGeneration !== replacementGeneration) {
        await Promise.all(previousClients.map((client) => client.close({ graceful: true })));
        return false;
      }
      await Promise.all(previousClients.map((client) => client.close({ graceful: true })));
      resetSourceLiveness();
      broadcast?.({ type: "subtitle:status", status: "listening" });
      return true;
    } finally {
      restartInFlight = false;
    }
  }
```

Add `waitUntilReady(timeoutMs)` to the object returned by `createSourceTranscriptionClient`:

```js
    waitUntilReady(timeoutMs = 2_500) {
      if (configured) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        readyWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
```

with `let readyWaiters = [];` declared next to `configured`, and in `markTransportReady` after `configured = true;`: `for (const wake of readyWaiters.splice(0)) wake();`.

- [ ] **Step 4: Trigger restarts from settings saves**

In `src/server.js`, inside both `PUT /api/settings` and the `settings:update` WS handler, replace `await saveSettingsPatch(req.body ?? {});` / `await saveSettingsPatch(message.patch ?? {});` with a call to a new helper:

```js
  async function saveSettingsAndApply(patch) {
    const before = await options.settingsStore.load();
    const beforeKey = engineSelectionKey(before.subtitle?.engine);
    const beforeKeys = Object.fromEntries(API_KEY_NAMES.map((name) => [name, Boolean(before.apiKeys?.[name])]));
    await saveSettingsPatch(patch);
    const after = await options.settingsStore.load();
    const engineChanged = engineSelectionKey(after.subtitle?.engine) !== beforeKey;
    const keysChanged = engineRequiredApiKeys(after.subtitle?.engine).some((name) => beforeKeys[name] !== Boolean(after.apiKeys?.[name]));
    if ((engineChanged || keysChanged) && subtitles._state?.active) {
      await subtitles.restartChannels({ reason: "engine_change" });
    }
  }
```

Import `engineSelectionKey`, `engineRequiredApiKeys` from the catalog and `API_KEY_NAMES` from `./settings-store.js`.

- [ ] **Step 5: Run tests**

Run: `node --test test/subtitle-restart-watchdog.test.js test/server-startup.test.js && npm test 2>&1 | tail -6`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/subtitle-realtime.js src/server.js test/subtitle-restart-watchdog.test.js test/server-startup.test.js
git commit -m "feat(desktop): engine hot swap on settings save with open-new-then-close-old channel restart"
```

---

### Task 7: Settings UI — engine dropdowns, language mode, Soniox key

**Files:**
- Modify: `public/subtitle-model-settings.js` (rewrite), `public/subtitle.html:559-566` (+ API key strip), `public/subtitle-dashboard.js` (~L9, L225-230, L281, L308, L2809-2812, and the `captionModels` consumer near L1651), `public/subtitle-i18n.js`, `public/subtitle-i18n-ja.js`
- Mirror: `cp public/subtitle-dashboard.js subtitle-dashboard.js && cp public/subtitle.html subtitle.html`
- Rewrite tests: `test/subtitle-model-settings.test.js`; update `test/server-model-selection-security.test.js`, `test/desktop-live-model-preferences.test.js` (assert `engine`, not `geminiTranscribeModel`)

**Interfaces:**
- Consumes: `/api/config.captionEngines` (Task 4), `PUT /api/settings { subtitle: { engine } }` (Task 6)
- Produces: form fields `engineStt` (value `provider:model`), `engineLanguageMode`, `engineTranslation`, `engineSummary`, `sonioxKey`; `mountCaptionEngineSettings({ form, getSettings, save, onSaved, onError, translate })` with `setCatalog(view)`, `refresh()`.

- [ ] **Step 1: Write the failing UI module test**

```js
// test/subtitle-model-settings.test.js  (replace file)
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom"; // if jsdom is not a devDependency, build the form with a minimal fake as the old test did
import { mountCaptionEngineSettings, normalizeCaptionEngineCatalog } from "../public/subtitle-model-settings.js";

const catalog = {
  stt: [
    { provider: "gemini", model: "gemini-3.5-transcribe-live", label: "Gemini 3.5 Transcribe Live", requiredApiKey: "gemini", available: true, languageModes: ["auto"] },
    { provider: "soniox", model: "stt-rt-v5", label: "Soniox stt-rt-v5", requiredApiKey: "soniox", available: false, languageModes: ["auto", "ko", "en"] },
  ],
  translation: [
    { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", requiredApiKey: "gemini", available: true, languageModes: [] },
    { provider: "soniox", model: "stt-rt-v5", label: "Soniox", requiredApiKey: "soniox", available: false, languageModes: [], requiresSttProvider: "soniox" },
  ],
  summary: [{ provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", requiredApiKey: "gemini", available: true, languageModes: [] }],
  defaults: { stt: { provider: "gemini", model: "gemini-3.5-transcribe-live", languageMode: "auto" }, translation: { provider: "gemini", model: "gemini-3.6-flash" }, summary: { provider: "gemini", model: "gemini-3.6-flash" } },
};

test("catalog normalization rejects malformed entries and keeps availability", () => {
  assert.equal(normalizeCaptionEngineCatalog(null), null);
  const view = normalizeCaptionEngineCatalog(catalog);
  assert.equal(view.stt[1].available, false);
  assert.equal(normalizeCaptionEngineCatalog({ ...catalog, stt: [{ provider: "x y", model: "z", label: "", available: true, languageModes: [] }] }), null);
});

test("selecting an engine saves subtitle.engine and disables options whose key is missing", async () => {
  const dom = new JSDOM(`<form>
    <select name="engineStt"></select><select name="engineLanguageMode"></select>
    <select name="engineTranslation"></select><select name="engineSummary"></select>
    <p data-caption-engine-status></p></form>`);
  const form = dom.window.document.querySelector("form");
  const saved = [];
  let settings = { engine: catalog.defaults };
  const ui = mountCaptionEngineSettings({ form, getSettings: () => settings, save: async (patch) => { saved.push(patch); settings = { ...settings, ...patch }; }, onSaved() {}, onError() {}, translate: (key) => key });
  ui.setCatalog(catalog);
  const stt = form.elements.engineStt;
  assert.equal(stt.options.length, 2);
  assert.equal([...stt.options].find((o) => o.value === "soniox:stt-rt-v5").disabled, true, "no soniox key → disabled");
  assert.equal(form.elements.engineLanguageMode.disabled, true, "gemini has only auto");
  form.elements.engineTranslation.value = "gemini:gemini-3.6-flash";
  form.elements.engineSummary.value = "gemini:gemini-3.6-flash";
  form.elements.engineSummary.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(saved.at(-1), { engine: catalog.defaults });
  assert.equal(form.querySelector("[data-caption-engine-status]").textContent, "engine.appliesNow");
});
```

If `jsdom` is not installed (`ls node_modules/jsdom`), replace the JSDOM form with the same fake-element approach the old `test/subtitle-model-settings.test.js` used (it built `form.elements` objects by hand); keep the assertions identical.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/subtitle-model-settings.test.js`
Expected: FAIL (`mountCaptionEngineSettings` not exported)

- [ ] **Step 3: Rewrite `public/subtitle-model-settings.js`**

```js
// Engine IDs come from the server's shared catalog; opening this UI makes no provider calls.
import { t } from "./subtitle-i18n.js";

const ROLE_FIELDS = { stt: "engineStt", translation: "engineTranslation", summary: "engineSummary" };
const ID_PATTERN = /^[a-z0-9.-]{1,80}$/u;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const optionValue = (entry) => `${entry.provider}:${entry.model}`;

export function normalizeCaptionEngineCatalog(value) {
  if (!isRecord(value) || !isRecord(value.defaults)) return null;
  const result = { defaults: value.defaults };
  for (const role of Object.keys(ROLE_FIELDS)) {
    const entries = value[role];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) return null;
    const seen = new Set();
    result[role] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || !ID_PATTERN.test(entry.provider ?? "") || !ID_PATTERN.test(entry.model ?? "")
        || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 120 || /[<>\p{Cc}\p{Cf}]/u.test(entry.label)
        || typeof entry.available !== "boolean" || !Array.isArray(entry.languageModes) || seen.has(optionValue(entry))) return null;
      seen.add(optionValue(entry));
      result[role].push({ provider: entry.provider, model: entry.model, label: entry.label, available: entry.available,
        languageModes: entry.languageModes.filter((mode) => ["auto", "ko", "en"].includes(mode)),
        requiresSttProvider: typeof entry.requiresSttProvider === "string" ? entry.requiresSttProvider : null });
    }
  }
  return result;
}

export function mountCaptionEngineSettings({ form, getSettings, save, onSaved, onError, translate = t }) {
  let catalog = null;
  let isPending = false;
  let hasSaveError = false;
  const status = form.querySelector("[data-caption-engine-status]");
  const field = (name) => form.elements[name];

  function currentEngine() {
    const engine = getSettings()?.engine ?? catalog?.defaults;
    return engine ?? null;
  }
  function selectedEntry(role) {
    const value = field(ROLE_FIELDS[role])?.value ?? "";
    return catalog?.[role].find((entry) => optionValue(entry) === value) ?? null;
  }
  function fillOptions(select, entries, disabledFor) {
    if (!select) return;
    select.replaceChildren(...entries.map((entry) => {
      const option = select.ownerDocument.createElement("option");
      option.value = optionValue(entry); option.textContent = entry.label;
      option.disabled = !entry.available || (disabledFor?.(entry) ?? false);
      return option;
    }));
  }
  function refresh() {
    const engine = currentEngine();
    if (!catalog || !engine) { if (status) status.textContent = translate("engine.unavailable"); return; }
    const sttEntry = selectedEntry("stt") ?? catalog.stt.find((e) => optionValue(e) === `${engine.stt.provider}:${engine.stt.model}`) ?? catalog.stt[0];
    fillOptions(field("engineTranslation"), catalog.translation, (entry) => entry.requiresSttProvider && entry.requiresSttProvider !== sttEntry.provider);
    for (const [role, name] of Object.entries(ROLE_FIELDS)) {
      const select = field(name);
      if (!select) continue;
      select.value = `${engine[role].provider}:${engine[role].model}`;
      select.disabled = isPending;
    }
    const modeSelect = field("engineLanguageMode");
    if (modeSelect) {
      modeSelect.replaceChildren(...sttEntry.languageModes.map((mode) => {
        const option = modeSelect.ownerDocument.createElement("option");
        option.value = mode; option.textContent = translate(`engine.mode.${mode}`);
        return option;
      }));
      modeSelect.value = sttEntry.languageModes.includes(engine.stt.languageMode) ? engine.stt.languageMode : "auto";
      modeSelect.disabled = isPending || sttEntry.languageModes.length <= 1;
    }
    if (status) status.textContent = translate(isPending ? "engine.saving" : hasSaveError ? "engine.saveFailed" : "engine.appliesNow");
  }
  async function commit() {
    if (!catalog || isPending) return;
    const stt = selectedEntry("stt"), translation = selectedEntry("translation"), summary = selectedEntry("summary");
    if (!stt || !translation || !summary) { refresh(); return; }
    const modeSelect = field("engineLanguageMode");
    const languageMode = modeSelect && stt.languageModes.includes(modeSelect.value) ? modeSelect.value : "auto";
    const engine = { stt: { provider: stt.provider, model: stt.model, languageMode }, translation: { provider: translation.provider, model: translation.model }, summary: { provider: summary.provider, model: summary.model } };
    if (JSON.stringify(engine) === JSON.stringify(currentEngine())) { refresh(); return; }
    isPending = true; hasSaveError = false; refresh();
    try { await save({ engine }); onSaved({ engine }); }
    catch (error) { hasSaveError = true; onError(error); }
    finally { isPending = false; refresh(); }
  }
  for (const name of [...Object.values(ROLE_FIELDS), "engineLanguageMode"]) {
    field(name)?.addEventListener("change", (event) => { event.stopPropagation(); void commit(); });
  }
  return { refresh, isSaving: () => isPending, setCatalog(value) { catalog = normalizeCaptionEngineCatalog(value); refresh(); } };
}
```

- [ ] **Step 4: Update HTML, dashboard, i18n**

`public/subtitle.html` — replace the three `<label>` lines inside the `caption-models-heading` panel with:

```html
                  <label><span data-i18n="engine.stt">음성 인식</span><select name="engineStt" aria-describedby="caption-engine-status"></select></label>
                  <label><span data-i18n="engine.languageMode">입력 언어</span><select name="engineLanguageMode" aria-describedby="caption-engine-status"></select></label>
                  <label><span data-i18n="engine.translation">번역</span><select name="engineTranslation" aria-describedby="caption-engine-status"></select></label>
                  <label><span data-i18n="engine.summary">요약</span><select name="engineSummary" aria-describedby="caption-engine-status"></select></label>
                  <p id="caption-engine-status" class="field-status" data-caption-engine-status role="status" aria-live="polite" data-i18n="engine.loading">모델 목록을 불러오고 있어요.</p>
```

and next to the existing `geminiKey` input add `<label><span data-i18n="keys.soniox">Soniox API 키</span><input type="password" name="sonioxKey" autocomplete="off"></label><span id="soniox-key-status" class="field-status"></span>`.

`public/subtitle-dashboard.js`:
- import `mountCaptionEngineSettings` instead of `mountCaptionModelSettings`; construct it with `save: (patch) => saveSettings({ subtitle: patch })` (use the file's existing settings-save helper) and call `.setCatalog(config.captionEngines)` where `captionModels` was consumed (~L1651) and on `settings` WS messages (~L2555).
- In the two autosave guards (~L281, ~L308) replace the `["translationModel","geminiTranscribeModel","geminiSummaryModel"]` arrays with `["engineStt","engineLanguageMode","engineTranslation","engineSummary","sonioxKey"]`.
- In the API-key save block (~L2809): `if (sonioxKeyInput?.value.trim()) apiKeysPatch.soniox = sonioxKeyInput.value.trim();` with `const sonioxKeyInput = form.elements.sonioxKey;` declared next to `geminiKeyInput`, and `state.hasSonioxKey = Boolean(config.settings?.hasSonioxKey)` alongside `hasGeminiKey`; show `soniox-key-status` text `저장됨`/`` like the Gemini status.

`public/subtitle-i18n.js` (en) and `public/subtitle-i18n-ja.js` (ja) — add keys (ko strings live in HTML defaults):

```js
  "engine.stt": "Speech recognition", "engine.languageMode": "Input language", "engine.translation": "Translation", "engine.summary": "Summary",
  "engine.mode.auto": "Auto (KO+EN)", "engine.mode.ko": "Korean only", "engine.mode.en": "English only",
  "engine.loading": "Loading engines.", "engine.unavailable": "Engines unavailable. Reopen Settings after checking the connection.",
  "engine.saving": "Applying…", "engine.saveFailed": "Could not save. Select again to retry.", "engine.appliesNow": "Changes apply immediately, including running captions.",
  "keys.soniox": "Soniox API key",
```

(Japanese equivalents in the ja file. Remove the obsolete `models.*` keys from both.)

Mirror: `cp public/subtitle-dashboard.js subtitle-dashboard.js && cp public/subtitle.html subtitle.html`.

- [ ] **Step 5: Update the two deferred tests**

`test/server-model-selection-security.test.js`: every request body that sent `geminiTranscribeModel`/`geminiSummaryModel` now sends `engine: {...}`; the "local WS cannot override saved model" assertion checks that a `subtitle:start` message carrying `settings.engine` for Soniox is ignored in favour of the saved Gemini `engine` (assert on `subtitles.start` call args' `settings.engine.stt.provider === "gemini"`). `test/desktop-live-model-preferences.test.js`: assert electron main derives `modelPreferences.source` from `subtitleSettings.engine.stt.model` (see Step 6).

- [ ] **Step 6: Electron main reads the engine field**

In `electron/main.js` `sanitizeLiveCallDraft`, replace the `modelPreferences: readLiveCallModelPreferences({ source: readGeminiSelectedModel("source", subtitleSettings.geminiTranscribeModel), summary: readGeminiSelectedModel("summary", subtitleSettings.geminiSummaryModel) })` with

```js
    modelPreferences: readLiveCallModelPreferences({
      source: readGeminiSelectedModel("source", subtitleSettings.engine?.stt?.provider === "gemini" ? subtitleSettings.engine.stt.model : undefined),
      summary: readGeminiSelectedModel("summary", subtitleSettings.engine?.summary?.model),
    }),
```

(Plan 2 replaces `modelPreferences` with `engine`; until then a Soniox desktop selection pins the Live Call to the Gemini default, which is the only engine the deployed gateway has.) Also `pinLiveCallModelSettings` must set `engine` on the settings it returns: add `engine: { stt: { provider: "gemini", model: selected.source, languageMode: "auto" }, translation: settings?.engine?.translation ?? { provider: "gemini", model: "gemini-3.6-flash" }, summary: { provider: "gemini", model: selected.summary } },` and stop spreading the retired `geminiTranscribeModel`/`transcriptionModel`/`transcribeModel`/`geminiSummaryModel`/`summaryModel` keys.

- [ ] **Step 7: Run full root suite + typecheck**

Run: `npm test 2>&1 | tail -6 && npm run typecheck`
Expected: all PASS (skips allowed), typecheck clean. Also `node --test test/session-transcripts.test.js test/desktop-stage-window.test.js` PASS (root/public mirrors).

- [ ] **Step 8: Commit**

```bash
git add public/subtitle-model-settings.js public/subtitle.html public/subtitle-dashboard.js public/subtitle-i18n.js public/subtitle-i18n-ja.js subtitle-dashboard.js subtitle.html electron/main.js test/subtitle-model-settings.test.js test/server-model-selection-security.test.js test/desktop-live-model-preferences.test.js
git commit -m "feat(desktop-ui): engine, language mode, and soniox key settings that apply immediately"
```

---

### Task 8: Real-API spike script (decides the default provider)

**Files:**
- Create: `scripts/engine-spike.mjs`
- Create: `test/engine-spike.test.js` (pure helpers only)
- Modify: `package.json` scripts: `"spike:engine": "node ./scripts/engine-spike.mjs"`

**Interfaces:**
- Consumes: `buildSonioxConfig`, `createSonioxTokenReducer`, `SONIOX_ENDPOINTS` (Task 5); `buildGeminiTranscribeSetupMessage`, `handleGeminiTranscribeMessage` from `src/gemini-live-transcribe.js`
- Produces: `parseSpikeArgs(argv)`, `readWav16kMono(buffer)`, `summarizeMetrics(samples)` exported for tests; CLI writes `scratch/engine-spike-<timestamp>.json`.

- [ ] **Step 1: Write failing helper tests**

```js
// test/engine-spike.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpikeArgs, readWav16kMono, summarizeMetrics } from "../scripts/engine-spike.mjs";

test("args default to soniox+gemini, modes auto/ko/en, us endpoint", () => {
  const args = parseSpikeArgs(["--wav", "a.wav"]);
  assert.deepEqual(args, { wav: "a.wav", providers: ["soniox", "gemini"], modes: ["auto", "ko", "en"], endpoint: "us", realtime: true, out: null });
  assert.deepEqual(parseSpikeArgs(["--wav", "a.wav", "--providers", "soniox", "--modes", "ko", "--endpoint", "jp", "--no-realtime"]).modes, ["ko"]);
  assert.throws(() => parseSpikeArgs([]), /--wav/u);
});

test("wav reader accepts 16 kHz mono PCM16 and rejects others", () => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + 4, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(4, 40);
  const pcm = readWav16kMono(Buffer.concat([header, Buffer.from([1, 0, 2, 0])]));
  assert.equal(pcm.length, 4);
  header.writeUInt32LE(24000, 24);
  assert.throws(() => readWav16kMono(Buffer.concat([header, Buffer.from([1, 0, 2, 0])])), /16000/u);
});

test("metrics summarize p50/p95 and counts", () => {
  const summary = summarizeMetrics({ firstPartialMs: [100, 200, 300], finalLagMs: [500, 700], otherScriptFinals: 1, finals: 12 });
  assert.equal(summary.firstPartialMs.p50, 200);
  assert.equal(summary.finalLagMs.p95, 700);
  assert.equal(summary.otherScriptFinals, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/engine-spike.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the spike script**

```js
#!/usr/bin/env node
// scripts/engine-spike.mjs
// Real-API comparison of caption STT providers on ONE 16 kHz mono WAV.
// Keys: SONIOX_API_KEY from ~/.config/realtime-noel/soniox.env (or env),
//       Gemini from ~/.config/realtime-noel/settings.json apiKeys.gemini (or GEMINI_API_KEY).
// Never prints keys. Writes scratch/engine-spike-<ts>.json.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { SONIOX_ENDPOINTS, buildSonioxConfig, createSonioxTokenReducer } from "../packages/caption-core/soniox-protocol.js";
import { buildGeminiTranscribeSetupMessage, handleGeminiTranscribeMessage } from "../src/gemini-live-transcribe.js";

const GEMINI_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const FRAME_BYTES = 3_200; // 100 ms @ 16 kHz mono PCM16

export function parseSpikeArgs(argv) {
  const args = { wav: null, providers: ["soniox", "gemini"], modes: ["auto", "ko", "en"], endpoint: "us", realtime: true, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--wav") args.wav = next();
    else if (flag === "--providers") args.providers = next().split(",").filter(Boolean);
    else if (flag === "--modes") args.modes = next().split(",").filter(Boolean);
    else if (flag === "--endpoint") args.endpoint = next();
    else if (flag === "--out") args.out = next();
    else if (flag === "--no-realtime") args.realtime = false;
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!args.wav) throw new Error("--wav <16kHz mono PCM16 wav> is required");
  if (!["us", "jp"].includes(args.endpoint)) throw new Error("--endpoint must be us or jp");
  return args;
}

export function readWav16kMono(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let offset = 12; let format = null; let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4); const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") format = { audioFormat: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10), sampleRate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) };
    if (id === "data") data = buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error("WAV missing fmt/data");
  if (format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16) {
    throw new Error(`Need PCM16 mono 16000 Hz, got format=${format.audioFormat} ch=${format.channels} rate=${format.sampleRate} bits=${format.bits}. Convert: ffmpeg -i in.wav -ac 1 -ar 16000 -sample_fmt s16 out.wav`);
  }
  return data;
}

const percentile = (values, p) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]; };
export function summarizeMetrics(m) {
  const stats = (values) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null });
  return { firstPartialMs: stats(m.firstPartialMs ?? []), finalLagMs: stats(m.finalLagMs ?? []), firstTranslationMs: stats(m.firstTranslationMs ?? []), finals: m.finals ?? 0, otherScriptFinals: m.otherScriptFinals ?? 0, errors: m.errors ?? [] };
}

const isOtherScript = (text) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Thai}\p{Script=Arabic}]/u.test(text) || /[àảãáạăằẳẵắặâầẩẫấậđèẻẽéẹêềểễếệìỉĩíịòỏõóọôồổỗốộơờởỡớợùủũúụưừửữứựỳỷỹýỵ]/iu.test(text);

async function readKeys() {
  const home = os.homedir();
  let soniox = process.env.SONIOX_API_KEY ?? "";
  try { const env = await fs.readFile(path.join(home, ".config/realtime-noel/soniox.env"), "utf8"); soniox ||= (env.match(/^SONIOX_API_KEY=(.+)$/mu)?.[1] ?? "").trim(); } catch {}
  let gemini = process.env.GEMINI_API_KEY ?? "";
  try { const settings = JSON.parse(await fs.readFile(path.join(home, ".config/realtime-noel/settings.json"), "utf8")); gemini ||= settings.apiKeys?.gemini ?? ""; } catch {}
  return { soniox, gemini };
}

function streamPcm(ws, pcm, { realtime, binary, wrap }) {
  return new Promise((resolve) => {
    let offset = 0; const startedAt = Date.now();
    const tick = () => {
      if (ws.readyState !== WebSocket.OPEN) return resolve();
      const frame = pcm.subarray(offset, offset + FRAME_BYTES); offset += FRAME_BYTES;
      if (frame.length) ws.send(binary ? frame : wrap(frame), binary ? { binary: true } : undefined);
      if (offset >= pcm.length) return resolve();
      if (!realtime) return setImmediate(tick);
      const due = startedAt + (offset / FRAME_BYTES) * 100;
      setTimeout(tick, Math.max(0, due - Date.now()));
    };
    tick();
  });
}

async function runSoniox({ key, pcm, mode, endpoint, realtime }) {
  const metrics = { firstPartialMs: [], finalLagMs: [], firstTranslationMs: [], finals: 0, otherScriptFinals: 0, errors: [], transcript: [], translations: [] };
  const ws = new WebSocket(SONIOX_ENDPOINTS[endpoint]);
  const t0 = Date.now(); let audioStartedAt = 0; let segmentFirstPartialAt = null; let segmentFirstTranslationAt = null; let audioEndAt = null;
  const reducer = createSonioxTokenReducer({
    onSourcePartial() { if (segmentFirstPartialAt === null) segmentFirstPartialAt = Date.now(); },
    onSourceFinal(e) { metrics.finals += 1; if (isOtherScript(e.text)) metrics.otherScriptFinals += 1; metrics.transcript.push({ text: e.text, language: e.language, endMs: e.endMs }); if (segmentFirstPartialAt !== null && e.startMs !== null) metrics.firstPartialMs.push(segmentFirstPartialAt - (audioStartedAt + e.startMs)); if (e.endMs !== null) metrics.finalLagMs.push(Date.now() - (audioStartedAt + e.endMs)); },
    onTranslationPartial(e) { if (segmentFirstTranslationAt === null) segmentFirstTranslationAt = Date.now(); },
    onTranslationFinal(e) { metrics.translations.push({ text: e.text, language: e.language, sourceLanguage: e.sourceLanguage }); if (segmentFirstPartialAt !== null && segmentFirstTranslationAt !== null) metrics.firstTranslationMs.push(segmentFirstTranslationAt - segmentFirstPartialAt); },
    onBoundary() { segmentFirstPartialAt = null; segmentFirstTranslationAt = null; },
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify(buildSonioxConfig({ apiKey: key, languageMode: mode, languages: ["en", "ko"], translation: true, clientReferenceId: `spike-${mode}` })));
  const finished = new Promise((resolve) => {
    ws.on("message", (raw) => { const msg = JSON.parse(raw.toString("utf8")); if (msg.error_type) { metrics.errors.push({ type: msg.error_type, requestId: msg.request_id ?? null }); return; } reducer.apply(msg); if (msg.finished) resolve(); });
    ws.on("close", resolve);
  });
  audioStartedAt = Date.now();
  await streamPcm(ws, pcm, { realtime, binary: true });
  audioEndAt = Date.now();
  ws.send(Buffer.alloc(0), { binary: true });
  await Promise.race([finished, new Promise((r) => setTimeout(r, 8_000))]);
  ws.close();
  return { provider: "soniox", mode, endpoint, connectMs: audioStartedAt - t0, audioMs: Math.round(pcm.length / 32), drainMs: Date.now() - audioEndAt, ...summarizeMetrics(metrics), transcript: metrics.transcript, translations: metrics.translations };
}

async function runGemini({ key, pcm, realtime }) {
  const metrics = { firstPartialMs: [], finalLagMs: [], finals: 0, otherScriptFinals: 0, errors: [], transcript: [] };
  const ws = new WebSocket(`${GEMINI_URL}?key=${encodeURIComponent(key)}`);
  const t0 = Date.now(); let audioStartedAt = 0; let sawPartialSinceFinal = null;
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(buildGeminiTranscribeSetupMessage({}));
  await new Promise((resolve) => { const onMsg = (raw) => { if (JSON.parse(raw.toString("utf8")).setupComplete !== undefined) { ws.off("message", onMsg); resolve(); } }; ws.on("message", onMsg); });
  ws.on("message", (raw) => handleGeminiTranscribeMessage(raw, {
    onInterim() { if (sawPartialSinceFinal === null) sawPartialSinceFinal = Date.now() - audioStartedAt; },
    onFinal(e) { metrics.finals += 1; if (isOtherScript(e.text)) metrics.otherScriptFinals += 1; metrics.transcript.push({ text: e.text, language: e.languageCode ?? null, atMs: Date.now() - audioStartedAt }); if (sawPartialSinceFinal !== null) metrics.firstPartialMs.push(sawPartialSinceFinal); sawPartialSinceFinal = null; },
    onServerGoAway() { metrics.errors.push({ type: "goAway" }); },
    broadcast(event) { if (event?.type === "subtitle:error") metrics.errors.push({ type: event.code }); },
  }));
  audioStartedAt = Date.now();
  await streamPcm(ws, pcm, { realtime, binary: false, wrap: (frame) => JSON.stringify({ realtimeInput: { audio: { data: frame.toString("base64"), mimeType: "audio/pcm;rate=16000" } } }) });
  ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  await new Promise((r) => setTimeout(r, 4_000));
  ws.close();
  return { provider: "gemini", mode: "auto", connectMs: audioStartedAt - t0, audioMs: Math.round(pcm.length / 32), ...summarizeMetrics(metrics), transcript: metrics.transcript };
}

async function main() {
  const args = parseSpikeArgs(process.argv.slice(2));
  const keys = await readKeys();
  const pcm = readWav16kMono(await fs.readFile(args.wav));
  const results = [];
  for (const provider of args.providers) {
    if (provider === "soniox") {
      if (!keys.soniox) throw new Error("SONIOX_API_KEY missing (env or ~/.config/realtime-noel/soniox.env)");
      for (const mode of args.modes) results.push(await runSoniox({ key: keys.soniox, pcm, mode, endpoint: args.endpoint, realtime: args.realtime }));
    } else if (provider === "gemini") {
      if (!keys.gemini) throw new Error("Gemini API key missing (settings.json apiKeys.gemini or GEMINI_API_KEY)");
      results.push(await runGemini({ key: keys.gemini, pcm, realtime: args.realtime }));
    }
  }
  const out = args.out ?? path.join(process.cwd(), "scratch", `engine-spike-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify({ wav: path.basename(args.wav), results }, null, 2));
  for (const r of results) {
    console.log(`${r.provider}/${r.mode}${r.endpoint ? `@${r.endpoint}` : ""}: connect ${r.connectMs}ms, finals ${r.finals}, other-script finals ${r.otherScriptFinals}, first partial p50 ${r.firstPartialMs.p50}ms, final lag p50 ${r.finalLagMs.p50}ms${r.firstTranslationMs ? `, first translation p50 ${r.firstTranslationMs.p50}ms` : ""}, errors ${r.errors.length}`);
  }
  console.log(`written ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
```

Add `"spike:engine": "node ./scripts/engine-spike.mjs"` to root `package.json` scripts and `scratch/` to `.gitignore` if absent.

- [ ] **Step 4: Run helper tests**

Run: `node --test test/engine-spike.test.js`
Expected: 3 PASS

- [ ] **Step 5: Prepare synthetic Korean/English fixtures (no customer audio)**

```bash
mkdir -p scratch
say -v Yuna -o scratch/ko.aiff "안녕하세요. 이번 분기 영업이익은 35억 원이며 ARR은 12% 증가했습니다. 프로젝트 오로라는 9월 15일 출시 예정입니다."
say -v Samantha -o scratch/en.aiff "Good afternoon. Cloud and AI services drove the results this quarter, and operating profit reached three point five billion won."
ffmpeg -loglevel error -y -i scratch/ko.aiff -i scratch/en.aiff -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" -ac 1 -ar 16000 -sample_fmt s16 scratch/ko-en.wav
```

- [ ] **Step 6: Run the spike (needs the user's keys; ~2 minutes; paid, a few cents)**

Run: `npm run spike:engine -- --wav scratch/ko-en.wav --endpoint us` then `npm run spike:engine -- --wav scratch/ko-en.wav --providers soniox --modes auto --endpoint jp`
Expected: one line per run; JSON written under `scratch/`. Record: other-script finals (must be 0 for Soniox strict modes), first partial p50, first translation p50, connect ms per endpoint. If Soniox returns `unauthenticated`, the key file is missing or wrong — do not retry in a loop.

- [ ] **Step 7: Decide the default and record it**

If Soniox `auto` shows 0 other-script finals, first partial p50 ≤ Gemini's, and translations are present: change `DEFAULT_ENGINE_SELECTION` in `packages/caption-core/caption-engine-catalog.js` to `stt: soniox/stt-rt-v5/auto`, `translation: soniox/stt-rt-v5` and update the Task 1 test expectation; otherwise keep Gemini. Either way, append a `## Spike result <date>` section to `docs/superpowers/specs/2026-09-02-soniox-fit-analysis.md` with the printed lines (no transcripts of real people, synthetic only).

- [ ] **Step 8: Run full suite, commit**

Run: `npm test 2>&1 | tail -6 && npm run typecheck`

```bash
git add scripts/engine-spike.mjs test/engine-spike.test.js package.json .gitignore packages/caption-core/caption-engine-catalog.js test/caption-engine-catalog.test.js docs/superpowers/specs/2026-09-02-soniox-fit-analysis.md
git commit -m "feat(spike): real-API caption engine comparison script and default provider decision"
```

---

### Task 9: Gateway/webapp compile check and hand-off to Plan 2

**Files:**
- Verify only: `media-gateway/`, `webapp/`

- [ ] **Step 1: Run the other two suites against the shared package changes**

Run: `npm --prefix media-gateway test 2>&1 | tail -6 && npm --prefix webapp run test:live 2>&1 | tail -6 && npm --prefix webapp run typecheck`
Expected: gateway tests that pin `gemini-3.5-live-translate-preview` as the source default fail (`media-gateway/test/host-model-authorization.test.js`, `gemini-runtime-composition.test.js`, `direct-live-*`); everything else passes. Do not fix them here — list the failing files in the Plan 2 hand-off note. Webapp `model-preferences.test.ts` may fail on the default id; same treatment.

- [ ] **Step 2: Write the hand-off note**

Append to `docs/superpowers/specs/2026-09-02-caption-engine-provider-hotswap-design.md`:

```markdown
## Plan 1 hand-off (desktop complete)

- Catalog: `packages/caption-core/caption-engine-catalog.js`; protocol: `soniox-protocol.js`.
- Gateway/webapp still consume `gemini-model-catalog.js` (shim). Failing gateway tests to replace in Plan 2: <list from Step 1>.
- Installed NOVA.app and deployed gateway unchanged; Live Call from `npm run desktop` is rejected until Plan 2 deploys.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-02-caption-engine-provider-hotswap-design.md
git commit -m "docs: plan 1 hand-off notes for gateway/webapp engine migration"
```

---

## Self-Review

**Spec coverage (Plan 1 scope):** §1 catalog + adapter contract → Tasks 1, 4, 5. §2 settings schema/migration/`hasSonioxKey`/client catalog → Tasks 3, 4, 7. §3.1 desktop hot swap open-new-first, language mode via same path, replay ring + dedup → Task 6 (open-new-first, trigger), Task 5 (replay ring); **gap:** boundary-sentence dedup after mode switch is not implemented — the lane's `commit` already ignores exact duplicates via `isSourceEcho`, but normalized-overlap dedup (≥12 chars) is deferred to Plan 2's shared segment layer; noted here so it is not lost. §3.2/§3.3 → Plan 2. §4 Soniox error branching (`error_type`, no reconnect on auth/invalid) → Task 5 Step 8; backoff cap 5 s is the existing `RECONNECT_MAX_MS`. §5 segment ids on source/translation → Task 5 (`segmentId` on events and broadcasts); DB provenance → Plan 2. §6 unit/integration/spike → Tasks 1-8. §7 deploy → Plan 2.

**Placeholder scan:** all code steps carry code; "adapt the helper name" instructions in Tasks 3/6/7 refer to helpers that already exist in those test files (`createTempStore`, `startTestServer`, `createHarness`) — the implementer must use the actual names found in the file.

**Type consistency:** transport surface `{ requiresSetupAck, binaryAudio, providerLabel, maximumSessionMilliseconds, assertReady, connect, setupPayloads, audioPayload, replayPayloads, keepalivePayload, finalizePayload, closePayload, handleMessage }` is used identically in Tasks 4, 5, 6. Lane methods `acceptProviderTranslation`, `onProviderBoundary`, `targetLanguage` defined in Task 4 and called in Task 4's message handler; `providerTranslated` set in Task 5, read in Task 4. `engineSelectionKey`, `engineRequiredApiKeys`, `normalizeEngineSelection` names match Task 1 across Tasks 3, 4, 6.
