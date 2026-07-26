const DEFAULT_LEAD_MINUTES = 10;
const ROUNDING_MINUTES = 5;

export const PAST_LIVE_SCHEDULE_ERROR = "Choose a start time later than the current local time.";
export const INVALID_LIVE_SCHEDULE_ERROR = "Enter a valid date and start time.";

export interface LiveScheduleFields {
  sessionDate: string;
  startTime: string;
}

export interface LiveScheduleValidation {
  scheduledAt: string;
  error: string;
}

function padTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function getDefaultLiveSchedule(now: Date): LiveScheduleFields {
  const rounded = new Date(now.getTime() + DEFAULT_LEAD_MINUTES * 60_000);
  rounded.setSeconds(0, 0);
  rounded.setMinutes(Math.ceil(rounded.getMinutes() / ROUNDING_MINUTES) * ROUNDING_MINUTES);

  return {
    sessionDate: `${rounded.getFullYear()}-${padTwoDigits(rounded.getMonth() + 1)}-${padTwoDigits(rounded.getDate())}`,
    startTime: `${padTwoDigits(rounded.getHours())}:${padTwoDigits(rounded.getMinutes())}`,
  };
}

export function validateLiveSchedule(
  sessionDate: string,
  startTime: string,
  nowMilliseconds: number,
): LiveScheduleValidation {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(sessionDate);
  const timeMatch = /^(\d{2}):(\d{2})$/u.exec(startTime);
  if (!dateMatch || !timeMatch) return { scheduledAt: "", error: INVALID_LIVE_SCHEDULE_ERROR };

  const year = Number(dateMatch[1]);
  const monthIndex = Number(dateMatch[2]) - 1;
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const scheduled = new Date(year, monthIndex, day, hour, minute, 0, 0);
  const hasExactLocalComponents = scheduled.getFullYear() === year
    && scheduled.getMonth() === monthIndex
    && scheduled.getDate() === day
    && scheduled.getHours() === hour
    && scheduled.getMinutes() === minute;

  if (!hasExactLocalComponents) return { scheduledAt: "", error: INVALID_LIVE_SCHEDULE_ERROR };
  if (scheduled.getTime() <= nowMilliseconds) return { scheduledAt: "", error: PAST_LIVE_SCHEDULE_ERROR };
  return { scheduledAt: scheduled.toISOString(), error: "" };
}
