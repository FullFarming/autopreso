# Toss / TDS — Implementation Reference for a Dark Electron Desktop App

Research deliverable. Companion to `../DESIGN.md`, not a replacement.
`DESIGN.md` is the **decision** document (NOVA's tokens, chosen values).
This is the **evidence** document: what Toss actually publishes, at what value,
from which source, and where the dark-desktop translation is extrapolation.

Compiled 2026-07-25.

---

## 0. How to read this document

Every claim carries one of four markers:

| Marker | Meaning |
|---|---|
| **[V-CODE]** | Verified by reading shipped TDS source published to npm. Highest confidence — these are the literal numbers Toss's components run on. |
| **[V-DOC]** | Verified from a Toss-owned URL (toss.tech, tossmini-docs.toss.im, developers-apps-in-toss.toss.im, toss.im). URL given. |
| **[D]** | **Derived.** Computed from a [V-CODE]/[V-DOC] value by a stated method. Defensible, but Toss never published this number. |
| **[X]** | **Extrapolation / NOVA decision.** Toss publishes nothing here. Do not describe as "Toss says". |

Rough proportions of this document: **~60% [V-CODE]**, **~20% [V-DOC]**,
**~12% [D]**, **~8% [X]**.

### The primary sources

**Shipped code (read directly, all public on npm/jsDelivr):**

| Package | Version | What it gave |
|---|---|---|
| `@toss/tds-colors` | 0.1.0 | The complete light + dark primitive palette, every hex |
| `@toss/tds-typography` | 0.0.3 | The complete 20-token type scale, icon/badge/link scaling maps, OS text-scaling ramps |
| `@toss/tds-easings` | 0.0.1 | All 5 cubic-beziers, all 8 spring presets, and the spring integrator itself |
| `@toss/tds-spring-easing` | 0.0.1 | Same integrator, standalone |
| `@toss/tds-react-native` | 2.0.4 | Every component's real metrics: paddings, radii, heights, spring choices per interaction |

**Toss-owned documentation and articles:**

- <https://tossmini-docs.toss.im/tds-mobile/> — TDS Mobile (web) component docs
- <https://tossmini-docs.toss.im/tds-react-native/foundation/typography/> — type scale
- <https://tossmini-docs.toss.im/tds-mobile/foundation/colors/> — colors
- <https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-overview/> — ListRow
- <https://tossmini-docs.toss.im/tds-mobile/components/button/> — Button
- <https://tossmini-docs.toss.im/tds-mobile/components/skeleton/> — Skeleton archetypes
- <https://toss.tech/article/tds-color-system-update> — the 2025-12-15 OKLCH color rebuild (윤민석, 권윤)
- <https://toss.tech/article/interaction> — the motion doctrine (박연주, 김지혜, 2023-09-07)
- <https://toss.tech/article/toss-design-system> — TDS overview (박수현, 2024-03-05)
- <https://toss.tech/article/toss-design-system-guide> — how TDS documents components (황희영, 2024-04-05)
- <https://toss.tech/article/insurance-claim-process> — "Easy to answer" + the 3-second rule (김재현)
- <https://toss.tech/article/toss-signup-process> — "1 thing for 1 page" (정희연, Head of UX)
- <https://toss.tech/article/21004> — recommend exactly one thing (박다롱)
- <https://toss.tech/article/8-writing-principles-of-toss> — the 8 writing principles
- <https://toss.tech/article/how-to-write-error-message> — the 6 error principles (김자유)
- <https://toss.tech/article/introducing-toss-error-message-system> — "Navigating error"
- <https://toss.im/tossfeed/article/beginning-of-tps> — Toss Product Sans design notes
- <https://toss.im/slash-23/session-detail/B2-2> — Rally, the internal motion library
- <https://developers-apps-in-toss.toss.im/design/prepare/design.html> — App-in-Toss design prep

---

## 1. What `DESIGN.md` already had, and what this adds

### `DESIGN.md` already covers well — do not re-derive

1. **The three-tier token architecture** (primitive → semantic → component) and the
   `data-theme` single-attribute switch. Correct, and it matches Toss's published
   Target/Role/Variant scheme.
2. **The "caption is the protagonist" framing** and the two override rules
   (no explanatory copy; the gradient is never a fill).
3. **Pretendard as the Toss Product Sans substitute**, with the Sandoll 고딕neo1 →
   Apple SD Gothic Neo → Pretendard ancestry argument and the 0.1% `가` advance
   measurement. That reasoning is sound and this document does not repeat it.
4. **The line-height derivation rule** (`11–17 → ×1.5`, `18–29 → +9`, `30+ → +10`).
   Confirmed exactly against source — see §3.3.
5. **Elevation by surface-lightening rather than shadow**, and the four-step dark
   ramp `#101013 → #17171c → #202027 → #2c2c35`. Those are real TDS values.
6. **`greyOpacity` as the mechanism** for state overlays that composite correctly
   over any surface in either mode. Correct and important.
7. **Speaker-colour rotation, caption ramp, in-progress/committed treatment,
   scroll and overlay behaviour** — all Naver/Papago-derived, out of scope here.
8. **The repo implementation constraints** (`root/`+`public/` duplication, brand
   guard tests, rename scope). Untouched.

### What this document adds that `DESIGN.md` lacks

1. **The complete palette**, not a sample: 11 hue families × 10 steps, light *and*
   dark, plus `greyOpacity`, `whiteOpacity`, `inverseGrey`, and the two
   **desktop-only** tokens `lightThemePcScreenBg` / `darkThemePcScreenBg`. §2.
2. **The full 20-step type scale** with the interleaved `st*` tokens — `DESIGN.md`
   lists 7 of 20. §3.2.
3. **The list-row line-height exception**: inside `ListRow`, line-height is
   `fontSize × 1.35`, not `× 1.5`. `DESIGN.md` misses this entirely, and it is the
   single biggest density lever in the system. §3.3.
4. **The icon-size-per-type-token table** — exact integers, not "~1.10–1.15×". §3.4.
5. **The complete motion system with computed durations**: all 5 beziers, all 8
   spring presets, their exact settling times computed from Toss's own integrator,
   overshoot behaviour, and a fitted `cubic-bezier` for each. §5.
6. **Which spring each interaction uses**, asymmetrically — press-in `rapid`,
   press-out `quick`. §5.4.
7. **The ListRow taxonomy**: 15 named content archetypes + 10 right-side
   archetypes, with the exact typography/weight pair for every line. §6.2.
8. **Corrections to `DESIGN.md`** on button typography, switch travel, segmented
   control geometry, shadow values, and letter-spacing. §10.
9. **The date-grouped-list construction** from real TDS parts. §8.
10. **An explicit, auditable dark-desktop derivation** for a `#0A0A0B` base,
    with contrast ratios computed. §9.

---

## 2. Colour

### 2.1 The primitive palette — light [V-CODE]

Source: `@toss/tds-colors@0.1.0/colors.css`. These are the literal published values.
11 families, steps `50, 100, 200, …, 900`.

| Step | grey | blue | red | orange | yellow | green | teal | purple |
|---|---|---|---|---|---|---|---|---|
| 50 | `#f9fafb` | `#e8f3ff` | `#ffeeee` | `#fff3e0` | `#fff9e7` | `#f0faf6` | `#edf8f8` | `#f9f0fc` |
| 100 | `#f2f4f6` | `#c9e2ff` | `#ffd4d6` | `#ffe0b0` | `#ffefbf` | `#aeefd5` | `#bce9e9` | `#edccf8` |
| 200 | `#e5e8eb` | `#90c2ff` | `#feafb4` | `#ffcd80` | `#ffe69b` | `#76e4b8` | `#89d8d8` | `#da9bef` |
| 300 | `#d1d6db` | `#64a8ff` | `#fb8890` | `#ffbd51` | `#ffdd78` | `#3fd599` | `#58c7c7` | `#c770e4` |
| 400 | `#b0b8c1` | `#4593fc` | `#f66570` | `#ffa927` | `#ffd158` | `#15c47e` | `#30b6b6` | `#b44bd7` |
| **500** | **`#8b95a1`** | **`#3182f6`** | **`#f04452`** | **`#fe9800`** | **`#ffc342`** | **`#03b26c`** | **`#18a5a5`** | **`#a234c7`** |
| 600 | `#6b7684` | `#2272eb` | `#e42939` | `#fb8800` | `#ffb331` | `#02a262` | `#109595` | `#9128b4` |
| 700 | `#4e5968` | `#1b64da` | `#d22030` | `#f57800` | `#faa131` | `#029359` | `#0c8585` | `#8222a2` |
| 800 | `#333d4b` | `#1957c2` | `#bc1b2a` | `#ed6700` | `#ee8f11` | `#028450` | `#097575` | `#73228e` |
| 900 | `#191f28` | `#194aa6` | `#a51926` | `#e45600` | `#dd7d02` | `#027648` | `#076565` | `#65237b` |

Plus `--white #ffffff`, `--black #000000`.

> Note the grey ramp is **cool and blue-biased**, not neutral: `grey900 #191f28`
> is a desaturated navy, not `#1a1a1a`. Every Toss screen inherits a faint cool
> cast from this. If you go neutral-grey the app stops looking like Toss.

### 2.2 The dark palette [V-CODE]

Source: `colors.dark.css`. In dark mode every `adaptive*` token remaps.
Two things matter structurally:

**(a) The greys invert *and compress*.** `adaptiveGrey900` is pure white, and the
dark ramp is a different set of values, not an inversion of the light ramp:

| Token | Dark value | Light counterpart |
|---|---|---|
| `adaptiveGrey900` | `#ffffff` | `#191f28` |
| `adaptiveGrey800` | `#e4e4e5` | `#333d4b` |
| `adaptiveGrey700` | `#c3c3c6` | `#4e5968` |
| `adaptiveGrey600` | `#9e9ea4` | `#6b7684` |
| `adaptiveGrey500` | `#7e7e87` | `#8b95a1` |
| `adaptiveGrey400` | `#62626d` | `#b0b8c1` |
| `adaptiveGrey300` | `#4d4d59` | `#d1d6db` |
| `adaptiveGrey200` | `#3c3c47` | `#e5e8eb` |
| `adaptiveGrey100` | `#2c2c35` | `#f2f4f6` |
| `adaptiveGrey50` | `#202027` | `#f9fafb` |

Note the dark greys are **violet-biased** (hue ≈ 285° in OKLCH), where the light
greys are blue-biased (~250°). Toss shifts hue between modes deliberately.

**(b) Hue accents get their own dark values — brighter, less saturated.**

| Family | Light 500 | Dark 500 | Light 600 | Dark 600 |
|---|---|---|---|---|
| blue | `#3182f6` | `#3485fa` | `#2272eb` | `#449bff` |
| red | `#f04452` | `#f04251` | `#e42939` | `#fa616d` |
| green | `#03b26c` | `#16bb76` | `#02a262` | `#26cf88` |
| yellow | `#ffc342` | `#ffb134` | `#ffb331` | `#ffc259` |
| orange | `#fe9800` | `#f18600` | `#fb8800` | `#fd9528` |
| teal | `#18a5a5` | `#2eaab2` | `#109595` | `#43bec7` |
| purple | `#a234c7` | `#ae3dd1` | `#9128b4` | `#c353e5` |

Full dark 50–900 for every hue is in `colors.dark.css` if you need more steps.

### 2.3 The surface ladder [V-CODE]

This is the load-bearing structure and it is **explicitly named by depth**:

| Semantic | Light | Dark | Role |
|---|---|---|---|
| `BackgroundLevelB01` / `greyBackground` | `#f2f4f6` | `#101013` | *Below* base — recessed wells, the gutter between sections |
| `Background` | `#ffffff` | `#17171c` | Base page |
| `BackgroundLevel01` / `layeredBackground` | `#ffffff` | `#202027` | Cards, sheets, list surfaces |
| `BackgroundLevel02` / `floatBackground` | `#ffffff` | `#2c2c35` | Dialogs, tooltips, dropdowns, toasts |
| `HairlineBorder` | `#e5e8eb` | `#3c3c47` | Border between two same-level surfaces |
| `BackgroundDimmed` | `rgba(0,0,0,0.2)` | `rgba(0,0,0,0.56)` | Modal scrim |
| **`PcScreenBg`** | **`#f6f7f9`** | **`#202027`** | **Desktop/PC screen background** |

**The asymmetry is the whole model.** In light mode all four levels are `#ffffff`
except the recessed one — depth is expressed by the *gutter* being grey while
content is white. In dark mode all four differ — depth is expressed by
**progressive lightening**. There is no shadow in either model.

> `PcScreenBg` is the only desktop-specific token in the whole palette, and its
> dark value `#202027` equals `BackgroundLevel01`. Read as: on desktop, Toss
> treats the *whole window* as if it were one elevation step up. [V-CODE]

### 2.4 Alpha overlay ramps [V-CODE]

The mechanism that lets one component composite over any surface in either mode.

`greyOpacity*` (light mode) — a very dark navy at increasing alpha:

```
greyOpacity50   rgba(0,23,51,0.02)
greyOpacity100  rgba(2,32,71,0.05)
greyOpacity200  rgba(0,27,55,0.10)
greyOpacity300  rgba(0,29,58,0.18)
greyOpacity400  rgba(0,25,54,0.31)
greyOpacity500  rgba(3,24,50,0.46)
greyOpacity600  rgba(0,19,43,0.58)
greyOpacity700  rgba(3,18,40,0.70)
greyOpacity800  rgba(0,12,30,0.80)
greyOpacity900  rgba(2,9,19,0.91)
```

`whiteOpacity*` / dark-mode `adaptiveOpacity*` — a **violet-tinted** white:

```
adaptiveOpacity50   rgba(209,209,253,0.05)
adaptiveOpacity100  rgba(217,217,255,0.11)
adaptiveOpacity200  rgba(222,222,255,0.19)
adaptiveOpacity300  rgba(224,224,255,0.27)
adaptiveOpacity400  rgba(232,232,253,0.36)
adaptiveOpacity500  rgba(242,242,255,0.47)
adaptiveOpacity600  rgba(248,248,255,0.60)
adaptiveOpacity700  rgba(253,253,255,0.75)
adaptiveOpacity800  rgba(253,253,254,0.89)
adaptiveOpacity900  rgba(255,255,255,1)
```

**Three overlays are non-negotiable if you want Toss-feel:**

| Use | Light | Dark |
|---|---|---|
| Press / hover overlay on any row or icon button | `greyOpacity100` = `rgba(2,32,71,0.05)` | `adaptiveOpacity100` = `rgba(217,217,255,0.11)` |
| Divider / hairline rule | `greyOpacity300` = `rgba(0,29,58,0.18)` | `adaptiveOpacity300` = `rgba(224,224,255,0.27)` |
| `IconButton` default background | `greyOpacity100` | `adaptiveOpacity100` |

> The dark press overlay is **11%**, not 4–8%. And it is *violet-white*
> `rgb(217,217,255)`, not pure white. `DESIGN.md`'s `rgba(255,255,255,0.04)` /
> `0.08` are noticeably weaker and hue-neutral. §10 lists this as a correction.

### 2.5 The restraint rule for blue [V-CODE] + [V-DOC]

The mechanism, not an adjective:

**There is exactly one seed colour for the entire theme.**
`core/theme/seedToken/seedToken.js` reduces to `{ color: { primary: blue500 } }`.
Everything else a button needs — its weak fill, its text colour, its press dim,
its loader colour, its press gradient — is **computed from that one value** by
`ButtonDerivedTokenGenerator`, which converts the seed to OKLCH and branches on
lightness. [V-CODE]

The generator's actual thresholds, verbatim in behaviour:

| Seed OKLCH `L` | fill background | fill text | weak background | weak text |
|---|---|---|---|---|
| `L < 0.40` | seed | `#fff` | `grey700 @ 7%` | `grey700` |
| `0.40 ≤ L ≤ 0.525` | seed | `#fff` | seed `@ 8%` | seed |
| `0.525 < L ≤ 0.645` | seed | `#fff` | seed `@ 9%` | seed at `L=0.525` |
| `0.645 < L < 0.70` | seed clamped to `L=0.645` | `#fff` | seed `@ 11%` | seed at `L=0.525` |
| `0.70 ≤ L ≤ 0.75` | seed clamped to `L=0.645` | `#fff` | seed `@ 13%` | seed at `L=0.525` |
| `0.75 < L < 0.80` | seed clamped to `L=0.645` | `#fff` | seed `@ 15%` | seed at `L=0.525` |
| `L ≥ 0.80` | seed | `greyOpacity800` | `grey700 @ 7%` | `grey700` |

Also: press dim = `#000` (or `rgba(0,0,0,0.5)` if the seed is very light); the
press gradient start is the fill colour darkened by `ΔL = −0.134`. [V-CODE]

**What this means for implementation.** The "restraint" is not a style guideline
you have to remember — it is enforced because **there is only one accent value in
the system and its tints are all derived from it.** Copy that: one accent
variable; every tint an alpha or a lightness offset of it; no second blue.

The alpha values `7–15%` are the entire tinted-badge/weak-button system. Toss
never hand-picks a tint. (`DESIGN.md`'s single `0.16` alpha is in the right family
but is one number where Toss uses a lightness-dependent curve.)

**Where blue is *not* used.** Verified from the code paths: `Button` colour options
are `primary | danger | light | dark` only, mapping to
`blue500 / red500 / whiteOpacity900 / grey700` [V-CODE]. So a Toss screen has at
most one blue thing and at most one red thing, and everything else is grey. The
`ListFooter` "see more" row is the one other blue element — `t5 / medium /
blue500` at row height 59. [V-CODE]

### 2.6 Semantic colours and when Toss uses them

[V-CODE] from component source, so this is behaviour rather than doctrine:

| Colour | Token | Verified use in TDS source |
|---|---|---|
| Blue | `blue500 #3182f6` | The single primary action; `ListFooter` link row; `Loader` primary (`#3188ff` — see below) |
| Red | `red500 #f04452` | `Button color="danger"` only |
| Green | `green500 #03b26c` | No component in `tds-react-native@2.0.4` uses it. It exists as a primitive for product-level gain/positive amounts. |
| Yellow / Orange | `yellow500`, `orange500` | Likewise unused by any component. |
| Grey | `grey600/700/800/900` | Everything else. |

**There is no "warning" component in TDS.** No banner, no alert strip, no
inline caution box. Warnings are delivered by `Dialog` (explains) or `Toast`
(notifies) with the standard grey/blue treatment — colour is not the carrier.
That is consistent with the published error doctrine: *"경고 문구를 화면에 채워
넣기 보다는"* — don't pre-fill the screen with warnings.
[V-CODE for the absence; [V-DOC] <https://toss.tech/article/how-to-write-error-message> for the doctrine]

> **Curiosity worth knowing:** `Loader` hardcodes `primary: "#3188ff"` — a
> *different* blue from `blue500 #3182f6`. [V-CODE] It is almost certainly a
> legacy typo that shipped. Use `blue500`; do not replicate.

### 2.7 The 2025 OKLCH rebuild [V-DOC]

Source: <https://toss.tech/article/tds-color-system-update> (2025-12-15).
The palette in §2.1–2.2 is the **pre-rebuild** system — it is what the published
npm package still ships, and it is what the Toss app looked like for 7 years
(2018 → 2025). The rebuild changes the *generation method*, and its concrete
outputs are **not published**.

What is verified:

- Adopted **OKLCH** so that a given numeric step reads as the same perceived
  lightness across all hues. Verbatim: *"OKLCH를 기준으로 명도를 통일하면 훨씬
  균일한 색대비를 가지게 돼요."*
- The problem being fixed, with numbers: `Grey 100` was **1.1:1** contrast while
  `Red 100` was **1.34:1**; the same `Teal 50` was **1.06:1** in light mode and
  **1.36:1** in dark mode.
- **The dark-mode rule, verbatim:** *"다크모드에서는 명도대비를 더 강하게 가지도록
  설계했어요."* — dark mode is designed to carry **stronger** lightness contrast
  than light mode.
- New semantic naming is **Target · Role · Variant**:
  - Target = `fill` | `text` | `border`
  - Role = `brand` | `neutral` | `primary` | `secondary`
  - Variant = `weak` | `alt`
  - Published examples: `fill-brand`, `button-fill-primary`
- Pipeline: Token Studio (Figma) → GitHub → Style Dictionary → CSS/TS/native.

What is **not** published, and must not be invented: the number of lightness
steps, the OKLCH `L` values, per-step contrast targets, and any WCAG number.
Toss has never stated a contrast target.

**Actionable takeaway:** adopt the naming (`fill-*` / `text-*` / `border-*` ×
role × variant) and the "dark mode gets stronger contrast" rule. Do not claim to
be using Toss's OKLCH values, because they are not public.

---

## 3. Typography

### 3.1 Family and licensing

**Toss Product Sans (TPS)** [V-DOC] <https://toss.im/tossfeed/article/beginning-of-tps>

- Commissioned from **Sandoll**, started summer 2020, **14 consultations over 7 months**;
  IdoType joined from v2. First release shipped **7 weights**.
- Latin and numerals are drawn **deliberately heavier than the Hangul** — matching them
  exactly made the Latin look too thin: *"완벽하게 국문과 동일한 두께로 맞추면 숫자,
  영문이 너무 얇아 보이기 때문에 국문보다 조금 더 두껍게 디자인했고요."*
- Symbols (`%`, `,`, `+`, `−`, `→`) were individually re-sized and re-spaced to work as
  UI elements rather than as punctuation.
- Vertical metrics were tuned for multi-script: Vietnamese diacritics pushed the ascender
  up, which made Hangul sit optically low, so the **descender was lowered** to
  re-centre the Hangul.
- **Ships both proportional and tabular numerals.** The stated rule: tabular for large
  and live-updating numbers, proportional for single numbers.
  *"프로덕트 산스는 가변폭과 고정폭 숫자를 마련해 주식 수, 전체 매출액 등 큰 수와
  실시간으로 반영되는 수치들에는 고정폭을 활용"*
- **Licensing is not disclosed and TPS is not distributed.** The `Txt` component in
  `@toss/tds-react-native` has its `fontFamily` string **deliberately obfuscated**
  (XOR-encoded at runtime) — a strong signal that the family name is not meant to be
  reused. [V-CODE] Do not ship or hotlink it.
- **TDS sets no `letter-spacing` anywhere.** Zero occurrences of `letterSpacing` in
  the entire `@toss/tds-react-native@2.0.4` bundle. [V-CODE] The tracking is baked
  into TPS's metrics. See §10 for what this means for `DESIGN.md`'s `-0.02em`.

### 3.2 The complete scale — all 20 tokens [V-CODE]

Source: `@toss/tds-typography@0.0.3`, `TYPOGRAPHY_RULE_ORDER` zipped with
`defaultTypographyRule` and `textSizeMap`. `t*` are the named tiers; `st*` are the
in-between steps. Ordered largest → smallest exactly as TDS orders them.

| Token | px | line-height | Notes |
|---|---|---|---|
| `t1` | 30 | 40 | very large heading; `TextField` hero/big input |
| `st1` | 29 | 38 | |
| `st2` | 28 | 37 | `Top` title, large variant |
| `st3` | 27 | 36 | |
| `t2` | 26 | 35 | large heading |
| `st4` | 25 | 34 | |
| `st5` | 24 | 33 | |
| `st6` | 23 | 32 | |
| `t3` | 22 | 31 | standard heading; `Top` title default; `DatePicker` month caption |
| `st7` | 21 | 30 | |
| `t4` | 20 | 29 | small heading; `Dialog` title; `BottomSheet` header |
| `st8` | 19 | 28 | `Dropdown` item |
| `st9` | 18 | 27 | **`Button` large + xlarge label** |
| **`t5`** | **17** | **25.5** | **default body.** ListRow primary line, `DatePicker` day number |
| `st10` | 16 | 24 | `TableRow` both sides |
| **`t6`** | **15** | **22.5** | small body; `Button` medium; `Toast` message; `Dialog` body |
| `st11` | 14 | 21 | `GridList` item |
| **`t7`** | **13** | **19.5** | "optional reading"; `Button` small; timestamps, meta |
| `st12` | 12 | 18 | |
| `st13` | 11 | 16.5 | "non-essential reading"; badges |

Weights [V-CODE] `constants/typography/fontWeight.js`:
`thin 100 · extraLight 200 · light 300 · regular 400 · medium 500 · semiBold 600 · bold 700 · extraBold 800 · heavy 900 · black 900`.
In practice TDS components use only **400 / 500 / 600 / 700**.

### 3.3 The line-height law — and the ListRow exception

**The law** [D from V-CODE `textSizeMap`, which covers every integer 11–42]:

```
11 ≤ px ≤ 17  →  lineHeight = px × 1.5
18 ≤ px ≤ 29  →  lineHeight = px + 9
     px ≥ 30  →  lineHeight = px + 10
```

Verified against all 32 entries: `17→25.5`, `18→27`, `29→38`, `30→40`, `42→52`. `DESIGN.md` states this rule and it is exactly right. Implement it as a function; do not hardcode.

**The exception — and this is the important part.** [V-CODE]
`components/list-row/ListRowTexts/ListRowTxt.js` overrides line-height:

```js
lineHeight: typography[token].fontSize * token('line-height-s')
```

and `tokens/token.js` defines:

```js
'line-height-xs': 1.252
'line-height-s' : 1.35
'line-height-m' : 1.5
```

So **inside a `ListRow`, line-height is `fontSize × 1.35`, not the default `× 1.5`.**
A `t5` line is `17 × 1.35 = 22.95px`, not `25.5px` — **2.55px tighter per line**.
The same override applies to `ListRowRightTxt`.

This is Toss's density mechanism and it is invisible in the type table. Long
scrolling lists are typographically tighter than body prose *by design*, which is
why Toss lists feel dense without feeling small. `DESIGN.md` does not mention it.

### 3.4 Icon size per type token [V-CODE]

`iconSizeMap` gives an exact icon height for every font size 11–42 so that icons
track type through OS text scaling. Excerpt at the sizes you will actually use:

| Type token | px | Icon height | Ratio |
|---|---|---|---|
| `t1` | 30 | 34 | 1.133 |
| `t3` | 22 | 25 | 1.136 |
| `t4` | 20 | 22 | 1.100 |
| `t5` | 17 | 19 | 1.118 |
| `st10` | 16 | 18 | 1.125 |
| `t6` | 15 | 17 | 1.133 |
| `st11` | 14 | 15 | 1.071 |
| `t7` | 13 | 14 | 1.077 |
| `st12` | 12 | 13 | 1.083 |
| `st13` | 11 | 12 | 1.091 |

Full map (fontSize → iconHeight): 11→12, 12→13, 13→14, 14→15, 15→17, 16→18,
17→19, 18→20, 19→21, 20→22, 21→24, 22→25, 23→26, 24→27, 25→28, 26→29, 27→31,
28→32, 29→33, 30→34, 31→35, 32→36, 33→38, 34→39, 35→40, 36→41, 37→42, 38→43,
39→44, 40→46, 41→47, 42→48.

Note `IconButton`'s own default `iconSize` is **24** with padding `iconSize/2 = 12`
(special-cased to `9` for sizes 18–20), and its radius is `≤16 → 6`, `≤20 → 8`,
else `12`. [V-CODE]

### 3.5 Badge and link scaling [V-CODE]

`badgeSizeMap[fontSize] → { fontSize, padding:[v,h], borderRadius }`, and TDS's
`Badge` component maps its size names onto type tokens
(`tiny→t5`, `small→t3`, `medium→t2`, `large→t1`). Resolved:

| Badge size | via token | font-size | padding | radius |
|---|---|---|---|---|
| `tiny` | `t5` (17) | 10 | `3px 7px` | 9 |
| `small` | `t3` (22) | 12 | `3px 7px` | 11 |
| `medium` | `t2` (26) | 13 | `3px 7px` | 12 |
| `large` | `t1` (30) | 14 | `4px 8px` | 13 |

`linkSizeMap` gives underline thickness per size — for `t5` (17px):
`lightThickness 1`, `boldThickness 1.3`, `horizontalPadding 4`, `borderRadius 4`.
At `t7` (13px): `0.7 / 1`. [V-CODE] Underline weight scales with type; it is not `1px` everywhere.

### 3.6 OS text-scaling ramps [V-CODE]

TDS never hardcodes sizes. It swaps the **whole 20-value rule array** per
accessibility level. iOS levels and their scale factors:

```
Large 100 · xLarge 110 · xxLarge 120 · xxxLarge 135
A11y_Medium 160 · A11y_Large 190 · A11y_xLarge 235
A11y_xxLarge 275 · A11y_xxxLarge 310
```

The `Large` (default) rule array, in `TYPOGRAPHY_RULE_ORDER` order, is:

```
[30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11]
```

At `xxLarge` it becomes `[34,33,32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15]`
— i.e. **`t5` body goes 17 → 21**, and the smallest token `st13` goes 11 → 15.
Android derives its array as `round(min(baseSize × scale/100, cap))` with per-token caps
`[42,42,41,41,41,41,40,40,40,40,40,40,39,39,39,37,36,34,32,31]`.

**The desktop translation** [X]: Electron has no OS text-scale signal equivalent to
iOS's Dynamic Type. Ship the same mechanism anyway — one CSS variable per token
(`--font-size-t5`, `--line-height-t5`) written from a single JS rule array, plus a
user-facing scale control. `DESIGN.md` §12 already calls for this; the arrays above
give you real ramps to use instead of inventing multipliers.

### 3.7 Korean-specific handling [V-CODE]

**Line breaking.** `components/paragraph/Paragraph.js` sets
`lineBreakStrategyIOS: "hangul-word"` on every `Paragraph`. That is the iOS-native
equivalent of CSS `word-break: keep-all` — break at word boundaries, never mid-word.
So `DESIGN.md`'s `word-break: keep-all` recommendation now has a **Toss** source, not
just a Naver one. On the web, the correct pair is:

```css
word-break: keep-all;
overflow-wrap: break-word;   /* so an unbreakable URL still can't overflow */
```

**Letter-spacing: none.** See §3.1 — TDS sets none. [V-CODE]

**Numerals.** Toss's rule is font-level tabular figures for large/live numbers
[V-DOC], and `tabular-nums` appears **0 times** in the TDS bundle [V-CODE]. With
Pretendard you must ask for it explicitly:

```css
.tnum { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
```

Apply to: elapsed time, clock, counters, any number that changes in place. [X]

**Inline code inside prose.** `ParagraphCode` is a real component: background
`opacity100`, border `1px opacity200`, `padding: 0 4px`, radius by font size
(`<19 → 4`, `<23 → 5`, `<29 → 6`, `<41 → 8`, else `10`), and it is optically
raised via a `top` correction so the box centres on the text baseline. [V-CODE]

---

## 4. Spacing, radius, elevation, density

### 4.1 Spacing [V-CODE]

TDS publishes **no spacing token scale.** There is no `spacing.md`, no
`@toss/tds-spacing`, and no `space[]` array in any package. What exists is a set of
values used consistently across components:

| Value | Where it appears in TDS source |
|---|---|
| **24** | The universal horizontal inset. `ListRow.paddingHorizontal`, `ListHeader.marginHorizontal`, `Top.paddingHorizontal`, `TableRow.paddingHorizontal`, `Dropdown` item, `BottomSheet.Header.paddingLeft`, `SegmentedControl.Root.paddingHorizontal`, `TextField.paddingHorizontal` |
| **20** | The narrow inset variant. `ListRow horizontalPadding="small"`, `BottomCTA.paddingHorizontal` |
| **16** | Row vertical padding (`TableRow`, `TextField`), `right` slot gap in `ListRow`, `Result.button` top gap, `Border height16` |
| **12** | `ListRow verticalPadding="medium"` (web default), `Dropdown` item vertical, `Result.figure` bottom |
| **8** | `ListHeader.marginBottom`, `Dialog.body` top gap, gaps between stacked headers |
| **4** | `ListHeader.upper/lower` gaps, `ListRow` press-underlay vertical inset |

So the honest statement is: **base unit 4, primary layout inset 24, secondary 20,
row rhythm 16/12/8/4.** [D] `DESIGN.md`'s "4px base, layout steps 8/16/24, free 1px
granularity inside components" is consistent with the code and can stand.

**24px is confirmed as the standard side margin** [V-CODE] — it is the single most
repeated number in the entire library.

### 4.2 Radius [V-CODE]

TDS publishes no radius scale either. Radius is **anchored to component height**.
Every radius actually shipped in `@toss/tds-react-native@2.0.4`:

| Radius | Component |
|---|---|
| `4` | `Highlight`/`ParagraphCode` small, `BottomSheet` handle, `ListRowImage` thumbnail (34×54, 30×47) |
| `6` | **`Skeleton` default**, `IconButton` at icon ≤16 |
| `8` | `Button small`, `SegmentedControl` indicator (small), `TextButton` hit area, `IconButton` at icon ≤20, `NumericSpinner` |
| `9` | `GridList` item |
| `10` | `Button medium`, `SegmentedControl` group (small), `SegmentedControl` indicator (medium), `Tab` indicator, `ListRowImage` 54×54 |
| `12` | **`ListRow` press underlay**, `SegmentedControl` item, `IconButton` default, `BottomSheet.Select` row |
| `14` | `Button large`, **`TextField` box** |
| `15` | `SegmentedControl` group (medium), `Switch` track (= height/2), `TextButton` level5 hit area |
| `16` | **`Button xlarge`**, `Dropdown` panel |
| `20` | `ListRowIcon`/`ListRowImage` 40×40 avatar (= height/2) |
| `24` | **`Dialog`** |
| `28` | **`BottomSheet`** |
| `99` / `100` | Button loader dots, `Toast` button, `ProgressBar` |
| `999` | `ListRow` blink effect overlay |
| `50%` | `DatePicker` selected day, `DatePicker` today dot |

**The pattern is legible:** *the larger and more floating the surface, the larger the
radius.* Small controls 8–12, medium containers 14–16, dialogs 24, sheets 28.
Note `Dialog` 24 < `BottomSheet` 28 — the sheet is the softer of the two.

`DESIGN.md`'s ladder (`4 / 8 / 12 / 16 / pill`) is a defensible simplification, but
**it misses that Toss's biggest containers are 24–28, not 16.** For a desktop app
with large panels, going to 20–24 on major surfaces is more Toss-like than capping
at 16. [D]

### 4.3 Elevation and shadow [V-CODE] — with a docs conflict

**Confirmed: Toss ships exactly three shadow tokens.** `components/shadow/tokens.js`:

| Token | offsetY | blur radius | Light colour | Dark colour | Opacity |
|---|---|---|---|---|---|
| `tiny` | 1 | 3 | `greyOpacity200` `rgba(0,27,55,0.10)` | `greyOpacity900` `rgba(2,9,19,0.91)` | 1 |
| `weak` | 2 | 30 | `greyOpacity200` `rgba(0,27,55,0.10)` | `greyOpacity900` `rgba(2,9,19,0.91)` | 1 |
| `medium` | 16 | 60 | `greyOpacity300` `rgba(0,29,58,0.18)` | `greyOpacity900` `rgba(2,9,19,0.91)` | 1 |

Direction is a parameter: `shadow.medium('up')` flips `offsetY` negative — used by
`Tooltip` when it flips above its anchor. [V-CODE]

As CSS:

```css
/* light */
--shadow-tiny:   0 1px  3px rgba(0,27,55,0.10);
--shadow-weak:   0 2px 30px rgba(0,27,55,0.10);
--shadow-medium: 0 16px 60px rgba(0,29,58,0.18);
/* dark — all three use the same near-opaque near-black */
--shadow-tiny:   0 1px  3px rgba(2,9,19,0.91);
--shadow-weak:   0 2px 30px rgba(2,9,19,0.91);
--shadow-medium: 0 16px 60px rgba(2,9,19,0.91);
```

> **⚠️ Conflict to be aware of.** The RN docs page
> <https://tossmini-docs.toss.im/tds-react-native/components/shadow/> presents a
> table of `Weak / Medium / Strong` with `radius 4/10/20`, `opacity 0.05/0.1/0.15`,
> `offset y 1/2/4`. Those are **prop examples on the doc page**, and they do not
> match the shipped `shadow` token object. **Trust the code values above.** If you
> want the doc-page values instead, know that you are copying documentation
> examples, not the design system.

**Where shadow is actually used** — only three places in the whole library:
`Tooltip` (`shadowRadius 60`, `offsetY ±16`, `elevation 40`), `Radio`'s moving
segment (`shadowRadius 1`, `opacity 0.09`), and via the explicit `useShadow` hook.
**`Button`, `ListRow`, `Dialog`, `BottomSheet`, `Toast`, and `Dropdown` have no
shadow at all.** [V-CODE] They rely on the surface ladder.

**So `DESIGN.md`'s claim is confirmed and can be stated more strongly:** in TDS,
elevation is a *background colour step*, and shadow is reserved for things that
float over unpredictable content. On dark surfaces a `rgba(0,0,0,0.91)` shadow is
nearly invisible anyway — which is precisely why the ladder has to carry the depth.

Android has a distinct elevation curve [V-CODE] `calculateElevation`:
piecewise-linear through `{0:0, 3:1, 30:50, 50:125, 60:130, 80:145}`, clamped to
`MAX_ELEVATION 145`. Irrelevant to Electron but confirms shadow is treated as a
platform-mapped abstraction, not a literal CSS value.

### 4.4 Density

Three verified levers, in order of impact:

1. **The `ListRow` line-height override to 1.35** (§3.3) — the big one.
2. **`ListRow verticalPadding`**, which is where Toss's two published versions
   disagree:

   | | web (`tds-mobile`) | RN (`tds-react-native@2.0.4`) |
   |---|---|---|
   | small | 8 | 8 (`extraSmall`) |
   | medium | **12 (default)** | 16 (`small`) |
   | large | 16 | **24 (`medium`, default)** |
   | xlarge | 24 | 32 (`large`) |

   [V-DOC for web, V-CODE for RN.] They are the same ladder read at a different
   offset — RN's default row is twice as tall as web's. **For desktop, web's
   `12` is the right default** [D]; a pointer device does not need 24px of dead
   vertical space per row.
3. **`ListRow min-height 44px`** [V-DOC, web docs]. This is a **touch** minimum.
   See §11 — it should not survive on desktop.

---

## 5. Motion

This is the section where reading the source pays off most, because Toss's own
motion article deliberately publishes **names without numbers**, and the numbers
are in the npm package.

### 5.1 The published doctrine [V-DOC]

<https://toss.tech/article/interaction> (박연주, 김지혜, 2023-09-07):

- **Exactly two easing families.** Verbatim: *"bezier랑 spring 두 가지"*.
- **Easings must be named tokens, never raw numbers.** Verbatim:
  *"bezier.expo, spring.quick처럼 이름을 지어주는 일"*. The first thing they
  tokenised was easings, and nothing else.
- **One motion per target.** Verbatim:
  *"하나의 타겟엔 하나의 모션만 붙일 수 있다는 규칙을 만들자."*
  Sequencing across multiple targets is a separate concept (`Timeline`), with
  `parallel / serial / stagger` playback modes.
- **Motion is opt-out, not default.** Verbatim:
  *"정적인 UI로도 전달할 수 있는 가치라면 인터랙션은 Good to have가 되거든요."*
  — if a static UI already conveys the value, the interaction is merely nice-to-have.
- Implementation rule: developers build from Rally code or the Framer inspector,
  **never by eyeballing a reference video**.
- Rally (the internal library) took ~1 year to build and is not public.
  <https://toss.im/slash-23/session-detail/B2-2>

**⚠️ One myth to retire.** There is **no** published Toss rule saying *"no loading
animation when there's nothing to wait for."* `DESIGN.md` §2 quotes that sentiment;
it is not attributable to a Toss source I could find. What Toss actually documents
is the *opposite* nuance: in a loan flow, users believed the figures were fake, so
Toss **deliberately animated real products streaming in during the wait** to build
trust, and completion went up. [V-DOC, same article] The defensible rule is
**"loading must earn its keep"**, not "never show loading."

### 5.2 The five beziers [V-CODE]

`@toss/tds-easings@0.0.1`, `bezier`:

```css
--ease-linear: cubic-bezier(0,    0,    1,    1   );
--ease-ease:   cubic-bezier(0.6,  0,    0,    0.6 );   /* not a standard ease */
--ease-out:    cubic-bezier(0.25, 0.1,  0.25, 1   );
--ease-expo:   cubic-bezier(0.16, 1,    0.3,  1   );
--ease-back:   cubic-bezier(0.34, 1.56, 0.64, 1   );   /* overshoots */
```

`bezier.ease` `(0.6, 0, 0, 0.6)` is worth a second look — it is a **symmetric
S-curve that is slower in the middle** than CSS `ease`, i.e. an unusually
"deliberate" in-out. It is not `ease-in-out`. Do not substitute.

Observed usage [V-CODE]: `bezier.out` at `duration: 500` for `IconButton`
fill-background crossfade; `bezier.back` at `duration: 150` for `Checkbox`;
`bezier.linear` for every wiggle and every loader pulse. `bezier.expo` is the
one Toss names publicly for entrances.

### 5.3 The eight springs — with computed durations [V-CODE] + [D]

`@toss/tds-easings` defines the presets **and** ships the integrator that resolves
them (RK4, `dt = 1/60`, `tolerance = 0.01`, acceleration `= −k·x − c·v`; `mass` is
present in the type but marked `@deprecated 사용되지 않는 값입니다` and is
**ignored** by the solver). I re-implemented that exact integrator to get settling
times, so the durations below are **[D] — computed from Toss's own algorithm**, not
guessed and not published.

| Preset | stiffness | damping | **duration** | peak | overshoots? |
|---|---|---|---|---|---|
| `rapid` | 1000 | 55 | **200.0 ms** | 1.0039 | barely (0.4%) |
| `quick` | 800 | 55 | **350.0 ms** | 0.9998 | no |
| `small` | 480 | 50 | **600.0 ms** | 0.9994 | no |
| `medium` | 270 | 25 | **566.7 ms** | 1.0251 | yes (2.5%) |
| `basic` | 200 | 30 | **766.7 ms** | 0.9991 | no |
| `bounce` | 300 | 15 | **800.0 ms** | 1.2211 | yes (22%) |
| `large` | 100 | 15 | **883.3 ms** | 1.0283 | yes (2.8%) |
| `slow` | 70 | 20 | **1433.3 ms** | 0.9978 | no |

Two other springs are used inline rather than via a preset [V-CODE]:
`{stiffness: 1000, damping: 52}` (Switch knob, SegmentedControl indicator, Radio at
`150/20`) and `{stiffness: 766, damping: 52}` (ListRow blink scale-up),
`{stiffness: 650, damping: 35}` (Checkbox), `{stiffness: 300, damping: 15}`
(Tooltip "strong" second phase — same as `bounce`).

**CSS translation [D].** Least-squares fits of a monotone `cubic-bezier` to each
spring's own ease function, sampled at 60 points:

| Preset | duration | fitted cubic-bezier | RMSE |
|---|---|---|---|
| `rapid` | 200 ms | `cubic-bezier(0.378, 0.838, 0.334, 1.024)` | 0.032 |
| `quick` | 350 ms | `cubic-bezier(0.282, 1.081, 0.338, 0.988)` | 0.020 |
| `medium` | 567 ms | `cubic-bezier(0.367, 1.150, 0.135, 1.031)` | 0.017 |
| `small` | 600 ms | `cubic-bezier(0.217, 0.892, 0.182, 1.016)` | 0.013 |
| `basic` | 767 ms | `cubic-bezier(0.276, 0.850, 0.182, 1.012)` | 0.011 |
| `large` | 883 ms | `cubic-bezier(0.372, 1.006, 0.101, 1.076)` | 0.015 |
| `slow` | 1433 ms | `cubic-bezier(0.230, 0.628, 0.117, 1.029)` | 0.008 |
| `bounce` | 800 ms | `cubic-bezier(0.324, 2.096, 0.000, 0.713)` | 0.040 |

`bounce` does not fit — a 22%-overshoot oscillation is not expressible as one
monotone bezier. If you need `bounce`, use a keyframe animation or `linear()`
with sampled stops. Everything else fits within ~2–3% and is safe as a CSS
transition. [D]

For maximum fidelity, modern CSS `linear()` can carry the sampled spring exactly;
the fitted beziers above are the pragmatic path.

### 5.4 Which motion goes on which interaction [V-CODE]

This is the part no article publishes, and it is asymmetric on purpose.

| Interaction | Motion | Values |
|---|---|---|
| **Press in** (any pressable) | `spring.rapid` (200 ms) | `scale 1 → 0.96`, underlay `opacity 0 → 1` |
| **Press out** | `spring.quick` (350 ms) | `scale → 1`, underlay `opacity → 0` |
| `IconButton` press | `spring.rapid` in / `quick` out | `scale 1 → 0.9` (deeper than 0.96) |
| `IconButton` fill-colour | `bezier.out`, `500 ms` | background crossfade |
| `Button` press dim | `spring.quick` | dim overlay `opacity → 0.26` |
| `Button` loading dim | `spring.quick` | dim overlay `opacity → 0.13` |
| `Button` press scale | `spring.rapid` | `0.96`, but see §6.1 — **`display: inline` scales the container; `block`/`full` scale only the label** |
| `Switch` knob travel | `{stiffness:1000, damping:52}` | `translateX 0 → 20`, `scale 1 → 1.5` |
| `Switch` press | `spring.rapid`/`quick` | `scale 0.96` |
| `SegmentedControl` indicator | `{stiffness:1000, damping:52}` | `translateX` |
| `Dialog` enter | `spring.quick` (350 ms) | content `opacity 0→1` + `scale 0.8→1`; dimmer `opacity 0→0.2` |
| `Dialog` exit | `spring.rapid` (200 ms) | content `opacity→0`, dimmer `→0`. **Scale is *not* animated back** — it fades without shrinking |
| `BottomSheet` open/close | `spring.quick` | `translateY` |
| `Tooltip` enter (normal) | `spring.medium` | `opacity 0→1` + `scale 0→1` from the anchored edge |
| `Tooltip` enter (strong) | `spring.quick` then `{300,15}` | `scale 0→1.25` then `1.25→1` — a two-phase overshoot |
| `Checkbox` | `bezier.back`, `150 ms` + `{650,35}` | |
| `ListRow` blink | `{766,52}` scale to `1.02`, then `spring.slow` back; dimmer `→0.04` after `480 ms` delay via `spring.basic` | |

**Rejection: the wiggle** [V-CODE] `useWiggleAnimation` — a **4-step sequence,
`87.5 ms` each, `bezier.linear`**, total **350 ms**:

```
small:  translateX  +2 → −2 → +1 → −1 → 0
big:    translateX  +4 → −4 → +2 → −2 → 0
```

Used when a **disabled `Switch` is pressed** and when a **`Dialog` dimmer is tapped
while `closeOnDimmerClick` is false**. The `NumericSpinner` variant runs 5 steps of
`87.5 ms` and fires a `wiggle` haptic. [V-CODE]

This is a real, citable Toss idiom: **a rejected input is answered with a
350 ms horizontal wiggle, not with silence and not with an error message.**
`DESIGN.md` mentions it for disabled buttons; the verified triggers are disabled
toggle and refused dismiss.

**Loading indicators** [V-CODE]:

- `Button` loading: three dots `8 × 8`, `border-radius 99`, `gap 7`, each pulsing
  `opacity 0.2 ↔ 1` on a **300 ms linear** loop, staggered. **Button width does not
  change.**
- `Skeleton`: default `border-radius 6`, background `grey200`. Shimmer is an
  **opacity pulse `0.2 ↔ 1` over 650 ms each direction**, plus a `100 ms` fade-in
  after the stagger delay — *not* a travelling gradient sweep. An optional vertical
  gradient mask (`5% → 95%`, background-coloured) fades the bottom of the block.
- `Loader`: sizes `small 24 / medium 36 / large 48`, inner `12 / 12 / 16`.

**Haptics** [V-CODE]: `IconButton` press fires `tickWeak`; the numeric-spinner
wiggle fires `wiggle`. There is no Electron equivalent — drop it, do not
substitute a sound.

### 5.5 A ready motion token set [D]

```css
:root {
  /* beziers — verbatim TDS */
  --ease-linear: cubic-bezier(0, 0, 1, 1);
  --ease-ease:   cubic-bezier(0.6, 0, 0, 0.6);
  --ease-out:    cubic-bezier(0.25, 0.1, 0.25, 1);
  --ease-expo:   cubic-bezier(0.16, 1, 0.3, 1);
  --ease-back:   cubic-bezier(0.34, 1.56, 0.64, 1);

  /* springs as duration + fitted bezier */
  --dur-rapid: 200ms;  --spring-rapid: cubic-bezier(0.378, 0.838, 0.334, 1.024);
  --dur-quick: 350ms;  --spring-quick: cubic-bezier(0.282, 1.081, 0.338, 0.988);
  --dur-med:   567ms;  --spring-med:   cubic-bezier(0.367, 1.150, 0.135, 1.031);
  --dur-basic: 767ms;  --spring-basic: cubic-bezier(0.276, 0.850, 0.182, 1.012);

  /* colour-only transitions: TDS uses timing, not springs */
  --dur-color: 300ms;  --ease-color: var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  :root { --dur-rapid:1ms; --dur-quick:1ms; --dur-med:1ms; --dur-basic:1ms; --dur-color:1ms; }
}
```

`ListRow` and `BottomSheetContainer` both check a `preferReducedMotion` flag and
skip their effects entirely rather than shortening them — mirror that for the
wiggle and the blink. [V-CODE]

Animate **only** `opacity`, `transform`, and colour. No component in TDS animates
`height`, `width`, or any layout property; `Rally`'s property list includes
`height`/`width` but no shipped component uses them. [V-CODE]

---

## 6. Core components

All values [V-CODE] from `@toss/tds-react-native@2.0.4` unless a docs URL is given.
Where the web package `@toss/tds-mobile` differs, both are shown.

### 6.1 Button

Internal size names differ from the public API. Mapping and metrics:

| Public size | internal | min-height | min-width | padding | radius | label token |
|---|---|---|---|---|---|---|
| `small` | `tiny` | **32** | 52 | `2px 10px` | **8** | `t7` (13/19.5) |
| `medium` | `medium` | **38** | 64 | `2px 16px` | **10** | `t6` (15/22.5) |
| `large` | `large` | **48** | 80 | `2px 16px` | **14** | **`st9` (18/27)** |
| `xlarge` *(default)* | `big` | **56** | 96 | `2px 28px` | **16** | **`st9` (18/27)** |

- `font-weight: semibold` (600) on every size. Labels are single-line.
- **`display: full` forces `border-radius: 0`.** `inline` adds `align-self: flex-start`.
  `block` and `full` are otherwise identical in style.
- Variants: **`fill`** (saturated) and **`weak`** (translucent tint). Colours:
  `primary → blue500`, `danger → red500`, `light → whiteOpacity900`, `dark → grey700`.
  All weak/dim/loader/gradient colours are *derived* from the seed — see §2.5.
- **Press:** `scale → 0.96` on `spring.rapid`, dim overlay `opacity → 0.26` on
  `spring.quick`, plus a `RadialGradient` wash at `width: 110%` whose start colour is
  the fill darkened by `ΔL −0.134`.
  **Critical asymmetry:** for `display: inline` the *container* scales; for
  `block`/`full` **only the label scales**, the container stays put. That is Toss's
  deliberate exception so a full-width bar doesn't visibly shrink from its gutters.
  `DESIGN.md` states "full-width buttons do NOT scale" — the code shows the label
  still does, which is the more faithful version.
- **Disabled:** `opacity 0.3` on iOS-style fills. Weak stays opaque, text dims.
- **Loading:** three `8×8` dots, `radius 99`, `gap 7`, `opacity 0.2 ↔ 1`, `300 ms`
  linear loop, staggered; dim overlay `0.13`. **Width does not change.**

Docs: <https://tossmini-docs.toss.im/tds-mobile/components/button/> confirms the
size/variant/display/state matrix but publishes **no pixel values** — those are
code-only.

### 6.2 ListRow — the signature component

**Geometry**

| Property | RN value | Web value |
|---|---|---|
| `paddingHorizontal` | 24 (fixed) | `small 20` / `medium 24` *(default)* |
| `verticalPadding` | `extraSmall 8` / `small 16` / `medium 24` *(default)* / `large 32` | `small 8` / `medium 12` *(default)* / `large 16` / `xlarge 24` |
| `min-height` | — | **44** |
| Press underlay | `margin: 4px 6px`, `border-radius: 12`, colour `greyOpacity100` (dark: `adaptiveOpacity100`) | same idiom |
| `right` slot | `margin-left: 16`, `max-width: 80%`, right-aligned | same |
| Divider (`indented`, default) | `Border type="padding24"` | `::before` on the row: `margin-left:24px; width:calc(100% - 24px); height:1px` |

> **The press underlay is inset, not full-bleed.** `4px` vertical and `6px`
> horizontal inside the row bounds, with `radius 12`. Pressing a Toss row highlights
> a floating rounded rectangle *inside* the row — it never touches the row edges or
> the divider. This one detail is most of why Toss lists feel like Toss.

> **The divider belongs to the row, not to the group**, and it is **left-inset 24px
> and bleeds to the right edge** (not inset on both sides). `DESIGN.md` gets the
> left inset right.

**Responsive reflow** [V-CODE]: at container width **≥ 560px**, or at large
accessibility text, `ListRow` switches to a **vertical** layout — the `right` slot
drops below `contents` at full width. Directly relevant to a desktop window that
can be narrow or wide.

`horizontalPadding: 0` is implemented as `marginHorizontal: -24`, i.e. it *cancels*
the built-in inset rather than setting zero.

**The content taxonomy — 15 named archetypes** [V-CODE]

Every row body in Toss is one of these. `Top / Middle / Bottom` are the stacked lines.

| Type | Top | Middle | Bottom |
|---|---|---|---|
| `1RowTypeA` | `t5` medium | — | — |
| `1RowTypeB` | `t5` semiBold | — | — |
| `1RowTypeC` | `t5` bold | — | — |
| `2RowTypeA` | `t5` bold | — | `t6` regular |
| `2RowTypeB` | `t4` semiBold | — | `t6` regular |
| `2RowTypeC` | `t5` bold | — | `t7` medium |
| `2RowTypeD` | `t6` regular | — | `t5` bold |
| `2RowTypeE` | `t6` regular | — | `t4` semiBold |
| `2RowTypeF` | `t7` medium | — | `t5` bold |
| `3RowTypeA` | `t5` bold | `t7` medium | `t7` medium |
| `3RowTypeB` | `t4` semiBold | `t6` medium | `t6` medium |
| `3RowTypeC` | `t7` medium | `t5` bold | `t7` medium |
| `3RowTypeD` | `t6` regular | `t4` semiBold | `t6` regular |
| `3RowTypeE` | `t7` medium | `t7` medium | `t5` bold |
| `3RowTypeF` | `t6` regular | `t6` regular | `t4` semiBold |

**Read the structure:** the `A/B/C` families are *label-above-value*; the
`D/E/F` families are the same shapes **inverted** so the emphasised line sits at the
bottom. Toss does not decide emphasis by position — it decides which line is the
*subject* and gives that line the heavier token, then places the label wherever the
scan order needs it. That is the mechanism behind "how Toss decides what is
emphasised" in §7.

**Right-side taxonomy — 10 archetypes** [V-CODE]

| Type | Top | Bottom |
|---|---|---|
| `1RowTypeA` | `t5` (inherit weight) | — |
| `1RowTypeB` | `t5` medium | — |
| `1RowTypeC` | `t6` regular | — |
| `1RowTypeD` | `t7` regular | — |
| `1RowTypeE` | `t5` bold | — |
| `2RowTypeA` | `t5` bold | `t6` regular |
| `2RowTypeB` | `t5` bold | `t7` medium |
| `2RowTypeC` | `t6` regular | `t6` regular |
| `2RowTypeD` | `t7` medium | `t5` bold |
| `2RowTypeE` | `t6` regular | `t5` bold |

Both taxonomies apply the `× 1.35` line-height override (§3.3).

**Left slot** [V-CODE] `ListRowIcon` / `ListRowImage`:
icon `24×24` or `20×20` with `margin-right: 16`; avatar `40×40 radius 20` with a
`1px` border; thumbnails `54×54 radius 10`, `34×54 radius 4`, `30×47 radius 4`,
`34×34 radius 17`. `ListRowLeftText` is `t6` bold with `margin-right: 8`.
`ListRowRightArrow` has `margin-left: 4`.

**Effects** [V-CODE] — two named attention effects, both driven imperatively via a
ref: `blink` (scale to `1.02` on `{766,52}`, dimmer to `0.04` after a `480 ms`
delay, a `radius 999` glow at `opacity 0.1`) and `shine` (a `400% × 300%` gradient
sweep peaking at `opacity 0.8`). These exist so a list can point at a row that just
changed, without moving it.

**Disabled** has two styles: `type1` (light veil) and `type2` (darker veil).

Docs: <https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-overview/>

### 6.3 ListHeader — the section header

This is what a date-group header is built from.

**Web** [V-CODE via `@toss/tds-mobile`]:

| `verticalPadding` | padding-top | padding-bottom | row-gap |
|---|---|---|---|
| `medium` *(default)* | 24 | 8 | 4 |
| `small` | 16 | 4 | 0 |

`horizontalPadding`: `medium 24` *(default)* / `small 20`. Title↔right `column-gap: 8`.
**No fixed height — content-sized.**

| `size` | title token | title weight | right token | description token |
|---|---|---|---|---|
| `large` | `t4` (20/29) | bold | `t6` | `t7` |
| `medium` *(default)* | **`t5` (17/25.5)** | **bold** | `t6` | `st12` |
| `small` | `t6` (15/22.5) | medium | `t7` | — |
| `xsmall` | `t7` (13/19.5) | regular | `t7` | — |

Colours: title `grey800`, right text `grey700`, right arrow icon `grey400`,
description `grey600`.

**RN** [V-CODE]: `container { marginTop: 24, marginBottom: 8 }`,
`body { marginHorizontal: 24 }`, `title { flex: 2 }`, `right { flex: 1, align: flex-end }`,
`upper { marginBottom: 4 }`, `lower { marginTop: 4 }`. Title size mapping
`20 → t4`, `17 → t5` *(default)*, `13 → t7`.

Sub-components: `TitleParagraph`, `TitleTextButton` (`clear` / `arrow` / `underline`),
**`TitleSelector`** (dropdown affordance — the natural month-switcher),
`RightText`, `RightArrow`, `RightIconButton`, `DescriptionParagraph`.

Docs/code discrepancy: docs say `titleWidthRatio` default `0.66`; web code uses `0.6`;
RN's `flex 2 / flex 1` is `0.667`. Capped to `0.5` above 200% text scale.

### 6.4 Cards / sections — there is no Card component

**TDS ships no `Card`.** [V-CODE — the component directory has no card] The docs
say plainly that `ListRow` is used **instead of** a Card UI
(<https://developers-apps-in-toss.toss.im/design/components.html>).

Sectioning is done with `Border` [V-CODE], which has three types:

| Type | Implementation |
|---|---|
| `full` | `width: 100%`, `height: hairlineWidth`, colour `greyOpacity300` |
| `padding24` | `padding-left: 24` then a hairline — **left-inset only** |
| *(default / spacer)* | **a solid block `height: 16` filled with `greyBackground`** (`#f2f4f6` light / `#101013` dark) |

**That 16px grey block is Toss's group separator.** Rules separate *items*; a 16px
recessed band separates *sections*. This is the closest published Toss answer to
"how do I visually break a long list into groups", and it is the single most useful
finding for a date-grouped feed. On dark it is `#101013` — one step *below* the
surface, so the gap reads as a trench rather than a line.

`ListFooter` closes a section: `height 59`, centred, title `t5 / medium / blue500`
(the "see more" affordance), optional `full` border on top,
underlay `rgba(0,0,0,0.26)`. [V-CODE]

### 6.5 BottomSheet

| Property | Value |
|---|---|
| Container `border-radius` | **28** (top corners) |
| `max-height` | **70%** of window height (**90%** at large a11y text) |
| Open / close | `translateY` on `spring.quick` (350 ms) |
| Bottom safe-area | `max(safeAreaBottom, 10)` |
| Handle | container `height 16`, bar **`48 × 4`, `radius 4`**, colour `grey200` |
| Header container | `padding: 21px 0 13px` |
| Header title | `t4` bold, `padding-left 24`, `padding-right 16`, `margin-top 4` |
| Header description | `t6` regular, `padding: 8px 44px 0 24px` |
| `Select` row | `t5` medium, `padding: 16px 24px`, `radius 12`, check icon `24×24` |
| Dimmer opacity | light `0.2` (darker variant `0.4`); **dark `0.56`** (darker `0.8`) |
| CTA area | `padding: 0 20px 18px`, buttons `16px` top/bottom margins |

Note the dimmer values match `darkThemeBackgroundDimmed: rgba(0,0,0,0.56)`.
`DESIGN.md`'s scrim value is right.

### 6.6 Dialog

| Property | Value |
|---|---|
| Width | **312** (fixed) |
| Padding | `22px 22px 16px` |
| `border-radius` | **24** |
| Background | `floatBackground` (dark `#2c2c35`) |
| Body scroll `max-height` | **70%** of window height |
| Title | `t4` **bold**, `grey800` |
| Body | `t6` **medium**, `grey700`, `margin-top 8` |
| Footer | `margin-top 20` |
| Dimmer | `black` at `opacity 0.2` |
| Enter | `spring.quick`: content `opacity 0→1` + `scale 0.8→1`, dimmer `0→0.2` |
| Exit | `spring.rapid`: content `opacity→0`, dimmer `→0` — **scale not animated back** |
| Refused dismiss | tapping the dimmer when `closeOnDimmerClick: false` **wiggles the dialog** (`small`, x, 350 ms) |

Variants are `AlertDialog` (single action, label `t5 medium`) and `ConfirmDialog`
(two actions, `padding-top 8`, `padding-left 8` between them).

`DESIGN.md`'s rule that the left button is always **닫기**, never 취소, is a
copy-doctrine claim from the error-message articles, not a code-level fact — keep it,
but it is [V-DOC]-adjacent rather than [V-CODE].

### 6.7 Inputs — TextField

Four variants [V-CODE]:

| Variant | Geometry | Value type |
|---|---|---|
| `Box` | `radius 14`, `border 1px`, `padding: 14px 16px` | `t5`-scale |
| `Line` | underline, no box | `t3` (22) semiBold |
| `Big` | no box | `t1` (30) semiBold |
| `Hero` | no box | `t1` (30) semiBold |

Shared: container `padding: 16px 24px`; **label `t7`** with `padding-bottom 6` and an
animated `opacity`; **help text `t7`** with `padding-top 6`; trailing button
`padding-right 8`, `margin-left 8`. `Box` press overlay: `radius 14`, `opacity 0.05`.
`TextArea` derives `min-height` from `lineHeight`.

**The Line/Big/Hero variants are the Toss signature**: a financial amount input is
30px semiBold with no box at all. Chrome is removed until only the value remains.

### 6.8 Switch

| Property | Value |
|---|---|
| Track | **50 × 30**, `border-radius 15` |
| Track colour | off `grey200` → on `blue500` (interpolated) |
| Knob | **16 × 16**, `radius 8`, `#ffffff`, positioned `left: 7, top: 7` |
| On state | `translateX 0 → 20` **and `scale 1 → 1.5`** (so 16 → 24px effective) |
| Travel motion | `{ stiffness: 1000, damping: 52 }` |
| Press | `scale 0.96` (`rapid` in / `quick` out) |
| Disabled | iOS `opacity 0.3`; Android colours pre-multiplied by `0.3` |
| Disabled press | **wiggle** (`small`, x, 350 ms) |

`DESIGN.md` says `translateX 0→16` and cites `spring rapid/med`. The verified
values are **`translateX 20`** and **`{1000, 52}`**. §10.

### 6.9 Segmented control

Two sizes. Note these are **not pill-shaped** and are much taller than 32px.

| | `small` | `medium` *(default)* |
|---|---|---|
| Group padding | `3` (all sides) | `padding: 4px 5px` |
| Group radius | **10** | **15** |
| Indicator inset | `top/bottom: 3` | `top/bottom: 4` |
| Indicator radius | **8** | **10** |
| Item radius | 12 | 12 |
| Item label padding | `5px 14px` | `7px 14px` |
| Label token | `t6` (15/22.5) | `t5` (17/25.5) |
| **Computed height** [D] | `3+5+22.5+5+3 ≈ 38.5` | `4+7+25.5+7+4 ≈ 47.5` |

Indicator motion `{ stiffness: 1000, damping: 52 }`. Root `padding-horizontal: 24`.
Scrollable variants add a `28px` edge gradient and a `24×24 radius 12` scroll button.

`DESIGN.md` specifies `height 32` with `radius pill`. That is not Toss geometry. §10.

### 6.10 Tabs

`height: 2` indicator with `border-radius: 10`; indicator width is inset from the tab
(`FluidTab` insets `14`, `FullTab` insets `20`); a `1px` track line beneath;
`TabItem` shows a `6×6 radius 3` dot for a badge state; horizontal edge gradients
appear when the strip scrolls. Indicator opacity is animated separately from
position, so the underline **fades during a swipe** rather than sliding rigidly. [V-CODE]

### 6.11 Toast

Bottom variant: `margin-horizontal 20`, `padding-vertical 14`, `margin-left 20`,
`margin-right 12`, message `t6` **semiBold**, icon `24×24`, trailing
`ToastButton` at `radius 100`, `padding: 6px 12px`, `t7` semiBold.
Top variant: `padding: 12px 16px 12px …`, `margin-right 10`.
Background `floatBackground`. [V-CODE]

### 6.12 Empty state — `Result`

| Slot | Spec |
|---|---|
| Figure | `margin-bottom 12` |
| Title | `t5` **medium**, `grey800`, centred, `margin-bottom 5` |
| Description | `t6` **medium**, `grey600`, centred |
| Button | `margin-top 16` |
| Container | `flex: 1`, centred both axes |

Two lines and an optional button. **No illustration is required** and there is no
"tips" list. That is the whole empty state. [V-CODE]

### 6.13 Skeleton

`Skeleton` primitive: `border-radius 6` default, background `grey200`, explicit
`width`/`height`. `AnimateSkeleton`: fade-in `100 ms` after a stagger delay, then an
**opacity pulse `0.2 ↔ 1` at `650 ms` per direction**; optional vertical gradient
mask from `5%` to `95%` in the background colour. [V-CODE]

**Nine named layout archetypes** [V-DOC
<https://tossmini-docs.toss.im/tds-mobile/components/skeleton/>]:
`topList`, `topListWithIcon`, `amountTopList`, `amountTopListWithIcon`,
`subtitleList`, `subtitleListWithIcon`, `listOnly`, `listWithIconOnly`, `cardOnly`.
Composable primitives: `title`, `subtitle`, `list`, `listWithIcon`, `card`,
`spacer(n)`. `repeatLastItemCount` default **3**; `background` default `"grey"`.

**The point of naming them is that the skeleton IS the layout** — nothing shifts when
content arrives. `DESIGN.md` says this; here are the names.

### 6.14 Other verified metrics worth having

| Component | Spec |
|---|---|
| `TableRow` | `padding: 16px 24px`, left `margin-right 16`; left text `st10` `grey700`, right text `st10` `grey900` |
| `BoardRow` | `padding: 16px 24px 15px`, title `t5` regular; secondary `fontSize 19 / lineHeight 23` |
| `Dropdown` | panel `width 240`, `padding-vertical 12`, `radius 16`; item `padding: 12px 24px`, `st8` semiBold |
| `ProgressBar` | heights `light 2 / normal 5 / bold 8`, `border-radius = height` |
| `Loader` | `small 24 / medium 36 / large 48`; inner `12 / 12 / 16` |
| `IconButton` | `iconSize` default 24; padding `iconSize/2` (9 for 18–20); radius `≤16→6`, `≤20→8`, else 12; bg `greyOpacity100`; press `scale 0.9` |
| `GridList` item | `padding: 12px 8px`, `radius 9`, label `st11` medium, `max-height 28`, `margin-bottom 6` |
| `Tooltip` | `shadowRadius 60`, `offsetY ±16`, `elevation 40`, bg `floatBackground` |
| `NumericSpinner` | container `padding 3/4`, number box `padding 3px 5px` → `12px 14px` by size; disabled `opacity 0.3`; wiggle + haptic on rejection |
| `StepperRow` | `padding: 3px 24px`, rail `width 2`, `min-height 16`, `radius 1`; texts `t5 bold / t6 regular` or `t5 bold / t7 medium` |

---

## 7. Information hierarchy, one primary action, and stripping copy

This is the section that matters most for "no explanatory sentences anywhere",
so it separates what Toss actually published from what circulates as Toss lore.

### 7.1 "One thing per screen" — verified, with the real mechanism [V-DOC]

<https://toss.tech/article/toss-signup-process> (정희연, Head of UX, 2022-09-20).
The principle is named verbatim **"1 thing for 1 page"** —
*"하나의 화면에서 하나의 액션만 시키라는 내용"*.

**The case study is more useful than the slogan.** The signup screen had four
required fields (name, ID number, carrier, phone) on one screen. The fix was
**not** four separate screens. It was **reverse-order progressive disclosure**: ask
for the last field first, reveal the previous one above it as each is completed, so
the user only ever sees one active question. Users did not consciously notice the
restructure ("invisible gorilla"). Shipped in a 2-week iteration. The governing
principle is named **"Sleek experience"**.

**Translation for a desktop app** [X]: "one thing per screen" on desktop does not
mean one control per window — it means **one thing is *active* at a time**. A
1440×900 window can hold a rail, a header and a feed and still obey the rule, as
long as exactly one element is the answer to "what do I do here". `DESIGN.md`'s
four-page split (Captions configures / Live Call invites / Records reviews /
Settings persists) is the right reading.

### 7.2 "Recommend exactly one thing" — verified A/B result [V-DOC]

<https://toss.tech/article/21004> (박다롱). A ranked list of cards was replaced with
a **single** recommended card. The single card won on application conversion. Support
devices used instead of a comparison table: social proof
(*"토스 회원들이 가장 많이 구매한 상품"*) and personalisation.

This is the strongest published evidence for "one primary action per screen": Toss
tested the alternative and the alternative lost.

### 7.3 "Easy to answer" and the 3-second rule [V-DOC]

<https://toss.tech/article/insurance-claim-process> (김재현, Design Strategy Lead,
2022-12-14). **The only hard number Toss publishes about hierarchy:**

> *"3초 안에 답이 안나오면 어려운 질문이에요"* — if the answer doesn't come within
> 3 seconds, the question is too hard.

Worked examples: *"저녁 뭐 먹을래?"* → *"저녁에 피자 먹을까?"*; and in the real
product, *"전문가 도움받을래 직접 할래?"* → *"서류 있어?"*.
**Result: drop-off reduced 50–60%.**

The operational form: replace an open question with a closed one, and replace a
choice-of-strategy with a question about a fact the user already knows.

### 7.4 How Toss decides what is emphasised

There is **no published rule** for maximum emphasis levels per screen. [X for any
such number.] But the mechanism is legible in code, and it is better than a rule:

1. **Emphasis is a type-token + weight pair, never a colour.** The `ListRow`
   taxonomy (§6.2) has 15 combinations and **not one of them uses colour to signal
   importance** — every archetype is `grey` text at different sizes and weights.
   Colour is reserved for the single accent and the single danger.
2. **Exactly one line per row is heavy.** Every 2-row and 3-row archetype has exactly
   one `bold`/`semiBold` line; the rest are `regular`/`medium`. There is no archetype
   with two bold lines.
3. **The heavy line moves, the count doesn't.** `2RowTypeA` (bold above, regular
   below) and `2RowTypeD` (regular above, bold below) are the same row with the
   subject relocated. That is the whole emphasis system: pick the subject, give it
   the heavy token, place the label where the scan needs it.
4. **Section headers are one token above body and grey800, not black.** `t5 bold
   grey800` over `t5 medium/regular grey700-800` body. The step is weight and one
   shade, not size.

**Reading direction is designed** [V-DOC
<https://toss.tech/article/toss-design-system-guide>, 황희영, 2024-04-05]:
*"정보를 단순히 그룹핑만 하는 것이 아니라, 읽는 방식부터 누구나 같은 방향으로 읽을
수 있게끔 그룹핑된 가이드 내용을 위에서 아래로 흐르게끔 배치했어요."* Same article:
macro→micro ordering; **worst-case-first** (show the component at maximum density
with every element present, *then* explain the options); accessibility notes always
last.

Also from that article, a genuinely useful long-list finding: Toss added **top and
bottom blur affordances** to scrollable menus because users could not tell more
items existed below. [V-DOC] `DESIGN.md`'s `mask-image` fade at the top of the
caption feed is the same device — now with a Toss source.

And a caution for row-heavy UIs [V-DOC
<https://toss.tech/article/senior-usability-research>]:
*"어디를 클릭해야 진입할 수 있는지 혼란스러워하는 상황은 다양한 형태의 컴포넌트와
진입점이 있는 리스트 화면에서 더 자주 발생했어요"* and *"명확한 버튼 형태가 아닌
경우 주변의 다른 진입점을 잘못 클릭하는 일이 많았어요"*. If a row has more than
one target, make the secondary target look like a button.

### 7.5 Stripping copy — the 8 writing principles [V-DOC]

<https://toss.tech/article/8-writing-principles-of-toss>. Values behind them:
명확한 / 간결한 / 친근한 / 존중하는 / 공감하는.

1. **Predictable hint** — does the text hint at the next screen?
2. **Weed cutting (잡초 뽑기)** — remove every word whose presence or absence changes
   nothing. **Note the stated goal: scannability, explicitly *not* character-count
   reduction.**
3. **Remove empty sentences (빈 문장 제거)** — never repeat the same information twice
   on one screen just to fill visual space.
4. **Focus on the key message.**
5. **Easy to speak** — must sound natural read aloud.
6. **Suggest, don't force** — no coercion, no fear.
7. **Universal words** — understandable and harmless to everyone.
8. **Find the hidden emotion.**

**#2 and #3 are the direct authority for the no-explanatory-copy rule.** Specifically
#3 covers the exact failure mode in `DESIGN.md` §3.1: a heading that says
"Output mode" followed by a sentence that says "Choose how captions are delivered"
is an *empty sentence* — the same information twice, present only to fill space.

**What the writing guides do *not* contain** [X]: any date, time, or number notation
rules. I read <https://developers-apps-in-toss.toss.im/design/ux-writing.html> and
the 8-principles article end to end. There is no date-format section at all.

### 7.6 Error copy [V-DOC]

Six principles, <https://toss.tech/article/how-to-write-error-message> (김자유):

1. *"최고의 에러는 발생하지 않는 것"* — the best error never happens.
2. *"적절한 컴포넌트 쓰기"* — **dialog explains, toast notifies.**
3. *"스스로 해결할 수 있는 방법 알려주기"* — tell them how to fix it themselves.
4. *"사용자 입장에서 이해할 수 있는 언어로 쓰기"*.
5. *"쉽게 해결할 수 있게 도와주기"* — put the action button in the message.
6. *"부정적인 감정 최소화하기"*.

The system-level doctrine is **"Navigating error"**
[<https://toss.tech/article/introducing-toss-error-message-system>]: the message's job
is to get you to the next screen, not to describe the failure. Delivered as an
**Error Message Library** callable from code plus Framer presets for designers, built
from **situation-specific templates** (*"상황별로 세분화된 템플릿"*).
**No structural spec (title/body/button lengths) and no character limits are
published.** [X for any such numbers.]

### 7.7 What is *not* a Toss publication — read this before quoting

The widely-circulated **8-item UX Principles list** (One Thing per One Page ·
Tap & Scroll · Easy to Answer · Value First, Cost Later · No Ads Patterns ·
Context-based · **No More Loading** · Sleek Experience) and the **3-item Product
Strategy** (Casual Concept · Minimum Features · Less Policy) **do not appear on any
Toss-owned domain.** They trace to the company book 『유난한 도전』, summarised at
<https://maily.so/eddy/posts/knrjvlp1rld> — **SECONDARY**.

Three items on that list *are* independently verified on toss.tech
("1 thing for 1 page", "Easy to answer", "Sleek experience"). The rest — including
**"No More Loading"** — are book-sourced only. Cite them as *"per 『유난한 도전』"*,
not as TDS guidance. See §5.1 for why "No More Loading" is actively contradicted by
Toss's own published loan-flow case.

### 7.8 Where Toss guidance supports — and conflicts with — "the subtitle is the protagonist"

**Supports it:**

| Toss guidance | How it helps |
|---|---|
| Elevation by surface step, shadow only for floating things (§4.3) | Chrome can recede to a flat surface delta with no drop-shadow noise competing with text |
| One seed accent, all tints derived (§2.5) | Nothing in the chrome can accidentally become a second focal point |
| No colour in the ListRow emphasis system (§7.4) | The only saturated thing on screen can be the live indicator |
| `TextField` `Line` / `Big` / `Hero` variants (§6.7) | Toss already has the "remove the box, the value is the UI" idiom — that *is* subtitle-as-protagonist, applied to amounts |
| Weed cutting + remove empty sentences (§7.5) | Direct authority for zero explanatory copy |
| Motion is opt-out (§5.1) | Chrome should not animate; only the caption changes |
| Skeleton = layout, nothing shifts (§6.13) | The caption never jumps when data arrives |

**Conflicts with it:**

| Toss guidance | The conflict |
|---|---|
| `t5` (17px) is the body default; `t1` (30px) is the largest token | Toss's scale **tops out at 30px**. A 38px caption is off-scale. You must define a caption ramp *outside* TDS — `DESIGN.md` does exactly that, and it is correct to do so. Do not try to force the caption into `t1`. |
| `ListRow` line-height `× 1.35` (§3.3) | Right for dense ledger rows, **wrong for a caption you read at distance**. Use `× 1.35`–`1.4` for the feed metadata but keep the caption itself at its own ramp. |
| Dark grey ramp compresses toward white (`adaptiveGrey900 = #ffffff`) | Toss's top-of-ramp *is* pure white. `DESIGN.md` reserves `#FFFFFF` for the live caption edge only and uses `#DDDDDD` for body — that is a deliberate **departure** from Toss, justified by long-session reading. Keep the departure; label it as one. |
| `Border height16` grey block as the section separator | On a caption feed, a 16px recessed band between every group would be visual noise competing with text. Use it between *sections* (feed vs controls), not between caption entries. |
| Toss's 24px universal inset | Fine for a 375px phone. On a 1440px window a 24px inset leaves a 1392px measure — far past readable. You need a `max-width` the way `DESIGN.md` specifies (880–920px); Toss has no guidance because Toss has no wide layout. [X] |

---

## 8. Dates, times, and date-grouped lists

### 8.1 The honest headline

**Toss has never published its transaction-history date-grouping pattern.** No format
string, no weekday rule, no 오늘/어제 rule, no sticky behaviour, no per-day subtotal,
no inter-group spacing. Anything specific in that area would be invention. §8.6 lists
exactly what is missing.

What *is* verified is better than expected in one place: **TDS ships three
undocumented date-picker components.**

### 8.2 `DatePicker` / `DateRangePicker` — undocumented but shipped [V-CODE]

Source: `@toss/tds-mobile@2.5.0` (published **2026-06-15**; absent in 2.4.1). All are
tagged `@public tds` in the type definitions, but every doc route
(`/components/DatePicker/`, `/date-picker/`, `/DateRangePicker/`, `/WheelDatePicker/`)
**404s**. There is **no** date component in `@toss/tds-react-native` at all — these
are web-only.

Structure is a semantic table, continuously scrolling:

```
<table role="grid">
  <caption><time dateTime="yyyy-MM">…</time></caption>
  <tbody>
    <tr>                                  <!-- week -->
      <td role="gridcell">
        <time dateTime="yyyy-MM-dd">…</time>
```

| Element | Exact value |
|---|---|
| Day cell | **height 46**, `flex: 1 1 14.2857%` (100/7) |
| Day number | `font-size 17`, `weight 400`, colour **`grey600` `#6b7684`**; text is `format(date,'d')` — **no leading zero** |
| **Selected** | circle **46 × 46**, `border-radius: 50%`, bg **`blue500` `#3182f6`**, text `#ffffff`, `z-index: 2` |
| **In-range** | cell bg `greyOpacity100`, text `grey700` `#4e5968` |
| **Range start** | `::after` covers the **right 50%**, `height 46`, bg `greyOpacity100` |
| **Range end** | `::after` covers the **left 50%**, `height 46`, bg `greyOpacity100` |
| **Disabled** | colour `grey300` `#d1d6db`, `pointer-events: none` |
| **Today** | **4 × 4** dot, `blue500`, `radius 50%`, `left: calc(50% - 2px)`, **`top: 6px`**, `z-index: 3`; suppressed when selected; also sets `aria-current="date"` |
| **Month caption** | format **`"yyyy.MM"`** → `2026.07`; `padding: 32px 18px 0`; `margin-bottom: 8`; **`font-size 22`, `weight 700`**, colour `grey900` `#191f28` |
| Weekday row | `padding: 9px 0`; constant **height 40**; bottom rule `::after` = **`0.5px solid rgba(0,0,33,0.07)`** |
| Weekday labels | **`일 월 화 수 목 금 토`** — **Sunday-first**; `font-size 15`, `weight 400`, `grey600`, centred |
| **Month navigation** | **No chevrons.** Months are stacked vertically in one scroller and appended on reaching the bottom. `monthPageSize` default **5** (DatePicker) / **3** (DateRangePicker); `scrollThreshold` **50** px |
| Keyboard | `←/→` ±1 day, `↑/↓` ±7 days, `PageUp/PageDown` ±1 month |
| `minSelectableDate` | defaults to **today** |
| `allowSameDateSelect` | default **false** (range) |
| Day `aria-label` | **`"yyyy년 M월 d일"`** — the one Korean display-date format TDS hardcodes |
| a11y suffixes | `"이 선택됨"`, `"이 시작날짜로 선택됨"`, `"이 끝날짜로 선택됨"`, `"이 선택범위에 포함됨"` |

Range states are modelled as `in-selected-range`, `selected-start`, `selected-end`,
`selected`, `disabled`.

> **Two things to take from this even if you build no calendar.**
> 1. **`46px` day cell, `50%`-radius `blue500` selection, `4px` today dot.** Those
>    are real Toss numbers for a date grid.
> 2. **Toss's calendar has no month chevrons.** It is one continuous vertical scroll
>    with a `yyyy.MM` caption per month. That is a striking choice and it is
>    directly usable on desktop, where vertical scroll is cheap.

**Caveat:** v2.5.0 is recent and undocumented. Treat as pre-release surface Toss may
change without notice.

### 8.3 `WheelDatePicker` [V-CODE]

| Fact | Value |
|---|---|
| Trigger | `TextField.Button variant="line"`, display `format` default **`'yyyy.MM.dd'`** |
| Sheet | **three wheels** (year / month / day), container **`height: 240`** |
| Value labels | `` `${n}년` ``, `` `${n}월` ``, `` `${n}일` `` |
| Wheel aria-labels | `"년도 선택"`, `"월 선택"`, `"일 선택"` |
| CTA label | **`"적용"`** |
| Default range | `initialDate ± 100 years` |
| Wheel item | `height: 16%` of container, `padding: 0 6px`, `perspective: 1000px`, `transform-style: preserve-3d`, `backface-visibility: hidden` |

**Do not port this to desktop.** See §11.

### 8.4 Date and time formats Toss actually uses [V-DOC]

Observed on Toss-authored web surfaces. Toss is not perfectly self-consistent, which
is itself worth knowing.

| Format | Examples | Context |
|---|---|---|
| **`YYYY.MM.DD.`** (trailing period) | `2026.07.25.`, `2026.07.13. ~ 2027.07.12.` | reference/effective dates, legal qualifiers — tossbank.com |
| spaced variant | `2023. 06. 29. 기준` | same document — inconsistent |
| **`YY.MM.DD`** | `26.07.24`, `26.06.30` | dense data tables — tossinvest.com |
| **`YYYY년 M월 D일`** | `2025년 9월 1일 기준` | prose; also the `DatePicker` `aria-label` |
| `YYYY.MM.DD` | `2024.12.16` | page footer |
| **`yyyy.MM`** | `2026.07` | `DatePicker` month caption [V-CODE] |

**Zero instances of a weekday marker** (`(토)`, `토요일`) anywhere in Toss-authored
content. **Zero instances of a bare month-day** (`7월 25일`) in a Toss UI.

**Time is 24-hour, no 오전/오후, in timestamps and operational contexts** [V-DOC]:
`15:54:17`, `23:30~00:30`, `KRX 09:00 - 15:30`, `15:30 - 익일 08:20`,
`평일 : 08시-18시`, `23시 50분~00시`.
오전/오후 appears only in **prose** business hours — `평일 오전 9시 - 오후 6시` —
and note the Korean convention: **오전/오후 precedes the hour**.

**Relative timestamps** [V-DOC, verbatim from tossinvest.com news list]:
pattern `{출처} ・ {상대시간}` with a **`・`** separator —
`뉴스1 ・ 6시간 전`, `연합뉴스 ・ 5시간 전`. Confirmed form is **`N시간 전`**.
`방금` is **not attested**. `N분 전` with the `전` suffix is **unconfirmed**.

**`@toss/date`** [V-CODE] exports `kstFormat` (date-fns with the `ko` locale),
`parseYYYYMMDD`, `getDateDistance`, `getDateDistanceText`. `getDateDistanceText`
produces **`"N일 N시간 N분 N초"`** — a *duration*, with **no `전` suffix**.
**There is no 오늘/어제 helper anywhere in Toss's published code.**

**Tabular numerals** [V-DOC]: Toss Product Sans ships both proportional and
fixed-width figures, and the stated rule is fixed-width for large / live-updating
numbers, with the reason given:
*"수가 커질수록 자릿수를 비교하기 어려워요. 반면 숫자를 크게 볼 땐 숫자마다의 고유
간격을 지키는 것이 안정감을 줍니다."* `tabular-nums` appears **0 times** in the TDS
bundle — it is a font-level mechanism, not a CSS token. [V-CODE]

### 8.5 What Toss published about ledger screens [V-DOC]

<https://toss.tech/article/thinking-user-perspective> (김소현, Product Designer,
2023-01-19) is the single most relevant Toss artifact, and it says two things that
cut against the assumption in the brief:

1. **Toss describes 내 소비 as time-ordered, not date-grouped.** Verbatim:
   *"초기의 '내 소비'에서는 수입, 지출, 이체 내역이 만들어진 시간 순서대로 쌓이게
   되는 리스트를 제공하는 것이 핵심 사용성이었어요."* Toss never states that the list
   carries date headers.
2. **Daily aggregation was deliberately moved *out* of the list and into a calendar.**
   Verbatim: *"달력과 같은 형태로 월 단위로 소비 내역을 한눈에 보고 싶다는 사용자의
   보이스를 여러 차례 받게 되면서 소비내역에 달력을 넣기로 했어요."*

And the navigation finding, which is the most transferable thing in the article:
Toss first shipped the calendar as a **pull-down drawer**
(*"서랍을 열듯이 화면을 터치한 후 아래로 끌어내리면 달력이 펼쳐지는 방식이예요."*).
It tested well internally and **failed in production** —
*"결과는 기대와 달리 달력을 열어보는 사용자들의 수가 너무 적었어요."* The fix was to
replace the gesture with **a plain tab**: *"스마트폰을 이용하는 사용자라면 누구나
한 번쯤 사용해 보았을 '탭'형태의 UI를 활용했어요."* Result: **~4× more users opened
the calendar** (*"네 배 정도 늘어났어요"*).

Day cells in that calendar show **that day's total expense and total income**
[V-DOC, user-observed: <https://toss.im/tossfeed/article/toss-user-interview-timeline>
— *"하루 총지출과 총수입을 한눈에 보여줘서 굉장히 인상적이었"*].

Also verified: **토스뱅크 '함께 쓰는 캘린더'** (launched ~2025-11-11) is a real
calendar product with two tabs — **`일정 캘린더`** and **`가계부 캘린더`** — entries
colour-coded by person, entered from a home-screen widget.
<https://www.tossbank.com/articles/calendar>

**Sticky headers are not a TDS capability**: `position: sticky` appears **0 times**
in the entire `@toss/tds-mobile` bundle, and there is no `StickyHeader` or `Section`
component. [V-CODE, negative] That says nothing about the app's own runtime, but it
means you get no Toss precedent for sticky date headers.

### 8.6 Explicitly NOT published — do not invent these

1. The 거래내역 date-group **header format string**.
2. Whether the header **includes a weekday** (`7월 25일 (금)`).
3. Whether Toss uses **오늘 / 어제** as group labels.
4. Whether date headers are **sticky**.
5. Whether there is a **divider specifically between date groups**.
6. **Per-day subtotals in a list** (they exist only in *calendar day cells*).
7. **Spacing between date groups.**
8. A **chevron month switcher** or month-picker bottom sheet in 내 소비. The only
   documented mechanism is a **tab**, and TDS ships only `icon-arrow-right-mono` —
   **there is no left/right chevron pair in the icon set.** [V-CODE, negative]
9. The **selected-month label string** in 소비 리포트.
10. Any verbatim Toss app timestamp of the form `오후 3:04` / `15:04`.
11. **`방금`** as a Toss string (not attested).
12. Any **정기결제 / 구독 calendar** or payment-due calendar.
13. **Doc pages** for the three date pickers (all 404).
14. Any **RN calendar cell sizing** (no RN calendar exists).

### 8.7 How to build a date-grouped meeting feed from verified TDS parts [D]

Nothing below invents a Toss value. Every number is cited from §6 or §8.2.

```
┌─ Border (spacer)  height 16, bg surface-recessed  ← §6.4, between sections only
│
├─ ListHeader                                        ← §6.3
│    padding-top 24, padding-bottom 8, inset 24
│    title:  t5 (17/25.5) bold, fg-secondary-strong
│    right:  t6 (15/22.5) regular, fg-tertiary      ← count / duration total
│
├─ ListRow  (2RowTypeC)                              ← §6.2
│    inset 24, vertical padding 12 (web default)
│    top:    t5 (17) bold      ← meeting title      line-height ×1.35 → 22.95
│    bottom: t7 (13) medium    ← participants       line-height ×1.35 → 17.55
│    right:  RightTexts1RowTypeD → t7 regular       ← time, tabular-nums
│    divider: ::before, margin-left 24, width calc(100% - 24px), 1px
│    press:   underlay inset 4/6, radius 12, adaptiveOpacity100
│
├─ ListRow …
│
└─ ListFooter  height 59, t5 medium, accent          ← §6.4, "see all"
```

**The three decisions that are yours, not Toss's** — mark them as [X] in your code:

1. **Header label format.** Toss gives you `yyyy.MM` (calendar caption) and
   `yyyy년 M월 d일` (a11y label) and `YYYY.MM.DD.` (documents). It gives you **no**
   list-group header format and **no** weekday precedent. A defensible choice
   consistent with Toss's own strings: **`2026.07.25`** for older groups and
   **`오늘` / `어제`** for the two most recent — but be explicit that the relative
   labels are your addition, since Toss ships no such helper (§8.4).
2. **Sticky or not.** No Toss precedent (§8.5). On desktop, sticky is cheap and
   valuable in a long scroll; if you do it, keep the header at `t5 bold` and give it
   the *base* surface colour so it does not read as a floating chrome bar.
3. **Group separation.** Toss's only published group separator is the **16px recessed
   block** (§6.4). Between date groups in a caption/meeting feed that is likely too
   heavy — the `ListHeader`'s own `24px` top padding already does the work. Use the
   16px block only where a genuine section changes.

**Month navigation, if you add one** [D]: Toss's shipped answer is **continuous
vertical scroll with a per-month caption and no chevrons** (§8.2), and its published
lesson from 내 소비 is that **a discoverable tab beat a clever gesture 4:1** (§8.5).
Both point the same way: prefer an always-visible affordance and continuous scroll
over a hidden month stepper.

---

## 9. Translating Toss to a dark desktop app on `#0A0A0B`

Toss ships a dark palette (§2.2–2.3), so the *dark* half of this translation is
mostly adoption, not invention. What Toss does **not** ship is (a) a base darker
than `#17171c`, (b) any wide-viewport layout guidance, and (c) hover — a mobile
design system has no hover state at all. Those three are the extrapolation, and
they are marked.

### 9.1 The surface ladder — two options, with the maths

`#0A0A0B` sits **below** Toss's darkest surface. In OKLCH, `#0A0A0B` is `L = 0.1452`;
Toss's deepest token `#101013` is `L = 0.1744`. So you are asking for one extra step
at the bottom.

**Option A — recommended. Keep Toss's values verbatim; `#0A0A0B` becomes step 0.** [D]

| Step | Value | OKLCH `L` | ΔL from previous | Role |
|---|---|---|---|---|
| 0 | **`#0A0A0B`** | 0.1452 | — | App background, rail, overlay window |
| 1 | `#101013` | 0.1744 | +0.0292 | Recessed wells, the 16px section trench |
| 2 | `#17171c` | 0.2069 | +0.0325 | Panels, the feed surface |
| 3 | `#202027` | 0.2466 | +0.0397 | Cards, list surfaces, sticky headers |
| 4 | `#2c2c35` | 0.2969 | +0.0503 | Popovers, menus, the floating controller |
| — | `#3c3c47` | 0.3605 | +0.0636 | Hairline border |

Note the ΔL steps are **progressive** (0.029 → 0.033 → 0.040 → 0.050 → 0.064) — Toss
widens each step as it rises, which is what makes the ladder legible at the top
without the bottom looking banded. Adding `#0A0A0B` at `ΔL 0.029` continues that
curve correctly, which is why this option works at all.

**Option B — ΔL-preserving compression.** If you want the *whole* app deeper, keep
Toss's step sizes but re-anchor: `#0A0A0B → #111115 → #191920 → #25252e → #35343f`.
[D — computed by holding each step's OKLCH chroma and hue and shifting `L` by the
constant offset `0.1452 − 0.1744 = −0.0292`.]

Option B is darker and more monolithic. **Prefer Option A**: it keeps you on real
Toss values, and it gives the recessed step (`#101013`) enough separation from the
base that the section trench actually reads.

`DESIGN.md`'s ladder (`#0A0A0B / #15151A / #1F1F27 / #2F2F3A`) sits between the two
options and is fine; the only thing worth changing is that it has **no recessed
step below the base**, so `--nova-surface-recessed: #000000` is doing that job with
pure black. `#101013` is the Toss-native answer and is easier to see against
`#0A0A0B` than pure black is. [D]

### 9.2 Foreground ramp and measured contrast

Toss's dark grey ramp used as a text ramp, with WCAG contrast computed against each
surface step:

| | `#0A0A0B` | `#101013` | `#17171c` | `#202027` | `#2c2c35` |
|---|---|---|---|---|---|
| `#ffffff` (grey900) | 19.79 | 19.00 | 17.86 | 16.19 | 13.83 |
| `#e4e4e5` (grey800) | 15.58 | 14.95 | 14.06 | 12.74 | 10.88 |
| `#DDDDDD` *(NOVA body)* | 14.57 | 13.98 | 13.15 | 11.92 | 10.18 |
| `#c3c3c6` (grey700) | 11.25 | 10.80 | 10.16 | 9.21 | 7.86 |
| `#9e9ea4` (grey600) | 7.43 | 7.13 | 6.70 | 6.07 | 5.19 |
| `#7e7e87` (grey500) | 4.92 | 4.72 | 4.44 | 4.02 | 3.44 |
| `#62626d` (grey400) | 3.29 | 3.15 | 2.97 | 2.69 | 2.30 |
| `#4d4d59` (grey300) | 2.38 | 2.28 | 2.14 | 1.94 | 1.66 |

Practical consequences:

- `grey500 #7e7e87` is the **floor for body text** — it clears 4.5:1 on steps 0–2 and
  fails on step 4. Do not put secondary text on the float surface at grey500.
- `grey400 #62626d` clears **3:1 only on steps 0–1**. It is a disabled/decorative
  colour, not a text colour. Toss uses it for the `ListHeader` right arrow — an icon,
  not text.
- `DESIGN.md`'s `--nova-fg-secondary: #8B95A1` is *light-mode* `grey500`, not the dark
  ramp value. On `#0A0A0B` it measures well (it is lighter than `#7e7e87`), so it is
  safe — but it is a light-palette value used in dark mode. If you want the Toss-native
  dark secondary, it is **`#9e9ea4`** (7.43:1). Same for `--nova-fg-tertiary: #6B7684`,
  whose dark-ramp counterpart is `#7e7e87`.
- **`#DDDDDD` at 14.57:1 is well justified.** `DESIGN.md` claims ≈14.5:1 — the exact
  figure is **14.57:1**.

Accents on dark, using Toss's **dark** hue values (not the light ones):

| Token | Dark value | on `#0A0A0B` | on `#202027` |
|---|---|---|---|
| blue500 | `#3485fa` | 5.54 | 4.53 |
| blue600 | `#449bff` | 6.95 | 5.69 |
| blue700 | `#61b0ff` | 8.63 | 7.06 |
| red500 | `#f04251` | 5.28 | 4.32 |
| red600 | `#fa616d` | 6.59 | 5.39 |
| green500 | `#16bb76` | 7.92 | 6.48 |
| yellow500 | `#ffb134` | 10.92 | 8.93 |

**Use `#3485fa`, not `#3182f6`, in dark mode.** That is Toss's own dark-mode blue and
it buys 0.2 of contrast for free. Anything sitting on the float surface (`#2c2c35`)
should step up to blue600 `#449bff`.

This is the concrete form of Toss's published dark-mode rule — *"다크모드에서는
명도대비를 더 강하게 가지도록 설계했어요"* (§2.7). **Every accent gets one step
brighter in dark mode.**

### 9.3 Hover — pure extrapolation [X]

**TDS has no hover state.** Zero `:hover` handling; every interactive component has
`pressIn`/`pressOut` only. [V-CODE, negative] Desktop needs a third state, and Toss
gives you nothing to copy.

The defensible construction is to **subdivide Toss's own overlay ramp** rather than
invent values, since `adaptiveOpacity100` (`rgba(217,217,255,0.11)`) is already the
press value:

```css
--state-hover: rgba(217,217,255,0.055);  /* [X] half of adaptiveOpacity100 */
--state-press: rgba(217,217,255,0.11);   /* [V-CODE] adaptiveOpacity100 */
--state-selected: rgba(217,217,255,0.19);/* [V-CODE] adaptiveOpacity200 */
```

Keep the violet tint — `rgb(217,217,255)`, not `rgb(255,255,255)`. It is what makes
the overlay disappear into the violet-biased dark greys instead of reading as a grey
film. That detail is [V-CODE] even though the 0.055 step is not.

Apply hover with the **same inset underlay geometry as press** (§6.2: `4px/6px` inset,
`radius 12`) so hover and press are the same shape at two intensities, and a pointer
moving down a list draws one consistent floating highlight.

**Transition timing** [D]: hover in/out is a colour change, and TDS uses *timing*
functions for colour, never springs (§5.4 — `IconButton` uses `bezier.out` at 500ms
for its background). 500ms is too slow for pointer hover; use
`120ms var(--ease-out)` [X] and keep press on `spring.rapid` 200ms [V-CODE].

### 9.4 Focus — pure extrapolation [X]

TDS has no focus-visible treatment either (mobile). `DESIGN.md` §8.13 already
specifies `2px solid` accent at `offset 2px` with a reserved transparent border so
focus never shifts layout. That is correct desktop practice and there is no Toss
alternative to weigh it against. Use the **dark** accent `#3485fa`.

### 9.5 Density and measure on a wide window [X] + [D]

Toss has no wide-viewport guidance. Two verified anchors constrain the answer:

1. **`ListRow` reflows to vertical at container width ≥ 560px** [V-CODE, §6.2] — so
   Toss's own row *does* have an opinion about wide containers, and the opinion is
   "stack, don't stretch". Read as: **do not let a row's left and right content drift
   more than ~560px apart.** That is a real argument for a `max-width` on the feed,
   sourced from Toss code rather than from typographic folklore.
2. **The 24px universal inset** [V-CODE, §4.1] is a *phone* inset. Keeping it on a
   1440px window yields a 1392px measure. Combine with (1): inset stays 24px, and a
   `max-width` in the **880–920px** range keeps rows inside the non-reflow regime with
   room to spare. `DESIGN.md`'s 880px content / 920px caption measure is consistent
   with this.

Density: use the **web** `ListRow` vertical padding of **12px** as the desktop default
(§4.4), not RN's 24. With the `× 1.35` line-height override that gives a `t5`+`t7`
two-line row at `12 + 22.95 + 17.55 + 12 ≈ 64.5px` [D] — dense enough for a long
meeting list, and it does not need the 44px touch floor.

### 9.6 A paste-ready dark token sheet

Values marked per line. This is the Toss-derived layer only — `DESIGN.md` owns the
brand/gradient/speaker/caption tokens.

```css
:root[data-theme="dark"] {
  /* ── surfaces: Toss's dark ladder, with #0A0A0B as step 0 ───────────── */
  --surface-base:       #0A0A0B; /* [X] NOVA base, below Toss's range      */
  --surface-recessed:   #101013; /* [V-CODE] adaptiveGreyBackground        */
  --surface-panel:      #17171c; /* [V-CODE] adaptiveBackground            */
  --surface-layered:    #202027; /* [V-CODE] adaptiveLayeredBackground     */
  --surface-float:      #2c2c35; /* [V-CODE] adaptiveFloatBackground       */
  --border-hairline:    #3c3c47; /* [V-CODE] adaptiveHairlineBorder        */
  --scrim:              rgba(0,0,0,0.56);  /* [V-CODE] BackgroundDimmed    */
  --scrim-strong:       rgba(0,0,0,0.80);  /* [V-CODE] Dimmer "darker"     */

  /* ── foreground: Toss's dark grey ramp ──────────────────────────────── */
  --fg-max:        #ffffff; /* [V-CODE] adaptiveGrey900 — 19.79:1          */
  --fg-strong:     #e4e4e5; /* [V-CODE] adaptiveGrey800 — 15.58:1          */
  --fg-primary:    #c3c3c6; /* [V-CODE] adaptiveGrey700 — 11.25:1          */
  --fg-secondary:  #9e9ea4; /* [V-CODE] adaptiveGrey600 —  7.43:1          */
  --fg-tertiary:   #7e7e87; /* [V-CODE] adaptiveGrey500 —  4.92:1, floor   */
  --fg-disabled:   #62626d; /* [V-CODE] adaptiveGrey400 —  3.29:1, non-text*/

  /* ── divider / state overlays: Toss's violet-white alpha ramp ───────── */
  --divider:        rgba(224,224,255,0.27); /* [V-CODE] adaptiveOpacity300 */
  --state-hover:    rgba(217,217,255,0.055);/* [X]  half of Opacity100     */
  --state-press:    rgba(217,217,255,0.11); /* [V-CODE] adaptiveOpacity100 */
  --state-selected: rgba(222,222,255,0.19); /* [V-CODE] adaptiveOpacity200 */

  /* ── accents: Toss's DARK hue values, one step brighter ─────────────── */
  --accent:          #3485fa; /* [V-CODE] adaptiveBlue500  — 5.54:1        */
  --accent-hover:    #449bff; /* [V-CODE] adaptiveBlue600                  */
  --accent-on-float: #449bff; /* [D] step up over #2c2c35                  */
  --danger:          #f04251; /* [V-CODE] adaptiveRed500                   */
  --danger-hover:    #fa616d; /* [V-CODE] adaptiveRed600                   */
  --positive:        #16bb76; /* [V-CODE] adaptiveGreen500                 */
  --warning:         #ffb134; /* [V-CODE] adaptiveYellow500                */
  /* weak tints: alpha of the accent, per §2.5's 7–15% band               */
  --accent-weak:     rgba(52,133,250,0.11); /* [D]                         */
  --danger-weak:     rgba(240,66,81,0.11);  /* [D]                         */

  /* ── shadow: only for genuinely floating surfaces ───────────────────── */
  --shadow-tiny:   0  1px  3px rgba(2,9,19,0.91); /* [V-CODE]              */
  --shadow-weak:   0  2px 30px rgba(2,9,19,0.91); /* [V-CODE]              */
  --shadow-medium: 0 16px 60px rgba(2,9,19,0.91); /* [V-CODE]              */

  /* ── radius: anchored to component size, per §4.2 ───────────────────── */
  --r-skeleton: 6px;  --r-control: 8px;  --r-row-press: 12px;
  --r-input: 14px;    --r-cta: 16px;     --r-dialog: 24px;
  --r-sheet: 28px;    --r-pill: 999px;
}
```

---

## 10. Corrections to `DESIGN.md`

Each is a place where `DESIGN.md` states a Toss-attributed value that the shipped
source contradicts. None invalidate `DESIGN.md`'s decisions — but if the intent is
"Toss is the structural authority", these should move.

| # | `DESIGN.md` says | Verified TDS value | Impact |
|---|---|---|---|
| 1 | Button large/xlarge font is `t5` (17/25.5) | **`st9` (18/27)** [V-CODE §6.1] | Primary CTA labels are 1px larger and 1.5px looser than specified |
| 2 | `letter-spacing: -0.02em` presented as part of "the Korean trio" | **TDS sets no letter-spacing at all** [V-CODE §3.1] | This is a *Papago/Naver* value, correctly used but wrongly attributed. Keep it if it looks right with Pretendard — but it is not Toss |
| 3 | Switch: knob `translateX 0→16`, springs `rapid`/`med` | **`translateX 0→20`**, `{stiffness 1000, damping 52}` [V-CODE §6.8] | Knob under-travels by 4px |
| 4 | Segmented control: `height 32`, `radius pill`, `inset 2px` | `small ≈38.5` / `medium ≈47.5`; group radius **10 / 15**; inset **3 / 4–5** [V-CODE §6.9] | Not Toss geometry. Toss's segmented control is not a pill and is much taller |
| 5 | Shadows `rgba(0,0,0,.40)` / `.40` / `.50` | Dark: **all three are `rgba(2,9,19,0.91)`** with blur `3 / 30 / 60` [V-CODE §4.3] | Blur radii match; the colours are far more opaque and slightly blue |
| 6 | Hover `rgba(255,255,255,0.04)`, press `rgba(255,255,255,0.08)` | Press is **`rgba(217,217,255,0.11)`** — violet-tinted, 11% [V-CODE §2.4] | Press reads noticeably weaker and hue-neutral vs Toss |
| 7 | ListRow "padding 12px/24px", divider inset 24 | Padding correct for web. **The press underlay is inset `4px/6px` at `radius 12`** — a floating highlight, not full-bleed [V-CODE §6.2] | The single most Toss-identifying interaction detail, currently missing |
| 8 | Line-height derived by the 3-branch rule | Correct — **but `ListRow` overrides to `fontSize × 1.35`** [V-CODE §3.3] | Lists will render ~11% looser than Toss's |
| 9 | Tinted badges use one alpha, `0.16` | Toss uses a **lightness-dependent 7–15% curve** derived from the seed [V-CODE §2.5] | `0.16` is outside Toss's band at every lightness |
| 10 | "No loading animation when there's nothing to wait for", quoted as Toss | **Not attributable.** Toss's published case is the opposite nuance [V-DOC §5.1] | Keep the behaviour; drop the attribution, or requote as 『유난한 도전』 |
| 11 | Dialog left button "always 닫기, never 취소" | Doctrine-adjacent, not in code. Defensible from the error-message articles but not a TDS spec | Label as inferred |
| 12 | Radius ladder caps at `16px` for cards | Toss's `Dialog` is **24**, `BottomSheet` **28** [V-CODE §4.2] | Large desktop panels at 20–24 are more Toss-like than 16 |
| 13 | `--nova-fg-secondary #8B95A1`, `--nova-fg-tertiary #6B7684` | These are **light-mode** `grey500`/`grey600`. Dark-ramp counterparts are `#9e9ea4` / `#7e7e87` [V-CODE §2.2] | Contrast is fine; the tokens are cross-mode borrowings |
| 14 | Skeleton = "9 named layout archetypes" | Correct. Names: `topList`, `topListWithIcon`, `amountTopList`, `amountTopListWithIcon`, `subtitleList`, `subtitleListWithIcon`, `listOnly`, `listWithIconOnly`, `cardOnly` [V-DOC §6.13] | Adds the actual names |
| 15 | Loading dots "staggered 0.1s/0.2s, opacity .2→1 + scale .8→1, 0.3s reversing" | `8×8`, `radius 99`, **`gap 7`**, `opacity 0.2↔1`, **`300ms` linear loop** — no scale animation in the shipped code [V-CODE §6.1] | Drop the scale |

**Also worth adding rather than correcting:** `DESIGN.md` has no mention of the
**wiggle-on-rejection** triggers (disabled toggle, refused dismiss), the **`Border`
16px grey block** as the section separator, the **ListRow ≥560px vertical reflow**,
or the **`ListRow` 15-archetype taxonomy** — all four are high-leverage.

---

## 11. What NOT to copy from Toss

Toss is a one-handed, 375px-wide, touch-only, light-first product. Six things in it
would be actively wrong here.

**1. Bottom sheets as the primary modal.**
Toss's `BottomSheet` (`radius 28`, 70% max height, `translateY` on `spring.quick`,
a `48×4` drag handle) exists because the thumb is at the bottom of the screen. On
desktop the pointer is wherever the user left it and the window is not held.
Use `Dialog` — which Toss also ships, at `width 312 / radius 24` — scaled up to a
desktop width, or a non-modal inline panel. **Keep the sheet only for the one case
where content genuinely continues off-screen.** The `48×4` handle in particular is a
drag affordance for a gesture that does not exist with a mouse; drop it.

**2. Thumb-zone bottom navigation and `FixedBottomCTA`.**
`BottomCTA` / `FixedBottomCTA` pin the primary action to the bottom edge with
`padding: 0 20px 18px` and a gradient fade above it. That is a reachability fix.
On desktop it costs you a permanent horizontal band of the window and puts the
primary action as far as possible from the content it acts on. Put the action next to
its object. `DESIGN.md`'s sticky transport bar is a *different* thing (a
media-player chrome, always relevant) and is fine.

**3. The 44px touch floor everywhere.**
`ListRow min-height: 44` is a touch target. With a mouse, the useful floor is
**~28–32px** for rows and **24px** for icon buttons. Keeping 44px on a meeting list
throws away ~35% of the rows visible per screen for no gain — and it fights the
"protagonist" goal directly, because every pixel of chrome height is a pixel not
spent on the subtitle. Note Toss's own `Button small` is already **32px**
[V-CODE §6.1], so 32 has TDS precedent.

**4. `WheelDatePicker`.**
Three spinning 3D wheels in a 240px sheet, `perspective: 1000px`,
`backface-visibility: hidden`, labels `2026년 / 7월 / 25일`, CTA `적용`
[V-CODE §8.3]. This is an iOS-picker idiom that only makes sense for a thumb flick.
On desktop, type into a field or click a day in a calendar grid. Toss's own
`DatePicker` (a real 7-column grid, keyboard-navigable with arrows and PageUp/Down)
is the one to port — **that** one is desktop-ready almost as-is.

**5. `RN ListRow verticalPadding: 24` as the default.**
Toss's RN default row is 24px top *and* bottom before content. Use the web default
**12** (§4.4).

**6. Haptics, and mobile-only affordances generally.**
`tickWeak` on icon-button press and `wiggle` on rejection [V-CODE §5.4] have no
Electron equivalent. **Keep the visual wiggle; drop the haptic and do not substitute
a sound.** Likewise: pull-to-reveal gestures (Toss shipped one for its calendar and
it failed even on mobile — §8.5), `lineBreakStrategyIOS` (use CSS `word-break:
keep-all`), and Android `elevation` mapping.

**One thing to copy that looks mobile but is not:**
`ListRow`'s inset press underlay (§6.2) reads like a touch-highlight idiom, but on
desktop it is *better* than a full-bleed hover row — the floating rounded highlight
never collides with the divider, so a pointer sweeping a long list produces a clean
single shape instead of stacked edge-to-edge bands. Port it, and use it for hover too
(§9.3).

---

## 12. Remaining gaps — where a developer will have to decide

Ordered by how likely they are to come up.

1. **Hover, focus, and keyboard states.** TDS has none. §9.3–9.4 gives a derived
   construction; everything there beyond `adaptiveOpacity100/200/300` is [X].
2. **Any layout wider than a phone.** No grid, no breakpoints, no max-widths, no
   multi-column guidance. The only wide-viewport signal in all of TDS is `ListRow`'s
   560px reflow and the `PcScreenBg` token (§2.3, §9.5).
3. **A caption/display type ramp above 30px.** `t1` is the ceiling. Anything larger is
   outside TDS.
4. **The date-group header.** Format, weekday, relative labels, stickiness, group
   spacing, subtotals — all unpublished (§8.6).
5. **The post-2025 OKLCH token values.** Naming is public; values are not (§2.7).
6. **`bounce` as CSS.** Not expressible as a monotone bezier (§5.3).
7. **Contrast targets.** Toss has never stated one. The ratios in §9.2 are computed
   by me, not adopted from Toss.
8. **Toss Product Sans.** Not licensable, and its family name is obfuscated in the
   shipped code specifically so it is not reused (§3.1). Pretendard, per
   `DESIGN.md`.
9. **Tabular figures.** Toss gets them from the font; with Pretendard you must
   request them in CSS (§3.7).
10. **Empty-state illustration.** `Result` takes an arbitrary `figure` node; TDS
    provides no illustration set.

### Reproducing the code evidence

```sh
npm pack @toss/tds-colors@0.1.0          # colors.css, colors.dark.css, colors.light.css
npm pack @toss/tds-typography@0.0.3      # textSizeMap, iconSizeMap, badgeSizeMap, linkSizeMap
npm pack @toss/tds-easings@0.0.1         # bezier{}, spring{}, the integrator
npm pack @toss/tds-react-native@2.0.4    # per-file unminified component source
npm pack @toss/tds-mobile@2.5.0          # web components — incl. the undocumented DatePicker
```

Everything marked [V-CODE] in this document is a literal value in one of those five
tarballs. The spring durations and cubic-bezier fits in §5.3 come from
re-implementing `@toss/tds-easings`'s own RK4 integrator (`dt = 1/60`,
`tolerance = 0.01`, `a = −k·x − c·v`, `mass` ignored) and least-squares-fitting a
cubic-bezier to the resulting ease function at 60 sample points.

---

*Research deliverable. No application code was changed.*
