# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

```sh
npm run dev                       # run the CLI from source (./src/cli.js)
npm run desktop                   # run the Electron desktop host (./scripts/start-desktop.js)
npm run typecheck                 # tsc --noEmit
npm test                          # node --test "test/**/*.test.js" - the root suite only
npm run test:all                  # root suite + media-gateway + webapp test:live
node --test test/server-startup.test.js   # run a single test file
node --test --test-name-pattern="warmup" test/whiteboard-session.test.js  # filter by test name
npm run build:moonshine-sidecars  # build Python -> single-binary sidecars for macOS arm64+x64
node ./scripts/build-moonshine-sidecars.js darwin-arm64   # build only one target
npm run dist:mac                  # electron-builder DMG (also dist:mac:x64, dist:win)
```

### Three test suites, three npm projects

There is no npm workspace: the root, `media-gateway/`, and `webapp/` each have
their own `package.json` and lockfile, so each needs its own `npm ci`.

```sh
npm test                             # root: 739 tests (738 pass, 1 skip)
npm --prefix media-gateway test      # 250 tests (bare `node --test`)
npm --prefix webapp run test:live    # 104 tests (Live Call surface)
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

## Product surfaces

Two products share this repo, one Express server, and one settings file. Most
current work is on the first; the `## Architecture` section and all of its
subsections describe the second.

- **Live translation subtitles** - live captions translated across the 14
  language codes in `LIVE_TRANSLATION_LANGUAGES` (`media-gateway/src/config.js`,
  mirrored by `SUBTITLE_LANGUAGES` in `src/subtitle-languages.js`), 1-3 per
  session. It has two independent delivery paths: a **local** one where the
  Electron desktop host translates its own audio in-process
  (`src/subtitle-realtime.js` talking straight to Gemini Live / OpenAI Realtime)
  and paints overlay windows, and **Live Call**, where a separate WebSocket
  gateway (`media-gateway/`) runs the pipeline and a Next.js app (`webapp/`)
  shows captions to remote participants. See "Live translation architecture"
  below. Persistent Live Call state is in Supabase (`supabase/migrations/`).
- **Whiteboard agent CLI** - the original product, still real. `npm run dev`
  boots it and opens `/`, which serves `public/index.html` + `public/app.js`
  (Excalidraw); an LLM agent edits the scene through tool calls.

Both are served by the same `startServer` in `src/server.js`. The CLI opens `/`
(whiteboard); the Electron app loads `/subtitle.html` (subtitles) and passes a
no-op `createTranscription`. They share no session model and no pipeline - a
change to one is very unlikely to be the fix for the other.

## Architecture

This section describes the **whiteboard** product: a single Node process that serves a static Excalidraw frontend, runs an STT pipeline, and orchestrates an LLM agent that edits the whiteboard via tool calls. The end-to-end loop is:

```
browser mic -> WS audio frames -> transcription provider -> turn queue ->
runWhiteboardAgent (in src/server.js) -> tool call ops -> apply to scene ->
broadcast whiteboard:update over WS -> frontend re-renders Excalidraw
```

### Entry points and wiring

- `src/cli.js` parses args, loads `~/.config/realtime-noel/settings.json` via `settings-store.js`, resolves an agent provider, then calls `startServer`.
- `src/server.js` is the central hub. It owns the Express + WebSocket server, mounts the static frontend in `public/`, instantiates a `WhiteboardSession`, builds a `TranscriptionManager`, and exposes `runWhiteboardAgent` / `runWhiteboardWarmupOnce` which contain the system prompt and the AI SDK `tool({...})` definitions. `server.js` is large (~1700 LOC) on purpose - keep the agent prompt, message construction, and tool schemas colocated. It also carries the subtitle product's HTTP surface (`/api/subtitles/*`, `/api/subtitle-languages`, `/api/glossary-presets`) and wires up `createSubtitleRealtimeManager`, so not everything in this file is whiteboard code.
- `public/app.js` is the React frontend. It renders Excalidraw, handles mic capture at 24 kHz, sends audio frames over WS, periodically pushes downscaled screenshots back to the server (`whiteboard:screenshot`), and reflects server-pushed scene updates back into Excalidraw. Frontend is plain ES modules loaded via `<script type="importmap">` from esm.sh - no build step.
- `src/session-cost.js` tracks per-session agent token usage and transcription audio seconds. `server.js` records agent usage after warmup/turn calls, records transcription audio as frames arrive, broadcasts `cost` over WS, and resets the tracker on Start Realtime_Noel and session reset.

### Two-mode session model (`src/whiteboard-session.js`)

The session has two modes that are NOT symmetric:

- **`staging`** - client-side scratchpad. The server does not track elements in this mode; the frontend owns them. Used to seed the canvas with reference content before going live.
- **`live`** - the server owns `state.elements` as the source of truth. Audio, screenshots, and user edits all flow into the server, which applies agent edits and broadcasts updates.

Transitions: `POST /api/preso/start` builds a "staging primer" message (current scene snapshot + downscaled screenshot when staging is non-empty), extracts staging text/labels as transcription keywords, snapshots saved Agent instructions for the whole preso, resets session cost, and kicks off the warmup loop. `POST /api/preso/back-to-staging` returns to client-owned mode and clears the transcription keywords; `POST /api/session/reset` also clears them and resets session cost.

Audio messages carry a browser-generated `sessionId`. `stop`, reset, back-to-staging, and Start Realtime_Noel invalidate the current session token so late audio frames, queued turns, stale tool executions, and post-turn history appends cannot mutate the next session; cost still records usage already incurred.

### Warmup loop

Before the user speaks, `startWarmupLoop` repeatedly fires the agent against the staging primer and the Agent instructions snapshot with exponential backoff (`DEFAULT_WARMUP_DELAYS`, max 8 attempts). Its purpose is **prompt cache priming**: after the loop ends, `agentHistory` is forced to `[warmup_user_msg, assistant("UNDERSTOOD")]` so every subsequent turn reuses the same prefix bytes. Do not change this primer-then-fixed-history pattern or the per-preso instructions snapshot without understanding the cache implications.

### Transcript turn queue (`src/transcript-turn-queue.js`)

Transcript chunks are gated by an `isReady` predicate, but the live session sets queue debounce to `0` because turn boundaries are decided upstream. OpenAI Realtime uses `src/openai-transcription.js` delta-quiet flushing instead of `transcription.completed` events, while Moonshine emits per-chunk commits. While a turn is running, additional chunks are buffered and concatenated for the next turn. This means the agent never has more than one in-flight turn, but it always sees the most recent burst of speech in one shot. `isTrivialTranscript` in `whiteboard-session.js` filters out filler-only chunks ("uh", "okay", etc.) so they don't trigger turns on their own.

### Whiteboard edit model (`src/whiteboard-tools.js`)

The agent does not see Excalidraw JSON directly; it sees a **line-numbered text view** of the scene (`formatLineNumberedWhiteboard`) and emits `replace`, `insert_after`, or `delete` operations against line numbers. `applyWhiteboardEditOperations` validates and applies them in order. When changing the agent's contract, update both the tool schema in `server.js` and this applier, and add a test in `test/whiteboard-tools.test.js`.

### Agent providers (`src/agent-provider.js`, `src/codex-auth.js`)

Three providers, all routed through the `@ai-sdk/openai` adapter:

- **openai** - direct API key, with configurable OpenAI-compatible API base URL.
- **codex** - reads the user's Codex CLI auth from `~/.codex/auth.json`, then talks to the ChatGPT backend with that bearer token. No API key needed.
- **ollama** - OpenAI-compatible local endpoint (`http://localhost:11434/v1`).

`reasoningEffort` is validated against the set `{none, low, medium, high, xhigh}`.

### Transcription providers

- **Moonshine (default, local)** - `src/moonshine-transcription.js` spawns the platform-specific binary at `@realtime-noel/moonshine-<platform>/bin/realtime-noel-moonshine` (declared as **optional** dependencies; the install just skips on unsupported platforms). The binary is built from `scripts/moonshine-sidecar.py` via PyInstaller; only macOS arm64/x64 are currently packaged.
- **OpenAI Realtime** - `src/openai-transcription.js` opens a WSS connection to `wss://api.openai.com/v1/realtime?intent=transcription` and streams PCM frames.

The active provider is hot-swappable: `applyCurrent()` in `server.js`'s `createTranscriptionManager` rebuilds the underlying instance whenever settings change, without restarting the server. Any active session context is reapplied to the new provider.

### Settings store (`src/settings-store.js`)

Persists to `~/.config/realtime-noel/settings.json`, including `agentInstructions` validated at 100,000 characters. The store has a `getSanitized()` method that strips API keys before sending to the frontend - always use that for outbound payloads. Env vars (`OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OLLAMA_*`, `CODEX_*`) only **seed** the file on first run; once it exists, the file wins and env vars are ignored.

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

`public/` is the only copy that matters. `src/server.js` serves `PUBLIC_DIR`
(`<repo>/public`) and nothing else, and both ship manifests - npm `files` and
electron-builder `build.files` in `package.json` - list `public/`, never the repo
root.

There are nevertheless eight root-level `subtitle-*.{js,css,html}` files that are
currently byte-identical duplicates of their `public/` counterparts, reached by no
server route and no ship manifest. Only three are protected by a root-vs-`public`
byte-equality assertion:

| root copy | guard |
| --- | --- |
| `subtitle-dashboard.js` | `test/desktop-stage-window.test.js` and `test/session-transcripts.test.js` |
| `subtitle.html` | `test/session-transcripts.test.js` |
| `subtitle.css` | `test/session-transcripts.test.js` |
| `subtitle-controller.{js,html}`, `subtitle-workspace.js`, `subtitle-overlay.js`, `subtitle-audio-player.js` | **none** |

Every other test reads the `public/` copy (`read("public/subtitle-controller.js")`
and friends in `test/live-ui.test.js`, `test/desktop-live-start.test.js`, ...).

Practical consequence: **edit `public/`**. If you edit a root copy, mirror it to
`public/` or the change does nothing at runtime - and for five of the eight files
nothing will fail to tell you.

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

## Whiteboard agent system prompt

The system prompt and tool schemas are defined inline in `src/server.js` (search for `buildWhiteboardAgentMessages` and the `tool({...})` calls). Its structure is `P1-P10` cross-cutting principles + short per-genre stubs. Do **not** append verbose "When the talk is X..." paragraphs - that bloat was already consolidated once. See `scripts/simulate-whiteboard-agent.md` for the full editing rubric and the `simulate-whiteboard-agent.js` harness used for prompt A/B experiments.

## Release process

This repo uses **release-please** in **monorepo manifest mode** (`.github/workflows/release-please.yml`, `release-please-config.json`, `.release-please-manifest.json`).

Only two components are tracked. `media-gateway/` and `webapp/` are `private: true`
and are **not** release-please packages - they are deployed (Cloud Run / Vercel),
not published, so a commit touching only those paths still bumps `realtime-noel`
via the root component.

Two components version independently:

- **`realtime-noel`** (root, `.`) - the CLI npm package. Bumps on any conventional commit _except_ those touching the sidecar paths (`packages/moonshine-darwin-*`, `moonshine-sidecar.config.json`, `scripts/moonshine-sidecar.py`, `scripts/build-moonshine-sidecars.js`).
- **`moonshine-sidecars`** (`packages/moonshine-darwin-arm64`) - the platform sidecar npm packages. Bumps **only** when commits touch the sidecar paths above. The arm64 package is the release-please anchor; its version is mirrored into `packages/moonshine-darwin-x64/package.json` and into both `optionalDependencies` entries in the root `package.json` via `extra-files`. The two sidecar packages always share one version.

Workflow consequences:

- A typical change to `src/`, `public/`, or `test/` only bumps realtime-noel. The publish job for the sidecar group is skipped, so CI never runs the Python/PyInstaller build path on a regular release.
- A change to `moonshine-sidecar.config.json` (e.g. bumping `moonshineVoiceVersion`) bumps the sidecars. CI will then build the Python sidecar binaries on `macos-15` (required by recent `moonshine-voice` wheels, which target `macosx_15_0_universal2`) and publish both `@realtime-noel/moonshine-darwin-{arm64,x64}` packages.
- A commit that touches both kinds of paths bumps both components in a single release-please PR.

Other notes:

- `CHANGELOG.md` and `.release-please-manifest.json` are auto-generated. Per global rules, never hand-edit them.
- Sidecar binaries are produced by `scripts/build-moonshine-sidecars.js` and must be built on macOS (the script enforces this).
- `scripts/prepare-release-packages.js` is now a verification step: it confirms each sidecar's `package.json` version matches the root `optionalDependencies` entry and that the binary exists. Version writing is owned by release-please's `extra-files`, not this script.
- The published-on-npm sidecar version may lag realtime-noel; that's by design (pinning the same binary keeps users from re-downloading on every CLI patch).

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
