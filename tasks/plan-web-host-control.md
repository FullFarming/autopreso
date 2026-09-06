# Implementation Plan: Web Live Call — Web Host Control

Source spec: [`SPEC-web-host-control.md`](../SPEC-web-host-control.md)  
Module id: `web-host-control`

## Overview

Stabilize the existing Next.js Live Host surface as the ADMIN-only production
host. The work preserves the current Live Session and gateway contracts, adds
deterministic active-session recovery, hardens browser audio reconnection, and
verifies that the browser HOST path is authorized without weakening exact
origin enforcement.

This plan does not implement participant profile changes, participant microphone
denial, invitation delivery, durable summaries, or summary email delivery.

## Architecture Decisions

1. **Reuse `LiveHostDashboard`.** `/` remains the single host entry. A second
   host application would create competing session state and duplicate the
   existing browser audio client.
2. **Keep Supabase as session truth.** Refresh recovery begins with
   `GET /api/live-sessions?scope=mine`; local storage must not decide which
   session is active.
3. **Extract recovery decisions from React.** A small pure module maps owned
   active sessions and browser-audio state to `restore`, `choose`, `idle`, or
   `ended`. This keeps race behavior testable without mounting the dashboard.
4. **Do not equate audio loss with session loss.** WebSocket, worklet, or media
   permission failure moves the host to a recoverable audio state; it never
   creates or terminates a Live Session.
5. **Preserve exact browser-origin authorization.** Browser HOST sockets use the
   configured webapp origin and signed HOST token. The trusted no-Origin branch
   remains desktop-main only.
6. **Keep Electron compatible.** Shared gateway messages are unchanged unless a
   later, separately approved contract change proves necessary.

## Dependency Graph

```text
Existing host auth and session ownership
        │
        ├── Task 1: ADMIN host boundary regression
        │
Existing active-session API
        │
        └── Task 2: Pure recovery decision contract
                       │
Existing browser audio client
        │              │
        └── Task 3: Audio reconnect lifecycle
                       │
                       └── Task 4: Dashboard auto-restore UX

Existing gateway origin/token checks
        └── Task 5: Browser HOST security regression

Tasks 1–5 ──→ Task 6: Integrated browser and adversarial verification
```

## Parallel Execution and File Ownership

Task 2 is the first implementation slice and freezes the recovery decision and
`scope=mine` response contract. After its checkpoint, Tasks 1, 3, and 5 may run
in parallel because their file boundaries do not overlap. Task 4 remains
sequential after Tasks 2 and 3.

| Workstream | Ownership | Files |
|---|---|---|
| Security Agent | Task 1 and Task 5 | host login tests/config; gateway security tests only |
| Backend Agent | Task 2 | new pure recovery module and its unit test |
| Backend Agent | Task 3 | browser audio client and its existing focused test |
| Design Agent | Task 4 | `LiveHostDashboard.tsx`, `globals.css`, host-surface/recovery UI tests |
| CTO/Reviewer | Task 6 | read-only integration review, commands, and browser QA evidence |

`LiveHostDashboard.tsx`, `globals.css`, and gateway files are already modified in
the working tree. Before implementation, the owning agent must inspect and
preserve those changes. No other agent may edit the same files concurrently.
Every task begins with `git diff -- <owned files>` and records the pre-existing
diff before any patch is applied.

## Task List

### Phase 1: Security and Recovery Foundations

- [ ] Task 1: Lock the ADMIN-only host boundary with regression tests.
- [ ] Task 2: Define deterministic active-session recovery decisions.
- [ ] Task 3: Harden browser audio reconnect and cleanup invariants.

### Checkpoint: Foundation

- [ ] Focused red/green tests pass for auth, recovery decisions, and audio lifecycle.
- [ ] No ADMIN password, token, or production origin appears in the diff.
- [ ] No Live Session API or gateway message shape changed.

### Phase 2: Host Surface Integration

- [ ] Task 4: Auto-restore active sessions in the host dashboard.
- [ ] Task 5: Verify browser HOST origin and token enforcement at the gateway.

### Checkpoint: Integrated Host

- [ ] Refreshing one owned `live` session returns to its live surface.
- [ ] Refreshing a `preparing` session does not request microphone permission.
- [ ] Multiple active sessions fail closed into an explicit chooser instead of guessing.
- [ ] A viewer token or unapproved browser origin cannot start a HOST pipeline.

### Phase 3: Verification

- [ ] Task 6: Run automated, manual browser, accessibility, and adversarial checks.

### Checkpoint: Complete

- [ ] Every success criterion in `SPEC-web-host-control.md` has evidence.
- [ ] Webapp typecheck, full tests, build, and media-gateway tests pass.
- [ ] Desktop Live Call regression tests remain green.
- [ ] No production migration or deployment has run.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Browser autoplay policy blocks automatic `AudioContext` resumption | High | Restore session state first; attempt allowed reconnect; show one user-gesture recovery action without ending the session |
| Refresh creates a duplicate host socket or PCM stream | High | Serialize reconnect, reject stale sockets, and test exact-once cleanup/attachment |
| Existing dirty `LiveHostDashboard` and gateway changes are overwritten | High | Assign exclusive file ownership, inspect current diff before edits, and review the final scoped diff |
| Web browser origin is admitted through the desktop no-Origin exception | High | Add regression tests proving exact allowed origin plus HOST token are both required |
| Multiple active sessions cause the wrong call to resume | Medium | Auto-restore only when exactly one recoverable session exists; otherwise require explicit selection |
| Exposed administrator password is reused | High | Never place it in code/tests; require operator rotation before production configuration |
| System-audio behavior differs across browser/OS combinations | Medium | Treat microphone as required baseline; detect missing display audio and present an actionable error |

## Test Plan

### Static and automated

```sh
npm --prefix webapp run typecheck
npm --prefix webapp run test:live
npm --prefix webapp test
npm --prefix webapp run build
npm --prefix media-gateway test
npm test
```

### Required scenarios

1. Allowed ADMIN login succeeds; unknown ID and wrong password fail without
   revealing which credential was wrong.
2. The recovery API returns only the six documented fields, filters to owned
   unexpired `preparing/live/paused` sessions, and orders them newest first.
3. One owned `live` session restores its UI after refresh and reconnects audio
   to the same session ID automatically when permitted or through one explicit
   recovery action when browser policy requires it.
4. One owned `paused` session restores paused; one `preparing` session restores
   without microphone capture.
5. Two active sessions do not auto-select one.
6. A stale gateway credential refresh creates one replacement socket and closes
   the old socket once.
7. Microphone denial leaves the session active and exposes one recovery action.
8. Disallowed origin, missing origin, viewer token, wrong session ownership, and
   suspended/invalid host session fail closed.
9. Chrome and Safari keyboard-only flows expose visible focus, status text, and
   actionable permission errors.

## Adversarial Bug Hunt Scope

| Scenario | Required check |
|---|---|
| A1 Concurrency | Two refresh/reconnect triggers produce one active HOST stream |
| A2 Authorization | Non-owner and viewer tokens cannot control or publish to the session |
| A3 CSRF/origin | CSRF canonicalizes a valid trailing slash then compares strictly; gateway upgrades reject raw trailing-slash, evil suffix, missing origin, and port mismatch variants |
| A4 XSS | Session title/status text remains React-escaped; no new raw HTML sink |
| A5 SSRF | N/A unless a new user-provided gateway URL is introduced; introducing one is prohibited by this plan |
| A6 Input boundaries | Empty/oversized title, invalid languages, invalid versions, and expired credentials fail safely |
| A7 Orphan state | Audio loss leaves no orphan worklet/socket/timer and does not terminate the DB session |
| A8 Device | iPad/desktop browser uses host layout; mobile viewport remains operable but is not the primary host target |

## Open Questions

None. Production environment configuration and rollout are explicitly outside
this plan and require a later approval gate.
