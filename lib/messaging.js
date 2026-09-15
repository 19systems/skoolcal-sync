/*
 * lib/messaging.js — thin wrappers over runtime messaging.
 *
 * All request/response payloads follow { ok: boolean, data?, error? } so
 * callers can handle failures uniformly. Content scripts additionally talk to
 * the MAIN-world hook over window.postMessage (see content/network-capture.js).
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};

  function bg() { return g.SkoolCal.browser; }

  function sendToBackground(type, payload) {
    var b = bg();
    if (!b || !b.runtime) return Promise.resolve({ ok: false, error: "No runtime available." });
    return b.runtime.sendMessage({ type: type, payload: payload || {} })
      .then(function (res) {
        if (res && typeof res === "object" && "ok" in res) return res;
        return { ok: true, data: res };
      })
      .catch(function (err) {
        return { ok: false, error: (err && err.message) || "Message failed." };
      });
  }

  function sendToTab(tabId, type, payload) {
    var b = bg();
    if (!b || !b.tabs) return Promise.resolve({ ok: false, error: "No tabs API." });
    return b.tabs.sendMessage(tabId, { type: type, payload: payload || {} })
      .then(function (res) {
        if (res && typeof res === "object" && "ok" in res) return res;
        return { ok: true, data: res };
      })
      .catch(function (err) {
        return { ok: false, error: (err && err.message) || "No content script in tab." };
      });
  }

  /** Register a background-side request handler. */
  function onRequest(handler) {
    var b = bg();
    if (!b || !b.runtime) return;
    b.runtime.onMessage(function (message, sender) {
      if (!message || !message.type) return Promise.resolve({ ok: false, error: "Malformed message." });
      var handled;
      try {
        handled = handler(message.type, message.payload || {}, sender);
      } catch (e) {
        return Promise.resolve({ ok: false, error: (e && e.message) || String(e) });
      }
      if (handled && typeof handled.then === "function") {
        return handled.then(function (data) {
          if (data && typeof data === "object" && "ok" in data) return data;
          return { ok: true, data: data };
        }).catch(function (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        });
      }
      if (handled && typeof handled === "object" && "ok" in handled) return Promise.resolve(handled);
      return Promise.resolve({ ok: true, data: handled });
    });
  }

  function ok(data) { return { ok: true, data: data }; }
  function fail(error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }

  g.SkoolCal.msg = {
    sendToBackground: sendToBackground,
    sendToTab: sendToTab,
    onRequest: onRequest,
    ok: ok,
    fail: fail
  };
})();
