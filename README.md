# SkoolCal Sync

[![CI](https://github.com/your-org/skoolcal-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/skoolcal-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-success.svg)](#)
[![No runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](#)

A cross-browser extension (**Chrome Manifest V3** + **Firefox Manifest V3**) that extracts every
event from a [Skool](https://www.skool.com) community calendar and lets you export them in one
click — as a single multi-event `.ics`, as individual `.ics` files, or synced straight to Google
Calendar.

Instead of opening each event and downloading its `.ics` by hand, open the calendar once and
SkoolCal Sync collects the whole thing.

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Install (load unpacked)](#install-load-unpacked)
- [Build & package](#build--package)
- [Google Cloud OAuth setup](#google-cloud-oauth-setup)
- [Permissions & privacy](#permissions--privacy)
- [Maintaining the Skool extractor](#maintaining-the-skool-extractor)
- [Project structure](#project-structure)
- [Monetisation (free vs Pro)](#monetisation-free-vs-pro)
- [Limitations & troubleshooting](#limitations--troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Features

| | |
|---|---|
| **Automatic detection** | Runs on any `https://*.skool.com/<community>/calendar` page and extracts on load (toggleable). |
| **Upcoming only** | Events that have already finished are filtered out of the list and never exported. |
| **Fresh scan on export** | Pressing export or sync re-scans first, so you always export complete data rather than a stale cache. |
| **On-page progress overlay** | A page-wide card on skool.com shows what the scan is doing (phase, months loaded, progress bar) and confirms the result. Shadow-DOM isolated, dismissible. |
| **Date presets** | One-tap ranges — Today, This week, This month, Next 30 days, This year, Till year end, All time. Picking a preset only filters; nothing is fetched until you export. |
| **Multi-source extraction** | Merges four sources (see below) and de-duplicates, preferring authoritative data. |
| **Recurring series** | Detects repeating events; can optionally collapse them into proper `RRULE` series. |
| **Export** | One merged `.ics` (RFC 5545), or one `.ics` per event — imports into Apple Calendar, Outlook, Thunderbird and Google. |
| **Google Calendar sync** | OAuth 2.0 (PKCE) + Calendar API, idempotent (re-running never duplicates). |
| **Copy links** | Copies ready-made “add to Google Calendar” links for any selection. |
| **Filters** | Search, date range, “upcoming only”, per-community. |
| **Multi-community** | Remembers every community you scan. Free = 1 managed community, Pro = unlimited. |
| **Reminders** | Optional browser notifications before events start (local only). |
| **Dark mode** | Follows your OS theme. |
| **Local-first** | No analytics, no server. Data leaves the device only when *you* press “Sync”. |

### Paging behaviour (important)

Skool's calendar shows one month at a time. SkoolCal Sync **never pages on its own**:

- **Browsing costs nothing.** The scan that runs when a calendar page loads reads only what is already
  on screen — zero extra requests.
- **Preset chips only filter.** Clicking *This year* or *Next 30 days* changes the list, not the
  network.
- **Export does exactly one bounded scan.** Pressing *Export* / *Sync* pages forward as far as the
  chosen preset needs (capped by *Settings → Maximum months to page*), then exports. That's a single
  deliberate burst instead of a request storm, which is also friendlier to Skool's bot detection.
- The popup tells you which months are pending (*"Months up to December load when you export."*).

Presets are defined in `lib/daterange.js` and shared by the popup (filtering) and the content script
(paging), so both always agree.

### Scanning and feedback

- **Past events are hidden.** Anything that has already finished is filtered out of the list and
  never selected or exported (`lib/events.js → isPast`).
- **Scanning happens on export.** Browsing the calendar and clicking date presets make no extra
  requests. Clicking *Export* or *Sync* runs one fresh, bounded scan (the popup waits for it) and
  then exports the refreshed selection. UIDs are stable, so your selection survives the re-scan.
- **The page tells you what's happening.** A user-initiated scan renders a status card on the
  Skool page (`content/overlay.js`) showing the current phase, months loaded and a progress bar,
  then confirms the export. It's inside a Shadow DOM so Skool's CSS can't affect it, and it sits
  outside `#calendar-wrapper` so the extractor never sees it. The automatic scan on page load
  stays silent.

---

## How it works

Skool is a Next.js app, so the extension combines several signals and merges them. Every source is
normalised into one event shape and de-duplicated by UID / event id / title+start.

| # | Source | Confidence | Notes |
|---|--------|-----------|-------|
| 1 | **Server-rendered `__NEXT_DATA__`** | 70 | **The primary source.** Skool server-renders the full event objects (`props.pageProps.events`) into the page. We read them directly — complete title, description, exact offset timestamps, timezone and meeting link. |
| 2 | **Intercepted API responses** | 80 | A page-world hook wraps `fetch`/`XHR` and buffers Skool's own calendar requests, so month navigation is captured too. The same permissive JSON walker parses them. |
| 3 | **Event `.ics` files** | 100 | When an `.ics` URL is known it is fetched same-origin and parsed. Not needed on the calendar page (source 1 is already complete) but kept for other views. |
| 4 | **DOM month grid** | 35 | Fallback only. Skool renders bare `2pm - Title` text chips, so this yields **title + local time only** — no id, description or meeting link. |

### The real Skool event object

Read straight out of `__NEXT_DATA__`:

```jsonc
{
  "id": "f385827b0cd34a6ba755eb665b9eb24a",  // 32-hex event id
  "occurrenceId": "1827073800",               // unix seconds for THIS occurrence
  "startTime": "2027-11-24T17:30:00+01:00",   // RFC3339 with offset — exact
  "endTime":   "2027-11-24T18:30:00+01:00",
  "groupId": "866d841bcb40438d86613587f4505c56",
  "metadata": {
    "title": "Roast my emails",
    "description": "…",
    "timezone": "Europe/Belgrade",
    // LOCATION is a JSON *string*, not an object:
    "location": "{\"location_type\":2,\"location_info\":\"https://meet.google.com/hwk-vnij-fgd\"}"
  }
}
```

Three things this shapes in the code (`lib/events.js`):

- The human-readable fields are nested under **`metadata`**, so the scavenger flattens it before testing (`flattenMetadata`).
- `location` is a **JSON string**; `parseLocationField` unwraps `location_info` so the meeting link lands in `LOCATION` and the provider is detected.
- **`occurrenceId` gives us Skool's own UID**: `uid = id + occurrenceId`. That is byte-for-byte the UID inside Skool's downloadable `.ics` (verified against the real samples), so re-importing an event you already downloaded by hand is recognised as a duplicate instead of creating a second copy.

`pageProps.numCalendarEvents` reports the community's total event count. If we captured fewer, the popup says so and suggests a wider date preset to page through more months.

> **The “Add to calendar” dropdown** (Google / Apple / Outlook / Outlook.com / Yahoo) is where Skool's per-event `.ics` download lives. SkoolCal Sync doesn't need to click it — `__NEXT_DATA__` already contains everything the `.ics` would.

### What the DOM actually looks like

Verified against the live calendar:

```html
<div id="calendar-wrapper">
  <div class="sc-3e5122c2-5">September 2026</div>
  <a href="/settings?t=account"><div class="sc-3e5122c2-6">11:33am Nairobi time</div></a>
  <button aria-label="Next month">›</button>
  <div class="sc-3e5122c2-14">                     <!-- week row -->
    <div class="sc-3e5122c2-16"><span>1</span>     <!-- day cell -->
      <div class="sc-3e5122c2-17">2pm - Brands Q&amp;A with Ossama</div>
    </div>
  </div>
</div>
```

Two consequences the extractor handles:

- **The grid is Monday-first and includes spillover days** (31, 1, 2…), so dates are computed from
  the grid position rather than the day number.
- **Times are wall-clock in your *account* timezone**, labelled by city. The extension reads the
  on-page clock to derive the UTC offset, then refines it to the exact IANA zone (DST-correct) when
  the city is in `CONST.TIMEZONE_CITIES`.

### What a Skool `.ics` looks like

The extraction is built around the real format Skool produces:

```
BEGIN:VEVENT
UID:9ce0133fb8994601aabeae55fac13b371790530200   <- 32-hex event id + unix seconds
DTSTART:20260927T173000Z                          <- always UTC
DTEND:20260927T180000Z
SUMMARY:Email/website Support call
DESCRIPTION:...\n\nFrom: The IMA Accelerator      <- community name is appended here
LOCATION:https://meet.google.com/hwk-vnij-fgd     <- meeting link lives here
END:VEVENT
```

Skool expands recurring events server-side, so each occurrence is a **separate** `VEVENT` with its
own UID. SkoolCal Sync therefore *infers* recurrence from the series of occurrences (see
`lib/events.js → groupSeries`). Exporting occurrences individually is the default and is always
lossless; collapsing into `RRULE`s is opt-in because it is inherently approximate.

> **Getting full event details** (description, meeting link, duration) depends on source 2. If your
> events show only titles and times, open DevTools → Network, change month once, and paste the
> request URL + response shape so the API path can be pinned down.

---

## Install (load unpacked)

You need Node 18+ only to run the build scripts. There are **no runtime dependencies**.

```bash
git clone <this repo>
cd skoolcal-sync
npm run build          # creates dist/chrome and dist/firefox
```

### Chrome / Edge / Brave

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select `dist/chrome`.

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…**
3. Select `dist/firefox/manifest.json`.

> Temporary add-ons in Firefox are removed on restart. For a permanent install, sign the package
> (see below) or use Developer Edition / `xpinstall.signatures.required = false`.

### Try it

1. Open `https://www.skool.com/<your-community>/calendar`.
2. The toolbar badge fills with the number of events found.
3. Open the popup, adjust the selection, and export or sync.

---

## Build & package

```bash
npm run icons     # regenerate icons/*.png (zero-dependency PNG encoder)
npm run lint      # syntax-check + verify every manifest reference exists
npm run test      # 136 assertions: ICS/event logic + jsdom suites over the real grid & API payload
npm run check     # lint + test
npm run build     # dist/chrome + dist/firefox
npm run validate  # check the BUILT manifests (Chrome/Firefox drift, permissions, remote code)
npm run lint:firefox   # AMO's web-ext validator — must report 0 errors
npm run package   # zips dist/skoolcal-sync-{chrome,firefox}.zip
```

The DOM suite uses **jsdom** and is optional:

```bash
npm install --no-save jsdom && npm test
```

If jsdom isn't installed the DOM suite skips itself, so `npm test` always runs with zero
dependencies. It exercises the real pipeline against the actual Skool markup: month-label and
week-start detection, the Monday-first grid with spillover days, `2pm - Title` chip parsing,
timezone conversion from the on-page clock, cancelled events, **bounded month paging**, `.ics`
discovery, embedded Next.js payloads, and a mocked `.ics` fetch proving authoritative data overrides
scraped data.

`npm run package` shells out to the system `zip` binary (present on macOS and most Linux distros).

### Store submission

- **Chrome Web Store** → upload `dist/skoolcal-sync-chrome.zip`.
- **Firefox Add-ons (AMO)** → upload `dist/skoolcal-sync-firefox.zip`, or sign locally:

  ```bash
  npx web-ext sign --source-dir dist/firefox --api-key ... --api-secret ...
  ```

The Firefox manifest is generated with a `browser_specific_settings.gecko.id`
(`skoolcal-sync@skoolcal.dev`) — change it in `scripts/build.mjs` before submitting.
Store copy, permission justifications and the full checklist live in
[`docs/`](docs/): [store listing](docs/STORE_LISTING.md),
[permission justifications](docs/PRIVACY_JUSTIFICATIONS.md),
[release checklist](docs/RELEASE_CHECKLIST.md).

---

## Google Cloud OAuth setup

SkoolCal Sync uses **your own** OAuth client, so no third-party server is involved and the extension
never handles your password.

1. **Create a project** at <https://console.cloud.google.com>.
2. **Enable the Google Calendar API**:
   <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>.
3. **Configure the OAuth consent screen**:
   - User type: *External*.
   - Add the scope `https://www.googleapis.com/auth/calendar.events`.
   - While in “Testing” mode, add your own Google account under **Test users**.
4. **Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Under **Authorised redirect URIs**, add the redirect URI shown on the extension's options page
     (the extension displays it for you; copy it with the **Copy** button).
5. **Copy the Client ID** into *Settings → Google Calendar → OAuth Client ID* and click
   **Connect Google Calendar**.

### About the redirect URI

It is derived from your extension ID:

| Browser | Redirect URI |
|---------|--------------|
| Chrome | `https://<extension-id>.chromiumapp.org/` |
| Firefox | `https://<random-hash>.extensions.allizom.org/` |

Reinstalling the extension (or loading it unpacked from a different path) can change the ID — if
sign-in starts failing, re-copy the redirect URI from the options page and add it in Google Cloud.

### Scopes requested

- `https://www.googleapis.com/auth/calendar.events` — create events (least privilege; cannot read
  or delete unrelated calendars).
- `https://www.googleapis.com/auth/userinfo.email` — show which account is connected.

---

## Permissions & privacy

| Permission | Why |
|-----------|-----|
| `storage` | Save settings, communities and the local event cache. |
| `identity` | `launchWebAuthFlow` for Google OAuth (PKCE). |
| `notifications` | Optional “event starting soon” reminders. |
| `alarms` | Periodically check for upcoming events. |
| Host: `skool.com` | Read the calendar page + fetch event `.ics` files. |
| Host: `googleapis.com` / `oauth2.googleapis.com` | Google Calendar API + token refresh. |

No `tabs`, no `scripting`, no `downloads`, no `<all_urls>`, no analytics, no remote code. `.ics` files
are saved by the popup itself via a Blob object URL, which works in both browsers without the
`downloads` permission. All extraction and `.ics` generation happens locally. The only outbound
traffic is to Google, and only when you press **Sync to Google Calendar** (or connect the account).
See [PRIVACY.md](PRIVACY.md).

---

## Maintaining the Skool extractor

Skool's class names are minified and **will** change. The extractor is designed to degrade
gracefully, but if you ever get **0 events**, this is the fix:

1. Open a calendar page and inspect an event card.
2. Add the new selector to the **top** of the relevant list in
   `content/extract.js → SELECTORS` (never replace existing candidates).
3. Reload the extension.

Everything structural lives in these two places:

- `lib/constants.js` — message types, defaults, and Skool URL knowledge
  (`CALENDAR_PATH`, `ICS_URL_TEMPLATES`, `API_HINTS`, meeting providers).
- `content/extract.js` — `SELECTORS` (calendar root, event card, title, time, description,
  location, `.ics` link, next-month/load-more buttons).

The network hook in `content/injected.js` intentionally has **no** schema assumptions — it captures
anything matching `/calendar|event|ics|schedule/` and the JSON walker figures out the rest. That path
tends to survive frontend redesigns.

### Adding a known API endpoint

If you discover Skool's calendar endpoint, add it to `CONST.SKOOL.API_HINTS`. The hook matches on
substring, so a hint is usually enough.

---

## Project structure

```
skoolcal-sync/
├── manifest.json                 # Chrome/base manifest (Firefox variant generated at build)
├── lib/                          # classic scripts shared by every context (no bundler)
│   ├── browser.js                # chrome.* / browser.* promise shim
│   ├── constants.js              # messages, defaults, Skool URL knowledge
│   ├── datetime.js               # parsing + ICS date formats
│   ├── daterange.js              # named date-range presets (popup + paging)
│   ├── ics.js                    # RFC 5545 builder + parser
│   ├── events.js                 # canonical model, dedupe, series inference, Google mapping
│   ├── storage.js                # typed chrome.storage.local access
│   └── messaging.js              # request/response helpers
├── background/
│   ├── service-worker.js         # message router + orchestration
│   ├── google.js                 # OAuth PKCE + Calendar API
│   └── notifications.js          # reminder alarm
├── content/
│   ├── injected.js               # MAIN-world fetch/XHR hook
│   ├── network-capture.js        # isolated-world bridge + fallback injection
│   ├── extract.js                # the extraction engine + SELECTORS registry
│   ├── month-nav.js              # bounded month paging
│   ├── overlay.js                # on-page progress card (Shadow DOM)
│   └── content.js                # orchestrator (auto-run, SPA route watching)
├── popup/                        # event list, presets, export/sync actions
├── options/                      # OAuth setup, communities, settings, privacy
├── icons/                        # generated PNGs
├── scripts/
│   ├── build.mjs                 # dist/chrome + dist/firefox (manifest rewrite)
│   ├── make-icons.mjs            # zero-dependency PNG encoder
│   ├── lint.mjs                  # syntax + manifest reference checks
│   ├── test.mjs                  # pure-logic tests
│   ├── test-dom.mjs              # jsdom tests (optional; skips without jsdom)
│   ├── validate.mjs              # checks the BUILT dist manifests
│   ├── package.mjs               # zip for the stores
│   └── fixtures/                 # committed real Skool .ics samples
├── docs/                         # store listing, permission justifications, release checklist
└── .github/                      # CI, release workflow, issue/PR templates
```

**Why classic scripts instead of ES modules?** Content scripts and Firefox background scripts
cannot use static `import`, and we want the extension to be loadable *unpacked with no bundler*.
Each file is an IIFE that attaches to a single `globalThis.SkoolCal` namespace, so there is exactly
one build step and zero runtime dependencies.

---

## Monetisation (free vs Pro)

The free/Pro gate is implemented in `lib/storage.js → addCommunity` and `background/service-worker.js
→ SET_TIER`.

- **Free:** 1 managed community.
- **Pro:** unlimited communities + series collapsing.

> ⚠️ `SET_TIER` is a **local stub**. Before shipping paid tiers, replace it with server-side licence
> verification (or the Chrome/Firefox in-app purchase APIs) and never trust a client-supplied key.
> The extension still caches events for any community you visit; only the *managed* list is gated.

---

## Limitations & troubleshooting

- **Not on a calendar page** — the popup needs `…/<community>/calendar`. It shows an “Open skool.com”
  button otherwise.
- **Private / paywalled community** — extraction needs your logged-in session. If Skool gates the
  calendar, the extension reports it instead of returning junk.
- **0 events found** — usually a selector change (see [Maintaining the extractor](#maintaining-the-skool-extractor)).
  Try toggling *Auto-load months* off/on and re-scan; then check the Service Worker console
  (`chrome://extensions` → *service worker*) and the page console.
- **Only titles and times, no descriptions or meeting links** — full details come from the
  server-rendered `__NEXT_DATA__` and the network hook. If they go missing, the payload shape
  changed: check `lib/events.js → flattenMetadata` and `parseLocationField`.
- **Fewer events than expected** — the popup tells you when `numCalendarEvents` exceeds what was
  captured. Pick a wider date preset (e.g. *This year*) to page through the missing months.
- **Multiple download prompts** — exporting individual `.ics` files triggers the browser's
  “allow multiple downloads?” prompt. Exporting one merged `.ics` avoids it.
- **Google sync errors** — `403` usually means the Calendar API isn't enabled or the consent screen
  isn't configured. `401` means reconnect from the options page.
- **Recurring accuracy** — occurrence-level export is exact. Collapsing to `RRULE` is a heuristic
  (Skool's per-occurrence times can drift, e.g. across DST); it splits multi-weekday series to keep
  times accurate.

---

## Contributing

Contributions are welcome — especially fixes when Skool changes its markup. Start with
[CONTRIBUTING.md](CONTRIBUTING.md), which covers the (deliberate) no-bundler/no-dependency
architecture, where Skool-specific knowledge lives, and how to add tests.

Quick version:

```bash
npm install --no-save jsdom     # optional, enables the DOM suite
npm run check                   # lint + tests
npm run package && npm run validate && npm run lint:firefox
```

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md) — report vulnerabilities privately
- [Changelog](CHANGELOG.md)

---

## License

[MIT](LICENSE) © SkoolCal Sync contributors.

Not affiliated with or endorsed by Skool.com. “Skool” is a trademark of its respective owner.
