# Realtime Noel Desktop Host - Design QA

## Comparison target

- Source visual truth:
  - `/Users/kyeongmankim/.codex/generated_images/019f8d7a-645f-7d52-8e19-2ad6183f30c2/call_iYI1gh0aFKCdCJdZjF2qoF3r.png`
  - Supporting setup state: `/Users/kyeongmankim/.codex/generated_images/019f8d7a-645f-7d52-8e19-2ad6183f30c2/call_LIs9Ph2sSqHwBSaeYG39qglA.png`
- Browser-rendered implementation:
  - `/Users/kyeongmankim/Realtime/autopreso/output/design-qa/desktop-dark-final-icons-1487.png`
- Side-by-side evidence:
  - `/Users/kyeongmankim/Realtime/autopreso/output/design-qa/desktop-host-comparison-final-icons.png`
- Implementation route: `http://127.0.0.1:3210/subtitle.html`
- Intended packaged route: Electron loads `/subtitle.html` from the bundled local server.

## Viewport and normalization

- Source pixels: 1487 x 1058.
- Browser viewport request: 1487 x 1058 CSS px, device scale factor 1.
- Browser implementation capture: 1472 x 1047 pixels after the in-app browser's scrollbar/content-area adjustment.
- Comparison canvas: both images normalized into 1487 x 1058 slots, side by side on a 2974 x 1058 canvas.
- Additional responsive evidence:
  - 1440 x 900: `/Users/kyeongmankim/Realtime/autopreso/output/design-qa/desktop-dark-1440-final-candidate.png`
  - 1120 x 760: `/Users/kyeongmankim/Realtime/autopreso/output/design-qa/desktop-dark-1120.png`

## State

- Source: active Live Call with transcript, current speaker, QR and session controls.
- Implementation: base local-caption state before Live Call is opened.
- This state difference is intentional. The desktop product must keep local captions as its primary independent workflow; detailed QR, participant and speaker controls remain in the host-only Live Call workspace. QA compares the selected shell, hierarchy, palette, proportions, typography and control treatment rather than pretending the dynamic content states are identical.

## Full-view comparison

- The selected black host workspace is now present in the actual Electron dashboard path.
- Both source and implementation use a persistent narrow left rail, a dominant central content region and a narrower right control region.
- The central caption area is the largest region and the right-side controls remain subordinate.
- Black surfaces, white primary text, muted gray metadata, 8px control radii and restrained borders match the selected direction.
- The original light card dashboard shown by the user is no longer the active visual layer.
- At 1487 x 1058, document and panel horizontal overflow are zero.

## Focused-region comparison

### Navigation

- Official Feather `radio`, `file-text`, `users` and `settings` assets reproduce the source's thin line-icon language.
- Icons are local, 20px, decorative to assistive technology, and change opacity with the selected/hover state.
- Selected navigation uses a restrained dark-gray fill and white label/icon, matching the source.

### Main caption surface

- The central caption viewport retains the source's large uninterrupted black reading field.
- The live translation text is large, white and left-aligned, with no gradient, decorative card treatment or unnecessary color.
- Transcript/history remains directly below the caption surface so the real desktop function is preserved.

### Right control surface

- Session, input, subtitle language, tone, local playback, audio source and start/stop controls remain intact.
- Controls use black surfaces, white selection, muted borders and a clear focus ring.
- Dense controls fit a 430px maximum side column without clipping at the reference viewport.

## Required fidelity surfaces

- Fonts and typography: system/Pretendard/Inter fallback stack is consistent; display, caption, label and metadata weights establish the same hierarchy as the source. No broken wrapping or truncation remains at the tested widths.
- Spacing and layout rhythm: 220px rail, large main region, 400-430px control region, 8px radii and thin dividers follow the reference composition. No horizontal overflow remains.
- Colors and tokens: final visible shell is black, white, neutral gray and Apple Blue for focus only. No gradient or decorative color accent is visible.
- Image quality and asset fidelity: navigation icons come from the official Feather icon library and render sharply as local SVG assets. The base caption state contains no product imagery that requires generation.
- Copy and content: desktop copy explains that Live Call is optional and local captions remain independent. Web-only English requirements do not remove the established Korean desktop caption labels.

## Interaction and accessibility checks

- Captions navigation: scrolls to the caption workspace and becomes the single `aria-current` item.
- Transcripts navigation: scrolls to transcript history and becomes active.
- Settings navigation: opens the native settings details panel, scrolls to it and becomes active.
- Live Call: preserves the existing host-only workspace opening contract.
- Keyboard focus: 2px Apple Blue focus outline is present.
- 1120 x 760 responsive state: no horizontal overflow; layout moves to one column.
- Browser console: no warnings or errors in the final capture.

## Comparison history

### Pass 1 - blocked

- P1: the existing installed/app-loaded screen still used the legacy light card dashboard.
- Fix: applied the selected black host visual system directly to `public/subtitle.html` and `public/subtitle.css`, which are bundled into the DMG.

### Pass 2 - blocked

- P1: the right command panel overflowed at 1487px; document width reached 1507px and the command panel scrolled to 436px inside a 383px box.
- Fix: added explicit `min-width: 0` boundaries and changed the main grid to a flexible center plus a 400-430px right column.
- Post-fix evidence: root/body width equals the available content width; command panel scroll width equals client width.

- P1: Settings navigation changed the hash but left the settings panel closed.
- Fix: added primary-navigation state handling; Settings opens before scrolling, while all links update `aria-current`.
- Post-fix evidence: `hash=#settings-drawer`, `open=true`, `current=[Settings]`.

### Pass 3 - blocked

- P2: the left rail used text labels without the line icons visible in the selected source.
- Fix: added official local Feather icons with MIT provenance and state-aware opacity.
- Post-fix evidence: four 20 x 20 icon assets render in the final browser capture with no console errors.

### Pass 4 - passed

- No actionable P0, P1 or P2 visual, responsive or interaction findings remain.
- Residual P3: the implementation's base-caption right panel is denser than the source's active-Live panel because it preserves the existing local input, language, audio and caption controls. This is an accepted product-state difference.

## Verification

- `test/subtitle-frontend.test.js` and `test/electron-subtitle-cache.test.js`: 20/20 passed.
- Desktop Live workspace and stage integration test group: passed.
- TypeScript: passed.
- Public/root asset synchronization: passed.
- Diff whitespace check: passed.

final result: passed

---

# Realtime Noel Live Viewer - Design QA (2026-07-24)

## Comparison target

- Source visual truth:
  - `/Users/kyeongmankim/.codex/attachments/d1601a45-995e-4c72-a9fd-95e6a5c63f39/image-1.png`
  - `/Users/kyeongmankim/Downloads/ScreenRecording_07-23-2026 13-17-22_1.MP4`
- Browser-rendered implementation:
  - `/Users/kyeongmankim/Realtime/autopreso/output/design-qa/live-viewer-2026-07-24/mobile-chromium.png`
- Side-by-side evidence:
  - `/Users/kyeongmankim/Realtime/autopreso/output/design-qa/live-viewer-2026-07-24/source-vs-implementation.png`
- Cross-browser evidence:
  - `/Users/kyeongmankim/Realtime/autopreso/output/design-qa/live-viewer-2026-07-24/cross-browser.png`
- Desktop join evidence:
  - `/Users/kyeongmankim/Realtime/autopreso/output/design-qa/live-viewer-2026-07-24/desktop-join.png`
- Implementation routes:
  - `http://127.0.0.1:3000/m/watch/demo`
  - `http://127.0.0.1:3000/watch`

## Viewport and normalization

- Source pixels: 360 x 782.
- Implementation pixels: 390 x 844.
- CSS viewport: 390 x 844, device scale factor 1.
- Density normalization: the source was resized to 390 x 844 before the combined comparison.
- Additional viewport: desktop join at 1280 x 800, device scale factor 1.

## State

- Source: active meeting with a participant holding the speaking floor, an empty caption area, and a failed microphone banner.
- Implementation: active meeting with attributed final captions, current speaker sheet, and active microphone waveform.
- The state change is intentional: it represents the corrected successful microphone and caption path requested by the user.

## Full-view comparison

- The implementation preserves the source's pure-black live canvas and keeps meeting controls compact.
- The empty center region is now used by an append-only, speaker-attributed caption flow.
- The current speaker sheet stays anchored above the footer without creating document scroll.
- At 390 x 844 in Chromium, WebKit, and Firefox, document width and height exactly equal the viewport.

## Focused-region comparison

### Speak control

- The source uses a full-width text button. The corrected implementation keeps the approved full-width pill shape but removes the label.
- The active state contains a five-bar microphone-level waveform and retains an accessible state label.
- The control is 52px high, exceeds the 44px touch target, and remains active until another participant or host takes the floor.

### Caption feed

- The source's empty caption canvas has been replaced with readable speaker-attributed turns and a focused current-speaker sheet.
- Final turns remain in the feed while the partial/current turn is visually separated.
- Caption and control regions remain bounded; only the transcript region can scroll.

## Required fidelity surfaces

- Fonts and typography: Pretendard/system fallbacks, weight hierarchy, line height, wrapping, and small metadata are consistent across Chromium, WebKit, and Firefox. The deterministic schedule formatter prevents cross-engine hydration drift.
- Spacing and layout rhythm: toolbar, session context, transcript, current-speaker sheet, speaking control, and footer fit one 100dvh grid with no document overflow at 360 x 800 or 390 x 844.
- Colors and visual tokens: the screen uses the approved black, white, C&W Red, Indigo, Blue, and neutral gray tokens. Error, live, and speaking states are not identified by color alone.
- Image quality and asset fidelity: this live state does not require logos, product imagery, or illustration assets. The microphone icon and waveform are interface controls rather than substituted source artwork.
- Copy and content: waiting, live, paused, ended, microphone, preemption, and recording-failure states are mutually exclusive and explicit. The Speak button itself contains no visible text.

## Interaction and accessibility checks

- Speak button: empty visible text, `aria-pressed="true"` in the active state, descriptive `aria-label`, 52px height.
- Keyboard focus: 2px approved Blue outline.
- Page overflow: none at 360 x 800, 390 x 844, and the desktop join route at 1280 x 800.
- Browser primitives: `isSecureContext`, `navigator.mediaDevices.getUserMedia`, and `AudioContext` are present in the Chromium, WebKit, and Firefox local HTTPS-equivalent test contexts.
- Browser console/page errors: zero in the final Chromium, WebKit, and Firefox captures.

## Comparison history

### Pass 1 - blocked

- P1: the non-compact `/watch` join screen rendered white text and labels on the light global canvas.
- Fix: added a route-scoped `.live-viewer-shell.is-join` black canvas and explicit accessible foreground tokens.
- Post-fix evidence: `desktop-join.png` at 1280 x 800.

### Pass 2 - blocked

- P2: WebKit formatted the scheduled time differently from server rendering and triggered a React hydration mismatch.
- Fix: replaced locale-dependent formatting with a deterministic KST schedule formatter.
- Post-fix evidence: all three engines render `Jul 23 · 2:00 PM` with zero console or page errors.

### Pass 3 - passed

- No actionable P0, P1, or P2 visual, responsive, accessibility, or cross-engine findings remain.
- Residual P3: the circular `N` shown in local captures is the Next.js development indicator and is absent from the production build.

## Verification

- Live UI tests: 52/52 passed.
- Speak browser-capture tests: 9/9 passed.
- Web live suite: 104/104 passed.
- Chromium, WebKit, Firefox render checks: passed.
- Web production build and TypeScript: passed.

final result: passed
