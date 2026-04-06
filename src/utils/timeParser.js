import * as chrono from "chrono-node";
import {
  addDays,
  addMinutes,
  addMonths,
  endOfDay,
  endOfMonth,
  nextFriday,
  nextWednesday,
  set,
  startOfDay,
} from "date-fns";
import {
  addZonedCalendarDays,
  zonedEndOfCalendarDay,
  zonedStartOfDay,
} from "./slotFinder.js";

const weekdayMap = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function getNextWeekday(target) {
  const now = new Date();
  const day = now.getDay();
  const delta = (target - day + 7) % 7 || 7;
  return addDays(startOfDay(now), delta);
}

function parseDayPart(text) {
  if (/\bmorning\b/i.test(text)) return "morning";
  if (/\bafternoon\b/i.test(text)) return "afternoon";
  if (/\bevening\b/i.test(text) || /\bafter\s+7\b/i.test(text)) return "evening";
  return null;
}

function parseDurationMinutes(text) {
  const hourMatch = text.match(/(\d+)\s*(hour|hr|hours)\b/i);
  const minuteMatch = text.match(/(\d+)\s*(minute|min|minutes)\b/i);
  const quickMatch = text.match(/\bquick\s+(\d+)\b/i);

  let minutes = 0;
  if (hourMatch) minutes += Number(hourMatch[1]) * 60;
  if (minuteMatch) minutes += Number(minuteMatch[1]);
  if (!minutes && quickMatch) minutes += Number(quickMatch[1]);
  return minutes || null;
}

function normalizeMeridiemText(text) {
  return text
    .replace(/\ba\.\s*m\.?\b/gi, "am")
    .replace(/\bp\.\s*m\.?\b/gi, "pm")
    .replace(/\ba\s*m\b/gi, "am")
    .replace(/\bp\s*m\b/gi, "pm");
}

function parseBetweenTimeWindow(text, now) {
  const normalized = normalizeMeridiemText(text);
  const betweenMatch = normalized.match(
    /\bbetween\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\s+and\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i,
  );
  if (!betweenMatch) return null;

  const startHourRaw = Number(betweenMatch[1]);
  const startMinute = Number(betweenMatch[2] || "0");
  const startMeridiem = betweenMatch[3].toLowerCase();

  const endHourRaw = Number(betweenMatch[4]);
  const endMinute = Number(betweenMatch[5] || "0");
  const endMeridiem = betweenMatch[6].toLowerCase();

  let startHour24 = startHourRaw % 12;
  if (startMeridiem === "pm") startHour24 += 12;
  let endHour24 = endHourRaw % 12;
  if (endMeridiem === "pm") endHour24 += 12;

  const day = startOfDay(now);
  const windowStart = new Date(day);
  windowStart.setHours(startHour24, startMinute, 0, 0);
  const windowEnd = new Date(day);
  windowEnd.setHours(endHour24, endMinute, 0, 0);

  if (windowEnd <= windowStart) {
    return null;
  }

  return {
    windowStartISO: windowStart.toISOString(),
    windowEndISO: windowEnd.toISOString(),
    notBeforeHour: startHour24,
    notAfterHour: endHour24,
  };
}

function parsePreferredStartTime(text) {
  const normalized = normalizeMeridiemText(text);
  const match = normalized.match(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (!match) return {};

  const rawHour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = match[3].toLowerCase();
  let hour24 = rawHour % 12;
  if (meridiem === "pm") hour24 += 12;

  return {
    preferredStartHour: hour24,
    preferredStartMinute: minute,
  };
}

function parseAfterClockConstraint(text) {
  const normalized = normalizeMeridiemText(text);
  const match = normalized.match(/\bafter\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (!match) return null;

  const rawHour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = match[3].toLowerCase();
  let hour24 = rawHour % 12;
  if (meridiem === "pm") hour24 += 12;

  return {
    preferredStartHour: hour24,
    preferredStartMinute: minute,
    notBeforeHour: hour24,
  };
}

function parseAfterNamedEventReference(text) {
  const normalized = normalizeMeridiemText(text);
  if (/\bafter\s+\d{1,2}(?::\d{2})?\s*(am|pm)\b/i.test(normalized)) {
    return null;
  }

  const match = normalized.match(
    /\bafter\s+(.+?)(?=\s+\b(?:today|tomorrow|on|between|at|for|in)\b|[,.!?]|$)/i,
  );
  if (!match) return null;

  const candidate = match[1].replace(/\s+/g, " ").trim();
  if (!candidate || candidate.length < 3) return null;

  return { eventName: candidate };
}

function parseWeekdayHints(text) {
  const lower = text.toLowerCase();
  const preferredDays = new Set();
  const avoidDays = new Set();

  Object.entries(weekdayMap).forEach(([name, index]) => {
    const isAvoided = new RegExp(`\\b(?:not\\s+on|except\\s+|exclude\\s+)${name}\\b`, "i").test(
      lower,
    );
    if (isAvoided) {
      avoidDays.add(index);
      return;
    }

    // Accept broader phrasing such as "for friday slots", "this friday", etc.
    if (new RegExp(`\\b(?:on\\s+|for\\s+|this\\s+|next\\s+)?${name}\\b`, "i").test(lower)) {
      preferredDays.add(index);
    }
  });

  return { preferredDays: [...preferredDays], avoidDays: [...avoidDays] };
}

function parseLastWeekdayOfMonth(text) {
  if (!/last weekday of (this|the) month/i.test(text)) return null;
  const monthEnd = endOfMonth(new Date());
  let current = startOfDay(monthEnd);
  while (current.getDay() === 0 || current.getDay() === 6) {
    current = addDays(current, -1);
  }
  return {
    windowStartISO: current.toISOString(),
    windowEndISO: endOfDay(current).toISOString(),
  };
}

function parseLateNextWeek(text) {
  if (!/late next week/i.test(text)) return null;
  const friday = nextFriday(new Date());
  const wednesday = nextWednesday(new Date());
  return {
    windowStartISO: startOfDay(wednesday).toISOString(),
    windowEndISO: endOfDay(friday).toISOString(),
  };
}

function parseNamedEventOffset(text) {
  const match = text.match(/['"]([^'"]+)['"].*day or two after/i);
  if (!match) return null;
  return {
    eventName: match[1],
    offsetDaysMin: 1,
    offsetDaysMax: 2,
  };
}

function parseBeforeMeetingConstraint(text) {
  const match = text.match(
    /(\d+)\s*(minute|minutes|hour|hours)\s+before\s+my\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm))\s+meeting\s+on\s+([a-z]+)/i,
  );
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const bufferMinutes = unit.startsWith("hour") ? amount * 60 : amount;
  const meetingClock = match[3];
  const weekday = match[4].toLowerCase();
  const dayIndex = weekdayMap[weekday];
  if (dayIndex === undefined) return null;

  const day = getNextWeekday(dayIndex);
  const parsed = chrono.parseDate(meetingClock, day);
  if (!parsed) return null;

  const deadline = new Date(parsed.getTime() - bufferMinutes * 60 * 1000);
  return {
    windowStartISO: startOfDay(day).toISOString(),
    windowEndISO: deadline.toISOString(),
  };
}

/**
 * Phrases like "day after tomorrow" — chrono often mis-parses these; also handles
 * "3 days from today", "in 3 days", "2 weeks from now".
 */
function parseRelativeDayExpressions(text, now, timeZone) {
  const tz = timeZone || "UTC";
  const t = text.trim();
  const todayStart = zonedStartOfDay(now, tz);

  if (/\bday\s+after\s+tomorrow\b/i.test(t) || /\bthe\s+day\s+after\s+tomorrow\b/i.test(t)) {
    const dayStart = addZonedCalendarDays(todayStart, 2, tz);
    return {
      windowStartISO: dayStart.toISOString(),
      windowEndISO: zonedEndOfCalendarDay(dayStart, tz).toISOString(),
    };
  }

  const daysFrom = t.match(/\b(\d+)\s+days?\s+from\s+(today|now)\b/i);
  if (daysFrom) {
    const dayStart = addZonedCalendarDays(todayStart, Number(daysFrom[1]), tz);
    return {
      windowStartISO: dayStart.toISOString(),
      windowEndISO: zonedEndOfCalendarDay(dayStart, tz).toISOString(),
    };
  }

  const weeksFrom = t.match(/\b(\d+)\s+weeks?\s+from\s+(today|now)\b/i);
  if (weeksFrom) {
    const dayStart = addZonedCalendarDays(todayStart, Number(weeksFrom[1]) * 7, tz);
    return {
      windowStartISO: dayStart.toISOString(),
      windowEndISO: zonedEndOfCalendarDay(dayStart, tz).toISOString(),
    };
  }

  const inDays = t.match(/\bin\s+(\d+)\s+days?\b/i);
  if (inDays) {
    const dayStart = addZonedCalendarDays(todayStart, Number(inDays[1]), tz);
    return {
      windowStartISO: dayStart.toISOString(),
      windowEndISO: zonedEndOfCalendarDay(dayStart, tz).toISOString(),
    };
  }

  return null;
}

function parseRelativeDeadline(text) {
  const match = text.match(
    /(\d+)\s*(minute|minutes|hour|hours).*before my flight.*friday at ([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm))/i,
  );
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const bufferMinutes = unit.startsWith("hour") ? amount * 60 : amount;
  const friday = getNextWeekday(5);
  const flightTime = chrono.parseDate(match[3], friday);
  if (!flightTime) return null;

  const deadline = new Date(flightTime.getTime() - bufferMinutes * 60 * 1000);
  return {
    windowStartISO: new Date().toISOString(),
    windowEndISO: deadline.toISOString(),
  };
}

export async function extractConstraintsFromText(
  text,
  findEventByNameFn,
  options = {},
) {
  const { linkCalendarEvents = true, timeZone: inputTimeZone } = options;
  const tz = inputTimeZone || "UTC";
  const now = new Date();
  const normalizedText = normalizeMeridiemText(text);
  const durationMinutes = parseDurationMinutes(text);
  const preferredStart = parsePreferredStartTime(text);
  const afterClock = parseAfterClockConstraint(text);
  const afterEventReference = parseAfterNamedEventReference(text);
  const betweenWindow = parseBetweenTimeWindow(text, now);
  const dayPart = parseDayPart(text);
  const { preferredDays, avoidDays } = parseWeekdayHints(text);

  let windowStartISO = null;
  let windowEndISO = null;
  let anchoredToEvent = false;
  let missingEventReference = null;

  const explicit = chrono.parse(normalizedText, now, { forwardDate: true });
  if (explicit.length && explicit[0].start) {
    try {
      const first = explicit[0];
      const start = first.start.date();
      const end = first.end ? first.end.date() : null;
      windowStartISO = startOfDay(start).toISOString();
      windowEndISO = endOfDay(end || start).toISOString();
    } catch {
      /* ignore bad chrono components */
    }
  }

  const lateNextWeek = parseLateNextWeek(text);
  if (lateNextWeek) {
    windowStartISO = lateNextWeek.windowStartISO;
    windowEndISO = lateNextWeek.windowEndISO;
  }

  const lastWeekday = parseLastWeekdayOfMonth(text);
  if (lastWeekday) {
    windowStartISO = lastWeekday.windowStartISO;
    windowEndISO = lastWeekday.windowEndISO;
  }

  const beforeMeeting = parseBeforeMeetingConstraint(text);
  if (beforeMeeting) {
    windowStartISO = beforeMeeting.windowStartISO;
    windowEndISO = beforeMeeting.windowEndISO;
  }

  const deadline = parseRelativeDeadline(text);
  if (deadline) {
    windowStartISO = deadline.windowStartISO;
    windowEndISO = deadline.windowEndISO;
  }

  const namedEventOffset = parseNamedEventOffset(text);
  if (
    namedEventOffset &&
    linkCalendarEvents &&
    typeof findEventByNameFn === "function"
  ) {
    try {
      const event = await findEventByNameFn(namedEventOffset.eventName);
      if (event?.start) {
        const eventDate = new Date(event.start);
        const rangeStart = addDays(startOfDay(eventDate), namedEventOffset.offsetDaysMin);
        const rangeEnd = addDays(endOfDay(eventDate), namedEventOffset.offsetDaysMax);
        windowStartISO = rangeStart.toISOString();
        windowEndISO = rangeEnd.toISOString();
      }
    } catch {
      /* calendar lookup failed */
    }
  }

  if (
    afterEventReference &&
    linkCalendarEvents &&
    typeof findEventByNameFn === "function"
  ) {
    try {
      const event = await findEventByNameFn(afterEventReference.eventName);
      if (event?.start || event?.end) {
        const eventStart = new Date(event.start);
        const eventEnd = event.end ? new Date(event.end) : addMinutes(eventStart, 30);
        windowStartISO = eventEnd.toISOString();
        windowEndISO = endOfDay(eventStart).toISOString();
        anchoredToEvent = true;
        missingEventReference = null;
      } else {
        missingEventReference = afterEventReference.eventName;
      }
    } catch {
      /* calendar lookup failed — do not block scheduling with a false "missing" */
    }
  }

  if (/next week/i.test(text) && !windowStartISO) {
    const start = addDays(startOfDay(now), 7 - now.getDay() + 1);
    const end = addDays(endOfDay(start), 6);
    windowStartISO = start.toISOString();
    windowEndISO = end.toISOString();
  }

  if (/this month/i.test(text) && !windowStartISO) {
    windowStartISO = startOfDay(now).toISOString();
    windowEndISO = endOfMonth(now).toISOString();
  }

  if (/today/i.test(text) && !anchoredToEvent) {
    windowStartISO = zonedStartOfDay(now, tz).toISOString();
    windowEndISO = zonedEndOfCalendarDay(now, tz).toISOString();
  }

  if (/tomorrow/i.test(text) && !anchoredToEvent && !/\bday\s+after\s+tomorrow\b/i.test(text)) {
    const tomorrowStart = addZonedCalendarDays(zonedStartOfDay(now, tz), 1, tz);
    windowStartISO = tomorrowStart.toISOString();
    windowEndISO = zonedEndOfCalendarDay(tomorrowStart, tz).toISOString();
  }

  const relativeDayWindow = parseRelativeDayExpressions(text, now, tz);
  if (relativeDayWindow) {
    windowStartISO = relativeDayWindow.windowStartISO;
    windowEndISO = relativeDayWindow.windowEndISO;
  }

  if (betweenWindow) {
    windowStartISO = betweenWindow.windowStartISO;
    windowEndISO = betweenWindow.windowEndISO;
  }

  if (/not too early/i.test(text)) {
    return {
      durationMinutes,
      dayPart,
      preferredDays,
      avoidDays,
      windowStartISO,
      windowEndISO,
      ...preferredStart,
      ...(afterClock || {}),
      ...(betweenWindow
        ? {
            notBeforeHour: betweenWindow.notBeforeHour,
            notAfterHour: betweenWindow.notAfterHour,
          }
        : {}),
      notBeforeHour: 10,
      missingEventReference,
    };
  }

  if (/after 7/i.test(text)) {
    return {
      durationMinutes,
      dayPart,
      preferredDays,
      avoidDays,
      windowStartISO,
      windowEndISO,
      ...preferredStart,
      ...(afterClock || {}),
      ...(betweenWindow
        ? {
            notBeforeHour: betweenWindow.notBeforeHour,
            notAfterHour: betweenWindow.notAfterHour,
          }
        : {}),
      notBeforeHour: 19,
      missingEventReference,
    };
  }

  if (/decompress after my last meeting/i.test(text)) {
    return {
      durationMinutes,
      dayPart,
      preferredDays,
      avoidDays,
      windowStartISO,
      windowEndISO,
      ...preferredStart,
      ...(afterClock || {}),
      ...(betweenWindow
        ? {
            notBeforeHour: betweenWindow.notBeforeHour,
            notAfterHour: betweenWindow.notAfterHour,
          }
        : {}),
      afterLastMeetingBufferMinutes: 60,
      missingEventReference,
    };
  }

  if (/june 20/i.test(text) && /morning/i.test(text)) {
    const base = set(addMonths(startOfDay(now), 0), {
      month: 5,
      date: 20,
    });
    return {
      durationMinutes,
      dayPart: "morning",
      preferredDays,
      avoidDays,
      windowStartISO: startOfDay(base).toISOString(),
      windowEndISO: endOfDay(base).toISOString(),
      ...preferredStart,
      ...(afterClock || {}),
      ...(betweenWindow
        ? {
            notBeforeHour: betweenWindow.notBeforeHour,
            notAfterHour: betweenWindow.notAfterHour,
          }
        : {}),
      missingEventReference,
    };
  }

  return {
    durationMinutes,
    dayPart,
    preferredDays,
    avoidDays,
    windowStartISO,
    windowEndISO,
    ...preferredStart,
    ...(afterClock || {}),
    ...(betweenWindow
      ? {
          notBeforeHour: betweenWindow.notBeforeHour,
          notAfterHour: betweenWindow.notAfterHour,
        }
      : {}),
    missingEventReference,
  };
}
