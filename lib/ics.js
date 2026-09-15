/*
 * lib/ics.js — RFC 5545 (.ics) builder and parser.
 *
 * Builder notes:
 *  - Times are emitted in UTC (trailing "Z"). This is valid RFC 5545 and needs
 *    no VTIMEZONE block, which is what makes the output import cleanly into
 *    Apple Calendar, Google Calendar, Outlook and Thunderbird alike.
 *  - Lines are folded at 75 octets (UTF-8 aware) and terminated with CRLF.
 *  - Text values are escaped per RFC 5545 §3.3.11.
 *
 * Parser notes:
 *  - Handles line unfolding, parameters, and the escaped text Skool emits
 *    (see sample: "domain\, DNS\, warm-up" and literal "\n" newlines).
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};
  var dt = g.SkoolCal.dt;

  var CRLF = "\r\n";

  /* ---- text escaping --------------------------------------------------- */

  function escapeText(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");
  }

  function unescapeText(value) {
    if (value === null || value === undefined) return "";
    var out = "";
    for (var i = 0; i < value.length; i++) {
      var ch = value[i];
      if (ch === "\\" && i + 1 < value.length) {
        var next = value[++i];
        if (next === "n" || next === "N") out += "\n";
        else if (next === ",") out += ",";
        else if (next === ";") out += ";";
        else if (next === "\\") out += "\\";
        else out += next;
      } else {
        out += ch;
      }
    }
    return out;
  }

  /* ---- line folding (UTF-8 octet aware) -------------------------------- */

  var encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  function byteLength(str) {
    if (encoder) return encoder.encode(str).length;
    // Fallback approximation for very old engines.
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /** Fold a single logical line to <=75 octets per physical line. */
  function foldLine(line) {
    if (byteLength(line) <= 75) return line;
    var out = [];
    var current = "";
    var currentBytes = 0;
    // Iterate CODE POINTS, not UTF-16 code units: splitting between the two
    // halves of an emoji surrogate pair produces invalid UTF-16, which later
    // blows up encodeURIComponent with "malformed URI sequence".
    var chars = Array.from(line);
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var chBytes = byteLength(ch);
      // Continuation lines start with a single space, which counts toward the 75.
      var limit = out.length === 0 ? 75 : 74;
      if (current !== "" && currentBytes + chBytes > limit) {
        out.push(current);
        current = "";
        currentBytes = 0;
      }
      current += ch;
      currentBytes += chBytes;
    }
    if (current) out.push(current);
    return out.join(CRLF + " ");
  }

  /* ---- value builders -------------------------------------------------- */

  function dtProp(name, date, allDay) {
    if (allDay) return name + ";VALUE=DATE:" + dt.toIcsDate(date);
    return name + ":" + dt.toIcsUtc(date);
  }

  /**
   * Build one VEVENT block (array of unfolded logical lines).
   * @param {object} ev canonical event (see lib/events.js)
   */
  function buildEventLines(ev) {
    var lines = ["BEGIN:VEVENT"];
    var uid = ev.uid || (g.SkoolCal.events && g.SkoolCal.events.makeUid(ev)) || ("skoolcal-" + Date.now() + "@skoolcal-sync");
    lines.push("UID:" + uid);

    var stamp = ev.dtstamp || new Date();
    lines.push("DTSTAMP:" + dt.toIcsUtc(stamp));
    if (ev.created) lines.push("CREATED:" + dt.toIcsUtc(ev.created));
    if (ev.lastModified) lines.push("LAST-MODIFIED:" + dt.toIcsUtc(ev.lastModified));

    lines.push(dtProp("DTSTART", ev.start, ev.allDay));
    if (ev.end) lines.push(dtProp("DTEND", ev.end, ev.allDay));

    lines.push("SUMMARY:" + escapeText(ev.title || "Untitled event"));
    if (ev.description) lines.push("DESCRIPTION:" + escapeText(ev.description));
    if (ev.location) lines.push("LOCATION:" + escapeText(ev.location));
    if (ev.url) lines.push("URL:" + escapeText(ev.url));

    if (ev.organizer) {
      var cn = ev.organizerName ? ";CN=" + escapeText(ev.organizerName) : "";
      lines.push("ORGANIZER" + cn + ":mailto:" + ev.organizer);
    }

    lines.push("STATUS:" + (ev.status || "CONFIRMED"));
    lines.push("SEQUENCE:" + (ev.sequence || 0));
    lines.push("TRANSP:" + (ev.transparency || "OPAQUE"));

    // Recurrence: accept either a raw "FREQ=..." body or a full "RRULE:..." line.
    if (ev.rrule) {
      var rule = String(ev.rrule).replace(/^RRULE:/i, "");
      lines.push("RRULE:" + rule);
    }
    if (ev.exdates && ev.exdates.length) {
      ev.exdates.forEach(function (d) {
        lines.push("EXDATE" + (ev.allDay ? ";VALUE=DATE" : "") + ":" + (ev.allDay ? dt.toIcsDate(d) : dt.toIcsUtc(d)));
      });
    }
    if (ev.recurrenceId) {
      lines.push("RECURRENCE-ID" + (ev.allDay ? ";VALUE=DATE" : "") + ":" + (ev.allDay ? dt.toIcsDate(ev.recurrenceId) : dt.toIcsUtc(ev.recurrenceId)));
    }

    // Skool-specific provenance, harmless to other clients.
    if (ev.community) lines.push("X-SKOOLCAL-COMMUNITY:" + escapeText(ev.community));
    if (ev.eventId) lines.push("X-SKOOLCAL-EVENT-ID:" + escapeText(ev.eventId));
    if (ev.recurring) lines.push("X-SKOOLCAL-RECURRING:TRUE");

    lines.push("END:VEVENT");
    return lines;
  }

  /**
   * Build a full VCALENDAR document.
   * @param {object[]} events canonical events
   * @param {object} [opts] { name, method, prodId }
   */
  function build(events, opts) {
    var o = opts || {};
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//SkoolCal Sync//SkoolCal Sync//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:" + (o.method || "PUBLISH")
    ];
    if (o.name) {
      lines.push("X-WR-CALNAME:" + escapeText(o.name));
      lines.push("NAME:" + escapeText(o.name));
    }
    if (o.timezone) lines.push("X-WR-TIMEZONE:" + escapeText(o.timezone));

    (events || []).forEach(function (ev) {
      if (!ev || !ev.start) return;
      lines = lines.concat(buildEventLines(ev));
    });

    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join(CRLF) + CRLF;
  }

  /** Single-event calendar, for per-event .ics downloads. */
  function buildOne(ev, opts) {
    return build([ev], opts);
  }

  /* ---- parser ---------------------------------------------------------- */

  function unfold(text) {
    var normalised = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // A line beginning with space/tab continues the previous logical line.
    var raw = normalised.split("\n");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^[ \t]/.test(line) && out.length) {
        out[out.length - 1] += line.slice(1);
      } else {
        out.push(line);
      }
    }
    return out;
  }

  /** Split "NAME;PARAM=V;PARAM2=V2:VALUE" into parts. */
  function parseLine(line) {
    var colon = -1;
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ":" && !inQuotes) { colon = i; break; }
    }
    if (colon === -1) return null;
    var head = line.slice(0, colon);
    var value = line.slice(colon + 1);
    var segs = head.split(";");
    var name = segs.shift().toUpperCase();
    var params = {};
    segs.forEach(function (seg) {
      var eq = seg.indexOf("=");
      if (eq === -1) { params[seg.toUpperCase()] = true; return; }
      params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, "");
    });
    return { name: name, params: params, value: value };
  }

  function valueIsDateOnly(params, value) {
    if (params.VALUE && String(params.VALUE).toUpperCase() === "DATE") return true;
    return /^\d{8}$/.test(String(value).trim());
  }

  /**
   * Parse an .ics document into canonical-ish events.
   * Unknown properties are preserved on `ev.raw`.
   */
  function parse(text) {
    var lines = unfold(text);
    var events = [];
    var current = null;
    var calName = null;

    for (var i = 0; i < lines.length; i++) {
      var p = parseLine(lines[i]);
      if (!p) continue;

      if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") {
        current = { raw: {}, exdates: [] };
        continue;
      }
      if (p.name === "END" && p.value.toUpperCase() === "VEVENT") {
        if (current) events.push(current);
        current = null;
        continue;
      }
      if (p.name === "X-WR-CALNAME" || p.name === "NAME") {
        calName = unescapeText(p.value);
      }
      if (!current) continue;

      var val = p.value;
      switch (p.name) {
        case "UID": current.uid = val; break;
        case "SUMMARY": current.title = unescapeText(val); break;
        case "DESCRIPTION": current.description = unescapeText(val); break;
        case "LOCATION": current.location = unescapeText(val); break;
        case "URL": current.url = val; break;
        case "DTSTART":
          current.allDay = valueIsDateOnly(p.params, val);
          current.start = dt.fromIcsDate(val);
          if (p.params.TZID) current.timezone = p.params.TZID;
          break;
        case "DTEND":
          current.end = dt.fromIcsDate(val);
          break;
        case "DTSTAMP": current.dtstamp = dt.fromIcsDate(val); break;
        case "CREATED": current.created = dt.fromIcsDate(val); break;
        case "LAST-MODIFIED": current.lastModified = dt.fromIcsDate(val); break;
        case "STATUS": current.status = val.toUpperCase(); break;
        case "SEQUENCE": current.sequence = parseInt(val, 10) || 0; break;
        case "RRULE": current.rrule = val; current.recurring = true; break;
        case "EXDATE":
          val.split(",").forEach(function (v) {
            var d = dt.fromIcsDate(v.trim());
            if (d) current.exdates.push(d);
          });
          break;
        case "RECURRENCE-ID": current.recurrenceId = dt.fromIcsDate(val); break;
        case "ORGANIZER":
          var m = /mailto:([^;]+)/i.exec(val);
          if (m) current.organizer = m[1].trim();
          if (p.params.CN) current.organizerName = p.params.CN;
          break;
        default:
          if (/^X-SKOOLCAL-/.test(p.name)) current.raw[p.name] = val;
      }
    }

    return { name: calName, events: events };
  }

  g.SkoolCal.ICS = {
    CRLF: CRLF,
    escapeText: escapeText,
    unescapeText: unescapeText,
    foldLine: foldLine,
    byteLength: byteLength,
    build: build,
    buildOne: buildOne,
    buildEventLines: buildEventLines,
    parse: parse,
    unfold: unfold,
    parseLine: parseLine
  };
})();
