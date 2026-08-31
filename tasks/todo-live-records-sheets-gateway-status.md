# Task Checklist: Live Records, Sheets, and Gateway Status

Status: implementation complete; external rollout approval pending  
Source: [`plan-live-records-sheets-gateway-status.md`](./plan-live-records-sheets-gateway-status.md)

## Phase 1 — Foundations

- [x] T1 Schema: additive archive/consent/outbox/export migration
- [x] T1 Schema: bootstrap parity and migration contract tests
- [x] T2 Security: consent, Sheet cell/tab, route boundary validators
- [x] T2 Security: auth/origin/rate/no-store hostile tests

### Foundation gate

- [x] Legacy sessions and summary consent remain readable
- [x] Auth grants still expire independently of archive retention
- [x] Concurrent canonical mutation enqueues one projection
- [x] No shared/production migration applied

## Phase 2 — Backend and Gateway

- [x] T3 Backend: paginated ADMIN archive list/detail
- [x] T3 Backend: participant consent update/withdrawal
- [x] T3 Backend: recoverable archive delete/restore
- [x] T3 Backend: end-to-summary archive state
- [x] T4 Sheets: server-only auth/config/client
- [x] T4 Sheets: idempotent projection worker and explicit retry
- [x] T4 Sheets: fake-client/no-network tests
- [x] T5 Gateway: browser HOST all-lane caption output
- [x] T5 Gateway: shared connection state and lifecycle tests

### Backend gate

- [x] Sheets is absent from transaction bodies and authorization decisions
- [x] One job attempt cannot block join/end/summary
- [x] Desktop host caption/overlay regression remains green
- [x] Status rendering/opening causes zero `/health` requests

## Phase 3 — Design Integration

- [x] T6 Design: shared top-right connection status component
- [x] T6 Design: source + host-configured language tabs, no duplicate dropdown
- [x] T6 Design: host uses the shared live translation presentation
- [x] T6 Design: three-purpose admission consent UI
- [x] T6 Design: ADMIN records list/detail/sync/delete UI
- [x] T6 Design: NOVA tokens, 44px, focus, reduced motion, responsive layouts

### Design gate

- [x] Switching tabs has no loading flash or history loss
- [x] All lanes ingest while hidden; only selected panel mounts
- [x] Host/viewer connection state is top-right and truthful
- [x] 1,000 topics/12,000 captions keep bounded DOM work
- [x] Participant UI exposes no provider/model/token/gateway URL

## Phase 4 — Integration and Adversarial Review

- [x] T7 API/SQL/UI shape reconciliation
- [x] T7 full webapp, gateway, root tests/typechecks/diff check
- [ ] T7 production build (run only at the release gate)
- [x] T8 A1-A8 adversarial bug hunt
- [x] T8 Chrome 320/768/1024/1440 and 200% zoom evidence
- [ ] T8 Safari production-readiness checklist
- [x] T8 Critical/High findings repaired and reverified

## Approval Gates

- [x] Implementation plan explicitly approved
- [x] No real Google account, workbook, migration, email, or deployment used in development
- [ ] Separate approval for shared/production migration
- [ ] Separate approval for Google service-account/workbook configuration
- [ ] Separate approval for deployment
