/*
 * lib/datetime.js — date/time parsing and formatting helpers.
 *
 * Skool's own .ics files always express times in UTC (DTSTART:20260927T173000Z),
 * so the canonical internal representation is a JS Date (which is UTC-based
 * internally) and we serialise to UTC on the way out. This sidesteps the
 * VTIMEZONE problem entirely and is correct for every calendar client.
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function pad(n, width) {
    var s = String(Math.abs(n));
    while (s.length < (width || 2)) s = "0" + s;
    return (n < 0 ? "-" : "") + s;
  }

  /** Return the browser's IANA timezone, or "UTC" as a last resort. */
  function localTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch (e) {
      return "UTC";
    }
  }

  /**
   * Parse anything event-ish into a Date, or null.
   * Accepts: Date, epoch seconds, epoch millis, ISO 8601, ICS compact form
   * (20260927T173000Z), and a handful of human formats Skool may render.
   */
  function parseDate(value) {
    if (value === null || value === undefined || value === "") return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

    if (typeof value === "number") {
      // Heuristic: 10-digit numbers are seconds, 13-digit are millis.
      var ms = value < 1e12 ? value * 1000 : value;
      var d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }

    var s = String(value).trim();
    if (!s) return null;

    // Pure numeric string -> epoch (seconds or millis).
    if (/^\d{10}$/.test(s)) return parseDate(parseInt(s, 10) * 1000);
    if (/^\d{13}$/.test(s)) return parseDate(parseInt(s, 10));

    // ICS compact UTC/naive form: YYYYMMDDTHHMMSS[Z]
    var m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
    if (m) {
      var iso = m[1] + "-" + m[2] + "-" + m[3] +
        (m[4] ? "T" + m[4] + ":" + m[5] + ":" + m[6] : "T00:00:00") +
        (m[7] ? "Z" : "");
      var dd = new Date(iso);
      return isNaN(dd.getTime()) ? null : dd;
    }

    // Try the native parser for ISO 8601 and RFC 2822.
    var native = new Date(s);
    if (!isNaN(native.getTime())) return native;

    // "September 27, 2026 5:30 PM" / "27 Sep 2026 17:30"
    var alt = s.replace(/\bat\b/i, " ").replace(/(\d)(am|pm)/i, "$1 $2");
    var altDate = new Date(alt);
    if (!isNaN(altDate.getTime())) return altDate;

    return null;
  }

  /** Combine a loose date string and a loose time string into a Date. */
  function parseLooseDateTime(dateStr, timeStr) {
    if (!dateStr && !timeStr) return null;
    if (dateStr && !timeStr) return parseDate(dateStr);
    if (!dateStr && timeStr) {
      // Time only — assume today.
      var t = parseDate("1970-01-01 " + timeStr);
      if (!t) return null;
      var now = new Date();
      t.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
      return t;
    }
    return parseDate(String(dateStr).trim() + " " + String(timeStr).trim()) || parseDate(dateStr);
  }

  /* ---- ICS serialisation --------------------------------------------- */

  /** UTC form used by DTSTART/DTEND: 20260927T173000Z */
  function toIcsUtc(date) {
    return pad(date.getUTCFullYear(), 4) + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) +
      "T" + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + "Z";
  }

  /** Date-only form used for all-day events: 20260927 */
  function toIcsDate(date) {
    return pad(date.getUTCFullYear(), 4) + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate());
  }

  /** Local (floating) form: 20260927T173000 (no Z). */
  function toIcsLocal(date) {
    return pad(date.getFullYear(), 4) + pad(date.getMonth() + 1) + pad(date.getDate()) +
      "T" + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  }

  function fromIcsDate(value) {
    if (!value) return null;
    var s = String(value).trim();
    var m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    if (m[4]) {
      return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + (m[7] ? 0 : 0));
    }
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0));
  }

  /* ---- display helpers ------------------------------------------------ */

  function formatDate(date, opts) {
    if (!date) return "";
    var o = opts || {};
    var now = new Date();
    var sameYear = date.getFullYear() === now.getFullYear();
    var time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    var day = date.getDate() + " " + MONTHS[date.getMonth()];
    if (!sameYear || o.alwaysYear) day += " " + date.getFullYear();
    return o.dateOnly ? day : day + ", " + time;
  }

  function formatRange(start, end) {
    if (!start) return "No date";
    if (!end) return formatDate(start);
    var sameDay = start.toDateString() === end.toDateString();
    var time = function (d) { return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
    if (sameDay) return formatDate(start) + " – " + time(end);
    return formatDate(start) + " → " + formatDate(end);
  }

  function toInputDate(date) {
    if (!date) return "";
    return pad(date.getFullYear(), 4) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function fromInputDate(value) {
    if (!value) return null;
    var d = new Date(value + "T00:00:00");
    return isNaN(d.getTime()) ? null : d;
  }

  function addMonths(date, n) {
    var d = new Date(date.getTime());
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  }

  function addMinutes(date, n) { return new Date(date.getTime() + n * 60000); }

  function diffMinutes(a, b) { return Math.round((a.getTime() - b.getTime()) / 60000); }

  function isSameDay(a, b) {
    return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  /** Google Calendar uses RFC3339 with an offset; UTC is always accepted. */
  function toRfc3339(date) { return date.toISOString(); }

  g.SkoolCal.dt = {
    MONTHS: MONTHS,
    MONTHS_LONG: MONTHS_LONG,
    pad: pad,
    localTimeZone: localTimeZone,
    parseDate: parseDate,
    parseLooseDateTime: parseLooseDateTime,
    toIcsUtc: toIcsUtc,
    toIcsDate: toIcsDate,
    toIcsLocal: toIcsLocal,
    fromIcsDate: fromIcsDate,
    formatDate: formatDate,
    formatRange: formatRange,
    toInputDate: toInputDate,
    fromInputDate: fromInputDate,
    addMonths: addMonths,
    addMinutes: addMinutes,
    diffMinutes: diffMinutes,
    isSameDay: isSameDay,
    toRfc3339: toRfc3339
  };
})();
