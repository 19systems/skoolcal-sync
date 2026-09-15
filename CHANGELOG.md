# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-15

Initial public release. Cross-browser (Chrome MV3 + Firefox MV3) extension that
extracts every event from Skool community calendars.

### Added

- Automatic extraction on any `https://*.skool.com/<community>/calendar` page.
- Four merged extraction sources, preferring authoritative data:
  1. server-rendered `__NEXT_DATA__` (full event objects),
  2. intercepted `fetch`/`XHR` calendar responses (page-world hook),
  3. per-event `.ics` files when a URL is known,
  4. the DOM month grid (fallback: title + local time).
- `lib/ics.js` — RFC 5545 `.ics` builder **and** parser (line folding, escaping,
  UTC serialisation).
- Recurring-series inference, including multi-weekday patterns and per-occurrence
  time drift, with optional collapsing into `RRULE`s.
- Export as one merged `.ics`, or one `.ics` per event (imports into Apple
  Calendar, Outlook, Thunderbird and Google).
- Google Calendar sync via OAuth 2.0 PKCE + Calendar API, idempotent through
  `iCalUID`.
- Copy ready-made "add to Google Calendar" links.
- Date presets: Today, This week, This month, Next 30 days, This year, Till year
  end, All time.
- Past events are filtered out of the list and never exported.
- Page-wide progress overlay (Shadow DOM) for user-initiated scans.
- Optional browser reminders before events start.
- Multi-community support with free (1) / Pro (unlimited) gating.
- Popup and options UI with light/dark theming.
- Tooling: zero-dependency icon generator, build (Chrome + Firefox manifests),
  lint, hermetic test suites, and packaging.

### Fixed

- `foldLine` split UTF-16 surrogate pairs, producing invalid strings that made
  `encodeURIComponent` throw `URIError: malformed URI sequence` on events with
  emoji.
- Firefox rejected the generated `.ics` download because it used a `data:` URL;
  downloads now use a Blob object URL from the popup. The `downloads` permission
  was removed as a result.
- The JSON scavenger ignored Skool's nested `metadata` object and its
  JSON-string `location`, so no events were found from the real payload.
- De-duplication keyed on `eventId` collapsed distinct occurrences of a recurring
  series; it now keys on UID (`id + occurrenceId`), which matches Skool's own
  `.ics` UIDs exactly.
- Month paging is now limited to a single, user-initiated scan on export instead
  of firing requests on page load and on every date-preset click.

[Unreleased]: https://github.com/your-org/skoolcal-sync/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/your-org/skoolcal-sync/releases/tag/v1.0.0
