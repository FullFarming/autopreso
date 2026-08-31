# Tasks: Web Live Call — Attendee Admission

Source plan: [`plan.md`](./plan.md)  
Source spec: [`../SPEC-attendee-admission.md`](../SPEC-attendee-admission.md)  
Module id: `attendee-admission`

## Task 1: Add the legacy-safe participant profile migration

**Description:** Write an additive migration for participant email, company,
summary consent, atomic QR/code admission RPC mapping, roster projection, and
existing personal-data cleanup. Keep new-project bootstrap SQL equivalent. Do
not apply the migration to a shared or production database.

**Acceptance criteria:**

- [ ] Legacy participant rows without email remain valid and readable.
- [ ] New admissions atomically store canonical email, optional company/profile, masked display label, and optional consent timestamp.
- [ ] Existing cleanup removes the new PII on the participant retention schedule.

**Verification:**

- [ ] RED/GREEN migration/static contract tests cover legacy rows, constraints, RPC atomicity, and cleanup.
- [ ] Migration contains no column/enum drop and no external IO.
- [ ] Bootstrap schema and migration end state match.

**Dependencies:** None  
**Files likely touched:** new `supabase/migrations/*_live_attendee_admission.sql`, `supabase/bootstrap-new-project.sql`, one focused migration contract test  
**Estimated scope:** Medium, 3 files

**Ownership:** Schema Agent only. Inspect existing diffs before editing.

## Task 2: Define participant identity and validation contracts

**Description:** Add strict email/company/consent validation and a pure,
server-authoritative masked-label helper while preserving QR-versus-code
exclusivity and optional department/job-title normalization.

**Acceptance criteria:**

- [ ] Required email is normalized, bounded, and rejected when malformed or hostile.
- [ ] Company/department/job title are optional and NFC-normalized within bounds.
- [ ] Public `displayName` is derived from email and cannot be client supplied for new joins.

**Verification:**

- [ ] RED/GREEN tests cover null/blank, Unicode NFC, emoji, markup/control characters, length edges, QR/code exclusivity, and strict consent boolean.
- [ ] Full email never appears in the masked-label result.
- [ ] `npm --prefix webapp run typecheck` passes.

**Dependencies:** None  
**Files likely touched:** `webapp/lib/security/live-input-validation.ts`, new `webapp/lib/security/participant-identity.ts`, focused tests for both  
**Estimated scope:** Medium, 4 files

**Ownership:** Security Agent only. May run in parallel with Task 1.

## Checkpoint: Data and Identity Foundation

- [ ] Tasks 1–2 focused tests pass.
- [ ] SQL and TypeScript contracts agree on normalization, bounds, nulls, masking, and consent semantics.
- [ ] No shared/production migration has run.

## Task 3: Integrate atomic attendee admission and privacy projections

**Description:** Bind the approved TypeScript input to the updated atomic RPC,
map the participant's own profile safely, preserve grant/capacity idempotency,
and enforce role-scoped full-email access.

**Acceptance criteria:**

- [ ] QR and code joins return the same response shape and create/restore one participant.
- [ ] Consent false/true and reconnect semantics match the migration contract.
- [ ] Full email is available only to the participant's own join result and authenticated host-owner roster path.

**Verification:**

- [ ] RED/GREEN store/route tests cover both credentials, concurrent duplicate redemption, store failure rollback, and legacy rows.
- [ ] Non-owner and VIEWER full-email reads fail closed.
- [ ] `npm --prefix webapp run test:live` and typecheck pass.

**Dependencies:** Tasks 1 and 2  
**Files likely touched:** `webapp/lib/live-contract.ts`, `webapp/lib/security/live-admission-store.ts`, `webapp/lib/security/live-admission-store.test.ts`, `webapp/app/api/live-sessions/join/route.ts`  
**Estimated scope:** Medium, 4 files

**Ownership:** Backend Agent. Security Agent reviews the final route/store diff.

## Checkpoint: Atomic Admission

- [ ] QR and code integration tests pass with one capacity increment.
- [ ] API envelopes, exact origin/CORS behavior, rate limits, and signed viewer cookie remain unchanged.
- [ ] No full email is present in participant-visible event payloads or logs.

## Task 4: Build the caption-only participant profile experience

**Description:** Replace the name form with required email, optional company,
department, job title, and unchecked summary consent. Remove all participant
microphone/Speak UI and update host/private versus participant/masked displays.

**Acceptance criteria:**

- [ ] QR and code forms follow the approved field order, copy, validation, autocomplete, focus, and 44px target rules.
- [ ] Participant surfaces show own email or masked shared labels as appropriate; host roster remains owner-scoped.
- [ ] No participant UI path renders or invokes microphone, Speak, floor, mute, or capture behavior.

**Verification:**

- [ ] RED/GREEN UI contract tests cover QR/code, consent off/on, optional fields, masking, and zero media controls/calls.
- [ ] Keyboard, status/error announcement, reduced motion, mobile width, and 200% zoom checks pass.
- [ ] Webapp full test, typecheck, and build pass.

**Dependencies:** Task 3  
**Files likely touched:** `webapp/components/live/LiveViewer.tsx`, `webapp/components/live/LiveHostDashboard.tsx`, `webapp/app/globals.css`, `test/live-ui.test.js`  
**Estimated scope:** Medium, 4 files

**Ownership:** Design Agent only. It must read and extract applicable `DESIGN.md` tokens before editing.

## Task 5: Enforce VIEWER subscribe-only gateway behavior

**Description:** Reject participant audio chunks and all speaking-floor commands
for VIEWER claims while preserving caption subscription, HOST browser audio,
and the trusted desktop-host branch.

**Acceptance criteria:**

- [ ] VIEWER can authenticate and subscribe to captions/snapshots/status.
- [ ] Forged VIEWER audio, floor request/release/preempt, or participant media control fails closed.
- [ ] HOST browser and desktop-host audio regressions remain green.

**Verification:**

- [ ] RED/GREEN focused gateway tests prove every denied message family and unchanged VIEWER subscribe behavior.
- [ ] `npm --prefix media-gateway test` passes.
- [ ] Static search finds no alternate VIEWER media path.

**Dependencies:** Task 3  
**Files likely touched:** `media-gateway/src/gateway-server.js`, `media-gateway/test/live-call-gateway.test.js`, `media-gateway/test/gateway-security-integration.test.js`  
**Estimated scope:** Medium, 3 files

**Ownership:** Gateway Security Agent only. May run in parallel with Task 4.

## Checkpoint: Caption-Only Integration

- [ ] Tasks 4–5 focused and full suites pass.
- [ ] Participant browser makes no microphone permission request.
- [ ] VIEWER bypass attempts do not alter floor or host pipeline state.
- [ ] Desktop host regression remains green.

## Task 6: Run full and adversarial verification

**Description:** Execute all repository gates and applicable A1–A8 scenarios,
then manually demonstrate QR/code join, consent, refresh, caption viewing, and
zero participant microphone prompts without sending email or deploying.

**Acceptance criteria:**

- [ ] All automated gates pass or every pre-existing failure is isolated with evidence.
- [ ] Chrome and Safari desktop/mobile-size QR and code flows are demonstrated.
- [ ] Every spec success criterion maps to evidence and unresolved operational risks are reported.

**Verification:**

- [ ] `npm --prefix webapp run typecheck`
- [ ] `npm --prefix webapp test`
- [ ] `npm --prefix webapp run build`
- [ ] `npm --prefix media-gateway test`
- [ ] `npm test`
- [ ] `git diff --check`

**Dependencies:** Tasks 1–5  
**Files likely touched:** plan/task evidence only if needed  
**Estimated scope:** Small, read-only execution

## Checkpoint: Complete

- [ ] Spec, plan, task acceptance criteria, and adversarial report are complete.
- [ ] No migration has been applied to a shared/production database.
- [ ] No email/message has been sent and no deployment has run.
- [ ] User approval is requested before the next module or any operational action.
