# Gateway scale-to-zero production approval runbook

Status: **Replacement service is healthy and request-billed with service/revision `min=0`, `max=1`.**

This runbook is evidence-only. It does not authorize deployment, traffic movement,
tag removal, monitoring changes, or secret mutation in production. Older sections below preserve the retired-project incident history.

## Exact current target

- Project: `gen-lang-client-0321430669` (`Realtime`)
- Service: `realtime-noel-media-gateway`
- Region: `asia-northeast3`
- Required serving contract: request-based CPU, service and every traffic-addressable
  revision `min=0`, `max=1`, concurrency `256`, timeout `3600`, startup CPU boost on,
  `1 CPU / 1 GiB` unless a separately approved load test changes it.
- Health contract: exact unauthenticated `GET /health`, no query/suffix/redirect,
  `Cache-Control: no-store`, no Gemini or media-pipeline creation.

## 2026-08-21 read-only production audit

- [x] **PASS — healthy replacement service exists.**
  Console reports `Ready`, one serving revision, and 100% traffic in
  `gen-lang-client-0321430669/asia-northeast3`.
- [x] **PASS — serving revision uses request-based billing.**
  Revision `realtime-noel-media-gateway-00001-5fc` reports request-based billing,
  startup CPU boost, concurrency `256`, timeout `3600`, revision max `1`, and
  `1 CPU / 1 GiB`.
- [x] **PASS — service-level minimum is zero.**
  Console reports automatic scaling with service minimum `0`.
- [x] **PASS — service-level maximum is one.**
  After exact-target approval, the console update changed service automatic
  scaling from `min=0, max=20` to `min=0, max=1`. The console reported both the
  service update and traffic routing complete; the existing ready revision and
  100% traffic target were preserved.
- [x] **PASS — application prewarm is cost-first by default.**
  Scheduled T-60 warmup now requires explicit
  `NEXT_PUBLIC_LIVE_GATEWAY_PREWARM_ENABLED=true`; otherwise the first Cloud Run
  request occurs at T0 or manual Start.
- [x] **PASS — reproducible local guard exists.**
  `scripts/configure-cloud-run-scale-zero.sh` previews by default and requires an
  exact `PROJECT/REGION/SERVICE` confirmation before mutation.
  `scripts/verify-cloud-run-scale-zero.mjs` fails closed on service, revision,
  billing, resource, readiness, and traffic-tag drift.
- [ ] **PARTIAL — zero-idle observation.**
  The post-change dashboard shows no request data for the last day and the exact
  service/revision scaling and billing contracts pass visual inspection. A
  direct active-instance-count series should still be captured after the next
  complete host Start/Stop exercise without issuing a manual health request.

## 2026-08-16 retired-project read-only audit evidence

- [ ] **BLOCKED — serving traffic is scale-to-zero safe.**
  Evidence: 100% traffic serves `realtime-noel-media-gateway-dual-path-0730`,
  whose revision-level minimum is `1`. Seven additional tagged revisions also
  have revision-level minimum `1`; their tag URLs remain traffic-addressable.
- [ ] **BLOCKED — a healthy replacement revision exists.**
  Evidence: latest created revision `realtime-noel-media-gateway-00082-bem`
  has `min=0`, `max=1`, request CPU throttling, startup boost, and 3600-second
  timeout, but is not Ready. Cloud Run reports that its container did not listen
  on `PORT=8080` within the startup window. It is not a safe traffic target.
- [ ] **BLOCKED — concurrency is 256.**
  Evidence: the current serving revision uses concurrency `80`.
- [x] **PASS — serving resource and timeout envelope.**
  Evidence: current serving revision is `1 CPU / 1 GiB`, timeout `3600`, startup
  CPU boost enabled, and max instances `1`.
- [x] **PASS — production secrets use references.**
  Evidence: Gemini, Supabase, HOST token, VIEWER token, and metrics credentials
  are reference-backed. Only variable names and injection modes were inspected.
- [x] **PASS — no uptime check is configured.**
  Evidence: Monitoring uptime configuration list returned zero entries.
- [x] **PASS — Cloud Scheduler cannot be a wake source.**
  Evidence: Cloud Scheduler API is disabled in the configured project; it was
  not enabled during this audit.
- [ ] **BLOCKED — idle instance count reaches zero.**
  Evidence: 18 Cloud Run system instance-start events were observed between
  2026-08-15 13:02Z and 14:59Z. Current revision-level `min=1` settings prevent
  a valid zero-idle demonstration.

## 2026-08-16 approved deployment attempt

- [x] **PASS — immutable production image built without known vulnerabilities.**
  Cloud Build `a29fd744-8be7-4a2e-8325-8dca0c24ec12` produced digest
  `sha256:d04eed2db89e3a1409b4e38c212b0955f5c917633224b3caf99a5da1cc83bf9c`.
  Its production install reported zero vulnerabilities after upgrading the
  `brace-expansion` security override from `5.0.8` to `5.0.9`.
- [x] **PASS — exact image starts locally on `PORT=8080`.**
  Exact `GET /health` returned 200 JSON with `Cache-Control: no-store`;
  HEAD, POST, query, and trailing-slash variants returned 404.
- [x] **PASS — candidate configuration matches the cost contract.**
  Both `readiness-08160108` (gen1) and `readinessg2-08160113` (gen2) used the
  immutable digest, `min=0`, `max=1`, concurrency `256`, request CPU, startup
  boost, `1 CPU / 1 GiB`, and timeout `3600`, with zero percent traffic.
- [ ] **BLOCKED — candidate becomes Ready.**
  Both execution environments failed before emitting an application startup log.
  Cloud Run reported `Internal error occurred while performing container health
  check`, followed by `HealthCheckContainerError` after the four-minute probe.
  Production traffic was not moved.
- [x] **PARTIAL COST BLOCK — legacy traffic tags removed.**
  The traffic list now contains only 100% `dual-path-0730`; seven legacy
  `minScale=1` tag endpoints and the failed candidate tags are no longer
  traffic-addressable. The remaining serving revision still has revision-level
  `minScale=1`, so full scale-to-zero is not yet achieved.
- [ ] **BLOCKED — production health restored.**
  After tag removal, the primary exact `GET /health` returned a Google Frontend
  500 HTML response rather than the gateway JSON contract. The serving revision
  is therefore not a valid availability rollback even though its metadata is Ready.
- [ ] **BLOCKED — readiness database migrations applied.**
  Superseded by the production execution evidence below.

## 2026-08-16 production execution evidence

- [x] **PASS — approved migrations `202608150001` through `202608150006` applied.**
  The first push applied `001`, then `002` rolled back cleanly when pg_cron
  rejected an unschedule call for a missing named job. The migration was repaired
  to check exact job existence, all migration tests passed, and the second push
  applied `002` through `006`. Linked history now matches all six versions.
- [x] **PASS — production schema lint has no errors.**
  Additive corrective migration
  `202608150007_live_plpgsql_ambiguity_repair.sql` was explicitly approved and
  applied. Linked history contains `001` through `007`; remote lint exits zero
  with no errors. Existing non-blocking warnings remain tracked separately.
- [x] **PASS — Tokyo candidate preserves the approved cost and security envelope.**
  `asia-northeast1` revision `realtime-noel-media-gateway-00001-c8g` uses the
  immutable patched digest, exact runtime service account and environment/secret
  reference names, public invoker policy, port `8080`, `min=0`, `max=1`,
  concurrency `256`, request-based CPU, startup boost, `1 CPU / 1 GiB`, and a
  3600-second request timeout. It received no production traffic.
- [ ] **BLOCKED — Tokyo candidate becomes healthy.**
  The revision ended `Ready=False` / `ContainerHealthy=False` with
  `HealthCheckContainerError` after the four-minute TCP startup probe. As in
  Seoul, Cloud Run emitted only the platform `Starting new instance` event and no
  application stdout/stderr. The exact digest starts locally on `PORT=8080`.
- [x] **PASS — a zero-traffic, no-secret diagnostic revision was isolated.**
  Revision `realtime-noel-media-gateway-00003-jfz` uses the same immutable image,
  has no environment or Secret Manager references, and overrides startup with a
  minimal Node HTTP server. Its command and arguments were verified from the
  stored revision spec; it received no traffic or tag.
- [ ] **BLOCKED — the minimal diagnostic process becomes healthy.**
  Even the no-secret minimal Node server ended `Ready=False` /
  `ContainerHealthy=False` after the 30-second TCP probe. Cloud Run again emitted
  only `Starting new instance` and no user-process stdout/stderr. This isolates
  the failure below the gateway configuration/provider layer. The approved
  condition for applying the change to Seoul was therefore not met.
- [x] **PASS — Vercel production was not switched to an unhealthy gateway.**
  `NEXT_PUBLIC_LIVE_GATEWAY_URL` remains unchanged and no production Vercel
  deployment was triggered.

## Human approval checklist

- [ ] Record evidence: identify why the latest revision exits before binding
  `PORT=8080`; attach only safe error codes and timestamps, never env values.
- [ ] Record evidence: build and locally cold-start the exact candidate with
  `PORT=8080`, then prove exact `GET /health` and hostile method/path rejection.
- [ ] Record evidence: confirm the candidate has no literal secret values and
  uses the intended runtime service account with least privilege.
- [ ] Record evidence: obtain explicit approval for one exact healthy revision,
  the intended 100% traffic target, and the complete tag-retention/removal list.
- [ ] Record evidence: before traffic movement, verify the candidate settings:
  `min=0`, `max=1`, concurrency `256`, timeout `3600`, CPU throttling on, startup
  boost on, and the approved CPU/memory envelope.
- [ ] Record evidence: after approved movement, enumerate every traffic entry.
  No entry may reference a `min=1` revision.
- [ ] Record evidence: with no host, viewer, uptime, scheduler, or manual health
  requests, observe instance count return to zero.
- [ ] Record evidence: at T-60, one authenticated host page creates exactly one
  health request and one instance without starting Gemini or the media pipeline.
- [ ] Record evidence: 200 `preparing` participants create zero gateway requests;
  participant 201 is rejected by the canonical capacity fence.
- [ ] Record evidence: at T0/manual Start, readiness CAS succeeds before `started`
  ACK and `live` broadcast; replay returns the same authoritative version.
- [ ] Record evidence: Stop drains HOST and VIEWER sockets, closes provider
  resources once, cancels timers, and returns the service to zero instances.
- [ ] Record evidence: billing and instance-hour alerts are active and contain
  no session identifier, credential, transcript, or participant identity.

## Secret hygiene

- [ ] Record evidence: web and gateway production HOST-token secret references
  resolve to the same active version without printing or exporting its value.
- [ ] Record evidence: rotate production credentials only through the approved
  secret manager procedure, then invalidate the prior version after both
  components are healthy. Local rotation is not production rotation.
- [ ] Record evidence: scan build output and logs for credential-shaped values;
  retain only safe counts and fingerprints.

## 2026-08-16 Seoul service retirement

- [x] **PASS — explicit destructive approval recorded.**
  The user named the exact target:
  `asia-northeast3/realtime-noel-media-gateway`.
- [x] **PASS — the remaining `minScale=1` cost surface was deleted.**
  Cloud Run confirmed deletion of the Seoul service. A subsequent exact service
  describe failed as not found, and the service-scoped revision list was empty.
- [x] **PASS — the immutable deployment artifact was preserved.**
  Artifact Registry still contains digest
  `sha256:d04eed2db89e3a1409b4e38c212b0955f5c917633224b3caf99a5da1cc83bf9c`
  for a future rebuild after the Cloud Run startup issue is resolved.
- [x] **PASS — unrelated production state was preserved.**
  The Tokyo diagnostic service remains `min=0`/`max=1` and has no ready
  revision. Supabase migrations and the Vercel gateway URL were not changed by
  the deletion operation.
- [ ] **BLOCKED — live gateway availability.**
  No healthy Cloud Run gateway remains. The existing Vercel gateway URL now
  targets a deleted Seoul service, so live calls must remain unavailable until a
  replacement revision passes the complete health and readiness gates.

## Rollback gate

- [ ] Record evidence: name the prior healthy revision before any traffic change.
- [ ] Record evidence: rollback changes traffic only; it must not silently restore
  `min=1`. If availability requires `min=1`, stop and request explicit cost approval.
- [ ] Record evidence: readiness feature flag can be disabled while the additive
  RPC remains dormant; do not drop readiness columns or receipts in this release.
