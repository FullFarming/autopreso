# Spec: Live Records, Sheets Operations, and Gateway Status

Module id: `live-records-sheets-gateway-status`

## Objective

Make NOVA DB the only authoritative record for every committed source caption,
host-approved translation lane, topic, and post-call summary. Give the ADMIN a
durable Live Call archive, project participant and consent operations into a
Google Sheets workbook asynchronously, and show one truthful real-time
connection indicator at the top-right of both host and participant web views.

The Google workbook is an operational copy. It never becomes an authorization,
transcript, summary, or consent source of truth.

## Approved Product Contract

```text
Host Live Call
    |
    v
NOVA DB -- source captions, translations, topics, summaries, consent truth
    |-- host/participant real-time language tabs
    |-- ADMIN Live Call records archive
    `-- automatic post-call summary
             |
             `-- asynchronous projection
                    Google Sheets -- participant, consent, delivery status copy
```

## Scope

### Included

- Preserve committed source captions, translations, topics, and summaries until
  an ADMIN explicitly deletes the archive.
- Keep participant recap access and invitation expiry separate from ADMIN
  archive retention.
- Separate required privacy consent, optional summary-delivery consent, and
  optional marketing consent. Store purpose, notice version, acceptance time,
  and withdrawal time as NOVA DB truth.
- Add an ADMIN-only records list and detail view with language tabs, transcript,
  topics, summary, participant roster, consent state, and Sheets sync state.
- Enqueue Sheets projections during committed database operations and perform
  the external request only after the transaction commits.
- Create or reuse one per-call sheet tab named from the session date and title,
  plus a stable session index tab.
- Generate post-call summaries automatically from durable NOVA records after
  authenticated session termination. Participant clients never dispatch AI.
- Replace duplicated host/viewer connection labels with one shared, accessible
  top-right `GatewayConnectionStatus` presentation.
- Preserve all language histories in memory and durable snapshots while the
  user changes the visible source/translation tab.

### Excluded

- Sending real email or marketing messages.
- Using Google Sheets as a database, authorization source, or summary store.
- Storing transcripts or summary bodies in Google Sheets.
- Applying migrations, creating a real spreadsheet/service account, changing
  production secrets, or deploying.
- Changing the separately governed participant-capacity limit.

## Roles and Authorization

- `ADMIN`: create/host/end sessions; read owned archives and participant consent;
  retry a failed Sheets projection; request an archive deletion.
- Participant: join with a valid invite/code, submit their own consent choices,
  view the admitted session's language lanes and published summary.
- Gateway service role: persist committed captions/topics and read the pinned
  session projection only. It cannot read Google credentials.
- Sheets worker: server-only, reads one authorized NOVA projection and writes
  one configured workbook. It cannot mutate session or consent truth.

All owner checks precede transcript, participant, sync, or external-provider
work. Participant cookies cannot reach ADMIN archive or sync endpoints.

## Data Contract

### Existing canonical records

- `live_sessions`
- `live_utterances`
- `live_topics`
- `live_topic_utterances`
- `live_meeting_summaries`
- `live_participants`

### Additive records

1. `live_participant_consents`
   - session and participant foreign keys
   - purpose: `privacy`, `summary_delivery`, or `marketing`
   - notice version
   - accepted/withdrawn timestamps
   - immutable audit revision
2. `live_sheet_sync_jobs`
   - session, projection version, reason, state, attempt count, safe error code
   - no raw email, transcript, summary, token, or Google credential
   - unique idempotency key per session projection
3. `live_sheet_exports`
   - session, opaque workbook reference version, numeric sheet ID, safe tab title
   - last exported projection version and last outcome
4. Archive lifecycle fields on `live_sessions`
   - archived time and optional ADMIN deletion time
   - deletion is hidden immediately and purged only after a recovery window

No existing column is dropped. Existing summary consent is projected into the
new purpose model during the migration without inventing privacy or marketing
consent.

## Consent UI and Semantics

- Required privacy checkbox: unchecked blocks admission.
- Optional summary-delivery checkbox: defaults off.
- Optional marketing checkbox: defaults off and is visually separate.
- Every checkbox links to its exact notice text/version.
- A participant may withdraw either optional consent through an authenticated,
  same-session endpoint. Withdrawal never deletes the underlying audit event.
- Sheets shows current state and timestamp; NOVA DB remains the evidence source.

## Google Sheets Projection

### Workbook layout

- `세션 목록`: session ID, date, title, status, languages, participant count,
  summary state, sheet sync state, and the per-call sheet link.
- Per-call tab: participant email, optional company/department/job title, joined
  time, privacy/summary/marketing state and timestamps, delivery status.
- Tab titles are NFC-normalized, formula-safe, length-bounded, and collision
  suffixed. Cell values beginning with formula control characters are written as
  literal strings.

### Execution boundary

- Database RPC commits canonical state and one idempotent outbox row.
- Next.js `after()` may claim one job after the response; external IO is never
  inside a database transaction.
- One physical Sheets request is made per claim, using batch operations and a
  request body below 2 MB.
- A failure records only an allowlisted safe code. It does not fail admission,
  stop, summary storage, or archive access.
- Failed jobs remain visible to ADMIN and require an explicit retry action. No
  silent provider retry or fallback is permitted.
- Authentication uses a server-only service account with the Sheets scope and
  a workbook explicitly shared to that account. Domain-wide delegation is not
  required.

## Live Language History

- The visible lanes are `원문` followed by the languages selected by the host
  before starting.
- Both host and participant receive the same labels, ordering, topic grouping,
  and final/provisional distinction.
- Every lane continues ingesting while another tab is selected.
- Switching tabs performs no provider request, does not clear another cache,
  and immediately renders the cached history.
- Refresh loads the durable snapshot before replay merging. Session, language,
  sequence, utterance key, and topic fences reject cross-session or duplicate
  events.
- Browser HOST receives its own caption events without changing the desktop
  host's existing local-overlay mirroring contract.

## Gateway Connection Status

The shared state machine is:

```text
idle -> warming -> connecting -> connected
                         |           |
                         v           v
                       error <- reconnecting

connected <-> paused
connected/paused/reconnecting -> ended | failed
```

- User-facing label: `실시간 연결`, not a provider or infrastructure name.
- Host and participant show a 44px top-right status trigger with icon, text, and
  semantic state; color is never the only signal.
- `role=status`/polite announcements occur only on meaningful state changes.
- Host details may show language health and one recovery action.
- Participant details show caption continuity and a safe next action, never
  gateway URL, model, token, or raw error.
- Merely rendering or opening the status control never requests `/health` and
  never wakes Cloud Run. Host start is the only browser warm-up trigger.
- Preparing, stopped, ended, and failed participants hold zero gateway sockets.

## Records UI

- Add `라이브콜 기록` to the ADMIN rail.
- List view is paginated and searchable by title/date; it never downloads the
  full transcript for every row.
- Detail view uses existing earnings-call header, language tabs, topic
  disclosures, and MeetingMinutes components.
- Transcript pages and expanded topics are progressively rendered so 1,000
  topics/12,000 captions do not create an unbounded DOM.
- Participant PII and consent are in a closed-by-default ADMIN disclosure.
- Archive deletion requires typed confirmation, first performs a recoverable
  soft delete, and never deletes the Google workbook automatically.

## Success Criteria

1. A host starts once; participant views create zero AI/provider requests.
2. Source and every configured translation continue recording while any tab is
   visible; tab changes have no loading flash or lost history.
3. Ending the call closes gateway resources and schedules exactly one summary
   claim per configured language.
4. ADMIN can reopen an ended session and read its language-specific transcript,
   topics, and summary after the previous 30-day boundary.
5. Join and consent mutation atomically enqueue one idempotent Sheets projection;
   failed external IO cannot corrupt canonical state.
6. Sheets contains participant/consent/delivery operations only and no transcript,
   summary body, token, or provider secret.
7. Host and participant top-right status matches the real lifecycle, survives
   reconnect races, and does not wake an idle Cloud Run service.
8. All controls work at 320/768/1024/1440px, 200% zoom, keyboard-only, reduced
   motion, and WCAG 2.1 AA contrast.

## Rollback

- Disable the records, Sheets, and new status surfaces independently with
  server-owned feature flags.
- Stop claiming Sheets jobs; canonical NOVA records are unaffected.
- New tables/fields remain additive and dormant. No immediate drop migration.
- Restore the 30-day purge only through a separately approved data-retention
  migration after an export/impact review.

