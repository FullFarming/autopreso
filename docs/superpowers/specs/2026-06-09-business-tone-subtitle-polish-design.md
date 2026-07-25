# Business-register subtitle polish — Design

Date: 2026-06-09
Status: Approved (proceed to implementation)

## Problem

Realtime EN↔KO subtitles come out in the model's default register. Users want a
**business register** in both directions: Korean in formal honorific (격식체
존댓말), English in professional business tone, less literal/awkward phrasing,
and consistent terminology / preserved proper nouns.

Hard constraint discovered: OpenAI's `gpt-realtime-translate` **does not support
custom prompting or style parameters** — output tone follows the speaker
automatically. So tone cannot be injected into the existing realtime session; a
separate polish step is required.

## Principles

- **P0 (non-negotiable): the realtime translation must keep looking realtime.**
  Live `subtitle:partial` deltas are NEVER polished and NEVER delayed. Polish
  applies only to the `subtitle:committed` line, which replaces the
  already-visible last partial. The user always sees streaming text; the polished
  line swaps in at end-of-utterance.
- Polish must NEVER block or drop a subtitle. Any failure/timeout → fall back to
  the raw translated text.
- Default behavior unchanged (`tone: "natural"` = today's pipeline, zero extra
  cost/latency, no API call).

## Scope (v1)

- Tone setting `natural | business`, default `natural`.
- `business`: polish committed lines only, both directions.
- Automatic terminology/proper-noun handling via prompt (NO glossary UI).
- Engine: OpenAI small model, reusing the stored OpenAI key; raw fallback on failure.

Non-goals (v1): glossary UI, polishing partials, per-direction tones, polish cost
tracking, provider switching UI.

## Components

### `src/subtitle-polish.js` (new, single responsibility, DI)
- `createSubtitlePolisher({ generateText, model, log })` →
  `async polish({ translatedText, sourceText, targetLanguage, tone, signal })`.
- `tone !== "business"` or empty/trivial text → return `translatedText` unchanged,
  no API call.
- Prompt rules: preserve meaning exactly, add nothing; `ko` → 격식체 존댓말
  (합니다체); `en` → professional business English; keep proper nouns
  (people/companies/products) untranslated; consistent terminology; output ONLY
  the rewritten line (no quotes/labels).
- Robustness: ~4s timeout (AbortSignal) + try/catch → return raw `translatedText`
  on any error/timeout. Length cap on input.

### `src/subtitle-realtime.js` (commit path)
- Manager accepts injected `polish` (default no-op passthrough returning input).
- Unify the two committed broadcast sites (`scheduleCommit` timer and
  `handleRealtimeMessage` `output_transcript.done`) through one async
  `commitSubtitle({ sourceText, translatedText, source, targetLanguage })`:
  compute raw → `await polish(...)` → broadcast `subtitle:committed` with polished
  `translatedText` (sourceText unchanged) → reset utterance.
- Session guard: capture session token before polish; if the session was
  invalidated while polishing, drop the polished broadcast (reuse existing
  `state.active` / sessionId invalidation) so a late line can't paint into the
  next session.
- Partials (`emitPartial`) are untouched (P0).

### `src/server.js` (wiring)
- Build the polisher from `@ai-sdk/openai` + `generateText` (`ai`) with the stored
  OpenAI key and `subtitle.tonePolishModel`; pass `subtitle.tone`; inject into
  `createSubtitleRealtimeManager`. Tone is read from settings so it hot-swaps with
  the existing settings flow.

### `src/settings-store.js`
- `DEFAULT_SUBTITLE_SETTINGS.tone = "natural"`; validate ∈ {natural, business};
  normalize in `normalizeSubtitleSettings`. Add `tonePolishModel` default
  (small model; file-overridable, no UI).

### UI (`public/subtitle.html`, `public/subtitle-dashboard.js`)
- Settings drawer: "번역 어투" select (자연스럽게 = natural / 비즈니스 = business).
- Include `tone` in the saved settings payload. Overlay unchanged.

## Data flow

```
audio → realtime channel → input/output transcript deltas
  → subtitle:partial (RAW, live, never polished)         ← P0 realtime feel
  → utterance ends → commitSubtitle()
       → polish(raw) [business] or passthrough [natural]
       → subtitle:committed (polished) → overlay/dashboard + history
```

## Testing (TDD)

- `test/subtitle-polish.test.js`: passthrough when natural; business prompt
  contains ko-honorific / en-professional / proper-noun / meaning-preserving
  rules; injected `generateText` throw → raw fallback; timeout → raw fallback;
  trivial/empty input → no call.
- `test/subtitle-realtime.test.js`: committed broadcast uses polished text when a
  polisher is injected; partials stay raw; polish failure → raw committed;
  session invalidation during polish drops the late committed line.
- `test/settings-store.test.js`: tone default/validation/normalization.
- `test/subtitle-frontend.test.js`: dashboard sends `tone`; settings drawer has
  the select with both options.

## Risks

- Added latency on the committed line. Mitigated by P0 (partials carry the live
  feel) + timeout→raw fallback. Last partial stays visible during polish so there
  is no blank gap.
- Cost: one small-model call per committed sentence. Acceptable; tracking deferred.
