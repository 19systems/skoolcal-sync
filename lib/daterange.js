/*
 * lib/daterange.js — named date-range presets.
 *
 * Shared by the popup (to filter the list) and the content script (to decide
 * how far to page). Ranges are computed in LOCAL time, which is what a user
 * means by "this week"; event start times are absolute so comparisons are
 * still correct.
 *
 * Weeks are Monday-first to match Skool's calendar grid.
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};

  var PRESETS = [
    { id: "today", label: "Today" },
    { id: "week", label: "This week" },
    { id: "month", label: "This month" },
    { id: "next30", label: "Next 30 days" },
    { id: "year", label: "This year" },
    { id: "tillYearEnd", label: "Till year end" },
    { id: "all", label: "All time" }
  ];

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }

  function endOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  }

  function startOfWeek(d) {
    var day = d.getDay();          // 0 = Sunday … 6 = Saturday
    var sinceMonday = (day + 6) % 7;
    var s = startOfDay(d);
    s.setDate(s.getDate() - sinceMonday);
    return s;
  }

  function endOfWeek(d) {
    var e = startOfWeek(d);
    e.setDate(e.getDate() + 6);
    return endOfDay(e);
  }

  function addDays(d, n) {
    var out = new Date(d.getTime());
    out.setDate(out.getDate() + n);
    return out;
  }

  /** Resolve a preset id to { from: Date|null, to: Date|null }. */
  function resolve(presetId, now) {
    now = now || new Date();
    var y = now.getFullYear();
    var m = now.getMonth();
    switch (presetId) {
      case "today":
        return { from: startOfDay(now), to: endOfDay(now) };
      case "week":
        return { from: startOfWeek(now), to: endOfWeek(now) };
      case "month":
        return { from: new Date(y, m, 1, 0, 0, 0, 0), to: endOfDay(new Date(y, m + 1, 0)) };
      case "next30":
        return { from: startOfDay(now), to: endOfDay(addDays(now, 30)) };
      case "year":
        return { from: new Date(y, 0, 1, 0, 0, 0, 0), to: endOfDay(new Date(y, 11, 31)) };
      case "tillYearEnd":
        return { from: startOfDay(now), to: endOfDay(new Date(y, 11, 31)) };
      case "all":
      default:
        return { from: null, to: null };
    }
  }

  /**
   * Resolve the range for a settings object. Falls back to "month" so the
   * default behaviour is the visible month with no paging.
   */
  function resolveRange(settings, now) {
    var preset = (settings && settings.datePreset) || "month";
    return resolve(preset, now);
  }

  /** True when reaching `to` requires paging to a later month than `now`. */
  function needsPaging(range, now) {
    if (!range || !range.to) return false;
    now = now || new Date();
    if (range.to.getFullYear() > now.getFullYear()) return true;
    return range.to.getFullYear() === now.getFullYear() && range.to.getMonth() > now.getMonth();
  }

  g.SkoolCal.daterange = {
    PRESETS: PRESETS,
    resolve: resolve,
    resolveRange: resolveRange,
    needsPaging: needsPaging,
    startOfDay: startOfDay,
    endOfDay: endOfDay,
    startOfWeek: startOfWeek,
    endOfWeek: endOfWeek
  };
})();
