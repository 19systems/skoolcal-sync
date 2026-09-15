/*
 * content/injected.js — runs in the PAGE world (MAIN) to observe Skool's own
 * network traffic.
 *
 * WHY: Skool is a Next.js app. Its calendar month data is fetched over the wire
 * (fetch/XHR) and may never be fully present in the DOM at once. Reading those
 * responses is far more reliable than scraping pixels.
 *
 * HOW: we monkey-patch window.fetch and XMLHttpRequest.open/send, keep a small
 * in-memory buffer of calendar-looking responses, and post them to the content
 * script with window.postMessage. The content script pulls the buffer via a
 * request message, so timing doesn't matter.
 *
 * SAFETY: every patch is wrapped in try/catch and the originals are always
 * called. If Skool changes its transport, the worst case is "no captures" —
 * the DOM and .ics paths still work.
 *
 * The hook is only interested in URLs that look calendar-related, and it caps
 * each captured body at MAX_BODY bytes to avoid ballooning memory.
 */
(function () {
  "use strict";

  var FLAG = "__skoolcal_hook_installed__";
  if (window[FLAG]) return;
  window[FLAG] = true;

  var HOOK_SOURCE = "skoolcal-hook";
  var CONTENT_SOURCE = "skoolcal-content";
  var MAX_BODY = 3 * 1024 * 1024; // 3 MB per response
  var MAX_CAPTURES = 40;

  var captures = [];
  var icsUrls = Object.create(null);

  // URL patterns worth keeping. Deliberately broad: /calendar, /event, /ics,
  // plus the community API surface. Static assets are excluded.
  var INTERESTING = /(calendar|events?|occurrence|recurring|ics|schedule)/i;
  var ASSET = /\.(png|jpe?g|gif|svg|webp|avif|css|m?js|woff2?|ttf|map)(\?|$)/i;
  var ICS_URL = /\.ics(\?|$)/i;

  function isInteresting(url) {
    if (!url || typeof url !== "string") return false;
    if (ASSET.test(url)) return false;
    return INTERESTING.test(url);
  }

  function remember(url) {
    if (!url) return;
    if (ICS_URL.test(url)) icsUrls[url] = true;
  }

  function pushCapture(capture) {
    captures.push(capture);
    if (captures.length > MAX_CAPTURES) captures.shift();
  }

  function post(kind, data) {
    try {
      window.postMessage({ source: HOOK_SOURCE, kind: kind, data: data }, window.location.origin);
    } catch (e) { /* never let the hook break the page */ }
  }

  function handleBody(url, status, contentType, body) {
    remember(url);
    if (!body || body.length > MAX_BODY) return;
    pushCapture({
      url: url,
      status: status,
      contentType: contentType || "",
      body: body,
      at: Date.now()
    });
    post("capture", { url: url, status: status, contentType: contentType || "", length: body.length });
  }

  /* ---- fetch ----------------------------------------------------------- */

  if (typeof window.fetch === "function") {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = "";
      try {
        url = typeof input === "string" ? input : (input && input.url) || "";
        remember(url);
      } catch (e) { /* ignore */ }

      var result = originalFetch.apply(this, arguments);

      if (isInteresting(url) && result && typeof result.then === "function") {
        result.then(function (response) {
          try {
            var ct = "";
            try { ct = response.headers.get("content-type") || ""; } catch (e) {}
            var looksIcs = ICS_URL.test(url) || /text\/calendar/i.test(ct);
            var looksJson = /json/i.test(ct) || /json/i.test(url);
            if (!looksIcs && !looksJson && !isInteresting(url)) return;
            // Clone before the app consumes the body.
            response.clone().text().then(function (text) {
              handleBody(url, response.status, ct, text);
            }).catch(function () {});
          } catch (e) { /* ignore */ }
        }).catch(function () {});
      }
      return result;
    };
  }

  /* ---- XMLHttpRequest -------------------------------------------------- */

  if (window.XMLHttpRequest) {
    var proto = window.XMLHttpRequest.prototype;
    var originalOpen = proto.open;
    var originalSend = proto.send;

    proto.open = function (method, url) {
      try {
        this.__skoolcal_url = url;
        remember(url);
      } catch (e) { /* ignore */ }
      return originalOpen.apply(this, arguments);
    };

    proto.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener("load", function () {
          try {
            var url = xhr.__skoolcal_url || "";
            if (!isInteresting(url)) return;
            var ct = "";
            try { ct = xhr.getResponseHeader("content-type") || ""; } catch (e) {}
            var type = xhr.responseType;
            if (type === "json" && xhr.response) {
              handleBody(url, xhr.status, ct, JSON.stringify(xhr.response));
            } else if (!type || type === "text") {
              handleBody(url, xhr.status, ct, xhr.responseText);
            }
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      return originalSend.apply(this, arguments);
    };
  }

  /* ---- content-script bridge ------------------------------------------- */

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== CONTENT_SOURCE) return;

    if (msg.kind === "get-captures") {
      post("captures", {
        captures: captures,
        icsUrls: Object.keys(icsUrls)
      });
    } else if (msg.kind === "ping") {
      post("ready", { installed: true });
    }
  });

  post("ready", { installed: true });
})();
