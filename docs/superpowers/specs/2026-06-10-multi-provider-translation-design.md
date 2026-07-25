# Multi-provider realtime translation + movie-style subtitles — Design

Date: 2026-06-10
Status: Approved (proceed to implementation)

## Goals

1. **Translation engine selection**: settings dropdown chooses the realtime
   translation provider — OpenAI `gpt-realtime-translate` (current, default) or
   Google `gemini-3.5-live-translate-preview` (Gemini Live API, public preview
   since 2026-06-09).
2. **Clear API key registration status**: both OpenAI and Gemini keys show an
   explicit registered/unregistered badge after save. Keys are never echoed back.
3. **Business tone works on both providers** — the polish layer runs on the
   shared commit pipeline, so it is provider-agnostic by construction.
4. **Movie-style subtitle expiry**: when speech stops, the last subtitle lingers
   briefly (duration proportional to text length, like cinema subtitles) then
   clears. While partials keep arriving the subtitle never disappears.
5. **Multi-display overlay**: one always-on-top overlay window per connected
   display, kept in sync as displays are added/removed, so extended/mirrored
   screens also show subtitles.

P0 carried over: subtitles must keep feeling realtime; nothing may delay partials.

## Gemini Live API facts (researched 2026-06-10)

- Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={API_KEY}`
- Setup: `{ setup: { model: "models/gemini-3.5-live-translate-preview", generationConfig: {
  responseModalities: ["AUDIO"], inputAudioTranscription: {}, outputAudioTranscription: {},
  translationConfig: { targetLanguageCode, echoTargetLanguage: false } } } }`
- Audio in: PCM16 mono **16 kHz** base64 via `{ realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } } }`.
  Our pipeline captures at 24 kHz → server-side linear resample 24k→16k.
- Transcripts: `serverContent.inputTranscription.text` / `serverContent.outputTranscription.text`
  (fragment semantics ambiguous in docs → adapter normalizes both append and
  replacement: if the new text starts with the accumulated text, treat as replacement).
- `serverContent.turnComplete` = commit boundary; keep the existing quiet-flush
  commit timer as fallback. Ignore `serverContent.modelTurn` audio parts.
- `setupComplete` → api_ready status. `goAway`/close → recoverable reconnect.
- Audio sessions limited to ~15 min → reconnect-on-close reuses existing pattern.
- `echoTargetLanguage: false` suppresses same-language echo model-side; the
  client-side wrong-direction suppression stays as a safety net.

## Components

### `src/subtitle-realtime.js` — transport abstraction
`createTranslationChannel` is parameterized by a `transport`:
- `connect({ createWebSocket, apiKey })` → socket
- `setupPayloads({ settings, targetLanguage })` → strings sent on open
- `audioPayload(base64Pcm24k)` → string (Gemini transport resamples internally)
- `handleMessage(raw, ctx)` → maps provider messages onto the shared ctx
  (setSourceText, emitPartial, scheduleCommit, commitSubtitle, …)
- `closePayload()` → optional graceful-close message (OpenAI `session.close`;
  Gemini none → immediate socket close)

Default transport = OpenAI (existing behavior; existing tests stay green).
`createRealtimeSubtitleClient` picks the transport from
`settings.translationProvider`. Language lock, suppression, commit, and polish
stay in the shared channel core — identical for both providers.

Manager `start()` resolves the provider-specific key:
openai → `apiKeys.openai`/`OPENAI_API_KEY`; gemini → `apiKeys.gemini`/`GEMINI_API_KEY`;
missing key → provider-specific clear error blocking start.

### `src/gemini-live-translate.js` (new)
- `resamplePcm16Base64(base64, fromRate, toRate)` — linear interpolation, pure.
- `buildGeminiSetupMessage(settings, targetLanguage)`.
- `handleGeminiLiveMessage(raw, ctx)` — fragment normalization, turnComplete
  commit, setupComplete status, goAway → reconnecting.
- `createGeminiTransport({ settings, targetLanguage, apiKey })`.

### Settings (`src/settings-store.js`)
- `subtitle.translationProvider: "openai" | "gemini"` (default openai), validated.
- `subtitle.geminiModel` default `"gemini-3.5-live-translate-preview"`.
- `apiKeys.gemini: ""` default; `getSanitized()` adds `hasGeminiKey` (strips keys).

### UI (`public/subtitle.html`, `public/subtitle-dashboard.js`)
- 번역 엔진 select `name="translationProvider"`.
- Gemini API key password input `name="geminiKey"` + save patch
  `apiKeys: { gemini }` (mirror of openaiKey flow).
- Key status badges for BOTH keys: "✓ 등록됨" / "미등록" driven by
  `hasOpenAIKey` / `hasGeminiKey`; refreshed after save.

### Movie-style expiry (`public/subtitle-overlay.js`)
- After each non-status subtitle render, reset a linger timer:
  `duration = clamp(2000 + 60 × chars, 2500, 7000)` ms (cinema-style: longer
  lines stay longer; max ~7 s per subtitle conventions).
- Timer expiry clears the subtitle. Partials/commits reset the timer.
  Existing idle/stop immediate clear unchanged.

### Multi-display overlay (`electron/main.js`)
- Replace single `overlayWindow` with `overlayWindows: Map<displayId, BrowserWindow>`.
- Create one overlay per `screen.getAllDisplays()` entry with that display's bounds.
- Display added/removed/metrics-changed → reconcile windows (create/destroy/re-bound).
- Watchdog + `reassertOverlayTop` + on/off toggle iterate all overlay windows.
- All existing window properties preserved per window (screen-saver level +1,
  visibleOnFullScreen, click-through, no content protection).

## Testing (TDD)
- `test/gemini-live-translate.test.js`: resample ratio/lengths, setup message
  shape, audio payload mime/rate, fragment append + replacement normalization,
  turnComplete commit, audio parts ignored, goAway → reconnecting.
- `test/subtitle-realtime.test.js`: provider selection (gemini opens Gemini
  transport, default stays OpenAI), gemini committed lines flow through polish,
  gemini key required error.
- `test/settings-store.test.js`: provider/geminiModel validation, hasGeminiKey,
  gemini key sanitization.
- `test/subtitle-frontend.test.js`: provider select, gemini key input + badges,
  overlay linger constants/function, electron `getAllDisplays` + per-display map.

## Risks
- Model is a day-old public preview; transcript fragment semantics unverified on
  the wire → adapter normalizes both; real-device test required before relying on it.
- Gemini returns translated AUDIO we discard (no text-only modality) — bandwidth
  cost accepted in v1.
