# Security Policy

## Supported versions

The latest release is supported with security fixes. This is a browser extension
distributed through the Chrome Web Store and addons.mozilla.org; users receive
updates through those stores.

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability). If that is unavailable,
contact a maintainer directly.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected version(s) and browser.
- Any suggested fix.

You can expect an acknowledgement within a few days. Please allow time for a fix
to be released before public disclosure.

## Scope

Areas of particular interest:

- **OAuth handling** — the PKCE flow, token storage, and token refresh in
  `background/google.js`.
- **Data exfiltration** — anything that could send event data somewhere other
  than the user's own Google Calendar. The extension is local-first by design and
  must make no other network requests.
- **Message-passing boundaries** — `content/` ↔ background ↔ popup. Content
  scripts run in an isolated world; `content/injected.js` runs in the page world
  and must never expose extension privileges.
- **Generated `.ics` output** — injection or corruption of calendar data.

## Out of scope

- Skool's own site, API, or terms of service.
- Google's API or OAuth service.
- The behaviour of the extension on accounts/pages the user is not authorised to
  access.

## Design guarantees (what we aim to preserve)

These are properties a report may reference:

1. **No third-party servers.** The only outbound requests are to `skool.com`
   (same-origin, using the user's existing session) and to Google's OAuth and
   Calendar endpoints, and only after the user initiates it.
2. **No remote code.** Nothing is fetched and executed at runtime; all code ships
   in the package.
3. **Minimal permissions.** `storage`, `identity`, `notifications`, `alarms`, and
   host access to `skool.com` + Google APIs. No `tabs`, no `scripting`, no
   `downloads`, no `<all_urls>`.
4. **User-supplied OAuth client.** The extension ships no client secret; the user
   configures their own OAuth client ID.

See [PRIVACY.md](PRIVACY.md) for the full data-handling description.
