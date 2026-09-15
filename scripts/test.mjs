/*
 * scripts/test.mjs — dependency-free checks for the pure logic (ICS + events).
 *
 * Loads the classic-script lib files into this Node context (they only touch
 * globalThis), then exercises them against the real Skool .ics samples in
 * "../skool calendar" when present.
 *
 * Run: node scripts/test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const file of ["lib/constants.js", "lib/datetime.js", "lib/daterange.js", "lib/ics.js", "lib/events.js"]) {
  const code = fs.readFileSync(path.join(ROOT, file), "utf8");
  vm.runInThisContext(code, { filename: file });
}

const SC = globalThis.SkoolCal;
const { ICS, events: EV, dt } = SC;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.error("  ✗ " + name + (detail ? "\n      " + detail : ""));
  }
}

/* ---- 1. datetime ------------------------------------------------------- */
console.log("\ndatetime");
check("parses ICS compact UTC", dt.toIcsUtc(dt.fromIcsDate("20260927T173000Z")) === "20260927T173000Z");
check("parses epoch seconds", dt.parseDate(1790530200).toISOString() === new Date(1790530200 * 1000).toISOString());
check("parses ISO", dt.parseDate("2026-09-27T17:30:00Z") instanceof Date);
check("rejects junk", dt.parseDate("not a date") === null);
check("addMonths clamps", dt.toInputDate(dt.addMonths(new Date("2026-01-31T00:00:00Z"), 1)) === "2026-02-28");

/* ---- 1b. date presets -------------------------------------------------- */
console.log("\nDate presets");
const DR = SC.daterange;
const NOW = new Date(2026, 8, 16, 12, 0, 0); // Wednesday 16 Sep 2026
check("this month spans the calendar month", (function () {
  const r = DR.resolve("month", NOW);
  return r.from.getDate() === 1 && r.from.getMonth() === 8 && r.to.getDate() === 30 && r.to.getMonth() === 8;
})());
check("this week is Monday-first", (function () {
  const r = DR.resolve("week", NOW);
  return r.from.getDay() === 1 && r.from.getDate() === 14 && r.to.getDay() === 0 && r.to.getDate() === 20;
})());
check("today is a single day", (function () {
  const r = DR.resolve("today", NOW);
  return r.from.getDate() === 16 && r.to.getDate() === 16 && r.from.getHours() === 0 && r.to.getHours() === 23;
})());
check("this year spans Jan 1 – Dec 31", (function () {
  const r = DR.resolve("year", NOW);
  return r.from.getMonth() === 0 && r.from.getDate() === 1 && r.to.getMonth() === 11 && r.to.getDate() === 31;
})());
check("till year end starts today", (function () {
  const r = DR.resolve("tillYearEnd", NOW);
  return r.from.getDate() === 16 && r.to.getMonth() === 11 && r.to.getDate() === 31;
})());
check("next 30 days reaches into October", (function () {
  const r = DR.resolve("next30", NOW);
  return r.to.getMonth() === 9 && r.to.getDate() === 16;
})());
check("all time has no bounds", (function () {
  const r = DR.resolve("all", NOW);
  return r.from === null && r.to === null;
})());
check("default preset is this month", DR.resolveRange({}, NOW).to.getMonth() === 8);
check("needsPaging false for this month", DR.needsPaging(DR.resolve("month", NOW), NOW) === false);
check("needsPaging false for all time", DR.needsPaging(DR.resolve("all", NOW), NOW) === false);
check("needsPaging true for this year (September)", DR.needsPaging(DR.resolve("year", NOW), NOW) === true);
check("needsPaging true for next 30 days", DR.needsPaging(DR.resolve("next30", NOW), NOW) === true);

/* ---- 1c. past-event filtering ----------------------------------------- */
console.log("\nPast events");
const pastNow = new Date("2026-09-16T12:00:00Z");
check("an event that already ended is past",
  EV.isPast({ start: new Date("2026-09-15T10:00:00Z"), end: new Date("2026-09-15T11:00:00Z") }, pastNow) === true);
check("an event later today is not past",
  EV.isPast({ start: new Date("2026-09-16T18:00:00Z"), end: new Date("2026-09-16T19:00:00Z") }, pastNow) === false);
check("an in-progress event is not past",
  EV.isPast({ start: new Date("2026-09-16T11:30:00Z"), end: new Date("2026-09-16T12:30:00Z") }, pastNow) === false);
check("an event with no end falls back to its start",
  EV.isPast({ start: new Date("2026-09-16T11:00:00Z"), end: null }, pastNow) === true);
check("missing start is never past", EV.isPast({ title: "x" }, pastNow) === false);

/* ---- 2. ICS escaping / folding ---------------------------------------- */console.log("\nICS primitives");
check("escapes commas and semicolons", ICS.escapeText("a,b;c") === "a\\,b\\;c");
check("escapes newlines", ICS.escapeText("a\nb") === "a\\nb");
check("unescapes round-trip", ICS.unescapeText(ICS.escapeText("x,y;z\nw\\v")) === "x,y;z\nw\\v");
const longLine = "SUMMARY:" + "ä".repeat(120);
check("folds long lines to <=75 octets", ICS.foldLine(longLine).split("\r\n ").every((l) => ICS.byteLength(l) <= 75));

/* ---- 3. round-trip a single event ------------------------------------- */
console.log("\nICS build");
const sample = {
  uid: "abc",
  title: "Weekly Q&A, with commas; and semis",
  description: "Line one\nLine two",
  location: "https://meet.google.com/abc-defg-hij",
  start: new Date("2026-09-27T17:30:00Z"),
  end: new Date("2026-09-27T18:00:00Z"),
  timezone: "UTC",
  recurring: true,
  rrule: "FREQ=WEEKLY;BYDAY=SU",
  community: "ima",
  eventId: "9ce0133fb8994601aabeae55fac13b37"
};
const built = ICS.buildOne(sample, { name: "Test" });
check("uses CRLF line endings", built.indexOf("\r\n") !== -1 && !/[^\r]\n/.test(built));
check("contains RRULE", built.indexOf("RRULE:FREQ=WEEKLY;BYDAY=SU") !== -1);
check("no physical line exceeds 75 octets", built.split("\r\n").every((l) => ICS.byteLength(l) <= 75));
const reparsed = ICS.parse(built).events[0];
check("round-trips title", reparsed.title === sample.title, reparsed.title);
check("round-trips description", reparsed.description === sample.description);
check("round-trips start", reparsed.start.toISOString() === sample.start.toISOString());
check("round-trips rrule", reparsed.rrule === "FREQ=WEEKLY;BYDAY=SU");

/* ---- 3b. Unicode / surrogate safety ----------------------------------- */
console.log("\nUnicode folding (regression: 'malformed URI sequence')");
check("folds emoji without splitting surrogate pairs", (function () {
  try {
    var folded = ICS.foldLine("DESCRIPTION:" + "🔥".repeat(60));
    encodeURIComponent(folded); // throws URIError if a pair was split
    return folded.replace(/\r\n /g, "") === "DESCRIPTION:" + "🔥".repeat(60);
  } catch (e) { return false; }
})());
check("folded emoji lines stay within 75 octets",
  ICS.foldLine("SUMMARY:" + "🔥".repeat(60)).split("\r\n ").every((l) => ICS.byteLength(l) <= 75));

const emojiEvent = {
  uid: "emoji@test",
  title: "Roast my emails 🔥",
  description: "aikido 😤 mindset 💪 " + "🔥".repeat(80),
  location: "https://meet.google.com/x",
  start: new Date("2026-09-27T17:30:00Z"),
  end: new Date("2026-09-27T18:30:00Z"),
  timezone: "UTC"
};
const emojiIcs = ICS.build([emojiEvent], { name: "IMA 🔥" });
check("built ICS with emoji is URI-safe", (function () {
  try { encodeURIComponent(emojiIcs); return true; } catch (e) { return false; }
})());
check("emoji survive an ICS round-trip",
  ICS.parse(emojiIcs).events[0].description === emojiEvent.description);
check("emoji title survives an ICS round-trip",
  ICS.parse(emojiIcs).events[0].title === emojiEvent.title);

/* ---- 4. real Skool .ics samples --------------------------------------- */
console.log("\nSkool .ics samples");
// Fixtures are committed under scripts/fixtures so the suite is hermetic.
// Any extra .ics dropped into ../skool calendar are picked up too.
const FIXTURE_DIR = path.join(ROOT, "scripts", "fixtures");
const EXTRA_DIR = path.resolve(ROOT, "..", "skool calendar");
const sampleDirs = [FIXTURE_DIR, EXTRA_DIR].filter((d) => fs.existsSync(d));

const sampleFiles = [];
for (const dir of sampleDirs) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".ics") && !sampleFiles.some((s) => s.name === name)) {
      sampleFiles.push({ name, file: path.join(dir, name) });
    }
  }
}
check("found sample .ics files", sampleFiles.length > 0,
  `looked in ${sampleDirs.join(", ") || "(none)"}`);

const parsedAll = [];
for (const sample of sampleFiles) {
  const parsed = ICS.parse(fs.readFileSync(sample.file, "utf8"));
  const ev = parsed.events[0] && EV.fromIcs(parsed.events[0], { community: "ima" });
  if (ev) parsedAll.push(ev);
}
check("every sample parsed into an event", parsedAll.length === sampleFiles.length,
  `${parsedAll.length} of ${sampleFiles.length}`);

const withTitles = parsedAll.filter((e) => e.title && e.start && e.end);
check("samples have title/start/end", withTitles.length === parsedAll.length);
check("community name extracted from 'From:' line",
  parsedAll.some((e) => e.communityName === "The IMA Accelerator"),
  parsedAll[0] && parsedAll[0].communityName);
check("Skool UID decoded into eventId + start",
  parsedAll.every((e) => /^[0-9a-f]{32}$/.test(e.eventId || "")),
  parsedAll.find((e) => !/^[0-9a-f]{32}$/.test(e.eventId || ""))?.uid);
check("meeting provider detected",
  parsedAll.some((e) => e.meetingProvider === "Google Meet") &&
  parsedAll.some((e) => e.meetingProvider === "Zoom"));

/* ---- 5. merge output of all samples ----------------------------------- */
const merged = ICS.build(parsedAll, { name: "IMA" });
const mergedParsed = ICS.parse(merged);
check("merged file keeps every event", mergedParsed.events.length === parsedAll.length,
  `${mergedParsed.events.length} vs ${parsedAll.length}`);
check("merged file is RFC-clean", merged.split("\r\n").every((l) => ICS.byteLength(l) <= 75));
check("merged file parses with no error", merged.startsWith("BEGIN:VCALENDAR") && merged.trimEnd().endsWith("END:VCALENDAR"));

/* ---- 6. dedupe + series inference ------------------------------------- */
console.log("\nDedupe & recurring series");
check("dedupe is idempotent", EV.dedupe(parsedAll).length === parsedAll.length,
  `${EV.dedupe(parsedAll).length} vs ${parsedAll.length}`);
check("dedupe removes exact duplicates", EV.dedupe(parsedAll.concat(parsedAll)).length === parsedAll.length);

// Reproduces the real pattern: a series that runs on Mondays AND Thursdays,
// with the start time drifting slightly between occurrences (as Skool's does).
function seriesEvent(title, iso) {
  return EV.normalize({ title: title, start: iso, end: new Date(new Date(iso).getTime() + 3600000).toISOString() },
    { source: "json", community: "ima" });
}
const izak = [
  seriesEvent("Influencers Q&A with Izak", "2026-09-07T14:30:00Z"),
  seriesEvent("Influencers Q&A with Izak", "2026-09-10T11:00:00Z"),
  seriesEvent("Influencers Q&A with Izak", "2026-09-14T14:30:00Z"),
  seriesEvent("Influencers Q&A with Izak", "2026-09-17T11:00:00Z"),
  seriesEvent("Influencers Q&A with Izak", "2026-09-21T14:00:00Z"),
  seriesEvent("Influencers Q&A with Izak", "2026-09-24T11:00:00Z"),
  seriesEvent("Influencers Q&A with Izak", "2026-09-28T14:00:00Z"),
  seriesEvent("Influencers Q&A with Izak", "2026-10-01T11:00:00Z")
];
const groups = EV.groupSeries(izak);
const izakGroup = Object.values(groups)[0];
check("weekly series inferred for a Mon+Thu pattern",
  izakGroup && izakGroup.rrule === "FREQ=WEEKLY;BYDAY=MO,TH",
  izakGroup && izakGroup.rrule);
const collapsed = EV.collapseSeries(izak);
check("collapseSeries splits multi-weekday series",
  collapsed.length === 2 && collapsed.every((c) => c.recurring) &&
  collapsed.map((c) => c.rrule).sort().join("|") === "FREQ=WEEKLY;BYDAY=MO|FREQ=WEEKLY;BYDAY=TH",
  JSON.stringify(collapsed.map((c) => c.rrule)));

/* ---- 7. Google Calendar body ------------------------------------------ */
console.log("\nGoogle Calendar mapping");
const body = EV.toGoogleEvent(parsedAll[0], { timezone: "UTC" });
check("body has RFC3339 start", /^\d{4}-\d{2}-\d{2}T.*Z$/.test(body.start.dateTime), body.start.dateTime);
check("body has iCalUID", !!body.iCalUID);
check("body has no attendees", body.attendees === undefined);
check("body carries provenance", body.extendedProperties.private.skoolcalSource === "skoolcal-sync");

const link = EV.googleTemplateLink(parsedAll[0]);
check("template link is well formed", /^https:\/\/calendar\.google\.com\/calendar\/render\?/.test(link) && link.includes("dates="));

/* ---- 8. JSON scavenging ----------------------------------------------- */
console.log("\nEmbedded JSON scavenging");
const payload = {
  props: {
    pageProps: {
      calendar: {
        events: [
          { id: "deadbeef", title: "Scavenged", startTime: "2026-10-01T10:00:00Z", endTime: "2026-10-01T11:00:00Z", locationUrl: "https://zoom.us/j/123" },
          { name: "Second", startsAt: 1790000000, durationMinutes: 45 }
        ]
      }
    }
  }
};
const scavenged = EV.scavengeEvents(payload, { source: "json", community: "x" });
check("finds nested events", scavenged.length === 2, String(scavenged.length));
check("normalises aliases", scavenged.some((e) => e.title === "Second" && e.end && e.end > e.start));
check("derives duration", scavenged.find((e) => e.title === "Second").end - scavenged.find((e) => e.title === "Second").start === 45 * 60000);

/* ---- 9. the REAL Skool API payload ------------------------------------ */
console.log("\nReal Skool API payload");
const apiEvent = {
  id: "f385827b0cd34a6ba755eb665b9eb24a",
  occurrenceId: "1827073800",
  startTime: "2027-11-24T17:30:00+01:00",
  endTime: "2027-11-24T18:30:00+01:00",
  groupId: "866d841bcb40438d86613587f4505c56",
  metadata: {
    coverImage: "",
    description: "Special call all about submitting your emails for the coaches to roast.",
    hasAccess: 1,
    location: '{"location_type":2,"location_info":"https://meet.google.com/hwk-vnij-fgd"}',
    reminderDisabled: 1,
    timezone: "Europe/Belgrade",
    title: "Roast my emails"
  }
};
const real = EV.scavengeEvents(
  { props: { pageProps: { events: [apiEvent], numCalendarEvents: 83 } } },
  { source: "json", community: "ima" }
);
check("scavenges metadata-nested events", real.length === 1, String(real.length));
const r0 = real[0];
check("reads the nested title", r0.title === "Roast my emails", r0.title);
check("parses the offset startTime to the exact instant",
  r0.start.toISOString() === new Date("2027-11-24T17:30:00+01:00").toISOString(), r0.start.toISOString());
check("unwraps the JSON location string", r0.location === "https://meet.google.com/hwk-vnij-fgd", r0.location);
check("detects the provider from the JSON location", r0.meetingProvider === "Google Meet", r0.meetingProvider);
check("reads the description", /roast/.test(r0.description));
check("captures occurrenceId", r0.occurrenceId === "1827073800", r0.occurrenceId);
check("builds Skool's own UID format", r0.uid === "f385827b0cd34a6ba755eb665b9eb24a1827073800", r0.uid);
// Cross-check against a real .ics Skool produced: its UID is exactly
// "<event id><occurrenceId>" — so our exports dedupe against hand downloads.
const realUid = EV.normalize({
  id: "2e73ffbb2a7f45fb9bdd07e69f210d74",
  occurrenceId: "1790247600",
  startTime: "2026-09-24T11:00:00Z",
  metadata: { title: "Influencers Q&A with Izak" }
}, { source: "json" }).uid;
check("UID matches Skool's own .ics UID exactly",
  realUid === "2e73ffbb2a7f45fb9bdd07e69f210d741790247600", realUid);
check("carries the event timezone", r0.timezone === "Europe/Belgrade", r0.timezone);

const occurrence2 = Object.assign({}, apiEvent, {
  occurrenceId: "1827153000",
  startTime: "2027-12-01T17:30:00+01:00",
  endTime: "2027-12-01T18:30:00+01:00"
});
const series = EV.scavengeEvents({ events: [apiEvent, occurrence2] }, { source: "json", community: "ima" });
check("keeps occurrences of a series distinct",
  series.length === 2 && series[0].uid !== series[1].uid, JSON.stringify(series.map((e) => e.uid)));
check("dedupe treats occurrences as separate events", EV.dedupe(series).length === 2, String(EV.dedupe(series).length));

/* ---- summary ---------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
