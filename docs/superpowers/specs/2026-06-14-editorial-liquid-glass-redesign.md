# Editorial + Liquid-Glass Redesign — Realtime Noel

Date: 2026-06-14 · Status: approved (mockup at `mockup/index.html`)

## Goal
Re-skin the webapp and desktop dashboard to a light **editorial** base (off-white
canvas, warm near-black ink, pastel atmospheric gradient orbs, serif display)
merged with **Apple liquid-glass** translucent layers. All third-party brand
wording/tokens removed; tokens renamed to neutral names. Live subtitle/overlay
surfaces stay dark for readability over video. Responsive web + program.

## Approved decisions
- **Base:** hybrid — light editorial canvas + liquid-glass layers for all chrome;
  live subtitle strip / PiP / floating overlay stay dark/translucent.
- **Display font:** EB Garamond 300 (serif signature); body Inter 400/500, +0.16px tracking.
- **Scope:** webapp + desktop dashboard (`public/subtitle.*`). Floating overlay
  (`public/subtitle-overlay.*`) stays dark/transparent — functional, untouched.

## Design tokens (neutral names)
- canvas `#f5f5f5` · canvas-soft `#fafafa` · ink `#0c0a09` · body `#4e4e4e` · muted `#777169`
- surface `#ffffff` · surface-strong `#f0efed` · hairline `#e7e5e4` · hairline-strong `#d6d3d1`
- primary (ink pill) `#292524` / active `#0c0a09` · on-primary `#fff`
- record accent (iOS red) `#ff453a` — used ONLY for the record button
- gradient orbs: mint `#a7e5d3` · peach `#f4c5a8` · lavender `#c8b8e0` · sky `#a8c8e8` · rose `#e8b8c4`
- dark surfaces: dark `#0c0a09` / elevated `#1c1917` / on-dark `#fff` / on-dark-soft `#a8a29e`
- radius: md 8 · lg 12 · xl 16 · xxl 24 · pill 9999
- liquid glass on light: `rgba(255,255,255,.55)` + `backdrop-blur(28px) saturate(150%)`,
  1px white/0.7 hairline, inset top highlight, soft `0 12px 40px rgba(12,10,9,.08)` drop.

## Layout rules (from user feedback)
- **Fixed width, no fluid stretch.** Desktop composition caps at a fixed width, centered.
- **Short labels/controls/titles never wrap** (`white-space:nowrap`): tabs, chips,
  buttons, badges, card titles, status text. Only long subtitle/lede sentences wrap.
- **Grid tracks use `minmax(0,1fr)`** so nowrap children can't overflow their panel
  (root cause of the reported "card bleeds past panel / modal overflow" bug).
- Synced webapp landing = **full one page** (`100dvh`, no scroll): recording ring
  centered, sync chip, live dark subtitle strip pinned in-view.

## Responsive
- mobile <640: 1-up, hamburger/stacked, orbs shrink (never disappear)
- tablet 640–1024: 2-up · desktop 1024–1280: full · wide >1280: cap content ~1100px

## Settings (⚙)
- Opens the existing SettingsModal (restyled to editorial glass; overflow fixed).
- **Preset registration:** the preset picker loads the desktop program's embedded
  presets (hospitality EN↔KO, F&B KO↔JA, hotel EN↔JA) — selecting one fills
  glossary + domain + language pair. Source of truth `webapp/lib/presets.ts`,
  auto-generated from `src/glossary-presets.js` via `scripts/generate-webapp-presets.mjs`.
- Modal body scrolls inside `max-h`; grids clamp with `minmax(0,1fr)`; no horizontal overflow.

## QR sync vs standalone (behavior preserved, not changed)
- **Sync ON:** phone-webapp mic → realtime translate (OpenAI GA shape / Gemini) →
  publish to Supabase `pair:{token}` (`event:"line"`) → desktop subscribes →
  `subtitle:mirror` → overlay/preview shows it.
- **Standalone desktop:** system/mic capture → server pipeline → overlay. Unchanged.

## Files
Webapp: `app/globals.css` (tokens, glass, orbs, fonts), `tailwind.config.ts`,
`app/layout.tsx` (fonts + light `.lg-bg` orb field), `app/(login)/login/page.tsx`,
`app/page.tsx` (full-page editorial recording view), `components/SettingsModal.tsx`
(editorial + overflow fix + prominent preset picker), `GlassTopBar.tsx`, `MeetingMode.tsx`.
Desktop: `public/subtitle.css` + `public/subtitle.html` (controls/drawer/panels →
light glass). NOT touched: `public/subtitle-overlay.*`.

## Out of scope
Animation timing polish; overlay theming; new translation features.
