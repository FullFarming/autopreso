# Capability Map: Web Live Call

## Objective

Move Live Call hosting into the existing Next.js web application while keeping
the current media gateway and participant viewer. The desktop host remains
available during the web-host stabilization period.

| Module id | Responsibility | Depends on |
|---|---|---|
| `web-host-control` | ADMIN-only browser host, browser audio publishing, session controls, and active-session recovery | Existing Live Session and media gateway contracts |
| `attendee-admission` | QR/code admission, required email, optional company/department/job title, summary consent, and participant-microphone denial | Existing viewer grants |
| `durable-summary` | Durable post-session jobs, single-winner generation, bounded retries, status, and persisted results | Existing transcript and summary storage |
| `invite-delivery` | Link/code share text, QR, direct email/SMS invitation delivery, and delivery status | `web-host-control`, `attendee-admission` |
| `summary-delivery` | Idempotent email delivery to the host and opted-in attendees | `attendee-admission`, `durable-summary` |
| `translation-first-ui` | Translation-first information architecture, shared UI primitives, responsive host/viewer/stage composition, and WCAG AA presentation | `web-host-control`, `attendee-admission` |

## Build Order

1. Build `web-host-control`, `attendee-admission`, and `durable-summary` as independent foundations.
2. Build `translation-first-ui` after the host and attendee contracts are stable; it replaces the broad host/viewer layout work rather than competing with those modules for the same component files.
3. Build `invite-delivery` after the host and admission contracts are stable.
4. Build `summary-delivery` after attendee consent and durable summary completion are stable.

## Initiative Boundaries

- Keep the existing Next.js `webapp`, Supabase storage, and `media-gateway` architecture.
- Keep the desktop Live Call host during stabilization; do not remove it in this initiative.
- Do not enable participant speaking, participant microphone capture, or translated speech playback.
- Treat translated captions as the primary content on participant, live-host, and live-stage surfaces; secondary controls collapse without hiding critical status or recovery actions.
- Do not hardcode administrator credentials or provider secrets.
- Production migration and deployment remain separately approval-gated.

## Approval

Approved by the user on 2026-08-15. The `translation-first-ui` addition and its
dependency on `web-host-control` and `attendee-admission` were approved for
joint execution on the same date.
