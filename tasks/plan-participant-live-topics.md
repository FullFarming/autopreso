# Plan: Participant Live Topic Transcript

Source: [`../SPEC-participant-live-topics.md`](../SPEC-participant-live-topics.md)

## Architecture Decision

Use server-authoritative semantic topics rather than client-side grouping.
Existing caption events remain the low-latency text truth. After each durable
source final, an ordered gateway detector decides whether the utterance continues
the active topic or starts a new one. A versioned atomic RPC persists the topic
transition and the gateway broadcasts a public-safe topic event to every
authorized language subscriber.

Two additive tables store topic metadata and `utteranceKey` membership. Snapshot
and transcript responses are extended; no new participant truth endpoint and no
topic data in the credential-restore response. Existing translation components,
caption provenance, replay cursors, viewer cookies, and retention are reused.

The participant surface composes lane tabs and topic disclosures inside the
existing `TranslationViewport`. Original text is projected from canonical
`sourceText`; translation uses the already selected host lane. Switching lanes
changes presentation only and never changes host settings.

## Dependency Graph

```text
Schema/RPC ───────────────┐
Topic detector contract ─┼─→ Gateway integration ─┐
Security contracts ──────┘                        ├─→ Viewer integration
Shared topic UI ──────────────────────────────────┘
                         Snapshot/transcript contracts ─┘
All implementation tasks ─────────────────────────────→ Integrated review/QA
```

## Task Breakdown and File Ownership

### Task 1 — Schema and atomic topic lifecycle

Owner: Schema Agent

- New additive migration for `live_topics` and `live_topic_utterances`.
- One-active-topic partial unique index, bounded checks, service-role RPC grants.
- Idempotent assign/shift, silence completion, session-end completion, recovery
  context RPCs using expected version.
- Bootstrap parity, 30-day cleanup, legacy-safe defaults, disposable DB tests.
- Files: new migration, `supabase/bootstrap-new-project.sql`, one new root test.

### Task 2 — Pure detector and security contracts

Owner: Topic/Security Agent

- New bounded detector module and strict structured-output parser.
- Prompt treats transcripts as untrusted data, omits profiles and secrets, and
  keeps provider storage disabled.
- Deterministic meaningful/filler classification and degraded fallback.
- Files: new `media-gateway/src/live-topic-detector.js`, focused tests; topic
  validation helpers and security test blocks only.

### Task 3 — Shared accessible UI

Owner: Design Agent (mandatory)

- `TranslationLaneTabs`, `CurrentTopicPanel`, `CompletedTopicAccordion`, and pure
  presentation state helpers.
- Native tab/disclosure semantics, roving keyboard control, 44px targets,
  bounded announcements, reduced motion, semantic NOVA tokens.
- Files: new modules under `webapp/components/live/translation/`, their module
  CSS/index, focused tests. No container/network changes.

Tasks 1–3 start in parallel with exclusive files.

### Task 4 — Gateway lifecycle and recovery

Owner: Gateway Agent

- Hook the detector only after durable source-final commit; captions fan out
  before AI work.
- Maintain one ordered queue and silence timer per session; pause does not close
  topics and partial activity delays the timer.
- Call atomic topic RPCs outside AI calls, fan out versioned topic events, and
  recover unassigned durable finals after restart.
- Files: `live-media-pipeline.js`, `supabase-adapters.js`, `gateway-server.js`, and
  non-overlapping focused tests under one owner.
- Depends on Tasks 1–2.

### Task 5 — Web contract, snapshot, and transcript projection

Owner: Backend Agent

- Add fail-closed `LiveTopic`, membership, and topic-event types.
- Extend existing snapshot and transcript parsing with topic metadata and
  provenance; retain existing endpoints and authorization.
- Topic event reducer enforces version monotonicity, final completion, session
  fences, late-snapshot protection, and `utteranceKey` identity.
- Apply `private, no-store` to viewer credential/topic-bearing responses.
- Files: `webapp/lib/live-contract.ts`, live store/feed helpers, existing
  snapshot/transcript routes and focused tests.
- Depends on Task 1; can run alongside Task 4 after the schema contract freezes.

### Task 6 — Participant container integration

Owner: Design Integration Agent

- Integrate shared tabs/topics into `LiveViewer` and demo without restoring any
  participant media path.
- Keep captions visible before topic assignment; move them when membership
  arrives without losing scroll or focus.
- Restore only selected lane, expanded topic IDs, and opaque anchor; clear on
  leave, invalid restore, or session fence.
- Extend post-session transcript to the same topic disclosures.
- Files: `LiveViewer.tsx`, `MeetingMinutes.tsx`, demo, viewer-specific CSS/tests.
- Depends on Tasks 3 and 5.

### Task 7 — Integrated review and adversarial QA

Owners: independent Reviewer, Security Agent, CTO

- Interface, authorization, transaction, migration-order, and accessibility
  review; required fixes return to the exclusive owner.
- Full webapp, gateway, root, migration, type, build, lint/diff gates.
- Chrome browser walkthrough, network/console inspection, and A1–A8 report.
- No migration apply, external provider dispatch beyond mocked/local tests,
  email, message, or deployment.

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Topic AI delays captions | High | Caption fanout first; bounded async detector; no retry |
| Semantic and silence transitions race | High | One active index + version CAS + idempotent utterance key |
| Original/translation enter different topics | High | Membership only by canonical `utteranceKey` |
| AI failure leaves speech ungrouped | High | Deterministic continue/new fallback and degraded state |
| Refresh loses active/completed groups | High | Durable topic/membership authority in snapshot/transcript |
| Participant accesses another session | High | Existing scoped credential + session filter + no-store |
| Prompt injection or PII disclosure | High | Durable source finals only, bounded untrusted envelope, profile omission |
| Continuous topic calls increase cost | Medium | Single-flight ordered queue, bounded context, timeout, metrics |
| Topic cards reduce translation space | Medium | Disclosures live inside existing viewport; active-only expansion |

## Test Plan

### Domain and concurrency

- First meaningful final creates topic 1; continuing finals preserve order.
- Semantic shift assigns the candidate utterance to the new topic.
- Duplicate `utteranceKey` and replay cause no new position or topic.
- Shift and 12-second timer race: exactly one versioned transition wins.
- Session end completes the active topic exactly once.
- Gateway restart recovers unassigned durable finals and stale active topics.

### Failure behavior

- Timeout, 429, refusal, invalid JSON, unsafe title, and DB conflict never delay
  or remove captions; no automatic retry or alternate provider.
- Partial speech and host pause cannot trigger silence completion.
- Late snapshots and stale events cannot reactivate or duplicate topics.

### Authorization and privacy

- Non-owner/VIEWER cannot mutate topics; cross-session reads return 403/404.
- Host language/version mismatch is rejected before topic/provider work.
- Prompt, logs, browser storage, URLs, and topic events contain no email, company,
  consent, token, grant, or raw provider response.
- Missing/evil Origin mutating requests remain blocked; read responses are
  `private, no-store`.

### UI and device

- Tabs keep the same utterance/topic position and deduplicate equivalent lanes.
- Active topic stays expanded; completed topic disclosure restores focus.
- Loading, no-topic, degraded, paused, reconnecting, ended, long Korean/English,
  and 40-topic states remain readable.
- 320/768/1024/1440px, 200% zoom, keyboard-only, screen-reader tree, reduced
  motion, clean console, and zero `getUserMedia` calls.

## Approval Gate

Implementation begins only after explicit `approve plan`. Database migration,
provider production traffic, email, and deployment require later separate
approval.

