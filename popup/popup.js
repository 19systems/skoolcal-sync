/*
 * popup/popup.js — the popup controller.
 *
 * Reads cached events from storage (written by the content script via the
 * background), applies filters, and dispatches export/sync actions. The popup
 * never scrapes the page itself.
 */
(function () {
  "use strict";
  var g = globalThis;
  var SC = g.SkoolCal;
  var CONST = SC.CONST;
  var MSG = CONST.MSG;
  var dt = SC.dt;
  var EV = SC.events;

  var state = {
    tab: null,
    slug: null,
    pageCommunity: null,
    events: [],
    totalCached: 0,
    selected: new Set(),
    autoSelectedSlug: null,
    preset: "month",
    settings: null,
    communities: [],
    index: {},
    auth: null,
    status: null,
    syncProgress: null,
    syncActive: false,
    pollTimer: null
  };

  function $(id) { return document.getElementById(id); }

  var els = {};

  /* ---- helpers --------------------------------------------------------- */

  function slugFromUrl(url) {
    if (!url) return null;
    var m = url.match(/^https:\/\/(?:www\.)?skool\.com\/([^/?#]+)/i);
    if (!m) return null;
    var slug = m[1];
    if (CONST.SKOOL.RESERVED_SLUGS.indexOf(slug.toLowerCase()) !== -1) return null;
    return slug;
  }

  function isSkoolTab() {
    return !!(state.tab && /^https:\/\/([a-z0-9-]+\.)?skool\.com\//i.test(state.tab.url || ""));
  }

  function toast(message, isError) {
    els.toast.textContent = message;
    els.toast.classList.toggle("error", !!isError);
    els.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { els.toast.hidden = true; }, 2600);
  }

  function serialize(list) {
    return list.map(SC.storage.serializeEvent);
  }

  function selectedEvents() {
    return state.events.filter(function (ev) { return state.selected.has(ev.uid); });
  }

  function currentRange() {
    return SC.daterange.resolveRange({ datePreset: state.preset }, new Date());
  }

  function visibleEvents() {
    var term = els.search.value.trim().toLowerCase();
    var range = currentRange();
    var from = range.from;
    var to = range.to;
    var onlyUpcoming = els.onlyUpcoming.checked;
    var now = Date.now();

    return state.events.filter(function (ev) {
      if (!ev.start) return false;
      if (onlyUpcoming && ev.start.getTime() < now) return false;
      if (from && ev.start < from) return false;
      if (to && ev.start > to) return false;
      if (term) {
        var hay = (ev.title + " " + (ev.description || "") + " " + (ev.communityName || "")).toLowerCase();
        if (hay.indexOf(term) === -1) return false;
      }
      return true;
    });
  }

  /* ---- rendering ------------------------------------------------------- */

  function renderCommunitySelect() {
    var options = [];
    var seen = Object.create(null);
    function add(slug, name) {
      if (!slug || seen[slug]) return;
      seen[slug] = true;
      options.push({ slug: slug, name: name || slug });
    }
    if (state.pageCommunity) add(state.pageCommunity, (state.index[state.pageCommunity] || {}).name);
    state.communities.forEach(function (c) { add(c.slug, c.name); });
    Object.keys(state.index).forEach(function (slug) { add(slug, state.index[slug].name); });

    els.community.innerHTML = "";
    if (!options.length) {
      var opt = document.createElement("option");
      opt.textContent = "No communities yet";
      opt.value = "";
      els.community.appendChild(opt);
      els.community.disabled = true;
      return;
    }
    els.community.disabled = false;
    options.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.slug;
      var label = o.name;
      if (o.slug === state.pageCommunity) label += "  •  current page";
      opt.textContent = label;
      els.community.appendChild(opt);
    });
    if (state.slug) els.community.value = state.slug;
  }

  function badge(text, cls) {
    var span = document.createElement("span");
    span.className = "badge" + (cls ? " " + cls : "");
    span.textContent = text;
    return span;
  }

  function renderList() {
    var list = visibleEvents();
    els.list.innerHTML = "";

    if (!list.length) {
      renderEmptyState();
      els.count.textContent = "";
      return;
    }

    var frag = document.createDocumentFragment();
    var now = Date.now();
    list.forEach(function (ev) {
      var row = document.createElement("label");
      row.className = "event" + (ev.start.getTime() < now ? " is-past" : "");

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.selected.has(ev.uid);
      cb.addEventListener("change", function () {
        if (cb.checked) state.selected.add(ev.uid);
        else state.selected.delete(ev.uid);
        updateSelectedCount();
      });

      var main = document.createElement("div");
      main.className = "event-main";

      var title = document.createElement("div");
      title.className = "event-title";
      title.textContent = ev.title || "Untitled event";
      title.title = ev.title || "";

      var meta = document.createElement("div");
      meta.className = "event-meta";
      var when = document.createElement("span");
      when.className = "event-when";
      when.textContent = dt.formatRange(ev.start, ev.end);
      meta.appendChild(when);

      if (ev.meetingProvider) meta.appendChild(badge(ev.meetingProvider));
      if (ev.cancelled) meta.appendChild(badge("Cancelled", "cancelled"));
      if (ev.recurring) meta.appendChild(badge("Recurring", "recurring"));
      if (ev.source === "ics") meta.appendChild(badge("Exact", "source-ics"));

      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(cb);
      row.appendChild(main);
      frag.appendChild(row);
    });

    els.list.appendChild(frag);
    els.count.textContent = list.length + (list.length === state.events.length ? "" : " of " + state.events.length) + " events";
    updateSelectedCount();
  }

  function renderEmptyState() {
    var wrap = document.createElement("div");
    wrap.className = "empty";
    var title = document.createElement("div");
    title.className = "empty-title";
    var p = document.createElement("p");
    var btn = document.createElement("button");
    btn.className = "btn btn-primary";

    if (!isSkoolTab()) {
      title.textContent = "Open a Skool calendar";
      p.textContent = "Go to your community's Calendar tab and this popup will fill up automatically.";
      btn.textContent = "Open skool.com";
      btn.addEventListener("click", function () {
        SC.browser.tabs.create({ url: "https://www.skool.com/" });
      });
    } else if (!state.events.length) {
      title.textContent = state.totalCached ? "No upcoming events" : "No events found yet";
      p.textContent = state.totalCached
        ? "This community's calendar has no events from now onwards."
        : "SkoolCal Sync can scan the page now, or wait for it to auto-detect.";
      btn.textContent = "Scan this page";
      btn.addEventListener("click", runExtraction);
    } else {
      title.textContent = "No events match your filters";
      p.textContent = "Try widening the date range or clearing the search.";
      btn.textContent = "Clear filters";
      btn.addEventListener("click", clearFilters);
    }

    wrap.appendChild(title);
    wrap.appendChild(p);
    wrap.appendChild(btn);
    els.list.appendChild(wrap);
  }

  function updateSelectedCount() {
    els.selectedCount.textContent = String(state.selected.size);
    var disabled = state.selected.size === 0;
    [els.exportMerged, els.exportIndividual, els.syncGoogle, els.copyLinks].forEach(function (b) {
      b.disabled = disabled;
    });
  }

  function renderStatus() {
    var sp = state.syncProgress;
    if (state.syncActive && sp) {
      els.status.hidden = false;
      els.status.classList.remove("done");
      els.statusSpinner.hidden = false;
      els.statusText.textContent = "Syncing " + (sp.done || 0) + " of " + (sp.total || 0) +
        (sp.current ? " — " + sp.current : "") +
        "  (" + (sp.inserted || 0) + " added, " + (sp.duplicate || 0) + " already there, " + (sp.failed || 0) + " failed)";
      els.progress.hidden = false;
      els.progressBar.style.width = Math.round(((sp.done || 0) / (sp.total || 1)) * 100) + "%";
      return;
    }

    var s = state.status;
    if (!s || !s.message) {
      els.status.hidden = true;
      return;
    }
    els.status.hidden = false;
    els.statusText.textContent = s.message;
    var finished = s.phase === "done" || s.phase === "error";
    els.status.classList.toggle("done", finished);
    els.statusSpinner.hidden = finished;
    els.progress.hidden = true;
  }

  function renderWarnings() {
    var warnings = (state.warnings || []).slice();
    if (!warnings.length) {
      els.warnings.hidden = true;
      return;
    }
    els.warnings.innerHTML = "";
    var ul = document.createElement("ul");
    warnings.forEach(function (w) {
      var li = document.createElement("li");
      li.textContent = w;
      ul.appendChild(li);
    });
    els.warnings.appendChild(ul);
    els.warnings.hidden = false;
  }

  function renderPresets() {
    els.presets.innerHTML = "";
    SC.daterange.PRESETS.forEach(function (p) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (p.id === state.preset ? " active" : "");
      chip.textContent = p.label;
      chip.setAttribute("aria-pressed", p.id === state.preset ? "true" : "false");
      chip.addEventListener("click", function () { selectPreset(p.id); });
      els.presets.appendChild(chip);
    });
  }

  /**
   * Change the date preset.
   *
   * This ONLY filters the list — it never touches the network. Scanning is
   * deliberately deferred to export so that clicking through presets can't
   * generate a burst of requests to Skool.
   */
  function selectPreset(id) {
    if (id === state.preset) return;
    state.preset = id;
    renderPresets();
    renderList();
    renderPageHint();
    SC.msg.sendToBackground(MSG.SET_SETTINGS, { patch: { datePreset: id } });
  }

  /** Tell the user which months will be fetched when they export. */
  function renderPageHint() {
    var range = currentRange();
    if (SC.daterange.needsPaging(range, new Date()) && range.to) {
      els.pageHint.hidden = false;
      els.pageHint.textContent = "Months up to " + dt.MONTHS_LONG[range.to.getMonth()] +
        " load when you export.";
    } else {
      els.pageHint.hidden = true;
    }
  }

  function render() {
    renderCommunitySelect();
    renderPresets();
    renderList();
    renderPageHint();
    updateSelectedCount();
    renderWarnings();
    renderStatus();
  }

  /* ---- data loading ---------------------------------------------------- */

  function refreshEvents() {
    if (!state.slug) { state.events = []; return Promise.resolve(); }
    return SC.msg.sendToBackground(MSG.GET_EVENTS, { slug: state.slug }).then(function (res) {
      var record = res.ok ? res.data : null;
      var all = (record && record.events) || [];
      state.totalCached = all.length;
      // Past events are hidden entirely (and never auto-selected/exported).
      state.events = all.filter(function (ev) { return !EV.isPast(ev); });
      state.warnings = (record && record.warnings) || [];
      // Auto-select everything the first time we open a community.
      if (state.autoSelectedSlug !== state.slug) {
        state.autoSelectedSlug = state.slug;
        state.selected = new Set(state.events.map(function (e) { return e.uid; }));
      }
      return SC.msg.sendToBackground(MSG.GET_STATUS, { slug: state.slug });
    }).then(function (res) {
      state.status = res.ok ? res.data : null;
    });
  }

  function loadState() {
    return SC.msg.sendToBackground(MSG.GET_STATE).then(function (res) {
      if (!res.ok) throw new Error(res.error || "Could not read extension state.");
      var d = res.data;
      state.settings = d.settings;
      state.communities = d.communities || [];
      state.index = d.index || {};
      state.auth = d.auth;
      state.syncProgress = d.syncProgress || null;
      if (state.syncProgress && state.syncProgress.startedAt && !state.syncProgress.finishedAt) {
        state.syncActive = true;
      }

      // Pick which community to show: current tab > saved preference > first.
      var tabSlug = slugFromUrl(state.tab && state.tab.url);
      state.pageCommunity = tabSlug;
      state.slug = tabSlug || state.settings.activeCommunity ||
        (state.communities[0] && state.communities[0].slug) || null;

      state.preset = state.settings.datePreset || "month";
    });
  }

  /* ---- actions --------------------------------------------------------- */

  function runExtraction() {
    els.status.hidden = false;
    els.statusText.textContent = "Scanning the page…";
    els.statusSpinner.hidden = false;
    els.status.classList.remove("done");
    SC.msg.sendToBackground(MSG.EXTRACT_NOW).then(function (res) {
      if (!res.ok) {
        toast(res.error || "Could not scan the page.", true);
        return;
      }
      toast("Scan started — this can take a moment.");
    });
  }

  function requireSelection() {
    var list = selectedEvents();
    if (!list.length) {
      toast("Select at least one event first.", true);
      return null;
    }
    return list;
  }

  /**
   * Save generated text as a file from the popup.
   *
   * Firefox's downloads.download rejects data: URLs and a Chrome MV3 service
   * worker has no Blob/object URLs, so neither the background nor a data: URL
   * can be used. The popup has a DOM, so a Blob + <a download> works in both
   * browsers with no downloads permission.
   */
  function saveBlobFile(filename, text) {
    return new Promise(function (resolve) {
      var blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      // Give the browser time to start the download before revoking.
      setTimeout(function () {
        try { URL.revokeObjectURL(url); a.remove(); } catch (e) { /* ignore */ }
        resolve();
      }, 350);
    });
  }

  /** Ask the page to show a short completion message in its overlay. */
  function overlayNotice(title, detail) {
    SC.msg.sendToBackground(MSG.OVERLAY_NOTICE, {
      title: title, detail: detail, state: "done", hideAfter: 3500
    });
  }

  /**
   * Run a fresh scan before an export/sync, then continue.
   *
   * The scan is user-initiated, so the content script shows the page-wide
   * overlay. EXTRACT_NOW resolves only when extraction has finished, which is
   * what lets us export complete data rather than a stale cache.
   */
  function withScan(onReady) {
    els.status.hidden = false;
    els.status.classList.remove("done");
    els.statusSpinner.hidden = false;
    els.statusText.textContent = "Scanning the calendar…";
    els.progress.hidden = true;

    return SC.msg.sendToBackground(MSG.EXTRACT_NOW).then(function (res) {
      if (!res.ok) throw new Error(res.error || "Could not scan the page.");
      return refreshEvents();
    }).then(function () {
      render();
      return onReady();
    }).catch(function (err) {
      els.status.hidden = true;
      toast((err && err.message) || "Scan failed.", true);
    });
  }

  function doExportMerged() {
    if (!requireSelection()) return;
    withScan(function () {
      var list = selectedEvents();
      if (!list.length) { toast("Those events are no longer available.", true); return; }
      var name = (state.index[state.slug] && state.index[state.slug].name) || state.slug || "Skool Calendar";
      return SC.msg.sendToBackground(MSG.EXPORT_MERGED_ICS, {
        events: serialize(list),
        calendarName: name
      }).then(function (res) {
        if (!res.ok) { toast(res.error || "Export failed.", true); return; }
        return saveBlobFile(res.data.filename, res.data.text).then(function () {
          toast("Saved " + res.data.filename + " (" + res.data.count + " events)");
          overlayNotice("Export complete", res.data.count + " events saved as " + res.data.filename);
        });
      });
    });
  }

  function doExportIndividual() {
    if (!requireSelection()) return;
    withScan(function () {
      var list = selectedEvents();
      if (!list.length) { toast("Those events are no longer available.", true); return; }
      return SC.msg.sendToBackground(MSG.EXPORT_INDIVIDUAL_ICS, { events: serialize(list) })
        .then(function (res) {
          if (!res.ok) { toast(res.error || "Export failed.", true); return; }
          var files = res.data.files || [];
          if (files.length > 4) toast("Saving " + files.length + " files — keep this popup open…");
          var chain = Promise.resolve();
          files.forEach(function (f) {
            chain = chain.then(function () { return saveBlobFile(f.filename, f.text); });
          });
          return chain.then(function () {
            toast("Saved " + files.length + " .ics file" + (files.length === 1 ? "" : "s"));
            overlayNotice("Export complete",
              files.length + " .ics file" + (files.length === 1 ? "" : "s") + " saved to your downloads.");
          });
        });
    });
  }

  function doCopyLinks() {
    var list = requireSelection();
    if (!list) return;
    SC.msg.sendToBackground(MSG.COPY_GOOGLE_LINKS, { events: serialize(list) }).then(function (res) {
      if (!res.ok) return toast(res.error || "Could not build links.", true);
      var text = res.data.links.map(function (l) { return l.title + "\n" + l.link; }).join("\n\n");
      return copyToClipboard(text).then(function () {
        toast("Copied " + res.data.links.length + " Google Calendar link" + (res.data.links.length === 1 ? "" : "s"));
      });
    });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove();
  }

  function doSyncGoogle() {
    if (!requireSelection()) return;

    withScan(function () {
      var list = selectedEvents();
      if (!list.length) { toast("Those events are no longer available.", true); return; }

      var start = state.auth && state.auth.connected
        ? Promise.resolve()
        : SC.msg.sendToBackground(MSG.GOOGLE_AUTH).then(function (res) {
            if (!res.ok) {
              toast(res.error || "Google sign-in failed.", true);
              throw new Error("cancelled");
            }
            state.auth = res.data;
            toast("Connected as " + (res.data.email || "Google account"));
          });

      return start.then(function () {
        state.syncActive = true;
        state.syncProgress = { total: list.length, done: 0, inserted: 0, duplicate: 0, failed: 0, current: null };
        renderStatus();
        return SC.msg.sendToBackground(MSG.SYNC_GOOGLE, { events: serialize(list) });
      }).then(function (res) {
        if (!res) return;
        if (!res.ok) {
          state.syncActive = false;
          toast(res.error || "Sync failed.", true);
          return renderStatus();
        }
        var r = res.data;
        state.syncActive = false;
        state.syncProgress = null;
        state.status = {
          phase: "done",
          message: "Synced: " + r.inserted + " added, " + r.duplicate + " already existed" +
            (r.failed ? ", " + r.failed + " failed" : "") + "."
        };
        // Keep the summary visible; the extraction-status poll would otherwise
        // overwrite it on the next tick.
        state.statusLock = Date.now() + 8000;
        renderStatus();
        toast("Google Calendar sync complete.");
        overlayNotice("Google Calendar sync complete",
          r.inserted + " added, " + r.duplicate + " already there" + (r.failed ? ", " + r.failed + " failed" : "") + ".");
        if (r.errors && r.errors.length) {
          state.warnings = r.errors.slice(0, 5);
          renderWarnings();
        }
      }).catch(function (err) {
        state.syncActive = false;
        if (err && err.message !== "cancelled") toast(err.message, true);
        renderStatus();
      });
    });
  }

  function clearFilters() {
    els.search.value = "";
    els.onlyUpcoming.checked = false;
    selectPreset("all");
  }

  /* ---- polling --------------------------------------------------------- */

  function poll() {
    if (!state.slug) return;
    var jobs = [SC.msg.sendToBackground(MSG.GET_STATUS, { slug: state.slug }).then(function (res) {
      if (res.ok && !(state.statusLock && Date.now() < state.statusLock)) state.status = res.data;
    })];

    if (state.syncActive) {
      jobs.push(SC.msg.sendToBackground(MSG.GET_STATE).then(function (res) {
        if (res.ok && res.data.syncProgress) state.syncProgress = res.data.syncProgress;
      }));
    }

    Promise.all(jobs).then(function () {
      // Refresh the list when an extraction finishes.
      var phase = state.status && state.status.phase;
      if ((phase === "done" || phase === "error") && state.lastPhase !== phase) {
        state.lastPhase = phase;
        if (phase === "done") refreshEvents().then(renderList);
      }
      if (phase && phase !== "done" && phase !== "error") state.lastPhase = phase;
      renderStatus();
    });
  }

  /* ---- wiring ---------------------------------------------------------- */

  function cacheEls() {
    els = {
      community: $("community"),
      count: $("count"),
      status: $("status"),
      statusSpinner: $("status-spinner"),
      statusText: $("status-text"),
      progress: $("progress"),
      progressBar: $("progress-bar"),
      search: $("search"),
      presets: $("presets"),
      pageHint: $("page-hint"),
      selectAll: $("select-all"),
      selectNone: $("select-none"),
      onlyUpcoming: $("only-upcoming"),
      list: $("list"),
      warnings: $("warnings"),
      selectedCount: $("selected-count"),
      exportMerged: $("export-merged"),
      exportIndividual: $("export-individual"),
      syncGoogle: $("sync-google"),
      copyLinks: $("copy-links"),
      refresh: $("refresh"),
      settings: $("settings"),
      toast: $("toast")
    };
  }

  function wire() {
    els.refresh.addEventListener("click", runExtraction);
    els.settings.addEventListener("click", function () {
      SC.msg.sendToBackground(MSG.OPEN_OPTIONS);
      window.close();
    });

    els.community.addEventListener("change", function () {
      state.slug = els.community.value;
      state.autoSelectedSlug = null;
      SC.msg.sendToBackground(MSG.SET_SETTINGS, { patch: { activeCommunity: state.slug } });
      refreshEvents().then(render);
    });

    els.search.addEventListener("input", renderList);
    els.onlyUpcoming.addEventListener("change", renderList);

    els.selectAll.addEventListener("click", function () {
      visibleEvents().forEach(function (ev) { state.selected.add(ev.uid); });
      renderList();
    });
    els.selectNone.addEventListener("click", function () {
      visibleEvents().forEach(function (ev) { state.selected.delete(ev.uid); });
      renderList();
    });

    els.exportMerged.addEventListener("click", doExportMerged);
    els.exportIndividual.addEventListener("click", doExportIndividual);
    els.syncGoogle.addEventListener("click", doSyncGoogle);
    els.copyLinks.addEventListener("click", doCopyLinks);
  }

  function init() {
    cacheEls();
    wire();

    SC.browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      state.tab = tabs && tabs[0];
      return loadState();
    }).then(function () {
      render();
      return refreshEvents();
    }).then(function () {
      render();
      state.pollTimer = setInterval(poll, 1100);
      poll();
    }).catch(function (err) {
      toast((err && err.message) || "Failed to load.", true);
    });

    window.addEventListener("unload", function () {
      if (state.pollTimer) clearInterval(state.pollTimer);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
