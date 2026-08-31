# Implementation Plan: Live Records, Sheets, and Gateway Status

Source spec: [`SPEC-live-records-sheets-gateway-status.md`](../SPEC-live-records-sheets-gateway-status.md)  
Module id: `live-records-sheets-gateway-status`

## Architecture Decisions

1. **NOVA DB remains the only truth.** Existing durable utterance, topic, and
   summary tables back live tabs and the archive. Sheets receives a bounded
   projection and is never read to authorize or render a Live Call.
2. **Separate archive retention from participant link expiry.** ADMIN records
   become admin-managed; invite/recap grants retain their shorter security
   lifetimes.
3. **Normalize consent by purpose.** Required privacy, optional summary delivery,
   and optional marketing are independent audit records. The existing summary
   timestamp is migrated only to the matching purpose.
4. **Use a transactional outbox.** Session/join/consent/end RPCs enqueue a
   projection version in the same database transaction. Google IO occurs after
   commit and can fail independently.
5. **Use one server-only Sheets client.** A service account accesses one
   configured workbook with the Sheets scope. Related tab/value updates use one
   atomic batch and stay below the documented 2 MB recommendation.
6. **Share presentation, not authority.** Host and viewer reuse language tabs,
   topic projection, and `GatewayConnectionStatus`; their authorization and
   socket roles remain distinct.
7. **No status-induced wake-up.** The top-right control derives state from the
   current lifecycle and Vercel/Supabase session status. Only host Start performs
   the Cloud Run health warm-up.
8. **Recoverable deletion.** ADMIN deletion hides an archive immediately and
   defers purge for 30 days. This is separate from old automatic retention.

## Dependency Graph

```text
T1 schema/retention/consent/outbox ──┬── T3 records API
                                    ├── T4 Sheets worker/API
T2 validation/security contracts ───┘

T5 gateway host-caption/status contract ─┐
T3 records API + T2 consent contract ────┼── T6 host/viewer/admin UI
T4 Sheets status contract ───────────────┘

T1-T6 ── T7 integration ── T8 adversarial review
```

## Parallel Workstreams and Exclusive Ownership

| Task | Agent | Exclusive production files |
|---|---|---|
| T1 | Schema Agent | one new migration, `supabase/bootstrap-new-project.sql`, migration contract test |
| T2 | Security Agent | new consent/sync validation modules, `live-input-validation.ts`, security test blocks, middleware/CSRF only if a new route requires it |
| T3 | Backend Agent | new `webapp/lib/live-records/*`, new records/consent API routes, focused tests |
| T4 | Sheets Backend Agent | new `webapp/lib/google-sheets/*`, `webapp/lib/live-sheet-sync/*`, sync/retry routes, config boundary and focused tests |
| T5 | Gateway Agent | `media-gateway` host caption fanout/status files and tests; `webapp/components/live/live-audio-client.ts` plus its focused test |
| T6 | Design Agent | new records/status components, `LiveHostDashboard.tsx`, `LiveViewer.tsx`, route-level UI, component CSS/tests |
| T7-T8 | CTO/Reviewers | package test registration, interface reconciliation, read-only review, browser/adversarial evidence |

No two agents edit `LiveHostDashboard.tsx`, `LiveViewer.tsx`, `globals.css`,
`live-contract.ts`, a migration, or `package.json` concurrently. Each agent
must record and preserve the pre-existing dirty diff in its owned files.

## Task Breakdown

### T1 — Additive archive, consent, and outbox schema

- Add purpose-scoped consent audit rows and exact service-role RPCs.
- Add archive lifecycle fields and change cleanup so ADMIN-managed content is
  not purged at 30 days.
- Keep participant/link expiry logic intact.
- Add sheet job/export metadata with idempotent projection versions.
- Enqueue projection jobs inside create/join/consent/end transactions without
  storing projection PII in the queue.
- Mirror the migration into bootstrap and test owner/service-role grants,
  foreign-key cascades, concurrent join/end, and legacy rows.

### T2 — Consent and external-projection security contracts

- Strictly validate three consent purposes, boolean values, notice versions,
  expected session/participant binding, and withdrawal transitions.
- Require the privacy purpose before admission; optional purposes default false.
- Define formula-injection-safe Sheet cell encoding and tab-title normalization.
- Keep full email out of shared viewer contracts, URLs, logs, and job rows.
- Ensure all mutating routes retain strict Origin-before-auth ordering, bounded
  body size, rate limits, private no-store responses, and safe Korean errors.

### T3 — Archive and participant-consent backend

- Add paginated ADMIN list/detail projections with owner filters.
- Reuse transcript/topic/summary stores; do not duplicate full records.
- Add same-participant consent update/withdrawal endpoint.
- Add soft-delete/restore endpoints and explicit purge eligibility state.
- Bind end-session summary scheduling to the existing one-claim-per-language
  flow and expose safe summary state to the archive.

### T4 — Server-only Google Sheets projection

- Add fail-fast server config for workbook ID, service-account email/private
  key, and feature enablement. Never expose these values to the browser.
- Use `google-auth-library` for service-account tokens and fixed Google Sheets
  REST origins; caller-provided URLs/scopes are prohibited.
- Claim one pending job, read the canonical projection, create/reuse the
  per-call tab, and batch index/participant values atomically.
- Serialize a maximum of one request per workbook at a time and keep payloads
  below 2 MB.
- One physical attempt per claim; store a safe failure code and allow only an
  explicit ADMIN retry.
- Provide fake-client tests; no real Google request or sheet creation.

### T5 — Host live lanes and shared connection truth

- Extend browser HOST output so it receives all source/translation caption
  events while preserving the desktop host's local-overlay mirroring rule.
- Add caption callbacks to the browser audio client with session/language/seq
  fences and reconnect exact-once listener cleanup.
- Define one pure connection state model for warming, connecting, connected,
  reconnecting, paused, ended, failed, and idle.
- Prove state presentation never calls `/health`; host Start remains the sole
  web warm-up path.
- Preserve viewer live/paused-only sockets and terminal reconnect fences.

### T6 — Records, consent, lane, and status UI

- Add `GatewayConnectionStatus` as the final/top-right toolbar item for both
  host and viewer. Use a status chip plus accessible disclosure, not color alone.
- Replace the remaining viewer language dropdown duplication with the existing
  `TranslationLaneTabs` as the single language control.
- Compose the browser HOST live surface from the same source/translation topic
  presentation while preserving immediate host controls.
- Keep every lane ingesting and cached; render only the selected panel.
- Add the required privacy and two optional consent controls to admission with
  clear purpose copy and independent state.
- Add ADMIN `라이브콜 기록` list/detail views with bounded pagination,
  language tabs, topic disclosures, minutes, roster/consent disclosure, sync
  status, explicit retry, and recoverable delete.
- Apply NOVA semantic tokens, 44px targets, 2px focus, reduced motion, and
  320/768/1024/1440 plus 200% zoom layouts.

### T7 — Integration and conflict resolution

- Reconcile SQL snake_case, server camelCase, and component presentation shapes.
- Confirm create/join/consent/end enqueue the exact projection version expected
  by the Sheets worker.
- Confirm summary generation reads durable records once and never depends on
  Sheets or participant browser calls.
- Register every new test in the correct package script and run all three suites,
  typechecks, builds, and diff checks.

### T8 — Adversarial bug hunt and browser evidence

- Run A1-A8 scenarios below and repair every Critical/High finding.
- Exercise host, participant, and archive flows in Chrome at 320/768/1024/1440
  and 200% zoom; keep Safari as a production-readiness gate.
- Do not apply a migration, create a Google Sheet, send email, or deploy.

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Changing 30-day cleanup accidentally retains auth grants | Critical | Separate content retention from invite/viewer/recap grant expiry and test each table |
| Sheets becomes an alternate consent truth | High | Outbound-only projection; no Sheets reads in auth, archive, join, or delivery decisions |
| Formula injection through participant fields | High | Literal-value encoding, hostile `= + - @` tests, no formula write mode |
| Sheets outage blocks join/end | High | Transactional outbox, post-commit one-attempt worker, independent failure state |
| Duplicate hooks create duplicate tabs/rows | High | Session projection version idempotency, stored numeric sheet ID, concurrent claim test |
| Indefinite PII retention increases exposure | High | ADMIN-only closed disclosure, export/delete audit, recoverable deletion, no PII in jobs/logs |
| Status indicator wakes Cloud Run | High | Static prohibition on status `/health`; only authenticated host-start lifecycle warms |
| Host and viewer language histories diverge | High | Shared presentation/reducer, durable snapshot merge, cross-session/seq replay tests |
| Browser HOST caption fanout alters desktop overlays | High | Capability-specific fanout and desktop regression tests |
| 1,000 topics/12,000 captions overload archive DOM | Medium | Server pagination, selected-lane-only mount, lazy topic bodies and visit-count tests |
| Google quota or large workbook degradation | Medium | one request/workbook, batch writes, <2 MB payload, safe rollover via config and admin-visible failure |

## Test Plan

### Functional

1. Join requires privacy consent and accepts either optional consent independently.
2. Reconnect does not change consent; withdrawal creates a new audit revision.
3. Two concurrent joins create one participant and one projection version.
4. Sheets failure leaves admission/session/summary committed and shows retry.
5. Replaying one job creates no duplicate sheet or participant row.
6. End closes gateway resources, archives the session, and claims each configured
   summary language once.
7. Host and participant switch source/translation tabs with zero provider call,
   zero loading flash, and complete prior history.
8. Refresh snapshot plus replay remains idempotent across every lane.
9. ADMIN archive works after the previous 30-day cutoff; participant expired
   credentials still fail.
10. The top-right state follows warm/connect/reconnect/pause/end/fail and never
    performs a health request by itself.

### Adversarial A1-A8

| Scenario | Required evidence |
|---|---|
| A1 concurrency | duplicate join/end/sync claims have one winner; one sheet tab/row projection |
| A2 authorization | participant/non-owner cannot list archives, read roster, retry sync, delete, or mutate another consent |
| A3 CSRF/origin | missing/evil suffix/trailing slash/port mismatch mutations fail before store/provider work |
| A4 injection | markup/control/bidi and Sheets formula payloads remain inert plain values |
| A5 SSRF | Sheets origin/scope/workbook come only from validated server config; no caller URL |
| A6 boundaries | empty/oversized Unicode, 2 MB batch edge, notice versions, timestamps, 1,000/12,000 paging |
| A7 orphan/retention | Sheets failure leaves one recoverable job; soft delete/purge/cascade and grant expiry are independent |
| A8 devices | 320/768/1024/1440, 200% zoom, keyboard/focus/live announcements, offline/reconnect/terminal races |

## Verification Commands

```sh
npm --prefix webapp run typecheck
npm --prefix webapp test
npm --prefix webapp run build
npm --prefix media-gateway test
npm run typecheck
npm test
git diff --check
```

Production migration, Google credentials, workbook creation, email dispatch,
and deployment remain behind a separate explicit approval gate.

