# Contributing

Thanks for helping improve SkoolCal Sync. This document covers how to set up the
project, the conventions it follows, and how to get a change merged.

## Getting started

Requires **Node 18+**. There are **no runtime dependencies** — the extension is
plain JavaScript that loads unpacked with no bundler.

```bash
git clone https://github.com/your-org/skoolcal-sync.git
cd skoolcal-sync
npm run build          # dist/chrome + dist/firefox
npm run check          # lint + tests
```

Load it unpacked:

- **Chrome/Edge:** `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`

The optional DOM test suite uses jsdom:

```bash
npm install --no-save jsdom
npm test
```

Without jsdom, that suite skips itself and `npm test` still passes.

## Project conventions

Please read these before making changes — they are deliberate.

### 1. No bundler, no runtime dependencies

Content scripts and Firefox background scripts cannot use static ES `import`, and
the extension must load unpacked without a build step. Every file is therefore a
**classic script** wrapped in an IIFE that attaches to a single
`globalThis.SkoolCal` namespace. Load order matters and is declared in
`manifest.json`.

Do not add runtime dependencies. Dev-only tooling is fine, but keep it optional.

### 2. Style

- 2-space indent, double quotes, semicolons.
- `var` in shipped files (matches the ES5-friendly style used throughout);
  `const`/`let` are fine in `scripts/`.
- Comments explain **why**, not what — especially around Skool-specific
  behaviour, which is the part most likely to confuse a future reader.
- Never log secrets, tokens or event data.

### 3. Skool-specific knowledge is centralised

Skool's markup and payload shape change. When you touch extraction:

- DOM selectors live in `content/extract.js → SELECTORS` (ordered candidate
  lists — **add** a candidate rather than replacing one).
- URL/API knowledge lives in `lib/constants.js`.
- The JSON field aliases live in `lib/events.js → FIELD_ALIASES`.

Keep these resilient: prefer structural/heuristic detection over a single exact
class name.

### 4. Tests

Two suites, both dependency-light:

| File | Scope |
|------|-------|
| `scripts/test.mjs` | Pure logic — ICS build/parse, dates, presets, series inference, payload normalisation. |
| `scripts/test-dom.mjs` | jsdom — the real Skool grid markup, `__NEXT_DATA__` payloads, the overlay, and the `collect()` merge pipeline. |

Guidelines:

- Add a test for any behaviour change. Regression tests for fixed bugs are
  especially welcome.
- Prefer asserting against the **real** shapes (see `scripts/fixtures/` and the
  captured payload fixtures) rather than invented ones.
- The sample `.ics` fixtures under `scripts/fixtures/` are committed so the suite
  is hermetic. Extra `.ics` files dropped in `../skool calendar` are picked up
  too.

Run everything with:

```bash
npm run check
```

### 5. Verify the store validators

Firefox ships a real validator; run it before opening a PR that touches the
manifest or build:

```bash
npm run build
npm run lint:firefox
```

It must report **0 errors**. Warnings should be addressed too — currently it
reports none.

## Submitting changes

1. Fork the repo and create a branch: `fix/malformed-uri`, `feat/preset-x`.
2. Keep commits focused and use a conventional-ish prefix: `fix:`, `feat:`,
   `docs:`, `test:`, `chore:`, `refactor:`.
3. Make sure `npm run check` passes and, if relevant, `npm run lint:firefox`.
4. Open a PR and fill in the template. Describe **what you observed** and **how
   you verified it** — for extraction changes, say which page/payload you tested
   against.

### Reporting a new Skool layout change

If extraction broke because Skool changed something, a useful issue includes:

- The community URL shape (redact the slug if you prefer).
- The event-card or day-cell `outerHTML`.
- The `pageProps` key shape from `__NEXT_DATA__` (redact personal data).
- What the popup showed (count, warnings).

See the "Maintaining the Skool extractor" section of the README.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
