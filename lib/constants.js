/*
 * lib/constants.js — shared message types, storage keys, defaults and the
 * Skool-specific URL/selector knowledge.
 *
 * Everything that is likely to break when Skool ships a frontend change is
 * collected here (and in content/extract.js's selector registry) so it can be
 * updated in one place. See README.md > "Maintaining the Skool extractor".
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};

  var CONST = {
    /* ---- storage keys (chrome.storage.local) -------------------------- */
    KEYS: {
      SETTINGS: "sc:settings",
      COMMUNITIES: "sc:communities",
      AUTH: "sc:googleAuth",
      EVENTS_PREFIX: "sc:events:",
      EVENTS_INDEX: "sc:eventsIndex",
      LAST_RUN: "sc:lastRun",
      NOTIFIED: "sc:notified",
      SYNC_PROGRESS: "sc:syncProgress",
      STATUS_PREFIX: "sc:status:"
    },

    /* ---- runtime message types ---------------------------------------- */
    MSG: {
      // popup/options -> background
      GET_STATE: "GET_STATE",
      GET_SETTINGS: "GET_SETTINGS",
      SET_SETTINGS: "SET_SETTINGS",
      GET_EVENTS: "GET_EVENTS",
      GET_STATUS: "GET_STATUS",
      EXTRACT_NOW: "EXTRACT_NOW",
      EXPORT_MERGED_ICS: "EXPORT_MERGED_ICS",
      EXPORT_INDIVIDUAL_ICS: "EXPORT_INDIVIDUAL_ICS",
      COPY_GOOGLE_LINKS: "COPY_GOOGLE_LINKS",
      SYNC_GOOGLE: "SYNC_GOOGLE",
      GOOGLE_AUTH: "GOOGLE_AUTH",
      GOOGLE_AUTH_STATUS: "GOOGLE_AUTH_STATUS",
      GOOGLE_SIGNOUT: "GOOGLE_SIGNOUT",
      ADD_COMMUNITY: "ADD_COMMUNITY",
      REMOVE_COMMUNITY: "REMOVE_COMMUNITY",
      SET_TIER: "SET_TIER",
      OPEN_OPTIONS: "OPEN_OPTIONS",
      TEST_NOTIFICATION: "TEST_NOTIFICATION",
      CLEAR_EVENTS: "CLEAR_EVENTS",

      // content -> background
      EVENTS_FOUND: "EVENTS_FOUND",
      EXTRACTION_STATUS: "EXTRACTION_STATUS",
      CAPTURE_HINT: "CAPTURE_HINT",

      // background -> content
      RUN_EXTRACTION: "RUN_EXTRACTION",
      OVERLAY_NOTICE: "OVERLAY_NOTICE",
      PING: "PING"
    },

    /* ---- default settings --------------------------------------------- */
    DEFAULT_SETTINGS: {
      autoExtract: true,          // extract automatically when a calendar page opens
      autoLoadMonths: 12,         // HARD CAP on months paged; 0 disables paging entirely.
                                  // Paging only happens when the user sets an end date.
      captureNetwork: true,       // intercept Skool's own calendar XHR/fetch calls
      fetchIcs: true,             // fetch each event's .ics for authoritative fields
      includeRecurring: true,     // keep recurring occurrences
      collapseSeries: false,      // collapse inferred series into one RRULE event
      notificationsEnabled: false,
      notifyBeforeMin: 10,
      googleCalendarId: "primary",
      googleClientId: "",         // user-supplied OAuth client id (see README)
      syncReminders: false,       // copy Skool event description into Google reminders field
      activeCommunity: null,      // slug of the community shown in the popup
      datePreset: "month",        // see lib/daterange.js (month = no paging)
      maxStoredEvents: 2000,
      tier: "free"                // 'free' | 'pro' (see README: monetisation hook)
    },

    /* ---- free/pro gating ---------------------------------------------- */
    TIER: {
      FREE: "free",
      PRO: "pro",
      FREE_MAX_COMMUNITIES: 1,
      PRO_MAX_COMMUNITIES: Infinity
    },

    /* ---- Google OAuth -------------------------------------------------- */
    GOOGLE: {
      AUTH_ENDPOINT: "https://accounts.google.com/o/oauth2/v2/auth",
      TOKEN_ENDPOINT: "https://oauth2.googleapis.com/token",
      CALENDAR_API: "https://www.googleapis.com/calendar/v3",
      SCOPES: [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/userinfo.email"
      ].join(" ")
    },

    /* ---- alarms -------------------------------------------------------- */
    ALARM_REMINDER: "sc:reminder-check",

    /* ---- Skool URL knowledge ------------------------------------------ */
    SKOOL: {
      // A community calendar lives under /<slug>/calendar (with optional view
      // query params). The slug is the first path segment.
      CALENDAR_PATH: /^\/([^/]+)\/calendar(?:\/|$|\?)/i,
      ANY_COMMUNITY_PATH: /^\/([^/]+)(?:\/|$)/i,
      // Paths that are definitely NOT a community slug.
      RESERVED_SLUGS: ["about", "login", "signup", "discover", "pricing", "api", "help", "terms", "privacy", "settings", "admin"],
      // Candidate endpoints that may return calendar events as JSON. These are
      // used only as *hints* for URL discovery — the extension always prefers
      // URLs it actually observed in the DOM or in the network hook.
      API_HINTS: [
        "/api/calendar",
        "/api/events",
        "/calendar/events",
        "/api/communities/"
      ],
      // Candidate templates for an event's downloadable .ics. `{id}` is the
      // 32-hex event id seen in Skool's own UID format. Templates are probed
      // only when the network hook never revealed a real .ics URL.
      ICS_URL_TEMPLATES: [
        "/{slug}/calendar/{id}.ics",
        "/api/calendar/events/{id}.ics",
        "/api/events/{id}.ics",
        "/api/communities/{slug}/calendar/{id}.ics"
      ]
    },

    /* ---- calendar provider detection (for LOCATION field) -------------- */
    MEETING_PROVIDERS: [
      { name: "Google Meet", re: /meet\.google\.com\//i },
      { name: "Zoom", re: /(?:[\w-]+\.)?zoom\.us\//i },
      { name: "Microsoft Teams", re: /teams\.(?:microsoft|live)\.com\//i },
      { name: "Discord", re: /discord\.(?:gg|com)\//i },
      { name: "Skool", re: /skool\.com\//i }
    ],

    /* ---- timezone city names -> IANA zones ----------------------------- */
    /*
     * Skool renders times in the ACCOUNT's timezone and labels it with a city
     * name, e.g. "11:33am Nairobi time". To turn a wall-clock time back into
     * UTC we need the IANA zone. When a city is missing here we fall back to
     * the offset derived from that on-page clock, which is correct for any
     * zone without DST — add entries here to make DST zones exact.
     */
    TIMEZONE_CITIES: {
      nairobi: "Africa/Nairobi",
      kampala: "Africa/Kampala",
      "dar es salaam": "Africa/Dar_es_Salaam",
      "addis ababa": "Africa/Addis_Ababa",
      khartoum: "Africa/Khartoum",
      cairo: "Africa/Cairo",
      lagos: "Africa/Lagos",
      accra: "Africa/Accra",
      abidjan: "Africa/Abidjan",
      casablanca: "Africa/Casablanca",
      algiers: "Africa/Algiers",
      tunis: "Africa/Tunis",
      johannesburg: "Africa/Johannesburg",
      "cape town": "Africa/Johannesburg",
      harare: "Africa/Harare",
      lusaka: "Africa/Lusaka",
      kigali: "Africa/Kigali",
      kinshasa: "Africa/Kinshasa",
      luanda: "Africa/Luanda",
      maputo: "Africa/Maputo",
      windhoek: "Africa/Windhoek",
      gaborone: "Africa/Gaborone",
      london: "Europe/London",
      dublin: "Europe/Dublin",
      lisbon: "Europe/Lisbon",
      paris: "Europe/Paris",
      berlin: "Europe/Berlin",
      madrid: "Europe/Madrid",
      rome: "Europe/Rome",
      amsterdam: "Europe/Amsterdam",
      brussels: "Europe/Brussels",
      zurich: "Europe/Zurich",
      vienna: "Europe/Vienna",
      stockholm: "Europe/Stockholm",
      oslo: "Europe/Oslo",
      copenhagen: "Europe/Copenhagen",
      helsinki: "Europe/Helsinki",
      warsaw: "Europe/Warsaw",
      prague: "Europe/Prague",
      athens: "Europe/Athens",
      istanbul: "Europe/Istanbul",
      moscow: "Europe/Moscow",
      kyiv: "Europe/Kyiv",
      "new york": "America/New_York",
      boston: "America/New_York",
      washington: "America/New_York",
      miami: "America/New_York",
      atlanta: "America/New_York",
      toronto: "America/Toronto",
      chicago: "America/Chicago",
      dallas: "America/Chicago",
      houston: "America/Chicago",
      denver: "America/Denver",
      phoenix: "America/Phoenix",
      "los angeles": "America/Los_Angeles",
      "san francisco": "America/Los_Angeles",
      seattle: "America/Los_Angeles",
      vancouver: "America/Vancouver",
      "mexico city": "America/Mexico_City",
      bogota: "America/Bogota",
      lima: "America/Lima",
      santiago: "America/Santiago",
      "buenos aires": "America/Argentina/Buenos_Aires",
      "sao paulo": "America/Sao_Paulo",
      dubai: "Asia/Dubai",
      "abu dhabi": "Asia/Dubai",
      riyadh: "Asia/Riyadh",
      doha: "Asia/Qatar",
      kuwait: "Asia/Kuwait",
      muscat: "Asia/Muscat",
      manama: "Asia/Bahrain",
      amman: "Asia/Amman",
      beirut: "Asia/Beirut",
      baghdad: "Asia/Baghdad",
      tehran: "Asia/Tehran",
      jerusalem: "Asia/Jerusalem",
      "tel aviv": "Asia/Jerusalem",
      karachi: "Asia/Karachi",
      lahore: "Asia/Karachi",
      islamabad: "Asia/Karachi",
      mumbai: "Asia/Kolkata",
      delhi: "Asia/Kolkata",
      "new delhi": "Asia/Kolkata",
      bangalore: "Asia/Kolkata",
      bengaluru: "Asia/Kolkata",
      chennai: "Asia/Kolkata",
      kolkata: "Asia/Kolkata",
      hyderabad: "Asia/Kolkata",
      colombo: "Asia/Colombo",
      kathmandu: "Asia/Kathmandu",
      dhaka: "Asia/Dhaka",
      yangon: "Asia/Yangon",
      bangkok: "Asia/Bangkok",
      hanoi: "Asia/Ho_Chi_Minh",
      "ho chi minh": "Asia/Ho_Chi_Minh",
      "kuala lumpur": "Asia/Kuala_Lumpur",
      singapore: "Asia/Singapore",
      jakarta: "Asia/Jakarta",
      manila: "Asia/Manila",
      "hong kong": "Asia/Hong_Kong",
      shanghai: "Asia/Shanghai",
      beijing: "Asia/Shanghai",
      taipei: "Asia/Taipei",
      tokyo: "Asia/Tokyo",
      osaka: "Asia/Tokyo",
      seoul: "Asia/Seoul",
      almaty: "Asia/Almaty",
      tashkent: "Asia/Tashkent",
      sydney: "Australia/Sydney",
      melbourne: "Australia/Melbourne",
      brisbane: "Australia/Brisbane",
      perth: "Australia/Perth",
      auckland: "Pacific/Auckland",
      honolulu: "Pacific/Honolulu",
      utc: "UTC",
      gmt: "UTC"
    }
  };

  g.SkoolCal.CONST = CONST;
})();
