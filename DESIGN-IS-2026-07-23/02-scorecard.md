# Scorecard — Live Call host flow (Settings host-auth + draft page + QR stage)

1. Good design is innovative — Score: 2/3
   Evidence: one-button desktop → silent host sign-in → QR stage overlay (01-evidence §1, §Copy).
   Justification: a clear refresh of "create meeting → share link" (QR stage + countdown overlay), but not a wholly new pattern — not a 3; more than imitation — not a 1.

2. Good design makes a product useful — Score: 1/3
   Evidence: happy path is 2 actions, but the auth detour requires manually navigating back to Live Call and re-pressing Start after save (`subtitle-workspace.js:282-296`; structural §5 steps 5a-5e); "Start Live Call" doesn't start the call (Go-Live elsewhere).
   Justification: the recovery path is an unnecessary detour the design itself created (auto-retry after verified save is trivially possible) — worst instance scores 1, not the happy-path 2.

3. Good design is aesthetic — Score: 1/3
   Evidence: undefined `.accent` on the primary CTA; ~28-step raw alpha ladder bypassing the `--cw-*` tokens; 16 spacing steps incl. off-grid; 0.5px type increments; filter-based light theme needing rescue rules (visual §gaps 1,2,5,7).
   Justification: more than five system violations incl. one jarring (primary CTA style silently absent) — 1, but a visible monochrome direction exists so not 0.

4. Good design makes a product understandable — Score: 1/3
   Evidence: "Host Authorization" (=sign-in), "stage", "workspace" (3 referents), "controller" undefined; Start button label overpromises; EN/KO mixed within single panels; API errors Korean-only under English UI (copy §2,5,6).
   Justification: 2–3+ primary controls/labels unclear with jargon present — 1; the primary action is still identifiable, so not 0.

5. Good design is unobtrusive — Score: 2/3
   Evidence: 0 modals/toasts on load, quiet chips, display-only stage (weight §; structural §1); but the "Share these captions with guests" handoff panel adds promotional framing beside the CTA (`subtitle.html:295-309`).
   Justification: chrome visible but quiet — 2; the handoff panel keeps it from "chrome recedes entirely".

6. Good design is honest — Score: 2/3
   Evidence: "They remain on this device." omits the verification round-trip (`subtitle.html:403`); stage renders auth-required for ANY load failure (`LiveStageView.tsx:59-61,127-130`); no dark patterns.
   Justification: one incomplete claim plus one misleading-by-bug error message — 2; no deception or dark pattern, so not lower.

7. Good design is long-lasting — Score: 2/3
   Evidence: restrained monochrome, clamp()-based stage type (visual §2); fragile invert/hue-rotate light theme (`subtitle.css:2750`).
   Justification: visual language ages well but one structural fragility (filter theme) will not survive palette evolution — 2.

8. Good design is thorough down to the last detail — Score: 1/3
   Evidence: no loading/pending state on Save/Start (visual §states); five sub-AA text pairs incl. an error status at 2.95:1 (a11y §1); no password reveal; raw machine codes leak in fallbacks (`js:300,352`); inconsistent main aria-label on stage error.
   Justification: multiple missing/rough states and detail-level failures — 1, not a single rough edge.

9. Good design is environmentally friendly — Score: 2/3
   Evidence: ~130 KB local JS (>100 KB), 0 idle animations on workspace, reduced-motion honored, dark default, modest 5s/1s stage timers (weight §).
   Justification: over the 100 KB anchor for 3 but comfortably within "motion gated, <500 KB" — 2.

10. Good design is as little design as possible — Score: 2/3
   Evidence: stage overlay has zero interactive elements (pure content); no dead elements; but the auth message is duplicated 5× across 3 files and ≥5 status-line affordances repeat (structural §3).
   Justification: restraint is real; a couple of removable/consolidatable elements keep it from 3.

**Total: 16/30**
