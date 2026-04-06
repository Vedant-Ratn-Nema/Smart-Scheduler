import { google } from "googleapis";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import { addDays, formatISO, startOfDay, subMinutes } from "date-fns";
import { config, hasGoogleCalendar } from "../config.js";
import {
  getOAuthClientFromSavedToken,
  isOAuthConfigured,
} from "./oauthService.js";

function getCalendarConfigError() {
  if (!config.calendarId) return "Missing GOOGLE_CALENDAR_ID.";
  if (
    !isOAuthConfigured() &&
    !config.serviceAccountJson &&
    !config.serviceAccountFile
  ) {
    return "Missing OAuth config or service account credentials.";
  }
  return "";
}

function loadServiceAccountCredentials() {
  if (config.serviceAccountJson) {
    return JSON.parse(config.serviceAccountJson);
  }
  if (config.serviceAccountFile) {
    const fileContent = readFileSync(config.serviceAccountFile, "utf8");
    return JSON.parse(fileContent);
  }
  throw new Error("Service account credentials are not configured.");
}

async function getCalendarClient() {
  if (!hasGoogleCalendar) {
    return { calendar: null, error: getCalendarConfigError() || "Google Calendar is not configured." };
  }

  if (isOAuthConfigured()) {
    const { client, error } = await getOAuthClientFromSavedToken();
    if (!client) {
      return { calendar: null, error };
    }
    return {
      calendar: google.calendar({ version: "v3", auth: client }),
      error: null,
    };
  }

  try {
    const parsed = loadServiceAccountCredentials();
    const auth = new google.auth.GoogleAuth({
      credentials: parsed,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });

    return {
      calendar: google.calendar({ version: "v3", auth }),
      error: null,
    };
  } catch {
    return {
      calendar: null,
      error:
        "Invalid calendar credentials. Configure OAuth (recommended) or valid service-account credentials.",
    };
  }
}

export async function getBusyIntervals(startISO, endISO, timeZone = config.timezone) {
  const { calendar } = await getCalendarClient();
  if (!calendar) return [];

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      timeZone,
      items: [{ id: config.calendarId }],
    },
  });

  const busy = response.data.calendars?.[config.calendarId]?.busy || [];
  return busy.map((entry) => ({
    start: entry.start,
    end: entry.end,
  }));
}

export async function listEvents(startISO, endISO, queryText = "") {
  const { calendar } = await getCalendarClient();
  if (!calendar) return [];

  const response = await calendar.events.list({
    calendarId: config.calendarId,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
    orderBy: "startTime",
    q: queryText || undefined,
    maxResults: 50,
  });

  return (response.data.items || []).map((event) => ({
    id: event.id,
    summary: event.summary || "",
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
  }));
}

/**
 * Lists events in the window with attendee emails (for matching guests).
 * Omits cancelled events.
 */
export async function listEventsDetailed(startISO, endISO, queryText = "") {
  const { calendar } = await getCalendarClient();
  if (!calendar) return [];

  const response = await calendar.events.list({
    calendarId: config.calendarId,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
    orderBy: "startTime",
    q: queryText || undefined,
    maxResults: 50,
  });

  return (response.data.items || [])
    .filter((event) => event.status !== "cancelled")
    .map((event) => ({
      id: event.id,
      summary: event.summary || "(No title)",
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      attendeeEmails: [
        ...new Set(
          (event.attendees || [])
            .map((a) => a.email?.toLowerCase())
            .filter(Boolean),
        ),
      ],
    }));
}

/**
 * Upcoming events on the host calendar where one of the guest emails appears as an attendee.
 * Includes events starting from a short grace window before now through lookAheadDays.
 */
export async function listUpcomingEventsWithGuest(guestEmails, lookAheadDays = 60) {
  const emails = [...new Set(guestEmails.map((e) => String(e).toLowerCase()).filter(Boolean))];
  if (!emails.length) return [];

  const now = new Date();
  const startISO = formatISO(subMinutes(now, 30));
  const endISO = formatISO(addDays(startOfDay(now), lookAheadDays));
  const detailed = await listEventsDetailed(startISO, endISO, "");

  return detailed.filter((ev) => {
    if (!ev.start) return false;
    const startMs = new Date(ev.start).getTime();
    if (Number.isNaN(startMs) || startMs < now.getTime() - 60 * 1000) return false;
    if (!ev.attendeeEmails?.length) return false;
    return emails.some((g) => ev.attendeeEmails.includes(g));
  });
}

export async function findOverlappingEvents(startISO, endISO) {
  const { calendar } = await getCalendarClient();
  if (!calendar) return [];

  const response = await calendar.events.list({
    calendarId: config.calendarId,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  return (response.data.items || [])
    .filter((event) => event.status !== "cancelled")
    .map((event) => ({
      id: event.id,
      summary: event.summary || "",
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
    }));
}

const TITLE_STOP_WORDS = /\b(?:the|a|an|my)\b/gi;

function normalizeEventTitleForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(TITLE_STOP_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Matches user/transcribed phrases to calendar titles even when articles differ (e.g. "planning week" vs "Planning the week"). */
export function eventTitleMatchesQuery(summary, query) {
  const s = normalizeEventTitleForMatch(summary);
  const q = normalizeEventTitleForMatch(query);
  if (!q || q.length < 2) return false;
  return s.includes(q) || q.includes(s);
}

export async function findEventByName(name, lookAheadDays = 60) {
  const startISO = formatISO(new Date());
  const endISO = formatISO(addDays(startOfDay(new Date()), lookAheadDays));

  const pick = (events) =>
    events.find((event) => eventTitleMatchesQuery(event.summary, name));

  let events = await listEvents(startISO, endISO, name);
  let found = pick(events);
  if (!found) {
    events = await listEvents(startISO, endISO, "");
    found = pick(events);
  }
  return found;
}

export async function createCalendarEvent({
  title,
  startISO,
  endISO,
  attendees = [],
  timeZone = config.timezone,
}) {
  const { calendar, error } = await getCalendarClient();
  if (!calendar) {
    return { created: false, reason: error || "Google Calendar is not configured." };
  }

  const conflicts = await findOverlappingEvents(startISO, endISO);
  if (conflicts.length) {
    return {
      created: false,
      reason: "That slot is already occupied in your calendar.",
      conflict: conflicts[0],
    };
  }

  const requestBody = {
    summary: title || "Scheduled meeting",
    start: {
      dateTime: startISO,
      timeZone,
    },
    end: {
      dateTime: endISO,
      timeZone,
    },
    attendees: attendees.map((email) => ({ email })),
    conferenceData: {
      createRequest: {
        requestId: randomUUID(),
      },
    },
  };

  let response;
  let attendeeInviteWarning = "";
  let meetLinkWarning = "";
  try {
    response = await calendar.events.insert({
      calendarId: config.calendarId,
      conferenceDataVersion: 1,
      sendUpdates: attendees.length ? "all" : "none",
      requestBody,
    });
  } catch (error) {
    const message = String(error?.message || "");
    const invalidConferenceType = /invalid conference type value/i.test(message);
    if (invalidConferenceType) {
      meetLinkWarning =
        "Google Meet link could not be auto-generated with this calendar configuration.";
      const requestBodyWithoutConference = { ...requestBody };
      delete requestBodyWithoutConference.conferenceData;
      response = await calendar.events.insert({
        calendarId: config.calendarId,
        sendUpdates: attendees.length ? "all" : "none",
        requestBody: requestBodyWithoutConference,
      });
    } else {
    const cannotInviteWithServiceAccount =
      attendees.length &&
      /cannot invite attendees without Domain-Wide Delegation|forbiddenForServiceAccounts/i.test(
        message,
      );

      if (!cannotInviteWithServiceAccount) {
        throw error;
      }

      attendeeInviteWarning =
        "Attendee invites were not sent because this service account is not delegated for user-wide email invites.";
      response = await calendar.events.insert({
        calendarId: config.calendarId,
        conferenceDataVersion: 1,
        sendUpdates: "none",
        requestBody: {
          ...requestBody,
          attendees: [],
        },
      });
    }
  }

  return {
    created: true,
    eventId: response.data.id,
    htmlLink: response.data.htmlLink,
    meetLink:
      response.data.hangoutLink ||
      response.data.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")
        ?.uri ||
      "",
    attendeeInviteWarning,
    meetLinkWarning,
  };
}

export async function updateCalendarEventTime(eventId, newStartISO, timeZone = config.timezone) {
  const { calendar, error } = await getCalendarClient();
  if (!calendar) {
    return { updated: false, reason: error || "Google Calendar is not configured." };
  }

  const existing = await calendar.events.get({
    calendarId: config.calendarId,
    eventId,
  });

  const startStr = existing.data.start?.dateTime;
  const endStr = existing.data.end?.dateTime;
  if (!startStr || !endStr) {
    return { updated: false, reason: "That event doesn’t have movable start/end times." };
  }

  const durationMs = new Date(endStr).getTime() - new Date(startStr).getTime();
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { updated: false, reason: "Could not read this event’s duration." };
  }

  const newEnd = new Date(new Date(newStartISO).getTime() + durationMs);
  const newStartStr = formatISO(new Date(newStartISO));
  const newEndStr = formatISO(newEnd);

  const conflicts = await findOverlappingEvents(newStartStr, newEndStr);
  const blocking = conflicts.filter((c) => c.id !== eventId);
  if (blocking.length) {
    return {
      updated: false,
      reason: `That time overlaps “${blocking[0].summary || "another event"}”.`,
      conflict: blocking[0],
    };
  }

  await calendar.events.patch({
    calendarId: config.calendarId,
    eventId,
    sendUpdates: "all",
    requestBody: {
      start: { dateTime: newStartStr, timeZone },
      end: { dateTime: newEndStr, timeZone },
    },
  });

  return {
    updated: true,
    startISO: newStartStr,
    endISO: newEndStr,
  };
}

export async function updateCalendarEventTitle(eventId, newTitle) {
  const { calendar, error } = await getCalendarClient();
  if (!calendar) {
    return { updated: false, reason: error || "Google Calendar is not configured." };
  }

  const response = await calendar.events.patch({
    calendarId: config.calendarId,
    eventId,
    requestBody: {
      summary: newTitle,
    },
  });

  return {
    updated: true,
    eventId: response.data.id,
    summary: response.data.summary || newTitle,
  };
}

export async function updateCalendarEventAttendees(eventId, attendeeEmails) {
  const { calendar, error } = await getCalendarClient();
  if (!calendar) {
    return { updated: false, reason: error || "Google Calendar is not configured." };
  }

  const existing = await calendar.events.get({
    calendarId: config.calendarId,
    eventId,
  });

  const existingEmails = new Set(
    (existing.data.attendees || [])
      .map((attendee) => attendee.email?.toLowerCase())
      .filter(Boolean),
  );
  attendeeEmails.forEach((email) => existingEmails.add(email.toLowerCase()));

  let response;
  let warning = "";
  try {
    response = await calendar.events.patch({
      calendarId: config.calendarId,
      eventId,
      sendUpdates: "all",
      requestBody: {
        attendees: [...existingEmails].map((email) => ({ email })),
      },
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (
      /cannot invite attendees without Domain-Wide Delegation|forbiddenForServiceAccounts/i.test(
        message,
      )
    ) {
      warning =
        "Could not send attendee invites from this service account. Configure Domain-Wide Delegation to enable participant invites.";
      return {
        updated: false,
        reason: warning,
      };
    }
    throw error;
  }

  return {
    updated: true,
    attendeeCount: (response.data.attendees || []).length,
    warning,
  };
}

export async function cancelCalendarEvent(eventId) {
  const { calendar, error } = await getCalendarClient();
  if (!calendar) {
    return { cancelled: false, reason: error || "Google Calendar is not configured." };
  }

  await calendar.events.delete({
    calendarId: config.calendarId,
    eventId,
  });

  return { cancelled: true };
}
