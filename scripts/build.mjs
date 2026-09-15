/*
 * scripts/build.mjs — produce dist/chrome and dist/firefox.
 *
 * The only meaningful manifest difference is the background entry:
 *   Chrome  -> background.service_worker (classic SW, uses importScripts)
 *   Firefox -> background.scripts (event page; the same files, loaded in order)
 * Everything else is shared verbatim, so there is a single source of truth.
 *
 * Run: npm run build
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const COPY_DIRS = ["lib", "background", "content", "popup", "options", "icons"];

// Order matters: later files use globals defined by earlier ones.
const BACKGROUND_SCRIPTS = [
  "lib/browser.js",
  "lib/constants.js",
  "lib/datetime.js",
  "lib/ics.js",
  "lib/events.js",
  "lib/storage.js",
  "lib/messaging.js",
  "background/google.js",
  "background/notifications.js",
  "background/service-worker.js"
];

const GECKO_ID = "skoolcal-sync@skoolcal.dev";

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function buildChrome() {
  const dir = path.join(DIST, "chrome");
  fs.mkdirSync(dir, { recursive: true });
  const manifest = readManifest();
  writeManifest(dir, manifest);
  for (const d of COPY_DIRS) copyDir(path.join(ROOT, d), path.join(dir, d));
  return dir;
}

function buildFirefox() {
  const dir = path.join(DIST, "firefox");
  fs.mkdirSync(dir, { recursive: true });
  const manifest = readManifest();

  delete manifest.minimum_chrome_version;
  manifest.background = { scripts: BACKGROUND_SCRIPTS };
  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      // 140: first desktop release that understands
      // browser_specific_settings.gecko.data_collection_permissions (required
      // by AMO for new submissions). content_scripts.world = MAIN needs 128+.
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] }
    },
    gecko_android: {
      // Android shipped data_collection_permissions in 142.
      strict_min_version: "142.0"
    }
  };

  writeManifest(dir, manifest);
  for (const d of COPY_DIRS) copyDir(path.join(ROOT, d), path.join(dir, d));
  return dir;
}

function ensureIcons() {
  const missing = [16, 32, 48, 128].some((s) => !fs.existsSync(path.join(ROOT, "icons", `icon${s}.png`)));
  if (missing) {
    console.log("icons missing — generating…");
    return import("./make-icons.mjs");
  }
  return Promise.resolve();
}

await ensureIcons();
rmrf(DIST);
const chromeDir = buildChrome();
const firefoxDir = buildFirefox();

console.log("Built:");
console.log("  " + path.relative(ROOT, chromeDir));
console.log("  " + path.relative(ROOT, firefoxDir));
console.log("\nLoad unpacked: chrome://extensions (Developer mode) or about:debugging (Firefox).");
