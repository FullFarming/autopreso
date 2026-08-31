# NOVA — Design System

Source of truth for the NOVA desktop app. **Toss (TDS) is the structural
authority** — principles, type scale, component metrics, motion. Naver's speech
products (Clova Note, Papago, CLOVA X) supply the transcript- and live-specific
patterns Toss has no equivalent for.

Every number is either extracted from shipped production code, measured from the
reference screen recording, or marked as a NOVA decision. Research extracts:

| File | Contents |
|---|---|
| `toss-tds-extract.md` | TDS from npm (`@toss/tds-*`) + Product Principles |
| `naver-tokens-extract.md` | naver.com core token system, 1,520 properties |
| `clova-papago-transcript-patterns.md` | transcript rhythm, live state, speaker identity |
| `reference-caption-design.md` | the fullscreen caption log from the recording |

---

## 1. The memorable thing

**Your words appear in another language, instantly.**

The caption is the protagonist. Every decision below is judged against one
question: does this make the caption more legible, or does it compete with it?

## 2. Principles — Toss's PP, applied

Toss's umbrella value: *"단순함이란, 사용자가 토스 제품을 사용하기 위해 특별히
'알아야 할 것', '배워야 할 것'이 없으며, 본능적으로 이해할 수 있음을 의미합니다."*

The five that bind hardest here:

**One thing per screen.** One intent per screen, one forward button. NOVA's four
pages each own exactly one: Captions configures, Live Call invites, Records
reviews, Settings persists. Nothing that belongs to one may appear on another.

**Weed cutting (잡초).** Remove any word that changes nothing if deleted. This is
the named principle behind the no-explanatory-copy rule in §3.

**Easy to answer.** Every question answerable in 3 seconds. If it isn't, NOVA
recommends a default rather than asking.

**No pre-emptive warnings.** *"경고 문구를 화면에 채워 넣기 보다는 고객이 실수를
했을 때만."* No banner explains what might go wrong. Tell them when it does.

**No loading animation when there's nothing to wait for.** *"기다릴 필요가 없는데
로딩 애니메이션을 사용하는 경우 사용자가 상황을 오해할 수 있어요."*

Error copy follows Toss's *"Navigating error"*: the message's job is to get you to
the next screen, not to describe a failure. Tell the user how to fix it themselves
— Toss calls this the most important of their six error rules. Dialogs explain;
toasts notify. Dialog's left button is always **닫기**, never 취소.

## 3. Two rules that override everything

### 3.1 No explanatory copy
Labels and values only. A control's name and its state are the entire explanation.
If a control can't be understood from its label, the control is wrong — don't add
a sentence to rescue it.

Deletes, specifically: `subtitle.html:95` `"Choose how captions are delivered."`,
`:169` `"Customize caption appearance."`, `:247` `"Add the basic information for
your live call."`, `:293`, `:306`, `:320`, and the `description` field on every
`LiveHostDashboard.tsx` output-mode option.

### 3.2 The gradient is never a fill
NOVA's blue→violet gradient touches exactly three things: the app icon, the focus
ring of the live caption edge, and 1px rules bracketing a live region. Never a
button fill, card background, or header wash.

Lifted from CLOVA X, where the pink→purple→cyan gradient appears only on the
logo's X, the composer focus ring, and 1px rules. **The restraint is the effect.**

---

## 4. Token architecture

Three tiers. **No raw hex outside tier 1.**
```
tier 1  --nova-{hue}-{step}                      primitives, the only hex literals
tier 2  --nova-{role}-{property}-{variant}       semantic, what components consume
tier 3  --nova-{component}-{property}[-{state}]  component-scoped
```
Theme switches on one attribute — `<html data-theme="dark">` — remapping tier 2
only. **Never `filter: invert()`.**

> `subtitle.css:3140` fakes light mode with `filter: invert(1) hue-rotate(180deg)`
> and counter-inverts images. Toss and Naver both ship hand-authored parallel
> ramps. Replace the filter.

`*-static-*` variants opt out of theming (values that must not flip).

---

## 5. Colour

### 5.1 Surfaces — elevation by lightening, not by shadow

Toss's model: **light mode digs down, dark mode floats up.** Dark elevation is a
4-step lightening ramp (`#101013 → #17171c → #202027 → #2c2c35`) with no shadows
needed to express depth. NOVA keeps that structure on a deeper base.

| Token | Value | Use |
|---|---|---|
| `--nova-surface-recessed` | `#000000` | overlay backdrop, inset wells |
| `--nova-surface-base` | `#0A0A0B` | app background, rail |
| `--nova-surface-layered` | `#15151A` | panels, cards, list surfaces |
| `--nova-surface-float` | `#1F1F27` | popovers, menus, the controller |
| `--nova-surface-hairline` | `#2F2F3A` | borders where two same-step surfaces meet |
| `--nova-scrim` | `rgba(0,0,0,0.56)` | modal backdrop (Toss's dark value) |

### 5.2 Foreground — never pure white
| Token | Value | Use |
|---|---|---|
| `--nova-fg-intense` | `#FFFFFF` | the live caption edge only |
| `--nova-fg-primary` | `#DDDDDD` | committed caption text, body |
| `--nova-fg-secondary` | `#8B95A1` | speaker names, labels |
| `--nova-fg-tertiary` | `#6B7684` | timestamps, meta |
| `--nova-fg-disabled` | `#4E5968` | disabled |

`#DDDDDD` for body is load-bearing: Clova Note uses `#ddd` in dark mode, never
`#fff`, and compresses its grey ramp inward for long transcript reading. A
two-hour meeting is that case. Pure white is reserved for the single live edge.

### 5.3 Two accents, two jobs

Papago runs a brand accent and a permanently-stable `system` accent concurrently,
so live-state signalling never moves when branding does. NOVA copies the split.

**Brand accent — indigo-violet.** Matches the icon (blue `A`, violet `한`) and the
Naver AI family (CLOVA X migrated to indigo-violet `#6566f7` in April 2025; Naver
encodes "AI" as blue→violet, explicitly not green).

| Token | Value |
|---|---|
| `--nova-brand-default` | `#6566F7` |
| `--nova-brand-hover` | `#7576FF` |
| `--nova-brand-pressed` | `#5355DB` |
| `--nova-brand-subtle` | `rgba(101,102,247,0.16)` |
| `--nova-brand-fg` | `#C9C9FC` |
| `--nova-brand-gradient` | `linear-gradient(96deg,#3283FD 0%,#6566F7 52%,#A94EFF 100%)` |

**System accent — blue.** Focus rings, text selection, the in-progress caption
underline. Never changes with branding.

| Token | Value |
|---|---|
| `--nova-system-default` | `#3182F6` |
| `--nova-system-subtle` | `rgba(49,130,246,0.16)` |

`0.16` is Toss's alpha for tinted badges — one value, composites correctly over
any surface. **That alpha-tint pattern is the entire badge system.**

### 5.4 Status
`--nova-status-live #F04452` · `--nova-status-ok #03B26C` ·
`--nova-status-warn #FFC342` · `--nova-status-error #F04452`
(Toss's red500/green500/yellow500.)

### 5.5 Speaker identity — Papago's 10-colour rotation
```
1 #FF9448   2 #4F9EFF   3 #54D089   4 #EF6262   5 #A883FF
6 #F383FF   7 #C5A700   8 #89A100   9 #66C9EB  10 #3652EE
```
Assign by stable hash of speaker id, cycling 1→10. 22px circular badge, 12px/500
white initials.

### 5.6 Interaction — alpha overlays, not colour variants
`--nova-hover: rgba(255,255,255,0.04)` · `--nova-press: rgba(255,255,255,0.08)`

Toss's `greyOpacity` ramp exists precisely so one component composites correctly
over any background in either mode. This is the mechanism, not a shortcut.

### 5.7 Web interface — three-color palette

The web app uses three primitives, including admin, participant entry, login,
records, and dialogs. These web decisions override the older desktop surface
and brand ramps above for product chrome.

| Role | Token | Value |
|---|---|---|
| Background | `--nova-web-background` | `#15151A` |
| Text | `--nova-web-text` | `#FFFFFF` |
| Action / selection / focus | `--nova-web-action` | `#0071E3` |

The page, rail, workspace, cards, input surfaces, dialog, and sticky footer
share the background token. Separate areas with spacing and alpha-white
borders rather than unrelated dark fills. Muted text, disabled controls, hover
and selected-state tints derive only from these three primitives. Primary
actions use white text on blue; secondary actions remain outlined.

Error, warning, live/microphone status, and stable speaker identities retain
their semantic colors. Captions and presentation surfaces keep their dark
reading treatment; QR images retain the contrast required for scanning.

---

## 6. Typography

### 6.1 Family — bundle Pretendard

`subtitle.html:9-12` loads EB Garamond, Inter, and Noto Sans KR from Google Fonts
while the CSS asks for Pretendard, which is never loaded. The app renders in a
fallback, downloads a serif it never uses, and needs the network at launch.

**Toss Product Sans is proprietary and unlicensable** — do not ship or hotlink it.
**Pretendard is the correct substitute for a structural reason:** TPS's Hangul is
Sandoll 고딕neo1; Apple licensed that same face as Apple SD 산돌고딕 Neo;
Pretendard's design target is Apple SD Gothic Neo. Same ancestry. Measured `가`
advance differs by **0.1%** (864.3 vs 865.2 @1000upm), and it has the lowest Latin
advance deviation (3.0%) of any candidate. SIL OFL — bundling permitted.

Self-host woff2, weights **400/500/600** only, `font-display: swap`. Remove all
three Google Fonts links and EB Garamond.

Per-script token, Papago's pattern — one token redefined per locale, Pretendard
always in the stack:
```css
--nova-font: "Pretendard", -apple-system, BlinkMacSystemFont,
             "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
:lang(ja) { --nova-font: "Pretendard", "Hiragino Sans", "Meiryo", sans-serif; }
:lang(zh-Hans) { --nova-font: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
```
zh-Hans/zh-Hant get **no** webfont — system stacks only, as Clova Note does.

**The controller and overlay windows currently load no fonts at all** and must get
the same `@font-face` block, or the overlay renders captions in a system fallback
while the dashboard renders in Pretendard.

Apply `font-feature-settings: "tnum"` to elapsed time and any live-updating
numeral — TPS ships tabular figures for exactly this.

### 6.2 The Korean trio — do not skip
```css
font-weight: 600;        /* the default emphasis weight, not 700 */
letter-spacing: -0.02em; /* Papago's "decrease"; ~-0.1px at body sizes */
word-break: keep-all;    /* wrap at word boundaries, never mid-word */
```
Weight 600 outnumbers 400 by 3.6× in CLOVA X. `word-break: keep-all` is what makes
Korean captions break correctly and is the most commonly omitted detail.

### 6.3 Scale — Toss's tiers, with Toss's line-height rule

**Line-height is derived, never hardcoded:**
```
11–17px → size × 1.5      18–29px → size + 9      30px+ → size + 10
```
That reproduces every published TDS value. Implement as a function.

| Token | px | line-height | Use |
|---|---|---|---|
| `t1` | 30 | 40 | — |
| `t3` | 22 | 31 | page title |
| `t4` | 20 | 29 | section title |
| **`t5`** | **17** | **25.5** | **body default, nav title (semibold)** |
| `t6` | 15 | 22.5 | dense body, secondary labels |
| `t7` | 13 | 19.5 | timestamps, meta — *"안 읽어도 됨"* |
| `st13` | 11 | 16.5 | badges — *"아예 안읽어도 됨"* |

**Caption type is its own ramp**, sized by content length — Papago's `--dynamic-*`
pattern, big by default and shrinking only when forced:
```
≤60 chars  → 38px / 1.35   (the user-adjustable default, range 14–96)
>60 chars  → 30px / 1.4
compact    → 22px / 1.4
```

Sub-pixel steps `10.5 / 11.5 / 12.5 / 13.5px` in the current CSS all go.

### 6.4 Web interface typography and aligned controls

The web admin, participant entry, login, and dialogs use one ordinary-text row:

| Token | Family | px | line-height | weight | letter-spacing |
|---|---|---|---|---|---|
| `--nova-ui-font` | self-hosted Pretendard with locale system fallback | 16 | 24 | 400 | -0.02em |

Labels, values, help text, inputs, buttons, badges, and navigation all use this
row. Page and section headings retain the heading scale and weight 600, using
the same family. Status is communicated with color and placement rather than
another font size or weight. The line-height token is unitless `1.5` (24px at
16px), so inherited display text scales its line box with its size.
User-adjustable captions, presentation access codes, countdowns, and icon
geometry retain their own display rules.

Peer fields and choices use equal-width `minmax(0, 1fr)` tracks. Session titles
and multiline agendas can span a complete row. Long controls keep a single
line and scroll within their available width; they do not enlarge one column.
Workspace zoom and dialog-contained scrolling remain available on narrow views.

---

## 7. Spacing, radius, elevation, motion

**Spacing** — 4px base. Layout steps `8 / 16 / 24`; free 1px granularity inside
components for optical tuning. Toss does not enforce an 8pt grid internally.
`2 4 6 8 12 16 20 24 28 32 40 48 56 64`

**24px is the standard window side margin.** **44px is the minimum touch target.**

**Radius** — anchored to component height, not a universal scale (Toss publishes
none). One pill idiom.
| Token | Value | Use |
|---|---|---|
| `--nova-radius-xs` | `4px` | marks, tags |
| `--nova-radius-sm` | `8px` | small buttons, inputs |
| `--nova-radius-md` | `12px` | panels, list press overlay |
| `--nova-radius-lg` | `16px` | cards, primary buttons |
| `--nova-radius-pill` | `999px` | chips, avatars, the controller |

**Elevation** — prefer a surface step. Toss ships only three shadow tokens; use
them only on genuinely floating things (controller, popovers):
```css
--nova-shadow-tiny:   0 1px 3px rgba(0,0,0,.40);
--nova-shadow-weak:   0 2px 30px rgba(0,0,0,.40);
--nova-shadow-medium: 0 16px 60px rgba(0,0,0,.50);
```

**Motion — springs are default, beziers the exception.** Toss's decree: only two
families, and **one motion per target**. Their adoption advice is to tokenise
easings first and nothing else.
```css
--nova-ease-out:  cubic-bezier(0.25, 0.1, 0.25, 1);  /* default, 0.5s */
--nova-ease-expo: cubic-bezier(0.16, 1, 0.3, 1);     /* entry — in TDS, Clova Note AND CLOVA X */
--nova-ease-back: cubic-bezier(0.34, 1.56, 0.64, 1); /* overshoot */

--nova-spring-rapid: 200ms;  /* press/release      — TDS stiffness 1000 damping 55 */
--nova-spring-quick: 350ms;  /* toggles, enter/exit — TDS 800/55, their most-used */
--nova-spring-med:   570ms;  /* positional travel   — TDS 270/25 */
```
Colour transitions are plain `0.1s ease-in-out`. **Animate only opacity,
transform, colour — never height, never layout.** Honour `prefers-reduced-motion`.

---

## 8. Component anatomy

### 8.1 Caption entry — the core component
```
[◯22]  화자명  ·  21:16                                원문보기 ⌄
Isomorphic Labs raised over $2B to scale its AI drug
design platform globally.
```
- meta row: 22px avatar (speaker colour, 12px/500 white initials), name `t7` in
  `--nova-fg-secondary`, `·`, time `t7` in `--nova-fg-tertiary` with `tnum`.
  Right-aligned disclosure `t7` in `--nova-fg-tertiary`.
- body: `t6` (15/22.5) in `--nova-fg-primary`, `white-space: pre-wrap`,
  `word-break: keep-all`
- header→body **4px**; between entries **22px**; reading inset **24px**;
  measure **≤920px**
- avatar: hairline ring `inset 0 0 0 1px rgba(255,255,255,.06)`; fades in over
  `.5s` when attribution resolves late; unknown-speaker badge at
  `right:-4px; bottom:-4px; 15px`

### 8.2 In-progress vs committed — two signals, composed
```css
/* the paragraph: contrast promotion (Papago .translation-text → .complete) */
.nova-caption            { color: var(--nova-fg-secondary); }
.nova-caption.is-final   { color: var(--nova-fg-primary); }
.nova-caption.is-failed  { color: var(--nova-status-error); }

/* the uncommitted tail: dashed system-blue underline (Papago .recording) */
.nova-caption-pending {
  text-decoration: underline dashed var(--nova-system-default) 1px;
  text-underline-offset: .2em;
}
```
Same size, same weight, same position. **No spinner, no layout shift.** The
in-flight tail sits inline in the same paragraph as committed text.

Three independent sources agree on the contrast half: Papago's shipped CSS, the
reference recording's bright/dim tail, and the `translationStatus:
verbatim | translated | failed` field already on `CaptionEvent`. The dashed
underline is Papago's addition — legible while unmistakably provisional, which
opacity alone cannot express.

**Mid-update, dim existing text rather than clearing it.** Papago's
`.text-area-box.translating` swaps primary→secondary so there is no empty flash
between turns.

### 8.3 Active entry
Translucent wash across the whole entry: `background: var(--nova-brand-subtle)`.
Papago's choice over Clova Note's solid fill, because solid-fill-with-inverted-text
is unreadable while the text is still changing.

### 8.4 Scroll
Newest at bottom, auto-scroll while pinned, unpin at 48px from the edge. Top of
the container fades via `mask-image`, never clips. A floating **jump-to-latest**
button, centred, **24px off the bottom**, visible only when unpinned.

### 8.5 Buttons — Toss's metrics
| size | min-height | radius | padding | font |
|---|---|---|---|---|
| **xlarge (default)** | **56** | **16** | `2px 28px` | `t5` |
| large | 48 | 14 | `2px 16px` | `t5` |
| medium | 38 | 10 | `2px 16px` | `t6` |
| small | 32 | 8 | `2px 10px` | `t7` |

`font-weight: 600`, `white-space: nowrap`. Variants **fill** (saturated) and
**weak** (translucent tint). Full-width forces radius `0`.

**Press: `scale(0.96)` + `--nova-spring-rapid` + a dimmer overlay at opacity
0.26. Full-width buttons do NOT scale** — Toss's deliberate exception.

Disabled: fill `opacity .3`; weak stays opaque but dims its text to `.3`.
**Tapping a disabled button wiggles it** (87.5ms) rather than doing nothing.

Loading: three dots staggered 0.1s/0.2s, each `opacity .2→1, scale .8→1`, 0.3s
reversing. **Width does not change.**

### 8.6 List row — the workhorse
`min-height 44px`, padding `12px / 24px`. **Divider 1px indented 24px from the
left** (`margin-left:24px; width:calc(100% - 24px)`) in `--nova-surface-hairline`.
Press: `--nova-press` overlay at `--nova-radius-md`.

### 8.7 Segmented control
Track `--nova-surface-float`, `--nova-radius-pill`, 2px inset, height 32. Active
segment `--nova-surface-layered` + `--nova-fg-intense` at 600. Inactive
`--nova-fg-secondary`, transparent.

### 8.8 Stepper (`A-`/value/`A+`, `−`/value/`+`)
Two 28×28 icon buttons flanking a fixed-width `t7` readout with `tnum`.
`--nova-radius-sm` on the group, `--nova-surface-float` background.

### 8.9 Switch — Toss's geometry
Track **50×30 radius 15**. **Knob grows 16→24px**, `left:7px`, translateX 0→16.
Off `--nova-surface-hairline`, on `--nova-brand-default`. Press `scale(0.96)` with
`rapid`; travel with `med`.

### 8.10 Status chip
`--nova-radius-pill`, height 24, `0 10px`, `st13`, `--nova-surface-float`
background, 6px leading dot carrying the state colour. No border.

### 8.11 Mic level
A **~20×20 canvas glyph**, not a waveform. Clova Note is 19×19, Papago 22×24, and
**Papago has no live waveform anywhere** — only a static 3-bar glyph inside the
active mic button. The level is a status indicator; the caption is the subject.

### 8.12 Skeletons
Not shimmer boxes. Toss ships 9 named layout archetypes so **the skeleton IS the
layout** and nothing shifts on load. NOVA needs two: `captionFeed` and
`recordList`.

### 8.13 Focus
`:focus-visible` → `2px solid var(--nova-system-default)`, offset 2px.
`button:focus:not(:focus-visible) { outline: none }`. Reserve the ring with
`border: 2px solid transparent` so focus never shifts layout.

---

## 9. Layout

### 9.1 Dashboard (1440×900, `subtitle.html`)
```
┌──────────┬──────────────────────────────────────────────┐
│  NOVA    │  Captions                        ● Connected │  56px
│          ├──────────────────────────────────────────────┤
│ Captions │                                              │
│ Live Call│         content, max-width 880px             │
│ Records  │         24px side margin                     │
│ Settings │                                              │
│          │                                              │
│ ──────── │                                              │
│ Realtime │                                              │
│ by Noel  │                                              │
├──────────┴──────────────────────────────────────────────┤
│ Overlay ●        [Restart] [Start] [Stop]      Overlay ⃝ │
└─────────────────────────────────────────────────────────┘
```
- rail 220px, `--nova-surface-base`, right hairline
- wordmark **NOVA** at `t4`, weight 700, tracking `0.18em`
- **`Realtime by Noel` pinned at the rail bottom**: `st13` (11/16.5) in
  `--nova-fg-disabled`, tracking `0.04em`. The rail already has a
  `margin: auto 14px 0` element there, so it lands with no layout surgery. The
  sticky player bar would occlude anything after it, and the controller is a
  content-hugging 84px row with no vertical room.
- **The `1`–`5` step badges on config cards go.** Numbering implies a wizard this
  isn't, and it violates one-thing-per-screen by suggesting a sequence.

### 9.2 Controller (frameless, transparent, always-on-top)
One pill, `--nova-radius-pill`, `--nova-surface-float` at 92% +
`backdrop-filter: blur(24px)`, `--nova-shadow-medium`. Left→right: drag/brand
(wordmark + status + 20px level glyph) · transport · appearance · window controls
pushed right. Groups separated by a **1px × 14px rule**, not a gap. No footer.

### 9.3 Overlay (one per display, click-through)
Caption only. `--nova-surface-recessed` at the user's opacity,
`--nova-radius-sm`, measure `min(1500px, 88vw)`. **Nothing else may ever render
here** — it sits over the user's screen during a presentation.

---

## 10. Removals

Deleting these is part of the work:

1. `filter: invert(1) hue-rotate(180deg)` light theme → real token remap
2. All three Google Fonts links + EB Garamond
3. The duplicate `:root` at `subtitle.css:3069` redefining `--cw-blue`
4. All five appended "pass" layers — replace, don't add a sixth
5. Every explanatory paragraph (§3.1)
6. The `1`–`5` step badges
7. `9999px` radius (keep `999px`)
8. Sub-pixel type steps `10.5 / 11.5 / 12.5 / 13.5px`
9. Orphaned CSS: `.controller-row*`, `.controller-session`, `.workspace-columns`,
   `.workspace-summary`, `.dashboard-grid`
10. Orphaned JS: the language search/tag UI at `subtitle-dashboard.js:529-606`
    whose DOM hooks don't exist
11. `assets/autopreso.png` — zero references, 409 KB, bundled twice

## 11. Implementation constraints

1. **`root/` and `public/` are byte-identical duplicate trees** and Electron
   serves from `public/` over HTTP, so the root copies are decorative.
   `test/subtitle-frontend.test.js:22-31` **does** enforce the sync — but only for
   5 of the 8 pairs (`subtitle.html`, `subtitle-dashboard.js`,
   `subtitle-audio-player.js`, `subtitle-overlay.js`, `subtitle.css`).
   `subtitle-controller.html`, `subtitle-controller.js` and `subtitle-workspace.js`
   have **no** guard and can drift silently. Edit both copies regardless.
   *(Corrected 2026-07-25: an earlier revision of this document claimed nothing
   enforced the sync.)*
2. **`src/server.js:38-48` is a cache-control list, NOT a serve allowlist.**
   `SUBTITLE_NO_STORE_ASSETS` only sets no-store headers; `express.static` serves
   everything under `public/` regardless, so a new asset does **not** 404 if it is
   unregistered — it merely gets cached. `test/server-startup.test.js:98-118`
   asserts the headers, not serve-ability.
   *(Corrected 2026-07-25: an earlier revision claimed unregistered assets 404.)*
3. **`public/subtitle-overlay.html` has no root copy.**
4. **Three brand-guard tests pin the old name:** `test/product-brand.test.js:45-62`,
   `test/live-ui.test.js:298`, `test/subtitle-frontend.test.js:382`.
5. **Rename scope is visible surfaces only.** `appId com.realtime-noel.app`, the
   npm package name, the `realtimeNoelDesktop` preload global, the
   `realtime-noel-*` localStorage keys, and `~/.config/realtime-noel/` all stay.
   Changing appId loses granted macOS mic/screen permissions; changing the config
   dir orphans `settings.json` including the 53-term CMG glossary.

## 12. Accessibility

- **Type must respond to OS text scaling.** TDS is explicit: *"아래 표에 나온
  값을 직접 하드코딩하지 않길 권장해요."* Emit `--nova-font-size-{n}` /
  `--nova-line-height-{n}` and derive line-height by the §6.3 rule.
- **Icons scale with the font** (~1.10–1.15×) so hierarchy survives large-text mode.
- sr-only: `position:absolute; clip:rect(0 0 0 0); width:1px; height:1px; margin:-1px`
- `aria-selected` drives tabs; `aria-pressed` drives toggles
- state never carried by colour alone — pair every status dot with its label
- caption contrast `#DDDDDD` on `#0A0A0B` ≈ 14.5:1
- honour `prefers-reduced-motion`; custom scrollbar only under
  `hover:hover and pointer:fine`

---

*Realtime by Noel*
