# Spec: Web Live Call — Translation-First UI

Module id: `translation-first-ui`

## Objective

Recompose every webapp surface around NOVA's defining experience: translated
captions are the first visual and screen-reader priority during a live session.
Secondary settings and metadata remain reachable within two interactions but no
longer compete with the translation viewport.

The work creates reusable, accessible primitives and translation-domain
components, then composes them across participant, host, stage, join, summary,
and login states. It preserves existing session, gateway, and API behavior and
does not redesign the Electron desktop app in this module.

### User Stories

- As a participant, I immediately see translated captions with minimal chrome.
- As a participant, I can change language or recover the latest caption in one action.
- As a participant, I can reach appearance, session details, and leave controls without losing my reading position.
- As a host, I can monitor translation while retaining immediate live controls and recovery status.
- As a room audience, I see invitations before a call and translated captions after it starts.
- As a keyboard or screen-reader user, I encounter the live translation before secondary metadata and can operate every disclosure/drawer.

## Clarification Summary

- **Purpose:** remove UI competition around translated captions.
- **Included:** login, host setup/invite/live/ended, participant join/viewer/summary, mobile viewer, and stage.
- **Excluded:** Electron redesign, backend/schema changes, email delivery, deployment.
- **Roles:** ADMIN receives translation-first operations; participants receive caption-only translation-first viewing.
- **Data model:** unchanged; existing APIs and caption contracts are reused.
- **Normal flow:** join/create → live translation occupies the main viewport → secondary controls open on demand.
- **Failure flow A:** no captions yet → quiet translation-shaped empty state without fake content.
- **Failure flow B:** connection/audio recovery → persistent actionable status without replacing the translation record.
- **Devices:** participant mobile-first; host desktop-first; 320/768/1024/1440px plus 200% zoom.
- **External systems:** no new provider or UI dependency.
- **Success:** translation owns the documented viewport share, critical controls remain within two interactions, and WCAG 2.1 AA checks pass.
- **Rollback:** surface-by-surface commits, preserving existing containers and API contracts.

## Tech Stack

- Next.js 15.3 and React 19
- TypeScript 5.8 strict mode
- Existing global NOVA semantic tokens plus component-scoped CSS Modules
- Existing REST/WebSocket/caption contracts
- Native HTML controls, `<dialog>`/popover behavior where supported by the current browser baseline, with accessible React fallbacks using no new dependency

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

Browser verification uses the existing Chrome DevTools integration. Safari is a
required manual production-readiness gate.

## Project Structure

```text
webapp/components/ui/
  Button/, FormField/, DisclosurePanel/, ControlDrawer/, StatusChip/,
  EmptyState/, ErrorState/
webapp/components/live/translation/
  TranslationViewport/, CaptionEntry/, LanguageSelector/,
  TranslationToolbar/, SessionInspector/
webapp/components/live/LiveViewer.tsx
  Participant data/gateway container; composes translation components.
webapp/components/live/LiveHostDashboard.tsx
  Host state/media container; composes live workspace and inspector.
webapp/components/live/LiveStageView.tsx
  Pre-live invitation composition and live translation composition.
webapp/app/(login)/login/page.tsx
  Minimal shared-field login composition.
webapp/app/globals.css
  Global reset, semantic NOVA tokens, route-level layout only.
webapp/components/**/*.module.css
  Component-owned styling and responsive states.
test/live-ui.test.js
webapp/components/**/*.test.ts(x)
  Static contracts and focused behavior tests.
```

Components and tests are colocated. New presentational component files target
under 200 lines. Existing containers are reduced incrementally; data fetching,
gateway lifecycle, and session transitions are not duplicated into primitives.

## Code Style

Prefer composition and semantic HTML over configuration-heavy panels.

```tsx
<TranslationViewport
  captions={captions}
  state={translationState}
  onJumpToLatest={jumpToLatest}
>
  <TranslationToolbar>
    <LanguageSelector value={language} options={languages} onChange={setLanguage} />
    <StatusChip state={connectionState}>{connectionLabel}</StatusChip>
    <ControlDrawer triggerLabel="더보기">
      <SessionInspector session={session} onLeave={leaveSession} />
    </ControlDrawer>
  </TranslationToolbar>
</TranslationViewport>
```

- Use English identifiers and Korean user-facing recovery/validation copy where the current product localization requires it.
- Use immutable state updates and existing container callbacks.
- Use native `button`, `select`, `details`, and `dialog` semantics before custom ARIA widgets.
- Dropdowns/disclosures hold secondary choices only; live state, errors, recovery, language, and destructive confirmation are never hidden solely to save space.
- Component CSS consumes semantic `--nova-*` tokens only; raw colors remain in the primitive token tier.
- One `h1` per page, sequential heading levels, and stable accessible names.

## Functional Requirements

### Shared translation viewport

- `TranslationViewport` is the common reading frame for participant, host, and live stage.
- It supports presentation and meeting caption shapes through composed `CaptionEntry` content rather than a large variant switch.
- Final, partial, failed, loading, empty, paused, disconnected, and ended states preserve the reading region's dimensions.
- Existing captions remain visible during reconnect or translation update; status is layered without clearing content.
- Newest captions appear at the bottom. Auto-scroll pauses when the reader moves more than 48px from the live edge and exposes one Jump to latest action.
- Caption measure is at most 920px. Korean uses `word-break: keep-all`; text responds to OS scaling and the existing user caption scale.
- Partial updates are not announced repeatedly. Screen readers receive final caption additions through a bounded polite live region.

### Participant viewer

- Translation occupies all flexible space after one compact toolbar/status row.
- Language remains directly accessible. Up to three languages use a segmented selector at sufficient width; narrow or larger option sets use a labeled native select.
- Text size, session details, participant identity, capacity, transcript/summary navigation, and leave move into one More-controls drawer or post-session tabs.
- The drawer restores focus to its trigger, traps focus while modal on mobile, closes with Escape, and does not reset caption scroll position.
- No participant microphone, Speak, floor, mute, waveform, capture, or translated-audio control renders or reserves space.
- Join keeps required email/code and summary consent visible. Company, department, and job title live in one optional-profile disclosure.
- Waiting, paused, ended, reconnecting, and summary states reuse shared status/empty/error primitives rather than separate full-screen visual systems.

### Host workspace

- In live state, translation owns at least 60% of usable desktop content area.
- Start/pause/resume/end, audio recovery, and overall session state remain immediately visible adjacent to the translation viewport.
- Invitation, participants, language diagnostics, appearance, stage, and advanced settings compose into a right inspector capped at 360px.
- The inspector can collapse on desktop and becomes a bottom drawer below 1024px.
- Participant tables become responsive list rows below their usable table width; horizontal scrolling is not the primary mobile design.
- Setup shows the minimum create fields first. Advanced output, glossary, capacity, and cover settings use labeled disclosures/selectors; an empty QR placeholder does not consume half the layout before creation.
- Destructive controls remain separated and require explicit confirmation; they are not placed in a generic dropdown beside routine settings.

### Stage

- Preparing state keeps title, countdown, QR/code, and attendance as the primary composition.
- Live/paused state replaces invitation content with the shared translation viewport and a minimal state/attendance overlay.
- Ended state shows a concise finished message without stale QR or translations presented as live.
- Stage remains readable from distance, click-free, and free of settings controls.

### Login and post-session surfaces

- Login uses shared field, button, and error primitives with one primary action and no decorative dashboard chrome.
- Summary/transcript use existing data and retain their tabs, but share the translation reading measure, typography, empty state, and error treatment.
- Loading uses layout-shaped skeletons; no spinner or shimmer displaces translation content.

### Design-system consolidation

- `DESIGN.md` remains the authority for semantic tokens, typography, spacing, radius, motion, and focus.
- Raw component colors migrate to tiered `--nova-*` tokens; no new raw hex is introduced in component styles.
- `9999px` component radii migrate to the single pill token.
- Shadows appear only on genuinely floating drawer/popover surfaces.
- No gradient fill, generic card grid, explanatory-copy wall, emoji, or decorative animation is introduced.
- `prefers-reduced-motion` removes nonessential transforms and auto-smooth scrolling.

## State and Component Boundaries

- Existing containers own network, authentication, session, media, and gateway state.
- Presentation components accept normalized props and callbacks and perform no fetches.
- Local state owns drawer/disclosure/selector visibility only.
- URL state remains limited to existing language/shareable navigation where already supported.
- No new global store, React Query layer, or duplicated desktop/mobile source of truth is introduced.

## Testing Strategy

### Unit and component contracts

- Language selector chooses segmented versus select presentation without changing value semantics.
- Drawer/disclosure keyboard behavior, focus return, Escape, labels, and reduced motion.
- Translation viewport pin/unpin, Jump to latest, final-only announcement, and preserved content during failure states.
- Participant composition contains no Speak/microphone/capture controls or client import.
- Host inspector keeps critical recovery and destructive confirmation outside generic secondary menus.

### Integration and static checks

- `/watch` and `/m/watch` share the same translation components and endpoint behavior.
- Host, viewer, and stage reuse `TranslationViewport`/`CaptionEntry`; no parallel caption rendering truth is introduced.
- API request/response and WebSocket contracts remain unchanged.
- Static searches reject new raw component colors, `9999px` radii, skipped heading levels, click-only divs, and participant media imports.
- Existing host recovery and attendee privacy/security suites remain green.

### Browser checks

- 320, 768, 1024, and 1440px plus 200% zoom.
- Translation area measurements: participant at least 70% of usable 1440px live area; host at least 60%; mobile translation receives all remaining space below the compact toolbar/status.
- Keyboard order: translation/language first, then More controls; focus trap/return and Escape work.
- Screen reader structure, accessible names, final-caption announcements, empty/error/loading states.
- Clean console/network, no layout overflow, and no participant microphone permission request.
- Chrome automation and manual Safari verification.

## Boundaries

### Always

- Preserve translation as the dominant live content and keep critical state/recovery visible.
- Compose focused components; separate presentation from data/media containers.
- Use existing NOVA tokens and WCAG 2.1 AA contrast, keyboard, focus, and announcement behavior.
- Validate at all four breakpoints, 200% zoom, reduced motion, empty/error/loading, and long Korean/English content.
- Preserve current APIs and build each surface as an independently reversible change.

### Ask first

- Any backend/schema, gateway, authentication, routing, or session-state contract change.
- Any new runtime/UI dependency, analytics, localization framework, or browser-baseline change.
- Changing destructive-action semantics or exposing new participant/host data.
- Expanding the redesign to Electron desktop surfaces.

### Never

- Hide language, live/error/recovery status, or destructive confirmation only to reduce visual density.
- Reintroduce participant microphone, Speak, floor, or translated-audio UI.
- Clear existing translations during reconnect/loading or make a spinner the primary live content.
- Create separate desktop/mobile fetch or state implementations.
- Add arbitrary colors, type sizes, radii, gradients, emoji, or shadow-heavy cards.
- Deploy or change production configuration without explicit approval.

## Success Criteria

- Participant live translation is the first and dominant content, using at least 70% of the usable desktop live area and all flexible mobile space.
- Host live translation uses at least 60% of usable content area while start/pause/resume/end and recovery remain immediately accessible.
- Stage switches from invitation/countdown to translated captions when live.
- Secondary settings are reachable within two interactions and do not reset reading position.
- Join keeps required fields and consent visible while optional work profile fields collapse accessibly.
- Host/viewer/stage share translation components and generic controls reuse common primitives.
- Participant pages render no speaking/media controls and request no microphone permission.
- All breakpoints, 200% zoom, keyboard, screen-reader structure, reduced motion, empty/error/loading states, tests, typecheck, and build pass.
- No backend/schema contract, external service, production configuration, migration, or deployment changes.

## Out of Scope

- Electron desktop redesign.
- Attendee identity/admission persistence and gateway media authorization, which remain owned by `attendee-admission`.
- Invitation delivery, durable summary generation, and summary email delivery.
- New design framework, Storybook installation, analytics, or localization infrastructure.

## Open Questions

None. The user approved the webapp-wide, translation-first, component-driven,
responsive direction on 2026-08-15.

## Approval

Approved by the user for joint implementation with `attendee-admission` on 2026-08-15.
