/*
 * content/content.js — the orchestrator that lives on skool.com.
 *
 * Flow:
 *   page loads / SPA route changes to a calendar
 *     -> (optional) click through N months, snapshotting the DOM each step
 *     -> collect() merges .ics + network + embedded JSON + DOM sources
 *     -> report progress and the final event list to the background
 *
 * The popup talks to this script only via the background (RUN_EXTRACTION) and
 * reads the cached results from storage, so the popup never has to be open
 * while extraction runs.
 */
(function () {
  "use strict";
  var g = globalThis;
  var SC = (g.SkoolCal = g.SkoolCal || {});
  var CONST = SC.CONST;
  var MSG = CONST.MSG;
  var EV = SC.events;

  var state = {
    running: null,
    lastRunAt: 0,
    lastUrl: location.href,
    domSnapshot: []
  };

  var CALENDAR_RE = CONST.SKOOL.CALENDAR_PATH;

  function isCalendarPage() {
    return CALENDAR_RE.test(location.pathname) || /[?&]view=calendar/i.test(location.search);
  }

  function report(phase, message, progress, slug) {
    SC.msg.sendToBackground(MSG.EXTRACTION_STATUS, {
      phase: phase,
      message: message,
      progress: progress || null,
      community: { slug: slug || SC.extract.currentSlug(), name: SC.extract.currentCommunityName() }
    });

    // Mirror progress onto the page so the user can see what is happening
    // while a scan runs (the popup is small and may not be the focus).
    if (SC.overlay && SC.overlay.isVisible()) {
      if (phase === "error") {
        SC.overlay.update({ state: "error", detail: message, progress: null });
        SC.overlay.hide(6000);
      } else if (phase === "done") {
        SC.overlay.update({ state: "done", title: "Scan complete", detail: message, progress: null });
        SC.overlay.hide(3000);
      } else {
        SC.overlay.update({ state: "busy", detail: message, progress: progress || null });
      }
    }
  }

  /** Heuristic: is the page gating us behind login / paywall / empty state? */
  function detectBlocked() {
    var text = (document.body && document.body.innerText || "").toLowerCase();
    if (/\b(log in|sign in|join this community|request to join|members only|upgrade to)\b/.test(text) && text.length < 4000) {
      return "You may need to log in or join this community to see its calendar.";
    }
    return null;
  }

  function runExtraction(reason) {
    if (state.running) return state.running;
    if (!isCalendarPage()) {
      return Promise.resolve({ ok: false, error: "Not on a Skool calendar page." });
    }

    var slug = SC.extract.currentSlug();
    if (!slug) {
      report("error", "Could not identify the community from the URL.", null, null);
      return Promise.resolve({ ok: false, error: "Unknown community." });
    }

    state.running = SC.msg.sendToBackground(MSG.GET_SETTINGS).then(function (res) {
      var settings = (res && res.data) || CONST.DEFAULT_SETTINGS;
      var communityName = SC.extract.currentCommunityName();
      state.domSnapshot = [];

      // Only surface the on-page overlay for user-initiated scans; the
      // automatic scan on page load stays quiet.
      if (reason === "manual" && SC.overlay) {
        SC.overlay.show({ title: "Scanning calendar", detail: "Looking for events…" });
      }

      report("start", "Looking for events…", null, slug);

      // Paging happens ONLY for a user-initiated scan (i.e. export/sync).
      //
      // The automatic scan on page load deliberately stays on the visible
      // month: browsing the calendar should cost zero extra requests. A single
      // deliberate export then does one bounded scan that pages as far as the
      // chosen preset needs — instead of firing a burst of requests every time
      // a date chip is clicked (which is also friendlier to Skool's bot
      // detection).
      var range = SC.daterange.resolveRange(settings, new Date());
      var until = range.to;
      var maxMonths = settings.autoLoadMonths || 0;
      var expandPromise = Promise.resolve({ clicks: 0 });

      if (reason === "manual" && until && maxMonths > 0 && SC.daterange.needsPaging(range, new Date())) {
        report("expand", "Loading months ahead…", null, slug);
        expandPromise = SC.monthNav.expand({
          until: until,
          maxMonths: maxMonths,
          onStep: function (clicks) {
            // Snapshot the DOM before the month is unmounted.
            try {
              var dom = SC.extract.extractFromDom();
              state.domSnapshot = state.domSnapshot.concat(dom.events);
            } catch (e) { /* keep paging */ }
            report("expand", "Loaded month " + clicks + "…", null, slug);
          }
        }).catch(function () { return { clicks: 0 }; });
      }

      return expandPromise.then(function () {
        // Make sure the hook has flushed its buffer before we read captures.
        if (SC.capture) SC.capture.request();
        return SC.extract.collect({
          fetchIcs: settings.fetchIcs !== false,
          captureNetwork: settings.captureNetwork !== false,
          community: slug,
          communityName: communityName,
          onStatus: function (s) { report(s.phase, s.message, s.progress, slug); }
        });
      }).then(function (result) {
        // Fold in events snapshotted from months that are no longer rendered.
        if (state.domSnapshot.length) {
          result.events = EV.dedupe(result.events.concat(state.domSnapshot))
            .filter(function (e) { return !!e.start; })
            .sort(function (a, b) { return a.start - b.start; });
        }

        var blocked = detectBlocked();
        if (blocked && !result.events.length) result.warnings.push(blocked);

        return SC.msg.sendToBackground(MSG.EVENTS_FOUND, {
          community: result.community,
          events: result.events.map(SC.storage.serializeEvent),
          partial: result.partial,
          warnings: result.warnings
        }).then(function () {
          state.lastRunAt = Date.now();
          return {
            ok: true,
            count: result.events.length,
            warnings: result.warnings,
            stats: result.stats,
            community: result.community
          };
        });
      });
    }).catch(function (err) {
      report("error", (err && err.message) || "Extraction failed.", null, slug);
      return { ok: false, error: (err && err.message) || String(err) };
    }).then(function (result) {
      state.running = null;
      return result;
    });

    return state.running;
  }

  /* ---- SPA route watching ---------------------------------------------- */

  function watchNavigation() {
    var last = location.href;
    function check() {
      if (location.href === last) return;
      last = location.href;
      state.lastUrl = last;
      if (!isCalendarPage()) return;
      scheduleRun("navigation", 700);
    }
    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    // pushState/replaceState can't be observed from the isolated world, so poll.
    setInterval(check, 800);
  }

  var runTimer = null;
  function scheduleRun(reason, delay) {
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(function () {
      runTimer = null;
      runExtraction(reason);
    }, delay || 400);
  }

  /* ---- boot ------------------------------------------------------------ */

  function boot() {
    if (SC.capture) SC.capture.init();

    SC.msg.onRequest(function (type, payload) {
      if (type === MSG.RUN_EXTRACTION) return runExtraction("manual");
      if (type === MSG.PING) return { alive: true, calendar: isCalendarPage() };
      if (type === MSG.OVERLAY_NOTICE) {
        if (SC.overlay) {
          SC.overlay.update({
            title: payload.title || "SkoolCal Sync",
            detail: payload.detail || "",
            state: payload.state || "done",
            progress: null
          });
          SC.overlay.hide(payload.hideAfter || 3500);
        }
        return { shown: true };
      }
      return undefined;
    });

    watchNavigation();

    if (!isCalendarPage()) return;

    SC.msg.sendToBackground(MSG.GET_SETTINGS).then(function (res) {
      var settings = (res && res.data) || CONST.DEFAULT_SETTINGS;
      if (settings.autoExtract !== false) {
        // Wait for the calendar to render, then run.
        scheduleRun("auto", 1400);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
