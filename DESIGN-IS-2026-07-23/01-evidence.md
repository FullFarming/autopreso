# Evidence — consolidated subagent reports

## 1. Structural (completed)

- Interactive elements: Host Authorization panel 4 (`subtitle.html:407,411,416,419`); Live Call draft 7 (`subtitle.html:244,250,251,266,270,291,308`); QR stage overlay **0** — display-only (`LiveStageView.tsx:155-197`).
- Max nesting: settings 4; draft 7; stage DOM 5 / component tree 3. No unused imports/elements found on the three surfaces.
- Repeated patterns: ≥5 status-line affordances across surfaces; "authorization required" message duplicated 5× across 3 files (`subtitle.html:420`, `subtitle-workspace.js:285,328`, `LiveStageView.tsx:130,131`); `InviteQrCode` reused 3× (stage + dashboard ×2).
- Primary task happy path: sidebar → (optional fields) → Start Live Call → overlay fetch → QR visible. **Failure detour adds 5 manual steps** (auto-jump to Settings, type 3 fields, save, navigate back to Live Call page manually, press Start again) — `subtitle-workspace.js:282-296` navigates TO settings but nothing navigates back or retries after a successful save.
- QR is visible pre-live; Go-Live is a separate controller action (`LiveStageView.tsx:3-7,140`).
- Gaps: Electron bridge internals, LiveHostDashboard full tree, CSS-driven visibility.

## 2. Visual (completed, INFERRED from source)

- **Undefined `.accent` class**: primary CTA `<button class="accent">Start Live Call` (`subtitle.html:308`) has **no matching CSS rule** in any `public/*.css` — intended primary emphasis never renders.
- Spacing: 16 distinct px steps on the workspace surface incl. off-grid 5/7/11/22/26; type: 10 sizes in a 10–15px band with 0.5px increments — no enforced scale. Stage surface is closer to a system (clamp()-based hero type is well done).
- Color: ~40+ distinct references on the workspace surface; declared `--cw-*` token system is bypassed by a ~28-step raw `rgba(255,255,255,α)` ladder. Stage mixes raw hex with tokens inside one component.
- Contrast (computed): `.field-status` #777169 on ≈#070707 ≈ **4.1:1**; stage hint rgba(255,255,255,.42) on #000 ≈ **3.9:1** — both below WCAG AA 4.5:1 for small text. Hero elements pass (21:1).
- States: workspace Host-Auth/draft has **no loading state** (save/create show no pending style — text-only via JS); error/success/focus/disabled present. Stage has loading/error/success; focus/disabled N/A (no controls).
- Light theme is a `filter: invert(1) hue-rotate(180deg)` hack (`subtitle.css:2750`) that rotates all accent hues and already needed manual rescue rules (2755-2759). Stage is hardcoded #000 (intentional broadcast overlay).

## 4. Weight & Friction (completed)

- Desktop workspace: ~130 KB local unminified JS (3 ESM modules, `subtitle.html:566-567`), 58 KB CSS, ~10 local requests + render-blocking Google Fonts CSS (`subtitle.html:10`) — fonts are the main friction, not JS.
- Idle animations on workspace: **0 effective** (the one infinite keyframe targets a selector absent from this page).
- Notifications/modals on load: 0; two quiet status chips only.
- No persistent polling on the settings/livecall pages; only two one-shot 800 ms setTimeouts (`subtitle-workspace.js:77,240`).
- Stage overlay: `LiveStageView` imports the whole 65 KB `LiveHostDashboard.tsx` **just for `InviteQrCode`** (`LiveStageView.tsx:12`) + `qrcode` lib (~84 KB source). On-load fetches 1–2; QR is a data: URL (no request).
- Stage idle: 1 infinite spinner during prelive (`globals.css:803-804`), gated by `prefers-reduced-motion`; 5 s session poll + 1 s countdown tick on mount (`LiveStageView.tsx:67,116`) with BroadcastChannel fast path.
- Gaps: no production bundle for stage route; sizes are on-disk source sizes.

## 5. Accessibility (completed, INFERRED)

- Contrast failures (small text over #000): cover rules 4.41:1 (`subtitle.css:2587`); handoff kicker/flow 4.26:1 (`:2172`); **error status `.is-error` #A32D2D ≈ 2.95:1** (`:447`); stage hint 3.95:1 (`globals.css:844`); stage code label 4.41:1 (`:850`). Several statuses sit at ~4.88:1 with no headroom.
- Save-button border 1.66:1 — fails 3:1 non-text minimum (`subtitle.css:2130`). Password placeholder color undeclared (UA default — likely fail).
- Focus outlines present and consistent; `prefers-reduced-motion` honored on stage. Keyboard: both primary buttons reachable; stage overlay has zero controls (by design).
- ARIA: sections labeled, statuses `role="status" aria-live="polite"`, countdown `role="timer"`. Inconsistency: error-state `<main>` lacks the aria-label the success state has (`LiveStageView.tsx:129` vs `:156`).
- No skip link; all labels implicit-wrapping (works, no for/id); **no password reveal toggle** on any credential field.

## 3. Copy & Honesty (completed)

### Language mix (EN/KO on the same screen)
- Host Authorization panel: EN heading/labels/button (`subtitle.html:402,407,416,420,421`) with KO label `표시 이름 (자막용)` (411) and KO placeholder `저장된 비밀번호는 표시되지 않습니다` (417).
- Live Call draft: EN section headings (`subtitle.html:239,259,277,285`) above fully-KO help paragraphs (272, 278); `Start Date (비우면 바로 시작)` (264) beside EN `Start Time` (268).
- Login API errors are 100% Korean (`route.ts:20,24,30,44,65`) while UI is English-first.

### Jargon / unclear labels
- "Host Authorization" conflates sign-in with permission → plain: "Host sign-in" (`subtitle.html:402,420,421`).
- "QR stage" / "Stage overlay" internal jargon (`subtitle.html:403,309`; `LiveStageView.tsx:130`).
- "workspace" has 3 referents: remote server (`js:337-350`), app shell (`subtitle.html:17`), participant workspace (`js:313`).
- "Go-Live on the controller" — controller undefined on-screen (`subtitle.html:272,309`).

### Label→behavior mismatches
- **LiveStageView.tsx:127-130 renders "Host authorization is required for this Stage overlay." for ANY session-load failure** (tsx:59-61 catches all errors); the generic `Unable to load the session.` (tsx:60) is overridden. Network/500 masquerades as auth failure.
- Raw machine codes leak to users in fallback branches: `js:300` `(${result?.code})`, `js:352` `(${result.verificationCode})`.
- Button `Start Live Call` (`subtitle.html:308`) does not start the call — it opens the pre-live stage; actual start is controller Go-Live. Mitigating copy exists (309) but the label overpromises.

### Honesty
- "They remain on this device." (`subtitle.html:403`) — incomplete: stored copy stays local, but the credential is transmitted to the workspace during save-verification.
- No dark patterns found; Live Call consistently framed as optional (`subtitle.html:26,247,297`).

### Gaps
- Invite persistence claim (292) implemented elsewhere; countdown format not inspected.
