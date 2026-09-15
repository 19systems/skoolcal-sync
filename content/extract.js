/*
 * content/extract.js — the extraction engine.
 *
 * STRATEGY (in priority order, results are merged and de-duplicated):
 *
 *   1. .ics FETCH (confidence 100) — when an event's .ics URL is known we fetch
 *      it same-origin (cookies included) and parse it. This is the most
 *      reliable source by far: exact UTC times, description, location, UID and
 *      event id. NOTE: the month grid does not expose these URLs — they come
 *      from the intercepted API responses, so source 2 is what usually feeds
 *      this one on a calendar page.
 *
 *   2. INTERCEPTED JSON (confidence 80) — the MAIN-world hook records Skool's
 *      own calendar API responses. `scavengeEvents` walks them looking for
 *      event-shaped objects, so we don't need to hard-code the API schema.
 *      THIS IS THE PRIMARY SOURCE OF FULL EVENT DATA on the real calendar.
 *
 *   3. EMBEDDED JSON (confidence 70) — Next.js inlines its payload in
 *      <script> tags (__NEXT_DATA__ / self.__next_f). We scan those blobs.
 *
 *   4. DOM SCRAPING (confidence 35-40) — the real Skool calendar is a month
 *      grid of bare "2pm - Title" text chips (see extractFromGrid below). It
 *      yields title + local time only: no id, description, meeting link or
 *      .ics URL. Useful as a fallback and for discovering months, but the API
 *      is what makes the data complete.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MAINTAINING THIS FILE
 * ────────────────────────────────────────────────────────────────────────────
 * Skool's class names are styled-components hashes (sc-<hash>-<index>) and WILL
 * change. Everything structural is therefore kept in SELECTORS below as ordered
 * candidate lists — add a new candidate rather than replacing one. The grid
 * parser also has a structural fallback that does not depend on class names at
 * all (see findDayCells). If extraction returns 0 events:
 *   1. Open the calendar page and inspect an event chip / day cell.
 *   2. Add its selector to the top of the relevant SELECTORS entry.
 *   3. Reload the extension.
 */
(function () {
  "use strict";
  var g = globalThis;
  var SC = (g.SkoolCal = g.SkoolCal || {});
  var CONST = SC.CONST;
  var EV = SC.events;
  var ICS = SC.ICS;
  var dt = SC.dt;

  /* ======================================================================
   * SELECTOR REGISTRY — update here when Skool changes its markup.
   * Each value is an ordered list of CSS selectors, most-specific first.
   * ==================================================================== */
  var SELECTORS = {
    // Container that holds the month grid / event list. Used to scope queries.
    // `#calendar-wrapper` is the real id Skool renders (verified against the
    // live DOM) and is by far the most stable hook we have.
    calendarRoot: [
      "#calendar-wrapper",
      '[data-testid="calendar"]',
      '[data-testid*="calendar" i]',
      '[class*="calendar" i]',
      '[class*="Calendar"]',
      "main"
    ],
    // The month grid: day cells contain a leading <span> with the day number
    // and one chip per event. Class names are styled-components hashes, so the
    // structural fallback in findDayCells() is what we actually rely on.
    dayCell: [
      '[class*="3e5122c2-16"]',
      '[class*="3e5122c2-15"]'
    ],
    // A single event chip, e.g. <div>2pm - Brands Workshop with Himzo</div>.
    eventChip: [
      '[class*="3e5122c2-17"]'
    ],
    // The "September 2026" heading and the "11:33am Nairobi time" clock.
    monthLabel: ['[class*="3e5122c2-5"]'],
    timezoneLabel: ['[class*="3e5122c2-6"]'],
    // One event. `a[href*="/calendar/"]` is the most stable signal because
    // Skool links each event to its own detail view.
    eventCard: [
      '[data-testid*="event" i]',
      '[data-event-id]',
      '[data-eventid]',
      '[class*="event-card" i]',
      '[class*="eventCard"]',
      'a[href*="/calendar/"]',
      'a[href*="/events/"]',
      "article",
      '[role="button"]'
    ],
    title: [
      '[data-testid*="title" i]',
      '[class*="event-title" i]',
      '[class*="eventTitle"]',
      "h1", "h2", "h3", "h4",
      '[class*="title" i]',
      '[class*="name" i]'
    ],
    description: [
      '[data-testid*="description" i]',
      '[class*="event-description" i]',
      '[class*="description" i]',
      '[class*="desc" i]',
      "p"
    ],
    time: ["time", "[datetime]", '[data-start]', '[class*="time" i]', '[class*="date" i]'],
    location: [
      'a[href*="meet.google.com"]',
      'a[href*="zoom.us"]',
      'a[href*="teams.microsoft.com"]',
      'a[href*="discord.gg"]',
      '[data-testid*="location" i]',
      '[class*="location" i]',
      '[class*="meeting" i]'
    ],
    // Downloadable calendar file link, if rendered.
    icsLink: [
      'a[href*=".ics"]',
      'a[href*="ics?"]',
      "a[download]",
      "[data-ics-url]",
      "[data-download-url]"
    ],
    // "Next month" / "Load more" controls for paging the calendar.
    nextMonth: [
      '[aria-label*="next month" i]',
      '[aria-label*="Next" i][role="button"]',
      '[data-testid*="next" i]',
      'button[class*="next" i]',
      'button[title*="next" i]'
    ],
    loadMore: [
      'button[class*="load-more" i]',
      '[data-testid*="load-more" i]',
      'button[class*="loadMore"]'
    ]
  };

  var HEX32 = /\b[0-9a-f]{32}\b/i;
  var ICS_HREF = /\.ics(?:\?|$)/i;

  // A real event card always exposes a machine-readable time. We use this to
  // tell a card apart from an inner link that merely wraps the title.
  var TIME_SELECTORS = ["time[datetime]", "[datetime]", "[data-start]", "time"];

  /* ---- tiny DOM helpers ------------------------------------------------ */

  function q(root, selectorList) {
    for (var i = 0; i < selectorList.length; i++) {
      try {
        var el = root.querySelector(selectorList[i]);
        if (el) return el;
      } catch (e) { /* invalid selector — skip */ }
    }
    return null;
  }

  function qa(root, selectorList) {
    var out = [];
    for (var i = 0; i < selectorList.length; i++) {
      try {
        var nodes = root.querySelectorAll(selectorList[i]);
        for (var j = 0; j < nodes.length; j++) {
          if (out.indexOf(nodes[j]) === -1) out.push(nodes[j]);
        }
      } catch (e) { /* skip */ }
    }
    return out;
  }

  function clean(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function textOf(el) {
    if (!el) return "";
    // Prefer visible text; aria-label/title as fallback for icon-only nodes.
    var t = clean(el.textContent);
    if (!t) t = clean(el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title")));
    return t;
  }

  /** Walk up from `el` to the smallest ancestor that looks like an event card. */
  function closestCard(el, root) {
    var node = el;
    var depth = 0;
    while (node && node !== root && depth < 8) {
      if (node.matches && isCardCandidate(node)) return node;
      node = node.parentElement;
      depth++;
    }
    return el;
  }

  function matchesAnySelector(node, selectorList) {
    for (var i = 0; i < selectorList.length; i++) {
      try { if (node.matches(selectorList[i])) return true; } catch (e) { /* skip */ }
    }
    return false;
  }

  /**
   * A candidate card must match a known selector AND carry either a time or a
   * title. Skool nests the event link inside the card, so an inner <a> often
   * matches too — we resolve that in selectCards().
   */
  function isCardCandidate(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!matchesAnySelector(node, SELECTORS.eventCard)) return false;
    return !!q(node, TIME_SELECTORS) || !!q(node, SELECTORS.title);
  }

  /**
   * Pick the real cards out of all candidates.
   *
   * If a candidate contains another candidate that itself has a time, the outer
   * one is a container and is dropped. If the inner one only wraps the title
   * (no time), the outer one wins — which is what happens on Skool, where the
   * card is a <div> and the title sits inside an <a>.
   */
  function selectCards(root) {
    var candidates = qa(root, SELECTORS.eventCard).filter(isCardCandidate);
    var timed = candidates.map(function (c) { return !!q(c, TIME_SELECTORS); });

    return candidates.filter(function (card, i) {
      for (var j = 0; j < candidates.length; j++) {
        if (j === i) continue;
        // `card` is a container wrapping a complete (timed) card.
        if (card.contains(candidates[j]) && timed[j]) return false;
        // `card` is an inner wrapper (title link) with no time of its own.
        if (!timed[i] && candidates[j].contains(card)) return false;
      }
      return true;
    });
  }

  function findCalendarRoot() {
    return q(document, SELECTORS.calendarRoot) || document.body;
  }

  /* ---- field extraction ------------------------------------------------ */

  function extractEventId(card) {
    var attrs = ["data-event-id", "data-eventid", "data-event", "data-id", "data-uuid"];
    for (var i = 0; i < attrs.length; i++) {
      var v = card.getAttribute && card.getAttribute(attrs[i]);
      if (v && /^[0-9a-f]{16,}$/i.test(v.trim())) return v.trim().toLowerCase();
    }
    // href="/some-slug/calendar/<id>" or "?event=<id>"
    var links = card.querySelectorAll ? card.querySelectorAll("a[href]") : [];
    for (var j = 0; j < links.length; j++) {
      var href = links[j].getAttribute("href") || "";
      var m = href.match(/([0-9a-f]{32})/i) || href.match(/[?&]event(?:Id)?=([0-9a-f]{16,})/i);
      if (m) return m[1].toLowerCase();
    }
    // Last resort: a 32-hex token anywhere in the card's markup.
    var html = card.outerHTML || "";
    var hex = html.match(HEX32);
    return hex ? hex[0].toLowerCase() : null;
  }

  function extractTitle(card) {
    var el = q(card, SELECTORS.title);
    var title = textOf(el);
    if (title && title.length <= 200) return title;
    // Fallback: first meaningful line of the card.
    var lines = String(card.innerText || "").split("\n").map(clean).filter(Boolean);
    return lines[0] || "";
  }

  function extractDescription(card) {
    var candidates = qa(card, SELECTORS.description);
    var best = "";
    candidates.forEach(function (el) {
      var t = textOf(el);
      if (t.length > best.length && t.length < 4000) best = t;
    });
    return best;
  }

  function extractLocation(card) {
    var el = q(card, SELECTORS.location);
    if (el) {
      if (el.tagName === "A") return el.getAttribute("href") || textOf(el);
      return textOf(el);
    }
    var urls = EV.extractUrls(card.innerHTML);
    var meeting = EV.detectMeeting(urls);
    return meeting ? meeting.url : "";
  }

  /** Read start/end from <time datetime> nodes, then fall back to text. */
  function extractTimes(card) {
    var nodes = qa(card, TIME_SELECTORS);
    var dates = [];
    nodes.forEach(function (n) {
      var raw = n.getAttribute("datetime") || n.getAttribute("data-start") || n.textContent;
      var parsed = dt.parseDate(raw);
      if (parsed) dates.push(parsed);
    });
    if (dates.length >= 2) return { start: dates[0], end: dates[1] };
    if (dates.length === 1) return { start: dates[0], end: null };

    // Text fallback: "Sep 27, 2026 · 5:30 PM – 6:00 PM"
    var text = clean(card.innerText || card.textContent);
    var dateMatch = text.match(/([A-Z][a-z]{2,8}\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
    var timeMatches = text.match(/\d{1,2}:\d{2}\s*(?:am|pm)?/gi) || [];
    if (dateMatch && timeMatches.length) {
      var start = dt.parseLooseDateTime(dateMatch[1], timeMatches[0]);
      var end = timeMatches[1] ? dt.parseLooseDateTime(dateMatch[1], timeMatches[1]) : null;
      return { start: start, end: end };
    }
    if (dateMatch) return { start: dt.parseDate(dateMatch[1]), end: null };
    return { start: null, end: null };
  }

  /* ---- .ics URL discovery ---------------------------------------------- */

  function discoverIcsUrls(root) {
    var urls = [];
    var seen = Object.create(null);

    function add(url) {
      if (!url) return;
      var abs;
      try { abs = new URL(url, location.href).href; } catch (e) { return; }
      if (!ICS_HREF.test(abs) && !/calendar\/download/i.test(abs)) return;
      if (!seen[abs]) { seen[abs] = true; urls.push(abs); }
    }

    qa(root, SELECTORS.icsLink).forEach(function (el) {
      add(el.getAttribute("data-ics-url"));
      add(el.getAttribute("data-download-url"));
      add(el.getAttribute("href"));
    });

    // Any anchor whose href mentions .ics, even if it matched no selector.
    var anchors = root.querySelectorAll ? root.querySelectorAll("a[href]") : [];
    for (var i = 0; i < anchors.length; i++) add(anchors[i].getAttribute("href"));

    // Inline handlers sometimes carry the URL.
    var html = root.innerHTML || "";
    var re = /https?:\/\/[^\s"'<>]+?\.ics(?:\?[^\s"'<>]*)?/gi;
    var m;
    while ((m = re.exec(html))) add(m[0]);

    return urls;
  }

  /* ---- month grid (the real Skool calendar view) ----------------------- */

  /*
   * Skool renders a Monday-first month grid. Each day cell holds a leading
   * <span> with the day number and one text chip per event:
   *
   *   <div class="sc-...-16"><span>1</span>
   *     <div class="sc-...-17">2pm - Brands Q&A with Ossama</div>
   *   </div>
   *
   * The chips carry NO id, link, description or .ics URL — only "time - title".
   * Times are wall-clock in the ACCOUNT timezone (labelled e.g. "Nairobi time"),
   * so they are converted back to UTC here. This path is a fallback: the
   * intercepted API is what provides full event details.
   */

  var CHIP_RE = /^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–—]/i;

  function parseMonthLabel(text) {
    var t = clean(text);
    var m = t.match(/^([A-Za-z]{3,12})\.?\s+(\d{4})$/);
    if (!m) return null;
    var name = m[1].toLowerCase();
    var idx = -1;
    for (var i = 0; i < dt.MONTHS_LONG.length; i++) {
      if (dt.MONTHS_LONG[i].toLowerCase() === name) { idx = i; break; }
    }
    if (idx === -1) {
      for (var j = 0; j < dt.MONTHS.length; j++) {
        if (dt.MONTHS[j].toLowerCase() === name) { idx = j; break; }
      }
    }
    if (idx === -1) return null;
    return { year: parseInt(m[2], 10), month: idx };
  }

  function findMonthLabel(root) {
    var direct = q(root, SELECTORS.monthLabel);
    if (direct && parseMonthLabel(clean(direct.textContent))) return clean(direct.textContent);
    var els = root.querySelectorAll("div,span,h1,h2,h3,button");
    for (var i = 0; i < els.length; i++) {
      var t = clean(els[i].textContent);
      if (t.length <= 24 && parseMonthLabel(t)) return t;
    }
    return null;
  }

  /** 1 = Monday-first (Skool), 0 = Sunday-first. */
  function detectWeekStart(root) {
    var els = root.querySelectorAll("div,span,th");
    for (var i = 0; i < els.length; i++) {
      var t = clean(els[i].textContent).toLowerCase();
      if (t === "mon") return 1;
      if (t === "sun") return 0;
    }
    return 1;
  }

  function gridStartDate(anchor, weekStart) {
    var first = new Date(Date.UTC(anchor.year, anchor.month, 1));
    var back = weekStart === 1 ? (first.getUTCDay() + 6) % 7 : first.getUTCDay();
    return new Date(first.getTime() - back * 86400000);
  }

  function isDayCell(el) {
    var span = el.firstElementChild;
    return !!(span && span.tagName === "SPAN" && /^\d{1,2}$/.test(clean(span.textContent)));
  }

  /**
   * Find the day cells. Tries the known class first, then falls back to a
   * purely structural search (elements with a leading numeric <span>, grouped
   * into rows of 7) so a class-name change doesn't break us.
   */
  function findDayCells(root) {
    var classCells = qa(root, SELECTORS.dayCell).filter(isDayCell);
    if (classCells.length >= 28) return classCells;

    var numeric = [];
    var divs = root.querySelectorAll("div");
    for (var i = 0; i < divs.length; i++) if (isDayCell(divs[i])) numeric.push(divs[i]);

    var byParent = new Map();
    numeric.forEach(function (el) {
      var p = el.parentElement;
      if (!p) return;
      var arr = byParent.get(p) || [];
      arr.push(el);
      byParent.set(p, arr);
    });
    var cells = [];
    byParent.forEach(function (arr) { if (arr.length === 7) cells = cells.concat(arr); });
    return cells;
  }

  function findEventChips(cell) {
    var direct = Array.prototype.filter.call(cell.children, function (el) {
      return el.tagName !== "SPAN" && CHIP_RE.test(clean(el.textContent));
    });
    if (direct.length) return direct;

    var all = Array.prototype.slice.call(cell.querySelectorAll("*"));
    return all.filter(function (el) {
      if (!CHIP_RE.test(clean(el.textContent))) return false;
      // Keep only the innermost match.
      return !all.some(function (o) {
        return o !== el && el.contains(o) && CHIP_RE.test(clean(o.textContent));
      });
    });
  }

  /** "2pm - Brands Q&A" / "5:30pm - Review My Negotiations" */
  function parseChipText(text) {
    var m = clean(text).match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–—]\s*(.+)$/i);
    if (!m) return null;
    var hour = parseInt(m[1], 10) % 12;
    if (/pm/i.test(m[3])) hour += 12;
    var title = clean(m[4]);
    if (!title) return null;
    return {
      hour: hour,
      minute: m[2] ? parseInt(m[2], 10) : 0,
      title: title,
      cancelled: /^cancelled\b/i.test(title)
    };
  }

  /** Wrap a minute offset into [-720, 720] and snap to the nearest 15 min. */
  function normalizeOffset(minutes) {
    var m = minutes;
    while (m > 720) m -= 1440;
    while (m < -720) m += 1440;
    return Math.round(m / 15) * 15;
  }

  /** Exact UTC offset (minutes east) for an IANA zone at a given instant. */
  function zoneOffsetMinutes(zone, date) {
    try {
      var dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
      var p = {};
      dtf.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
      var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      return Math.round((asUtc - date.getTime()) / 60000);
    } catch (e) {
      return null;
    }
  }

  /**
   * Work out which timezone the calendar is displayed in.
   * The page shows its own clock ("11:33am Nairobi time"), so we can derive the
   * offset without a city database, then refine it with the IANA zone when the
   * city is known (which makes DST-transition dates exact).
   */
  function resolveTimeZone(root, now) {
    now = now || new Date();
    var text = "";
    var el = q(root, SELECTORS.timezoneLabel);
    if (el) text = clean(el.textContent);
    if (!text) {
      var els = document.querySelectorAll("div,span,a");
      for (var i = 0; i < els.length; i++) {
        var t = clean(els[i].textContent);
        if (t.length < 40 && /\d{1,2}:\d{2}\s*(?:am|pm)\s+.+\s+time/i.test(t)) { text = t; break; }
      }
    }
    var m = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)\s+(.+?)\s+time/i);
    if (!m) {
      return { city: null, zone: null, offsetMinutes: -now.getTimezoneOffset() };
    }
    var hour = parseInt(m[1], 10) % 12;
    if (/pm/i.test(m[3])) hour += 12;
    var displayed = hour * 60 + parseInt(m[2], 10);
    var utc = now.getUTCHours() * 60 + now.getUTCMinutes();
    var city = clean(m[4]);
    return {
      city: city,
      zone: CONST.TIMEZONE_CITIES[city.toLowerCase()] || null,
      offsetMinutes: normalizeOffset(displayed - utc)
    };
  }

  /** Wall-clock time in `tz` -> absolute Date. */
  function localToUtc(year, month, day, hour, minute, tz) {
    var wall = Date.UTC(year, month, day, hour, minute, 0);
    var offset = null;
    if (tz && tz.zone) {
      offset = zoneOffsetMinutes(tz.zone, new Date(wall));
      if (offset !== null) {
        var refined = zoneOffsetMinutes(tz.zone, new Date(wall - offset * 60000));
        if (refined !== null) offset = refined;
      }
    }
    if (offset === null || offset === undefined) offset = (tz && tz.offsetMinutes) || 0;
    return new Date(wall - offset * 60000);
  }

  function extractFromGrid() {
    var root = findCalendarRoot();
    var result = { events: [], icsUrls: [], ids: [], warnings: [], detected: false };

    var anchor = parseMonthLabel(findMonthLabel(root));
    var cells = findDayCells(root);
    if (!anchor || cells.length < 7) return result;

    result.detected = true;
    var start = gridStartDate(anchor, detectWeekStart(root));
    var tz = resolveTimeZone(root);
    var seen = Object.create(null);

    cells.forEach(function (cell, index) {
      var day = new Date(start.getTime() + index * 86400000);
      findEventChips(cell).forEach(function (chip) {
        var parsed = parseChipText(chip.textContent);
        if (!parsed) return;
        var eventStart = localToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(),
          parsed.hour, parsed.minute, tz);
        var key = parsed.title + "|" + eventStart.toISOString();
        if (seen[key]) return;
        seen[key] = true;

        var ev = EV.normalize({
          title: parsed.title,
          start: eventStart,
          end: new Date(eventStart.getTime() + 3600000), // duration unknown in the grid
          allDay: false
        }, {
          source: "dom",
          community: currentSlug(),
          communityName: currentCommunityName(),
          timezone: tz.zone || null
        });
        if (!ev) return;
        ev.confidence = 35;             // below network/JSON: no id, link or description
        ev.cancelled = parsed.cancelled;
        ev.timezone = tz.zone || tz.city || null;
        result.events.push(ev);
      });
    });

    if (!result.events.length) {
      result.warnings.push("Calendar grid found but no event chips could be read from it.");
    }
    return result;
  }

  /* ---- generic event-card pass (other Skool views) --------------------- */

  function extractFromCards(root) {
    var result = { events: [], icsUrls: discoverIcsUrls(root), ids: [], warnings: [] };

    var cards = selectCards(root);

    // De-duplicate nested anchors pointing at the same event.
    var seen = Object.create(null);
    cards.forEach(function (card) {
      var times = extractTimes(card);
      var eventId = extractEventId(card);
      var title = extractTitle(card);
      if (!title && !times.start) return;

      var key = (eventId || "") + "|" + title + "|" + (times.start ? times.start.toISOString() : "");
      if (seen[key]) return;
      seen[key] = true;

      var description = extractDescription(card);
      var locationText = extractLocation(card);
      // Prefer the link to the event's own detail page over a meeting link.
      var anchor = card.tagName === "A"
        ? card
        : (card.querySelector('a[href*="/calendar/"]') || card.querySelector('a[href]'));
      var url = null;
      if (anchor && anchor.getAttribute("href")) {
        try { url = new URL(anchor.getAttribute("href"), window.location.href).href; } catch (e) { url = null; }
      }

      var ev = EV.normalize({
        title: title,
        description: description,
        location: locationText,
        start: times.start,
        end: times.end
      }, {
        source: "dom",
        community: currentSlug(),
        eventId: eventId,
        url: url
      });
      if (ev) {
        result.events.push(ev);
        if (eventId) result.ids.push(eventId);
      }

      // A card may link straight to its .ics.
      discoverIcsUrls(card).forEach(function (u) {
        if (result.icsUrls.indexOf(u) === -1) result.icsUrls.push(u);
      });
    });

    if (!result.events.length) {
      result.warnings.push("No event cards matched the DOM selectors — Skool's markup may have changed.");
    }
    return result;
  }

  /* ---- DOM pass (grid + cards merged) ---------------------------------- */

  function extractFromDom() {
    var root = findCalendarRoot();
    var grid = extractFromGrid();
    var cards = extractFromCards(root);

    var icsUrls = grid.icsUrls.slice();
    cards.icsUrls.forEach(function (u) { if (icsUrls.indexOf(u) === -1) icsUrls.push(u); });

    var warnings = grid.warnings.slice();
    cards.warnings.forEach(function (w) {
      // Don't complain about "no cards" when we successfully read the grid.
      if (grid.detected && /No event cards matched/.test(w)) return;
      if (warnings.indexOf(w) === -1) warnings.push(w);
    });

    return {
      events: grid.events.concat(cards.events),
      icsUrls: icsUrls,
      ids: cards.ids,
      warnings: warnings,
      detectedGrid: grid.detected
    };
  }

  /* ---- embedded Next.js / JSON payloads -------------------------------- */

  /** Extract every balanced JSON object/array from a text blob. */
  function findJsonBlobs(text, budget) {
    var blobs = [];
    var remaining = budget || 4000000;
    var i = 0;
    while (i < text.length && remaining > 0) {
      var ch = text[i];
      if (ch !== "{" && ch !== "[") { i++; continue; }
      var depth = 0;
      var inString = false;
      var escaped = false;
      var start = i;
      var j = i;
      for (; j < text.length; j++) {
        var c = text[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
        } else if (c === '"') {
          inString = true;
        } else if (c === "{" || c === "[") {
          depth++;
        } else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth === 0 && j > start) {
        blobs.push(text.slice(start, j + 1));
        remaining -= (j - start);
        i = j + 1;
      } else {
        i++;
      }
    }
    return blobs;
  }

  function tryParseJson(candidate) {
    try { return JSON.parse(candidate); } catch (e) { /* try unescaping next */ }
    try {
      var unescaped = candidate.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return JSON.parse(unescaped);
    } catch (e) {
      return null;
    }
  }

  function extractFromEmbeddedJson() {
    var events = [];
    var blobs = [];

    var nextData = document.getElementById("__NEXT_DATA__");
    if (nextData && nextData.textContent) blobs.push(nextData.textContent);

    qa(document, ['script[type="application/json"]', "script"]).forEach(function (s) {
      var text = s.textContent || "";
      if (!text) return;
      // Skip our own scripts and anything clearly not data.
      if (s.dataset && s.dataset.skoolcal) return;
      if (text.indexOf("skoolcal") !== -1) return;
      if (text.length < 40) return;
      blobs.push(text);
    });

    var seen = new Set();
    blobs.forEach(function (blob) {
      findJsonBlobs(blob, 1500000).forEach(function (candidate) {
        if (candidate.length < 40) return;
        if (!/start|date|title|summary|name/i.test(candidate)) return;
        if (seen.has(candidate)) return;
        seen.add(candidate);
        var parsed = tryParseJson(candidate);
        if (!parsed) return;
        events = events.concat(EV.scavengeEvents(parsed, {
          source: "json",
          community: currentSlug(),
          communityName: currentCommunityName()
        }));
      });
    });

    return events;
  }

  /**
   * Skool tells us how many events the community has in total
   * (pageProps.numCalendarEvents). Comparing that with what we captured is a
   * cheap "did we miss a month?" signal we surface as a warning.
   */
  function extractExpectedCount() {
    try {
      var el = document.getElementById("__NEXT_DATA__");
      if (!el || !el.textContent) return null;
      var data = JSON.parse(el.textContent);
      var n = data && data.props && data.props.pageProps && data.props.pageProps.numCalendarEvents;
      return typeof n === "number" && n > 0 ? n : null;
    } catch (e) {
      return null;
    }
  }

  /* ---- intercepted network payloads ------------------------------------ */

  function extractFromCaptures(captures) {
    var events = [];
    var icsUrls = [];

    (captures || []).forEach(function (cap) {
      if (!cap || !cap.body) return;
      var url = cap.url || "";
      if (ICS_HREF.test(url) || /BEGIN:VCALENDAR/i.test(cap.body)) {
        if (ICS_HREF.test(url)) icsUrls.push(url);
        try {
          var parsed = ICS.parse(cap.body);
          parsed.events.forEach(function (e) {
            var ev = EV.fromIcs(e, {
              community: currentSlug(),
              communityName: currentCommunityName() || parsed.name,
              url: url
            });
            if (ev) events.push(ev);
          });
        } catch (e) { /* not really an ics */ }
        return;
      }
      if (/json/i.test(cap.contentType) || /^\s*[{[]/.test(cap.body)) {
        var json = tryParseJson(cap.body);
        if (json) {
          events = events.concat(EV.scavengeEvents(json, {
            source: "network",
            community: currentSlug(),
            communityName: currentCommunityName()
          }));
        }
      }
    });

    return { events: events, icsUrls: icsUrls };
  }

  /* ---- .ics fetching --------------------------------------------------- */

  function fetchIcs(url, ctx) {
    return fetch(url, {
      credentials: "include",
      headers: { Accept: "text/calendar, text/plain, */*" }
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    }).then(function (text) {
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("Not an .ics document");
      var parsed = ICS.parse(text);
      return parsed.events.map(function (e) {
        return EV.fromIcs(e, {
          community: ctx.community,
          communityName: ctx.communityName || parsed.name,
          url: ctx.pageUrl
        });
      }).filter(Boolean);
    });
  }

  /** Last resort: guess .ics URLs from known event ids. */
  function probeIcsTemplates(slug, ids, ctx, budget) {
    if (!slug || !ids.length) return Promise.resolve([]);
    var templates = CONST.SKOOL.ICS_URL_TEMPLATES;
    var attempts = 0;
    var found = [];
    var chain = Promise.resolve();

    ids.slice(0, budget || 12).forEach(function (id) {
      templates.forEach(function (tpl) {
        var path = tpl.replace("{slug}", slug).replace("{id}", id);
        chain = chain.then(function () {
          if (attempts++ > (budget || 12) * templates.length) return;
          var abs = new URL(path, location.origin).href;
          return fetchIcs(abs, ctx).then(function (events) {
            found = found.concat(events);
          }).catch(function () { /* template miss is expected */ });
        });
      });
    });
    return chain.then(function () { return found; });
  }

  /* ---- community context ----------------------------------------------- */

  function currentSlug() {
    var m = location.pathname.match(CONST.SKOOL.CALENDAR_PATH) || location.pathname.match(CONST.SKOOL.ANY_COMMUNITY_PATH);
    if (!m) return null;
    var slug = m[1];
    if (CONST.SKOOL.RESERVED_SLUGS.indexOf(slug.toLowerCase()) !== -1) return null;
    return slug;
  }

  function currentCommunityName() {
    // The header usually shows the community name; fall back to the slug.
    var el = q(document, [
      '[data-testid="community-name"]',
      '[class*="community-name" i]',
      'header h1', "h1"
    ]);
    var name = textOf(el);
    return name && name.length < 120 ? name : null;
  }

  /* ---- orchestration --------------------------------------------------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * Run every extraction source and merge the results.
   * @param {object} opts { fetchIcs, captureNetwork, community, communityName, onStatus }
   */
  function collect(opts) {
    opts = opts || {};
    var slug = opts.community || currentSlug();
    var communityName = opts.communityName || currentCommunityName();
    var ctx = { community: slug, communityName: communityName, pageUrl: location.href };
    var warnings = [];
    var stats = { dom: 0, json: 0, network: 0, ics: 0, fetched: 0, failed: 0 };
    var partial = false;

    function status(phase, message, progress) {
      if (opts.onStatus) opts.onStatus({ phase: phase, message: message, progress: progress });
    }

    status("dom", "Scanning page…");
    var dom = extractFromDom();
    stats.dom = dom.events.length;
    warnings = warnings.concat(dom.warnings);

    status("json", "Reading embedded data…");
    var jsonEvents = extractFromEmbeddedJson();
    stats.json = jsonEvents.length;

    var captured = { events: [], icsUrls: [] };
    if (opts.captureNetwork !== false && SC.capture) {
      status("network", "Reading intercepted calendar requests…");
      captured = extractFromCaptures(SC.capture.getCaptures());
      stats.network = captured.events.length;
    }

    // Candidate .ics URLs, in order of trust: captured network > DOM > discovered.
    var icsUrls = [];
    function pushUrl(u) { if (u && icsUrls.indexOf(u) === -1) icsUrls.push(u); }
    captured.icsUrls.forEach(pushUrl);
    (SC.capture ? SC.capture.getIcsUrls() : []).forEach(pushUrl);
    dom.icsUrls.forEach(pushUrl);

    var icsEvents = [];

    var work = Promise.resolve();
    if (opts.fetchIcs !== false && icsUrls.length) {
      status("ics", "Fetching " + icsUrls.length + " event file" + (icsUrls.length === 1 ? "" : "s") + "…");
      var limit = Math.min(icsUrls.length, 80);
      icsUrls.slice(0, limit).forEach(function (url, index) {
        work = work.then(function () {
          return fetchIcs(url, ctx).then(function (events) {
            icsEvents = icsEvents.concat(events);
            stats.fetched++;
            if (index % 5 === 0) status("ics", "Fetched " + stats.fetched + " of " + limit + " event files…", { done: stats.fetched, total: limit });
          }).catch(function () {
            stats.failed++;
          });
        });
      });
      if (icsUrls.length > limit) { partial = true; warnings.push("Only the first " + limit + " .ics files were fetched."); }
    } else if (opts.fetchIcs !== false) {
      // No .ics links found — try to reconstruct them from event ids.
      var ids = dom.ids.concat(icsEvents.map(function (e) { return e.eventId; })).filter(Boolean);
      var uniqueIds = ids.filter(function (v, i) { return ids.indexOf(v) === i; });
      if (uniqueIds.length) {
        status("probe", "Looking for downloadable event files…");
        work = work.then(function () {
          return probeIcsTemplates(slug, uniqueIds, ctx, 8).then(function (events) {
            icsEvents = icsEvents.concat(events);
            stats.fetched += events.length ? 1 : 0;
          });
        });
      }
    }

    return work.then(function () {
      status("merge", "Merging results…");
      stats.ics = icsEvents.length;

      // .ics data is authoritative; fold DOM/JSON/network into it.
      // NOTE: key on UID, never eventId — every occurrence of a recurring
      // series shares the same event id and only the UID is unique.
      var merged = icsEvents.slice();
      var byUid = Object.create(null);
      merged.forEach(function (ev) { if (ev.uid) byUid[ev.uid] = ev; });

      function sameUtcDay(a, b) {
        return a.getUTCFullYear() === b.getUTCFullYear() &&
          a.getUTCMonth() === b.getUTCMonth() &&
          a.getUTCDate() === b.getUTCDate();
      }

      function absorb(list, fuzzy) {
        list.forEach(function (ev) {
          if (ev.uid && byUid[ev.uid]) {
            var i = merged.indexOf(byUid[ev.uid]);
            if (i !== -1) {
              var combined = EV.mergeEvent(merged[i], ev);
              merged[i] = combined;
              byUid[ev.uid] = combined;
              return;
            }
          }
          // Fall back to title matching. `fuzzy` (used for DOM events, whose
          // wall-clock times come from the account timezone) accepts the same
          // calendar day, which tolerates timezone/DST rounding.
          var match = merged.filter(function (m) {
            if (m.title !== ev.title || !m.start || !ev.start) return false;
            if (Math.abs(m.start - ev.start) < 60000) return true;
            return fuzzy && sameUtcDay(m.start, ev.start);
          })[0];
          if (match) {
            var j = merged.indexOf(match);
            var mergedEvent = EV.mergeEvent(match, ev);
            merged[j] = mergedEvent;
            if (mergedEvent.uid) byUid[mergedEvent.uid] = mergedEvent;
          } else {
            merged.push(ev);
            if (ev.uid) byUid[ev.uid] = ev;
          }
        });
      }

      absorb(dom.events, true);
      absorb(jsonEvents, false);
      absorb(captured.events, false);

      var events = EV.dedupe(merged).filter(function (ev) { return !!ev.start; });
      events.sort(function (a, b) { return a.start - b.start; });

      var expected = extractExpectedCount();
      if (expected && events.length < expected) {
        warnings.push("Skool reports " + expected + " events; " + events.length +
          " are loaded now. Pick a wider date preset (e.g. This year) — those months load when you export.");
      }
      if (!events.length) {
        warnings.push("No events found. Make sure you are on the community's Calendar tab, are logged in, and that the calendar isn't empty.");
      }
      if (stats.failed) warnings.push(stats.failed + " event file(s) could not be fetched; those events may be incomplete.");

      status("done", events.length + " event" + (events.length === 1 ? "" : "s") + " found.");
      return {
        events: events,
        partial: partial,
        warnings: warnings,
        stats: stats,
        community: { slug: slug, name: communityName || slug }
      };
    });
  }

  SC.extract = {
    SELECTORS: SELECTORS,
    TIME_SELECTORS: TIME_SELECTORS,
    collect: collect,
    extractFromDom: extractFromDom,
    extractFromGrid: extractFromGrid,
    extractFromCards: extractFromCards,
    extractFromEmbeddedJson: extractFromEmbeddedJson,
    extractFromCaptures: extractFromCaptures,
    extractExpectedCount: extractExpectedCount,
    discoverIcsUrls: discoverIcsUrls,
    fetchIcs: fetchIcs,
    findJsonBlobs: findJsonBlobs,
    selectCards: selectCards,
    isCardCandidate: isCardCandidate,
    // grid helpers (exported for tests)
    findMonthLabel: findMonthLabel,
    parseMonthLabel: parseMonthLabel,
    findDayCells: findDayCells,
    findEventChips: findEventChips,
    parseChipText: parseChipText,
    detectWeekStart: detectWeekStart,
    gridStartDate: gridStartDate,
    resolveTimeZone: resolveTimeZone,
    localToUtc: localToUtc,
    normalizeOffset: normalizeOffset,
    currentSlug: currentSlug,
    currentCommunityName: currentCommunityName,
    findCalendarRoot: findCalendarRoot,
    sleep: sleep
  };
})();
