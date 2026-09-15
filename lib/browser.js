/*
 * lib/browser.js — Cross-browser WebExtensions shim.
 *
 * Loaded as a CLASSIC script in every context (content scripts, popup, options,
 * background service worker / Firefox event page). It normalises the
 * `chrome.*` (callback) and `browser.*` (promise) APIs behind a single
 * promise-based surface so the rest of the code never branches on browser.
 *
 * NOTE: this file must stay dependency-free and must not use import/export,
 * because content scripts and classic service workers cannot use ES modules.
 */
(function () {
  "use strict";

  var g = globalThis;
  var existing = g.SkoolCal && g.SkoolCal.browser;
  if (existing) return; // already initialised in this context

  // Prefer `browser` (Firefox, and Chrome 121+ exposes it too). Fall back to
  // `chrome`, which is available in every Chromium browser.
  var api = (g.browser && g.browser.runtime) ? g.browser : g.chrome;
  if (!api) throw new Error("SkoolCal: no WebExtensions API found in this context");

  var isFirefox = !!(g.browser && g.browser.runtime) &&
    typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent || "");

  /** Promise wrapper around any callback-style API call. */
  function call(fn, thisArg, args) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var maybePromise;
      try {
        maybePromise = fn.apply(thisArg, (args || []).concat([function (result) {
          if (settled) return;
          settled = true;
          // Read lastError synchronously inside the callback, as required.
          var err = api.runtime && api.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve(result);
        }]));
      } catch (e) {
        if (!settled) { settled = true; reject(e); }
        return;
      }
      // Firefox's `browser.*` ignores the extra callback and returns a promise.
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(function (v) { if (!settled) { settled = true; resolve(v); } },
          function (e) { if (!settled) { settled = true; reject(e); } });
      }
    });
  }

  function area(name) {
    var store = api.storage && api.storage[name];
    if (!store) return null;
    return {
      get: function (keys) { return call(store.get, store, [keys]); },
      set: function (items) { return call(store.set, store, [items]); },
      remove: function (keys) { return call(store.remove, store, [keys]); },
      clear: function () { return call(store.clear, store, []); }
    };
  }

  var browser = {
    raw: api,
    isFirefox: isFirefox,
    isChrome: !isFirefox,

    runtime: {
      id: api.runtime.id,
      getURL: function (p) { return api.runtime.getURL(p); },
      getManifest: function () { return api.runtime.getManifest(); },
      sendMessage: function (msg, options) {
        // options is only used by Firefox to target a specific frame; Chrome
        // takes no third argument, so we pass the message + callback only.
        return call(api.runtime.sendMessage, api.runtime, [msg]);
      },
      openOptionsPage: function () { return call(api.runtime.openOptionsPage, api.runtime, []); },
      onMessage: function (handler) {
        api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
          var result;
          try {
            result = handler(message, sender);
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
            return false;
          }
          if (result && typeof result.then === "function") {
            result.then(function (value) { sendResponse(value); },
              function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
            return true; // keep the message channel open for the async reply
          }
          sendResponse(result);
          return false;
        });
      },
      onInstalled: function (fn) { api.runtime.onInstalled.addListener(fn); },
      onStartup: function (fn) { api.runtime.onStartup.addListener(fn); }
    },

    storage: {
      local: area("local"),
      sync: area("sync"),
      session: area("session")
    },

    tabs: {
      query: function (info) { return call(api.tabs.query, api.tabs, [info]); },
      create: function (info) { return call(api.tabs.create, api.tabs, [info]); },
      sendMessage: function (tabId, msg) { return call(api.tabs.sendMessage, api.tabs, [tabId, msg]); },
      update: function (tabId, info) { return call(api.tabs.update, api.tabs, [tabId, info]); }
    },

    identity: {
      getRedirectURL: function (path) { return api.identity.getRedirectURL(path); },
      launchWebAuthFlow: function (options) { return call(api.identity.launchWebAuthFlow, api.identity, [options]); }
    },

    notifications: {
      create: function (id, options) { return call(api.notifications.create, api.notifications, [id, options]); },
      clear: function (id) { return call(api.notifications.clear, api.notifications, [id]); },
      onClicked: function (fn) { api.notifications.onClicked.addListener(fn); }
    },

    alarms: {
      create: function (name, info) { api.alarms.create(name, info); },
      clear: function (name) { return call(api.alarms.clear, api.alarms, [name]); },
      onAlarm: function (fn) { api.alarms.onAlarm.addListener(fn); }
    },

    action: {
      setBadgeText: function (details) {
        if (api.action && api.action.setBadgeText) api.action.setBadgeText(details);
      },
      setBadgeBackgroundColor: function (details) {
        if (api.action && api.action.setBadgeBackgroundColor) api.action.setBadgeBackgroundColor(details);
      }
    }
  };

  g.SkoolCal = g.SkoolCal || {};
  g.SkoolCal.browser = browser;
})();
