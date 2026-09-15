# Release checklist

## One-time setup

- [ ] Replace `your-org` in `package.json`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/config.yml`
      and `docs/STORE_LISTING.md` with the real GitHub owner/repo.
- [ ] Confirm the extension ID in `scripts/build.mjs` (`GECKO_ID`) is the one you want
      permanently. **This becomes the Firefox add-on identity — changing it later
      creates a new add-on.**
- [ ] For Chrome, the extension ID is derived from the key/publisher once uploaded.
      Pin it deliberately (see below) so the OAuth redirect URI stays stable.
- [ ] Enable GitHub Actions and (optionally) private vulnerability reporting.

### Pinning the Chrome extension ID (recommended)

The Google OAuth redirect URI is `https://<extension-id>.chromiumapp.org/`. The
unpacked ID changes with the load path, which is annoying for users following the
README. To keep it stable, generate a key and add it to the manifest as `"key"`:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
```

Paste the output into `manifest.json` as `"key"`. Keep `key.pem` **out of the
repo** (it is already covered by `.gitignore` if named `*.pem` — verify).

## Every release

1. [ ] Bump the version in **both** `manifest.json` and `package.json`
       (they must match; CI enforces this).
2. [ ] Update `CHANGELOG.md` (move `[Unreleased]` entries under the new version).
3. [ ] Run the full pipeline locally:
       ```bash
       npm run check
       npm run package
       npm run validate
       npm run lint:firefox      # must report 0 errors
       ```
4. [ ] Load both builds unpacked and smoke-test:
       - Chrome: `dist/chrome`
       - Firefox: `dist/firefox/manifest.json`
       - Open a community calendar, confirm the event count, export a merged
         `.ics`, import it into a calendar app.
       - If the manifest/permissions changed, re-check the OAuth redirect URI.
5. [ ] Commit, tag, push:
       ```bash
       git commit -am "chore(release): v1.0.0"
       git tag v1.0.0
       git push && git push --tags
       ```
6. [ ] The **Release** workflow builds, validates, runs `web-ext lint`, and
       attaches `dist/skoolcal-sync-chrome.zip` and `dist/skoolcal-sync-firefox.zip`
       to a GitHub Release.
7. [ ] Upload the zips:
       - **Chrome Web Store** → upload `skoolcal-sync-chrome.zip`
       - **AMO** → upload `skoolcal-sync-firefox.zip` (or sign with
         `npx web-ext sign`)

## First submission only

- [ ] Complete the Chrome "Privacy practices" form
      (answers in `docs/STORE_LISTING.md`).
- [ ] Fill in the AMO "Data collection" and reviewer notes.
- [ ] Upload screenshots and promo tiles (`docs/STORE_LISTING.md`).
- [ ] Verify the published redirect URI matches what the options page shows, and
      add it to the Google Cloud OAuth client.

## If a release is bad

Extensions cannot be un-published, only superseded. Ship a patch version
immediately; stores usually review a hotfix quickly. If the issue is severe,
consider unpublishing on AMO (possible) and hiding on Chrome (not possible).
