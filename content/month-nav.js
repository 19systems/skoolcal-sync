/*
 * content/month-nav.js — paging through the calendar.
 *
 * IMPORTANT BEHAVIOUR: the extension NEVER pages on its own. It stays on the
 * month that is currently on screen unless the popup's date preset reaches a
 * later month (e.g. "This year"), in which case it clicks forward until that
 * month is reached (or a hard cap is hit). This keeps a single scan to a
 * bounded number of clicks.
 */
(function () {
  "use strict";
  var g = globalThis;
  var SC = (g.SkoolCal = g.SkoolCal || {});
  var SELECTORS = SC.extract.SELECTORS;
  var sleep = SC.extract.sleep;

  function q(root, list) {
    for (var i = 0; i < list.length; i++) {
      try {
        var el = root.querySelector(list[i]);
        if (el) return el;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.getAttribute("data-disabled") === "true") return true;
    var cls = el.className || "";
    if (typeof cls === "string" && /(^|\s)(disabled|is-disabled|pointer-events-none)(\s|$)/i.test(cls)) return true;
    return false;
  }

  /** Wait until the DOM changes or the timeout elapses. */
  function waitForChange(root, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        try { observer.disconnect(); } catch (e) {}
        clearTimeout(timer);
        resolve();
      };
      var observer = new MutationObserver(finish);
      try {
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      } catch (e) { /* observe can fail on detached roots */ }
      var timer = setTimeout(finish, timeoutMs || 1200);
    });
  }

  function visibleMonth(root) {
    return SC.extract.parseMonthLabel(SC.extract.findMonthLabel(root));
  }

  function monthIndex(m) { return m.year * 12 + m.month; }

  /**
   * Click forward from the visible month to `until` (inclusive), at most
   * `maxMonths` times. Does nothing at all when `until` is absent.
   *
   * @param {object} opts { until: Date|null, maxMonths: number, onStep(clicks), root, timeout }
   * @returns {Promise<{clicks:number, exhausted:boolean, reason?:string}>}
   */
  function expand(opts) {
    opts = opts || {};
    var root = opts.root || SC.extract.findCalendarRoot();
    var timeout = opts.timeout || 1200;
    var maxMonths = Math.max(0, Math.min(opts.maxMonths || 0, 24));
    var target = opts.until
      ? { year: opts.until.getFullYear(), month: opts.until.getMonth() }
      : null;
    var clicks = 0;
    var exhausted = false;

    if (!target || maxMonths <= 0) {
      return Promise.resolve({ clicks: 0, exhausted: false, reason: "current-month-only" });
    }

    function step() {
      if (clicks >= maxMonths) { exhausted = true; return Promise.resolve(); }

      var here = visibleMonth(root);
      if (!here) { exhausted = true; return Promise.resolve({ reason: "month-label-unreadable" }); }
      if (monthIndex(here) >= monthIndex(target)) return Promise.resolve(); // already there

      var next = q(document, SELECTORS.nextMonth);
      if (!next || isDisabled(next)) {
        var more = q(document, SELECTORS.loadMore);
        if (!more || isDisabled(more)) { exhausted = true; return Promise.resolve(); }
        next = more;
      }

      try {
        next.click();
      } catch (e) {
        exhausted = true;
        return Promise.resolve();
      }
      clicks++;

      return waitForChange(root, timeout).then(function () {
        // Give late XHRs a moment to land, then snapshot.
        return sleep(350);
      }).then(function () {
        if (opts.onStep) {
          try { opts.onStep(clicks); } catch (e) { /* keep paging */ }
        }
        var after = visibleMonth(root);
        // If the label didn't move, stop — otherwise we'd loop forever.
        if (!after || (after.year === here.year && after.month === here.month)) {
          exhausted = true;
          return;
        }
        return step();
      });
    }

    return step().then(function (r) {
      return Object.assign({ clicks: clicks, exhausted: exhausted }, r || {});
    });
  }

  SC.monthNav = {
    expand: expand,
    visibleMonth: visibleMonth,
    isDisabled: isDisabled,
    waitForChange: waitForChange
  };
})();
