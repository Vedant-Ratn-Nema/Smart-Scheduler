import {
  addDays,
  addMinutes,
  endOfDay,
  format,
  formatISO,
  isAfter,
  isBefore,
  parseISO,
  setHours,
  setMilliseconds,
  setMinutes,
  setSeconds,
  startOfDay,
} from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

function getDayPartRange(dayPart) {
  switch (dayPart) {
    case "morning":
      return { startHour: 8, endHour: 12 };
    case "afternoon":
      return { startHour: 12, endHour: 17 };
    case "evening":
      return { startHour: 17, endHour: 22 };
    default:
      return { startHour: 8, endHour: 18 };
  }
}

/** Start of calendar day in `timeZone`, as a UTC instant. */
export function zonedStartOfDay(instant, timeZone) {
  const tz = timeZone || "UTC";
  const z = toZonedTime(instant, tz);
  return fromZonedTime(startOfDay(z), tz);
}

function zonedWallTimeOnDay(dayMidnightUtc, timeZone, hour, minute) {
  const tz = timeZone || "UTC";
  const z = toZonedTime(dayMidnightUtc, tz);
  const d0 = startOfDay(z);
  let t = setHours(d0, hour);
  t = setMinutes(t, minute);
  t = setSeconds(t, 0);
  t = setMilliseconds(t, 0);
  return fromZonedTime(t, tz);
}

export function addZonedCalendarDays(dayMidnightUtc, days, timeZone) {
  const tz = timeZone || "UTC";
  const z = toZonedTime(dayMidnightUtc, tz);
  const nextLocal = addDays(startOfDay(z), days);
  return fromZonedTime(nextLocal, tz);
}

/** Last millisecond of the calendar day containing `instant` in `timeZone`. */
export function zonedEndOfCalendarDay(instant, timeZone) {
  const tz = timeZone || "UTC";
  const next = addZonedCalendarDays(zonedStartOfDay(instant, tz), 1, tz);
  return new Date(next.getTime() - 1);
}

function ceilToTimeStep(instant, stepMinutes) {
  const ms = stepMinutes * 60 * 1000;
  return new Date(Math.ceil(instant.getTime() / ms) * ms);
}

export function formatSlotLabel(date, timeZone) {
  const tz = timeZone || "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    }).format(date);
  } catch {
    return format(date, "EEEE, MMMM d, h:mm a");
  }
}

function overlaps(candidateStart, candidateEnd, busyIntervals) {
  return busyIntervals.some((busy) => {
    const busyStart = parseISO(busy.start);
    const busyEnd = parseISO(busy.end);
    return isBefore(candidateStart, busyEnd) && isAfter(candidateEnd, busyStart);
  });
}

function getLastMeetingEndOnDay(dayMidnightUtc, busyIntervals, timeZone) {
  const tz = timeZone || "UTC";
  const z = toZonedTime(dayMidnightUtc, tz);
  const dayStart = startOfDay(z);
  const dayEnd = endOfDay(z);
  const dayBusy = busyIntervals
    .map((busy) => ({ start: parseISO(busy.start), end: parseISO(busy.end) }))
    .filter(
      (busy) =>
        isAfter(busy.start, dayStart) &&
        isBefore(busy.start, dayEnd) &&
        isAfter(busy.end, dayStart) &&
        isBefore(busy.end, dayEnd),
    );

  if (!dayBusy.length) return null;
  return dayBusy.reduce(
    (latest, interval) => (isAfter(interval.end, latest) ? interval.end : latest),
    dayBusy[0].end,
  );
}

/**
 * @param {object} params
 * @param {Date} [params.now] - "Current" instant (defaults to real time). All slots start strictly at or after max(now, window).
 */
export function findAvailableSlots({
  constraints,
  busyIntervals,
  timezone,
  maxSlots = 5,
  stepMinutes = 15,
  now = new Date(),
}) {
  const tz = timezone || "UTC";
  const durationMinutes = constraints.durationMinutes || 30;
  const range = getDayPartRange(constraints.dayPart || "any");
  const preferredDays = constraints.preferredDays || [];
  const avoidDays = constraints.avoidDays || [];
  const notBeforeHour = constraints.notBeforeHour ?? range.startHour;
  const hardEndHour = constraints.notAfterHour ?? range.endHour;
  const preferredStartHour = Number.isInteger(constraints.preferredStartHour)
    ? constraints.preferredStartHour
    : null;
  const preferredStartMinute = Number.isInteger(constraints.preferredStartMinute)
    ? constraints.preferredStartMinute
    : 0;

  let windowStart = constraints.windowStartISO
    ? parseISO(constraints.windowStartISO)
    : zonedStartOfDay(now, tz);
  let windowEnd = constraints.windowEndISO
    ? parseISO(constraints.windowEndISO)
    : addZonedCalendarDays(zonedStartOfDay(now, tz), 14, tz);

  if (!isBefore(windowStart, windowEnd)) {
    return [];
  }

  /** No slot may start before this instant (current time in the real world). */
  const nowInstant = now;
  /** Search / booking window left edge in absolute time. */
  const leftEdge = new Date(Math.max(windowStart.getTime(), nowInstant.getTime()));

  if (!isBefore(leftEdge, windowEnd)) {
    return [];
  }

  let dayMidnightUtc = zonedStartOfDay(leftEdge, tz);

  const slots = [];

  while (isBefore(dayMidnightUtc, windowEnd) && slots.length < maxSlots) {
    const z = toZonedTime(dayMidnightUtc, tz);
    const dayIndex = z.getDay();

    if (avoidDays.includes(dayIndex)) {
      dayMidnightUtc = addZonedCalendarDays(dayMidnightUtc, 1, tz);
      continue;
    }
    if (preferredDays.length && !preferredDays.includes(dayIndex)) {
      dayMidnightUtc = addZonedCalendarDays(dayMidnightUtc, 1, tz);
      continue;
    }

    let firstStartUtc;
    if (preferredStartHour !== null) {
      firstStartUtc = zonedWallTimeOnDay(
        dayMidnightUtc,
        tz,
        Math.max(notBeforeHour, preferredStartHour),
        preferredStartHour >= notBeforeHour ? preferredStartMinute : 0,
      );
    } else {
      firstStartUtc = zonedWallTimeOnDay(dayMidnightUtc, tz, notBeforeHour, 0);
    }

    const dayEndWallUtc = zonedWallTimeOnDay(dayMidnightUtc, tz, hardEndHour, 0);

    const lastMeetingEnd = constraints.afterLastMeetingBufferMinutes
      ? getLastMeetingEndOnDay(dayMidnightUtc, busyIntervals, tz)
      : null;
    const minStartWithBuffer = lastMeetingEnd
      ? addMinutes(lastMeetingEnd, constraints.afterLastMeetingBufferMinutes)
      : null;

    let candidateStart = new Date(Math.max(firstStartUtc.getTime(), leftEdge.getTime()));
    candidateStart = ceilToTimeStep(candidateStart, stepMinutes);

    if (minStartWithBuffer && isBefore(candidateStart, minStartWithBuffer)) {
      candidateStart = ceilToTimeStep(minStartWithBuffer, stepMinutes);
    }

    while (isBefore(candidateStart, dayEndWallUtc) && slots.length < maxSlots) {
      const candidateEnd = addMinutes(candidateStart, durationMinutes);
      if (isAfter(candidateEnd, dayEndWallUtc)) {
        break;
      }
      if (isBefore(candidateStart, windowStart) || isAfter(candidateEnd, windowEnd)) {
        candidateStart = addMinutes(candidateStart, stepMinutes);
        continue;
      }
      if (isBefore(candidateStart, nowInstant)) {
        candidateStart = addMinutes(candidateStart, stepMinutes);
        continue;
      }
      if (!overlaps(candidateStart, candidateEnd, busyIntervals)) {
        slots.push({
          startISO: formatISO(candidateStart),
          endISO: formatISO(candidateEnd),
          label: formatSlotLabel(candidateStart, tz),
          timezone: tz,
        });
      }

      candidateStart = addMinutes(candidateStart, stepMinutes);
    }

    dayMidnightUtc = addZonedCalendarDays(dayMidnightUtc, 1, tz);
  }

  return slots;
}
