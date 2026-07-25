# Handoff — /make-plan prompt

````
/make-plan Redesign the Live Call host flow presentation layer (Settings host sign-in + Live Call draft page + QR stage error states) in the Realtime Noel desktop app. Current design failed a Dieter Rams audit at 16/30 with critical gaps in principles #2 (useful), #4 (understandable), #8 (thorough), #3 (aesthetic).

Verdict paragraph (quoted from the audit):
> Total 16/30 (<20) with load-bearing weaknesses on #2 useful and #4 understandable: the Live Call host flow's presentation layer (auth-setup journey, vocabulary, state feedback, and this surface's token usage) should be redesigned; the underlying architecture (one-button start, silent sign-in, display-only stage) is sound and is explicitly preserved.

Why redesign and not refine: total is below the 20-point threshold and the failures are systemic to this surface (vocabulary, journey, tokens), not isolated patches.

Preserve from current design:
- One-button start → silent host sign-in → QR stage overlay architecture (electron/main.js live-call:start; save-time server verification added 2026-07-23)
- Display-only stage overlay with zero interactive elements (webapp/components/live/LiveStageView.tsx:155-197) and its clamp()-based hero typography (webapp/app/globals.css:839-852)
- Monochrome dark identity, quiet chrome (no modals/toasts on load), aria-live status pattern (public/subtitle.html:421,309)
- The --cw-* token vocabulary (public/subtitle.css:4-17) as the base to re-adopt

Discard:
- The dead-end auth detour: jump-to-Settings with no return/auto-retry (public/subtitle-workspace.js:282-296). Caused failure on #2.
- Mixed vocabulary: "Host Authorization"/"stage"/"workspace"(3 referents)/"controller", EN/KO mixed inside single panels, Korean-only API errors under English UI (subtitle.html:402-421, webapp/app/api/login/route.ts:20-65). Caused failure on #4.
- The untokenized 28-step rgba(255,255,255,α) ladder and the invert/hue-rotate light theme (subtitle.css:2490-2760, 2750-2759). Caused failure on #3.
- Text-only, stateless button feedback and sub-AA small text (.42/.44/.45 alphas; .is-error #A32D2D at 2.95:1; undefined .accent on the primary CTA subtitle.html:308). Caused failure on #8.

Top moves from the audit (verbatim):
1. #2 Useful: after a verified save, return the host to the Live Call page and auto-retry Start (or "Save & Start Live Call"). Evidence: subtitle-workspace.js:282-296.
2. #4 Understandable: one vocabulary, one language per panel; rename Host Authorization → 호스트 로그인/host sign-in; relabel Start Live Call to "Open QR stage" or make it start. Evidence: copy audit §2,5,6.
3. #8 Thorough: pending states on Save/Start; contrast fixes; password reveal; no raw codes. Evidence: a11y audit §1.
4. #3 Aesthetic: define .accent, collapse alpha ladder to ~5 tokens, token-based light theme. Evidence: visual audit gaps 1,2,5.
5. #6 Honest: LiveStageView branches 401 vs other errors (LiveStageView.tsx:59-61,127-134).

Redesign principles in priority order:
1. #2 Useful — a first-run host reaches the QR in one continuous flow, including the sign-in interruption (save returns and retries automatically).
2. #4 Understandable — every label names what it does, in one language per panel, with one name per concept.
3. #8 Thorough — every action has pending/success/error states; all small text ≥4.5:1.

Deliverables for the plan:
- New auth-interruption flow (save → verify → auto-return → auto-retry), low-fi, compared side-by-side to current
- Vocabulary table (concept → single KO + single EN term) applied across subtitle.html, subtitle-workspace.js, LiveStageView.tsx, login route messages
- Token spec: ~5 alpha/ink tokens replacing the raw ladder; .accent definition; light theme via tokens
- States checklist per control (empty, loading, error, success, focus, disabled)
- Migration path: root/public copy sync (subtitle-workspace.js exists twice) and test updates (test/live-ui.test.js asserts current strings)
- Cutover criteria: audit re-run scores ≥24/30 with no principle below 2

Anti-patterns to guard against:
- Porting old copy under new layout (the vocabulary is the redesign)
- Keeping the filter-based light theme "temporarily"
- Redesigning the stage overlay's structure — it scored well; only its error branching changes
- Treating the Preserve list as optional
````
