# Spec: Web Live Call — Attendee Admission

Module id: `attendee-admission`

## Objective

Upgrade the existing participant join flow so a guest can enter a Live Call
from one shared QR/link or a six-digit access code, provide a required email
address plus optional company, department, and job title, and watch translated
captions without any participant microphone or speaking capability.

The email address is a delivery destination and participant identifier only.
It is not verified ownership, a login credential, or proof of identity. QR/link
admission bypasses the six-digit code but never bypasses the profile form,
rate limits, session capacity, expiry, or consent choice.

### User Stories

- As a guest with a QR/link, I can enter my profile and join without typing the code.
- As a guest with a code, I can enter the six digits and the same profile to join.
- As a guest, I provide email and may add company, department, and job title.
- As a guest, I can opt in to receive the finished summary at that email address.
- As a guest, I can only read translations; the site never requests my microphone.
- As a host, I can identify admitted attendees while other attendees see only masked email labels.

## Tech Stack

- Next.js 15.3 and React 19 in `webapp/`
- TypeScript 5.8 with strict type checking
- Zod 4 boundary validation
- Supabase Postgres, RLS, and existing atomic admission RPCs
- Signed viewer-grant cookie and VIEWER WebSocket token
- Existing `LiveViewer` responsive desktop/mobile viewer surface

## Commands

Run from `/Users/kyeongmankim/Realtime/autopreso`.

```sh
npm --prefix webapp run typecheck
npm --prefix webapp run test:live
npm --prefix webapp test
npm --prefix webapp run build
npm --prefix media-gateway test
npm test
```

There is no separate lint script. Type checking, focused/full tests, build, and
gateway tests are the required automated gates.

## Project Structure

```text
webapp/components/live/LiveViewer.tsx
  Participant profile form, QR/code branch, caption-only viewer, and reconnect.
webapp/lib/live-contract.ts
  Participant identity and join response contracts.
webapp/lib/security/live-input-validation.ts
  Email and optional profile validation and normalization.
webapp/lib/security/live-admission-store.ts
  Atomic invite/code redemption and participant profile mapping.
webapp/app/api/live-sessions/join/route.ts
  Rate-limited join boundary and signed viewer grant.
webapp/app/api/live-sessions/[id]/participants/route.ts
  Host-owned roster projection.
webapp/lib/auth/live-auth.ts
  Viewer cookie and gateway claim issuance.
media-gateway/src/gateway-server.js
media-gateway/src/gateway-security.js
  VIEWER subscribe-only enforcement; participant audio/floor commands denied.
supabase/migrations/
  Additive participant profile and summary-consent migration/RPC update.
supabase/bootstrap-new-project.sql
  New-project schema kept equivalent to the migration chain.
```

No new top-level runtime directory or second admission service is required.

## Data Model

The migration is additive and preserves existing participant rows.

| Entity | Field | Rule |
|---|---|---|
| `live_participants` | `email` | Nullable for legacy rows; required for every new admission after rollout, max 254 characters. |
| `live_participants` | `company` | Nullable, NFC-normalized, max 100 characters. |
| `live_participants` | `summary_consent_at` | Nullable timestamp; set only by an explicit checked consent control. |
| `live_participants` | `display_name` | Retained for compatibility; new admissions store a server-derived masked email label rather than a separate name. |

- `department` and `job_title` remain nullable and optional.
- Email is trimmed and validated server-side. The canonical delivery value is
  stored lowercase for deterministic deduplication; UI never treats it as an
  authenticated identity.
- `display_name` is derived server-side (for example `n***@example.com`) so
  clients cannot submit a misleading public label.
- Existing rows are not backfilled with invented email values. No column is
  dropped in this module.
- The admission RPC writes the viewer grant, participant row, attendance event,
  and viewer count atomically. Email delivery is never performed inside that
  transaction.
- Existing personal-data cleanup must delete the new email, company, and consent
  data on the same retention schedule as `live_participants`.

## Functional Requirements

### QR/link and code admission

- The existing opaque invite token in the URL hash remains the QR/link credential.
- A valid invite token means the six-digit field is not shown or submitted.
- Without a valid invite token, exactly one six-digit code is required.
- Both branches require the same email/profile validation, anonymous Supabase
  access token, stable device identifier, rate limits, capacity checks, active
  admission window, and expiry checks.
- Invalid, expired, ended, full, or rate-limited sessions return stable Korean
  API errors without revealing whether a guessed email has joined before.
- Repeated redemption for the same anonymous user/device/session is idempotent
  and does not increment viewer count twice.

### Participant profile

- Required: email.
- Optional: company, department, job title.
- Removed: separate participant name input for new admissions.
- Email uses `type="email"`, `autocomplete="email"`, and a 254-character limit.
- Canonical email atoms support ASCII letters/digits, Latin `U+00C0–U+02AF`,
  combining marks `U+0300–U+036F`, and Korean Jamo/compatibility
  Jamo/syllables (`U+1100–U+11FF`, `U+3130–U+318F`, `U+AC00–U+D7A3`).
  The local part additionally allows RFC-style ``.!#$%&'*+/=?^_`{|}~-``
  symbols; domain labels additionally allow only `-`. Cyrillic, CJK, Indic,
  emoji, controls, and characters outside those explicit ranges are rejected.
  Email and label limits count Unicode code points consistently in TypeScript
  and PostgreSQL, not UTF-16 code units or UTF-8 bytes.
- Company uses `autocomplete="organization"`; department and job title remain
  plain optional profile fields with their existing bounds.
- Values are NFC-normalized, trimmed, stripped of control characters, and
  rejected when they contain unsafe markup delimiters after normalization.
- The participant sees their own full email. Host-owned roster APIs may return
  the full email. Participant-facing captions, overlays, presence, stage avatars,
  and any shared roster expose only the server-derived masked label.

### Summary consent

- The join form contains an unchecked checkbox: “완성된 요약을 이 이메일로 받겠습니다.”
- Consent is optional and never bundled into required terms or inferred from join.
- The API accepts a strict boolean and stores `summary_consent_at` only when true.
- Joining succeeds when consent is false.
- This module records consent only. It does not send mail or promise delivery;
  `summary-delivery` later reads the stored email and consent timestamp.
- A downstream delivery job must ignore legacy rows, missing emails, and null consent.

### Translation-only participant

- The participant join screen and viewer never render Speak, floor-request,
  microphone-selection, mute, or audio-capture controls.
- No participant path calls `getUserMedia`, creates a participant audio worklet,
  or sends PCM/audio/floor-control messages.
- VIEWER WebSocket claims can subscribe to captions/snapshots and receive status
  only. The gateway rejects all participant audio chunks and speaking-floor
  commands even if a client constructs them manually.
- Host microphone publishing and desktop-host behavior remain unchanged.
- Translated speech playback remains out of scope; participant output is captions only.

### Refresh and reconnect

- A valid viewer grant restores the same attendee record after refresh without
  requesting the profile again while the grant and session remain active.
- Foreground/network reconnect creates no second participant row and preserves
  the selected caption language.
- An expired/invalid grant returns to the admission screen without retaining a
  stale full email in visible UI state.

## API Contract

The join request becomes:

```ts
type JoinLiveSessionInput = {
  inviteToken?: string;
  admissionCode?: string;
  email: string;
  company?: string;
  department?: string;
  jobTitle?: string;
  summaryConsent: boolean;
  deviceId: string;
  accessToken: string;
};
```

Exactly one of `inviteToken` and `admissionCode` is required. The successful
response keeps the existing `{ ok: true, data }` envelope and adds the admitted
participant's own email/company/consent fields. Participant-facing events carry
only `displayName` as the masked compatibility label.

## UI and Accessibility

- Keep the existing NOVA join card and responsive `/watch` and `/m/watch` flow;
  both surfaces call the same endpoint.
- Field order: email, company (optional), department (optional), job title
  (optional), six-digit code when needed, summary-email consent, Join.
- QR copy states that the code is already applied; code entry copy states that
  email is not account verification.
- Every field has a stable `id`, `name`, matching label, useful autocomplete,
  inline Korean validation, and an error summary announced with `role="alert"`.
- The consent control is keyboard operable, has a visible 2px focus ring, and
  uses a 44px minimum touch target without making the checkbox itself ambiguous.
- No microphone note or permission prompt appears anywhere in the participant flow.
- UI styling uses the existing NOVA design tokens and reduced-motion behavior;
  no new raw colors, fonts, gradients, or emoji are introduced.

## Testing Strategy

### Unit tests

- Valid/invalid email boundaries, NFC normalization, control characters, markup,
  blank optionals, 4-byte Unicode, and maximum lengths.
- Mask derivation for short local parts, plus-addresses, Unicode, and malformed input.
- QR/token branch excludes code; code branch requires exactly six digits.
- Consent false remains null; true records a timestamp.
- Viewer surface contains no participant microphone/speaking action.

### Integration tests

- Invite join and code join atomically create one participant with required email.
- Duplicate submit/reconnect is idempotent and capacity count increments once.
- Invalid/expired invite, wrong code, closed admission, full session, and rate
  limit fail with stable envelopes.
- Existing participant rows without email remain readable after migration.
- Host owner can read the delivery email; non-owner and participant roster reads
  cannot obtain another attendee's full email.
- VIEWER gateway token can subscribe but cannot send audio or acquire the floor.
- Personal-data cleanup removes email/company/consent with the participant row.

### Manual browser checks

- Latest Chrome and Safari on desktop plus iPhone-sized viewport.
- QR join and code join, validation errors, optional fields, consent on/off,
  refresh recovery, language switching, and leave/rejoin.
- Browser permission panel confirms no microphone request from participant pages.
- Keyboard-only form completion, visible focus, screen-reader labels, and 200% zoom.

## Boundaries

### Always

- Treat email as unverified delivery data, not authentication.
- Validate and normalize on both client and server; trust only the server result.
- Preserve atomic admission, ownership filters, rate limits, exact origin checks,
  signed cookies, API envelopes, and existing retention cleanup.
- Mask email before any participant-visible broadcast or shared presence data.
- Deny participant media at both UI and gateway boundaries.
- Add migration defaults/legacy handling and tests before implementation.

### Ask first

- Running the database migration in any shared or production environment.
- Adding an email-verification flow, legal terms, or a required consent.
- Changing retention duration or exposing full attendee emails beyond the host.
- Adding runtime dependencies or changing shared gateway message contracts.

### Never

- Store an email as a password, verified identity, or authorization factor.
- Put a full attendee email into captions, WebSocket broadcasts, logs, URLs, QR
  payloads, analytics, stage displays, or participant-visible rosters.
- Enable participant microphone capture, Speak/floor actions, or translated audio.
- Send invitation or summary email from an admission transaction.
- Drop legacy columns or deploy/migrate without explicit approval.

## Success Criteria

- A guest joins with QR/link + required email/profile without entering a code.
- A guest joins with six-digit code + required email/profile without a QR link.
- Company, department, and job title can all be omitted.
- Summary consent defaults off and is recorded exactly when checked.
- Refresh/reconnect restores one participant record and selected caption language.
- No participant browser microphone permission is requested, and forged VIEWER
  audio/floor messages are rejected by the gateway.
- Other attendees see only masked labels; host-only delivery data remains protected.
- Legacy participant data remains valid and automated gates pass.

## Out of Scope

- Sending invitations by email/SMS/Kakao or recording delivery status.
- Durable summary generation/retry and actual summary email delivery.
- Email ownership verification, attendee accounts, SSO, or password login.
- Participant speaking, microphone, floor control, or translated audio playback.
- Desktop host removal, production migration, or deployment.

## Open Questions

None. The previously approved decisions are fixed here: email is required but
unverified, QR bypasses only the code, company/department/job title are optional,
summary delivery is opt-in, and participants are caption-only.

## Approval

Approved by the user on 2026-08-15.
