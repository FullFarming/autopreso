# Cushman & Wakefield Brand Design Policy

Source documents:
- `/Users/kyeongmankim/Downloads/CW Brand Color Guidelines.pdf` (June 2024)
- `/Users/kyeongmankim/Downloads/Logo and Photography Use Policy.pdf` (October 2025)

This document converts the attached Cushman & Wakefield brand PDFs into a practical `DESIGN.md`-style reference for product, presentation, and marketing work. It intentionally documents only what the PDFs support. Typography, spacing, layout, and UI component systems are not inferred from the PDFs.

## Overview

Cushman & Wakefield's documented brand system is built around a disciplined corporate palette: deep Indigo, strong Red, neutral Grey, and White as primary colors, supported by Blue, Yellow, Green, and Dark Red. The palette is not a decorative free-for-all. Red and Indigo carry brand weight and must not be diluted with tints. Green is a brand color but must not become a dominant layout color because it can create competitor confusion.

The color guidance is especially strict in data-heavy and accessibility-sensitive contexts. Dark Grey is recommended for body and chart text, contrast must be checked, and charts should use tint variation and whitespace rather than stacking saturated colors directly against each other.

The logo and photography policy adds a second layer: visual assets are not just design choices, they are rights-managed materials. Client logos, client names, building imagery, stock photography, and CoStar/LoopNet media all require usage-context checks before publication.

**Key Characteristics**
- Primary palette: Indigo, Red, Grey, White.
- Secondary palette: Blue, Yellow, Green, Dark Red.
- Approved tints exist only for Grey, Blue, Yellow, Green, and Dark Red.
- No tints of Indigo or Red.
- Red is used sparingly; in charts, tables, and graphs it is reserved for negative data.
- Green must not be the dominant color and Green 100% / Green 75% must not be used as background colors.
- Dark Grey is the recommended body and chart text color in Microsoft Office contexts.
- Contrast and color-blindness simulation are required checks for accessible color use.
- Client logos and names have different approval rules for limited distribution versus public distribution.
- Web-copied imagery and rights-uncleared imagery are prohibited for external/public use.

## Colors

> Source analyzed: `CW Brand Color Guidelines.pdf`, pages 2-14 and appendix pages 16-22.

### Primary Colors

Primary colors are the foundation of all brand applications.

| Token | Name | PMS | CMYK | RGB | HEX | Usage |
|---|---|---|---|---|---|---|
| `{colors.indigo}` | Indigo | PMS 2765 | 96, 96, 42, 49 | 29, 23, 64 | `#1D1740` | Primary brand color. Do not tint. |
| `{colors.red}` | Red | PMS 185 | 0, 100, 93, 0 | 228, 0, 43 | `#E4002B` | Primary brand color. Use sparingly. Do not tint. |
| `{colors.grey}` | Grey | PMS 425 | 65, 55, 54, 29 | 84, 88, 89 | `#545859` | Primary neutral. Recommended for body and chart text. |
| `{colors.white}` | White | White | 0, 0, 0, 0 | 255, 255, 255 | `#FFFFFF` | Primary light surface. |

### Secondary Colors

Secondary colors enhance the primary palette and should be used with the primary colors, not as a replacement system.

| Token | Name | PMS | CMYK | RGB | HEX | Usage |
|---|---|---|---|---|---|---|
| `{colors.blue}` | Blue | PMS 6129 | 86, 26, 26, 0 | 0, 147, 173 | `#0093AD` | Secondary accent. |
| `{colors.yellow}` | Yellow | PMS 143 | 5, 31, 92, 0 | 241, 180, 52 | `#F1B434` | Secondary accent. Check contrast carefully. |
| `{colors.green}` | Green | PMS 2419 | 88, 28, 78, 14 | 0, 124, 88 | `#007C58` | Secondary accent. Do not use as dominant layout color or background. |
| `{colors.dark-red}` | Dark Red | PMS 2350 | 27, 100, 100, 30 | 142, 16, 0 | `#8E1000` | Secondary accent. Avoid direct adjacency with Green in charts. |

### Approved Tints

Only Grey, Blue, Yellow, Green, and Dark Red may use tints. Tints of Indigo and Red are prohibited because they dilute the impact of the primary colors.

| Token | Base | Tint | HEX | Background Use |
|---|---|---:|---|---|
| `{colors.grey-75}` | Grey | 75% | `#7F8283` | Allowed |
| `{colors.grey-50}` | Grey | 50% | `#AAACAC` | Allowed |
| `{colors.grey-25}` | Grey | 25% | `#D4D5D6` | Allowed |
| `{colors.grey-12}` | Grey | 12% | `#EAEBEB` | Allowed |
| `{colors.blue-75}` | Blue | 75% | `#40AEC2` | Allowed |
| `{colors.blue-50}` | Blue | 50% | `#80C9D6` | Allowed |
| `{colors.blue-25}` | Blue | 25% | `#BFE4EB` | Allowed |
| `{colors.blue-12}` | Blue | 12% | `#E0F2F5` | Allowed |
| `{colors.yellow-75}` | Yellow | 75% | `#F4C767` | Allowed |
| `{colors.yellow-50}` | Yellow | 50% | `#F8DA9A` | Allowed |
| `{colors.yellow-25}` | Yellow | 25% | `#FCECCC` | Allowed |
| `{colors.yellow-12}` | Yellow | 12% | `#FDF6E7` | Allowed |
| `{colors.green-75}` | Green | 75% | `#409D82` | Background prohibited |
| `{colors.green-50}` | Green | 50% | `#80BEAC` | Allowed |
| `{colors.green-25}` | Green | 25% | `#BFDED5` | Allowed |
| `{colors.green-12}` | Green | 12% | `#E0EFEB` | Allowed |
| `{colors.dark-red-75}` | Dark Red | 75% | `#AA4C40` | Allowed |
| `{colors.dark-red-50}` | Dark Red | 50% | `#C78880` | Allowed |
| `{colors.dark-red-25}` | Dark Red | 25% | `#E3C3BF` | Allowed |
| `{colors.dark-red-12}` | Dark Red | 12% | `#F1E2E0` | Allowed |

### Prohibited Tints

| Token | Rule |
|---|---|
| `{colors.indigo-*}` | Do not create or use Indigo tints. |
| `{colors.red-*}` | Do not create or use Red tints. |

### Background Colors

Most palette colors and approved tints can be used as backgrounds, with these exceptions:

| Color | Background Rule | Reason |
|---|---|---|
| `{colors.green}` | Do not use as a background. | Avoid competitor confusion. |
| `{colors.green-75}` | Do not use as a background. | Avoid competitor confusion. |
| `{colors.indigo-*}` | Do not use; tints are prohibited. | Primary color dilution. |
| `{colors.red-*}` | Do not use; tints are prohibited. | Primary color dilution. |

Green also must not be used as the dominant color in a layout, including gradients and duotone-style treatments.

### Text Colors

| Token | HEX | Usage |
|---|---|---|
| `{colors.text-primary}` | `#545859` | Use Grey for body and chart text when following the PDF guidance. |
| `{colors.text-on-dark}` | `#FFFFFF` | Use on dark brand backgrounds only after contrast check. |

The PDF recommends 90% black for body text but does not specify an exact HEX value. Do not invent a separate 90% black token without brand approval.

## Accessibility

> Source analyzed: `CW Brand Color Guidelines.pdf`, accessibility section and contrast appendix.

### Contrast

The PDF points teams to Adobe's color contrast checker and states a minimum contrast ratio of 3:1. Product teams should treat this as the minimum documented brand threshold and still apply stricter WCAG requirements when the target medium requires them.

| Pairing | Documented Result | Rule |
|---|---|---|
| Yellow text on Indigo background | Pass | Allowed after contrast check. |
| Indigo text on Yellow background | Pass | Allowed after contrast check. |
| White text on Yellow background | Fail | Avoid. |
| Yellow text on White background | Fail | Avoid. |

### Color-Blindness Checks

Use a color-blindness simulator for important charts, diagrams, and UI states. The PDF names Colbis and Adobe Illustrator's Protanopia / Deuteranopia proof setup as acceptable tools.

### Practical Accessibility Rules

- Do not encode state using color alone.
- Keep chart labels in dark Grey unless a specific brand-approved exception exists.
- Add whitespace or white separation lines between chart segments when adjacent colors need additional contrast.
- Re-check Yellow combinations before use; Yellow fails in common white/yellow pairings.

## Data Visualization

> Source analyzed: `CW Brand Color Guidelines.pdf`, chart color combination samples.

### Chart Rules

| Rule | Requirement |
|---|---|
| Chart text | Use dark Grey. |
| Red | Avoid in charts, tables, and graphs unless showing negative data. |
| Green + Dark Red | Do not place directly next to each other in the same chart. |
| Indigo / Red tints | Do not use. |
| Saturated-only palettes | Avoid using only primary and secondary colors in a single chart. Add approved tints for contrast and hierarchy. |
| Separation | Use whitespace or lines between chart elements to improve contrast. |

### Recommended Chart Palette Strategy

Use one strong brand color for the main signal, then approved tints for secondary series. Reserve Red for negative values, errors, or loss indicators where the data semantics justify it.

## Typography

The provided PDFs do not define a digital typography scale, line-height system, tracking, or UI font tokens.

### Microsoft Office Font Guidance

| Context | Rule |
|---|---|
| Microsoft theme | Gotham and Gotham Bold are the default theme fonts. |
| PowerPoint templates | Gotham can be embedded in template files for users without local font installation. |
| Microsoft fallback | Arial is permitted in Microsoft products. |
| Bold styling | Do not apply synthetic bold to Gotham Book; select Gotham Bold from the font dropdown. |

Do not create product typography tokens from this section alone. If a digital product typography system is needed, request the full brand identity guidelines or explicit brand approval.

## Logo Usage Policy

> Source analyzed: `Logo and Photography Use Policy.pdf`, logo section.

Logo and client-name use depends on distribution context.

| Context | Approval Rule | Notes |
|---|---|---|
| Presentations, proposals, internal meetings, limited distribution | Client logos may be used without client approval if the representation is accurate and no known contractual restriction exists. | Keep the use factual and limited. |
| Media, web, industry events, external collateral, public distribution | Written client approval is required per use event for client name or logo. | Email approval can be sufficient if it clearly approves the specific use. |
| Prior approved publicity | Does not automatically grant universal logo/name approval. | Re-check approval scope before reuse. |

### Logo Compliance Checklist

- Confirm whether the output is limited distribution or public distribution.
- Confirm the representation is accurate.
- Check for known contractual restrictions.
- For public distribution, attach written client approval for the specific use.
- Do not treat a previous one-off approval as blanket approval.

## Photography And Imagery Policy

> Source analyzed: `Logo and Photography Use Policy.pdf`, photography, stock imagery, property imagery, and CoStar/LoopNet sections.

### General Imagery Rules

Professional-quality photography is required for brand presentation, but image quality does not override licensing. Images copied from websites or digital resources are prohibited unless rights are explicitly cleared.

| Asset Type | Rule |
|---|---|
| Website images | Do not copy and paste imagery from public, government, nonprofit, subscription, or other websites without rights clearance. |
| Royalty-free images | Royalty-free does not mean free to use. Purchase or license terms still apply. |
| Maps, floor plans, aerials, illustrations | Treat as imagery subject to rights and licensing. |
| External collateral / public distribution | Do not use non-licensed imagery. |

### Adobe Stock

| Asset Type | Allowed Use | Restriction |
|---|---|---|
| Standard assets | Perpetual worldwide license for print, presentations, broadcasts, websites, and social media. | Confirm asset is standard and obtained under C&W's enterprise account. |
| Internal/external sharing | Assets may be shared by email within or between C&W markets and on internal or external websites. | Keep the asset within the license scope. |
| Editorial Use Only | Use only for newsworthy/public-interest topics such as news articles or similar editorial contexts. | Do not use for ads, promotions, or commercial marketing. |
| Other stock providers | Review that provider's license before use. | Do not assume Adobe Stock terms apply elsewhere. |

### Property Imagery

| Scenario | Requirement |
|---|---|
| Owner/client provides building imagery | Confirm written permission from the owner/client to use the media in property marketing. |
| Photographer is hired | Obtain written permission from the photography rights owner for property marketing use. |
| Interior photography includes people | Make individuals non-recognizable through silhouettes, blurred faces, or distant shots. |

Building ownership does not automatically mean image ownership. Always confirm media rights separately.

### CoStar / LoopNet

| Rule | Requirement |
|---|---|
| Marketing use | CoStar Group media may be used to market properties C&W represents on the global website, social channels, and digital or printed marketing materials. |
| Modification | Do not alter or modify CoStar Group media. |
| Watermarks | Retain all CoStar Group watermarks. |
| Customer-submitted media | Ownership remains with the submitting customer; usage and manipulation depend on the actual media owner's terms. |
| Internal storage | Do not save CoStar Group media to internal or proprietary databases or digital asset management systems. |

## Components

The PDFs do not define web UI components. The following entries are policy components: reusable decision patterns for applying the brand safely.

### `{component.brand-color-palette}`

Use only documented primary colors, secondary colors, and approved tints. Do not add ad hoc brand colors.

### `{component.chart-palette}`

Use dark Grey text, approved tints, and whitespace separation. Reserve Red for negative data. Avoid adjacent Green and Dark Red.

### `{component.logo-approval-gate}`

Before using a client name or logo, classify distribution as limited or public. Public distribution requires written approval for the specific use.

### `{component.image-rights-gate}`

Before using imagery, record source, license or permission, usage scope, and restrictions. Reject copied web imagery and unclear property imagery.

### `{component.costar-media-gate}`

For CoStar/LoopNet assets, enforce no modification, watermark retention, and no internal DAM/database storage.

## Do's And Don'ts

### Do

- Use the documented primary and secondary colors exactly as specified.
- Use approved tints only for Grey, Blue, Yellow, Green, and Dark Red.
- Use Grey for body and chart text unless a more specific approved text token exists.
- Check contrast before pairing Yellow with light backgrounds or White text.
- Use whitespace or separator lines to improve chart contrast.
- Keep Red sparse and data-semantic.
- Confirm client logo/name approvals based on distribution context.
- Confirm image rights before any external or public use.
- Preserve CoStar/LoopNet watermarks and terms.

### Don't

- Do not create tints of Indigo or Red.
- Do not use Green or Green 75% as a background.
- Do not use Green as the dominant layout color, including gradients or duotone treatments.
- Do not use Red in charts, tables, or graphs unless displaying negative data.
- Do not place Dark Red and Green directly next to each other in the same chart.
- Do not use only saturated primary and secondary colors in complex charts.
- Do not copy imagery from websites or digital resources without rights clearance.
- Do not treat "royalty free" as free for unrestricted use.
- Do not use Editorial Use Only stock assets for advertising or promotions.
- Do not modify CoStar Group media or remove its watermarks.
- Do not store CoStar Group media in internal or proprietary DAM/database systems.

## Token Reference

```yaml
colors:
  indigo: "#1D1740"
  red: "#E4002B"
  grey: "#545859"
  white: "#FFFFFF"
  blue: "#0093AD"
  yellow: "#F1B434"
  green: "#007C58"
  dark-red: "#8E1000"

  grey-75: "#7F8283"
  grey-50: "#AAACAC"
  grey-25: "#D4D5D6"
  grey-12: "#EAEBEB"

  blue-75: "#40AEC2"
  blue-50: "#80C9D6"
  blue-25: "#BFE4EB"
  blue-12: "#E0F2F5"

  yellow-75: "#F4C767"
  yellow-50: "#F8DA9A"
  yellow-25: "#FCECCC"
  yellow-12: "#FDF6E7"

  green-75: "#409D82"
  green-50: "#80BEAC"
  green-25: "#BFDED5"
  green-12: "#E0EFEB"

  dark-red-75: "#AA4C40"
  dark-red-50: "#C78880"
  dark-red-25: "#E3C3BF"
  dark-red-12: "#F1E2E0"
```

## Implementation Guardrails

These rules should be lintable if the brand system is later converted into design tokens or code:

- Reject `colors.indigo-*` and `colors.red-*` tint tokens.
- Reject Green 100% and Green 75% as background tokens.
- Warn when Green exceeds a dominant share of a layout.
- Warn when Red is used in data visualization without negative-data semantics.
- Warn when Dark Red and Green are adjacent chart series.
- Require contrast evidence for Yellow pairings.
- Require approval metadata for public client logo/name usage.
- Require source, license, and usage-scope metadata for image assets.
- Reject CoStar/LoopNet assets marked for modification, watermark removal, or internal DAM storage.

## Known Gaps

- No digital typography scale is provided in the attached PDFs.
- No layout grid, spacing system, responsive behavior, or web component library is provided.
- No exact HEX value is provided for the recommended 90% black body text.
- The contrast appendix is visual; this document records the explicit guidance and visible examples, not a full machine-readable contrast matrix.
- This document summarizes brand and usage policy. It is not legal advice.
