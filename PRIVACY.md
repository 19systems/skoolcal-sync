# Privacy Policy — SkoolCal Sync

_Last updated: 2026_

SkoolCal Sync is a browser extension that extracts events from Skool community calendars and lets
you export them. This policy explains exactly what data the extension touches and where it goes.

## Summary

- **All processing happens locally in your browser.**
- There is **no analytics, no tracking, no telemetry, and no server operated by the developer.**
- Your data leaves your device **only** when you explicitly connect/sync to Google Calendar, and then
  it goes **directly** to Google's API using **your own** OAuth credentials.
- No data is ever sold or shared with third parties.

## What the extension accesses

| Data | Purpose | Where it is stored |
|------|---------|-------------------|
| Calendar event data (title, time, description, location, links) from pages you visit on `skool.com` | To display, export and optionally sync the events you ask for | Local extension storage (`chrome.storage.local`) on your device |
| Your settings (selected community, date range, preferences) | To remember your choices | Local extension storage |
| Google OAuth tokens (access + refresh) | To call the Google Calendar API on your behalf | Local extension storage |
| Your Google account email | To show which account is connected | Local extension storage |

The extension does **not** collect browsing history, keystrokes, passwords, or data from any site
other than the Skool calendar pages it runs on.

## Network requests the extension makes

1. **To `skool.com`** — reading the calendar page and fetching each event's `.ics` file, using the
   session you are already logged in with. This is the same request your browser makes when you click
   an event's download button.
2. **To Google (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`)** — only when
   you press **Connect** or **Sync to Google Calendar**. The extension sends the selected events to
   the Google Calendar API using your own OAuth client.

No other network requests are made. The extension does not contact any developer-controlled server.

## Permissions and why they exist

- `storage` — save settings and the local event cache.
- `identity` — sign in to Google with OAuth (PKCE).
- `notifications` — optional reminders before events start.
- `alarms` — periodically check for upcoming events to remind you about.
- Host access to `skool.com` — read the calendar and fetch event `.ics` files.
- Host access to `googleapis.com` / `oauth2.googleapis.com` — Google Calendar API and token refresh.

`.ics` files are generated and saved entirely inside the extension (via a Blob object URL); the
extension does not request the `downloads` permission.

## Data retention and deletion

Cached events and tokens live only in your browser profile's local extension storage. You can clear
them at any time from **Settings → Data & privacy → Clear cached events**, or by disconnecting your
Google account, or by removing the extension (which deletes all extension storage).

## Children's privacy

The extension is not directed at children and does not knowingly collect data from them.

## Changes

If this policy changes, the updated version will be included with the extension.

## Contact

For questions, open an issue in the project's repository.
