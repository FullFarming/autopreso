# Verdict — REDESIGN (scoped)

Total 16/30 (<20) with load-bearing weaknesses on #2 useful and #4 understandable: the Live Call host flow's **presentation layer** (auth-setup journey, vocabulary, state feedback, and this surface's token usage) should be redesigned; the underlying architecture (one-button start, silent sign-in, display-only stage) is sound and is explicitly preserved.

Scope note: this is NOT an app-wide redesign. The stage overlay's structure scored well (unobtrusive, minimal); the failures concentrate in the Settings/draft surface and cross-surface language.

## Highest-leverage moves

1. **#2 Useful — close the auth detour loop.** After a verified save, return the host to the Live Call page and auto-retry Start (or make the CTA "Save & Start Live Call"). Evidence: `subtitle-workspace.js:282-296` navigates to Settings but nothing navigates back or retries.
2. **#4 Understandable — one vocabulary, one language per panel.** Rename "Host Authorization" → host sign-in ("호스트 로그인"); stop using "workspace" for three referents; define or remove "controller"; relabel "Start Live Call" to what it does ("QR 무대 열기 / Open QR stage") or make it actually start. Decide KO-first vs EN-first per surface and align the login API messages. Evidence: copy audit §2, §5, §6.
3. **#8 Thorough — states and contrast.** Pending state on Save/Start buttons; raise sub-AA alphas (.42/.44/.45 → ≥.62 for small text); fix `.is-error` #A32D2D (2.95:1); declare placeholder color; add password reveal; never print raw codes (`js:300,352`). Evidence: a11y §1, visual §states.
4. **#3 Aesthetic — reinstate the token system on this surface.** Define the missing `.accent` rule (primary CTA currently unstyled), collapse the 28-step alpha ladder to ~5 named tokens, replace the invert/hue-rotate light theme with token swaps. Evidence: visual §gaps 1, 2, 5.
5. **#6 Honest — truthful stage errors.** `LiveStageView` must branch 401 vs other failures instead of showing "Host authorization is required" for every error, and label the error `<main>`. Evidence: `LiveStageView.tsx:59-61, 127-134, 156`.
