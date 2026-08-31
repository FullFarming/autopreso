# Tasks: Live Call Quality and Gemini Boundary

Source: [`plan-live-call-quality-gemini.md`](./plan-live-call-quality-gemini.md)

## Task 1 — Independent audit

- [x] Correctness/architecture review.
- [x] Gemini/security review.
- [x] Performance review.
- [x] Design/UX review.

## Task 2 — Gemini platform boundary

- [x] RED retry/model/redaction/usage/budget tests.
- [x] Server-only facade and workload allowlist.
- [x] Flash-Lite topic path and Gemini 3.x parameter cleanup.

## Task 3 — Summary reliability

- [x] RED topic-grounded recap and concurrency tests.
- [x] Gemini structured recap transport.
- [x] Durable failure/manual retry states.

## Task 4 — Browser key surface

- [x] Remove unused direct Gemini browser transport and tests.
- [x] Keep 410 tombstones.
- [x] Add bundle/API key non-disclosure contracts.

## Task 5 — Structural decomposition

- [x] Split viewer orchestration and presentation.
- [x] Split host orchestration and presentation.
- [x] Split gateway topic coordinator and lane runtime.

## Task 6 — Functional UI

- [x] Host AI health disclosure.
- [x] Participant local degraded states.
- [x] Topic-grounded minutes navigation and demo states.

## Task 7 — Review and verification

- [x] Five-axis independent re-review and fixes.
- [x] Full tests, typecheck, build and diff checks.
- [ ] Dependency audit — registry metadata 전송에 대한 사용자 승인이 필요해 보류.
- [x] Chrome walkthrough and A1-A8 report.
- [x] Confirm no real provider call, migration, message, email or deployment.
