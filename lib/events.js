/*
 * lib/events.js — the canonical event model.
 *
 * Every extraction source (Skool .ics files, the DOM, intercepted JSON APIs,
 * embedded Next.js payloads) is normalised into one shape:
 *
 *   {
 *     uid, eventId, title, description, location, url,
 *     start: Date, end: Date, allDay: boolean, timezone,
 *     organizer, organizerName, host,
 *     rrule, exdates: Date[], recurring: boolean,
 *     community, communityName, meetingProvider,
 *     status, sequence, dtstamp, created, lastModified,
 *     source, confidence
 *   }
 *
 * `confidence` lets merge() prefer authoritative data (a fetched .ics = 100)
 * over heuristic DOM scraping (=40).
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};
  var dt = g.SkoolCal.dt;
  var CONST = g.SkoolCal.CONST;

  var SOURCE_CONFIDENCE = { ics: 100, network: 80, json: 70, dom: 40, manual: 90 };

  /* ---- ids ------------------------------------------------------------- */

  /** Stable 32-hex hash (FNV-1a repeated over 4 lanes) for synthesised ids. */
  function hash32(str) {
    var h = [0x811c9dc5, 0x01000193, 0x7fffffff, 0xdeadbeef];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h[0] = ((h[0] ^ c) * 16777619) >>> 0;
      h[1] = ((h[1] + c) * 2246822519) >>> 0;
      h[2] = ((h[2] ^ (c << 5)) * 3266489917) >>> 0;
      h[3] = ((h[3] + (c << 7)) * 668265263) >>> 0;
    }
    return h.map(function (x) { return ("00000000" + x.toString(16)).slice(-8); }).join("");
  }

  /**
   * Skool's own UID format is "<32 hex event id><10-digit unix seconds>".
   * The API gives us that second part directly as `occurrenceId`, so when both
   * are present we reproduce Skool's exact UID — which means re-exporting an
   * event we already downloaded by hand stays a duplicate, not a second copy.
   */
  function makeUid(ev) {
    if (ev.uid) return ev.uid;
    if (ev.eventId && ev.occurrenceId) {
      return ev.eventId + String(ev.occurrenceId).replace(/\D/g, "");
    }
    if (ev.eventId && ev.start) {
      return ev.eventId + Math.floor(ev.start.getTime() / 1000);
    }
    var basis = [ev.title || "", ev.start ? ev.start.toISOString() : "", ev.community || ""].join("|");
    return hash32(basis) + "@skoolcal-sync";
  }

  /** Reverse of the Skool UID convention; returns null if it doesn't match. */
  function parseSkoolUid(uid) {
    if (!uid) return null;
    var m = String(uid).match(/^([0-9a-f]{32})(\d{9,11})$/i);
    if (!m) return null;
    return { eventId: m[1].toLowerCase(), startEpoch: parseInt(m[2], 10) };
  }

  /* ---- small helpers --------------------------------------------------- */

  function firstString(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return null;
  }

  function firstValue(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null && obj[keys[i]] !== "") return obj[keys[i]];
    }
    return null;
  }

  function looksLikeUrl(s) {
    return typeof s === "string" && /^https?:\/\//i.test(s.trim());
  }

  function extractUrls(text) {
    if (!text) return [];
    var re = /https?:\/\/[^\s<>"')\]]+/gi;
    var out = [];
    var m;
    while ((m = re.exec(text))) out.push(m[0].replace(/[.,;]+$/, ""));
    return out;
  }

  function detectMeeting() {
    var urls = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (typeof a === "string") urls = urls.concat(extractUrls(a));
      else if (Array.isArray(a)) urls = urls.concat(a);
    }
    for (var j = 0; j < urls.length; j++) {
      for (var k = 0; k < CONST.MEETING_PROVIDERS.length; k++) {
        if (CONST.MEETING_PROVIDERS[k].re.test(urls[j])) {
          return { name: CONST.MEETING_PROVIDERS[k].name, url: urls[j] };
        }
      }
    }
    return urls.length ? { name: "Link", url: urls[0] } : null;
  }

  /**
   * Skool appends "\n\nFrom: <Community Name>" to every DESCRIPTION. Split it
   * back out so we get a clean description plus the community display name.
   */
  function splitSkoolDescription(description) {
    if (!description) return { description: "", communityName: null };
    var re = /\n{0,2}From:\s*(.+?)\s*$/i;
    var m = re.exec(description);
    if (m) {
      return {
        description: description.slice(0, m.index).trim(),
        communityName: m[1].trim()
      };
    }
    return { description: description.trim(), communityName: null };
  }

  /* ---- date coercion --------------------------------------------------- */

  function coerceDate(value) {
    if (!value) return null;
    if (typeof value === "object" && !(value instanceof Date)) {
      // Google-style { dateTime, timeZone } or { date }
      var nested = value.dateTime || value.datetime || value.date || value.start || value.value;
      if (nested) return dt.parseDate(nested);
      return null;
    }
    return dt.parseDate(value);
  }

  function coerceTimezone(value) {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof value === "object") return value.timeZone || value.timezone || null;
    return null;
  }

  /**
   * Skool stores LOCATION as a JSON string:
   *   "{\"location_type\":2,\"location_info\":\"https://meet.google.com/...\"}"
   * location_type 1 = Zoom, 2 = Google Meet, 3 = Skool call, 0/other = custom.
   * Unwrap it so the meeting link ends up in LOCATION and is detected as a
   * provider rather than being emitted as an escaped JSON blob.
   */
  function parseLocationField(value) {
    if (!value || typeof value !== "string") return value;
    var s = value.trim();
    if (s.charAt(0) !== "{") return value;
    try {
      var obj = JSON.parse(s);
      return obj.location_info || obj.location_url || obj.url || obj.link || obj.address || "";
    } catch (e) {
      return value;
    }
  }

  /** Flatten Skool's nested { ...event, metadata: { title, description, ... } }. */
  function flattenMetadata(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
    var meta = obj.metadata;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return obj;
    return Object.assign({}, meta, obj);
  }

  /* ---- normalisation --------------------------------------------------- */

  var FIELD_ALIASES = {
    title: ["title", "name", "summary", "eventName", "event_name", "label", "heading"],
    description: ["description", "desc", "details", "body", "about", "content", "notes"],
    start: ["start", "startTime", "start_time", "startsAt", "starts_at", "startDate", "start_date", "date", "beginsAt", "begins_at", "from", "startAt", "starts"],
    end: ["end", "endTime", "end_time", "endsAt", "ends_at", "endDate", "end_date", "to", "finish", "ends"],
    location: ["location", "locationUrl", "location_url", "meetingUrl", "meeting_url", "meetingLink", "meeting_link", "venue", "address", "place", "link", "joinUrl", "join_url"],
    url: ["url", "permalink", "href", "eventUrl", "event_url", "shareUrl", "share_url", "publicUrl"],
    id: ["id", "eventId", "event_id", "uuid", "uuidHex", "_id", "slug", "key", "calendarEventId"],
    occurrenceId: ["occurrenceId", "occurrence_id", "occurrence"],
    organizer: ["organizer", "organizerEmail", "hostEmail", "email", "createdByEmail"],
    organizerName: ["organizerName", "hostName", "host", "organizer_name", "author", "instructor", "createdBy", "owner", "speaker"],
    timezone: ["timezone", "timeZone", "tz", "time_zone"],
    rrule: ["rrule", "recurrence", "repeatRule", "repeat_rule", "recurrenceRule"],
    recurring: ["recurring", "isRecurring", "is_recurring", "repeats", "repeating"],
    duration: ["duration", "durationMinutes", "duration_minutes", "length"]
  };

  /**
   * Normalise an arbitrary raw object into the canonical event shape.
   * @param {object} raw
   * @param {object} [ctx] { community, communityName, source, eventId, url }
   */
  function normalize(raw, ctx) {
    ctx = ctx || {};
    if (!raw || typeof raw !== "object") return null;

    var title = firstString(raw, FIELD_ALIASES.title);
    var start = coerceDate(firstValue(raw, FIELD_ALIASES.start));
    if (!title && !start) return null;

    var end = coerceDate(firstValue(raw, FIELD_ALIASES.end));
    var timezone = coerceTimezone(firstValue(raw, FIELD_ALIASES.timezone)) || ctx.timezone || null;

    var allDay = !!(raw.allDay || raw.all_day || (typeof firstValue(raw, FIELD_ALIASES.start) === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(firstValue(raw, FIELD_ALIASES.start)))));
    if (allDay && start) { start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); }

    // Duration fallback when only a start + duration are given.
    if (start && !end) {
      var dur = firstValue(raw, FIELD_ALIASES.duration);
      var mins = typeof dur === "number" ? dur : (typeof dur === "string" && /^\d+$/.test(dur) ? parseInt(dur, 10) : null);
      end = dt.addMinutes(start, mins && mins > 0 ? mins : 60);
    }
    if (start && end && end < start) end = dt.addMinutes(start, 60);

    var descriptionRaw = firstString(raw, FIELD_ALIASES.description);
    var split = splitSkoolDescription(descriptionRaw);

    var location = parseLocationField(firstString(raw, FIELD_ALIASES.location));
    var urls = extractUrls(descriptionRaw).concat(extractUrls(location));
    var meeting = detectMeeting(urls, location);

    var recurringFlag = raw.recurring === true || raw.isRecurring === true || raw.is_recurring === true ||
      raw.repeats === true || !!firstValue(raw, FIELD_ALIASES.rrule);

    var event = {
      uid: null,
      eventId: firstString(raw, FIELD_ALIASES.id) || ctx.eventId || null,
      occurrenceId: firstString(raw, FIELD_ALIASES.occurrenceId) || ctx.occurrenceId || null,
      title: title || "Untitled event",
      description: split.description || "",
      location: (meeting && meeting.url) ? meeting.url : (looksLikeUrl(location) ? location : (location || "")),
      url: firstString(raw, FIELD_ALIASES.url) || ctx.url || null,
      start: start,
      end: end,
      allDay: allDay,
      timezone: timezone,
      organizer: firstString(raw, FIELD_ALIASES.organizer),
      organizerName: firstString(raw, FIELD_ALIASES.organizerName) || ctx.organizerName || null,
      host: firstString(raw, FIELD_ALIASES.organizerName) || ctx.host || null,
      rrule: firstString(raw, FIELD_ALIASES.rrule),
      exdates: [],
      recurrenceId: null,
      recurring: recurringFlag,
      community: ctx.community || null,
      communityName: split.communityName || ctx.communityName || null,
      meetingProvider: meeting ? meeting.name : null,
      status: "CONFIRMED",
      sequence: 0,
      dtstamp: new Date(),
      created: coerceDate(raw.createdAt || raw.created_at) || null,
      lastModified: coerceDate(raw.updatedAt || raw.updated_at) || null,
      source: ctx.source || "json",
      confidence: SOURCE_CONFIDENCE[ctx.source || "json"] || 50
    };

    event.uid = raw.uid || makeUid(event);
    return event;
  }

  /** Convert a parsed .ics VEVENT into the canonical shape. */
  function fromIcs(icsEvent, ctx) {
    ctx = ctx || {};
    if (!icsEvent || !icsEvent.start) return null;
    var split = splitSkoolDescription(icsEvent.description);
    var meeting = detectMeeting(icsEvent.location, icsEvent.description);
    var parsedUid = parseSkoolUid(icsEvent.uid);

    var ev = {
      uid: icsEvent.uid || null,
      eventId: parsedUid ? parsedUid.eventId : (ctx.eventId || null),
      occurrenceId: parsedUid ? String(parsedUid.startEpoch) : (ctx.occurrenceId || null),
      title: icsEvent.title || "Untitled event",
      description: split.description || "",
      location: (meeting && meeting.url) ? meeting.url : (icsEvent.location || ""),
      url: icsEvent.url || ctx.url || null,
      start: icsEvent.start,
      end: icsEvent.end || dt.addMinutes(icsEvent.start, 60),
      allDay: !!icsEvent.allDay,
      timezone: icsEvent.timezone || ctx.timezone || null,
      organizer: icsEvent.organizer || null,
      organizerName: icsEvent.organizerName || null,
      host: icsEvent.organizerName || null,
      rrule: icsEvent.rrule || null,
      exdates: icsEvent.exdates || [],
      recurrenceId: icsEvent.recurrenceId || null,
      recurring: !!icsEvent.rrule,
      community: ctx.community || null,
      communityName: split.communityName || ctx.communityName || null,
      meetingProvider: meeting ? meeting.name : null,
      status: icsEvent.status || "CONFIRMED",
      sequence: icsEvent.sequence || 0,
      dtstamp: icsEvent.dtstamp || new Date(),
      created: icsEvent.created || null,
      lastModified: icsEvent.lastModified || null,
      source: "ics",
      confidence: SOURCE_CONFIDENCE.ics
    };
    if (!ev.uid) ev.uid = makeUid(ev);
    return ev;
  }

  /* ---- dedupe / merge -------------------------------------------------- */

  function dedupeKey(ev) {
    if (ev.uid) return "u:" + ev.uid;
    if (ev.eventId) return "i:" + ev.eventId;
    var t = (ev.title || "").toLowerCase().replace(/\s+/g, " ").trim();
    return "t:" + t + "@" + (ev.start ? ev.start.toISOString() : "?");
  }

  function richness(ev) {
    var score = ev.confidence || 0;
    if (ev.description) score += 5;
    if (ev.location) score += 3;
    if (ev.url) score += 2;
    if (ev.end) score += 2;
    if (ev.organizerName) score += 1;
    return score;
  }

  /** Merge b into a, keeping the richer value for each field. */
  function mergeEvent(a, b) {
    if (!a) return b;
    if (!b) return a;
    var winner = richness(b) > richness(a) ? b : a;
    var loser = winner === a ? b : a;
    var out = {};
    var keys = Object.keys(winner);
    keys.forEach(function (k) { out[k] = winner[k]; });
    Object.keys(loser).forEach(function (k) {
      if (out[k] === null || out[k] === undefined || out[k] === "") out[k] = loser[k];
    });
    out.uid = a.uid || b.uid;
    out.confidence = Math.max(a.confidence || 0, b.confidence || 0);
    if (a.community && b.community && a.community !== b.community) {
      // Same event seen in two communities — keep both, caller decides.
      out.communities = [a.community, b.community];
    }
    return out;
  }

  /** Deduplicate a list, preferring higher-confidence records. */
  function dedupe(events) {
    var map = Object.create(null);
    (events || []).forEach(function (ev) {
      if (!ev || !ev.start) return;
      var key = dedupeKey(ev);
      map[key] = map[key] ? mergeEvent(map[key], ev) : ev;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  /* ---- recurring-series inference -------------------------------------- */

  var WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

  /**
   * Skool exports each occurrence of a recurring series as its own VEVENT, so
   * `recurring` is false on every record even though the series repeats. This
   * groups records that share a normalised title + time-of-day and infers an
   * RRULE when the cadence is regular.
   *
   * Returns a Map of groupKey -> { events, rrule, recurring }.
   */
  function groupSeries(events) {
    var groups = Object.create(null);
    (events || []).forEach(function (ev) {
      if (!ev.start) return;
      // NOTE: neither the location nor the exact time-of-day is part of the
      // key. Skool issues a fresh Meet/Zoom link per occurrence and the start
      // time can drift by a few minutes between occurrences (DST changes or
      // host edits), so both are too brittle to group on.
      var key = (ev.title || "").toLowerCase().replace(/\s+/g, " ").trim() +
        "|" + (ev.community || "");
      (groups[key] = groups[key] || []).push(ev);
    });

    var result = Object.create(null);
    Object.keys(groups).forEach(function (key) {
      var list = groups[key].sort(function (a, b) { return a.start - b.start; });
      var info = { events: list, rrule: null, recurring: list.length > 1 && !!list[0].rrule };
      if (list.length >= 3) {
        info.rrule = inferRrule(list);
        info.recurring = info.recurring || !!info.rrule;
      }
      result[key] = info;
    });
    return result;
  }

  /** Infer FREQ/INTERVAL/BYDAY from evenly spaced occurrences (best effort). */
  function inferRrule(list) {
    if (!list || list.length < 3) return null;
    var days = [];
    for (var i = 1; i < list.length; i++) {
      days.push(Math.round((list[i].start - list[i - 1].start) / 86400000));
    }
    var allSame = days.every(function (d) { return d === days[0]; });
    if (allSame) {
      var step = days[0];
      if (step === 1) return "FREQ=DAILY";
      if (step === 7) {
        var wd = WEEKDAY[list[0].start.getUTCDay()];
        var sameWeekday = list.every(function (e) { return WEEKDAY[e.start.getUTCDay()] === wd; });
        return sameWeekday ? "FREQ=WEEKLY;BYDAY=" + wd : null;
      }
      if (step === 14) return "FREQ=WEEKLY;INTERVAL=2;BYDAY=" + WEEKDAY[list[0].start.getUTCDay()];
      if (step >= 28 && step <= 31) return "FREQ=MONTHLY;BYMONTHDAY=" + list[0].start.getUTCDate();
      if (step % 7 === 0) return "FREQ=WEEKLY;INTERVAL=" + (step / 7) + ";BYDAY=" + WEEKDAY[list[0].start.getUTCDay()];
      if (step < 7) return "FREQ=DAILY;INTERVAL=" + step;
      return null;
    }

    // Multi-weekday weekly pattern, e.g. every Monday AND Thursday. The gaps
    // alternate (3,4,3,4...) so the allSame branch never fires, but the set of
    // weekdays stays tiny and consistent.
    var weekdays = [];
    list.forEach(function (e) {
      var d = e.start.getUTCDay();
      if (weekdays.indexOf(d) === -1) weekdays.push(d);
    });
    var regularGaps = days.every(function (d) { return d >= 1 && d <= 7; });
    if (weekdays.length <= 3 && regularGaps) {
      weekdays.sort(function (a, b) { return a - b; });
      return "FREQ=WEEKLY;BYDAY=" + weekdays.map(function (d) { return WEEKDAY[d]; }).join(",");
    }
    return null;
  }

  function makeSeries(cluster, rrule) {
    var first = cluster[0];
    var duration = (first.end && first.start) ? (first.end - first.start) : 3600000;
    var last = cluster[cluster.length - 1];
    return Object.assign({}, first, {
      rrule: rrule,
      recurring: true,
      uid: makeUid({ title: first.title, start: first.start, community: first.community }) + "-series",
      end: new Date(first.start.getTime() + duration),
      exdates: [],
      occurrenceCount: cluster.length,
      seriesLast: last.start
    });
  }

  /**
   * Collapse inferred series into single recurring events.
   * Off by default (occurrences carry exact dates + UIDs), opt-in via settings.
   *
   * When a series runs on several weekdays with different times (common on
   * Skool: "Q&A" every Monday 14:30 *and* every Thursday 11:00), it is split
   * into one recurring event per weekday so the times stay accurate.
   */
  function collapseSeries(events) {
    var groups = groupSeries(events);
    var out = [];

    function flush(list, rrule) {
      if (list.length >= 3 && rrule) out.push(makeSeries(list, rrule));
      else out = out.concat(list);
    }

    Object.keys(groups).forEach(function (key) {
      var info = groups[key];
      if (!info.rrule || info.events.length < 3) { out = out.concat(info.events); return; }

      var byday = /BYDAY=([A-Z,]+)/.exec(info.rrule);
      if (byday && byday[1].indexOf(",") !== -1) {
        byday[1].split(",").forEach(function (wd) {
          var cluster = info.events.filter(function (e) { return WEEKDAY[e.start.getUTCDay()] === wd; });
          if (!cluster.length) return;
          flush(cluster, "FREQ=WEEKLY;BYDAY=" + wd);
        });
        return;
      }
      flush(info.events, info.rrule);
    });
    return out;
  }

  /* ---- embedded-JSON scavenging ---------------------------------------- */

  /**
   * Recursively walk arbitrary JSON (e.g. a Next.js __NEXT_DATA__ payload or a
   * captured API response) and collect objects that look like calendar events.
   * Deliberately permissive: it only needs to feed normalize(), which drops
   * anything without a title or a start date.
   */
  function scavengeEvents(root, ctx, depth, seen) {
    depth = depth || 0;
    seen = seen || new Set();
    var found = [];
    if (depth > 8 || root === null || root === undefined) return found;
    if (typeof root !== "object") return found;
    if (seen.has(root)) return found;
    seen.add(root);

    if (Array.isArray(root)) {
      root.forEach(function (item) { found = found.concat(scavengeEvents(item, ctx, depth + 1, seen)); });
      return found;
    }

    var hasTitle = FIELD_ALIASES.title.some(function (k) { return typeof root[k] === "string" && root[k].trim(); });
    var startRaw = firstValue(root, FIELD_ALIASES.start);
    var hasStart = !!coerceDate(startRaw);

    // Skool nests the human-readable fields under `metadata`, so a raw event
    // object has no top-level title. Flatten before testing/normalising.
    var view = root;
    if (!hasTitle || !hasStart) {
      var flat = flattenMetadata(root);
      if (flat !== root) {
        var flatHasTitle = FIELD_ALIASES.title.some(function (k) { return typeof flat[k] === "string" && flat[k].trim(); });
        var flatHasStart = !!coerceDate(firstValue(flat, FIELD_ALIASES.start));
        if (flatHasTitle && flatHasStart) { view = flat; hasTitle = true; hasStart = true; }
      }
    }

    if (hasTitle && hasStart) {
      var ev = normalize(view, ctx);
      if (ev && ev.start) found.push(ev);
    }

    Object.keys(root).forEach(function (k) {
      var v = root[k];
      if (v && typeof v === "object") found = found.concat(scavengeEvents(v, ctx, depth + 1, seen));
    });
    return found;
  }

  /* ---- Google Calendar ------------------------------------------------- */

  /** Body for POST /calendars/{id}/events */
  function toGoogleEvent(ev, options) {
    var o = options || {};
    var body = {
      summary: ev.title,
      description: ev.description || undefined,
      location: ev.location || undefined,
      start: {},
      end: {},
      iCalUID: ev.uid || undefined,
      status: "confirmed",
      extendedProperties: {
        private: {
          skoolcalCommunity: ev.community || "",
          skoolcalEventId: ev.eventId || "",
          skoolcalSource: "skoolcal-sync"
        }
      },
      reminders: o.syncReminders && ev.description
        ? { useDefault: false, overrides: [] }
        : { useDefault: true }
    };

    if (ev.allDay) {
      body.start.date = dt.toIcsDate(ev.start).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
      var endDate = ev.end || dt.addMinutes(ev.start, 1440);
      body.end.date = dt.toIcsDate(endDate).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    } else {
      body.start.dateTime = ev.start.toISOString();
      body.end.dateTime = (ev.end || dt.addMinutes(ev.start, 60)).toISOString();
      body.start.timeZone = ev.timezone || o.timezone || "UTC";
      body.end.timeZone = ev.timezone || o.timezone || "UTC";
    }

    if (ev.rrule) body.recurrence = [ev.rrule.indexOf("RRULE:") === 0 ? ev.rrule : "RRULE:" + ev.rrule];
    if (ev.url) body.source = { title: "Skool", url: ev.url };
    if (ev.organizer) body.attendees = undefined; // never auto-invite anyone
    return body;
  }

  /** Public "add to Google Calendar" template link (used by Copy links). */
  function googleTemplateLink(ev) {
    var dates = ev.allDay
      ? dt.toIcsDate(ev.start) + "/" + dt.toIcsDate(ev.end || dt.addMinutes(ev.start, 1440))
      : dt.toIcsUtc(ev.start) + "/" + dt.toIcsUtc(ev.end || dt.addMinutes(ev.start, 60));
    var params = {
      action: "TEMPLATE",
      text: ev.title || "",
      dates: dates,
      details: ev.description || "",
      location: ev.location || "",
      trp: "false"
    };
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    }).join("&");
    return "https://calendar.google.com/calendar/render?" + qs;
  }

  /**
   * True once the event has finished. Past events are hidden from the popup and
   * excluded from exports by default.
   */
  function isPast(ev, now) {
    if (!ev || !ev.start) return false;
    var ref = now ? now.getTime() : Date.now();
    var end = ev.end ? ev.end.getTime() : ev.start.getTime();
    return end < ref;
  }

  /** Compact filename-safe slug. */
  function slugify(text, max) {    return String(text || "event")
      .replace(/[\/\\:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max || 60) || "event";
  }

  g.SkoolCal.events = {
    SOURCE_CONFIDENCE: SOURCE_CONFIDENCE,
    FIELD_ALIASES: FIELD_ALIASES,
    hash32: hash32,
    makeUid: makeUid,
    parseSkoolUid: parseSkoolUid,
    normalize: normalize,
    fromIcs: fromIcs,
    dedupeKey: dedupeKey,
    dedupe: dedupe,
    mergeEvent: mergeEvent,
    groupSeries: groupSeries,
    inferRrule: inferRrule,
    collapseSeries: collapseSeries,
    scavengeEvents: scavengeEvents,
    extractUrls: extractUrls,
    detectMeeting: detectMeeting,
    splitSkoolDescription: splitSkoolDescription,
    toGoogleEvent: toGoogleEvent,
    googleTemplateLink: googleTemplateLink,
    isPast: isPast,
    slugify: slugify,
    coerceDate: coerceDate
  };
})();
