/*
 * content/overlay.js — a page-wide status card rendered on skool.com.
 *
 * Shown only for user-initiated scans (i.e. when the popup asks for one), so
 * the automatic scan on page load stays silent. It lives in a Shadow DOM so
 * Skool's styles can't bleed in, and is appended outside #calendar-wrapper so
 * the extractor never sees it.
 */
(function () {
  "use strict";
  var g = globalThis;
  var SC = (g.SkoolCal = g.SkoolCal || {});

  var HOST_ID = "skoolcal-sync-overlay";
  var CSS = [
    ".card{pointer-events:auto;min-width:250px;max-width:360px;display:flex;gap:11px;align-items:flex-start;",
    "padding:12px 14px;border-radius:12px;background:rgba(17,19,24,.96);color:#f2f4f8;",
    "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;",
    "border:1px solid rgba(255,255,255,.09);box-shadow:0 10px 34px rgba(0,0,0,.4);",
    "backdrop-filter:blur(10px);opacity:1;transform:translateY(0);transition:opacity .18s ease,transform .18s ease}",
    ".card.enter{opacity:0;transform:translateY(-8px)}",
    ".spinner{width:16px;height:16px;flex:0 0 auto;margin-top:2px;border-radius:50%;",
    "border:2px solid rgba(129,140,248,.32);border-top-color:#818cf8;animation:sc-spin .7s linear infinite}",
    ".card.done .spinner{animation:none;border-color:transparent;background:#4ade80}",
    ".card.error .spinner{animation:none;border-color:transparent;background:#f87171}",
    "@keyframes sc-spin{to{transform:rotate(360deg)}}",
    ".body{min-width:0;flex:1}",
    ".brand{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#7f8a9e}",
    ".title{font-weight:650;font-size:13px;margin-top:2px}",
    ".detail{color:#b6bdcb;font-size:12px;margin-top:2px;word-break:break-word}",
    ".bar{margin-top:8px;height:4px;border-radius:99px;background:rgba(129,140,248,.2);overflow:hidden}",
    ".bar>i{display:block;height:100%;width:0;background:#818cf8;border-radius:99px;transition:width .25s ease}",
    ".close{pointer-events:auto;margin:-4px -4px 0 0;border:0;background:none;color:#7f8a9e;font:inherit;",
    "font-size:15px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}",
    ".close:hover{color:#f2f4f8;background:rgba(255,255,255,.08)}"
  ].join("");

  var host = null;
  var shadow = null;
  var ui = {};
  var hideTimer = null;

  function ensure() {
    if (host && document.documentElement.contains(host)) return;
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      // Position the host itself so no page rule can move it.
      host.style.cssText = "position:fixed;z-index:2147483647;top:16px;left:50%;" +
        "transform:translateX(-50%);pointer-events:none;";
      (document.body || document.documentElement).appendChild(host);
    }
    shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    shadow.innerHTML = "";

    var style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    var card = document.createElement("div");
    card.className = "card enter";
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");

    var spinner = document.createElement("div");
    spinner.className = "spinner";

    var body = document.createElement("div");
    body.className = "body";
    var brand = document.createElement("div");
    brand.className = "brand";
    brand.textContent = "SkoolCal Sync";
    var title = document.createElement("div");
    title.className = "title";
    var detail = document.createElement("div");
    detail.className = "detail";
    var bar = document.createElement("div");
    bar.className = "bar";
    var fill = document.createElement("i");
    bar.appendChild(fill);
    bar.hidden = true;

    body.appendChild(brand);
    body.appendChild(title);
    body.appendChild(detail);
    body.appendChild(bar);

    var close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00d7";
    close.addEventListener("click", function () { hide(0); });

    card.appendChild(spinner);
    card.appendChild(body);
    card.appendChild(close);
    shadow.appendChild(card);

    ui = { card: card, title: title, detail: detail, bar: bar, fill: fill };
  }

  function apply(opts) {
    opts = opts || {};
    if (opts.title) ui.title.textContent = opts.title;
    if (opts.detail !== undefined) ui.detail.textContent = opts.detail || "";
    var state = opts.state || "busy";
    ui.card.classList.toggle("done", state === "done");
    ui.card.classList.toggle("error", state === "error");
    if (opts.progress && opts.progress.total) {
      ui.bar.hidden = false;
      var pct = Math.max(0, Math.min(100, Math.round((opts.progress.done / opts.progress.total) * 100)));
      ui.fill.style.width = pct + "%";
    } else if (state !== "busy") {
      ui.bar.hidden = true;
    }
  }

  function show(opts) {
    clearTimeout(hideTimer);
    ensure();
    apply(Object.assign({ title: "Working…", detail: "", state: "busy" }, opts || {}));
    ui.card.classList.remove("enter");
  }

  function update(opts) {
    if (!host || !document.documentElement.contains(host)) { show(opts); return; }
    clearTimeout(hideTimer);
    apply(opts);
  }

  function hide(delay) {
    clearTimeout(hideTimer);
    if (!host) return;
    var doHide = function () {
      if (!host) return;
      ui.card.classList.add("enter");
      setTimeout(function () {
        if (host && host.parentNode) host.parentNode.removeChild(host);
        host = null;
        shadow = null;
        ui = {};
      }, 200);
    };
    if (delay) hideTimer = setTimeout(doHide, delay);
    else doHide();
  }

  function isVisible() {
    return !!(host && document.documentElement.contains(host));
  }

  SC.overlay = { show: show, update: update, hide: hide, isVisible: isVisible };
})();
