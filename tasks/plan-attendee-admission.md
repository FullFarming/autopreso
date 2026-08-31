# Implementation Plan: Web Live Call — Attendee Admission

Source spec: [`SPEC-attendee-admission.md`](../SPEC-attendee-admission.md)  
Module id: `attendee-admission`

Previous module records: [`plan-web-host-control.md`](./plan-web-host-control.md),
[`todo-web-host-control.md`](./todo-web-host-control.md)

## Overview

Replace the participant name-based admission profile with a required,
unverified delivery email and optional company, department, and job title.
Both QR/link and six-digit-code admission keep the existing atomic grant flow,
while new consent data is stored for the later `summary-delivery` module.
Participant pages become caption-only, and the gateway rejects VIEWER media or
floor commands even when a modified client sends them.

This plan writes an additive migration but does not apply it to a shared or
production database. It does not send email, generate summaries, remove the
desktop host, or deploy.

## Architecture Decisions

1. **Keep one admission endpoint and one atomic RPC.** QR/link and code remain
   credential branches of the same join transaction, preventing divergent
   capacity, rate-limit, and idempotency rules.
2. **Make `live_participants` the profile truth.** New `email`, `company`, and
   `summary_consent_at` fields live with the retained participant record.
   Viewer grants remain authorization records rather than a second editable
   profile source.
3. **Retain `display_name` as a compatibility projection.** New admissions
   derive a masked label server-side from validated email. Existing caption,
   presence, stage, and gateway consumers continue to receive `displayName`
   without ever receiving the full address.
4. **Treat consent as monotonic opt-in during admission.** A checked control sets
   `summary_consent_at`; unchecked first admission stores null. Idempotent
   reconnect cannot erase prior consent. Consent withdrawal/unsubscribe belongs
   to `summary-delivery`, where delivery state exists.
5. **Enforce caption-only at two boundaries.** `LiveViewer` removes every Speak,
   microphone, capture, and floor action; the gateway independently rejects
   media/floor messages from VIEWER claims.
6. **Preserve legacy rows.** New columns are nullable, no backfill invents email,
   and no column or gateway contract is dropped in this module.
7. **Keep full email server/owner scoped.** The joining participant may see their
   own address and host-owned roster access may receive it. Participant-visible
   events and shared UI receive only the masked compatibility label.

## Dependency Graph

```text
Approved attendee-admission contract
        │
        ├── Task 1: Additive SQL/RPC and retention contract
        │
        └── Task 2: TypeScript identity, validation, and masking contract
                       │
             Task 1 ──┴──→ Task 3: Atomic join/store/API integration
                                  │
                                  ├── Task 4: Participant + host UI projections
                                  │
                                  └── Task 5: Gateway VIEWER media denial
                                               │
                                   Tasks 1–5 ──┴──→ Task 6: Integrated verification
```

Tasks 1 and 2 may run in parallel after plan approval. Task 3 is sequential
because it binds the SQL and TypeScript contracts. Tasks 4 and 5 may then run in
parallel because their file ownership does not overlap.

## Parallel Execution and File Ownership

| Workstream | Ownership | Exclusive files |
|---|---|---|
| Schema Agent | Task 1 | new Supabase migration, `bootstrap-new-project.sql`, migration/static contract test |
| Security Agent | Task 2 | `live-input-validation.ts`, identity/masking helper and focused security tests |
| Backend Agent | Task 3 | `live-contract.ts`, `live-admission-store.ts` and its test, join route |
| Design Agent | Task 4 | `LiveViewer.tsx`, `LiveHostDashboard.tsx`, `globals.css`, UI contract test |
| Gateway Security Agent | Task 5 | `gateway-server.js` and focused gateway test files |
| CTO/Reviewer | Task 6 | read-only integration review, browser QA, adversarial report |

Every agent must inspect and record the current diff for its owned files before
editing. Agents are not alone in the working tree and must preserve unrelated
changes. No two agents may edit the same file concurrently. If implementation
proves that a listed file must cross ownership, the dependent task waits and the
CTO reassigns that exact file before work continues.

## Task List

### Phase 1: Data and Identity Foundations

- [ ] Task 1: Add the legacy-safe participant email/company/consent migration and atomic RPC contract.
- [ ] Task 2: Define email validation, normalization, masking, optional profile, and consent input contracts.

### Checkpoint: Foundation

- [ ] Migration is additive, legacy rows remain valid, and bootstrap parity is tested.
- [ ] Hostile/boundary identity inputs fail before reaching the store.
- [ ] No full email can enter `displayName` or a participant-visible event contract.
- [ ] No migration has been applied to a shared or production database.

### Phase 2: Admission Slice

- [ ] Task 3: Bind QR/code join, participant persistence, viewer grant, roster privacy, and idempotency.

### Checkpoint: Atomic Admission

- [ ] QR and code branches create or restore exactly one participant record.
- [ ] Consent false succeeds with null timestamp; true is persisted; reconnect does not erase prior opt-in.
- [ ] Non-owner and participant callers cannot read another attendee's full email.

### Phase 3: Caption-Only Experience

- [ ] Task 4: Replace the join name field with the approved email/profile/consent UI and masked shared projections.
- [ ] Task 5: Reject all VIEWER audio and speaking-floor commands at the gateway.

### Checkpoint: Caption Only

- [ ] Participant UI contains no microphone, Speak, floor, mute, or capture action.
- [ ] Participant pages make no `getUserMedia` request in Chrome or Safari.
- [ ] A forged VIEWER media/floor message is rejected without affecting the host pipeline.
- [ ] QR and code flows remain keyboard accessible at desktop and mobile widths.

### Phase 4: Verification

- [ ] Task 6: Run full automated, browser, privacy, migration, and adversarial verification.

### Checkpoint: Complete

- [ ] Every success criterion in `SPEC-attendee-admission.md` has evidence.
- [ ] Webapp typecheck, full tests, build, gateway tests, and root tests pass.
- [ ] Chrome and Safari QR/code joins confirm zero participant microphone requests.
- [ ] No shared/production migration, email dispatch, or deployment has run.
- [ ] User approval is requested before the next module or any migration/deployment action.

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Full email leaks through captions, presence, stage, WebSocket payloads, logs, or error text | High | Derive masked `displayName` server-side; keep full email out of participant event types; add payload/static searches and cross-role tests |
| Additive migration breaks legacy rows that have only `display_name` | High | Nullable columns, no invented backfill, migration fixture for legacy data, no immediate drop |
| Duplicate QR/code submissions create two participants or consume capacity twice | High | Preserve one atomic RPC, device/user/session idempotency, and concurrent redemption tests |
| Reconnect with an unchecked default silently revokes prior consent | Medium | Monotonic opt-in in admission RPC; leave withdrawal to the later delivery module |
| Removing participant Speak UI leaves a gateway bypass | High | Reject VIEWER media/floor message types server-side and test forged frames |
| Gateway denial accidentally blocks HOST microphone or desktop hosting | High | Role-specific tests for VIEWER rejection plus HOST and desktop regression suites |
| Email becomes an account/existence oracle | Medium | Do not use email for AuthN/AuthZ; stable generic failures; rate-limit existing credential/device/session keys |
| New PII outlives existing participant retention | High | Extend and test the existing personal-data cleanup path in the same migration |
| Safari form/permission behavior differs from Chrome | Medium | Manual QR/code/refresh checks in both browsers; production readiness remains blocked until both pass |

## Test Plan

### Static and automated gates

```sh
npm --prefix webapp run typecheck
npm --prefix webapp run test:live
npm --prefix webapp test
npm --prefix webapp run build
npm --prefix media-gateway test
npm test
git diff --check
```

### Required functional scenarios

1. QR invite + valid email + blank optional fields joins without a code.
2. Six-digit code + valid email + all optional fields joins the same endpoint.
3. Missing/malformed/oversized email, both credentials, neither credential, and
   malformed consent fail with `INVALID_JOIN_REQUEST` before store IO.
4. Company, department, and job title normalize to NFC; blank values persist as null.
5. Consent false remains null, true records one timestamp, and idempotent
   reconnect does not clear or duplicate it.
6. Two concurrent submissions for the same device/user/session return one
   participant and increment capacity once.
7. Host-owned roster reads can access the delivery address; non-owner and VIEWER
   calls cannot read another attendee's full address.
8. Captions, stage avatars, presence, floor/status events, and shared UI contain
   only the masked label.
9. Participant refresh restores the same grant, participant record, and selected
   language without reopening the profile form.
10. Modified VIEWER clients cannot publish PCM, request/release/preempt the
    floor, or trigger participant microphone state; HOST publishing still works.
11. Legacy participant rows without email remain readable and are removed by
    the existing retention cleanup on schedule.
12. Chrome and Safari desktop/mobile-size flows request no participant
    microphone permission and remain keyboard accessible.

## Adversarial Bug Hunt Scope

| Scenario | Required check |
|---|---|
| A1 Concurrency | Concurrent duplicate redemption produces one participant/count; consent timestamp remains deterministic |
| A2 Authorization | Non-owner and VIEWER cannot read full email; VIEWER cannot send media/floor commands |
| A3 CSRF/origin | Join CORS and mutating boundaries keep exact origin behavior; evil suffix, missing origin, trailing slash, and port mismatch fail as specified |
| A4 XSS | Email/company/department/job title reject markup/control payloads; masked label is React-escaped and never raw HTML |
| A5 SSRF | N/A: admission performs no user-directed URL fetch; adding one is prohibited |
| A6 Input boundaries | Empty/null/undefined, oversized Unicode, decomposed Korean, emoji, malformed email/code/token/boolean, and duplicate credentials |
| A7 Orphan/retention | Failed admission leaves no partial grant/participant/count; cleanup removes all new PII and consent fields |
| A8 Device | Desktop, iPhone-sized, iPad, refresh/foreground recovery, keyboard, 200% zoom, and zero microphone permission prompts |

## Approval and Execution Gate

This plan is pending human approval. After approval, implementation follows TDD
with mandatory Schema, Security, Backend, Design, and Gateway Security agents.
No migration is applied and no deployment or external email is sent.

## Open Questions

None. The approved specification fixes the identity, consent, masking, QR/code,
and caption-only behavior. Operational migration and deployment approval remain
separate gates.
