# Permission justifications

Text to paste into store review forms. Keep it aligned with `manifest.json` — the
CI `validate` step enforces the allow-list, so if a permission is added here it
must be added there too.

The extension requests **no optional permissions** and **no `<all_urls>`**.

---

## Permissions

### `storage`

> Required to save the user's settings (selected community, date-range preset,
> notification preference, Google OAuth client ID) and a local cache of the
> calendar events the user asked to extract, so the popup can display them.
> Stored with `chrome.storage.local` / `browser.storage.local` on the user's
> device only. Nothing is synced to the developer.

### `identity`

> Required to run the OAuth 2.0 authorization-code (PKCE) flow that connects the
> user's own Google account, so the extension can create events in their Google
> Calendar. Used only when the user presses "Connect Google Calendar" or "Sync".
> The access/refresh tokens are stored locally and sent only to Google's token
> and Calendar endpoints.

### `notifications`

> Required for the optional "remind me before an event starts" feature. The user
> must enable it in Settings; it is off by default. Notifications are generated
> locally from already-stored events.

### `alarms`

> Required to periodically (every 5 minutes) check the locally cached events for
> anything starting soon, which is what triggers the optional reminders above.
> The alarm makes no network requests.

---

## Host permissions

### `https://skool.com/*` and `https://*.skool.com/*`

> The extension's single purpose is to read Skool community calendar pages and
> turn their events into calendar files. This host access is used to:
> 1. inject the content script that reads the calendar the user is viewing;
> 2. fetch each event's own downloadable `.ics` file (when available) using the
>    user's existing logged-in session, to get exact event details.
>
> Only calendar pages under `/<community>/calendar` are acted on. The extension
> does not read or modify any other part of the site, and it makes no requests to
> skool.com unless the user has opened a community calendar.

### `https://www.googleapis.com/*`

> Used to create events in the user's Google Calendar
> (`/calendar/v3/calendars/{id}/events`) and to read the connected account's email
> address for display. Only called after the user connects their account and
> presses Sync.

### `https://oauth2.googleapis.com/*`

> Used for the OAuth 2.0 token exchange and refresh endpoints required by the
> Google sign-in flow above.

---

## Single purpose statement

> SkoolCal Sync has one purpose: extract events from Skool community calendars
> and export them as `.ics` files or sync them to the user's own Google Calendar.
> Every permission above exists only to serve that purpose.

---

## Remote code

> The extension does not load, execute, or eval any remote code. All JavaScript
> ships inside the package. It contains no `eval`, no `new Function`, and no
> remotely hosted scripts. The `content_security_policy` does not reference any
> remote origin.

---

## Data usage / retention

> Calendar event data is processed locally and cached in `storage.local` on the
> user's device. The user can clear it at any time from Settings → "Clear cached
> events". Removing the extension deletes all extension storage. The developer
> operates no servers and receives no data.
