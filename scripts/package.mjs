/*
 * scripts/package.mjs — zip dist/chrome and dist/firefox for the stores.
 *
 * Uses the system `zip` binary (present on macOS and Linux). Produces:
 *   dist/skoolcal-sync-chrome.zip
 *   dist/skoolcal-sync-firefox.zip
 *
 * Run: npm run package   (builds first)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function zip(sourceDir, outFile) {
  if (fs.existsSync(outFile)) fs.rmSync(outFile);
  // -r recurse, -X strip extra attributes, -q quiet
  execFileSync("zip", ["-r", "-X", "-q", outFile, "."], { cwd: sourceDir, stdio: "inherit" });
  const size = fs.statSync(outFile).size;
  console.log(`  ${path.relative(ROOT, outFile)} (${(size / 1024).toFixed(1)} KB)`);
}

if (!fs.existsSync(path.join(DIST, "chrome")) || !fs.existsSync(path.join(DIST, "firefox"))) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

console.log("Packaging:");
zip(path.join(DIST, "chrome"), path.join(DIST, "skoolcal-sync-chrome.zip"));
zip(path.join(DIST, "firefox"), path.join(DIST, "skoolcal-sync-firefox.zip"));

console.log("\nUpload skoolcal-sync-chrome.zip to the Chrome Web Store and");
console.log("skoolcal-sync-firefox.zip to addons.mozilla.org (or sign it with web-ext).");
