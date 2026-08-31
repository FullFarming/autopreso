# Spec: Web Live Call — Web Host Control

Module id: `web-host-control`

## Objective

Promote the existing `LiveHostDashboard` into the supported ADMIN-only Live
Call host. An authenticated administrator can create and configure a session,
publish microphone audio from a browser, start/pause/resume/end the call, see
participant and language status, and return to an active call after refreshing
the page without depending on Electron.

The implementation reuses the existing Live Session REST APIs, signed HOST
gateway token, WebSocket media pipeline, and browser `AudioWorklet` client.
It does not create a second host application or a second source of session
truth.

### User Stories

- As the configured administrator, I can sign in and operate Live Call from a supported browser.
- As the host, I can select the microphone and 1–3 translation languages before starting.
- As the host, I can see whether the gateway and each language pipeline are ready.
- As the host, I return to the same active call after refreshing instead of landing on a new-session screen.
- As the host, I receive one recovery action when browser policy prevents automatic audio resumption.

## Tech Stack

- Next.js 15.3 and React 19 in `webapp/`
- TypeScript 5.8 with strict type checking
- Zod 4 for boundary validation
- Browser Media Capture, Web Audio, and `AudioWorklet`
- Authenticated WebSocket connection to `media-gateway/`
- Supabase-backed Live Session state through the existing store and RPC layer

## Commands

Run from `/Users/kyeongmankim/Realtime/autopreso`.

```sh
npm --prefix webapp run dev
npm --prefix webapp run typecheck
npm --prefix webapp run test:live
npm --prefix webapp test
npm --prefix webapp run build
npm --prefix media-gateway test
```

There is no separate lint script in this project. Type checking, focused tests,
the full webapp suite, and the Next.js build are the required static gates.

## Project Structure

```text
webapp/app/page.tsx
  ADMIN host entry; renders LiveHostDashboard.
webapp/app/(login)/login/page.tsx
  Host login surface.
webapp/app/api/live-sessions/
  Host-owned create/read/update/start/pause/resume/end and gateway-token APIs.
webapp/components/live/LiveHostDashboard.tsx
  Host state machine and visible host surfaces.
webapp/components/live/host-surface.ts
  Pure host-surface routing rules.
webapp/components/live/live-audio-client.ts
  Browser capture, PCM worklet, HOST WebSocket, and reconnect lifecycle.
webapp/lib/auth/live-auth.ts
  Signed host and gateway claims.
webapp/lib/live/service.ts
  Session transitions and optimistic concurrency.
webapp/lib/security/
  Login allowlist, validation, CSRF, rate limit, and secret configuration.
media-gateway/src/gateway-security.js
  Exact browser-origin admission.
media-gateway/src/gateway-server.js
  HOST authentication and media pipeline lifecycle.
webapp/components/live/*.test.ts
media-gateway/test/*.test.js
  Focused unit and integration coverage.
```

No new top-level runtime directory is required.

## Code Style

Follow the existing API envelope, boundary validation, immutable state updates,
and English identifiers with Korean user-facing error messages.

```ts
export async function POST(request: NextRequest) {
  try {
    const { hostId } = await requireHost(request);
    const parsed = hostActionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError("요청 형식이 올바르지 않습니다.", "INVALID_REQUEST", 400);
    }
    const session = await service.resume(hostId, parsed.data.sessionId, parsed.data.version);
    return apiSuccess(session);
  } catch (error: unknown) {
    return toHostActionFailure(error);
  }
}
```

- Do not use `any`; narrow `unknown` at boundaries.
- Use `is`/`has`/`can` prefixes for booleans and verb-first function names.
- Keep external network calls outside database transactions.
- Use optimistic version checks for state transitions.
- Comments explain hidden constraints and invariants, not visible operations.
- UI consumes existing NOVA semantic tokens from `DESIGN.md`; no raw component hex values.
- Preserve the caption-first hierarchy, 44px minimum targets, keyboard focus, and reduced-motion behavior.

## Functional Requirements

### Authentication and authorization

- `/` and every host mutation require the signed host session cookie.
- The production allowlist contains only the approved administrator identifier.
- Credentials remain environment-backed. No password or provider secret is written to source, tests, logs, or documentation.
- Invalid credentials are rate-limited and return the standard API failure envelope.

### Session control

- The host can create, configure, start, pause, resume, and end only sessions it owns.
- Session transitions remain idempotent where the existing service contract is idempotent.
- Concurrent host actions use the existing version guard; stale actions fail with `VERSION_CONFLICT`.
- Starting a session requires a deliberate user action so browser media permission is not requested on page load.

### Browser audio

- Microphone capture is the required host input path.
- System audio is offered only when the browser exposes supported display-audio capture.
- PCM framing and gateway start settings continue to use `live-audio-client.ts`; Electron IPC is not introduced into the web path.
- A lost gateway socket refreshes credentials and reconnects without creating a second Live Session.
- Tracks, worklets, timers, and sockets are closed exactly once when the host ends the call.

### Refresh recovery

- On mount, the dashboard fetches the authenticated host's active sessions.
- The recovery response contains only `id`, `title`, `status`, `scheduledAt`,
  `viewerCount`, and `version`; it includes unexpired owned `preparing`, `live`,
  and `paused` sessions ordered newest first.
- When exactly one session is `live` or `paused`, the matching session UI is restored automatically.
- A `preparing` session is restored without starting microphone capture.
- Refresh always destroys the prior `MediaStream`, `AudioContext`, worklet, and
  WebSocket. “Automatic recovery” therefore guarantees session/UI restoration,
  not survival of those browser resources. Audio reconnection is attempted only
  when browser policy permits; otherwise the session remains active and one clear
  `마이크 다시 연결` user action is shown.
- A stopped or failed session is never revived as an active session.

### Host status and failure recovery

- The host sees gateway connection state and per-language readiness.
- Permission denial, missing system audio, expired gateway credentials, and reconnect exhaustion produce distinct Korean recovery messages.
- Errors do not silently start a new session, rotate the admission code, or end the current session.

## Testing Strategy

### Unit tests

- Host-surface routing for `preparing`, `live`, `paused`, `stopped`, and failed recovery states.
- Audio client cleanup, credential refresh, reconnect deduplication, and stale-socket rejection.
- Login allowlist and exact credential checks without real secrets.

### Integration tests

- Host session create → start → pause → resume → end with version conflicts.
- HOST gateway authentication from an allowed web origin.
- Disallowed origin, viewer token, and non-owner session token are rejected.
- Refresh lookup returns only sessions owned by the authenticated host.

### Manual browser checks

- Latest Chrome and Safari on macOS: microphone permission, start, translation readiness, refresh recovery, and end.
- Chrome: system-audio capture when the operating system exposes an audio track.
- Narrow/mobile viewport: host controls remain reachable, but mobile hosting is not a required production workflow.
- Keyboard-only operation and visible focus rings for every host action.

### Required regression gates

```sh
npm --prefix webapp run typecheck
npm --prefix webapp test
npm --prefix webapp run build
npm --prefix media-gateway test
```

## Boundaries

### Always

- Require host authentication and ownership on every host endpoint.
- Validate user and gateway input at the boundary.
- Preserve exact origin checks and existing API envelopes.
- Keep audio capture client-side and AI/provider secrets server-side.
- Preserve desktop-host behavior while adding or stabilizing the web host.
- Add tests before implementation changes and keep focused suites green.

### Ask first

- Database schema or RPC changes.
- Adding a runtime dependency.
- Changing gateway message contracts shared with Electron.
- Changing production environment variables, allowed origins, or credentials.
- Removing or deprecating the desktop host.

### Never

- Hardcode the administrator password or reuse the exposed password in fixtures.
- Deploy, migrate production data, or change external services without explicit approval.
- Auto-retry forever or hide an exhausted recovery state.
- Start media capture without a browser-permitted user activation.
- End an active call merely because the browser audio connection was interrupted.
- Enable participant speaking in this module.

## Success Criteria

- The configured administrator can complete create → configure → start → translate → pause/resume → end entirely in the webapp.
- A non-allowlisted user cannot obtain a host cookie, host session, or HOST gateway token.
- After refreshing an active call, the same session and participant state are restored; no duplicate session is created.
- If browser policy blocks automatic audio resumption, one user action restores audio without rotating the invite or session ID.
- A gateway disconnect produces at most one active reconnect attempt and does not duplicate host PCM frames.
- Supported browsers show actionable failures for denied microphone permission and unsupported system audio.
- System-audio capture itself is optional; unsupported browser/OS combinations
  satisfy the requirement by reporting an actionable failure while microphone
  hosting continues to work.
- Webapp typecheck, full tests, build, and media-gateway tests pass.

## Out of Scope

- Participant profile fields, admission form changes, and summary consent.
- Direct invitation email/SMS delivery.
- Durable summary generation and summary email delivery.
- Participant microphone or speaking-floor support.
- Desktop host removal or production deployment.

## Open Questions

None for this module. Provider selection and retention policy belong to the
downstream delivery modules.

## Approval

Approved by the user on 2026-08-15.
