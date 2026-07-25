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
5. admission, invite, 50-viewer concurrency, duplicate join, revoke, expiry,
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
   only explicit stop or session expiry closes the admission lifetime.
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
