# Design-Is Audit Scope — 2026-07-23

## Audited surface
Live Call host flow in the Realtime Noel desktop app + web stage:

1. **Settings → Live Call Host Authorization** section — `public/subtitle.html` (`#live-host-login-section`), `public/subtitle-workspace.js` (save/verify handlers), `public/subtitle.css`
2. **Live Call draft page** (title/date/capacity/cover/languages + Start Live Call) — same files
3. **QR stage overlay** — `webapp/components/live/LiveStageView.tsx`, `webapp/app/stage/**`, opened by `electron/main.js` `openLiveStageOverlay`

## Primary user & task
The host (a presenter, often non-technical, Korean-speaking) wants to press **Start Live Call** and get a QR + 6-digit access code on screen with zero intermediate steps.

## Constraints
- Desktop Electron app, no build step for `public/` (plain ES modules); webapp is Next.js 15
- Monochrome light/dark theme already established
- Mixed EN/KO copy exists today
- Static audit: no running desktop instance — visual evidence is INFERRED from source/CSS

## Known context
- 2026-07-23: host-auth loop fixed (server 401 now `HOST_LOGIN_REJECTED`; save now verifies against the workspace)
- Password policy relaxed to 5+ chars with rate limiting retained
