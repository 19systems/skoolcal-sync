/*
 * lib/storage.js — typed access to chrome.storage.local.
 *
 * Events are persisted with Date fields serialised to ISO strings (the storage
 * layer is JSON) and rehydrated on read.
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};
  var CONST = g.SkoolCal.CONST;
  var K = CONST.KEYS;

  function store() {
    var b = g.SkoolCal.browser;
    return (b && b.storage && b.storage.local) || null;
  }

  /* ---- settings -------------------------------------------------------- */

  function getSettings() {
    var s = store();
    if (!s) return Object.assign({}, CONST.DEFAULT_SETTINGS);
    return s.get(K.SETTINGS).then(function (res) {
      return Object.assign({}, CONST.DEFAULT_SETTINGS, (res && res[K.SETTINGS]) || {});
    });
  }

  function setSettings(patch) {
    var s = store();
    if (!s) return Promise.resolve(CONST.DEFAULT_SETTINGS);
    return getSettings().then(function (current) {
      var next = Object.assign({}, current, patch || {});
      var write = {}; write[K.SETTINGS] = next;
      return s.set(write).then(function () { return next; });
    });
  }

  /* ---- communities ----------------------------------------------------- */

  function getCommunities() {
    var s = store();
    if (!s) return Promise.resolve([]);
    return s.get(K.COMMUNITIES).then(function (res) {
      return (res && res[K.COMMUNITIES]) || [];
    });
  }

  function maxCommunities(tier) {
    return tier === CONST.TIER.PRO ? CONST.TIER.PRO_MAX_COMMUNITIES : CONST.TIER.FREE_MAX_COMMUNITIES;
  }

  /**
   * Add a community. Enforces the free-tier limit and returns
   * { ok, community?, communities, error? }.
   */
  function addCommunity(input) {
    return getSettings().then(function (settings) {
      return getCommunities().then(function (list) {
        var slug = (input.slug || "").toLowerCase().trim();
        if (!slug) return { ok: false, error: "Missing community slug." };
        var existing = list.filter(function (c) { return c.slug === slug; })[0];
        if (existing) {
          if (input.name && input.name !== existing.name) existing.name = input.name;
          var w = {}; w[K.COMMUNITIES] = list;
          return store().set(w).then(function () { return { ok: true, community: existing, communities: list }; });
        }
        if (list.length >= maxCommunities(settings.tier)) {
          return {
            ok: false,
            error: "Free plan is limited to " + CONST.TIER.FREE_MAX_COMMUNITIES + " community. Upgrade to Pro for unlimited communities.",
            limitReached: true,
            communities: list
          };
        }
        var community = {
          slug: slug,
          name: input.name || slug,
          addedAt: new Date().toISOString()
        };
        list.push(community);
        var write = {}; write[K.COMMUNITIES] = list;
        return store().set(write).then(function () { return { ok: true, community: community, communities: list }; });
      });
    });
  }

  function removeCommunity(slug) {
    return getCommunities().then(function (list) {
      var next = list.filter(function (c) { return c.slug !== slug; });
      var write = {}; write[K.COMMUNITIES] = next;
      return store().set(write).then(function () {
        return store().remove(K.EVENTS_PREFIX + slug).then(function () {
          return { ok: true, communities: next };
        });
      });
    });
  }

  /* ---- event cache ----------------------------------------------------- */

  function serializeEvent(ev) {
    return {
      uid: ev.uid,
      eventId: ev.eventId,
      occurrenceId: ev.occurrenceId,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      url: ev.url,
      start: ev.start ? ev.start.toISOString() : null,
      end: ev.end ? ev.end.toISOString() : null,
      allDay: !!ev.allDay,
      timezone: ev.timezone,
      organizer: ev.organizer,
      organizerName: ev.organizerName,
      host: ev.host,
      rrule: ev.rrule,
      exdates: (ev.exdates || []).map(function (d) { return d.toISOString(); }),
      recurrenceId: ev.recurrenceId ? ev.recurrenceId.toISOString() : null,
      recurring: !!ev.recurring,
      cancelled: !!ev.cancelled,
      community: ev.community,
      communityName: ev.communityName,
      meetingProvider: ev.meetingProvider,
      status: ev.status,
      sequence: ev.sequence,
      source: ev.source,
      confidence: ev.confidence
    };
  }

  function deserializeEvent(raw) {
    if (!raw) return null;
    var dt = g.SkoolCal.dt;
    return {
      uid: raw.uid,
      eventId: raw.eventId,
      occurrenceId: raw.occurrenceId,
      title: raw.title,
      description: raw.description,
      location: raw.location,
      url: raw.url,
      start: raw.start ? new Date(raw.start) : null,
      end: raw.end ? new Date(raw.end) : null,
      allDay: !!raw.allDay,
      timezone: raw.timezone,
      organizer: raw.organizer,
      organizerName: raw.organizerName,
      host: raw.host,
      rrule: raw.rrule,
      exdates: (raw.exdates || []).map(function (d) { return new Date(d); }),
      recurrenceId: raw.recurrenceId ? new Date(raw.recurrenceId) : null,
      recurring: !!raw.recurring,
      cancelled: !!raw.cancelled,
      community: raw.community,
      communityName: raw.communityName,
      meetingProvider: raw.meetingProvider,
      status: raw.status,
      sequence: raw.sequence,
      source: raw.source,
      confidence: raw.confidence,
      dtstamp: raw.start ? new Date(raw.start) : new Date()
    };
  }

  function saveEvents(slug, payload) {
    var s = store();
    if (!s) return Promise.resolve({ ok: false });
    return getSettings().then(function (settings) {
      var events = (payload.events || []).slice(0, settings.maxStoredEvents);
      var record = {
        slug: slug,
        name: payload.name || slug,
        fetchedAt: new Date().toISOString(),
        partial: !!payload.partial,
        warnings: payload.warnings || [],
        events: events.map(serializeEvent)
      };
      var write = {}; write[K.EVENTS_PREFIX + slug] = record;
      return s.set(write).then(function () { return updateIndex(slug, record); }).then(function () {
        return record;
      });
    });
  }

  function updateIndex(slug, record) {
    var s = store();
    return s.get(K.EVENTS_INDEX).then(function (res) {
      var index = (res && res[K.EVENTS_INDEX]) || {};
      index[slug] = {
        name: record.name,
        count: record.events.length,
        fetchedAt: record.fetchedAt,
        partial: record.partial
      };
      var write = {}; write[K.EVENTS_INDEX] = index;
      return s.set(write);
    });
  }

  function getEvents(slug) {
    var s = store();
    if (!s) return Promise.resolve(null);
    return s.get(K.EVENTS_PREFIX + slug).then(function (res) {
      var record = res && res[K.EVENTS_PREFIX + slug];
      if (!record) return null;
      return {
        slug: record.slug,
        name: record.name,
        fetchedAt: record.fetchedAt,
        partial: record.partial,
        warnings: record.warnings || [],
        events: (record.events || []).map(deserializeEvent).filter(Boolean)
      };
    });
  }

  function getIndex() {
    var s = store();
    if (!s) return Promise.resolve({});
    return s.get(K.EVENTS_INDEX).then(function (res) {
      return (res && res[K.EVENTS_INDEX]) || {};
    });
  }

  function clearEvents(slug) {
    var s = store();
    if (!s) return Promise.resolve();
    return s.remove(K.EVENTS_PREFIX + slug).then(function () {
      return s.get(K.EVENTS_INDEX).then(function (res) {
        var index = (res && res[K.EVENTS_INDEX]) || {};
        delete index[slug];
        var write = {}; write[K.EVENTS_INDEX] = index;
        return s.set(write);
      });
    });
  }

  /* ---- Google auth ----------------------------------------------------- */

  function getAuth() {
    var s = store();
    if (!s) return Promise.resolve(null);
    return s.get(K.AUTH).then(function (res) { return (res && res[K.AUTH]) || null; });
  }

  function setAuth(auth) {
    var s = store();
    var write = {}; write[K.AUTH] = auth;
    return s.set(write);
  }

  function clearAuth() {
    var s = store();
    return s.remove(K.AUTH);
  }

  g.SkoolCal.storage = {
    getSettings: getSettings,
    setSettings: setSettings,
    getCommunities: getCommunities,
    addCommunity: addCommunity,
    removeCommunity: removeCommunity,
    maxCommunities: maxCommunities,
    saveEvents: saveEvents,
    getEvents: getEvents,
    getIndex: getIndex,
    clearEvents: clearEvents,
    getAuth: getAuth,
    setAuth: setAuth,
    clearAuth: clearAuth,
    serializeEvent: serializeEvent,
    deserializeEvent: deserializeEvent
  };
})();
