# Caption Engine Plan 2: Gateway Engines, Live Call Hot Swap, Webapp Engine Field, Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the media gateway and the webapp consume the shared engine catalog from Plan 1 so a running Live Call can switch STT/translation provider immediately, add the Soniox gateway adapter, reconcile every gateway/webapp test that still pins the removed Live Translate contract, and deploy gateway + webapp + desktop.

**Architecture:** The gateway keeps `LiveMediaPipeline` + `RollingSpeechSession` and gains an engine factory (`media-gateway/src/engines/`) that builds the STT provider and the text translator from `captionConfig.engine`. Soniox is a "combined" provider: its adapter attaches segment translations to each final utterance and streams partial translations, so the pipeline skips `textTranslate` for combined engines. The webapp stores `engine` in `event_metadata.modelPreferences.engine` (superset of the old shape), lifts the "pinned at creation" rule, and appends `engineHistory`. Hot swap reuses the gateway's existing `update` path (fingerprint change → new pipeline, seq carried over); the desktop/web host sends PATCH then `update`. Deploy order: gateway (secret + 0% revision + traffic) → Vercel → DMG.

**Tech Stack:** Node 24, `node:test`, `ws`, `@google/genai` (gateway), Next.js + zod (webapp), Supabase RPC, Cloud Run, Vercel, electron-builder.

**Spec:** `docs/superpowers/specs/2026-09-02-caption-engine-provider-hotswap-design.md` (§1 gateway side, §3.2, §3.3, §4 `engine-status`, §5 provenance, §7) and its "Plan 1 hand-off" section.

## Global Constraints

- Three suites, three installs: root `npm test`, `npm --prefix media-gateway test`, `npm --prefix webapp test` (test:live + test:core) — all three must pass at the end of Tasks 6 and 7; `npm run typecheck` (root) and `npm --prefix webapp run typecheck` clean.
- The working tree is authoritative until Task 6 commits the gateway/gemini-server files; after Task 6 every commit must also pass on a clean checkout (verify in a throwaway worktree, Task 7).
- No automatic provider/model substitution on provider failure; Gemini text translation keeps the one-attempt-per-model fallback chain (`fallbackModels` from the catalog) only.
- Gateway never returns key values to clients; `SONIOX_API_KEY` is read from env (Secret Manager `realtime-noel-soniox-api-key`) and a Soniox engine selection without the key is rejected with `ENGINE_KEY_MISSING` before any pipeline is created.
- Caption `seq` contract C1 (finals-only counter) unchanged; a swapped-in pipeline reseeds from durable max seq via the existing `resolvePipelineInitialSequences`.
- Stage only files named in each task; never `git add -A`. Conventional commit messages ending with a blank line and `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Korean UI copy: labels and values only.
- Deploy steps that change production (Cloud Run traffic, Vercel prod, DMG install) require the user's explicit go in the session before running.

---

## File Structure

| File | Responsibility |
|---|---|
| `media-gateway/src/engines/create-engines.js` (create) | `createSpeechToText({engine, ctx})`, `createTextTranslate({engine, ctx})`, `isCombinedEngine` re-export; the only place that maps catalog entries to adapters |
| `media-gateway/src/engines/soniox-realtime-adapter.js` (create) | Soniox WS adapter implementing the STT provider contract (`open({onFinalUtterance,onPartialTranscript,onPartialTranslation,onContinuityDiscard,signal})`) using `packages/caption-core/soniox-protocol.js` |
| `media-gateway/src/google-provider-adapters.js` (modify) | model ids come from the catalog entry passed in (no `LEGACY_*` constants); `GeminiTextTranslateAdapter` gets `fallbackModels` + per-model one attempt |
| `media-gateway/src/live-media-pipeline.js` (modify) | remove direct-translation branch; add combined-provider path (`utterance.translations`, `acceptPartialTranslation`); provenance from engine |
| `media-gateway/src/server.js`, `config.js`, `gateway-server.js`, `supabase-adapters.js` (modify) | factory uses `captionConfig.engine`; `SONIOX_API_KEY`; `ENGINE_KEY_MISSING`; authorizer compares `engine`; `engine-status` host event |
| `packages/gemini-server/policy.js` (modify) | `translation` workload restored; summary models from catalog |
| `webapp/lib/live/model-preferences.ts`, `store.ts`, `service.ts`, `live-input-validation.ts`, `live-contract.ts`, `live-audio-client.ts`, `LiveHostDashboard.tsx`, `app/api/live-sessions/*` (modify) | `modelPreferences.engine`, `engineHistory`, PATCH allowed while live, `update` after PATCH |
| `electron/main.js` (modify) | on engine change with an armed Live Call: PATCH → `update` (reuse restart sender with `type: "update"`) |
| Delete | `media-gateway/src/direct-live-translation-session.js`, `gemini-live-translate-adapter.js`, `gemini-source-transcriber.js`, and tests `direct-live-*.test.js`, `gemini-live-translate-adapter.test.js`, `gemini-source-transcriber.test.js`, `live-input-source-*.test.js`, `independent-translation-publisher.test.js`, `source-recording-gap.test.js` (keep the SQL migration files; the gap-recording publisher stays because the spec keeps source-gap recording) |

---

### Task 1: Gateway engine factory and config

**Files:**
- Create: `media-gateway/src/engines/create-engines.js`, `media-gateway/test/create-engines.test.js`
- Modify: `media-gateway/src/config.js` (env), `media-gateway/src/google-provider-adapters.js` (constructor model checks), `packages/gemini-server/policy.js`

**Interfaces:**
- Produces: `createSpeechToText({ engine, liveClient, sonioxApiKey, languageCodes, compiledGlossary, glossaryText, domainText })` → object with `open(...)` (STT provider contract); `createTextTranslate({ engine, geminiRuntime, sessionId })` → `{ translate }` or `null` when `isCombinedEngine(engine)`; `assertEngineKeys(engine, env)` throws `Error("ENGINE_KEY_MISSING")`.
- Consumes: `normalizeEngineSelection`, `isCombinedEngine`, `findEngineEntry`, `engineRequiredApiKeys` from `packages/caption-core/caption-engine-catalog.js`.

- [ ] **Step 1: Failing tests**

```js
// media-gateway/test/create-engines.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEngineKeys, createSpeechToText, createTextTranslate } from "../src/engines/create-engines.js";
import { DEFAULT_ENGINE_SELECTION } from "../../packages/caption-core/caption-engine-catalog.js";

const soniox = { stt: { provider: "soniox", model: "stt-rt-v5", languageMode: "auto" }, translation: { provider: "soniox", model: "stt-rt-v5" }, summary: { provider: "gemini", model: "gemini-3.6-flash" } };
const fakeLiveClient = { live: { connect: async () => ({ sendRealtimeInput() {}, close() {} }) } };
const fakeRuntime = { createSessionClient: () => ({ models: { generateContent: async () => ({ text: "x" }) } }) };

test("gemini engine builds the Transcribe adapter and a text translator with the catalog fallback chain", () => {
  const stt = createSpeechToText({ engine: DEFAULT_ENGINE_SELECTION, liveClient: fakeLiveClient, sonioxApiKey: "", languageCodes: ["ko-KR", "en-US"], compiledGlossary: null });
  assert.equal(typeof stt.open, "function");
  const translate = createTextTranslate({ engine: DEFAULT_ENGINE_SELECTION, geminiRuntime: fakeRuntime, sessionId: "s1" });
  assert.equal(translate.model, "gemini-3.6-flash");
  assert.deepEqual(translate.fallbackModels, ["gemini-3.5-flash-lite"]);
});

test("soniox combined engine builds the soniox adapter and no text translator", () => {
  const stt = createSpeechToText({ engine: soniox, liveClient: fakeLiveClient, sonioxApiKey: "fixture-key", languageCodes: ["ko-KR", "en-US"], compiledGlossary: null, translationLanguages: ["en", "ko"] });
  assert.equal(stt.provider, "soniox");
  assert.equal(createTextTranslate({ engine: soniox, geminiRuntime: fakeRuntime, sessionId: "s1" }), null);
});

test("missing provider key is rejected before any adapter is built", () => {
  assert.throws(() => assertEngineKeys(soniox, { GEMINI_API_KEY: "fixture-key" }), /ENGINE_KEY_MISSING/u);
  assert.doesNotThrow(() => assertEngineKeys(soniox, { GEMINI_API_KEY: "fixture-key", SONIOX_API_KEY: "fixture-key" }));
  assert.throws(() => createSpeechToText({ engine: soniox, liveClient: fakeLiveClient, sonioxApiKey: "", languageCodes: [], compiledGlossary: null, translationLanguages: ["en", "ko"] }), /ENGINE_KEY_MISSING/u);
});
```

- [ ] **Step 2: Run** `npm --prefix media-gateway test -- test/create-engines.test.js` → FAIL (module not found)

- [ ] **Step 3: Implement the factory**

```js
// media-gateway/src/engines/create-engines.js
import { engineRequiredApiKeys, findEngineEntry, isCombinedEngine, normalizeEngineSelection } from "../../../packages/caption-core/caption-engine-catalog.js";
import { GeminiLiveTranscriptionAdapter, GeminiTextTranslateAdapter } from "../google-provider-adapters.js";
import { SonioxRealtimeAdapter } from "./soniox-realtime-adapter.js";

const ENV_KEY_BY_PROVIDER_KEY = Object.freeze({ gemini: "GEMINI_API_KEY", soniox: "SONIOX_API_KEY" });

export { isCombinedEngine };

export function assertEngineKeys(engine, environment = process.env) {
  const selection = normalizeEngineSelection(engine);
  for (const key of engineRequiredApiKeys(selection)) {
    const envName = ENV_KEY_BY_PROVIDER_KEY[key];
    if (!envName || !String(environment[envName] ?? "").trim()) throw new Error("ENGINE_KEY_MISSING");
  }
  return selection;
}

export function createSpeechToText({ engine, liveClient, sonioxApiKey = "", languageCodes = [], compiledGlossary = null, glossaryText = "", domainText = "", translationLanguages = [] }) {
  const selection = normalizeEngineSelection(engine);
  if (selection.stt.provider === "gemini") {
    return Object.assign(new GeminiLiveTranscriptionAdapter({ client: liveClient, model: selection.stt.model, languageCodes, compiledGlossary }), { provider: "gemini" });
  }
  if (selection.stt.provider === "soniox") {
    if (!String(sonioxApiKey).trim()) throw new Error("ENGINE_KEY_MISSING");
    return new SonioxRealtimeAdapter({ apiKey: sonioxApiKey, languageMode: selection.stt.languageMode,
      translation: isCombinedEngine(selection), translationLanguages, glossaryText, domainText });
  }
  throw new Error("ENGINE_SELECTION_INVALID");
}

export function createTextTranslate({ engine, geminiRuntime, sessionId }) {
  const selection = normalizeEngineSelection(engine);
  if (isCombinedEngine(selection)) return null;
  if (selection.translation.provider !== "gemini") throw new Error("ENGINE_SELECTION_INVALID");
  const entry = findEngineEntry("translation", "gemini", selection.translation.model);
  return new GeminiTextTranslateAdapter({
    client: geminiRuntime.createSessionClient(sessionId, "translation", { model: selection.translation.model }),
    model: selection.translation.model,
    fallbackModels: entry?.fallbackModels ?? [],
    fallbackClients: (entry?.fallbackModels ?? []).map((model) => geminiRuntime.createSessionClient(sessionId, "translation", { model })),
  });
}
```

- [ ] **Step 4: Adapter constructors accept catalog models**

In `media-gateway/src/google-provider-adapters.js`: delete `LEGACY_TRANSCRIPTION_MODEL` / `LEGACY_TEXT_TRANSLATION_MODEL`; `GeminiLiveTranscriptionAdapter` validates `findEngineEntry("stt","gemini",model)` non-null else `GEMINI_MODEL_OVERRIDE_FORBIDDEN`; `GeminiTextTranslateAdapter` validates `findEngineEntry("translation","gemini",model)`, stores `this.model`, `this.fallbackModels`, `this.fallbackClients`, default `timeoutMilliseconds = captionPolishContract.timeoutMilliseconds` (6 000). In `translate()`, on a transient failure (`GEMINI_TRANSLATE_TIMEOUT`, HTTP 5xx/429 identifiers from `safeProviderErrorIdentifier`) try each fallback client once within the remaining deadline; never retry the same model. The session runtime rejects a `model` field in `generateContent` requests, so the model is bound at `createSessionClient` time (keep that).

In `packages/gemini-server/policy.js`: `GENERATE_WORKLOADS = new Set(["topic","translation","polish","recap"])`; `resolveGeminiWorkloadModel("translation", value)` accepts any catalog translation model (`findEngineEntry("translation","gemini",value)`), `"summary"`-role for topic/recap as today; `GEMINI_WORKLOAD_THINKING_LEVELS.translation = "low"` stays.

In `media-gateway/src/config.js`: add `sonioxApiKey: String(environment.SONIOX_API_KEY ?? "").trim()` to the returned config (optional), remove the `GEMINI_TEXT_MODEL` / `GEMINI_TRANSCRIBE_MODEL` fixed-matrix check (the catalog governs), keep `GEMINI_API_KEY` required. Update `media-gateway/.env.example` and README env list.

- [ ] **Step 5: Run** `npm --prefix media-gateway test -- test/create-engines.test.js test/config.test.js test/provider-adapters.test.js` → PASS (update `config.test.js` fixtures that asserted the removed env check; keep every other assertion). Root: `node --test test/gemini-3-7-workload-contract.test.js` → update pins to the catalog contract (translation workload present, timeout `captionPolishContract.timeoutMilliseconds`, model check via catalog) — this is the reconciliation the Plan 1 hand-off promised.

- [ ] **Step 6: Commit** `feat(gateway): engine factory from the shared catalog; adapters take catalog models; translation workload restored`

---

### Task 2: Soniox gateway adapter

**Files:**
- Create: `media-gateway/src/engines/soniox-realtime-adapter.js`, `media-gateway/test/soniox-realtime-adapter.test.js`

**Interfaces:**
- Produces: `class SonioxRealtimeAdapter { constructor({ apiKey, languageMode, translation, translationLanguages, glossaryText, domainText, endpoint = "us", createWebSocket = (url) => new WebSocket(url), now = Date.now }) ; async open({ onFinalUtterance, onPartialTranscript = null, onPartialTranslation = null, onContinuityDiscard = () => {}, signal }) → { sendAudio(frame1280), gracefulDrain(), close(), abort(), getUsage() } ; provider = "soniox" }`
- Final utterance shape (matches `RollingSpeechSession` expectations used by `#processFinalUtterance`): `{ speakerLabel: "speaker-1", text, rawText, sourceLanguage, sourceStartOffsetMs, sourceEndOffsetMs, sourceEndedAt (ISO), translations: { [language]: { text, sourceLanguage } } }`; partial transcript `{ text, sourceLanguage }`; partial translation `{ language, text, sourceLanguage, segmentId }`.
- Consumes: `buildSonioxConfig`, `createSonioxTokenReducer`, `createSonioxFinalizeScheduler`, `hasSonioxContentTokens`, `SONIOX_CONTROL`, `SONIOX_ENDPOINTS` (Plan 1).
- Inherits two wire rules measured in the 2026-09-02 spike (see `docs/superpowers/specs/2026-09-02-soniox-fit-analysis.md` "Spike result"): (1) end of audio is an **empty TEXT frame** (`ws.send("")`) — an empty binary frame is ignored and `finished` never arrives; (2) continuous speech never yields `<end>`, so the adapter runs `createSonioxFinalizeScheduler` (1.2 s without new tokens while committed source text is pending, or a 15 s segment cap → send `SONIOX_CONTROL.finalize` as a text frame, at most once per segment) and commits the utterance on `<fin>` exactly as on `<end>`. The desktop transport (`src/caption-engine/soniox-transport.js`) is the reference wiring.

- [ ] **Step 1: Failing tests** — fake `ws` (EventEmitter with `send/close/readyState`): (a) first frame after open is the JSON config with `language_hints_strict: true` and `two_way` when translation enabled; audio is sent as binary Buffers of 1,280 B unchanged (gateway PCM is already 16 kHz); (b) tokens `원문 final` + `translation final` + `<end>` → one `onFinalUtterance` with `translations.en.text === "Hello"`, `sourceStartOffsetMs`/`sourceEndOffsetMs` from `start_ms/end_ms`, and one prior `onPartialTranslation`; (c) 20 s without audio → a `keepalive` control message (use injected timers); (d) `error_type: "unauthenticated"` → `open()`/callbacks fail with `SONIOX_UNAUTHENTICATED` and no reconnect; (e) `gracefulDrain()` sends the empty **text** frame (`send("")`, never `Buffer.alloc(0)`) and resolves on `finished: true` (≤5 s); (f) `close()` resolves `{ transportClosed: true, inputAudioMilliseconds }`; (g) with injected timers, a final source token followed by 1.2 s without new tokens → exactly one `{"type":"finalize"}` text frame, no re-send until the `<fin>` arrives, and the `<fin>` frame → `onFinalUtterance` (same shape as `<end>`); tokens every 500 ms for 15 s → one finalize at the segment cap; a provisional-only stretch never finalizes; `close()`/`abort()` cancel the pending timer.

- [ ] **Step 2: Run** → FAIL (module not found)

- [ ] **Step 3: Implement** — structure mirrors `GeminiLiveTranscriptionAdapter.open()` (write tail, pending-frame backpressure 64, callback tail, terminal error, close promise). Core:

```js
const reducer = createSonioxTokenReducer({
  onSourcePartial: (e) => onPartialTranscript?.({ text: e.text, sourceLanguage: e.language ?? undefined }),
  onSourceFinal: (e) => { segment = { ...e }; },                       // buffered until boundary
  onTranslationPartial: (e) => onPartialTranslation?.({ language: e.language, text: e.text, sourceLanguage: e.sourceLanguage, segmentId: e.segmentId }),
  onTranslationFinal: (e) => { translations[e.language] = { text: e.text, sourceLanguage: e.sourceLanguage }; },
  onBoundary: () => {
    if (segment?.text.trim()) onFinalUtterance({ speakerLabel: "speaker-1", text: segment.text, rawText: segment.text,
      sourceLanguage: segment.language ?? undefined, sourceStartOffsetMs: segment.startMs ?? audioOffsetMs, sourceEndOffsetMs: segment.endMs ?? audioOffsetMs,
      sourceEndedAt: new Date(now()).toISOString(), translations: { ...translations } });
    segment = null; translations = {};
  },
});
```

Reducer events are emitted per `apply(result)`; the reducer already emits source final → translation finals → boundary in that order, so buffering both until `onBoundary` yields one utterance per segment. Finalize: `const scheduler = createSonioxFinalizeScheduler({ now, setTimer, clearTimer, onFinalize: () => ws.send(SONIOX_CONTROL.finalize) })`; after every `reducer.apply(msg)` call `if (hasSonioxContentTokens(msg) && reducer.hasPendingFinalText()) scheduler.noteTokens({ hasPendingFinalText: true, atMs: now() })`; call `scheduler.noteBoundary()` inside the reducer's `onBoundary` and `scheduler.dispose()` on drain/close/abort. Keepalive: `setTimeout` chain every 5 s that sends `SONIOX_CONTROL.keepalive` if `now() - lastAudioAt > 8_000`. Rollover: none (300-minute stream cap; `maxConnectionMilliseconds = 17_400_000` then fail `SONIOX_MAX_DURATION` so `RollingSpeechSession` reopens). Error map as in the desktop transport (`SONIOX_*` codes).

- [ ] **Step 4: Run** the adapter tests → PASS. **Step 5: Commit** `feat(gateway): soniox stt-rt-v5 adapter with segment translations`

---

### Task 3: Pipeline combined-provider path and provenance

**Files:**
- Modify: `media-gateway/src/live-media-pipeline.js` (remove `createLiveTranslationSession` branch, `#openDirectTranslation`, `#persistIndependentSource`, `#reportSourceRecordingFailure` stays but is driven by STT adapter `onError` with segment ranges; `#processFinalUtterance` translation step; new `acceptPartialTranslation`), `media-gateway/src/server.js` (factory), `media-gateway/src/supabase-adapters.js` (keep `persistSourceRecordingGap`, remove `publishIndependentTranslation`)
- Delete: files listed in File Structure
- Tests: `media-gateway/test/captions-only-live-call.test.js` (+ combined-engine cases), `gemini-only-shared-engine.test.js` (rename expectations), `pipeline*.test.js`

- [ ] **Step 1: Failing tests** in `captions-only-live-call.test.js`: (a) with a fake STT provider that emits a final with `translations: { en: { text: "Hello", sourceLanguage: "ko" } }` and a pipeline built with `textTranslate: null` and `engine` = soniox combined → the `en` lane publishes a final caption with `text: "Hello"`, `translationStatus: "translated"`, `translationModel: "stt-rt-v5"`, and `textTranslate` is never called; (b) a partial translation event → `en` lane `isFinal: false` caption with the same seq the coming final will take (`#peekCaptionSeq`), never consuming a seq; (c) provenance: `persistAuthoritativeSource` receives `sttProvider: "soniox"`, `sttModel: "stt-rt-v5"`; Gemini path receives `"gemini-transcribe-live"` / `"gemini-3.5-transcribe-live"` and `translationModel` = engine translation model.

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**
  - Constructor: accept `engine` (from `captionConfig.engine`), store `this.engine`, `this.isCombined = isCombinedEngine(engine)`; `dependencies.textTranslate` may be `null` only when combined (else throw `TEXT_TRANSLATE_REQUIRED`).
  - `#openSpeechSession`: remove the direct branch; pass `onPartialTranslation: (event) => this.acceptPartialTranslation(event)` into `speechToText.open`.
  - `acceptPartialTranslation({ language, text, sourceLanguage })`: if `!this.languages.includes(language)` return; run `applyGlossaryCorrections` + `isOutputInTargetLanguage` gate; publish via the existing partial-lane publisher with `isFinal: false`, `seq: this.#peekCaptionSeq(language)`.
  - `#processFinalUtterance`: when `this.isCombined && utterance.translations?.[language]?.text`, set `translatedText = translations[language].text` and skip `textTranslate.translate`, still run `captionFinalizer.finalize({..., hasPriorTextModelCall: true})` and the deterministic glossary pass; when combined but the translation is missing for a lane → publish `translationStatus: "failed"` with the source text (existing fail-open contract) and `LANGUAGE_UNAVAILABLE` status.
  - Provenance: `sttProvider`/`sttModel` from `this.engine.stt`, `translationModel` from `this.engine.translation.model` (persistAuthoritativeSource + caption `translationModel`). Remove the hard-coded `"gemini-live-input-transcription"` / `"gemini-3.5-live-translate-preview"` strings; `normalizeAuthoritativeSourceInput` in `supabase-adapters.js` accepts `sttProvider in ("gemini-transcribe-live","soniox")`.
  - `server.js` factory: `const engine = captionConfig.engine; assertEngineKeys(engine, process.env)` inside the start path (throw `ENGINE_KEY_MISSING` → gateway error message "선택한 엔진의 API 키가 서버에 없습니다."); `speechToText: createSpeechToText({...})`, `textTranslate: createTextTranslate({...})`, `captionPolish` unchanged.
  - Delete the direct files and their tests; delete `bindTopicModel` special-casing if it referenced `models.live`.

- [ ] **Step 4: Run** `npm --prefix media-gateway test` → remaining failures must be only the authorizer/model pins handled in Task 4. **Step 5: Commit** `feat(gateway): combined-provider translations in the pipeline; engine-derived provenance; remove direct live-translate path`

---

### Task 4: Webapp `engine` field, PATCH while live, authorizer parity

**Files:**
- Modify: `webapp/lib/live/model-preferences.ts`, `webapp/lib/security/live-input-validation.ts`, `webapp/lib/live/store.ts` (eventMetadataBody, parseStoredEventMetadata, `engineHistory`), `webapp/lib/live/service.ts` (remove `SESSION_MODEL_PREFERENCES_PINNED`; append history), `webapp/lib/live-contract.ts`, `webapp/components/live/live-audio-client.ts` (`captionConfig.engine`), `webapp/components/live/LiveHostDashboard.tsx` (engine picker reads `/api/live-config.captionEngines`), `webapp/app/api/live-config/route.ts` (add `captionEngines` from `captionEngineCatalogForClient` with server key availability), `media-gateway/src/supabase-adapters.js` `SupabaseHostAuthorizer.authorize` (compare `engine`), `electron/main.js` (`pinLiveCallModelSettings` sends `engine`)
- Tests: `webapp/lib/live/model-preferences.test.ts`, `live-service.test.ts`, `live-security.test.ts`, `components/live/host-manual-start.test.ts`, `media-gateway/test/host-model-authorization.test.js`, root `test/desktop-live-model-preferences.test.js`

- [ ] **Step 1: Failing tests** — schema accepts `{ source, summary }` (legacy) AND `{ engine }`; stored legacy rows read back as `engine` via `migrateLegacyEngineSelection`; PATCH with a different `engine` on a `live` session succeeds and appends `engineHistory[{ engine, changedAt, byHostId }]` (max 64); gateway authorizer accepts when `captionConfig.engine` equals the DB `engine` (deep-equal after normalization) and rejects otherwise; `/api/live-config` returns `captionEngines` with `available` reflecting `GEMINI_API_KEY`/`SONIOX_API_KEY` presence on the webapp server (booleans only).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (zod: `liveModelPreferencesSchema = z.union([legacyShape.transform(toEngine), z.object({ engine: engineSchema }).strict()])` where `engineSchema` validates via `normalizeEngineSelection`; store writes `{ engine, engineHistory }` inside `modelPreferences`). Desktop `pinLiveCallModelSettings` sends `modelPreferences: { engine }`. Gateway authorizer: `engineSelectionKey(config.engine) === engineSelectionKey(preferences.engine ?? migrateLegacy(preferences))`.

- [ ] **Step 4: Run** webapp test:live + test:core, gateway suite, root `test/desktop-live-model-preferences.test.js` → PASS. **Step 5: Commit** `feat(live): engine selection travels as modelPreferences.engine; PATCH allowed while live with engineHistory; gateway authorizer parity`

---

### Task 5: Admin-triggered Live Call engine switch and `engine-status`

> Re-scoped 2026-09-04 by user decision (auth console spec §9): the admin's global engine is the only Live Call engine, hosts cannot change it, and a deploy applies to running sessions immediately. There is **no** desktop-settings-originated Live Call hot swap.

**Files:**
- Modify: `media-gateway/src/server.js` + `gateway-server.js` (HTTP `POST /internal/sessions/:sessionId/engine`; `engine-status` host event; reuse the `update` pipeline-replacement path), `webapp/lib/auth/live-auth.ts` (mint `role: "ADMIN"` gateway token: `{ role: "ADMIN", sub: <admin hostId>, sessionId, aud: "media-gateway", iat, exp ≤ 60 s }` signed with `LIVE_GATEWAY_TOKEN_SECRET`, verified on the gateway with the existing token verifier), `webapp/lib/live/gateway-engine-push.ts` (new: `pushEngineToGateway({ gatewayHttpUrl, sessionId, engine, token, fetchFn })` → `"switched" | "queued" | "failed"`), `webapp/components/live/LiveHostDashboard.tsx` + `public/subtitle-controller.js` (read-only engine status line/pill fed by `engine-status`), `webapp/components/live/live-audio-client.ts` (surface `engine-status`)
- Tests: gateway `gateway-server.test.js` (internal endpoint: bad token 401, unknown session → `queued`, live session → new pipeline, old closed, seq continuity, viewers get `language-status preparing→ready`, host gets `engine-status connecting→ready`), webapp `gateway-engine-push.test.ts`, `live-audio-client.test.ts`, root `test/desktop-live-*.test.js` (controller pill)

- [ ] **Step 1: Failing tests**; **Step 2: RED**; **Step 3: Implement**: the gateway HTTP server (where `/health` lives) gains `POST /internal/sessions/:sessionId/engine` with body `{ engine }` (normalized via `normalizeEngineSelection`, `assertEngineKeys`) and `Authorization: Bearer <ADMIN token>`; when the session has an active pipeline, run the same replacement the host `update` message performs (open new → ready → close old; `resolvePipelineInitialSequences` reseeds seq) and answer `{ result: "switched" }`; when the gateway holds no pipeline for that session answer `{ result: "queued" }` (the DB value applies at next activation). `engine-status` is sent from `gateway-server.js` where `language-status` is sent today (`connecting` on start, `ready` when `start()` resolves, `failed` with code from `failOwnedPipeline`). Host UIs render it read-only; the engine picker in the web host dashboard (Task 4) shows "관리자 지정" and is disabled for non-admin roles. **Step 4: GREEN**; **Step 5: Commit** `feat(live-call): admin-triggered engine switch for running sessions and engine-status events`

---

### Task 6: Reconcile every remaining pin; commit the gateway/gemini-server working tree

**Files:** `media-gateway/test/*` (list from Plan 1 hand-off + Task 3 deletions), `packages/gemini-server/*.test.js`, root `test/gemini-3-7-workload-contract.test.js`, `webapp/lib/live/*.test.ts`

- [ ] **Step 1:** run all three suites; list failing files. **Step 2:** for each: contract pin of the removed Live Translate default → update to the catalog default; import of a deleted module → delete the test (it tested the removed path); anything else → fix the code. **Step 3:** `git add` the gateway `src/` and `packages/gemini-server` files that were uncommitted WT (this is the moment the branch becomes self-consistent); `git status --short | wc -l` afterwards must not list any `media-gateway/src` or `packages/gemini-server` file. **Step 4:** all three suites + both typechecks green. **Step 5: Commit** `test(gateway,webapp): reconcile engine-catalog contract pins; commit gateway working tree`

---

### Task 7: Deploy (needs the user's go at each production step)

- [ ] **Step 1: Clean-worktree verification** — `git worktree add /tmp/nova-verify HEAD && cd /tmp/nova-verify && npm ci && npm test && npm --prefix media-gateway ci && npm --prefix media-gateway test && npm --prefix webapp ci && npm --prefix webapp test && npm run typecheck && npm --prefix webapp run typecheck`; expected all green (the root `npm ci` lockfile debt in TODOS.md may block — if so, record and use `npm install` for the verification only).
- [ ] **Step 2: Gateway** — from repo root: `gcloud builds submit --config cloudbuild.media-gateway.yaml --region asia-northeast3 --project gen-lang-client-0321430669`; then `gcloud run deploy realtime-noel-media-gateway --region asia-northeast3 --project gen-lang-client-0321430669 --image <digest> --revision-suffix engines-<date> --no-traffic --update-secrets SONIOX_API_KEY=realtime-noel-soniox-api-key:latest`; `curl -s https://realtime-noel-media-gateway-1020335991043.asia-northeast3.run.app/health`; then `gcloud run services update-traffic realtime-noel-media-gateway --region asia-northeast3 --project gen-lang-client-0321430669 --to-revisions realtime-noel-media-gateway-engines-<date>=100`. Rollback: `--to-revisions realtime-noel-media-gateway-live-input-20260901=100`.
- [ ] **Step 3: Webapp** — `vercel deploy --prod` from the repo root (per memory the webapp deploys from the root); verify `/api/live-config` returns `captionEngines`; a test Live Call from the web host with Gemini engine works; rollback = previous deployment promote.
- [ ] **Step 4: Desktop** — `npm run dist:mac`; install per the existing procedure (quit NOVA, back up `/Applications/NOVA.app`, replace); verify local captions (Gemini and Soniox if key present) and one Live Call engine swap end-to-end.
- [ ] **Step 5:** update `docs/superpowers/specs/2026-09-02-caption-engine-provider-hotswap-design.md` status + AGENTS.md test counts; commit `docs: plan 2 deployment record`.

---

## Self-Review

**Spec coverage:** §1 gateway engines (T1-T3), §3.2 hot swap (T4-T5), §3.3 secret (T7), §4 `engine-status` + Soniox error mapping (T2, T5), §5 provenance (T3), §6 tests (T1-T6), §7 deploy (T7). Deferred from Plan 1 and now owned: root workload test reconciliation (T1/T6), gateway `config.test` (T1), `gemini-source-transcriber` test crash (T3 deletion), `engineHistory` (T4). Normalized-overlap dedup after reconnect (spec §3.1.4) remains unowned — noted as a follow-up in T7's docs step.

**Placeholder scan:** T2 Step 1 and T4/T5 Step 1 describe tests in prose with exact expectations rather than full code because the harness files (`captions-only-live-call.test.js`, `gateway-server.test.js`, `live-security.test.ts`) define large fixtures the implementer must reuse; each expectation names the observable value to assert.

**Type consistency:** `assertEngineKeys`, `createSpeechToText`, `createTextTranslate` (T1) are consumed by name in T3's `server.js` step; `onPartialTranslation` (T2) is consumed by T3's `#openSpeechSession`; `utterance.translations[language].text` shape defined in T2 is read in T3; `modelPreferences.engine`/`engineHistory` (T4) is what T5's PATCH sends and the authorizer compares via `engineSelectionKey`.
