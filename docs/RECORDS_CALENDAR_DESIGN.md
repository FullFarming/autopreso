# Records as a calendar + app-wide Toss redesign

Design for replacing the Spotify-style record list with an Outlook-style meeting
calendar, and for restyling the Electron app (controller excluded — it stays as
is) against Toss design policy.

Status: design. Phase 1 not yet implemented.

## 1. Requirements

**Functional**

- Records are presented as a calendar anchored on today, switchable between
  **month / week / day**.
- A meeting occupies its real time span: anchored on the **Live Call's actual
  start**, ending when the call ended.
- Clicking a meeting opens its **source transcript (원문 기록)** and **AI summary**.
- Only **Live Call meetings** appear on the calendar (decided 2026-07-25). Local
  subtitle-only sessions are still recorded and must remain reachable, but not
  on the calendar.
- No explanatory copy anywhere in the UI (standing product rule).

**Non-functional**

- Opening the calendar must not scale with transcript size. A month of 2-hour
  meetings is tens of MB of JSON today (see §3.2).
- The subtitle is the protagonist; app chrome recedes.
- Dark, pure-black `#0A0A0B` base with layered surfaces.
- Sessions run 2h+, so a meeting block must render correctly when it crosses
  midnight or overlaps another meeting.

**Constraints**

- Do not change `~/.config/realtime-noel/` layout in a way that orphans existing
  records — ~20 exist on this machine already.
- Additive schema changes only; old record files must keep loading.
- The controller UI is explicitly out of scope.

## 2. What already exists (verified, not assumed)

| Fact | Evidence |
|---|---|
| Store path + shape `{id,title,startedAt,endedAt,lines[],summary,audioSources}` | `src/session-transcripts.js` `writeSessionFile` |
| `list()` returns `metaOf`: `id,title,startedAt,endedAt,lineCount,hasSummary,audioSources`, sorted desc | `session-transcripts.js:226-240,295-306` |
| A record begins **only** on `subtitle:start` | `src/server.js:596` |
| `begin()` is idempotent per `sessionId`; caption restart reuses the same id | `session-transcripts.js:70`, `public/subtitle-dashboard.js:1280-1288` |
| **A detail view with 원문 기록 + AI 요약 already exists** | `public/subtitle.html:342-356` |
| Current cards are gradient "album art" with a 2-char mark | `subtitle-dashboard.js:874-901`, `SESSION_COVER_GRADIENTS` |
| Live Call sessions carry a title | `electron/main.js:1577` |
| Live Call start time reaches the desktop (drives the controller's elapsed clock) | controller `setLiveElapsed(startedAtIso)` |

Consequence: **restart does not fragment a meeting into several records.** I
suspected it did; it does not.

## 3. Gaps that block the calendar

### 3.1 Four data gaps

| # | Gap | Effect on the calendar |
|---|---|---|
| G1 | No marker distinguishing a Live Call record from a local one | Cannot honour "Live Call meetings only" |
| G2 | `begin({sessionId})` passes no title, so `title` is always `""` | Every block would be untitled; today's UI falls back to a timestamp |
| G3 | `endedAt` is `""` if the process dies mid-session | A block with no end cannot be laid out |
| G4 | `startedAt` is the *subtitle* start, not the Live Call start | Block is anchored to the wrong moment |

### 3.2 A performance gap

`list()` calls `readSessionFile` on every `.json`, which `JSON.parse`s the whole
file **including all `lines`** (cap 20,000) to produce six fields. At roughly
150 bytes/line that is ~3MB per 2-hour meeting. The transcript directory is
already 72MB. A month view would parse every meeting in that month on every
open, on the UI thread's server round-trip.

This is pre-existing and invisible today only because the flat list is opened
rarely and the current records are small.

## 4. Design

### 4.1 Schema (additive)

Add to the persisted payload, all optional so old files keep loading:

```js
kind: "live-call" | "local"   // absent → "local"
liveSessionId: string         // Supabase live session id, when kind === "live-call"
```

`startedAt` / `endedAt` remain the authoritative interval, but for a Live Call
they are set from the **Live Call's** clock, closing G4. `begin()` grows optional
`{ kind, liveSessionId, title, startedAt }`; when `startedAt` is supplied it wins
over `now()`. Callers that pass nothing behave exactly as today.

Title (G2): for a Live Call, thread the session title through `begin()`. For a
local session leave it empty and let the UI fall back — and once a summary
exists, prefer `summary.title`, which the summariser already produces.

### 4.2 Effective end time (G3)

Never write a guessed end. Derive it at read time so a crashed session is
recoverable and the rule can change later:

```
effectiveEnd = endedAt
            || lastLine.at              // last recorded transcript line
            || startedAt + MIN_BLOCK    // MIN_BLOCK = 15min, layout floor only
```

Records ending via the fallback are marked so the UI can show them as
unterminated rather than silently inventing a duration.

### 4.3 A meta index for cheap listing

Write `<id>.meta.json` next to `<id>.json` on begin / end / summarize, holding
exactly the `metaOf` fields plus `kind` and `liveSessionId`. `list()` reads meta
files only; when one is missing it falls back to a full parse **and writes the
meta file**, so the ~20 existing records self-heal on first listing with no
migration step.

Trade-offs considered:

| Option | Why not |
|---|---|
| Single global `index.json` | One writer for all sessions; a crashed write loses the whole index, and concurrent sessions contend |
| Bounded head-read of each `.json` | Works only because metadata precedes `lines` in the serialized object — brittle coupling to field order |
| Do nothing | Month view cost grows without bound with transcript length |
| **Per-session `<id>.meta.json`** | **Chosen.** Desync is per-session and self-healing; no lock; no migration |

### 4.4 Query surface

`GET /api/subtitles/sessions` gains optional `from`, `to`, `kind`. Filtering
happens server-side against meta files so the response is bounded by the visible
range rather than by history size. The existing no-parameter call keeps its
current behaviour.

### 4.5 View model

One pure module, `public/records-calendar.js`, with no DOM knowledge, so it is
testable in the root suite the way the existing frontend logic is:

- `buildMonthGrid(anchor, meetings)` → 6×7 day cells, each with the meetings
  intersecting that day.
- `buildWeekLanes(anchor, meetings)` → 7 columns × time rows, with overlap
  resolved into side-by-side lanes (greedy interval colouring).
- `buildDayLanes(anchor, meetings)` → single column, same lane algorithm.
- A meeting spanning midnight appears in **both** days, clipped to each — with
  the same id, so navigation stays coherent.

Rendering stays in `subtitle-dashboard.js`, built with `createElement` (the
no-`innerHTML` rule holds).

### 4.6 Navigation

The calendar replaces the flat list on the Records page. Clicking a block opens
the **existing** detail page — no new detail UI is built. Local (non-Live-Call)
records get a plain list reachable from the Records page, since they have no
calendar home.

## 5. Visual layer

Token values come from `docs/TOSS_DESIGN_REFERENCE.md` (separate research
deliverable); this document deliberately does not invent them. The approach:

1. Define the token layer as CSS custom properties on `:root` in `subtitle.css`.
2. Build the calendar directly on those tokens.
3. Migrate the remaining surfaces (captions config, Live Call, settings, history)
   onto the same tokens.

Toss's date-grouped transaction list is the closest published Toss analogue to a
meeting calendar and is the reference for the day/agenda presentation.

## 6. Phasing

| Phase | Scope | Reversible? |
|---|---|---|
| 1 | Token layer in `subtitle.css` | Yes — additive variables |
| 2 | Schema + meta index + effective-end + query params, with tests | Yes — additive, self-healing |
| 3 | Calendar view model + month/week/day rendering; delete the gradient cards | Yes |
| 4 | Restyle remaining surfaces onto the tokens | Yes, per surface |

Phase 2 is the only one touching persisted user data; it is additive and
self-healing, and old files stay loadable.

## 7. What I would revisit

- **Supabase as the source of truth for meetings.** Today the calendar is built
  from local transcript files, so a meeting hosted from another machine is
  invisible. `live_sessions` already holds the authoritative interval and title.
  If hosting ever moves across machines, the calendar should read Supabase and
  treat local transcripts as a cache.
- **Recurring meetings** — no support, and none needed until sessions are
  scheduled rather than started ad hoc.
- **Timezone.** Everything is stored ISO/UTC and rendered in local time. A host
  travelling mid-project would see historical blocks shift; acceptable now,
  wrong if meeting times ever become contractual.
- **The 15-minute layout floor** is arbitrary; it exists only so a crashed
  zero-length session is still clickable.
