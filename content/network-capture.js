/*
 * content/network-capture.js — isolated-world side of the page hook.
 *
 * Responsibilities:
 *  1. Keep a live list of responses the MAIN-world hook captured.
 *  2. Fall back to <script src> injection on browsers that don't support
 *     `world: "MAIN"` in the manifest (Firefox < 128).
 *
 * The content script runs at document_idle, the hook at document_start, so the
 * hook has usually buffered everything already. We still ask twice (once
 * immediately, once after a delay) to catch late navigations.
 */
(function () {
  "use strict";
  var g = globalThis;
  var SC = (g.SkoolCal = g.SkoolCal || {});

  var HOOK_SOURCE = "skoolcal-hook";
  var CONTENT_SOURCE = "skoolcal-content";

  var state = {
    captures: [],
    icsUrls: [],
    hookAlive: false
  };

  function onHookMessage(event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== HOOK_SOURCE) return;

    if (msg.kind === "ready") {
      state.hookAlive = true;
    } else if (msg.kind === "capture") {
      // A live capture arrived; refresh the buffer shortly after.
      setTimeout(requestCaptures, 50);
    } else if (msg.kind === "captures" && msg.data) {
      state.captures = msg.data.captures || [];
      state.icsUrls = msg.data.icsUrls || [];
    }
  }

  function requestCaptures() {
    try {
      window.postMessage({ source: CONTENT_SOURCE, kind: "get-captures" }, window.location.origin);
    } catch (e) { /* ignore */ }
  }

  /** Inject the hook as a page script (fallback for old Firefox). */
  function injectFallback() {
    try {
      var b = SC.browser;
      var script = document.createElement("script");
      script.src = b.runtime.getURL("content/injected.js");
      script.async = false;
      script.dataset.skoolcal = "hook";
      (document.head || document.documentElement).appendChild(script);
      script.addEventListener("load", function () { script.remove(); });
    } catch (e) { /* CSP may block; DOM extraction still works */ }
  }

  function init() {
    window.addEventListener("message", onHookMessage);
    requestCaptures();

    // If the manifest-declared MAIN-world script didn't run, inject manually.
    setTimeout(function () {
      if (!state.hookAlive) {
        injectFallback();
        setTimeout(requestCaptures, 150);
      }
    }, 400);

    // One more pull after the page has settled (SPA data often arrives late).
    setTimeout(requestCaptures, 2500);
  }

  SC.capture = {
    init: init,
    request: requestCaptures,
    getCaptures: function () { return state.captures.slice(); },
    getIcsUrls: function () { return state.icsUrls.slice(); },
    isHookAlive: function () { return state.hookAlive; }
  };
})();
