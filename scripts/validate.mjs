/*
 * scripts/validate.mjs — validate the BUILT extension in dist/.
 *
 * Run after `npm run build`. This is the check that catches Chrome/Firefox
 * drift, missing files, accidental broad permissions and remote code — the
 * things that get an extension rejected or broken on one store but not the
 * other.
 *
 * Run: npm run validate
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

let failures = 0;
function fail(msg) { failures++; console.error("  \u2717 " + msg); }
function ok(msg) { console.log("  \u2713 " + msg); }

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${path.relative(ROOT, file)} is not valid JSON: ${e.message}`);
    return null;
  }
}

if (!fs.existsSync(DIST)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const pkg = readJson(path.join(ROOT, "package.json"));
const base = readJson(path.join(ROOT, "manifest.json"));
const targets = {
  chrome: readJson(path.join(DIST, "chrome", "manifest.json")),
  firefox: readJson(path.join(DIST, "firefox", "manifest.json"))
};

const ALLOWED_PERMISSIONS = new Set(["storage", "identity", "notifications", "alarms"]);
const ALLOWED_HOSTS = [
  "https://skool.com/*",
  "https://*.skool.com/*",
  "https://www.googleapis.com/*",
  "https://oauth2.googleapis.com/*"
];

function collectRefs(m) {
  const refs = new Set();
  Object.values(m.icons || {}).forEach((p) => refs.add(p));
  const action = m.action || {};
  Object.values(action.default_icon || {}).forEach((p) => refs.add(p));
  if (action.default_popup) refs.add(action.default_popup);
  if (m.options_ui && m.options_ui.page) refs.add(m.options_ui.page);
  if (m.background && m.background.service_worker) refs.add(m.background.service_worker);
  (m.background && m.background.scripts ? m.background.scripts : []).forEach((p) => refs.add(p));
  (m.content_scripts || []).forEach((cs) => (cs.js || []).forEach((p) => refs.add(p)));
  (m.web_accessible_resources || []).forEach((war) => (war.resources || []).forEach((p) => refs.add(p)));
  return refs;
}

/* ---- shared invariants ------------------------------------------------ */
console.log("Shared");
const sharedBefore = failures;
for (const [name, m] of Object.entries(targets)) {
  if (!m) continue;
  if (m.manifest_version !== 3) fail(`${name}: manifest_version must be 3`);
  if (m.version !== base.version) fail(`${name}: version ${m.version} != manifest.json ${base.version}`);
  if (m.version !== pkg.version) fail(`${name}: version ${m.version} != package.json ${pkg.version}`);
  if (!m.name || !m.description) fail(`${name}: name and description are required`);

  const dir = path.join(DIST, name);
  for (const rel of collectRefs(m)) {
    if (!fs.existsSync(path.join(dir, rel))) fail(`${name}: referenced file is missing: ${rel}`);
  }

  for (const p of m.permissions || []) {
    if (!ALLOWED_PERMISSIONS.has(p)) fail(`${name}: unexpected permission "${p}"`);
  }
  for (const h of m.host_permissions || []) {
    if (!ALLOWED_HOSTS.includes(h)) fail(`${name}: unexpected host permission "${h}"`);
  }
  if (m.host_permissions && m.host_permissions.some((h) => /<all_urls>|\*:\/\/\*/.test(h))) {
    fail(`${name}: overly broad host permission`);
  }

  const csp = JSON.stringify(m.content_security_policy || {});
  if (/https?:\/\//.test(csp)) fail(`${name}: CSP references a remote origin (no remote code allowed)`);

  const cs = (m.content_scripts || [])[0];
  if (!cs) {
    fail(`${name}: no content script for skool.com`);
  } else {
    const js = cs.js || [];
    if (js[0] !== "lib/browser.js") fail(`${name}: content_scripts must start with lib/browser.js`);
    if (js[js.length - 1] !== "content/content.js") fail(`${name}: content/content.js must load last`);
    if (!js.includes("content/overlay.js")) fail(`${name}: content/overlay.js missing from content scripts`);
    if (!cs.matches || !cs.matches.some((mm) => mm.includes("skool.com"))) {
      fail(`${name}: content script does not match skool.com`);
    }
  }

  // The page-world hook must be declared separately with world: MAIN.
  const main = (m.content_scripts || []).find((c) => c.world === "MAIN");
  if (!main || !(main.js || []).includes("content/injected.js")) {
    fail(`${name}: content/injected.js must be declared with world: "MAIN"`);
  }
}
if (failures === sharedBefore) ok("version, references, permissions and CSP checked");

/* ---- Chrome specifics ------------------------------------------------- */
console.log("Chrome");
const chromeBefore = failures;
const chrome = targets.chrome;
if (chrome) {
  if (!chrome.background || !chrome.background.service_worker) {
    fail("chrome: background.service_worker is required");
  }
  if (chrome.background && chrome.background.scripts) {
    fail("chrome: background.scripts is MV2-only and unsupported");
  }
  if (chrome.browser_specific_settings) fail("chrome: browser_specific_settings must not be present");
  if (!chrome.minimum_chrome_version) fail("chrome: minimum_chrome_version is missing");
}
if (failures === chromeBefore) ok("service worker manifest looks correct");

/* ---- Firefox specifics ------------------------------------------------ */
console.log("Firefox");
const firefoxBefore = failures;
const firefox = targets.firefox;
if (firefox) {
  const bg = firefox.background || {};
  if (!Array.isArray(bg.scripts) || !bg.scripts.length) {
    fail("firefox: background.scripts (array) is required");
  } else {
    if (bg.scripts[0] !== "lib/browser.js") fail("firefox: background.scripts must start with lib/browser.js");
    if (bg.scripts[bg.scripts.length - 1] !== "background/service-worker.js") {
      fail("firefox: background/service-worker.js must load last");
    }
    if (!bg.scripts.includes("background/google.js") || !bg.scripts.includes("background/notifications.js")) {
      fail("firefox: background scripts are missing a dependency");
    }
  }
  if (bg.service_worker) fail("firefox: service_worker is not supported");
  if (firefox.minimum_chrome_version) fail("firefox: minimum_chrome_version must not be present");

  const gecko = (firefox.browser_specific_settings || {}).gecko;
  if (!gecko || !gecko.id) fail("firefox: browser_specific_settings.gecko.id is required");
  if (gecko && !gecko.strict_min_version) fail("firefox: gecko.strict_min_version is required");
  if (gecko && !gecko.data_collection_permissions) {
    fail("firefox: gecko.data_collection_permissions is required by AMO");
  }
}
if (failures === firefoxBefore) ok("background scripts and gecko settings look correct");

/* ---- summary ---------------------------------------------------------- */
if (failures) {
  console.error(`\n${failures} validation problem(s) found.`);
  process.exit(1);
}
console.log("\nAll dist validation checks passed.");
