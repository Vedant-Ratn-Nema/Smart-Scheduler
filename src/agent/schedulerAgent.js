import OpenAI from "openai";
import * as chrono from "chrono-node";
import {
  addDays,
  addMinutes,
  endOfDay,
  parseISO,
  setHours,
  setMilliseconds,
  setMinutes,
  setSeconds,
  startOfDay,
  subMinutes,
} from "date-fns";
import { config, hasOpenAi } from "../config.js";
import {
  cancelCalendarEvent,
  createCalendarEvent,
  eventTitleMatchesQuery,
  findEventByName,
  getBusyIntervals,
  listEvents,
  listUpcomingEventsWithGuest,
  updateCalendarEventAttendees,
  updateCalendarEventTime,
  updateCalendarEventTitle,
} from "../services/calendarService.js";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { findAvailableSlots, formatSlotLabel, zonedStartOfDay } from "../utils/slotFinder.js";
import { extractConstraintsFromText } from "../utils/timeParser.js";

const client = hasOpenAi ? new OpenAI({ apiKey: config.openAiApiKey }) : null;

const sessions = new Map();

function createDefaultSession() {
  return {
    constraints: {
      durationMinutes: null,
      dayPart: null,
      preferredDays: [],
      avoidDays: [],
      windowStartISO: null,
      windowEndISO: null,
    },
    lastSuggestedSlots: [],
    title: null,
    attendeeEmails: [config.hostEmail],
    lastBookedEventId: null,
    onboardingStep: "email",
    activeTimezone: null,
    clarifyCount: 0,
    /** When set, next message should supply a new time for this event id. */
    pendingRescheduleEventId: null,
    /** Numbered options from listGuestMeetingsForState; user replies with 1, 2, … */
    reschedulePickList: null,
  };
}

function mergeClientSessionSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  let parsed;
  try {
    parsed = JSON.parse(JSON.stringify(raw));
  } catch {
    return null;
  }
  const base = createDefaultSession();
  if (parsed.constraints && typeof parsed.constraints === "object") {
    base.constraints = { ...base.constraints, ...parsed.constraints };
  }
  if (Array.isArray(parsed.lastSuggestedSlots)) {
    base.lastSuggestedSlots = parsed.lastSuggestedSlots;
  }
  if (typeof parsed.title === "string" || parsed.title === null) {
    base.title = parsed.title;
  }
  if (Array.isArray(parsed.attendeeEmails)) {
    const emails = parsed.attendeeEmails.filter((e) => typeof e === "string" && e.includes("@"));
    if (emails.length) base.attendeeEmails = emails;
  }
  if (typeof parsed.lastBookedEventId === "string" || parsed.lastBookedEventId === null) {
    base.lastBookedEventId = parsed.lastBookedEventId;
  }
  if (parsed.onboardingStep === "email" || parsed.onboardingStep === "title" || parsed.onboardingStep === "done") {
    base.onboardingStep = parsed.onboardingStep;
  }
  if (typeof parsed.activeTimezone === "string" || parsed.activeTimezone === null) {
    base.activeTimezone = parsed.activeTimezone;
  }
  if (typeof parsed.clarifyCount === "number" && Number.isFinite(parsed.clarifyCount)) {
    base.clarifyCount = Math.min(100, Math.max(0, parsed.clarifyCount));
  }
  if (typeof parsed.pendingRescheduleEventId === "string" || parsed.pendingRescheduleEventId === null) {
    base.pendingRescheduleEventId = parsed.pendingRescheduleEventId;
  }
  if (Array.isArray(parsed.reschedulePickList)) {
    base.reschedulePickList = parsed.reschedulePickList.filter(
      (row) => row && typeof row.id === "string" && typeof row.summary === "string",
    );
  }
  return base;
}

function getSession(sessionId, clientSnapshot) {
  if (!sessions.has(sessionId)) {
    const restored = mergeClientSessionSnapshot(clientSnapshot);
    sessions.set(sessionId, restored || createDefaultSession());
  }
  return sessions.get(sessionId);
}

function mergeConstraints(existing, patch) {
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => {
        if (value === null || value === undefined) return false;
        if (Array.isArray(value) && value.length === 0) return false;
        return true;
      }),
    ),
    preferredDays: patch.preferredDays?.length ? patch.preferredDays : existing.preferredDays,
    avoidDays: patch.avoidDays?.length ? patch.avoidDays : existing.avoidDays,
  };
}

async function generateClarifyingQuestion(state, userText) {
  state.clarifyCount = (state.clarifyCount || 0) + 1;
  const hasDayHint = Boolean(
    state.constraints.windowStartISO ||
      state.constraints.dayPart ||
      (state.constraints.preferredDays?.length ?? 0) > 0,
  );

  if (!hasOpenAi) {
    const i = state.clarifyCount % 3;
    if (!state.constraints.durationMinutes) {
      const qs = [
        "Roughly how long should we block — 15, 30, 45 minutes?",
        "How much time do you need on the calendar?",
        "What length works best for you?",
      ];
      return qs[i];
    }
    const wqs = [
      "Any day or part of the week you’re aiming for?",
      "When would you like to meet — a specific day, or something like Tuesday afternoon?",
      "What does your week look like — is there a day that works better?",
    ];
    return wqs[i];
  }

  const systemPrompt = `
You are a warm, capable human assistant. The person chatting is a visitor booking time with ${config.hostName} (the calendar owner — not the visitor).
Ask exactly one short follow-up question for what's still missing (duration, day, or time window).
Vary your wording from typical chatbot lines — sound like a helpful, real person.
Keep it to one or two sentences. No bullet lists.
`;

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.55,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          userText,
          constraints: state.constraints,
          missing: {
            durationMissing: !state.constraints.durationMinutes,
            windowMissing: !hasDayHint,
          },
        }),
      },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() || "What time should we target?";
}

function toHour24From12(hour12, minute, meridiem) {
  let hour24 = hour12 % 12;
  if (meridiem === "pm") hour24 += 12;
  return hour24;
}

/** Speech often yields "345 pm" instead of "3:45 pm" — parse compact & spaced forms. */
function parseSpokenTimeToHour24Minute(normalizedMeridiem) {
  const spaced = normalizedMeridiem.match(/\b(\d{1,2})\s+(\d{2})\s*(am|pm)\b/i);
  if (spaced) {
    const hour12 = Number(spaced[1]);
    const minute = Number(spaced[2]);
    if (minute < 60 && hour12 >= 1 && hour12 <= 12) {
      return {
        hour24: toHour24From12(hour12, minute, spaced[3].toLowerCase()),
        minute,
      };
    }
  }

  const compact = normalizedMeridiem.match(/\b(\d{3,4})\s*(am|pm)\b/i);
  if (compact) {
    const digits = compact[1];
    const meridiem = compact[2].toLowerCase();
    let hour12;
    let minute;
    if (digits.length === 4) {
      hour12 = parseInt(digits.slice(0, 2), 10);
      minute = parseInt(digits.slice(2, 4), 10);
    } else {
      hour12 = parseInt(digits[0], 10);
      minute = parseInt(digits.slice(1), 10);
    }
    if (minute >= 60 || hour12 < 1 || hour12 > 12) return null;
    return {
      hour24: toHour24From12(hour12, minute, meridiem),
      minute,
    };
  }

  return null;
}

function zonedHourMinute(iso, timeZone) {
  const d = parseISO(iso);
  return {
    h: Number(formatInTimeZone(d, timeZone, "H")),
    m: Number(formatInTimeZone(d, timeZone, "m")),
  };
}

function matchSlotFromUserText(userText, slots, timeZone) {
  const tz = timeZone || "UTC";
  if (!slots.length) return null;
  const lower = userText.toLowerCase();
  const normalizedMeridiem = lower
    .replace(/\ba\.\s*m\.?\b/gi, "am")
    .replace(/\bp\.\s*m\.?\b/gi, "pm")
    .replace(/\ba\s*m\b/gi, "am")
    .replace(/\bp\s*m\b/gi, "pm");
  const normalized = lower.replace(/\s+/g, " ").trim();
  const direct = slots.find((slot) => normalizedMeridiem.includes(slot.label.toLowerCase()));
  if (direct) return direct;

  // Match shorter natural references like "book 12.30 pm" and speech "345 pm" (no colon)
  const byLooseLabel = slots.find((slot) => {
    const slotDate = parseISO(slot.startISO);
    const variants = [
      formatInTimeZone(slotDate, tz, "h:mm a"),
      formatInTimeZone(slotDate, tz, "h.mm a"),
      formatInTimeZone(slotDate, tz, "h:mma"),
      formatInTimeZone(slotDate, tz, "hmm a"),
      formatInTimeZone(slotDate, tz, "h mm a"),
      formatInTimeZone(slotDate, tz, "h a"),
      formatInTimeZone(slotDate, tz, "ha"),
    ].map((value) => value.toLowerCase());
    return variants.some((variant) => normalized.includes(variant));
  });
  if (byLooseLabel) return byLooseLabel;

  if (/first|1st|earlier|earliest/i.test(userText)) return slots[0];
  if (/second|2nd/i.test(userText) && slots[1]) return slots[1];
  if (/third|3rd/i.test(userText) && slots[2]) return slots[2];
  if (/last/i.test(userText)) return slots[slots.length - 1];

  const spoken = parseSpokenTimeToHour24Minute(normalizedMeridiem);
  if (spoken) {
    const candidates = slots.filter((slot) => {
      const { h, m } = zonedHourMinute(slot.startISO, tz);
      return h === spoken.hour24 && m === spoken.minute;
    });
    if (candidates.length >= 1) return candidates[0];
  }

  const timeMatch = normalizedMeridiem.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (timeMatch) {
    const rawHour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || "0");
    const meridiem = timeMatch[3].toLowerCase();
    const hour24 = toHour24From12(rawHour, minute, meridiem);

    const candidates = slots.filter((slot) => {
      const { h, m } = zonedHourMinute(slot.startISO, tz);
      return h === hour24 && m === minute;
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return candidates[0];
  }

  const parsed = new Date(userText);
  if (!Number.isNaN(parsed.getTime())) {
    return slots.find((slot) => {
      const { h, m } = zonedHourMinute(slot.startISO, tz);
      return h === parsed.getHours() && m === parsed.getMinutes();
    });
  }
  return null;
}

function hasEnoughInfo(constraints) {
  return Boolean(constraints.durationMinutes && (constraints.windowStartISO || constraints.dayPart || constraints.preferredDays.length));
}

function buildFallbackAlternatives(constraints) {
  const updated = { ...constraints };
  if (updated.dayPart === "afternoon") updated.dayPart = "morning";
  else if (updated.dayPart === "morning") updated.dayPart = "afternoon";
  else updated.dayPart = "any";

  if (updated.windowStartISO && updated.windowEndISO) {
    const start = parseISO(updated.windowStartISO);
    const end = parseISO(updated.windowEndISO);
    updated.windowStartISO = addMinutes(start, 24 * 60).toISOString();
    updated.windowEndISO = addMinutes(end, 24 * 60).toISOString();
  }

  return updated;
}

function slotListToText(slots) {
  return slots.map((slot, index) => `${index + 1}. ${slot.label}`).join("\n");
}

function slotListToSpeechFriendlyText(slots, timeZone) {
  if (!slots.length) return "";
  const labels = slots.map((slot) =>
    formatSlotLabel(parseISO(slot.startISO), timeZone),
  );
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels[0]}, ${labels[1]}, or ${labels[2]}`;
}

function extractTitleInstruction(userText) {
  const trimmed = userText.trim();
  const titleIs = trimmed.match(
    /^\s*(?:meeting\s+)?title\s+is\s+(.+?)\s*$/ims,
  );
  if (titleIs) {
    return titleIs[1].trim().replace(/[.!?]+$/g, "");
  }
  const meetingTitle = trimmed.match(/meeting\s+title\s*:?\s*(.+)/i);
  if (meetingTitle) {
    return meetingTitle[1].trim().replace(/[.!?]+$/g, "");
  }
  const appointmentWithMatch = userText.match(/appointment with\s+(.+)/i);
  if (appointmentWithMatch) {
    const rawName = appointmentWithMatch[1]
      .split(/\b(?:at|on|today|tomorrow|between|for)\b/i)[0]
      .replace(/[,.!?]+$/g, "")
      .trim();
    if (rawName) {
      return `Appointment with ${rawName}`;
    }
  }
  const callItMatch = userText.match(/\b(?:call it|name it)\s+["']?([^"'\n]+)/i);
  if (callItMatch) {
    return callItMatch[1].trim();
  }
  const inlineTitle = userText.match(/\b(?:meeting\s+)?title\s+is\s+(.+)/i);
  if (inlineTitle) {
    let rest = inlineTitle[1].trim();
    const cut = rest.search(/\s+(?:and|but)\s+(?:book|schedule|find)\b/i);
    if (cut > 0) rest = rest.slice(0, cut).trim();
    return rest.replace(/[.!?]+$/g, "").trim() || null;
  }
  return null;
}

function looksLikeSchedulingIntent(text) {
  const t = text.toLowerCase();
  return (
    /\b\d+\s*(min|minutes?|hours?|hrs?|h)\b/i.test(text) ||
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t) ||
    /\b(mon|tue|wed|thu|fri|sat|sun)\b/i.test(t) ||
    /\b(today|tomorrow|next week)\b/i.test(t) ||
    /\bday\s+after\s+tomorrow\b/i.test(t) ||
    /\b\d+\s+days?\s+from\s+(today|now)\b/i.test(t) ||
    /\bin\s+\d+\s+days?\b/i.test(t) ||
    /\b\d+\s+weeks?\s+from\s+(today|now)\b/i.test(t) ||
    /\b(morning|afternoon|evening|noon)\b/i.test(t) ||
    /\b\d{1,2}\s*(:\d{2})?\s*(am|pm)\b/i.test(t)
  );
}

function inferPlainTitle(userText) {
  const t = userText.trim();
  if (!t || t.length > 200) return null;
  if (looksLikeSchedulingIntent(t)) return null;
  const withoutEmails = t
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutEmails || withoutEmails.length < 2) return null;
  return withoutEmails;
}

function extractRenameInstruction(userText) {
  const renameTo = userText.match(/(?:rename|retitle|change title).*?\bto\s+["']?([^"']+)["']?/i);
  if (renameTo) return renameTo[1].trim();
  const callIt = userText.match(/(?:call|name)\s+(?:this|that|it)\s+["']?([^"']+)["']?/i);
  if (callIt) return callIt[1].trim();
  return null;
}

function extractEmails(text) {
  const matches =
    text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(matches.map((email) => email.toLowerCase()))];
}

function getParticipantEmails(attendeeEmails) {
  return attendeeEmails.filter(
    (email) => email.toLowerCase() !== config.hostEmail.toLowerCase(),
  );
}

function displayAttendee(email) {
  return email.toLowerCase() === config.hostEmail.toLowerCase() ? config.hostName : email;
}

function displayAttendeeList(attendees) {
  return attendees.map(displayAttendee).join(", ");
}

function acknowledgeGuestEmails(participants) {
  if (participants.length === 1) {
    return `Thanks — I’ve got you at ${participants[0]}.`;
  }
  return `Thanks — I’ve got ${participants.join(", ")} on the list.`;
}

function bookingInviteSummary(attendeeEmails) {
  const guests = getParticipantEmails(attendeeEmails);
  if (guests.length === 1) {
    return `You and ${config.hostName} will both get the calendar invite.`;
  }
  return `${guests.join(", ")} and ${config.hostName} are on the invite.`;
}

function isAddParticipantIntent(userText) {
  return /\b(add|include|invite)\b.*\b(participant|attendee|invitee|guest|email|people)\b/i.test(
    userText,
  );
}

function isCancelIntent(userText) {
  return /\b(cancel|delete|remove)\b.*\b(meeting|appointment|event|it)?\b/i.test(userText);
}

function beginNewBookingDraft(state) {
  state.constraints = createDefaultSession().constraints;
  state.lastSuggestedSlots = [];
  state.clarifyCount = 0;
  state.title = null;
  state.onboardingStep = "title";
}

function isNewBookingIntent(userText) {
  const t = userText.toLowerCase();
  if (/\b(another|a\s+new|one\s+more)\s+(meeting|call|session|appointment|booking|slot)\b/i.test(t)) {
    return true;
  }
  if (/\b(book|schedule|set\s+up)\s+(another|a\s+new|one\s+more)\b/i.test(t)) {
    return true;
  }
  if (/\bstart\s+(over|fresh)\b/i.test(t)) return true;
  if (/\bnew\s+(meeting|call|session|appointment|booking)\b/i.test(t)) return true;
  return false;
}

function hasSchedulingKeyword(userText) {
  const t = userText.toLowerCase();
  return (
    /\b(book|schedule|set\s*up|arrange|find|look\s+for)\b/i.test(t) &&
    /\b(meeting|call|appointment|slot|time)\b/i.test(t)
  );
}

function isFreshSchedulingRequestWithoutWindow(userText, parsedPatch) {
  if (!hasSchedulingKeyword(userText)) return false;
  if (isRescheduleIntent(userText)) return false;
  return !(
    parsedPatch.windowStartISO ||
    parsedPatch.windowEndISO ||
    parsedPatch.dayPart ||
    (parsedPatch.preferredDays?.length ?? 0) > 0 ||
    Number.isInteger(parsedPatch.preferredStartHour) ||
    Number.isInteger(parsedPatch.notBeforeHour) ||
    Number.isInteger(parsedPatch.notAfterHour)
  );
}

function resetTemporalConstraints(existing) {
  return {
    ...existing,
    dayPart: null,
    preferredDays: [],
    avoidDays: [],
    windowStartISO: null,
    windowEndISO: null,
    notBeforeHour: undefined,
    notAfterHour: undefined,
    preferredStartHour: undefined,
    preferredStartMinute: undefined,
    afterLastMeetingBufferMinutes: undefined,
  };
}

function isRescheduleIntent(userText) {
  const t = userText.toLowerCase();
  if (/\breschedule\b/i.test(t)) return true;
  if (/\b(move|push|shift)\s+it\s+(to|on)\b/i.test(t)) return true;
  if (/\bchange\s+(the\s+)?(time|when)\b/i.test(t)) return true;
  if (/\b(move|push)\s+(my|the|our|that)\s+(meeting|call|appointment|event)\b/i.test(t)) {
    return true;
  }
  if (
    /\b(last|that|previous|just|the)\b/i.test(t) &&
    /\bdifferent\s+(time|day|slot)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

function parseRescheduleDateTime(userText, now) {
  const results = chrono.parse(userText, now, { forwardDate: true });
  if (!results.length) {
    return { date: null, needsTime: false, unclear: true, hasExplicitDate: false };
  }
  const start = results[0].start;
  const date = start.date();
  if (!date || Number.isNaN(date.getTime())) {
    return { date: null, needsTime: false, unclear: true, hasExplicitDate: false };
  }
  const lower = userText.toLowerCase();
  const hasExplicitDate =
    start.isCertain("day") ||
    start.isCertain("month") ||
    start.isCertain("year") ||
    start.isCertain("weekday") ||
    /\b(today|tomorrow|tonight|next|this)\b/.test(lower) ||
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower) ||
    /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/.test(
      lower,
    ) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(lower);
  if (!start.isCertain("hour")) {
    return { date, needsTime: true, unclear: false, hasExplicitDate };
  }
  return { date, needsTime: false, unclear: false, hasExplicitDate };
}

function mergeTimeOntoDateInTimeZone(dateOnlyInstant, timeInstant, timeZone) {
  const tz = timeZone || "UTC";
  const dateWallTime = toZonedTime(dateOnlyInstant, tz);
  const timeWallTime = toZonedTime(timeInstant, tz);
  let merged = setHours(dateWallTime, timeWallTime.getHours());
  merged = setMinutes(merged, timeWallTime.getMinutes());
  merged = setSeconds(merged, 0);
  merged = setMilliseconds(merged, 0);
  return fromZonedTime(merged, tz);
}

/** Resolve an event when the user’s message mentions the calendar title (fuzzy match). */
async function findEventByTitleMentionInMessage(userText) {
  const now = new Date();
  const rangeStart = startOfDay(subMinutes(now, 12 * 60));
  const rangeEnd = endOfDay(addDays(now, 30));
  const upcoming = await listEvents(rangeStart.toISOString(), rangeEnd.toISOString());
  if (!upcoming.length) return null;
  return (
    upcoming.find((event) => {
      const s = (event.summary || "").trim();
      return s.length > 2 && eventTitleMatchesQuery(event.summary || "", userText);
    }) || null
  );
}

function parseMeetingListIndex(userText) {
  let t = userText.trim().replace(/^\s*reschedule\s+/i, "").trim();
  const onlyNum = t.match(/^\s*#?(\d{1,2})\s*$/);
  if (onlyNum) return Number(onlyNum[1]);

  const ord = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
  };
  const lower = t.toLowerCase();
  for (const [word, n] of Object.entries(ord)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return n;
  }

  const leadNum = t.match(/^\s*#?(\d{1,2})(?:\s*[,;:\-–]|\s+(?=[a-zA-Z0-9]))/);
  if (leadNum) return Number(leadNum[1]);

  return null;
}

function stripLeadingListPick(userText) {
  let t = userText.trim().replace(/^\s*reschedule\s+/i, "").trim();
  t = t.replace(/^\s*#?(\d{1,2})\s*(?:[,;:\-–]\s*|\s+)/, "").trim();
  return t;
}

function isListMeetingsIntent(userText) {
  const t = userText.toLowerCase();
  return (
    /\b(list|show)\b.*\b(meetings?|calls?|appointments?)\b/i.test(t) ||
    /\bwhat\s+(meetings?|calls?)\b/i.test(t) ||
    /\b(my|our)\s+(upcoming\s+)?(meetings?|calls?)\b/i.test(t)
  );
}

async function buildGuestMeetingPickList(state, tz) {
  const guests = getParticipantEmails(state.attendeeEmails);
  if (!guests.length) {
    return {
      error: `Share your email first so I can list meetings where you’re invited with ${config.hostName}.`,
    };
  }
  const events = await listUpcomingEventsWithGuest(guests, 60);
  if (!events.length) {
    return {
      empty: `I don’t see upcoming meetings on ${config.hostName}’s calendar where your email is on the invite. If something was just booked, wait a moment and try again — or book a time and I’ll list it next time.`,
    };
  }
  const slice = events.slice(0, 15);
  const lines = slice.map((ev, i) => {
    const label = formatSlotLabel(parseISO(ev.start), tz);
    return `${i + 1}. “${ev.summary}” — ${label}`;
  });
  const pickList = slice.map((ev) => ({
    id: ev.id,
    summary: ev.summary,
    startISO: ev.start,
  }));
  return { lines, pickList };
}

function isRenameIntent(userText) {
  return /\b(rename|retitle|change title|call this|name this|call it|name it)\b/i.test(userText);
}

async function findEventByTimeOrName(userText) {
  const now = new Date();
  const rangeStart = startOfDay(subMinutes(now, 12 * 60));
  const rangeEnd = endOfDay(addDays(now, 30));
  const upcoming = await listEvents(rangeStart.toISOString(), rangeEnd.toISOString());
  if (!upcoming.length) return null;

  const normalized = userText.toLowerCase();
  const byName = upcoming.find((event) =>
    normalized.includes((event.summary || "").toLowerCase()),
  );
  if (byName) return byName;

  const parsed = chrono.parseDate(
    normalized
      .replace(/\ba\.\s*m\.?\b/gi, "am")
      .replace(/\bp\.\s*m\.?\b/gi, "pm"),
    now,
    { forwardDate: true },
  );
  if (!parsed) return null;

  return (
    upcoming.find((event) => {
      if (!event.start) return false;
      const eventDate = new Date(event.start);
      return (
        eventDate.getFullYear() === parsed.getFullYear() &&
        eventDate.getMonth() === parsed.getMonth() &&
        eventDate.getDate() === parsed.getDate() &&
        eventDate.getHours() === parsed.getHours() &&
        eventDate.getMinutes() === parsed.getMinutes()
      );
    }) || null
  );
}

function hasExplicitTimeWindow(constraints) {
  return Boolean(
    constraints.windowStartISO &&
      constraints.windowEndISO &&
      Number.isInteger(constraints.notBeforeHour) &&
      Number.isInteger(constraints.notAfterHour),
  );
}

function buildNearbyWindow(constraints, minutes = 120) {
  if (!constraints.windowStartISO || !constraints.windowEndISO) return null;
  const start = parseISO(constraints.windowStartISO);
  const end = parseISO(constraints.windowEndISO);

  return {
    ...constraints,
    windowStartISO: subMinutes(start, minutes).toISOString(),
    windowEndISO: addMinutes(end, minutes).toISOString(),
    notBeforeHour: undefined,
    notAfterHour: undefined,
  };
}

export async function handleSchedulerTurn({ sessionId, userText, timezone, clientSession }) {
  const state = getSession(sessionId, clientSession);
  if (state.onboardingStep === undefined) {
    const migratedParticipants = getParticipantEmails(state.attendeeEmails);
    const hasTitle = state.title && String(state.title).trim();
    if (migratedParticipants.length && hasTitle) state.onboardingStep = "done";
    else if (migratedParticipants.length) state.onboardingStep = "title";
    else state.onboardingStep = "email";
  }
  const tz = timezone || state.activeTimezone || config.timezone;
  if (timezone) state.activeTimezone = timezone;

  const extractedEmails = extractEmails(userText);
  if (extractedEmails.length) {
    state.attendeeEmails = [...new Set([...state.attendeeEmails, ...extractedEmails])];
  }

  if (state.onboardingStep === "done" && isNewBookingIntent(userText)) {
    beginNewBookingDraft(state);
  }

  let newTitleInstruction = extractTitleInstruction(userText);
  if (state.onboardingStep === "title" && !newTitleInstruction) {
    newTitleInstruction = inferPlainTitle(userText);
  }
  if (newTitleInstruction) {
    state.title = newTitleInstruction;
  }

  if (state.pendingRescheduleEventId) {
    if (/\b(cancel|never\s+mind|forget\s+it|abort)\b/i.test(userText)) {
      state.pendingRescheduleEventId = null;
      return {
        message: "Okay — I won’t change that meeting.",
        state,
      };
    }
    const parsedPending = parseRescheduleDateTime(userText, new Date());
    if (parsedPending.unclear || !parsedPending.date) {
      return {
        message: `What day and time should I move it to? I’ll keep the same length.`,
        state,
      };
    }
    if (parsedPending.needsTime) {
      const dayHint = formatInTimeZone(parsedPending.date, tz, "EEEE, MMMM d");
      return {
        message: `What time on ${dayHint} should I move it to?`,
        state,
      };
    }
    if (!parsedPending.hasExplicitDate) {
      return {
        message: `Please include the day as well, for example: “Wednesday at 4:00 PM.”`,
        state,
      };
    }
    const movedPending = await updateCalendarEventTime(
      state.pendingRescheduleEventId,
      parsedPending.date.toISOString(),
      tz,
    );
    state.pendingRescheduleEventId = null;
    if (!movedPending.updated) {
      return {
        message: movedPending.reason
          ? `I couldn’t move it: ${movedPending.reason}`
          : `I couldn’t move that meeting.`,
        state,
      };
    }
    const whenSpoken = formatSlotLabel(parsedPending.date, tz);
    return {
      message: `Updated — it’s now at ${whenSpoken}. Invites will refresh if Google sends updates.`,
      state,
    };
  }

  if (state.reschedulePickList?.length) {
    const idx = parseMeetingListIndex(userText);
    if (idx !== null) {
      const item = state.reschedulePickList[idx - 1];
      if (!item) {
        return {
          message: `Pick a number between 1 and ${state.reschedulePickList.length}.`,
          state,
        };
      }
      const rest = stripLeadingListPick(userText);
      state.reschedulePickList = null;
      const parsedPick = parseRescheduleDateTime(rest.length >= 3 ? rest : "", new Date());
      if (rest.length >= 3 && !parsedPick.unclear && parsedPick.date && !parsedPick.needsTime) {
        const movedAt = parsedPick.hasExplicitDate
          ? parsedPick.date
          : mergeTimeOntoDateInTimeZone(parseISO(item.startISO), parsedPick.date, tz);
        const movedPick = await updateCalendarEventTime(item.id, movedAt.toISOString(), tz);
        if (!movedPick.updated) {
          state.pendingRescheduleEventId = item.id;
          return {
            message: movedPick.reason
              ? `I couldn’t move it: ${movedPick.reason} Want to try a different time?`
              : `I couldn’t move that meeting — want to try a different time?`,
            state,
          };
        }
        const whenSpoken = formatSlotLabel(movedAt, tz);
        return {
          message: `Updated — “${item.summary}” is now at ${whenSpoken}.`,
          state,
        };
      }
      if (rest.length >= 3 && !parsedPick.unclear && parsedPick.date && parsedPick.needsTime) {
        const dayHint = formatInTimeZone(parsedPick.date, tz, "EEEE, MMMM d");
        state.pendingRescheduleEventId = item.id;
        return {
          message: `What time on ${dayHint} should I move “${item.summary}” to?`,
          state,
        };
      }
      state.pendingRescheduleEventId = item.id;
      return {
        message: `Got “${item.summary}”. What day and time should I move it to?`,
        state,
      };
    }
  }

  if (isListMeetingsIntent(userText)) {
    const built = await buildGuestMeetingPickList(state, tz);
    if (built.error) {
      return { message: built.error, state };
    }
    if (built.empty) {
      return { message: built.empty, state };
    }
    state.reschedulePickList = built.pickList;
    return {
      message: `Here are upcoming meetings with ${config.hostName} where you’re on the invite — reply with a number to reschedule one, then say the new time:\n\n${built.lines.join("\n")}\n\nExample: “2” then “Tuesday at 3pm”, or “2 Tuesday 3pm”.`,
      state,
    };
  }

  if (isAddParticipantIntent(userText)) {
    if (!extractedEmails.length) {
      return {
        message:
          `Sure — what email should I add? I’ll include them on the invite with ${config.hostName}.`,
        state,
      };
    }

    if (state.lastBookedEventId) {
      const updated = await updateCalendarEventAttendees(
        state.lastBookedEventId,
        [config.hostEmail, ...extractedEmails],
      );
      if (!updated.updated) {
        return {
          message: `I couldn’t add them just yet: ${updated.reason}.`,
          state,
        };
      }
      return {
        message: `You’re all set — I’ve added ${displayAttendeeList(extractedEmails)} alongside ${config.hostName}.`,
        state,
      };
    }

    return {
      message: `Got it — I’ll add ${extractedEmails.join(", ")} when we book with ${config.hostName}.`,
      state,
    };
  }

  if (isRescheduleIntent(userText)) {
    let targetEventId = state.lastBookedEventId;
    if (!targetEventId) {
      const byTitle = await findEventByTitleMentionInMessage(userText);
      targetEventId = byTitle?.id || null;
    }
    if (!targetEventId) {
      const built = await buildGuestMeetingPickList(state, tz);
      if (built.error) {
        return { message: built.error, state };
      }
      if (built.empty) {
        return {
          message: `${built.empty} You can also say part of the meeting title as it appears on the calendar.`,
          state,
        };
      }
      state.reschedulePickList = built.pickList;
      return {
        message: `Here are upcoming meetings with ${config.hostName} where you’re on the invite — reply with a number, then the new time:\n\n${built.lines.join("\n")}\n\nExample: “2” then “Tuesday at 3pm”, or “2 Tuesday 3pm”.`,
        state,
      };
    }

    const parsed = parseRescheduleDateTime(userText, new Date());
    if (parsed.unclear || !parsed.date) {
      state.pendingRescheduleEventId = targetEventId;
      return {
        message: `What day and time should I move it to? I’ll keep the same meeting length.`,
        state,
      };
    }
    if (parsed.needsTime) {
      state.pendingRescheduleEventId = targetEventId;
      const dayHint = formatInTimeZone(parsed.date, tz, "EEEE, MMMM d");
      return {
        message: `What time on ${dayHint} should I move it to?`,
        state,
      };
    }
    if (!parsed.hasExplicitDate) {
      state.pendingRescheduleEventId = targetEventId;
      return {
        message: `Sure — what day should I move it to at that time?`,
        state,
      };
    }

    const moved = await updateCalendarEventTime(targetEventId, parsed.date.toISOString(), tz);
    if (!moved.updated) {
      return {
        message: moved.reason
          ? `I couldn’t move it: ${moved.reason}`
          : `I couldn’t move that meeting.`,
        state,
      };
    }
    const whenSpoken = formatSlotLabel(parsed.date, tz);
    return {
      message: `Updated — it’s now at ${whenSpoken}. Invites will refresh if Google sends updates.`,
      state,
    };
  }

  if (isRenameIntent(userText)) {
    const renameTo = extractRenameInstruction(userText);
    if (!renameTo) {
      return {
        message: "Sure thing — what would you like the new title to be?",
        state,
      };
    }

    let targetEventId = state.lastBookedEventId;
    if (!targetEventId) {
      const byReference = await findEventByTimeOrName(userText);
      targetEventId = byReference?.id || null;
    }
    if (!targetEventId) {
      return {
        message:
          "I’m not sure which event you mean — could you tell me the time or the current title?",
        state,
      };
    }

    const updated = await updateCalendarEventTitle(targetEventId, renameTo);
    if (!updated.updated) {
      return {
        message: `I couldn’t rename that one: ${updated.reason}.`,
        state,
      };
    }
    state.title = updated.summary || renameTo;
    return {
      message: `Done — it’s now titled “${state.title}”.`,
      state,
    };
  }

  if (isCancelIntent(userText)) {
    let targetEventId = state.lastBookedEventId;
    if (!targetEventId || !/\b(it|that|last)\b/i.test(userText)) {
      const byReference = await findEventByTimeOrName(userText);
      targetEventId = byReference?.id || targetEventId;
    }
    if (!targetEventId) {
      return {
        message:
          "I can cancel it — just tell me which meeting (the title or the time works).",
        state,
      };
    }

    const cancelled = await cancelCalendarEvent(targetEventId);
    if (!cancelled.cancelled) {
      return {
        message: `I couldn’t cancel that one: ${cancelled.reason}.`,
        state,
      };
    }
    if (state.lastBookedEventId === targetEventId) {
      state.lastBookedEventId = null;
    }
    return {
      message: "All set — I’ve cancelled that meeting.",
      state,
    };
  }

  const parsedPatch = await extractConstraintsFromText(userText, findEventByName, {
    linkCalendarEvents: state.onboardingStep === "done",
    timeZone: tz,
  });
  if (parsedPatch.missingEventReference) {
    return {
      message: `I couldn’t find “${parsedPatch.missingEventReference}” on ${config.hostName}’s calendar. Could you match the title the way it shows there?`,
      state,
    };
  }
  if (state.onboardingStep === "done" && isFreshSchedulingRequestWithoutWindow(userText, parsedPatch)) {
    state.constraints = resetTemporalConstraints(state.constraints);
  }
  state.constraints = mergeConstraints(state.constraints, parsedPatch);

  const participants = getParticipantEmails(state.attendeeEmails);
  if (state.onboardingStep === "email") {
    if (!participants.length) {
      return {
        message:
          `Hi — before I check ${config.hostName}’s availability, what’s your email? I’ll use it to send you the calendar invite.`,
        state,
      };
    }
    state.onboardingStep = "title";
    if (state.title && String(state.title).trim()) {
      state.onboardingStep = "done";
    } else {
      return {
        message: `${acknowledgeGuestEmails(participants)} What should we call this meeting with ${config.hostName}?`,
        state,
      };
    }
  }

  if (state.onboardingStep === "title") {
    if (!state.title || !String(state.title).trim()) {
      return {
        message:
          `What should we put as the meeting title? For example “Intro call” or “title is product walkthrough”.`,
        state,
      };
    }
    state.onboardingStep = "done";
  }

  const chosenSlot = matchSlotFromUserText(userText, state.lastSuggestedSlots, tz);
  if (chosenSlot) {
    const participantEmails = getParticipantEmails(state.attendeeEmails);
    if (!participantEmails.length) {
      return {
        message:
          `Almost there — I need your email so I can send you the invite with ${config.hostName}.`,
        state,
      };
    }

    const meetingTitle = state.title?.trim() || "Meeting";
    const attendeesForBooking = [...new Set([config.hostEmail, ...participantEmails])];
    const created = await createCalendarEvent({
      title: meetingTitle,
      startISO: chosenSlot.startISO,
      endISO: chosenSlot.endISO,
      attendees: attendeesForBooking,
      timeZone: tz,
    });
    if (created.created) {
      state.lastBookedEventId = created.eventId;
      const whenSpoken = formatSlotLabel(parseISO(chosenSlot.startISO), tz);
      return {
        message: `You’re booked — “${meetingTitle}” with ${config.hostName} at ${whenSpoken}.${created.meetLink ? ` Meet link: ${created.meetLink}` : ""} ${bookingInviteSummary(attendeesForBooking)}${created.attendeeInviteWarning ? ` ${created.attendeeInviteWarning}` : ""}${created.meetLinkWarning ? ` ${created.meetLinkWarning}` : ""}`,
        state,
        debug: { created },
      };
    }
    return {
      message: created.conflict
        ? `That time is no longer available because "${created.conflict.summary || "another event"}" overlaps it. Would you like the next best options?`
        : `I had your time, but couldn’t create the event: ${created.reason}.`,
      state,
    };
  }

  if (!hasEnoughInfo(state.constraints)) {
    let question;
    try {
      question = await generateClarifyingQuestion(state, userText);
    } catch {
      state.clarifyCount = (state.clarifyCount || 0) + 1;
      const i = state.clarifyCount % 3;
      const dq = [
        "Roughly how long should we block — 15, 30, 45 minutes?",
        "How much time do you need?",
        "What meeting length works for you?",
      ];
      const wq = [
        "Any day or part of the week you’re aiming for?",
        "Prefer a specific day or time of day?",
        "When were you hoping to meet?",
      ];
      question = !state.constraints.durationMinutes
        ? dq[i]
        : wq[i];
    }
    return { message: question, state };
  }

  const now = new Date();
  const userDayStart = zonedStartOfDay(now, tz);
  const constraintStart = state.constraints.windowStartISO
    ? parseISO(state.constraints.windowStartISO)
    : userDayStart;
  const searchStart = new Date(Math.min(constraintStart.getTime(), userDayStart.getTime()));
  const searchEnd = state.constraints.windowEndISO
    ? parseISO(state.constraints.windowEndISO)
    : addMinutes(now, 14 * 24 * 60);
  const busyIntervals = await getBusyIntervals(searchStart.toISOString(), searchEnd.toISOString(), tz);
  let slots = findAvailableSlots({
    constraints: state.constraints,
    busyIntervals,
    timezone: tz,
    maxSlots: 3,
    stepMinutes: config.slotStepMinutes,
    now,
  });

  if (!slots.length) {
    if (hasExplicitTimeWindow(state.constraints)) {
      const nearbyConstraints = buildNearbyWindow(state.constraints, 120);
      if (nearbyConstraints) {
        const nearbySlots = findAvailableSlots({
          constraints: nearbyConstraints,
          busyIntervals,
          timezone: tz,
          maxSlots: 3,
          stepMinutes: config.slotStepMinutes,
          now,
        });
        if (nearbySlots.length) {
          state.lastSuggestedSlots = nearbySlots;
          return {
            message: `Nothing free in that exact window, but here’s what’s close: ${slotListToSpeechFriendlyText(
              nearbySlots,
              tz,
            )}. Want one of these?`,
            state,
          };
        }
      }
    }

    const fallback = buildFallbackAlternatives(state.constraints);
    slots = findAvailableSlots({
      constraints: fallback,
      busyIntervals,
      timezone: tz,
      maxSlots: 3,
      stepMinutes: config.slotStepMinutes,
      now,
    });
    if (!slots.length) {
      return {
        message:
          "I’m not seeing openings there. Want me to look a bit wider — say, the next week or so?",
        state,
      };
    }

    state.lastSuggestedSlots = slots;
    return {
      message: `That window is currently full. Here are the next best options: ${slotListToSpeechFriendlyText(
        slots,
        tz,
      )}. Which works for you?`,
      state,
    };
  }

  state.lastSuggestedSlots = slots;
  return {
    message: `Here are a few times that look good: ${slotListToSpeechFriendlyText(
      slots,
      tz,
    )}. Just tell me which one you want and I’ll lock it in.`,
    state,
  };
}
