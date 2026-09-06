# Specification: Live Call Quality and Gemini Boundary

Status: Planned, awaiting implementation approval  
Date: 2026-08-15  
Scope: `autopreso` web host, participant viewer, media gateway, meeting recap

## Objective

Raise the current Live Call implementation from feature-complete to production-quality by reviewing correctness, simplicity, architecture, security, and performance, then applying only evidence-backed improvements. Gemini is a server-only dependency whose model, quota, prompt, output, and failure behavior are explicit per workload.

## Product Outcomes

1. Captions remain the primary product path. Gemini topic, polish, or recap failure never blocks durable source captions.
2. Participants receive text captions and topic metadata only. No participant microphone or translated-audio path is restored.
3. Host controls expose user-actionable AI health states, not API keys, model internals, raw provider errors, or token counts.
4. Meeting recap uses authoritative durable topics and utterance membership as its chapter structure instead of asking the model to rediscover chronology.
5. A failed recap attempt has one clear state and a bounded manual retry path. There is no hidden provider retry or alternate-model fallback.
6. Existing join, refresh recovery, invite, owner authorization, no-store, and retention contracts remain intact.

## Gemini Workload Matrix

| Workload | Model | Reason | Failure policy |
|---|---|---|---|
| Continuous host audio translation | `gemini-3.5-live-translate-preview` | Official continuous low-latency Live Translation model | Keep source captions; surface translation degraded state; no alternate provider |
| Topic boundary classification | `gemini-3.7-flash` (`low`) | Stable structured-output classification with bounded latency | Deterministic continue/fallback topic; no provider retry |
| Final text translation and selective polish | `gemini-3.7-flash` (`low`) | GA quality path for business-language output | Preserve committed draft or explicit failed translation state |
| Post-call recap | `gemini-3.7-flash` (`medium`) | GA structured output with grounded topic context | Durable single-winner claim; bounded manual retry only |

Model IDs are server configuration selected from a strict allowlist. Browser input, session settings, URLs, and gateway messages cannot choose a model. Preview Live Translation is isolated behind its adapter so its retirement does not alter caption persistence.

## Gemini Engineering Contract

- Use the existing server-side `@google/genai` installation; add no browser Gemini dependency.
- Keep `generateContent` for the stable text path. Do not migrate to the experimental Interactions API in this change.
- Construct one server client with `httpOptions.retryOptions.attempts = 1`; application calls also perform no automatic retry.
- Do not send deprecated `temperature`, `topP`, or `topK` parameters to Gemini 3.x.
- Structured calls set `responseMimeType: application/json`, a strict supported JSON schema, and then validate the returned object again locally.
- Apply a canonical sensitive-text redactor immediately before every prompt boundary and before model-derived local summaries are persisted.
- Never send email, company, department, job title, consent, access code, invite token, grant, session credential, API key, or cross-session content.
- Provider output is untrusted plain data. It never reaches HTML, SQL, a shell, a URL, a model selector, or an authorization decision.
- Bound prompt characters, output tokens, concurrent calls, per-session request rate, and total outstanding work before making a provider call.
- Record workload, allowlisted model, latency, safe result code, and numeric usage metadata only. Never log prompts, responses, keys, transcript text, or participant identity.
- Abort/timeout releases local work but is not treated as proof that Google stopped billing; budgets are enforced before dispatch.
- Production operations must use a restricted/auth Gemini key stored server-side and keep AI Studio developer logging/data sharing disabled for confidential meeting content.

## Security Tombstones and Dead Code

- Keep `/api/gemini-token` and `/api/pair-keys` as explicit `410` tombstones for one compatibility cycle.
- Remove the unused browser `webapp/lib/geminiChannel.ts` transport and its test entry. It still describes fetching a long-lived key even though the route is closed and has no production importer.
- Update stale comments that point to the removed browser transport.
- A static contract must fail if a browser bundle imports `@google/genai`, calls the Gemini WebSocket host directly, or expects an API key response.

## Structural Quality Contract

- Split behavior-preserving refactors from feature changes.
- Decompose `LiveViewer.tsx` and `LiveHostDashboard.tsx` into state orchestration hooks and focused presentation components before adding new UI branches.
- Move topic orchestration out of `supabase-adapters.js`; the data adapter remains responsible for validated IO, not detector state and timers.
- Move lane runtime responsibilities out of `live-media-pipeline.js` without changing durable-first ordering.
- No new production file should exceed 400 lines; no new React component should exceed 200 lines.
- Reuse one canonical Gemini request/redaction/usage boundary instead of adding provider-specific near-duplicates.

## UI Contract

- Caption and translation reading space remains visually dominant.
- Host AI health is a compact disclosure with four rows: source captions, translation, topic grouping, recap. Each row has one state and one recovery action when applicable.
- Participant failures remain local: translation unavailable does not replace source captions; topic delay does not remove ungrouped captions.
- Post-call minutes show topic navigation, grounded chapters, and recap generation state without exposing technical provider details.
- NOVA semantic tokens only, 44px targets, keyboard operation, reduced motion, 320/768/1024/1440 widths, and WCAG AA contrast.

## External Evidence

- Google requires production API keys to remain server-side: <https://ai.google.dev/gemini-api/docs/api-key>
- Gemini 3.7 Flash is GA, uses the exact model ID `gemini-3.7-flash`, and supports `low`, `medium`, and `high` thinking levels: <https://ai.google.dev/gemini-api/docs/latest-model>
- Live Translation is a continuous audio translation preview surface: <https://ai.google.dev/gemini-api/docs/live-api/live-translate>
- Structured output supports a documented JSON Schema subset and still requires application validation: <https://ai.google.dev/gemini-api/docs/structured-output>
- Rate limits are project-scoped across RPM, TPM, and RPD: <https://ai.google.dev/gemini-api/docs/rate-limits>
- Paid-project logs and optional data sharing have separate retention controls: <https://ai.google.dev/gemini-api/docs/logs-policy>
- SDK abort is client-side and does not guarantee service cancellation or avoided charges: <https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateContentConfig.html>

## Success Criteria

- Independent five-axis reviewers report no Critical, Required, High, or Medium unresolved findings.
- Full root, web, and gateway suites, typecheck, build, dependency audit triage, and diff checks pass.
- Runtime Chrome walkthrough passes normal flow plus network/provider failure flows.
- A1-A8 adversarial report covers concurrency, authorization, CSRF, injection, provider boundary, input limits, retention, and devices.
- No migration is applied, no real Gemini request is sent, no email/message is dispatched, and no deployment occurs.
