import assert from "node:assert/strict";
import test from "node:test";

import { buildMonthGrid, buildTimeGrid, splitByDay } from "../public/records-calendar.js";

// Meetings run 2h+ and can cross midnight, and two hosts can overlap. The view
// model is pure so those cases are testable without a browser.

function meeting(id, startedAt, effectiveEnd, extra = {}) {
  return { id, title: id, kind: "live-call", startedAt, effectiveEnd, isUnterminated: false, ...extra };
}

test("a meeting inside one day yields a single segment with local minute offsets", () => {
  const segments = splitByDay(meeting("m1", "2026-07-25T01:00:00.000Z", "2026-07-25T02:30:00.000Z"));
  assert.equal(segments.length, 1);
  const [only] = segments;
  assert.equal(only.id, "m1");
  assert.equal(only.isContinuation, false);
  assert.equal(only.continuesNext, false);
  // Rendered in local time: the offsets must agree with the local clock.
  const start = new Date("2026-07-25T01:00:00.000Z");
  assert.equal(only.startMinute, start.getHours() * 60 + start.getMinutes());
  assert.equal(only.endMinute - only.startMinute, 90);
});

test("a meeting crossing midnight appears on both days, clipped, keeping one id", () => {
  // 23:30 -> 00:45 local, expressed via local-time construction so the test does
  // not depend on the runner's zone.
  const startLocal = new Date(2026, 6, 25, 23, 30, 0);
  const endLocal = new Date(2026, 6, 26, 0, 45, 0);
  const segments = splitByDay(meeting("night", startLocal.toISOString(), endLocal.toISOString()));

  assert.equal(segments.length, 2, "one meeting, two day segments");
  assert.equal(segments[0].id, segments[1].id, "navigation stays coherent across the split");

  assert.equal(segments[0].startMinute, 23 * 60 + 30);
  assert.equal(segments[0].endMinute, 24 * 60, "first segment is clipped to midnight");
  assert.equal(segments[0].continuesNext, true);
  assert.equal(segments[0].isContinuation, false);

  assert.equal(segments[1].startMinute, 0, "second segment starts at midnight");
  assert.equal(segments[1].endMinute, 45);
  assert.equal(segments[1].isContinuation, true);
  assert.equal(segments[1].continuesNext, false);
});

test("a zero-length meeting still gets a clickable minimum height", () => {
  const at = new Date(2026, 6, 25, 10, 0, 0).toISOString();
  const [only] = splitByDay(meeting("blip", at, at));
  assert.ok(only.endMinute > only.startMinute, "a zero-height block would be unclickable");
});

test("overlapping meetings are assigned side-by-side lanes", () => {
  const day = new Date(2026, 6, 25);
  const mk = (id, sh, sm, eh, em) => meeting(
    id,
    new Date(2026, 6, 25, sh, sm).toISOString(),
    new Date(2026, 6, 25, eh, em).toISOString(),
  );
  // a: 09-11, b: 10-12 (overlaps a), c: 11:30-12:30 (overlaps b, not a),
  // d: 13-14 (overlaps nothing -> back to lane 0).
  const grid = buildTimeGrid({ anchor: day, days: 1, meetings: [mk("a", 9, 0, 11, 0), mk("b", 10, 0, 12, 0), mk("c", 11, 30, 12, 30), mk("d", 13, 0, 14, 0)] });

  assert.equal(grid.days.length, 1);
  const [only] = grid.days;
  const laneOf = (id) => only.segments.find((s) => s.id === id).lane;
  assert.equal(laneOf("a"), 0);
  assert.equal(laneOf("b"), 1, "b overlaps a so it cannot share a lane");
  assert.equal(laneOf("c"), 0, "c is clear of a, so it reuses lane 0");
  assert.equal(laneOf("d"), 0);
  assert.equal(only.laneCount, 2, "the day needs exactly two columns");
});

test("week grid spans seven days from the week start and places each meeting", () => {
  const wednesday = new Date(2026, 6, 22, 15, 0, 0);
  const grid = buildTimeGrid({
    anchor: wednesday,
    days: 7,
    meetings: [meeting("mon", new Date(2026, 6, 20, 9, 0).toISOString(), new Date(2026, 6, 20, 10, 0).toISOString())],
  });

  assert.equal(grid.days.length, 7);
  assert.equal(grid.days[0].date.getDay(), 0, "the week starts on Sunday by default");
  const withMeeting = grid.days.filter((day) => day.segments.length > 0);
  assert.equal(withMeeting.length, 1);
  assert.equal(withMeeting[0].segments[0].id, "mon");
  assert.equal(withMeeting[0].date.getDate(), 20);
});

test("month grid is a whole number of weeks, marks today and adjacent-month days", () => {
  const anchor = new Date(2026, 6, 15);
  const today = new Date(2026, 6, 25);
  const grid = buildMonthGrid({
    anchor,
    today,
    meetings: [meeting("mid", new Date(2026, 6, 25, 9, 0).toISOString(), new Date(2026, 6, 25, 11, 0).toISOString())],
  });

  assert.equal(grid.weeks.length % 1, 0);
  for (const week of grid.weeks) assert.equal(week.length, 7, "every row is a full week");

  const cells = grid.weeks.flat();
  assert.equal(cells[0].date.getDay(), 0);

  const todayCells = cells.filter((cell) => cell.isToday);
  assert.equal(todayCells.length, 1, "exactly one cell is today");
  assert.equal(todayCells[0].date.getDate(), 25);
  assert.equal(todayCells[0].meetings.length, 1);
  assert.equal(todayCells[0].meetings[0].id, "mid");

  // Leading/trailing cells belong to the neighbouring months and must be marked
  // so they can be de-emphasised rather than looking like July.
  assert.ok(cells.some((cell) => !cell.isCurrentMonth), "grid is padded with adjacent-month days");
  assert.ok(cells.every((cell) => cell.isCurrentMonth || cell.date.getMonth() !== 6));
});

test("a midnight-spanning meeting is listed on both month cells", () => {
  const grid = buildMonthGrid({
    anchor: new Date(2026, 6, 15),
    today: new Date(2026, 6, 15),
    meetings: [meeting("night", new Date(2026, 6, 25, 23, 30).toISOString(), new Date(2026, 6, 26, 0, 45).toISOString())],
  });
  const cells = grid.weeks.flat().filter((cell) => cell.meetings.some((entry) => entry.id === "night"));
  assert.deepEqual(cells.map((cell) => cell.date.getDate()), [25, 26]);
});

test("meetings with an unparseable interval are dropped rather than thrown", () => {
  assert.deepEqual(splitByDay(meeting("bad", "not-a-date", "also-not")), []);
  const grid = buildTimeGrid({ anchor: new Date(2026, 6, 25), days: 1, meetings: [meeting("bad", "", "")] });
  assert.equal(grid.days[0].segments.length, 0);
});

test("segments carry the fields the UI needs to render without re-deriving them", () => {
  const [segment] = splitByDay(meeting(
    "m",
    new Date(2026, 6, 25, 9, 0).toISOString(),
    new Date(2026, 6, 25, 10, 0).toISOString(),
    { title: "Board Review", kind: "live-call", isUnterminated: true },
  ));
  assert.equal(segment.title, "Board Review");
  assert.equal(segment.kind, "live-call");
  assert.equal(segment.isUnterminated, true, "the UI shows unterminated meetings differently");
});

test("width is decided per overlap cluster, not per day", () => {
  const mk = (id, sh, sm, eh, em) => meeting(
    id,
    new Date(2026, 6, 25, sh, sm).toISOString(),
    new Date(2026, 6, 25, eh, em).toISOString(),
  );
  // early stands alone; a and b overlap each other.
  const grid = buildTimeGrid({
    anchor: new Date(2026, 6, 25),
    days: 1,
    meetings: [mk("early", 0, 0, 0, 45), mk("a", 9, 0, 11, 30), mk("b", 10, 30, 12, 0)],
  });
  const find = (id) => grid.days[0].segments.find((s) => s.id === id);

  // A lone meeting must fill the column; sharing the day with an overlapping
  // pair elsewhere is not a reason to render it at half width.
  assert.equal(find("early").clusterLaneCount, 1);
  assert.equal(find("a").clusterLaneCount, 2);
  assert.equal(find("b").clusterLaneCount, 2);
  assert.equal(find("b").lane, 1);
  assert.equal(grid.days[0].laneCount, 2, "the day still reports its widest cluster");
});
