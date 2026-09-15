/*
 * options/options.js — settings controller.
 */
(function () {
  "use strict";
  var g = globalThis;
  var SC = g.SkoolCal;
  var CONST = SC.CONST;
  var MSG = CONST.MSG;

  var state = { settings: null, communities: [], index: {}, auth: null };

  function $(id) { return document.getElementById(id); }

  function toast(message, isError) {
    var el = $("toast");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2800);
  }

  /* ---- render ---------------------------------------------------------- */

  function renderAuth() {
    var connected = state.auth && state.auth.connected;
    var status = $("google-status");
    status.textContent = connected ? "Connected" : "Not connected";
    status.classList.toggle("ok", !!connected);
    $("connect").hidden = !!connected;
    $("disconnect").hidden = !connected;
    $("google-email").textContent = connected && state.auth.email ? state.auth.email : "";
    $("redirect-uri").value = (state.auth && state.auth.redirectUri) || "";
  }

  function renderCommunities() {
    var list = $("community-list");
    list.innerHTML = "";
    if (!state.communities.length) {
      var p = document.createElement("div");
      p.className = "empty-note";
      p.textContent = "No communities yet. Open a Skool calendar, or add one below.";
      list.appendChild(p);
    }
    state.communities.forEach(function (c) {
      var info = state.index[c.slug] || {};
      var item = document.createElement("div");
      item.className = "community-item";

      var name = document.createElement("div");
      name.className = "name";
      name.textContent = c.name || c.slug;
      var slug = document.createElement("div");
      slug.className = "slug";
      slug.textContent = c.slug;
      var left = document.createElement("div");
      left.appendChild(name);
      left.appendChild(slug);

      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = info.count != null ? info.count + " events" : "not scanned";

      var remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", function () { removeCommunity(c.slug); });

      item.appendChild(left);
      item.appendChild(meta);
      item.appendChild(remove);
      list.appendChild(item);
    });

    var tier = (state.settings && state.settings.tier) || CONST.TIER.FREE;
    var isPro = tier === CONST.TIER.PRO;
    $("tier-pill").textContent = isPro ? "Pro" : "Free";
    $("tier-pill").classList.toggle("ok", isPro);
    $("tier-note").hidden = isPro;
    $("pro-row").hidden = isPro;
  }

  function renderSettings() {
    var s = state.settings || {};
    $("client-id").value = s.googleClientId || "";
    $("calendar-id").value = s.googleCalendarId || "primary";
    $("auto-extract").checked = s.autoExtract !== false;
    $("capture-network").checked = s.captureNetwork !== false;
    $("fetch-ics").checked = s.fetchIcs !== false;
    $("collapse-series").checked = !!s.collapseSeries;
    $("auto-load-months").value = s.autoLoadMonths != null ? s.autoLoadMonths : 6;
    $("notifications-enabled").checked = !!s.notificationsEnabled;
    $("notify-before").value = s.notifyBeforeMin || 10;

    var total = Object.keys(state.index || {}).reduce(function (sum, k) {
      return sum + (state.index[k].count || 0);
    }, 0);
    $("storage-info").textContent = total + " event" + (total === 1 ? "" : "s") + " cached across " +
      Object.keys(state.index || {}).length + " community(ies).";
  }

  function render() {
    renderAuth();
    renderCommunities();
    renderSettings();
  }

  /* ---- actions --------------------------------------------------------- */

  function patchSettings(patch, message) {
    return SC.msg.sendToBackground(MSG.SET_SETTINGS, { patch: patch }).then(function (res) {
      if (!res.ok) { toast(res.error || "Could not save.", true); return; }
      state.settings = res.data;
      if (message) toast(message);
    });
  }

  function connect() {
    var clientId = $("client-id").value.trim();
    patchSettings({ googleClientId: clientId }).then(function () {
      toast("Opening Google sign-in…");
      return SC.msg.sendToBackground(MSG.GOOGLE_AUTH);
    }).then(function (res) {
      if (!res || !res.ok) { toast((res && res.error) || "Sign-in failed.", true); return; }
      state.auth = res.data;
      renderAuth();
      toast("Connected to Google Calendar.");
    });
  }

  function disconnect() {
    SC.msg.sendToBackground(MSG.GOOGLE_SIGNOUT).then(function () {
      state.auth = { connected: false, redirectUri: (state.auth && state.auth.redirectUri) || "" };
      renderAuth();
      toast("Disconnected.");
    });
  }

  function addCommunity() {
    var input = $("new-community");
    var slug = input.value.trim().toLowerCase();
    if (!slug) return;
    SC.msg.sendToBackground(MSG.ADD_COMMUNITY, { slug: slug, name: slug }).then(function (res) {
      if (!res.ok) { toast(res.error || "Could not add community.", true); return; }
      input.value = "";
      state.communities = res.data.communities || [];
      renderCommunities();
      toast("Community added.");
    });
  }

  function removeCommunity(slug) {
    SC.msg.sendToBackground(MSG.REMOVE_COMMUNITY, { slug: slug }).then(function (res) {
      if (!res.ok) { toast(res.error || "Could not remove.", true); return; }
      state.communities = res.data.communities || [];
      delete state.index[slug];
      render();
      toast("Removed.");
    });
  }

  function activatePro() {
    var key = $("license-key").value.trim();
    SC.msg.sendToBackground(MSG.SET_TIER, { tier: CONST.TIER.PRO, licenseKey: key }).then(function (res) {
      if (!res.ok) { toast(res.error || "Activation failed.", true); return; }
      state.settings = res.data.settings;
      render();
      toast("Pro activated. Unlimited communities unlocked.");
    });
  }

  function clearData() {
    var slugs = Object.keys(state.index || {});
    if (!slugs.length) { toast("Nothing to clear."); return; }
    Promise.all(slugs.map(function (slug) {
      return SC.msg.sendToBackground(MSG.CLEAR_EVENTS, { slug: slug });
    })).then(function () {
      state.index = {};
      render();
      toast("Cached events cleared.");
    });
  }

  function copyRedirect() {
    var value = $("redirect-uri").value;
    if (!value) return;
    var done = function () { toast("Redirect URI copied."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(done);
    } else {
      $("redirect-uri").select();
      try { document.execCommand("copy"); } catch (e) {}
      done();
    }
  }

  /* ---- wiring ---------------------------------------------------------- */

  function wire() {
    $("connect").addEventListener("click", connect);
    $("disconnect").addEventListener("click", disconnect);
    $("copy-redirect").addEventListener("click", copyRedirect);
    $("add-community").addEventListener("click", addCommunity);
    $("activate-pro").addEventListener("click", activatePro);
    $("clear-data").addEventListener("click", clearData);

    $("new-community").addEventListener("keydown", function (e) {
      if (e.key === "Enter") addCommunity();
    });

    $("client-id").addEventListener("change", function () {
      patchSettings({ googleClientId: $("client-id").value.trim() }, "Client ID saved.");
    });
    $("calendar-id").addEventListener("change", function () {
      patchSettings({ googleCalendarId: $("calendar-id").value.trim() || "primary" }, "Calendar ID saved.");
    });

    [["auto-extract", "autoExtract"], ["capture-network", "captureNetwork"],
     ["fetch-ics", "fetchIcs"], ["collapse-series", "collapseSeries"],
     ["notifications-enabled", "notificationsEnabled"]].forEach(function (pair) {
      $(pair[0]).addEventListener("change", function () {
        var patch = {}; patch[pair[1]] = $(pair[0]).checked;
        patchSettings(patch);
      });
    });

    $("auto-load-months").addEventListener("change", function () {
      var n = Math.max(0, Math.min(24, parseInt($("auto-load-months").value, 10) || 0));
      $("auto-load-months").value = n;
      patchSettings({ autoLoadMonths: n });
    });

    $("notify-before").addEventListener("change", function () {
      var n = Math.max(1, Math.min(120, parseInt($("notify-before").value, 10) || 10));
      $("notify-before").value = n;
      patchSettings({ notifyBeforeMin: n });
    });

    $("test-notification").addEventListener("click", function () {
      SC.msg.sendToBackground(MSG.TEST_NOTIFICATION).then(function (res) {
        toast(res.ok ? "Test notification sent." : "Could not send notification.", !res.ok);
      });
    });
  }

  function init() {
    var version = SC.browser.runtime.getManifest().version;
    $("version").textContent = "v" + version;
    $("footer-version").textContent = "v" + version;

    wire();

    SC.msg.sendToBackground(MSG.GET_STATE).then(function (res) {
      if (!res.ok) { toast(res.error || "Failed to load settings.", true); return; }
      state.settings = res.data.settings;
      state.communities = res.data.communities || [];
      state.index = res.data.index || {};
      state.auth = res.data.auth;
      render();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
