# Plan: Gateway-Ready Scheduled Live Start

Status: locally implemented and verified; production rollout blocked by Cloud Run revision health and configuration evidence
Date: 2026-08-16

## Clarified outcome

- A Live Call supports at most 200 participants.
- Creating or scheduling a call leaves the canonical session in `preparing`.
- The countdown is served by the web app and never wakes Cloud Run by itself.
- At T-60 seconds, an open authenticated host page starts one bounded gateway
  warm-up. Participants remain on the web/Supabase waiting path and open no
  gateway socket.
- At T0, or immediately after a manual Start, the host establishes the gateway
  connection and starts the media pipeline. The session becomes `live` only
  after the gateway proves readiness and an owner/version/settings-fenced DB
  transition commits.
- A prepared gateway failure leaves the session `preparing`. Automatic retries
  are bounded to T+30 seconds; the host then gets explicit Retry and Cancel
  actions.
- `paused` retains the gateway connection. `stopped` and `failed` release the
  pipeline, Gemini resources, every session socket, and allow Cloud Run to
  scale to zero.

## Architecture decision

### Authoritative readiness boundary

The browser must not assert that the gateway is ready. A new additive service
RPC, `activate_live_session_after_gateway_ready_v1`, is called only by the
authenticated media gateway after its host pipeline has started. The RPC:

1. locks the exact session;
2. verifies `preparing`, owner, expected version, and the complete immutable
   gateway settings fingerprint;
3. transitions `preparing -> live` once and increments the version;
4. returns the exact public session status/version; and
5. is executable only by `service_role`.

The gateway then sends `started` to the host and broadcasts `session-status:
live`. If the RPC fails, the candidate pipeline is closed and no live event is
broadcast. A lost ACK after a successful commit is recovered by the existing
live-session read and host reattach path.

### Scheduled orchestration

A pure browser coordinator derives actions from `scheduledAt`, authoritative
session status, visibility, and monotonic time:

- before T-60: countdown only;
- T-60 through T0: one same-origin `/health` warm-up flight;
- T0 through T+30: host connection/start attempts at 0, 2, 5, 10, and 20
  seconds, bounded by a single generation/session fence;
- after T+30: no automatic Cloud Run requests; show Retry and Cancel;
- manual Start: enter the same coordinator immediately, independent of T0;
- `pageshow`, `visibilitychange`, and `online`: recompute from current time;
  never replay missed timers or create parallel attempts.

`/health` proves only process liveness. The UI may show `게이트웨이 깨우는 중`
and `연결 중`, but shows `라이브 시작됨` only after the gateway `started` ACK
and the authoritative session read agrees that status is `live`.

### Participant flow

Participants poll the same-origin status API while `preparing`. They make zero
gateway health/token/WebSocket requests. After observing `live`, they connect,
authenticate, subscribe to one configured language lane, and show `라이브
시작됨` only after the subscribe ACK. A missed gateway status event is repaired
by the existing status poll. Status read failure is fail-closed and never wakes
Cloud Run.

### Cloud Run cost contract

Before any remote mutation, capture the current service, revisions, traffic
tags, billing/CPU mode, min/max scale, concurrency, timeout, startup boost,
uptime checks, Scheduler jobs, and recent instance-start logs. The required
target is:

- request-based CPU / CPU throttling;
- service and traffic-serving revision `min=0`;
- `max=1` while session fanout remains in process memory;
- `concurrency=256` for HOST + 200 VIEWER sockets and reconnect headroom;
- `timeout=3600` and startup CPU boost enabled;
- no external uptime check, cron, or monitoring probe that wakes `/health`.

Remote traffic changes are allowed only after a healthy cold-start revision is
observed. The prior project-specific Cloud Run startup failure must be
reproduced or cleared first. No code deployment is part of this plan without a
separate explicit `deploy` instruction.

## Task breakdown and file ownership

### T1 — Schema Agent

Owns only:

- `supabase/migrations/202608150006_live_gateway_readiness_start.sql`
- the exact appended bootstrap block
- `test/live-gateway-readiness-start-migration.test.js`

Deliver the readiness CAS RPC, service-role-only grants, bootstrap parity, and
concurrent/lost-ACK/idempotence tests. Do not apply the migration.

### T2 — Gateway Backend Agent

Owns only:

- `media-gateway/src/gateway-server.js`
- `media-gateway/src/supabase-adapters.js`
- gateway-focused tests

Permit authenticated HOST preparation against a `preparing` session, start the
candidate pipeline, commit the readiness RPC, then ACK/broadcast. Preserve the
200-viewer, 4x50 authorization batches, backpressure, stop drain, and scale-zero
contracts.

### T3 — Web Backend Agent

Owns only:

- `webapp/app/api/live-sessions/[id]/start/route.ts`
- relevant `webapp/lib/live/{service,store}.ts` blocks and focused tests
- `webapp/components/live/live-audio-client.ts` and focused transport tests

Remove the premature browser-owned `preparing -> live` transition. Start becomes
an owner-bound intent/transport operation; the gateway RPC remains the only
readiness commit. Keep strict Origin, bounded JSON, rate limits, private
no-store responses, and safe Korean errors.

### T4 — Design Agent

Owns only:

- `webapp/components/live/LiveHostDashboard.tsx`
- `webapp/components/live/LiveViewer.tsx`
- shared status/countdown presentation components and CSS
- `webapp/components/live/scheduled-gateway-start.ts` plus focused tests

Implement countdown orchestration, top-right host/viewer states, Retry/Cancel,
and non-blank cached-caption behavior. Use NOVA semantic tokens, Pretendard,
44px targets, a 2px focus ring, reduced motion, and the existing PC/mobile
shared controllers.

### T5 — Desktop Agent

Owns only:

- `electron/main.js`
- desktop start/security focused tests

Audit the desktop path against the same readiness rule. It must not mark or
present live before gateway `started`, must retain the bounded warm-up/retry
window, and must disarm every reconnect after terminal status.

### T6 — Security and Infrastructure Agent

Owns only:

- readiness input/auth/rate-limit validators and hostile tests
- `media-gateway/README.md`
- the scale-to-zero runbook/evidence document

Verify exact Origin, owner/service-role authorization, receipt/session/version
fences, public health method/path bounds, no secret/content logs, and no
participant wake path. Perform read-only GCP diagnosis first. Any remote Cloud
Run or monitoring mutation requires an exact-target approval immediately before
execution.

### T7 — CTO integration and adversarial review

Reconcile SQL/gateway/web shapes, run all suites/build/type checks, browser QA,
and the A1-A8 bug hunt. Repair every Critical/High finding before presenting a
rollout approval gate.

## Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| DB says live before gateway readiness | Critical | Gateway-owned CAS is the only transition; regression test forbids the old order |
| Pipeline starts but readiness CAS fails | High | Close candidate exactly once; no ACK/broadcast; remain preparing |
| CAS succeeds but host ACK is lost | High | Authoritative status read plus existing host reattach; never roll live back |
| Browser sleep or timer throttling misses T-60/T0 | High | Recompute from wall clock on visibility/pageshow/online with a generation fence |
| Retry loop keeps Cloud Run billable | High | Finite attempts ending at T+30; manual retry thereafter; no participant retry while preparing |
| Public health is used as a paid uptime probe | High | Exact GET path only, no scheduled probes, alerts on request/instance hours |
| Prewarming starts Gemini too early | Medium | T-60 performs health only; media pipeline starts at T0/manual Start |
| Cloud Run project still cannot cold-start | High | Reproduce with read-only evidence; do not move traffic until a healthy revision exists |
| 200 sockets exceed service concurrency | High | concurrency 256 contract, HOST+200 load/stop/backpressure test, max instances stays 1 |
| Secret leakage during diagnosis | High | Never print env/secret values; inspect names and redacted metadata only; rotate any credential exposed in prior diagnostic output |

## Test plan

### Minimal root-cause reproductions

1. Gateway connection failure after Start must leave the DB `preparing` and
   participants disconnected.
2. Pipeline success followed by CAS conflict must close the pipeline and emit
   no `started/live` event.
3. CAS success followed by dropped host ACK must recover as live without a
   second pipeline or second transition.

### Scheduling and retry

4. T-61 seconds: gateway request count 0.
5. T-60 seconds: one shared `/health` request, no Gemini/pipeline request.
6. T0: start connection; show live only after ACK plus authoritative status.
7. Failures retry at 0/2/5/10/20 seconds, stop by T+30, and resume only after a
   host Retry.
8. Hidden tab, system sleep, duplicated StrictMode effects, online/pageshow,
   and session replacement never create parallel or stale attempts.

### Participant and capacity

9. 200 viewers remain on web polling during preparing and create zero gateway
   requests; all connect only after live.
10. The 201st viewer is rejected; 200 authorization requests stay in 4x50
    batches; stop drains HOST + 200 viewers to zero sockets.
11. Paused retains the connection; stopped/failed cancels timers, health,
    pending sockets, active sockets, pipeline, and Gemini exactly once.

### Security and failure injection

12. Non-owner, VIEWER, forged version/settings/session, replayed readiness, and
    cross-session calls fail before transition.
13. Missing/evil Origin, health query/suffix/method, invalid gateway URL, and
    raw error injection fail closed without secret/content logs.
14. Provider timeout, Supabase timeout, response loss, browser close, and
    Cloud Run cold-start timeout preserve one authoritative state.

### End-to-end and cost evidence

15. Chrome 320/768/1024/1440, keyboard, 200% zoom: countdown and status are
    visible, actionable, and never claim live early.
16. Production build, web/gateway/root suites, type checks, and diff checks pass.
17. In approved GCP validation, idle instance count reaches zero, preparing
    viewers do not wake it, T-60 warm-up creates one instance, and explicit
    stop returns it to zero with no uptime/cron traffic.

## Rollback

- Feature flag the scheduled readiness coordinator off.
- Stop issuing preparation requests and leave sessions in `preparing`.
- The new RPC is additive and remains dormant; do not drop it in the same
  release.
- If the new Cloud Run revision is unhealthy, keep traffic on the last healthy
  revision while preserving `min=0` only where cold-start health is proven.
- Never restore `min=1` as a silent availability fallback; that reintroduces
  the original cost defect and requires explicit operator approval.
