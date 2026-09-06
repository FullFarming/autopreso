# Implementation Plan: Structured Glossary RAG + Earnings-Call Live Experience

Latest requested work (2026-09-05, local implementation complete; deployment configuration and real-provider evaluation pending):
- [Soniox default, up to three languages, host-ended sessions](../docs/superpowers/plans/2026-09-05-soniox-default-host-ended-sessions.md)
- [Gemini Transcribe → Flash official-source implementation plan](../docs/superpowers/plans/2026-09-05-gemini-transcribe-serial-implementation.md)

Current implementation evidence: [2026-09-05 report](../docs/superpowers/status/2026-09-05-core-product-implementation.md).

The completion status below describes the historical 2026-08-15 module, not these new plans.

Status: Implementation complete; awaiting explicit release approval  
Date: 2026-08-15  
Module: `glossary-rag-earnings-call`

Implementation was completed locally on 2026-08-15. No production database
migration, real Gemini/PDF request, email/message dispatch, or deployment was
performed. Production remains blocked on the human evidence checklist in
[`runbook-gemini-production.md`](./runbook-gemini-production.md).

Prior completed module plans remain preserved in:

- [`plan-attendee-admission.md`](./plan-attendee-admission.md)
- [`plan-web-host-control.md`](./plan-web-host-control.md)
- [`plan-participant-live-topics.md`](./plan-participant-live-topics.md)
- [`plan-live-call-quality-gemini.md`](./plan-live-call-quality-gemini.md)

## Clarification Baseline

- Admin hosts own reusable, versioned glossary presets. Organization-wide
  sharing and a public glossary marketplace are excluded.
- Hosts can edit, duplicate, import, and export JSON. AI-assisted extraction
  may propose terms from uploaded IR material, but a host must approve every
  term before it becomes active.
- Live retrieval is local and deterministic. No database, embedding, or Gemini
  request is made per partial caption.
- Participant microphones and translated-audio egress remain disabled. The
  participant product is a synchronized original/translation transcript.
- Topic classification, PDF glossary extraction, final text translation,
  selective polish, and recap use the GA `gemini-3.7-flash` model. Continuous
  audio translation remains on `gemini-3.5-live-translate-preview`, because
  Gemini 3.7 Flash does not provide the Live API surface used by that path.
  No alias, `latest`, client-selected model, or silent model fallback is allowed.
- No production migration, real Gemini request, document upload, email/message,
  or deployment is authorized by this plan.

## Product Outcome

An admin prepares a professional terminology package before a call, validates
the generated JSON, and pins one immutable version to the session. During the
call, source repair and final translation retrieve only the small relevant term
slice from an in-memory index. Participants follow an earnings-call-style live
transcript with original/translation tabs, speakers, timestamps, Prepared
Remarks/Q&A sections, searchable topics, and immediate post-call minutes.

## Architecture Decisions

### 1. Versioned glossary document

Add a canonical `glossary-document/v1` contract rather than passing arbitrary
free-form text through every layer.

```text
GlossaryDocumentV1
├─ schemaVersion: 1
├─ name, domain, sourceLanguage
├─ targetLanguages[]
├─ terms[]
│  ├─ id, source, translations{}
│  ├─ aliases[], pronunciation?
│  ├─ doNotTranslate, forbiddenTranslations[]
│  ├─ context?, examples[], tags[], priority
│  └─ provenance { kind, label? }
└─ createdAt, updatedAt, version
```

The parser is strict: unknown keys, duplicate normalized terms, unsupported
languages, controls/bidi, markup, oversized arrays/strings, conflicting target
translations, and executable-looking content are rejected. All comparison is
NFC/codepoint based.

### 2. Additive persistence and immutable session snapshot

Existing text presets remain readable for one compatibility cycle. Add a JSONB
document, schema version, optimistic version, and content fingerprint without
dropping legacy columns. On session creation/start, persist the selected preset
ID, version, and fingerprint. Editing a preset never changes an active call.

The API exposes owner-scoped CRUD, validate-only import, export, duplicate, and
activate-version operations. Full documents never enter participant payloads,
gateway logs, browser storage, or URLs.

### 3. Compile once, retrieve locally

At validation/session start, compile JSON into:

- normalized exact terms and aliases;
- target-language replacement rules;
- do-not-translate rules;
- bounded domain/context tokens;
- a deterministic lexical index.

At each committed source final, retrieve a bounded Top-K slice using exact,
alias, context-token, and conservative fuzzy matches. Partial captions never
invoke retrieval. The selected slice may feed source repair, final text
translation, and selective polish. The whole glossary is never sent to Gemini.

External vector storage and per-caption embedding calls are excluded from v1.
If lexical evaluation misses the agreed target, a later approval-gated phase
may create embeddings only during document indexing and materialize a local
session index before the call.

### 4. Workload-specific Gemini boundary

| Workload | Fixed model | Glossary behavior | Failure behavior |
|---|---|---|---|
| Continuous audio translation | `gemini-3.5-live-translate-preview` | No prompt/RAG support; use input/output transcripts and deterministic post-correction | Keep source; mark translation degraded |
| PDF glossary-candidate extraction | `gemini-3.7-flash` (`medium`) | Host-only inline PDF, strict candidate JSON, never activates terms | One attempt; discard bytes after response; host reviews candidates |
| Final text translation/polish | `gemini-3.7-flash` (`low`) | Send only redacted Top-K term slice | Preserve committed draft or explicit failed state |
| Topic classification | `gemini-3.7-flash` (`low`) | Bounded source context; no glossary document | Deterministic continuation; no retry |
| Post-call recap | `gemini-3.7-flash` (`medium`) | Ground on durable topics plus approved term renderings | Single claim; manual retry only |

All model IDs are server-owned allowlist constants. One physical attempt,
AbortSignal, concurrency/rate budgets, strict structured output, canonical
input/output redaction, and safe numeric usage metrics remain mandatory.

### 5. Earnings-call information architecture

The host session configuration gains optional event metadata: company name,
ticker, fiscal period, event type, and agenda labels. The transcript uses
server-authoritative section markers for `prepared_remarks`, `qa`, and `other`.
Existing topic metadata remains the fine-grained chapter source.

The participant surface reuses the current translation components and adds:

- compact company/period/live status header;
- Original and host-approved translation tabs;
- speaker, timestamp, final/partial state, and glossary match affordance;
- Prepared Remarks/Q&A navigation;
- transcript search and “jump to latest” without replacing live flow;
- completed-topic disclosures and active-topic panel;
- post-call topic index and grounded recap.

No participant audio player, microphone, floor control, AI model name, token
usage, or technical provider error is exposed.

## Dependency Graph

```text
T1 JSON contract/compiler ───────┬──→ T3 owner API/import-export ─→ T4 host glossary UI
                                │
T2 additive schema/RPC ─────────┘
                                ├──→ T5 local runtime retrieval ─→ T6 Gemini grounding
T7 event/section contract ────────────────────────────────────────→ T8 earnings-call UI
T3 + T5 + T6 + T7 + T8 ──────────────────────────────────────────→ T9 quality metrics
T1–T9 ────────────────────────────────────────────────────────────→ T10 adversarial QA
```

T1 and T2 may start in parallel. T3 waits for their contracts. T4 and T5 may
then run in parallel with exclusive UI/runtime ownership. T6 waits for T5. T7
may run beside T3–T6, while T8 waits for T4 and T7. T9–T10 are integration
gates, not opportunities to add new scope.

## Task Breakdown and File Ownership

### T1 — Canonical glossary JSON and compiler (M)

**Owner:** Backend/TDD Agent  
**Files:** new `packages/caption-core/glossary-document.js` and tests; focused
exports in `packages/caption-core/index.js`; compatibility adapter tests only in
existing glossary modules.

- Define strict v1 parsing, normalization, uniqueness, bounds, fingerprinting,
  legacy-text conversion, and deterministic compilation.
- Produce an immutable runtime index and human-readable validation diagnostics.
- Keep all functions pure and network-free.

**Acceptance:** hostile/oversized JSON fails closed; equivalent NFC input has
one fingerprint; the same document compiles byte-for-byte deterministically;
legacy text produces an explicit compatibility document rather than implicit
dual behavior.

### T2 — Additive glossary persistence and session pinning (M)

**Owner:** Schema Agent  
**Files:** one new Supabase migration, `supabase/bootstrap-new-project.sql`,
focused migration contract/integration tests.

- Add document/schema/fingerprint fields and immutable selected-version
  metadata; keep existing text fields nullable/readable.
- Owner-scoped RPCs use optimistic versions and exact response shapes.
- Preserve retention/cascade behavior and service-role-only execution.

**Acceptance:** legacy rows still load; concurrent update has one winner;
active session fingerprint cannot change when the preset is edited; cleanup
removes document versions at the existing retention boundary. No migration is
applied to a shared database.

### T3 — Owner API, validation, import/export (M)

**Owner:** Backend + Security Agents with non-overlapping files  
**Files:** glossary service/store/types and API routes owned by Backend;
validation/rate-limit/CSRF-focused tests owned by Security.

- Extend owner CRUD with validate-only import, version activation, duplicate,
  and JSON export.
- Validate content type, byte/codepoint/term counts, language membership, and
  strict JSON before persistence.
- Return stable Korean error codes/messages and `private, no-store`.

**Acceptance:** unauthenticated/non-owner/cross-preset access is denied before
store mutation; duplicate submission is idempotent; malformed/import bombs and
prompt-injection strings never persist; API responses cannot include secrets or
another host’s document.

### T4 — Host glossary workspace (M)

**Owner:** Design Agent  
**Files:** new focused `webapp/components/live/glossary/*`, host integration and
focused UI tests. `LiveHostDashboard.tsx` remains exclusive to this agent.

- Responsive preset list, editor, term table, import preview, validation
  summary, version history, duplicate/export, and session selection.
- Use form controls and disclosure/drawer components already in the design
  system; do not build a raw full-screen JSON textarea as the primary flow.
- Show AI-extracted terms as unapproved candidates; approval is explicit.

**Acceptance:** keyboard-only completion, 44px targets, 200% zoom, 320/768/
1024/1440 layouts, long Korean/English terms, validation focus routing, and no
secret/model internals. Editing an active preset clearly creates a new version.

### T5 — Local RAG runtime integration (M)

**Owner:** Gateway/Performance Agent  
**Files:** `packages/caption-core/local-term-retrieval.js` and focused tests;
small integration seams in committed finalization/media pipeline; no UI files.

- Adapt the current local retriever to compiled JSON terms and language-aware
  exact/alias/context/fuzzy ranking.
- Build once per pinned session version; reuse bounded caches; clear on session
  end/shutdown.
- Retrieve only after a durable source final and before final repair/polish.

**Acceptance:** no network/DB call in retrieval; Top-K and prompt characters are
bounded; partial latency is unchanged; false fuzzy replacements are rejected;
cache is session/version fenced; 10,000-term benchmark stays within the agreed
latency/memory budget.

### T6 — Gemini grounding and recap verification (M)

**Owner:** Gemini Backend + Security Agents  
**Files:** provider adapters/runtime and recap modules/tests only; model policy
has one owner.

- Verify all non-Live Gemini workloads remain on exact `gemini-3.7-flash`;
  reject aliases, `latest`, and client/env arbitrary model IDs. Enforce `low`
  thinking for topic/translation/polish and `medium` for extraction/recap.
- Add a host-only, rate-limited PDF candidate-extraction boundary on exact
  `gemini-3.7-flash`: bounded inline bytes, PDF magic/MIME verification,
  strict candidate JSON, no Files API persistence, and no automatic activation.
- Keep PPT/PPTX out of v1; the host exports it to PDF so visual document
  understanding has one reviewed format and one retention contract.
- Send only redacted relevant term slices to text translation/polish.
- Ground recap terminology in approved mappings and authoritative topic order;
  capture term IDs/provenance internally without exposing the glossary body.

**Acceptance:** one physical provider attempt; timeout keeps budget accounted;
hostile term definitions cannot change instructions; email/code/token/session
data is absent from captured requests; unsafe/oversized output cannot persist;
provider failure never blocks source captions or deterministic statistics. PDF
bytes are never written to application storage, browser storage, logs, or the
Gemini Files API, and extracted candidates require an explicit host approval.

### T7 — Earnings-call event and section contract (M)

**Owner:** Backend + Schema Agents sequentially  
**Files:** live contract/store/routes plus the same Schema-owned migration and
bootstrap from T2; gateway control event only if an authoritative section event
is required.

- Add optional normalized company, ticker, fiscal period, event type, and
  ordered agenda metadata.
- Add idempotent section transitions for Prepared Remarks/Q&A/Other without
  duplicating topic membership.
- Extend snapshot/transcript projection with exact no-PII public shapes.

**Acceptance:** one active section, stable reconnect snapshot, duplicate/stale
events are idempotent, non-owner cannot transition sections, old sessions render
without event metadata, and viewer reads remain session/grant fenced.

### T8 — Earnings-call participant and minutes UI (M)

**Owner:** Design Agent  
**Files:** focused live/translation/quality components, `LiveViewer.tsx`, demo,
minutes integration and UI tests; no backend authorization logic.

- Compose event header, section navigation, selected-only transcript lane,
  bounded search, glossary match disclosure, topics, and post-call index.
- Preserve current restore/session/language/topic state and caption-first error
  behavior.
- Ensure search/topic navigation never steals the live-edge reading position.

**Acceptance:** no participant audio/mic imports; selected lane only renders;
1,000 topics/12,000 captions remain bounded; source survives translation
failure; search, section, topic, and jump-to-latest work by keyboard and screen
reader; responsive browser evidence at all four widths.

### T9 — Quality evaluation and safe observability (S)

**Owner:** Quality/Observability Agent  
**Files:** offline fixtures/evaluation scripts, safe metric adapters/tests,
operator documentation. No production transcript fixture.

- Create a consent-safe golden set covering names, acronyms, finance/CRE terms,
  numbers, negation, mixed language, accents, and adversarial near-matches.
- Measure term recall, false correction, final translation accuracy proxy,
  added p50/p95 latency, prompt size, provider result/usage, and cache behavior.

**Acceptance:** target term accuracy at least 95%, prohibited rendering errors
zero in the golden set, false glossary correction rate explicitly reported,
and glossary path adds no more than 300ms p95 to committed final processing.
Metrics contain only fixed workload/model/result labels and numeric values.

### T10 — Integrated review and adversarial QA (M)

**Owner:** independent Reviewer/Security/Design reviewers; CTO synthesizes  
**Files:** tests and approved fixes only; no deployment.

- Run contract, web, gateway, root, typecheck, lint/build, diff, dependency, and
  browser gates.
- Perform A1–A8 scenarios below, normal flow, and two failure walkthroughs.
- Produce a one-page approval report with unresolved risk severity.

**Acceptance:** no Critical/High/Medium code blockers; every applicable A1–A8
case has evidence; production remains blocked until the existing Gemini
production runbook receives human evidence and the user separately approves
migration and deployment.

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Invented/unsupported Gemini model ID breaks production | High | Exact official `gemini-3.7-flash` allowlist; reject aliases/latest/fallback and preserve the separate Live model |
| Entire glossary or confidential IR content leaks to Gemini/logs | High | Local retrieval, Top-K redacted slice, exact request capture, safe metrics only |
| Preset edit changes terminology during a live session | High | Immutable version/fingerprint pinned at session start |
| Hostile imported JSON becomes prompt instructions | High | Strict plain-data schema, bounds, redaction, untrusted-data fencing, approval gate |
| Fuzzy match corrupts a legitimate term or number | High | Exact/alias precedence, conservative thresholds, forbidden-replacement tests, quality set |
| Large glossary raises caption latency or memory | High | Compile once, local bounded index/cache, benchmark and hard term/prompt caps |
| Cross-host glossary read/export | High | Owner filter before store read, opaque IDs, no-store, adversarial authorization tests |
| Summary invents sections or terminology | High | Durable topic/section grounding, strict JSON/output validation, manual retry only |
| Earnings-call controls reduce caption prominence | Medium | Selected-only panel, bounded search/nav, measured 320–1440 browser layouts |
| Preview Live Translation retires | Medium | Isolated adapter and explicit approval-gated model migration; source captions remain |
| Legacy text presets diverge from JSON | Medium | One explicit compatibility compiler and one-cycle deprecation; no dual parser logic |

## Verification Plan

### Normal scenario

Admin imports a JSON glossary, reviews warnings, activates version 1, creates an
earnings call with company/period/agenda metadata, starts the call, transitions
from Prepared Remarks to Q&A, and observes approved terminology in final source
and translation lanes. A participant joins by QR/code, searches a term, follows
topics/sections, refreshes back into the same position, and reads the grounded
post-call recap.

### Failure scenario A — invalid or hostile glossary

Import contains duplicate NFC terms, markup/prompt instructions, conflicting
translations, excessive entries, and a foreign owner ID. Validation rejects it
before mutation/provider work, focuses the first error, and leaves the previous
active version unchanged.

### Failure scenario B — Gemini/live translation degradation

The provider times out or returns malformed/unsafe content. Source captions and
durable topics continue; translation shows a safe degraded state; no automatic
retry/fallback occurs; recap becomes manually retryable; no prompt/PII/error
body appears in logs or participant responses.

## Adversarial Bug Hunt Matrix

| # | Scenario | Required evidence |
|---|---|---|
| A1 concurrency | Two updates/activations and duplicate section transitions | One optimistic winner; stable session fingerprint; idempotent transition |
| A2 authorization | Non-owner export/update, VIEWER mutation, cross-session snapshot | 401/403/404 before read/write/provider; no document leakage |
| A3 CSRF/origin | Missing, evil suffix, trailing slash, port mismatch | Exact allowed origin only; public GET allowlist not broadened |
| A4 injection | JSON prompt override, script/svg/bidi/control, unsafe model output | Rejected or rendered as inert text; never instructions/HTML |
| A5 SSRF | Uploaded provenance/labels contain URL/metadata IP/file scheme | No URL fetch in v1; strings remain inert metadata |
| A6 boundaries | 0/1/max/max+1 terms, codepoints, languages, arrays, malformed dates/version | Exact deterministic accept/reject behavior |
| A7 orphan/retention | Failed import, deleted preset, ended session, runtime cache | Atomic persistence; pinned call survives preset delete policy; DB/cache cleanup |
| A8 device/performance | 320/768/1024/1440, 200% zoom, 10k terms, 12k captions | No overflow/mic prompt; caption dominance; bounded latency/memory |

## Checkpoints and Approval Gates

1. **Contract checkpoint:** T1–T2 tests green; review JSON schema, legacy
   migration, and session pinning before API/UI work.
2. **Host workflow checkpoint:** T3–T4 green; demonstrate import → validate →
   approve → activate using fixtures only.
3. **Runtime checkpoint:** T5–T7 green; prove no per-caption external retrieval,
   exact models, source continuity, and section/topic recovery.
4. **Experience checkpoint:** T8–T9 green; browser and golden-set evidence.
5. **Release checkpoint:** T10 report and explicit user approval. Applying a
   database migration or deploying remains a separate command and approval.

## Standard Verification Commands

```sh
npm --prefix webapp run typecheck
npm --prefix webapp run test:live
npm --prefix webapp test
npm --prefix webapp run build
npm --prefix media-gateway test
npm test
git diff --check
```

Implementation starts only after the user replies `approve plan`.
