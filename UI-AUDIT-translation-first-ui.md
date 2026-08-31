# UI Audit: Translation-First Web App

Audit date: 2026-08-15  
Module id: `translation-first-ui`  
Surfaces: login, host setup/invite/live/ended, participant join/viewer/summary,
mobile viewer, and stage/countdown

## Outcome

The current webapp has strong live-caption building blocks, but its page
composition does not consistently make translation the protagonist defined by
`DESIGN.md`. The primary redesign is therefore an information-architecture and
component-boundary change, not a decorative restyle.

## Evidence Snapshot

- `LiveViewer.tsx`: 1,998 lines.
- `LiveHostDashboard.tsx`: 1,572 lines.
- `globals.css`: 1,220 lines and 617 `.live-*` selectors.
- Host dashboard markup currently contains 38 buttons across setup and live states.
- `globals.css` contains 35 `border-radius: 9999px` declarations despite the
  design system defining one `999px` pill token.
- The participant demo accessibility tree places session details, language,
  text size, delivery mode, connection copy, Speak, identity, and capacity
  around an empty translation region.
- The host live caption feed is constrained to `230–430px`, while operations,
  participants, and language monitoring retain equal-weight panels.
- The stage surface becomes status-only after going live; it does not promote
  translated captions when invitation information is no longer primary.

## Findings

| Priority | Finding | Consequence | Direction |
|---|---|---|---|
| P0 | Participant Speak/microphone UI remains in `LiveViewer` and a dedicated capture client | Competes with translation and contradicts the approved caption-only participant contract | Remove from participant composition; gateway denial remains owned by `attendee-admission` |
| P0 | Viewer and host containers own data, state, rendering, controls, and responsive variants in single 1,500–2,000-line components | Reuse is difficult and a layout change risks unrelated session behavior | Extract presentational components while containers retain server/media state |
| P1 | Translation is not guaranteed the dominant viewport on desktop host/viewer | Operators and guests scan chrome before the product's core output | Give translation the flexible main region; cap secondary inspector width and collapse it on demand |
| P1 | Persistent secondary controls consume reading space | Mobile captions compete with language, size, connection, Speak, and footer rows | Keep language/status immediately reachable; move appearance, session metadata, leave, and secondary actions into one accessible control drawer |
| P1 | Live stage stops at session status and attendance | Shared-room viewers cannot use the stage as a translation display after start | Replace invite/countdown with a large translation viewport once live; reuse existing caption contracts |
| P1 | Styling drifts from `DESIGN.md` tokens through raw colors, multiple surface systems, shadows, and oversized pill radii | Visual hierarchy varies by route and future components cannot compose predictably | Centralize semantic NOVA tokens; component styles consume tokens only |
| P2 | Join forms show all optional fields at once | Adding company and consent will push the primary join action below the fold | Keep email/code and consent visible; group optional work profile fields in one disclosure |
| P2 | Empty states and placeholders often fill unused space with cards or explanatory copy | Negative space becomes visual noise instead of improving caption focus | Use quiet inline status and layout-shaped skeletons; leave deliberate breathing room |
| P2 | Login uses a separate light/glass vocabulary | First impression does not match the dark live experience | Reuse shared field/button/error primitives while keeping login intentionally minimal |

## Target Information Hierarchy

### Participant viewer

1. Current translated caption and recent translation record.
2. Selected language and connection/session status.
3. Jump to latest and text-size accessibility action.
4. Session details, identity, capacity, leave, transcript, and summary in a drawer or post-session tabs.

### Host live workspace

1. Translation monitor and current partial/final state.
2. Start/pause/resume/end and recoverable audio status.
3. Language readiness and participant count.
4. Participant roster, invite, stage, and advanced session controls in a bounded inspector.

### Stage

1. Before live: session title, countdown, QR/code, attendance.
2. Live/paused: translated captions, clear live/paused state, minimal attendance.
3. Ended: finished state only.

## Component Opportunities

### Generic primitives

- `Button`: fill/weak/destructive variants and design-system sizes.
- `FormField`: label, input, hint/error association, and autocomplete contract.
- `DisclosurePanel`: keyboard/ARIA-correct optional sections.
- `ControlDrawer`: desktop popover/inspector and mobile bottom-sheet composition.
- `StatusChip`: text plus state marker; never color alone.
- `EmptyState` and `ErrorState`: quiet, actionable, and layout-specific.

### Translation-domain components

- `TranslationViewport`: scrolling, pin/unpin, live edge, empty/loading/error states.
- `CaptionEntry`: speaker, timestamp, translated text, pending/final/failed state, optional original disclosure.
- `LanguageSelector`: segmented control for up to three languages; labeled select when the option count or width requires it.
- `TranslationToolbar`: language, status, latest, and one More-controls trigger.
- `SessionInspector`: composable invitation, participants, appearance, and session actions.

Composition is preferred over a single configuration-heavy component. Data
fetching, gateway state, media state, and session transitions remain in the
existing containers.

## Responsive Composition

| Width | Translation | Secondary controls |
|---|---|---|
| 320px | Full remaining viewport below a 44px toolbar | Bottom drawer; optional profile disclosure |
| 768px | Full-width reading column, maximum readable measure | Bottom drawer or inline disclosure |
| 1024px | Main translation region plus collapsible 320px inspector | Inspector closed by default for participants |
| 1440px | Translation region owns at least 70% of participant usable area and 60% of host live area | Host inspector capped at 360px; no equal-weight card grid |

## Non-Goals

- No new backend or database source of truth.
- No email delivery, summary-generation, or invitation-delivery implementation.
- No participant microphone, speaking, or translated audio.
- No desktop Electron redesign in this module.
- No new UI framework or runtime dependency.

## Review Boundary

This audit is evidence for `SPEC-translation-first-ui.md`. It authorizes no
product-code change by itself.
