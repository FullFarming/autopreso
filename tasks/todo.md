# Tasks: Structured Glossary RAG + Earnings-Call Live Experience

Source: [`plan.md`](./plan.md)  
Status: Implementation complete; awaiting explicit release approval

## T1 — Canonical glossary JSON and compiler (M)

- [x] RED: strict schema, Unicode, duplicate, conflict, size, fingerprint, and legacy fixtures.
- [x] Implement `glossary-document/v1` parser and immutable normalized type.
- [x] Implement deterministic fingerprint and legacy text compatibility conversion.
- [x] Compile exact/alias/translation/do-not-translate/context indexes.
- [x] GREEN: pure/network-free tests and diff check.
- Depends on: none.
- Owner: Backend/TDD Agent (`packages/caption-core` only).

## T2 — Additive glossary persistence and session pinning (M)

- [x] RED: legacy row, optimistic conflict, session fingerprint, retention fixtures.
- [x] Add JSONB/schema/fingerprint/version fields without dropping legacy text.
- [x] Add owner-scoped versioned RPCs and immutable session selection metadata.
- [x] Mirror migration in bootstrap and retention cleanup.
- [x] GREEN: migration/static plus disposable local DB integration; do not apply externally.
- Depends on: none; interface review with T1 before merge.
- Owner: Schema Agent (migration/bootstrap/schema tests only).

### Checkpoint 1 — Contract

- [x] T1–T2 focused tests green.
- [x] CTO confirms JSON/DB shapes, legacy policy, fingerprint and retention parity.
- [x] User-facing plan scope unchanged; no production operation performed.

## T3 — Owner API, validation, import/export (M)

- [x] RED: auth/owner/order, invalid JSON, import bomb, idempotency, no-store cases.
- [x] Extend preset service/store/types for document/version/fingerprint.
- [x] Add validate-only import, duplicate, activate-version, and export flows.
- [x] Add strict security validation, rate limits, Korean stable errors, no-store.
- [x] GREEN: API/security focused and full web tests.
- Depends on: T1–T2.
- Owners: Backend Agent for API/service/store; Security Agent for validators/security tests.

## T4 — Host glossary workspace (M)

- [x] RED: keyboard, validation focus, versioning, responsive and candidate approval states.
- [x] Build reusable preset list, editor, term table, import preview, and validation summary.
- [x] Add version history, duplicate/export, explicit activation, and session selection.
- [x] Show AI-extracted terms as unapproved until host confirmation.
- [x] GREEN: 320/768/1024/1440, 200% zoom, screen-reader and design-token tests.
- Depends on: T3.
- Owner: Design Agent (glossary UI and host integration only).

### Checkpoint 2 — Host workflow

- [x] Fixture demonstration: import → validate → approve → activate → select session version.
- [x] Invalid import leaves prior active version unchanged.
- [x] No model/key/provider details visible in UI or responses.

## T5 — Local RAG runtime integration (M)

- [x] RED: ranking, language, false fuzzy match, cache fence, 10k-term performance cases.
- [x] Extend local retrieval for compiled JSON exact/alias/context/fuzzy ranking.
- [x] Build index once per session/version and clear it on end/shutdown.
- [x] Retrieve Top-K only for durable source finals; keep partials unchanged.
- [x] Feed bounded slices to source repair/final translation/selective polish.
- [x] GREEN: no network/DB per retrieval; latency/memory/prompt bounds pass.
- Depends on: T1 and pinned version shape from T2.
- Owner: Gateway/Performance Agent.

## T6 — Gemini grounding and recap verification (M)

- [x] RED: old model/alias/latest/client model rejection and exact workload matrix.
- [x] RED: non-PDF/polyglot/oversize upload, cross-host, prompt injection, unsafe candidate output.
- [x] Keep live translation on `gemini-3.5-live-translate-preview`.
- [x] Add host-only inline-PDF candidate extraction on exact `gemini-3.7-flash` with medium thinking.
- [x] Verify PDF magic/MIME/size, one attempt, no Files API/storage/logging, manual approval only.
- [x] Keep topic/text translation/polish/recap on exact `gemini-3.7-flash` with fixed workload thinking levels.
- [x] Send only redacted Top-K terms; ground recap in durable topics/approved mappings.
- [x] Verify one attempt, AbortSignal, budgets, strict output, safe metrics, manual retry.
- [x] GREEN: captured requests contain no email/code/token/session/cross-owner data.
- Depends on: T5.
- Owners: Gemini Backend Agent and Security Agent with exclusive file boundaries.

## T7 — Earnings-call event and section contract (M)

- [x] RED: optional legacy metadata, section transition, duplicate/stale/reconnect cases.
- [x] Add company/ticker/fiscal period/event type/agenda contract and persistence.
- [x] Add owner-only idempotent Prepared Remarks/Q&A/Other transitions.
- [x] Extend snapshot/transcript with exact public section shapes and no PII.
- [x] GREEN: old sessions, authorization, session fence, recovery and retention tests.
- Depends on: T2; can run beside T3–T6.
- Owners: Backend Agent then Schema Agent for the shared migration only.

### Checkpoint 3 — Runtime

- [x] T5–T7 suites green; caption partial latency unchanged.
- [x] No per-caption external retrieval or whole-glossary Gemini prompt.
- [x] Provider failure preserves source captions and durable topics.
- [x] Session refresh restores pinned glossary, section and topic truth.

## T8 — Earnings-call participant and minutes UI (M)

- [x] RED: event header, lane, section, search, topic, recovery and large-data cases.
- [x] Add company/period/live header and Prepared Remarks/Q&A navigation.
- [x] Compose selected-only original/translation transcript with bounded search.
- [x] Add glossary-match disclosure without exposing the glossary document.
- [x] Extend post-call topic index and grounded minutes presentation.
- [x] Preserve caption-first degraded states, refresh and jump-to-latest behavior.
- [x] GREEN: keyboard/screen reader/200% zoom/four widths; zero mic/audio path.
- Depends on: T4 and T7; T5–T6 contract frozen.
- Owner: Design Agent.

## T9 — Quality evaluation and safe observability (S)

- [x] Build a consent-safe golden set for finance/CRE/names/acronyms/numbers/negation.
- [x] Measure term recall, false correction, translation proxy, p50/p95 latency and prompt size.
- [x] Verify ≥95% target-term accuracy, zero prohibited renderings, ≤300ms added p95.
- [x] Connect only fixed workload/model/result labels and numeric usage metrics.
- [x] Document failed cases and tuning decisions without transcript/PII fixtures.
- Depends on: T5–T8.
- Owner: Quality/Observability Agent.

### Checkpoint 4 — Experience and quality

- [x] Golden-set thresholds met or unresolved misses explicitly returned for product decision.
- [x] Browser walkthrough normal flow plus two failure flows passes.
- [x] Earnings-call information remains secondary to readable live captions.

## T10 — Integrated review and adversarial QA (M)

- [x] Independent code-quality, security/privacy, performance and design reviews.
- [x] Resolve all Critical/High/Medium code blockers within approved scope.
- [x] Run A1 concurrency and immutable session-version tests.
- [x] Run A2 authorization and cross-host/session export/read tests.
- [x] Run A3 strict Origin/CSRF tests.
- [x] Run A4 JSON/prompt/model-output injection tests.
- [x] Run A5 inert URL/SSRF-surface verification.
- [x] Run A6 Unicode/size/language/date/version boundaries.
- [x] Run A7 failed import/delete/retention/runtime-cache orphan checks.
- [x] Run A8 320/768/1024/1440, 200% zoom, 10k terms/12k captions.
- [ ] External `npm audit` registry lookup (blocked by the external-metadata approval boundary; tests, typecheck, build, migration checks, and diff check passed).
- [x] Run web/gateway/root tests, typecheck, production build, local security checks and diff check.
- [x] Deliver Phase 5 one-page report and request explicit release approval.
- Depends on: T1–T9.
- Owners: independent Reviewers; CTO synthesis.

## External-action gates

- [x] Do not apply a Supabase migration without a new explicit approval.
- [x] Do not send real IR documents or glossary content to Gemini during local verification.
- [x] Do not send email/message/webhook.
- [x] Do not deploy until the user explicitly commands deployment.
- [x] Keep production blocked until `runbook-gemini-production.md` has human evidence.
