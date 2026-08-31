# Tasks: Web Live Call — Web Host Control

Source plan: [`plan.md`](./plan.md)  
Source spec: [`../SPEC-web-host-control.md`](../SPEC-web-host-control.md)

## Task 1: Lock the ADMIN-only host boundary

**Description:** Add regression coverage around the existing environment-backed
host allowlist, signed cookie, host-owned APIs, and feature flag. Do not add or
store real credentials.

**Acceptance criteria:**

- [x] Only configured IDs with the correct password obtain a host session cookie.
- [x] Unknown IDs, wrong passwords, and disabled configuration fail with stable API codes.
- [x] Host mutation routes reject missing/invalid host cookies and non-owned session IDs.
- [x] Mutating requests reject missing Origin, an evil suffix, and a port mismatch; the CSRF boundary canonicalizes a valid trailing slash before strict comparison.

**Verification:**

- [x] Regression tests confirmed the existing implementation; no production security defect required a RED implementation change.
- [x] GREEN: `npm --prefix webapp run test:live` passes.
- [x] Review: no credential value or weakened minimum appears in the diff.

**Dependencies:** None  
**Files likely touched:** `webapp/lib/security/live-security.test.ts`, and only if a failing test proves necessary, `webapp/lib/security/host-login-config.ts` or `webapp/lib/auth/live-auth.ts`  
**Estimated scope:** Small, 1–3 files

**Preflight:** Record `git diff --` for every owned file before editing; preserve all pre-existing changes.

## Task 2: Define active-session recovery decisions

**Description:** Add a pure decision module that maps the authenticated host's
active sessions to idle, automatic restore, or explicit selection. It must not
start media capture.

**Acceptance criteria:**

- [x] Exactly one `live`, `paused`, or `preparing` session resolves deterministically.
- [x] Multiple sessions require explicit selection; no first-row guess is allowed.
- [x] Stopped/failed/stale sessions never resolve as active.
- [x] The recovery API contract is fixed to `id`, `title`, `status`, `scheduledAt`, `viewerCount`, and `version`, with owned unexpired sessions ordered newest first.

**Verification:**

- [x] RED: new table-driven unit tests fail before implementation.
- [x] GREEN: the new focused test passes under the existing TypeScript test loader.
- [x] Typecheck: `npm --prefix webapp run typecheck` passes.

**Dependencies:** None  
**Files likely touched:** `webapp/components/live/host-session-recovery.ts`, `webapp/components/live/host-session-recovery.test.ts`, `webapp/package.json` to enumerate the test if required  
**Estimated scope:** Medium, 2–3 files

**Preflight:** This is the first implementation slice. Record the existing `webapp/package.json` diff before adding a test entry.

## Task 3: Harden browser audio reconnect lifecycle

**Description:** Ensure credential refresh, transient socket loss, media cleanup,
and user-activation recovery cannot create duplicate sockets, worklets, timers,
or PCM delivery.

**Acceptance criteria:**

- [x] Concurrent reconnect triggers share one in-flight reconnect.
- [x] Replacement closes the stale socket once and attaches one persistent listener set.
- [x] Permission/autoplay failure preserves the Live Session and returns a recoverable status.

**Verification:**

- [x] RED: lifecycle tests reproduce duplicate/stranded resources and error misclassification.
- [x] GREEN: `npm --prefix webapp run test:live` passes.
- [x] Automated: simulated reconnect and credential refresh preserve the same session ID; browser confirmation remains in Task 6.

**Dependencies:** None  
**Files likely touched:** `webapp/components/live/live-audio-client.ts`, `webapp/components/live/live-audio-client.test.ts`  
**Estimated scope:** Small, 2 files

**Preflight:** Record `git diff --` for both owned files before editing; preserve all pre-existing changes.

## Checkpoint: Foundation

- [x] Tasks 1–3 focused tests pass.
- [x] `npm --prefix webapp run typecheck` passes after the parallel changes converged.
- [x] Shared API and gateway message contracts are unchanged.

## Task 4: Integrate automatic host recovery

**Description:** Replace the current passive “active session found” recovery
experience with automatic restoration when exactly one active session exists,
while respecting browser media permission and the recovery decision contract.

**Acceptance criteria:**

- [x] A single `live` or `paused` session restores its correct host surface after refresh.
- [x] A `preparing` session restores without requesting media permission.
- [x] Browser-blocked audio exposes one keyboard-accessible `마이크 다시 연결` action.
- [x] UI/session recovery never claims that the destroyed pre-refresh media resources survived.

**Verification:**

- [x] RED/GREEN: host-surface and recovery integration tests pass.
  - [x] Manual (Chrome): refresh `preparing`, `live`, and `paused` sessions; the same session and correct surface restore without duplicate media attempts.
  - [ ] Manual (Safari): repeat `preparing`, `live`, and `paused` refresh recovery on macOS Safari.
- [x] Accessibility: focus ring, status announcement, and 44px target checks pass in isolated Chrome and by automated contract.

**Dependencies:** Tasks 2 and 3  
**Files likely touched:** `webapp/components/live/LiveHostDashboard.tsx`, `webapp/components/live/host-surface.ts`, `webapp/components/live/host-surface.test.ts`, `webapp/app/globals.css`  
**Estimated scope:** Medium, 4 files

**Preflight:** Record the current diff for all four files. The Design Agent has exclusive ownership of these files for this task.

## Task 5: Verify browser HOST gateway enforcement

**Description:** Add or tighten regression tests proving a browser HOST requires
an exact allowed origin, a valid HOST token, matching session ownership, and the
current version. Preserve the desktop-main no-Origin exception exactly as-is.

**Acceptance criteria:**

- [x] Allowed web origin plus valid HOST token can start the owned session.
- [x] Evil suffix, missing/disallowed origin, trailing-slash mismatch, port mismatch, viewer token, and wrong session fail closed.
- [x] Desktop-main trusted no-Origin behavior remains unchanged.

**Verification:**

- [x] RED/GREEN: focused gateway security and integration tests pass.
- [x] Full: `npm --prefix media-gateway test` passes.
- [x] Static search confirms no `startsWith` origin comparison was introduced.

**Dependencies:** None  
**Files likely touched:** `media-gateway/test/gateway-security-integration.test.js`, `media-gateway/test/live-call-gateway.test.js`, and only if tests prove a defect, `media-gateway/src/gateway-security.js` or `media-gateway/src/gateway-server.js`  
**Estimated scope:** Medium, 2–4 files

**Preflight:** Record the current gateway source/test diffs before editing; preserve the desktop-main and other in-progress changes.

## Checkpoint: Integrated Host

- [x] Tasks 4–5 automated acceptance criteria pass.
- [x] Web host and desktop host can each authenticate through their intended branch.
- [x] No participant microphone capability was added or changed in this module.

## Task 6: Run full and adversarial verification

**Description:** Execute the repository gates and the applicable A1–A8 scenarios,
capture evidence, and report unresolved browser or operational risks without
deploying.

**Acceptance criteria:**

- [x] All automated gates pass or every pre-existing failure is isolated with evidence.
- [x] Chrome development demo: create/start, unavailable audio input without session loss, and `preparing`/`live`/`paused` refresh recovery are demonstrated; the QA session was terminated directly without triggering summary-provider IO.
- [ ] Safari recovery and a provider-connected end-to-end translation/end demo remain for the production-readiness pass.
- [x] The final report maps every spec success criterion to evidence.

**Verification:**

- [x] `npm --prefix webapp run typecheck`
- [x] `npm --prefix webapp test`
- [x] `npm --prefix webapp run build`
- [x] `npm --prefix media-gateway test`
- [x] `npm test`

**Dependencies:** Tasks 1–5  
**Files likely touched:** no product files; verification report only if approved  
**Estimated scope:** Small, read-only execution

## Checkpoint: Complete

- [ ] Automated criteria and Chrome recovery are satisfied; Safari and provider-connected translation/end remain before production readiness.
- [x] Adversarial Bug Hunt report is complete for automated/security gates.
- [x] User approval is requested before implementation handoff, production configuration, migration, or deployment.
