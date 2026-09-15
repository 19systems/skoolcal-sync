/*
 * background/notifications.js — optional "upcoming event" reminders.
 *
 * A single repeating alarm wakes the service worker every 5 minutes. We look
 * at the locally cached events, find any starting inside the user's lead time,
 * and raise one notification per event (tracked so it never fires twice).
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};
  var CONST = g.SkoolCal.CONST;
  var storage = g.SkoolCal.storage;
  var browser = g.SkoolCal.browser;
  var dt = g.SkoolCal.dt;

  var CHECK_PERIOD_MIN = 5;
  var LOOKAHEAD_MIN = 60; // never consider events more than an hour out

  function getNotified() {
    return browser.storage.local.get(CONST.KEYS.NOTIFIED).then(function (res) {
      return (res && res[CONST.KEYS.NOTIFIED]) || {};
    });
  }

  function setNotified(map) {
    var write = {}; write[CONST.KEYS.NOTIFIED] = map;
    return browser.storage.local.set(write);
  }

  /** Create or remove the repeating alarm based on the current setting. */
  function ensureAlarm(settings) {
    if (settings && settings.notificationsEnabled) {
      browser.alarms.create(CONST.ALARM_REMINDER, { periodInMinutes: CHECK_PERIOD_MIN });
    } else {
      browser.alarms.clear(CONST.ALARM_REMINDER);
    }
  }

  function checkAndNotify() {
    return storage.getSettings().then(function (settings) {
      if (!settings.notificationsEnabled) return { shown: 0 };
      var lead = Math.max(1, settings.notifyBeforeMin || 10);
      var now = Date.now();
      var windowEnd = now + Math.min(lead, LOOKAHEAD_MIN) * 60000;

      return storage.getIndex().then(function (index) {
        var slugs = Object.keys(index || {});
        return Promise.all(slugs.map(function (slug) { return storage.getEvents(slug); }));
      }).then(function (records) {
        var candidates = [];
        (records || []).filter(Boolean).forEach(function (record) {
          (record.events || []).forEach(function (ev) {
            if (!ev.start) return;
            var t = ev.start.getTime();
            if (t >= now && t <= windowEnd) candidates.push(ev);
          });
        });
        if (!candidates.length) return { shown: 0 };

        return getNotified().then(function (notified) {
          var shown = 0;
          var chain = Promise.resolve();
          candidates.forEach(function (ev) {
            var key = ev.uid || (ev.title + "|" + ev.start.toISOString());
            if (notified[key]) return;
            notified[key] = new Date().toISOString();
            shown++;
            var when = dt.formatRange(ev.start, ev.end);
            chain = chain.then(function () {
              return browser.notifications.create("sc:evt:" + g.SkoolCal.events.hash32(key), {
                type: "basic",
                iconUrl: browser.runtime.getURL("icons/icon128.png"),
                title: "Starting soon: " + (ev.title || "Skool event"),
                message: when + (ev.communityName ? " • " + ev.communityName : ""),
                contextMessage: ev.meetingProvider ? ev.meetingProvider : "SkoolCal Sync",
                priority: 1
              });
            });
          });
          return chain.then(function () {
            // Prune entries older than 7 days so the map never grows unbounded.
            var cutoff = Date.now() - 7 * 86400000;
            Object.keys(notified).forEach(function (k) {
              var d = new Date(notified[k]).getTime();
              if (isNaN(d) || d < cutoff) delete notified[k];
            });
            return setNotified(notified).then(function () { return { shown: shown }; });
          });
        });
      });
    });
  }

  /** Manual test notification from the options page. */
  function test() {
    return browser.notifications.create("sc:test", {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon128.png"),
      title: "SkoolCal Sync",
      message: "Notifications are working. You'll be reminded before events start."
    });
  }

  g.SkoolCal.notifications = {
    ensureAlarm: ensureAlarm,
    checkAndNotify: checkAndNotify,
    test: test,
    CHECK_PERIOD_MIN: CHECK_PERIOD_MIN
  };
})();
