# Supabase live schema

The migrations in `migrations/` are additive and have not been applied
automatically. Apply them in filename order to a linked development Supabase
project. The core sequence is:

1. `202607190001_live_sessions.sql` creates sessions, viewer grants, speakers,
   snapshots, rate limits, RLS, admission RPCs, and cleanup RPCs.
2. `202607190002_live_voice_output.sql` adds Townhall voice state and moves
   speaker/snapshot writes behind guarded RPCs. It also removes the temporary
   `realtime.messages` policies created by the first migration because viewer
   delivery now goes through the media gateway.
3. `202607200001_live_session_invites.sql` adds one HMAC-only invite per
   session and connects invite revocation to admission close, session stop, and
   cleanup.
4. The later configuration, cleanup, and provider migrations evolve those
   contracts without removing legacy columns or overloads.
5. `202607230001_live_multilingual_languages.sql` restricts every new or
   updated session to 1–3 unique canonical language codes, validates existing
   sessions and snapshots without rewriting them, and adds an atomic
   service-role-only viewer topic authorization RPC.
6. `202607230002_live_call_floor.sql` adds the single-speaker floor,
   append-only meeting utterances, and structured meeting summaries.
7. `202607230003_live_scheduling_recap.sql` adds nullable title and schedule
   metadata, optimistic host start and explicit viewer leave RPCs, QR-only
   admission overloads, and a minimal 30-day participant recap grant. Recap
   grants retain no display name or device hash.
8. `202607230004_live_participant_identity_admission.sql` keeps the existing
   QR path and adds a parallel six-digit admission path without storing the
   plaintext code. It persists normalized participant name, department, job
   title, join/leave/speaking activity, and utterance attribution for the
   meeting recap. Existing viewer grants remain valid because their new
   identity columns are nullable; newly redeemed grants require all three
   identity fields through the v3 RPC overloads. Valid utterance start/end
   pairs also accumulate per-participant speaking seconds for recap analytics;
   negative or longer-than-one-hour segments are ignored.
9. `202609020002_auth_profiles_desktop_codes.sql` makes Supabase Auth the host
   identity provider: `profiles` (approval `status`, `role`, and the `host_id`
   string the `rnw_session` cookie carries), append-only `profile_events`,
   one-shot `desktop_login_codes`, RLS, and the service-role RPCs
   `upsert_profile_on_login_v1`, `read_profile_by_host_id_v1`,
   `issue_desktop_login_code_v1`, and `consume_desktop_login_code_v1`. See
   "Authentication 설정" below.
10. `202609020003_console_rpcs.sql` adds the admin console tables
    `engine_defaults` and `console_settings` plus the admin-only RPCs for
    signup approval, roles, session aggregates, global engine defaults, and
    the legacy password-login switch (`set_legacy_password_login_v1`). It
    depends on `profiles` from the previous migration.

## Deployment region policy and current audit

The accepted primary deployment regions for live customer data are:

- preferred: Supabase Northeast Asia (Seoul), AWS `ap-northeast-2`;
- accepted alternative: Supabase Southeast Asia (Singapore), AWS
  `ap-southeast-1`.

Use a **specific** region when creating a project. Do not rely on the general
`APAC` region if an exact residency location is required. Provider region codes
are not interchangeable: Supabase Seoul is `ap-northeast-2`, Google Cloud Run
Seoul is `asia-northeast3`, and Vercel Seoul is `icn1`.

Read-only audit on 2026-08-28:

| Component | Observed location | Status |
| --- | --- | --- |
| Production Cloud Run gateway | Seoul, `asia-northeast3` | accepted |
| Vercel Functions | Seoul, `icn1` | accepted; repository and dashboard override agree |
| Repository-linked Supabase project | Seoul, `ap-northeast-2` | accepted, but this alone does not prove it is the production target |
| Dashboard project named `Realtime noel` | Sydney, `ap-southeast-2` | not accepted by this policy |
| Gemini Developer API | global `generativelanguage.googleapis.com` endpoint | not region-pinned; no Seoul/Singapore residency guarantee |

The repository link, local environment, Vercel production secrets, Cloud Run
secret references, and the Supabase project receiving production requests must
all identify the same project before any migration or schema push. Do not infer
that relationship from a dashboard project name. The current repository link
points at the Seoul project, while the separate Sydney project shows recent
requests and a later migration. Treat that mismatch as a cutover blocker until
the exact production project is reconciled without printing secret values.

There is currently no configured Cloud Speech-to-Text regional resource in the
runtime. If Cloud Speech V2 is introduced, create the recognizer and client
endpoint in an approved region and verify model/language availability there.
Moving Cloud Run or Supabase does not regionalize Gemini Developer API traffic.
A strict in-region AI-processing requirement needs a separately approved Vertex
AI regional design and per-model availability check.

## Supabase region changes

A hosted Supabase project is bound to its selected region at the infrastructure
level. Its region cannot be changed in place, and `supabase link` only changes
the CLI target; it does not move data. To move from Sydney to Seoul or
Singapore, create a new project in the selected specific region and migrate to
it.

Do not use **Restore to a New Project** as a cross-region shortcut. Supabase's
physical-backup clone feature deliberately creates the clone in the same region
as the source. For a cross-region move, use a logical dump/restore and migrate
non-database resources separately.

Official references:

- region change: <https://supabase.com/docs/guides/troubleshooting/change-project-region-eWJo5Z>
- available regions: <https://supabase.com/docs/guides/platform/regions>
- project-to-project migration: <https://supabase.com/docs/guides/platform/migrating-within-supabase>
- CLI backup and restore: <https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore>
- physical-backup clone limitations: <https://supabase.com/docs/guides/platform/clone-project>
- Auth user migration: <https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects>
- Edge Function regional invocation: <https://supabase.com/docs/guides/functions/regional-invocation>

## Approved cross-region migration runbook

Do not run this procedure during a live event. The old project and the new
project must never accept production writes at the same time unless an approved
dual-write and reconciliation design exists.

### 1. Reconcile the source and destination

Record, without copying keys into logs or documentation:

- the source project ref, name, region, plan, Postgres version, and compute size;
- the target project ref and exact Seoul or Singapore region;
- migration history from `supabase migration list --linked`;
- database size, row counts, Auth user count, Storage object count and bytes;
- enabled extensions, Realtime publications, Database Webhooks, cron jobs,
  Edge Functions, Auth providers, redirect URLs, email templates, and secrets;
- the Supabase ref used by Vercel Production and each Cloud Run revision.

The source project for a production migration is the project actually receiving
production reads and writes, not automatically the project currently stored in
`supabase/.temp/project-ref`.

### 2. Create and prepare the target project

Create a new Supabase project in one exact region:

```text
Preferred: Northeast Asia (Seoul), ap-northeast-2
Alternative: Southeast Asia (Singapore), ap-southeast-1
```

Before restore, enable the required extensions and Database Webhooks. Keep the
target application credentials out of the repository and configure them only in
approved secret stores. Do not enable client traffic yet.

### 3. Freeze and back up the source

1. Block new live-session creation and wait for active sessions to finish.
2. Put the application into maintenance/read-only mode.
3. Take a final logical dump using securely supplied source and target database
   URLs. Do not place database passwords in committed scripts or shell history.
4. Preserve roles, schema, data, and `supabase_migrations` history.

Supabase's official logical backup sequence is:

```sh
supabase db dump --db-url "$OLD_DB_URL" -f roles.sql --role-only
supabase db dump --db-url "$OLD_DB_URL" -f schema.sql
supabase db dump --db-url "$OLD_DB_URL" -f data.sql --use-copy --data-only \
  -x "storage.buckets_vectors" -x "storage.vector_indexes"

supabase db dump --db-url "$OLD_DB_URL" -f history_schema.sql \
  --schema supabase_migrations
supabase db dump --db-url "$OLD_DB_URL" -f history_data.sql \
  --use-copy --data-only --schema supabase_migrations
```

Restore with a current PostgreSQL client and fail on the first error:

```sh
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --file history_schema.sql \
  --file history_data.sql \
  --dbname "$NEW_DB_URL"
```

Follow the current official guide if Supabase changes this command sequence.
Never execute a repository migration manually on top of an already restored
copy of the same migration.

### 4. Recreate resources that a database restore does not complete

A project database dump is not a full hosted-project clone. Recreate and verify:

- Auth providers, redirect URLs, email/SMS settings, templates, CAPTCHA, and
  API keys;
- Realtime publications and Realtime project settings;
- Edge Functions, their secrets, and any explicitly selected invocation region;
- Database extensions, Webhooks, network restrictions, read replicas, and log
  drains;
- scheduled cleanup, including `cleanup_expired_live_state()` and
  `verify_live_cleanup_schedule()`;
- Storage objects and bucket configuration.

The database restore can include Auth users and password hashes, but Auth
settings and keys still require manual configuration. Decide explicitly whether
to preserve signing-key continuity or force users to sign in again. A new JWT
secret invalidates existing sessions. Never copy signing secrets into this file.

The private `live-covers` bucket must remain private, preserve its 20 MiB limit
and JPEG/PNG/WebP MIME allowlist, and have every object copied separately.
Database rows in the `storage` schema are not proof that the underlying object
bytes were migrated. Compare source and target object count, path, size, and a
sample of content hashes.

### 5. Reconcile migration history before any push

Link the target only after recording the previous link and receiving approval:

```sh
supabase link --project-ref <new-development-or-target-project-ref>
supabase migration list --linked
supabase db push --linked --dry-run
```

For a full logical restore, the expected dry run is empty after migration
history is restored. If it is not empty, stop and reconcile missing or divergent
versions. Do not repair history or run additive SQL until the mismatch is
explained and approved.

### 6. Validate the target before cutover

In addition to the schema checks below, verify:

- expected table and critical row counts, Auth user count, and Storage object
  count/bytes;
- RLS, grants, service-role-only RPCs, and direct-client denial;
- Realtime publication membership and a full subscribe/unsubscribe exercise;
- Auth sign-in, anonymous viewer admission, token refresh, and redirect URLs;
- signed upload, signed read, move, and delete for `live-covers`;
- cleanup cron and retention behavior;
- one complete host/viewer session, duplicate join, revoke, expiry, reconnect,
  stop, recap, and cleanup flow;
- a 200-viewer staging test without creating provider sessions per viewer.

### 7. Cut over as one approved change

Update all of the following atomically and redeploy before removing maintenance
mode:

- Vercel Production and applicable Preview values:
  `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  temporary `NEXT_PUBLIC_SUPABASE_ANON_KEY` fallback,
  `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and
  `LIVE_ALLOWED_SUPABASE_REF`;
- corresponding Cloud Run Supabase URL/ref and Secret Manager references;
- Auth site URL and redirect allowlist;
- any provider webhooks or external callback URLs tied to the old project.

A Vercel deployment is required because `NEXT_PUBLIC_*` values are embedded at
build time. A Cloud Run environment or secret-reference change creates a new
revision. Both are remote production mutations and require explicit approval of
the exact project, region, service, revision, traffic target, and rollback
point.

### 8. Roll back safely

Keep the old project intact and read-only through the observation window. If the
new project has accepted no production writes, rollback may switch all
environments to the old project and redeploy. Once the new project accepts
writes, rollback requires a reverse delta migration or explicit reconciliation;
it is not an environment-variable-only operation.

Do not delete the Sydney project, rotate away its only recovery credentials, or
run destructive down migrations until the Seoul/Singapore target has passed the
observation window and backup restore has been tested.

## Schema migration apply procedure

Before an approved apply, use the linked-project migration history and dry run:

```sh
supabase link --project-ref <development-project-ref>
supabase migration list --linked
supabase db push --linked --dry-run
```

Verify that all repository migrations appear in filename order. Only after the
explicit migration approval, apply and lint them:

```sh
supabase db push --linked
supabase db lint --linked --fail-on error
```

Then verify:

1. anonymous sign-in is enabled for viewers;
2. direct client writes to live tables and all direct access to
   `live_session_invites` are denied;
3. the server alone holds `SUPABASE_SECRET_KEY`; the legacy
   `SUPABASE_SERVICE_ROLE_KEY` is temporary fallback only;
4. `cleanup_expired_live_state()` is scheduled and
   `verify_live_cleanup_schedule()` returns true;
5. admission, invite, 200-viewer concurrency, duplicate join, revoke, expiry,
   and language-removal tests pass before any production migration.
6. `live_languages_valid(array['en', 'ja', 'zh-Hans'])` returns true, while
   duplicate, uppercase, empty, and four-language arrays return false. Generic
   `zh` remains a compatible input alias but
   `live_languages_canonical(array['zh'])` returns false because storage uses
   `zh-Hans`. The executable development verification queries are documented
   at the end of the multilingual migration.
7. QR invite redemption succeeds while a session is `preparing`, caption topic
   authorization remains denied until `start_live_session` atomically moves it
   to `live`, and concurrent starts with the same version yield only one
   successful transition.
8. `leave_live_session` deletes the viewer grant and clears the speaking floor
   only when the departing viewer owns it. On termination, recap grants contain
   only `session_id`, anonymous `user_id`, and a 30-day expiry; cleanup removes
   expired grants, utterances, and summaries.
9. Opening admission twice with the same deterministic code HMAC returns the
    current version, while a different HMAC fails. Pause, restart, and host
    configuration updates preserve `admission_generation` and the code HMAC;
    explicit stop closes the admission lifetime. After the persistence migration,
    access expiry denies admission without deleting the saved call or its code.
    Renewing host access does not extend the admission deadline; reopening
    admission requires a separate explicit host action with the current version.
10. `redeem_live_admission_v3` and `redeem_live_invite_v3` both create the same
    retained participant identity. `read_live_participant_roster` rejects a
    non-owner host and returns no participant after its 30-day retention
    deadline. All three RPCs are executable only by `service_role`.
11. The application derives the displayed six-digit code deterministically
    from a server-only HMAC key plus `session_id:effective_generation`, then
    sends only a separate 64-character verification HMAC to Supabase. For an
    `uninitialized` session, effective generation is the stored generation
    plus one; otherwise it is the stored generation. Never log, persist, or
    return that plaintext code outside the host invite response.

The SQL files are migration-history artifacts, not idempotent setup scripts;
do not execute the same file manually twice. The first migration expects the
hosted Supabase `realtime` schema to exist.

Rollback is application-first: stop live session creation and leave the
additive tables/functions in place. A destructive down migration is
intentionally not included.

## Saved Live Call persistence

`202608310001_live_session_persistence.sql` separates a saved call from its
finite access window. Browser navigation, app closure, and access expiry do not
change `preparing`, `live`, or `paused` into a terminal status. The host must
explicitly cancel or end the call. Closing the host connection still releases
microphone/provider resources; retaining a database row does not keep audio
capture or a paid translation pipeline running.

| Schema surface | Change and existing-row behavior |
| --- | --- |
| `live_sessions.access_window_started_at` | New non-null timestamp. Existing rows use their original `created_at`; new rows use the current statement timestamp. Backfill does not alter status, schedule, code, or expiry. |
| Session expiry constraint | Keeps a maximum six-hour access window after the later of its anchor or scheduled start. The deadline is not a retention deadline. |
| Schedule constraint and `update_live_session` | Explicit edits accept schedules within 30 days from the edit, including for old retained calls. An unchanged overdue schedule remains valid. |
| `renew_live_session_access_v1(uuid, text, integer)` | Service-role-only, owner/version/active-state checked, row locked. Returns the current version if unexpired; otherwise updates the access anchor/deadline and increments the version once. |
| `enforce_stable_live_admission` | Keeps the code and generation stable. Access renewal preserves the prior admission deadline; explicit admission opening can set a new deadline. |
| `cleanup_expired_live_state()` | Returns zero terminated calls. Expired/revoked grants and invites still expire; orphan speaking-floor state is cleared. Durable session, participant, transcript, and summary records remain. |
| `cleanup_expired_live_glossary_documents()` | Session glossary pins and agenda sections follow explicit archive purge, including terminal calls kept as records. Only old inactive document versions referenced by neither singular nor multiple session pins are removed. |

Apply the migration only after explicit approval, in filename order, before
deploying callers of the new renewal RPC. Existing terminal or soft-deleted
sessions are never automatically revived. The host restoration endpoint uses
an owner-scoped lookup that includes expired active sessions; participant reads,
gateway tokens, viewer grants, and invite redemption retain their expiry checks.
Restoration must happen before editing an expired call, because the existing
event-update wrapper still requires a current access window.

Before an approved deployment, verify in a disposable development database:

1. Seed preparing/live/paused calls older than six hours, including a schedule
   older than 30 days. Cleanup leaves status, title, schedule, session ID, and
   admission code/generation unchanged while expiring grants and invites.
   Run glossary cleanup as well: old agenda sections and referenced document
   versions remain, including documents selected through multiple glossary pins.
2. Renewal by another host, with an old version, for a stopped/failed call, or
   for a soft-deleted archive is rejected. Concurrent renewals with the same
   expired version yield one increment and one conflict.
3. Renewal preserves an expired admission deadline and a paused admission
   state. A subsequent explicit admission-open call with the returned version
   uses the same code and opens the new finite deadline.
4. Editing a retained call keeps an unchanged past schedule; a deliberate new
   date is validated relative to the edit time, not the original creation time.
5. Explicit cancellation still terminates the call, revokes access, and creates
   its archive. Token expiration never becomes an implicit renewal trigger.

Rollback is application-first. Leave the additive anchor, RPC, and persistence
cleanup installed; do not restore an old cleanup function that would suddenly
terminate all retained calls. No destructive down migration or terminal-row
backfill is provided. The existing explicit archive-delete and delayed-purge
workflow remains unchanged.

## Recap requests, six-hour records, and participant demand (2026-08-31)

Apply these local migrations in order **before** deploying their callers. They
have not been applied to a remote database by this task:

1. `202608310002_live_recap_requests_and_record_access.sql`: adds nullable
   `live_participants.records_revoked_at`, private `live_recap_requests`, and
   recording-gap evidence used by source reads and workbook snapshots.
   Existing members have no explicit revocation; existing summary-only consent
   does not become a new request. The explicit recap action records
   `summary_delivery` with notice `summary-original-email-v2`, leaving marketing
   unchanged. One session/member request is durable and repeated clicks do not
   rewrite the original time or silently reaccept a withdrawn consent.
2. `202608310003_live_media_demand_leases.sql`: adds private runtime, viewer
   presence, and host-source generation tables. Existing calls
   have no runtime row and remain on their legacy path. An authenticated host
   start creates the runtime; no migration starts or stops a call.
3. `202608310004_live_media_write_epoch_fences.sql`: adds fenced source/final
   caption RPCs and permits the first authorized preparing-session viewer only
   when a current host source, explicit start intent, and matching pending
   connection exist. Ordinary future scheduled calls remain unauthorized.

The new participant access RPC reads retained membership after live-grant
cleanup. A deleted archive, explicit records revocation, missing actual end,
or server time at/after `ended_at + interval '6 hours'` is rejected. Legacy
authenticated recap SELECT policies use the same deadline. A long-lived
read-only cookie is identity evidence, never an extension of this deadline.
Host-owned archives retain their existing independent retention policy.

`request_live_recap_v1`, `read_live_recap_request_v1`,
`read_owned_live_recap_requests_v1`, and `read_owned_live_record_export_v1`
return camel-case JSON. Access and participant source RPCs return typed table
rows. Export is a STABLE single-statement snapshot, not a combination of HTTP
pages: all participants, authoritative effective source text, stored summary
languages, and explicit requests are included. More than 10,000 participants,
12,000 source rows, 12,000 recording gaps, 10,000 requests, or 14 summary languages fails explicitly;
it never returns a silently truncated workbook input. No provider metadata or
raw internal source fields are exposed by the participant source RPC.
Before JSON aggregation, the database also rejects an estimated export payload
over 12 MiB, including escaped source text and conservative row overhead.
Participant and host `read_*_live_recording_gaps_v1` RPCs return
`{recordingGaps:[{id,startedAt,endedAt,reason}]}` independently of source rows.
An empty transcript can therefore still show known collection gaps, and a
missing gap end remains null instead of being replaced by a guessed time.

**No email is sent by these migrations.** A request is neither verified email
ownership nor a sent/delivered receipt. Sending and the verification required
by a future sender are separate work. Request cancellation is derived from
the current purpose-specific consent, explicit records revocation, or an
address change; archived evidence is preserved.

Demand must remain disabled until all web, Electron, and gateway callers are
deployed together and locally validated. The protocol uses 45-second pending,
connected, host-source, and owner leases; clients renew every 15 seconds or
sooner. Last connected-viewer departure starts a 30-second grace period.
Pending ticket requests do not extend that period. Generations and gateway
owners are fenced at the SQL boundary; released host generations are permanent
tombstones so delayed heartbeats cannot reopen the microphone. A failed media
runtime requires explicit host start/retry. Idle media never changes meeting
status or its actual end. Provider final writes remain allowed during a
bounded drain for the current owner/epoch only.
An actual terminal meeting transition retires its leases and closes open gaps
only when the stored actual end is known; an idle transition never ends a call.

All new tables use RLS and have no direct client/service-role table grants.
Only narrow SECURITY DEFINER RPCs are available to service_role; the sole
authenticated helper derives its identity from `auth.uid()` for RLS. No
client-supplied host/user ID is itself authentication: API callers must obtain
these IDs from verified credentials. Apply migrations before enabling
`LIVE_PARTICIPANT_DEMAND_ENABLED`; disabling that application flag does not
delete stored consent, transcript, or runtime evidence.

Local SQL verification (no linked Supabase target or remote credentials):

```sh
npm install --prefix /tmp/nova-schema-validation --no-audit --no-fund @electric-sql/pglite
NOVA_PGLITE_MODULE=/tmp/nova-schema-validation/node_modules/@electric-sql/pglite/dist/index.js node --test test/live-recap-demand-sql.integration.test.js
```

The optional PGlite harness executes the new SQL against a minimal fixture of
the referenced existing tables and the actual existing consent RPC. It checks
authorization, six-hour boundaries, RLS, request idempotency, export limits,
first-viewer wake, owner/epoch conflicts, stale source heartbeats, and explicit
failure recovery. It is **not** proof of hosted Supabase migration application,
multi-process race timing, Cloud Run scale-to-zero, or mail delivery. The
regular test run still checks closed SQL entrypoints without this optional
local dependency. Roll back callers first and retain additive data; do not
reinstall legacy 30-day participant SELECT policies as a rollback shortcut.

### Canonical participant source snapshots (202608310005)

Apply `202608310005_live_canonical_source_snapshots.sql` after the preceding
recap/demand migrations and before deploying the matching gateway and web
readers. It adds nullable `live_source_utterances.language_observation`; old
rows remain null and no transcript, identity, consent, or language evidence is
backfilled. The v2 writer stores new observations atomically with the existing
source identity and sequence; replay requires identical evidence. The prior
writer stays available for old callers. Both writer generations retain the
existing source ledger, and the new fenced writer requires the current owner.

The participant snapshot RPC reads the same ledger for all language tabs. Live
access requires a valid bound viewer grant plus nonrevoked durable membership;
terminal access uses membership and actual `ended_at + 6 hours`, independent of
expired or cleaned live grants. Speaker labels are neutral, and provider raw
payloads and participant identity snapshots are excluded. A separate bounded,
service-only projection restores language observations on translated-caption
recovery. Neither reader creates a provider connection or changes demand.

Run the optional local PostgreSQL integration with
`NOVA_PGLITE_MODULE=/path/to/pglite/dist/index.js node --test test/live-canonical-source-sql.integration.test.js`.
It exercises real v2 persistence, unchanged replay, conflicting observation,
stale media epoch, private projections, role grants, revocation, and six-hour
expiry; this is not a hosted-database or paid-provider validation. Roll back
application callers first and retain the additive column and rows.

## Authentication 설정

Migrations `202609020002` and `202609020003` make Supabase Auth the identity
provider for hosts. The browser signs in with Google or email/password (PKCE)
and posts the access token to `POST /api/auth/exchange`; the server verifies it
against `GET /auth/v1/user`, upserts `profiles` through
`upsert_profile_on_login_v1`, and issues the existing `rnw_session` cookie only
when `profiles.status = 'approved'`. The cookie subject is `profiles.host_id`,
never the raw auth UUID: emails listed in `ADMIN_BOOTSTRAP_EMAILS` become
approved admins on first login and inherit the first `ADMIN_USER_IDS` entry as
their `host_id`, so their existing `live_sessions` rows stay owned; every other
profile gets `host_id = id::text`. `requireHost` re-reads the status through
`read_profile_by_host_id_v1` behind a 60-second cache, so rejecting or
disabling a profile locks that host out within a minute, and a UUID host id
with no profile row is rejected rather than treated as legacy. The legacy
`ADMIN_USER_IDS` / `ADMIN_PASSWORD_HASH` login keeps working until
`set_legacy_password_login_v1` turns it off from the console.

`profiles` intentionally has **no** `grant select ... to authenticated`. The
`profiles_self_select` policy exists but is inert until a browser-side read is
ever needed; every read today goes through service-role RPCs.

Dashboard steps, performed by the project owner. Never paste client secrets,
API keys, deep-link codes, or `state` values into chat, commits, or this file.

1. Google Cloud Console: create an OAuth 2.0 client (Web application) and add
   the Supabase callback `https://<project-ref>.supabase.co/auth/v1/callback`
   to its authorized redirect URIs.
2. Supabase Dashboard → Authentication → Providers: enable Google and enter
   that client ID and secret.
3. Authentication → URL Configuration: add
   `https://realtime-noel-web.vercel.app/auth/callback` to the redirect
   allowlist and keep email confirmation enabled. Desktop logins return through
   the same page (`?client=desktop&state=...`), which then hands the browser
   off to `nova://auth/callback?code&state`.
4. Vercel: set `ADMIN_BOOTSTRAP_EMAILS` (comma-separated) for Production and
   any Preview environment that should accept those admins.

Deploy order: apply both migrations by hand in filename order → deploy the
webapp with legacy login still enabled → confirm the first Google login of a
bootstrap admin creates an approved `profiles` row → ship the desktop DMG that
registers the `nova` scheme (`electron/main.js` registers it only when
`app.isPackaged` or `NOVA_DEV_DEEP_LINK=1`) → disable legacy login from the
console once stable. Password reset currently lands on `/auth/callback` and
exchanges the recovery session like a login; there is no "set a new password"
screen yet. Rollback is application-first: redeploy the previous webapp and
leave the additive tables in place.

Local SQL verification without a linked project:

```sh
NOVA_PGLITE_MODULE=/path/to/pglite/dist/index.js node --test test/auth-profiles-sql.test.js
```
