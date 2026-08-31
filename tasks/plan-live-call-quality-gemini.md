# Plan: Live Call Quality and Gemini Boundary

Source: [`../SPEC-live-call-quality-gemini.md`](../SPEC-live-call-quality-gemini.md)

## Architecture Decision

### AD-1 — Server-only Gemini facade

All Gemini text work crosses one server-owned facade that applies workload allowlists, one-attempt SDK HTTP policy, prompt/output bounds, local schema validation, redaction, safe error mapping, and content-free usage metrics. Live audio remains in its isolated gateway adapter. Browser code has no Gemini credential or direct provider transport.

### AD-2 — Durable captions before AI enrichment

Source transcription and durable caption publication remain the critical path. Translation, polish, topic grouping, and recap are downstream enrichment stages with independent states. An enrichment failure cannot roll back or delay committed source captions.

### AD-3 — Topic-grounded recap

The recap generator receives the existing authoritative topic order and selected final utterances. Deterministic statistics remain local code. Gemini generates only bounded prose fields defined by the recap schema.

### AD-4 — Decompose before adding branches

Large host/viewer/gateway files are split with behavior-locking tests first. New AI health UI and provider policies are added to focused modules, not as more conditionals in existing 1,000+ line files.

## Execution Phases and File Ownership

### Task 1 — Independent audit packet (read-only, parallel)

- Correctness/architecture reviewer: specs, tests, host/viewer state machines, recovery and recap lifecycle.
- Gemini/security reviewer: provider SDK usage, key boundary, prompts, rate/cost, output validation, logging and retention.
- Performance reviewer: hot paths, call amplification, re-renders, pagination, memory and N+1 IO.
- Design reviewer: host, participant, minutes, mobile and accessibility against `DESIGN.md`.
- Output: severity-ranked findings with exact evidence. No implementation yet.

### Task 2 — Gemini platform boundary

Owner files:

- New `packages/gemini-server/*`
- `media-gateway/src/server.js`
- `media-gateway/src/config.js`
- `media-gateway/src/live-topic-detector.js`
- `media-gateway/src/google-provider-adapters.js`
- `media-gateway/src/caption-polish.js`
- focused gateway/package tests

Responsibilities:

- One-attempt client, workload model allowlist, structured response adapter, redaction, usage metrics, concurrency/rate budgets.
- Topic model moves to Flash-Lite; remove deprecated sampling parameters.
- Preserve durable-first and no-fallback behavior.

### Task 3 — Summary reliability and Gemini recap

Owner files:

- `webapp/lib/live/summary.ts`
- `webapp/lib/live/config.ts`
- `webapp/app/api/live-sessions/[id]/summary/route.ts`
- summary tests

Responsibilities:

- Replace the OpenAI recap transport with the canonical server Gemini facade or its server-safe REST boundary without adding a client dependency.
- Feed authoritative topic structure; exclude profile/credential data; locally derive statistics.
- Keep durable claim/CAS state, explicit errors, bounded manual retry, no automatic fallback.

Dependency: Task 2 public server contract must be fixed first.

### Task 4 — Dead browser Gemini removal and security contracts

Owner files:

- Remove `webapp/lib/geminiChannel.ts` and `webapp/lib/geminiChannel.test.ts`
- `webapp/lib/audio.ts` stale comment only
- `webapp/package.json` test entry only
- `webapp/app/api/gemini-token/route.ts`
- `webapp/app/api/pair-keys/route.ts`
- security contract tests

Responsibilities:

- Preserve `410` tombstones.
- Prove browser bundles and API responses contain no Gemini key or direct provider transport.
- Do not alter authentication or CORS behavior.

### Task 5 — Behavior-preserving decomposition

Sequential ownership:

- Viewer slice: `LiveViewer.tsx` plus new `components/live/viewer/*` and hook tests.
- Host slice: `LiveHostDashboard.tsx` plus new `components/live/host/*` and hook tests.
- Gateway topic slice: move coordinator from `supabase-adapters.js` to `live-topic-coordinator.js`.
- Gateway lane slice: move lane runtime from `live-media-pipeline.js` to focused modules.

Each slice begins with characterization tests, changes no product behavior, and is reviewed before the next feature layer.

### Task 6 — Functional UI improvements

Design Agent ownership:

- New shared AI health disclosure components and CSS modules.
- Host integration in decomposed host surface.
- Participant degraded-state composition in decomposed viewer surface.
- Meeting minutes topic navigation and recap state.
- Demo states and browser-focused tests.

Backend state types are provided before UI integration. UI never determines authorization or provider policy.

### Task 7 — Synthesis and adversarial verification

- Reconcile backend shapes with UI states and Gemini failure codes.
- Independent code/security/design re-review after fixes.
- Run full suites, typechecks, build, dependency audit, diff/static scans.
- Run Chrome normal flow and provider/network failure simulations at required widths.
- Produce A1-A8 report and explicit deployment approval gate.

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| SDK default retries multiply cost and latency | High | Client-wide `attempts: 1` contract test; no application retry |
| Browser transport or stale code reintroduces key exposure | High | Remove unused transport; keep 410 tombstone; bundle/static regression tests |
| Preview Live Translation model changes or retires | High | Isolated pinned adapter, startup allowlist, deprecation runbook; no silent switch |
| Topic calls amplify on long continuous speech | High | Meaningful gate, per-session single-flight, request/concurrency budget before dispatch |
| Timeout is mistaken for provider-side cancellation | Medium | Usage budget before dispatch; metrics count timed-out requests; no cost claim from abort |
| Recap provider change reduces quality | Medium | Topic-grounded golden fixtures and schema/grounding tests before transport switch |
| Refactor changes recovery or ordering | High | Characterization tests; one slice at a time; durable-first order assertions |
| Large shared dirty worktree causes accidental overwrite | High | Exclusive file ownership, scoped diffs, no unrelated cleanup or reset |
| Usage telemetry leaks content/identity | High | Numeric/enum allowlist only; hostile prompt/log tests |
| Gemini logging/data-sharing retains confidential content | High | Operational ZDR/logging checklist; never enable shared datasets; paid/auth key requirement |

## Test Plan

### Correctness

- Host create/start/pause/resume/end and participant join/restore remain unchanged.
- Captions commit before topic/polish calls and survive provider timeout/refusal/429/5xx.
- Topic decision uses Flash-Lite and recap/final quality uses Flash; client input cannot override either.
- Recap chapters preserve authoritative topic order and omit unassigned/failed target-lane duplication.
- Same summary claim under concurrency calls Gemini once.

### Security

- Browser import/key response/direct Gemini WebSocket tests fail closed.
- Unicode email, access code, invite token, JWT, UUID/grant, company and title prompt probes are removed.
- Cross-session topic/recap data is rejected before provider dispatch.
- Gemini output with unknown keys, markup, control/bidi text, oversized arrays, invalid JSON or refusal is rejected.
- Logs contain only workload/model/latency/token counts/safe code.

### Performance and cost

- SDK attempts exactly one request for 429/5xx/network failure.
- Per-session concurrency and request budgets reject excess work before provider dispatch.
- Usage metadata parsing is bounded and never stores prompts/responses.
- No N+1 topic/utterance fetch; recap reads paginated data once per resource.
- Viewer/host render-count characterization protects against state-update amplification.

### UI and accessibility

- AI health disclosure keyboard/focus/44px/contrast/reduced-motion.
- Source captions remain visible when translation/topic/summary is degraded.
- Loading, empty, active, paused, reconnecting, failed, retryable and ended states.
- Chrome 320/768/1024/1440, 200% zoom, Lighthouse accessibility, console and network.

### Full gates

- Root, web and gateway full test suites.
- Root and web typecheck; web production build.
- Native dependency audit triaged by reachability; no automatic audit fix.
- `git diff --check` and dangerous-pattern/secret scans.

