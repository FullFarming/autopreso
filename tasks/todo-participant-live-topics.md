# Tasks: Participant Live Topic Transcript

Source: [`plan-participant-live-topics.md`](./plan-participant-live-topics.md)

## Task 1 — Schema/RPC

- [x] RED migration/RPC contract tests.
- [x] Add topic and membership tables, constraints, indexes, retention.
- [x] Add versioned assign/shift/silence/end/recovery RPCs.
- [x] Bootstrap parity; do not apply migration.

## Task 2 — Detector/Security

- [x] RED meaningful/shift/failure/prompt-injection tests.
- [x] Add bounded strict topic detector and deterministic fallback.
- [x] Prove no PII/secrets/tools/provider storage/retry.

## Task 3 — Shared UI

- [x] RED tab/disclosure/state/accessibility tests.
- [x] Add lane tabs, current topic, completed topic components.
- [x] Semantic NOVA tokens, responsive and reduced-motion contracts.

## Task 4 — Gateway lifecycle

- [x] Enqueue only durable source finals without blocking captions.
- [x] Versioned DB transitions, topic events, silence and pause rules.
- [x] Restart recovery and full gateway regression.

## Task 5 — Web contract/API

- [x] Fail-closed topic/event/snapshot/transcript types and reducer.
- [x] Existing endpoint projection, authorization, and no-store headers.
- [x] Replay, late snapshot, language switch, restore regression tests.

## Task 6 — Viewer integration

- [x] LiveViewer and post-session topic composition.
- [x] Demo states and recovery of non-content UI preferences only.
- [x] Confirm participant media/microphone paths remain absent.

## Task 7 — Review/QA

- [x] Independent code/security/design review and fixes.
- [x] Full tests, typecheck, build, and diff check (no lint script exists).
- [x] Chrome widths, keyboard, a11y, console, and responsive walkthrough.
- [x] A1–A8 evidence and Safari/provider/DB residual report.
- [x] Confirm no migration, email, message, or deployment action.
