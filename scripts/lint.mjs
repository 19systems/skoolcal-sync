/*
 * scripts/lint.mjs — dependency-free sanity checks.
 *
 *  1. `node --check` every source file (syntax errors).
 *  2. Parse manifest.json.
 *  3. Verify every file the manifest references actually exists.
 *  4. Verify every file referenced by the manifest is listed for content scripts
 *     in dependency order (cheap guard against a missing lib).
 *
 * Run: npm run lint
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["lib", "background", "content", "popup", "options"];

let failures = 0;

function fail(message) {
  failures++;
  console.error("  ✗ " + message);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/* 1. syntax check */
const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
console.log(`Syntax-checking ${files.length} files…`);
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    fail(`${path.relative(ROOT, file)}\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}

/* 2 + 3. manifest integrity */
console.log("Checking manifest.json…");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
} catch (err) {
  fail("manifest.json is not valid JSON: " + err.message);
}

if (manifest) {
  const referenced = new Set();
  Object.values(manifest.icons || {}).forEach((p) => referenced.add(p));
  Object.values((manifest.action && manifest.action.default_icon) || {}).forEach((p) => referenced.add(p));
  if (manifest.action && manifest.action.default_popup) referenced.add(manifest.action.default_popup);
  if (manifest.options_ui && manifest.options_ui.page) referenced.add(manifest.options_ui.page);
  if (manifest.background && manifest.background.service_worker) referenced.add(manifest.background.service_worker);
  (manifest.content_scripts || []).forEach((cs) => (cs.js || []).forEach((p) => referenced.add(p)));
  ((manifest.web_accessible_resources || [])[0]?.resources || []).forEach((p) => referenced.add(p));

  for (const rel of referenced) {
    if (!fs.existsSync(path.join(ROOT, rel))) fail(`manifest references missing file: ${rel}`);
  }

  // HTML pages must exist and must load their scripts with correct relative paths.
  for (const page of [manifest.action?.default_popup, manifest.options_ui?.page].filter(Boolean)) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    const dir = path.dirname(page);
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    for (const src of srcs) {
      if (/^https?:/.test(src)) continue;
      const resolved = path.normalize(path.join(ROOT, dir, src));
      if (!fs.existsSync(resolved)) fail(`${page} loads missing script: ${src}`);
    }
  }

  // Content scripts must be listed in an order where dependencies come first.
  const cs = (manifest.content_scripts || [])[0];
  if (cs) {
    const order = cs.js;
    const idx = (f) => order.indexOf(f);
    const deps = [
      ["lib/constants.js", "lib/browser.js"],
      ["lib/daterange.js", "lib/datetime.js"],
      ["lib/ics.js", "lib/datetime.js"],
      ["lib/events.js", "lib/ics.js"],
      ["content/content.js", "content/extract.js"],
      ["content/content.js", "content/overlay.js"],
      ["content/content.js", "lib/daterange.js"],
      ["content/extract.js", "lib/events.js"]
    ];
    for (const [after, before] of deps) {
      if (idx(after) !== -1 && idx(before) !== -1 && idx(before) > idx(after)) {
        fail(`content_scripts order: ${before} must come before ${after}`);
      }
    }
  }
}

if (failures) {
  console.error(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
