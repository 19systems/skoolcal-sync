/*
 * scripts/test-dom.mjs — end-to-end tests of the extraction engine using jsdom.
 *
 * jsdom is an OPTIONAL dev dependency: if it isn't installed this test prints a
 * notice and exits 0, so `npm test` stays dependency-free.
 *
 *   npm install --no-save jsdom && node scripts/test-dom.mjs
 *
 * Two fixtures are exercised:
 *   1. The REAL Skool month grid (verified against the live DOM) — Monday-first
 *      cells with bare "2pm - Title" chips and a "Nairobi time" clock.
 *   2. A card-style view, to keep the generic selector path covered.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch (e) {
  console.log("jsdom not installed — skipping DOM tests. Run: npm install --no-save jsdom");
  process.exit(0);
}

const FILES = [
  "lib/constants.js", "lib/datetime.js", "lib/daterange.js", "lib/ics.js", "lib/events.js",
  "content/extract.js", "content/month-nav.js", "content/overlay.js"
];

function makeContext(html, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const context = dom.getInternalVMContext();
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  for (const file of FILES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  }
  return dom;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name + (detail ? "\n      " + detail : "")); }
}

/* ====================================================================== *
 * Fixture 1 — the real Skool month grid
 * ====================================================================== */

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// Chips keyed by ISO date (the grid starts on Mon 31 Aug 2026).
const GRID_EVENTS = {
  "2026-08-31": ["2pm - Brands Workshop with Himzo"],
  "2026-09-01": ["2pm - Brands Q&A with Ossama"],
  "2026-09-03": ["2pm - Influencers Q&A with Izak"],
  "2026-09-05": ["6pm - MINDSET MASTERCLASS W/$10M CEO"],
  "2026-09-06": ["4am - CANCELLED - Influencers Imam"]
};

function buildGridHtml() {
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const start = new Date(Date.UTC(2026, 7, 31)); // Mon 31 Aug 2026
  const rows = [];
  for (let w = 0; w < 6; w++) {
    const cells = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getTime() + (w * 7 + d) * 86400000);
      const iso = date.toISOString().slice(0, 10);
      const chips = (GRID_EVENTS[iso] || [])
        .map((t) => `<div class="sc-3e5122c2-17 faTkFW">${t.replace(/&/g, "&amp;")}</div>`)
        .join("");
      cells.push(`<div class="sc-3e5122c2-16 huYWcr"><span>${date.getUTCDate()}</span>${chips}</div>`);
    }
    rows.push(`<div class="sc-3e5122c2-14 eMymOh">${cells.join("")}</div>`);
  }
  return rows.join("");
}

const GRID_HTML = `<!DOCTYPE html><html><head><title>Calendar</title></head><body>
  <div id="calendar-wrapper" class="sc-fac87e65-0 fULMrq">
    <div class="sc-3e5122c2-0 cetXpH">
      <div class="sc-3e5122c2-1 kdrLcZ">
        <button type="button">Today</button>
        <button type="button" aria-label="Previous month">‹</button>
        <div style="display:flex;flex-direction:column">
          <div class="sc-3e5122c2-5 kcDgCs">September 2026</div>
          <a href="/settings?t=account" class="sc-fa2fe681-1 bHyDHp">
            <div class="sc-3e5122c2-6 ccfxQm">11:33am Nairobi time</div>
          </a>
        </div>
        <button type="button" aria-label="Next month">›</button>
      </div>
      <div class="sc-3e5122c2-14 eMymOh">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="sc-3e5122c2-15 QaIeP">${d}</div>`).join("")}</div>
      ${buildGridHtml()}
    </div>
  </div>
</body></html>`;

const gridDom = makeContext(GRID_HTML, "https://www.skool.com/ima/calendar");
const grid = gridDom.window.SkoolCal;

console.log("\nGrid: structure detection");
check("finds #calendar-wrapper as the root", grid.extract.findCalendarRoot().id === "calendar-wrapper");
check("parses the month label", JSON.stringify(grid.extract.parseMonthLabel("September 2026")) === '{"year":2026,"month":8}',
  JSON.stringify(grid.extract.parseMonthLabel("September 2026")));
check("detects Monday-first weeks", grid.extract.detectWeekStart(gridDom.window.document) === 1);
check("finds 42 day cells", grid.extract.findDayCells(gridDom.window.document).length === 42,
  String(grid.extract.findDayCells(gridDom.window.document).length));
check("grid starts on Mon 31 Aug", grid.extract.gridStartDate({ year: 2026, month: 8 }, 1).toISOString().slice(0, 10) === "2026-08-31");

console.log("\nGrid: timezone handling");
const tz = grid.extract.resolveTimeZone(gridDom.window.document, new Date("2026-09-15T08:33:00Z"));
check("reads the city name", tz.city === "Nairobi", tz.city);
check("maps city to IANA zone", tz.zone === "Africa/Nairobi", tz.zone);
check("derives +180 offset from the on-page clock", tz.offsetMinutes === 180, String(tz.offsetMinutes));
check("converts 2pm Nairobi to 11:00Z",
  grid.extract.localToUtc(2026, 8, 1, 14, 0, tz).toISOString() === "2026-09-01T11:00:00.000Z",
  grid.extract.localToUtc(2026, 8, 1, 14, 0, tz).toISOString());
check("normalizeOffset wraps + snaps", grid.extract.normalizeOffset(177) === 180 && grid.extract.normalizeOffset(-1435) === 0);

console.log("\nGrid: chip parsing");
const chip = grid.extract.parseChipText("5:30pm - Influencers Q&A with Izak");
check("parses time and title", chip && chip.hour === 17 && chip.minute === 30 && chip.title === "Influencers Q&A with Izak",
  JSON.stringify(chip));
check("flags cancelled events", grid.extract.parseChipText("4am - CANCELLED - Influencers Imam").cancelled === true);
check("handles noon correctly", grid.extract.parseChipText("12pm - Lunch").hour === 12);
check("handles midnight correctly", grid.extract.parseChipText("12am - Midnight").hour === 0);

console.log("\nGrid: extraction");
const gridResult = grid.extract.extractFromGrid();
check("extracts all 5 events", gridResult.events.length === 5, String(gridResult.events.length));
const byTitle = {};
gridResult.events.forEach((e) => { byTitle[e.title] = e; });
const ossama = byTitle["Brands Q&A with Ossama"];
check("strips the time prefix from the title", !!ossama);
check("places the spillover day (Aug 31) correctly",
  byTitle["Brands Workshop with Himzo"].start.toISOString() === "2026-08-31T11:00:00.000Z",
  byTitle["Brands Workshop with Himzo"].start.toISOString());
check("applies the timezone offset to the date",
  ossama.start.toISOString() === "2026-09-01T11:00:00.000Z", ossama.start.toISOString());
check("handles a 4am early event", byTitle["CANCELLED - Influencers Imam"].start.toISOString() === "2026-09-06T01:00:00.000Z");
check("marks cancelled events", byTitle["CANCELLED - Influencers Imam"].cancelled === true);
check("records the IANA timezone on the event", ossama.timezone === "Africa/Nairobi", ossama.timezone);
check("defaults a 1h duration", ossama.end - ossama.start === 3600000);
check("no .ics URLs exist in the grid", gridResult.icsUrls.length === 0);
check("extractFromDom surfaces the grid without card warnings",
  grid.extract.extractFromDom().events.length === 5 &&
  !grid.extract.extractFromDom().warnings.some((w) => /No event cards/.test(w)),
  JSON.stringify(grid.extract.extractFromDom().warnings));

console.log("\nPaging: bounded by the selected end date");
const gridDoc = gridDom.window.document;
const labelEl = gridDoc.querySelector(".sc-3e5122c2-5");
const nextBtn = gridDoc.querySelector('[aria-label="Next month"]');
let cursor = { year: 2026, month: 8 };
nextBtn.addEventListener("click", () => {
  cursor.month += 1;
  if (cursor.month > 11) { cursor.month = 0; cursor.year += 1; }
  labelEl.textContent = MONTHS_LONG[cursor.month] + " " + cursor.year;
});

const noTarget = await grid.monthNav.expand({ maxMonths: 12, timeout: 40 });
check("does NOT page without an end date", noTarget.clicks === 0 && noTarget.reason === "current-month-only",
  JSON.stringify(noTarget));

const withTarget = await grid.monthNav.expand({
  until: new Date(2026, 10, 30), // November 2026
  maxMonths: 12,
  timeout: 40
});
check("pages forward to the end date", withTarget.clicks === 2, JSON.stringify(withTarget));
check("stops on the target month", cursor.year === 2026 && cursor.month === 10, JSON.stringify(cursor));

const capped = await grid.monthNav.expand({
  until: new Date(2027, 5, 1),
  maxMonths: 3,
  timeout: 40
});
check("honours the hard cap", capped.clicks === 3, JSON.stringify(capped));

/* ====================================================================== *
 * Fixture 2 — card-style view (generic selector path)
 * ====================================================================== */

const ID_A = "9ce0133fb8994601aabeae55fac13b37";
const ID_B = "2e73ffbb2a7f45fb9bdd07e69f210d74";

const CARD_HTML = `<!DOCTYPE html><html><head><title>Calendar</title></head><body>
  <header><h1>The IMA Accelerator</h1></header>
  <main data-testid="calendar">
    <div class="event-card" data-event-id="${ID_A}">
      <a href="/ima/calendar/${ID_A}"><h3 class="event-title">Email/website Support call</h3></a>
      <time datetime="2026-09-27T17:30:00Z">Sep 27, 2026 5:30 PM</time>
      <time datetime="2026-09-27T18:00:00Z">6:00 PM</time>
      <p class="event-description">Having issues setting up your website? Join us.</p>
      <a href="https://meet.google.com/hwk-vnij-fgd">Join</a>
      <a href="/ima/calendar/${ID_A}.ics" download>Download .ics</a>
    </div>
    <div class="event-card" data-event-id="${ID_B}">
      <a href="/ima/calendar/${ID_B}"><h3 class="event-title">Influencers Q&amp;A with Izak</h3></a>
      <time datetime="2026-09-24T11:00:00Z">Sep 24, 2026 11:00 AM</time>
      <time datetime="2026-09-24T12:00:00Z">12:00 PM</time>
      <p class="event-description">Got questions? Come ask them live!</p>
      <a href="https://zoom.us/j/83972784947">Join</a>
    </div>
  </main>
  <script id="__NEXT_DATA__" type="application/json">
  {"props":{"pageProps":{"calendar":{"events":[
    {"id":"aa11bb22cc33dd44ee55ff6600112233","title":"Embedded Event","startTime":"2026-10-05T09:00:00Z","endTime":"2026-10-05T10:00:00Z","meetingUrl":"https://meet.google.com/xyz-abc-123"}
  ]}}}}
  </script>
</body></html>`;

const cardDom = makeContext(CARD_HTML, "https://www.skool.com/ima/calendar");
const card = cardDom.window.SkoolCal;

console.log("\nCards: extraction");
const cardResult = card.extract.extractFromDom();
check("finds both event cards", cardResult.events.length === 2, String(cardResult.events.length));
const first = cardResult.events.find((e) => e.title === "Email/website Support call");
check("reads exact start from <time datetime>", first.start.toISOString() === "2026-09-27T17:30:00.000Z");
check("reads end", first.end.toISOString() === "2026-09-27T18:00:00.000Z");
check("reads description", /website/.test(first.description), first.description);
check("detects meeting provider", first.meetingProvider === "Google Meet", first.meetingProvider);
check("extracts event id", first.eventId === ID_A, first.eventId);
check("builds absolute event url", first.url === "https://www.skool.com/ima/calendar/" + ID_A);
check("finds the .ics link", cardResult.icsUrls.some((u) => u.endsWith(ID_A + ".ics")), JSON.stringify(cardResult.icsUrls));
check("does not treat the event page as .ics", !cardResult.icsUrls.some((u) => u.endsWith("/" + ID_A)));

console.log("\nCards: embedded Next.js payload");
const embedded = card.extract.extractFromEmbeddedJson();
check("scavenges the __NEXT_DATA__ event", embedded.some((e) => e.title === "Embedded Event"));
check("normalises embedded times", embedded.find((e) => e.title === "Embedded Event").start.toISOString() === "2026-10-05T09:00:00.000Z");
check("normalises embedded meeting link", embedded.find((e) => e.title === "Embedded Event").meetingProvider === "Google Meet");

console.log("\nCards: collect() pipeline with mocked .ics fetch");
const ICS_A = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:Skool.com", "METHOD:REQUEST",
  "BEGIN:VEVENT",
  `UID:${ID_A}1790530200`,
  "DTSTART:20260927T173000Z", "DTEND:20260927T180000Z",
  "SUMMARY:Email/website Support call",
  "DESCRIPTION:Authoritative description.\\n\\nFrom: The IMA Accelerator",
  "LOCATION:https://meet.google.com/AAA-BBB-CCC",
  "END:VEVENT", "END:VCALENDAR", ""
].join("\r\n");

let fetchCalls = [];
cardDom.window.fetch = (url) => {
  fetchCalls.push(url);
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(ICS_A) });
};
card.capture = { getCaptures: () => [], getIcsUrls: () => [], request: () => {}, init: () => {} };

const collected = await card.extract.collect({
  fetchIcs: true, captureNetwork: false, community: "ima", communityName: "The IMA Accelerator"
});
check("fetched the discovered .ics", fetchCalls.some((u) => u.endsWith(ID_A + ".ics")), JSON.stringify(fetchCalls));
check("merges DOM + embedded + .ics into 3 events", collected.events.length === 3, String(collected.events.length));
const evA = collected.events.find((e) => e.eventId === ID_A);
check("fetched .ics overrides scraped data", evA && evA.source === "ics" && /AAA-BBB-CCC/.test(evA.location),
  evA && evA.source + " " + evA.location);
check("no duplicate for the same event", collected.events.filter((e) => e.eventId === ID_A).length === 1);
check("events are sorted by start", collected.events.every((e, i, a) => i === 0 || a[i - 1].start <= e.start));

console.log("\nRound-trip");
const merged = card.ICS.build(collected.events, { name: "IMA" });
check("merged ICS parses back to all events", card.ICS.parse(merged).events.length === collected.events.length);
check("merged ICS keeps the meeting link", merged.indexOf("meet.google.com") !== -1);

/* ====================================================================== *
 * Fixture 3 — the real server-rendered __NEXT_DATA__ payload
 * ====================================================================== */

function skoolEvent(id, occurrenceId, startTime, endTime, title, location) {
  return {
    id: id,
    occurrenceId: occurrenceId,
    startTime: startTime,
    endTime: endTime,
    groupId: "866d841bcb40438d86613587f4505c56",
    metadata: {
      title: title,
      description: "Description for " + title,
      timezone: "Europe/Belgrade",
      location: JSON.stringify({ location_type: 2, location_info: location })
    }
  };
}

const RECURRING_ID = "f385827b0cd34a6ba755eb665b9eb24a";
const NEXT_DATA = {
  props: {
    pageProps: {
      numCalendarEvents: 83,
      timezone: "Africa/Nairobi",
      currentGroup: { metadata: { displayName: "The IMA Accelerator" } },
      events: [
        skoolEvent(RECURRING_ID, "1827073800", "2027-11-24T17:30:00+01:00", "2027-11-24T18:30:00+01:00", "Roast my emails", "https://meet.google.com/hwk-vnij-fgd"),
        skoolEvent(RECURRING_ID, "1827153000", "2027-12-01T17:30:00+01:00", "2027-12-01T18:30:00+01:00", "Roast my emails", "https://meet.google.com/hwk-vnij-fgd"),
        skoolEvent("9ce0133fb8994601aabeae55fac13b37", "1827426600", "2027-11-28T19:30:00+01:00", "2027-11-28T20:00:00+01:00", "Email/website Support call", "https://meet.google.com/aaa-bbbb-ccc")
      ],
      // Next.js also mirrors the current month under renderData — dedupe must cope.
      renderData: {
        events: [
          skoolEvent(RECURRING_ID, "1827073800", "2027-11-24T17:30:00+01:00", "2027-11-24T18:30:00+01:00", "Roast my emails", "https://meet.google.com/hwk-vnij-fgd")
        ]
      }
    }
  }
};

const NEXT_HTML = `<!DOCTYPE html><html><body>
  <div id="calendar-wrapper"></div>
  <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(NEXT_DATA)}</script>
</body></html>`;

const nextDom = makeContext(NEXT_HTML, "https://www.skool.com/the-ima-accelerator-9388/calendar");
const next = nextDom.window.SkoolCal;

console.log("\nServer-rendered __NEXT_DATA__");
check("reads the expected event count", next.extract.extractExpectedCount() === 83, String(next.extract.extractExpectedCount()));
const embeddedReal = next.extract.extractFromEmbeddedJson();
check("scavenges every server-rendered occurrence", embeddedReal.length >= 3, String(embeddedReal.length));

nextDom.window.fetch = () => Promise.reject(new Error("no fetch expected"));
next.capture = { getCaptures: () => [], getIcsUrls: () => [], request: () => {}, init: () => {} };

const nextResult = await next.extract.collect({
  fetchIcs: false, captureNetwork: false, community: "the-ima-accelerator-9388", communityName: "The IMA Accelerator"
});
check("dedupes the mirrored renderData copy to 3 events", nextResult.events.length === 3, String(nextResult.events.length));
const roast = nextResult.events.filter((e) => e.title === "Roast my emails");
check("keeps the two occurrences of the series separate", roast.length === 2, String(roast.length));
check("occurrences have distinct UIDs", roast[0].uid !== roast[1].uid, roast.map((e) => e.uid).join(", "));
check("each occurrence keeps its own start",
  roast[0].start.getTime() !== roast[1].start.getTime() &&
  roast.map((e) => e.start.toISOString()).sort().join("|") ===
    ["2027-11-24T16:30:00.000Z", "2027-12-01T16:30:00.000Z"].join("|"),
  roast.map((e) => e.start.toISOString()).join(", "));
check("events carry the meeting link from the JSON location",
  roast[0].location === "https://meet.google.com/hwk-vnij-fgd" && roast[0].meetingProvider === "Google Meet");
check("warns that more months are available", nextResult.warnings.some((w) => w.indexOf("83") !== -1),
  JSON.stringify(nextResult.warnings));
check("round-trips to a valid multi-event ICS", next.ICS.parse(next.ICS.build(nextResult.events, { name: "IMA" })).events.length === 3);

/* ====================================================================== *
 * Page overlay
 * ====================================================================== */

console.log("\nPage overlay");
grid.overlay.show({ title: "Scanning calendar", detail: "Looking for events…" });
const host = gridDom.window.document.getElementById("skoolcal-sync-overlay");
check("creates the overlay host", !!host);
check("renders inside a shadow root", !!(host && host.shadowRoot));
check("shows the title", host.shadowRoot.textContent.indexOf("Scanning calendar") !== -1);

grid.overlay.update({ detail: "Loaded month 2…", progress: { done: 2, total: 4 } });
check("updates the detail text", host.shadowRoot.textContent.indexOf("Loaded month 2") !== -1);
const fill = host.shadowRoot.querySelector(".bar > i");
check("progress bar reflects done/total", fill.style.width === "50%", fill.style.width);

grid.overlay.update({ state: "done", detail: "5 events found" });
check("switches to the done state", host.shadowRoot.querySelector(".card").classList.contains("done"));
check("overlay does not disturb extraction", grid.extract.extractFromDom().events.length === 5,
  String(grid.extract.extractFromDom().events.length));
check("overlay is not found by the JSON scanner", grid.extract.extractFromEmbeddedJson().length === 0);

grid.overlay.hide(0);
await new Promise((r) => setTimeout(r, 280));
check("removes the overlay when hidden", !gridDom.window.document.getElementById("skoolcal-sync-overlay"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);