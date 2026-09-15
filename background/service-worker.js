/*
 * background/service-worker.js — message router and orchestration.
 *
 * Runs as a Chrome MV3 service worker (classic, so it can importScripts the
 * shared lib files) and as a Firefox MV3 background script (the manifest lists
 * the same files in order, so importScripts is skipped there).
 */
"use strict";

/* Chrome: pull in the shared classic scripts. Firefox: already loaded via the
   manifest's background.scripts array, so importScripts is undefined. */
if (typeof importScripts === "function") {
  importScripts(
    "/lib/browser.js",
    "/lib/constants.js",
    "/lib/datetime.js",
    "/lib/ics.js",
    "/lib/events.js",
    "/lib/storage.js",
    "/lib/messaging.js",
    "/background/google.js",
    "/background/notifications.js"
  );
}

(function () {
  var g = globalThis;
  var SC = g.SkoolCal;
  var CONST = SC.CONST;
  var MSG = CONST.MSG;
  var K = CONST.KEYS;
  var browser = SC.browser;
  var storage = SC.storage;
  var msg = SC.msg;
  var dt = SC.dt;
  var ICS = SC.ICS;
  var EV = SC.events;

  /* ---- helpers --------------------------------------------------------- */

  function rehydrate(list) {
    return (list || []).map(storage.deserializeEvent).filter(Boolean);
  }

  function sessionGet(key) {
    var area = (browser.storage.session || browser.storage.local);
    return area.get(key).then(function (res) { return res && res[key]; });
  }

  function sessionSet(key, value) {
    var area = (browser.storage.session || browser.storage.local);
    var write = {}; write[key] = value;
    return area.set(write);
  }

  /*
   * Downloads are performed by the POPUP, not here.
   *
   * Firefox's downloads.download rejects data: URLs ("Access denied for URL
   * data:...") and a Chrome MV3 service worker has no Blob/object URLs, so
   * neither context can create a file reliably. The popup has a DOM, so it
   * turns the text we return into a Blob + object URL and clicks an <a download>.
   * That works identically in both browsers and needs no downloads permission.
   */
  function eventFilename(ev) {
    var date = ev.start ? dt.toInputDate(ev.start) : "event";
    return EV.slugify(ev.title, 80) + "-" + date + ".ics";
  }

  function updateBadge(count) {
    try {
      browser.action.setBadgeBackgroundColor({ color: "#2563eb" });
      browser.action.setBadgeText({ text: count ? String(count) : "" });
    } catch (e) { /* badge is cosmetic */ }
  }

  /* ---- request handlers ------------------------------------------------ */

  var handlers = {};

  handlers[MSG.GET_STATE] = function () {
    return Promise.all([
      storage.getSettings(),
      storage.getCommunities(),
      storage.getIndex(),
      SC.google.authStatus(),
      sessionGet(K.SYNC_PROGRESS)
    ]).then(function (r) {
      return {
        settings: r[0],
        communities: r[1],
        index: r[2],
        auth: r[3],
        syncProgress: r[4] || null,
        version: browser.runtime.getManifest().version
      };
    });
  };

  handlers[MSG.GET_SETTINGS] = function () { return storage.getSettings(); };

  handlers[MSG.SET_SETTINGS] = function (payload) {
    return storage.setSettings(payload.patch || payload).then(function (settings) {
      SC.notifications.ensureAlarm(settings);
      return settings;
    });
  };

  handlers[MSG.GET_EVENTS] = function (payload) {
    return storage.getEvents(payload.slug);
  };

  handlers[MSG.GET_STATUS] = function (payload) {
    if (!payload.slug) return null;
    return sessionGet(K.STATUS_PREFIX + payload.slug);
  };

  handlers[MSG.EVENTS_FOUND] = function (payload, sender) {
    var community = payload.community || {};
    var slug = community.slug;
    if (!slug) return msg.fail("No community slug supplied.");

    return storage.getSettings().then(function (settings) {
      var events = EV.dedupe(rehydrate(payload.events));
      if (settings.collapseSeries) events = EV.collapseSeries(events);
      events.sort(function (a, b) { return a.start - b.start; });

      return storage.saveEvents(slug, {
        name: community.name || slug,
        events: events,
        partial: !!payload.partial,
        warnings: payload.warnings || []
      }).then(function (record) {
        // Track the community (subject to the free-tier limit). Caching always
        // succeeds; only the managed list is limited.
        return storage.addCommunity({ slug: slug, name: community.name || slug }).then(function () {
          updateBadge(record.events.length);
          return SC.notifications.ensureAlarm(settings).then(function () {
            return { slug: slug, count: record.events.length, warnings: record.warnings };
          });
        });
      });
    });
  };

  handlers[MSG.EXTRACTION_STATUS] = function (payload, sender) {
    var slug = payload.community && payload.community.slug;
    if (!slug) return msg.ok();
    var key = K.STATUS_PREFIX + slug;
    return sessionSet(key, {
      slug: slug,
      phase: payload.phase,
      message: payload.message,
      progress: payload.progress || null,
      at: Date.now()
    }).then(function () { return msg.ok(); });
  };

  handlers[MSG.EXTRACT_NOW] = function () {
    return browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) throw new Error("No active tab.");
      if (!/^https:\/\/([a-z0-9-]+\.)?skool\.com\//i.test(tab.url || "")) {
        throw new Error("Open a Skool community calendar page first.");
      }
      return msg.sendToTab(tab.id, MSG.RUN_EXTRACTION, { reason: "manual" });
    });
  };

  /** Relay a short status message to the on-page overlay. */
  handlers[MSG.OVERLAY_NOTICE] = function (payload) {
    return browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !/^https:\/\/([a-z0-9-]+\.)?skool\.com\//i.test(tab.url || "")) return { shown: false };
      return msg.sendToTab(tab.id, MSG.OVERLAY_NOTICE, payload);
    });
  };

  handlers[MSG.EXPORT_MERGED_ICS] = function (payload) {
    var events = rehydrate(payload.events);
    if (!events.length) return msg.fail("No events selected.");
    var name = payload.calendarName || (payload.community && payload.community.name) || "Skool Calendar";
    var text = ICS.build(events, { name: name, timezone: payload.timezone || dt.localTimeZone() });
    var filename = "skoolcal-" + EV.slugify(name, 40) + "-" + dt.toInputDate(new Date()) + ".ics";
    // Returned to the popup, which performs the actual download.
    return { filename: filename, text: text, count: events.length, bytes: text.length };
  };

  handlers[MSG.EXPORT_INDIVIDUAL_ICS] = function (payload) {
    var events = rehydrate(payload.events);
    if (!events.length) return msg.fail("No events selected.");
    var tz = payload.timezone || dt.localTimeZone();
    var used = Object.create(null);
    var files = [];

    events.forEach(function (ev) {
      var filename = eventFilename(ev);
      if (used[filename]) filename = filename.replace(/\.ics$/, " (" + (++used[filename]) + ").ics");
      else used[filename] = 1;
      files.push({ filename: filename, text: ICS.buildOne(ev, { name: ev.communityName || "Skool", timezone: tz }) });
    });

    return { files: files, count: files.length };
  };

  handlers[MSG.COPY_GOOGLE_LINKS] = function (payload) {
    var events = rehydrate(payload.events);
    return { links: events.map(function (ev) {
      return { title: ev.title, start: ev.start ? ev.start.toISOString() : null, link: EV.googleTemplateLink(ev) };
    }) };
  };

  handlers[MSG.SYNC_GOOGLE] = function (payload) {
    var events = rehydrate(payload.events);
    if (!events.length) return msg.fail("No events selected.");

    return storage.getSettings().then(function (settings) {
      var progress = { total: events.length, done: 0, inserted: 0, duplicate: 0, failed: 0, current: null, startedAt: Date.now(), finishedAt: null };
      return sessionSet(K.SYNC_PROGRESS, progress).then(function () {
        return SC.google.syncEvents(events, {
          calendarId: settings.googleCalendarId || "primary",
          timezone: payload.timezone || dt.localTimeZone(),
          syncReminders: settings.syncReminders
        }, function (done, total, ev, result) {
          progress.done = done;
          progress.current = ev ? ev.title : null;
          if (result && result.status === "inserted") progress.inserted++;
          else if (result && result.status === "duplicate") progress.duplicate++;
          else if (result && result.status === "error") progress.failed++;
          sessionSet(K.SYNC_PROGRESS, progress);
        });
      }).then(function (results) {
        progress.finishedAt = Date.now();
        progress.results = results;
        return sessionSet(K.SYNC_PROGRESS, progress).then(function () { return results; });
      });
    });
  };

  handlers[MSG.GOOGLE_AUTH] = function () { return SC.google.connect(); };
  handlers[MSG.GOOGLE_AUTH_STATUS] = function () { return SC.google.authStatus(); };
  handlers[MSG.GOOGLE_SIGNOUT] = function () { return SC.google.signOut(); };

  handlers[MSG.ADD_COMMUNITY] = function (payload) { return storage.addCommunity(payload); };

  handlers[MSG.REMOVE_COMMUNITY] = function (payload) { return storage.removeCommunity(payload.slug); };

  handlers[MSG.SET_TIER] = function (payload) {
    // NOTE: this is a local stub. A production build must verify the licence
    // against a server (or the Chrome/Firefox in-app purchase API) before
    // trusting `payload.licenseKey`. See README > Monetisation.
    var key = (payload.licenseKey || "").trim();
    if (payload.tier === CONST.TIER.PRO && key.length < 8) {
      return msg.fail("Enter a valid licence key (at least 8 characters).");
    }
    return storage.setSettings({ tier: payload.tier }).then(function (settings) {
      if (payload.tier !== CONST.TIER.PRO) return { settings: settings, downgraded: true };
      return { settings: settings };
    });
  };

  handlers[MSG.CLEAR_EVENTS] = function (payload) {
    return storage.clearEvents(payload.slug).then(function () { updateBadge(0); return { cleared: true }; });
  };

  handlers[MSG.OPEN_OPTIONS] = function () {
    return browser.runtime.openOptionsPage().then(function () { return { opened: true }; });
  };

  handlers[MSG.TEST_NOTIFICATION] = function () { return SC.notifications.test(); };

  /* ---- wiring ---------------------------------------------------------- */

  msg.onRequest(function (type, payload, sender) {
    var handler = handlers[type];
    if (!handler) return msg.fail("Unknown message type: " + type);
    return handler(payload, sender);
  });

  browser.runtime.onInstalled(function (details) {
    storage.getSettings().then(function (settings) {
      SC.notifications.ensureAlarm(settings);
      if (details && details.reason === "install") {
        browser.runtime.openOptionsPage();
      }
    });
  });

  browser.runtime.onStartup(function () {
    storage.getSettings().then(function (settings) { SC.notifications.ensureAlarm(settings); });
  });

  browser.alarms.onAlarm(function (alarm) {
    if (alarm && alarm.name === CONST.ALARM_REMINDER) SC.notifications.checkAndNotify();
  });

  browser.notifications.onClicked(function (id) {
    if (!id || id.indexOf("sc:evt:") !== 0) return;
    // Best effort: open the options page where the event list lives.
    browser.runtime.openOptionsPage();
  });
})();
