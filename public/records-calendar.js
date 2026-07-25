// Records calendar view model. Pure: no DOM, no fetch, so the day/week/month
// placement rules are testable in the root suite (test/records-calendar.test.js).
//
// Everything is computed in LOCAL time because that is what the host reads.
// Records are stored ISO/UTC; the conversion happens here and nowhere else.

const MINUTES_PER_DAY = 24 * 60;
// A meeting that crashed before recording anything can have zero length. Give it
// a floor so the block is still large enough to click.
const MIN_SEGMENT_MINUTES = 12;

export function startOfDay(date) {
  const copy = new Date(date.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Clip one meeting to each local day it touches. A meeting crossing midnight
 *  yields one segment per day, all sharing the meeting's id so clicking any of
 *  them opens the same record. */
export function splitByDay(meeting) {
  const startMs = Date.parse(meeting?.startedAt ?? "");
  if (!Number.isFinite(startMs)) return [];
  const rawEndMs = Date.parse(meeting?.effectiveEnd ?? meeting?.endedAt ?? "");
  // An unparseable end is treated as a zero-length meeting, which the minimum
  // below then makes visible, rather than dropping the record entirely.
  const endMs = Number.isFinite(rawEndMs) && rawEndMs >= startMs ? rawEndMs : startMs;

  const start = new Date(startMs);
  const end = new Date(endMs);
  const segments = [];
  let cursor = startOfDay(start);
  const lastDay = startOfDay(end);

  while (cursor.getTime() <= lastDay.getTime()) {
    const isFirst = isSameDay(cursor, start);
    const isLast = isSameDay(cursor, end);
    const startMinute = isFirst ? start.getHours() * 60 + start.getMinutes() : 0;
    const endMinute = isLast ? end.getHours() * 60 + end.getMinutes() : MINUTES_PER_DAY;
    segments.push({
      id: meeting.id,
      title: meeting.title ?? "",
      kind: meeting.kind ?? "local",
      isUnterminated: Boolean(meeting.isUnterminated),
      hasSummary: Boolean(meeting.hasSummary),
      date: new Date(cursor.getTime()),
      startMinute,
      endMinute,
      isContinuation: !isFirst,
      continuesNext: !isLast,
      startedAt: meeting.startedAt,
      effectiveEnd: meeting.effectiveEnd ?? meeting.endedAt ?? "",
    });
    cursor = addDays(cursor, 1);
  }

  // Only the final segment can be too short; the clipped ones run to midnight.
  const tail = segments[segments.length - 1];
  if (tail && tail.endMinute - tail.startMinute < MIN_SEGMENT_MINUTES) {
    tail.endMinute = Math.min(MINUTES_PER_DAY, tail.startMinute + MIN_SEGMENT_MINUTES);
  }
  return segments;
}

/** Greedy interval colouring: each segment takes the first lane whose previous
 *  segment has already finished. Two meetings that overlap can never share a
 *  lane, and a meeting clear of the others falls back to lane 0. */
function assignLanes(segments) {
  const ordered = [...segments].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  /** @type {number[]} */
  let laneEnds = [];
  // Width comes from the block's own overlap cluster, not from the day. A day
  // holding one overlapping pair must not squeeze every OTHER meeting on it to
  // half width -- a meeting that overlaps nothing fills the column.
  /** @type {any[]} */
  let cluster = [];
  let clusterEnd = -1;
  let widest = 0;

  const closeCluster = () => {
    const lanes = cluster.reduce((max, segment) => Math.max(max, segment.lane + 1), 0);
    for (const segment of cluster) segment.clusterLaneCount = lanes;
    widest = Math.max(widest, lanes);
    cluster = [];
    laneEnds = [];
    clusterEnd = -1;
  };

  for (const segment of ordered) {
    // A gap with no live segment ends the cluster and resets the lanes.
    if (cluster.length > 0 && segment.startMinute >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= segment.startMinute);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(segment.endMinute);
    } else {
      laneEnds[lane] = segment.endMinute;
    }
    segment.lane = lane;
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.endMinute);
  }
  if (cluster.length > 0) closeCluster();

  return { segments: ordered, laneCount: widest };
}

/** Day (days=1) and week (days=7) views: a time grid with overlap lanes. */
export function buildTimeGrid({ anchor, meetings = [], days = 1, weekStartsOn = 0, today = new Date() }) {
  const base = startOfDay(anchor);
  let first = base;
  if (days === 7) {
    const shift = (base.getDay() - weekStartsOn + 7) % 7;
    first = addDays(base, -shift);
  }

  const allSegments = meetings.flatMap((meeting) => splitByDay(meeting));
  const result = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(first, offset);
    const daySegments = allSegments.filter((segment) => isSameDay(segment.date, date));
    const { segments, laneCount } = assignLanes(daySegments);
    result.push({ date, segments, laneCount, isToday: isSameDay(date, today) });
  }
  return { days: result, minutesPerDay: MINUTES_PER_DAY };
}

/** Month view: whole weeks, padded with adjacent-month days so every row is 7
 *  cells. Cells carry the meetings touching that day, not time-positioned. */
export function buildMonthGrid({ anchor, meetings = [], weekStartsOn = 0, today = new Date() }) {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const leading = (monthStart.getDay() - weekStartsOn + 7) % 7;
  const gridStart = addDays(monthStart, -leading);
  const totalCells = Math.ceil((leading + monthEnd.getDate()) / 7) * 7;

  const allSegments = meetings.flatMap((meeting) => splitByDay(meeting));
  const weeks = [];
  for (let index = 0; index < totalCells; index += 1) {
    if (index % 7 === 0) weeks.push([]);
    const date = addDays(gridStart, index);
    weeks[weeks.length - 1].push({
      date,
      isCurrentMonth: date.getMonth() === anchor.getMonth(),
      isToday: isSameDay(date, today),
      meetings: allSegments
        .filter((segment) => isSameDay(segment.date, date))
        .sort((a, b) => a.startMinute - b.startMinute),
    });
  }
  return { anchorMonth: monthStart, weeks };
}
