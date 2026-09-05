# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

```sh
npm run dev                       # run NOVA from source (./src/nova-cli.js)
npm run desktop                   # run the Electron desktop host (./scripts/start-desktop.js)
npm run typecheck                 # tsc --noEmit
npm test                          # node --test "test/**/*.test.js" - the root suite only
npm run test:all                  # root suite + media-gateway + webapp test:live
node --test test/server-startup.test.js   # run a single test file
node --test --test-name-pattern="warmup" test/whiteboard-session.test.js  # filter by test name
npm run dist:mac                  # electron-builder DMG (also dist:mac:x64, dist:win)
```

### Three test suites, three npm projects

There is no npm workspace: the root, `media-gateway/`, and `webapp/` each have
their own `package.json` and lockfile, so each needs its own `npm ci`.

```sh
npm test                             # root: 1537 tests (1517 pass, 20 skip - PGlite SQL tests need NOVA_PGLITE_MODULE; local-term-retrieval's lookup-budget test flakes only when the three suites run concurrently)
npm --prefix media-gateway test      # 644 tests (bare `node --test`)
npm --prefix webapp run test:live    # 1043 tests (Live Call surface; test:core adds 79)
npm --prefix webapp test             # test:live + test:core - what CI runs
```

The webapp's tests are TypeScript and a bare `node --test` cannot run them: they
need `--experimental-strip-types` plus the extension-adding resolver in
`webapp/lib/security/test-typescript-loader.mjs`. That is why every webapp test
file is enumerated by name inside a `webapp/package.json` script instead of being
globbed - and why `test/webapp-test-coverage.test.js` lives in the **root** suite
and fails if any `*.test.ts` on disk is named by no script - 10 of 21 files once
sat on disk referenced by nothing, so they simply never ran and nothing failed.
Note that `npm run test:all` chains only `test:live`, so `test:core` runs in CI
but not from that shortcut.

There is no separate lint step. CI (`.github/workflows/ci.yml`) runs three
parallel jobs on Node 24 so a red X names the suite that broke: `desktop + CLI`
(`npm ci`, `npm run typecheck`, `npm test`), `media gateway` (`npm ci`,
`npm test`), and `participant webapp` (`npm ci`, `npm run typecheck`,
`npm test`).

The `--no-open` flag suppresses auto-launching the browser, which is useful when iterating from a terminal.

## Product boundary — 2026-09-05

This repository is NOVA only: Captions, Live Call and Settings. Canvas is an
independent Git repository at `../realtime-noel-canvas`; never restore its entry
page, routes, WebSocket handlers or settings to NOVA.

- `npm run dev -- --no-open` / `npm start`: `src/nova-cli.js`, default port 3317.
- `/`, `/index.html`, `/subtitle`, `/subtitle.html`: NOVA captions.
- `npm run desktop`: Electron, retaining its existing application identity.
- `~/.config/nova/settings.json` and `transcripts/`: NOVA only. `nova-config.js`
  imports recognized prior caption settings/records/audio once without deleting
  the original or overwriting existing NOVA data.
- Canvas keeps `~/.config/realtime-noel` and port 3319. Neither repository relies
  on the other's runtime files or node_modules.
- Public assets are explicitly allowlisted; canvas, Coach and Interpreter URLs
  are not served. Do not expose an old surface by widening static middleware.

## Live translation architecture

Three processes, three trust boundaries. None of this shares state with the
whiteboard session model above.

```
desktop dashboard renderer (host mic, 16 kHz mono PCM)
  -> IPC live-call:audio-frame (40ms / 1280-byte frames)
  -> electron/main.js host WebSocket -> media-gateway /live
  -> LiveMediaPipeline (STT / translate / TTS)
  -> gateway fan-out per (sessionId, language) topic
  -> webapp LiveViewer captions + audio
```

In `meeting` sessions the pipeline also mirrors every caption back to the host
socket (`onHostEvent`), because participant Speak audio is invisible to the
desktop's own local engine; `electron/main.js` fans those to all renderers as
`live-call:caption`.

A session carries 1–3 unique canonical languages (`validateEngineForLanguages`
in `packages/caption-core/caption-engine-catalog.js`). On Soniox, 1 language is
a `one_way` stream and 2 is one `two_way` connection; 3 languages use
`SonioxFanoutAdapter` (`media-gateway/src/engines/`): one Soniox connection per
target language, finals aligned by time-range overlap plus normalized text,
dead or recovering lanes skipped (fail-open to the source text), and lane
rollovers staggered 60 s apart so no two connections renew in the same instant.

- **Electron desktop host** (`electron/main.js`, `electron/preload.js`) owns the
  windows and the OS capture permissions. It boots the same `startServer` on
  `127.0.0.1:3210` (falling back to port 0 on `EADDRINUSE`) and loads its pages
  from that local origin: a dashboard (`public/subtitle.html` +
  `subtitle-dashboard.js`, hidden at go-live but never background-throttled
  because it is the only host mic source), a frameless always-on-top controller
  (`subtitle-controller.html`), one click-through overlay window per connected
  display (`subtitle-overlay.html`), and a stage window that loads the *remote*
  `/stage/<id>` page for the QR + countdown. `configureMediaPermissions` grants
  `media`/`display-capture` to the local origin only - deliberately not to the
  remote workspace origin, so an XSS there cannot become a mic tap.
- **`media-gateway/`** is a separate private project
  (`@realtime-noel/media-gateway`, own lockfile, own Dockerfile, Cloud Run).
  `createGatewayServer` in `src/gateway-server.js` accepts exactly one WebSocket
  path, `/live`, for both host and viewer roles, and owns session lifecycle, the
  speaking floor, viewer topics, and per-language caption sequencing.
  `src/live-media-pipeline.js` is the STT/translate/TTS pipeline; the active
  Gemini STT/translation/TTS adapters live in `google-provider-adapters.js`;
  Supabase RPC wrappers live in `supabase-adapters.js`. Deployment and IAM
  constraints are in `media-gateway/README.md` (Korean).
- **`webapp/`** is the Next.js participant app *and* the host-facing REST API the
  desktop main process calls (`/api/login`, `/api/live-sessions`,
  `.../gateway-token`, `/api/live-config` for the gateway URL).
  `components/live/LiveViewer.tsx` is the viewer, `app/stage/[id]/page.tsx` the
  read-only stage. Participants join via `POST /api/live-sessions/join` with
  either a QR invite token or a 6-digit admission code.
- **Supabase** (`supabase/migrations/`, applied by hand in filename order - see
  `supabase/README.md`) holds `live_sessions` (floor state lives on it as the
  `floor_grant_id` / `floor_display_name` / `floor_taken_at` columns),
  `viewer_grants`, `live_utterances`, `live_meeting_summaries`, snapshots, and
  rate limits. Nearly everything goes through `security definer` RPCs rather
  than table writes.
- **Host identity.** Supabase Auth is the identity provider only. The browser
  signs in (Google or email/password, PKCE) and posts the access token to
  `POST /api/auth/exchange`, which verifies it server-side, upserts `profiles`
  via RPC, and issues the existing `rnw_session` cookie only for
  `status = 'approved'`. The cookie subject is `profiles.host_id`, not the auth
  UUID: bootstrap admins (`ADMIN_BOOTSTRAP_EMAILS`) inherit the first
  `ADMIN_USER_IDS` entry, so `host_id` ownership queries never changed.
  `requireHost` (`webapp/lib/auth/live-auth.ts`) re-checks approval through a
  60 s status cache and rejects a UUID host with no profile row;
  `/api/auth/session` reports `role`. The legacy `ADMIN_USER_IDS` password
  login stays until the console switch. Desktop login runs Google in the system
  browser and returns via `nova://auth/callback?code&state`, which
  `electron/main.js` trades for the cookie at `POST /api/auth/desktop-exchange`
  (the scheme is registered only when packaged or `NOVA_DEV_DEEP_LINK=1`).
- **Admin console.** `/console` (`users`, `sessions`, `engine`) is admin-only:
  the guard is `requireAdminFromCookieValue` in the server layout
  (`webapp/app/console/layout.tsx`), not middleware, and every read/write goes
  through service-role RPCs (`set_profile_status_v1`, `set_profile_role_v1`,
  `list_sessions_admin_v1`, ...) - the browser never selects from `profiles`.
  **Engine assignment is per user (decision D1, 2026-09-05).** The default is
  Soniox (recognition + its own translation); Gemini Transcribe Live → Flash is
  the alternative. The assignment lives on `profiles.voice_provider` (+
  `voice_provider_revision`) and only the operator changes it, in
  `/console/users`: `PATCH /api/console/users { voiceProvider }` →
  `set_profile_voice_provider_v2` → `engineSelectionForVoiceProvider` (the one
  provider→engine mapping, shared with `resolveHostEngineAssignment`) → for
  each of that host's `preparing|live` sessions
  (`list_live_session_ids_for_host_admin_v1`)
  `set_live_session_engine_admin_v2` (history <= 8 entries / 3800-byte
  `event_metadata` budget, `reason`, plus the profile's revision pinned as
  `modelPreferences.assignmentRevision`) and gateway
  `POST /internal/sessions/:id/engine` with a 60 s `ADMIN` gateway token; the
  gateway swaps the pipeline (contract C1 kept) and emits `engine-status` to
  the host. So a change applies **immediately** to running sessions and
  persists for future ones: `POST /api/live-sessions` pins the caller's current
  assignment and `assignmentRevision` on the session, and both host readers
  (`electron/main.js` `readLiveCallModelPreferences`,
  `live-audio-client.ts` `readHostModelPreferences`) accept and drop that key.
  Hosts cannot change the engine (server authority, not an error). The
  response is a per-session `switched|queued|failed` table (`queued` = cold
  session, applied on next activation); each change leaves a
  `profile_events` `user_assignment` row plus a best-effort
  `record_console_deploy_v1` row. The global `engine_defaults` deploy is
  retired: `PUT /api/console/engine-defaults` answers 410
  `ENGINE_DEFAULTS_RETIRED` (GET catalog kept), `/console/engine` is an info
  card linking to `/console/users` plus the account section, where
  `set_legacy_password_login_v1` turns the password login into
  `LEGACY_LOGIN_DISABLED` (403) at `/api/login`.

### Two supported HOST connection paths (do NOT tighten one to "fix" the other)

The gateway upgrade (`isAllowedWebSocketUpgrade`,
`media-gateway/src/gateway-security.js`) admits two host lanes, and both are
production paths — `media-gateway/test/gateway-security.test.js` pins this
contract:

1. **Web host (browser)** — the webapp host dashboard connects as HOST from the
   browser. The upgrade carries the webapp `Origin` (must be in
   `LIVE_GATEWAY_ALLOWED_ORIGINS`); browsers cannot set bearer headers, so HOST
   authentication happens post-upgrade via the `authenticate` message.
   `webapp/components/live/live-audio-client.ts` owns capture, proactive token
   refresh, and reconnects. Requiring the desktop-main marker for HOST would
   silently kill this shipped path.
2. **Electron desktop (main process)** — the desktop renderer's origin is
   `http://127.0.0.1:<port>`, which is never allowlisted, so the renderer only
   captures the mic and pushes 1280-byte frames over `live-call:audio-frame`
   IPC while `electron/main.js` holds the HOST socket. A Node client sends no
   `Origin`; that lane requires `LIVE_GATEWAY_ALLOW_TRUSTED_NON_BROWSER`, the
   header `x-realtime-noel-client: desktop-main`, *and* a `Bearer` token that
   verifies to role `HOST`.

Host takeover between the two is last-wins: the gateway closes the losing
socket with code 4410 (`REPLACED`), and warm pipeline reattach requires the
same `activationKey` on both clients.

### Speaking floor contract (`media-gateway/src/gateway-server.js`)

Server-authoritative, at most one holder per session, held in the `floorHolders`
map and mirrored to Supabase through the `take_live_floor` / `release_live_floor`
RPCs (`SupabaseFloorController`).

- A participant's binary frame is forwarded only while
  `floorHolders.get(sessionId).webSocket === webSocket`. Anything else is
  **dropped silently** (`dropped_audio_frames_total`) and the socket stays open -
  frames legitimately race `speak-ended` after a preemption, and closing the
  socket would also kill that viewer's captions.
- HOST binary frames obey the same rule inverted: while **any** participant holds
  the floor, host audio never reaches the pipeline. The host's `host-speak`
  message releases the floor, which is what reopens that gate (and is an
  idempotent ack when nobody holds it).
- A take that displaces someone sends the previous holder
  `{ type: "speak-ended", reason: "preempted" }`.
- `DEFAULT_FLOOR_IDLE_RELEASE_MILLISECONDS` is 8s. A holder's client streams
  every 40ms whether or not anyone is speaking, so an 8s gap means the client is
  gone, not quiet - and since host audio is gated off meanwhile, a dead holder
  would otherwise silence the entire call with no path back.
- Re-tapping Speak as the current holder is idempotent - no take/release round
  trip. The two rate limits differ on purpose: 2s when the take would cut off a
  live speaker, 250ms when the floor is unowned (retaking a free floor
  interrupts nobody).

### Caption `seq` is finals-only (contract C1)

`LiveMediaPipeline` keeps a per-language monotonic counter starting at 1.
Committed captions call `#nextCaptionSeq`, which consumes a number; interim
captions call `#peekCaptionSeq`, which reports the number the coming final will
take **without** consuming it. Both halves of that asymmetry are load-bearing:

- Only finals persist to `live_utterances`, and a fresh pipeline reseeds from
  `max(seq)` over the finals. Letting interims advance the counter **did** make
  that reseed regress below what viewers had already seen, and the viewer's
  `seq <= lastSeq` guard then dropped every later caption - a permanent caption
  blackout after a gateway restart. This is the bug the split exists to fix.
- Symmetrically, `LiveViewer.tsx` runs its strict-greater guard **only** when
  `event.isFinal` (see the comment in `handleEvent`). Applying it to interims
  would raise `lastSeq` to N and then drop the real final at N, blanking the
  feed the same way from the other end.

Change one side and you must change the other. `contract C1` is the searchable
marker on both.

## The root-vs-`public/` frontend duplication trap

`public/` is the only copy that matters, and now the only copy there is.
`src/server.js` serves `PUBLIC_DIR` (`<repo>/public`) and nothing else, and both
ship manifests - npm `files` and electron-builder `build.files` - list
`public/`, never the repo root. The eight root-level
`subtitle-*.{js,css,html}` duplicates that used to sit here are deleted: editing
one changed nothing at runtime while looking like real work, and five were
policed by no test. `test/subtitle-frontend.test.js` now asserts each of those
filenames exists under `public/` and does **not** exist at the repo root, so a
stale duplicate cannot come back.

## Testing conventions

This section covers the **root** suite; `media-gateway/test/` and `webapp/`'s
enumerated TS tests are described under "Three test suites, three npm projects"
above. All three use `node:test`.

Tests use Node's built-in test runner (`node:test`) and live in `test/*.test.js` (flat - no subdirectories, despite the `test/**/*.test.js` glob). They are not bundled into a framework - assertions are `node:assert/strict`, mocks are hand-rolled. Server tests in `test/server-startup.test.js`, `test/staging-mode.test.js`, etc. inject fakes for `generateTextFn`, `streamTextFn`, and `createTranscription` via `startServer({...})` options - prefer this pattern over network-touching tests. There is also a Chrome-driven smoke test (`test/browser-smoke.test.js`) that boots the real server.

The desktop/Live Call tests use a different trick, because `electron/main.js` and
the `public/subtitle-*.js` renderers cannot be imported under `node:test`: they
read the file as **text** and either regex-assert against it
(`assert.match(source, /getLiveCallEnabled/u)`) or slice out one function and
evaluate it with `node:vm` (`sourceBetween(...)` in
`test/desktop-stage-window.test.js`). That is why renaming a function or changing
a CSS class name can break a test that never imported your module - and why these
tests are cheap enough to keep, but do not prove runtime behaviour.

Per the user's global instructions, use **TDD** for bug fixes and new features: write the failing test first.

## Release process

The root package is `nova`. CI runs desktop, gateway and web independently.
Release configuration tracks NOVA only; the old Moonshine release job and
unverified npm publishing have been removed. Generated version history files
are retained. Publishing or deployment requires explicit user instruction.

## Project status (from README)

The project is in **alpha**. The README's prominent warning is intentional - keep the rough-edges framing rather than over-promising stability when editing it.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. The
skill has multi-step workflows, checklists, and quality gates that produce better
results than an ad-hoc answer. When in doubt, invoke the skill. A false positive is
cheaper than a false negative.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke /office-hours
- Strategy, scope, "think bigger", "what should we build" → invoke /plan-ceo-review
- Architecture, "does this design make sense" → invoke /plan-eng-review
- Design system, brand, "how should this look" → invoke /design-consultation
- Design review of a plan → invoke /plan-design-review
- Developer experience of a plan, API/CLI/SDK design → invoke /plan-devex-review
- "Review everything", full review pipeline → invoke /autoplan
- Bugs, errors, "why is this broken", "this doesn't work" → invoke /investigate
- Test the site, find bugs, "does this work" → invoke /qa (or /qa-only for report only)
- Code review, check the diff, pre-landing review → invoke /review
- Visual polish, design audit, "this looks off" → invoke /design-review
- Developer experience audit, try onboarding → invoke /devex-review
- Ship, deploy, push, create a PR → invoke /ship
- Merge + deploy + verify → invoke /land-and-deploy
- Configure deployment → invoke /setup-deploy
- Post-deploy monitoring → invoke /canary
- Update docs after shipping → invoke /document-release
- Weekly retro, "how'd we do" → invoke /retro
- Second opinion, codex review → invoke /codex
- Safety mode, careful mode → invoke /careful or /guard
- Restrict edits to a directory → invoke /freeze or /unfreeze
- Upgrade gstack → invoke /gstack-upgrade
- Save progress or checkpoint → invoke /context-save
- Resume or restore context → invoke /context-restore
- Security audit, OWASP, vulnerabilities → invoke /cso
- Make a PDF, document, publication → invoke /make-pdf
- Launch real browser for QA → invoke /open-gstack-browser
- Import cookies for authenticated testing → invoke /setup-browser-cookies
- Performance regression, page speed, benchmarks → invoke /benchmark
- Review what gstack has learned → invoke /learn
- Tune question sensitivity → invoke /plan-tune
- Code quality dashboard → invoke /health
