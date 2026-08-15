/**
 * Kaoz Emporium — calendar feed generator (GitHub Actions version)
 * ------------------------------------------------------------------
 * Standalone script (no Cloud Functions / Blaze plan needed) that:
 *   1. Reads approved events + subscribed external calendars from Firestore
 *      using a service account (read-only is all it needs).
 *   2. Fetches each subscribed .ics feed directly (server-to-server, so no
 *      CORS proxy needed here, unlike the in-app client-side version).
 *   3. Writes the combined result to public/calendar.ics.
 *
 * Run on a schedule by .github/workflows/calendar-feed.yml, which then
 * publishes the public/ folder to GitHub Pages. Every run regenerates the
 * file fresh, so "auto-updating" here means "as fresh as the last scheduled
 * run" (every 30 min by default) rather than instant-per-request — a fair
 * trade for not needing any paid infrastructure.
 *
 * Required env var: FIREBASE_SERVICE_ACCOUNT_KEY — the full JSON contents
 * of a Firebase service account key (Firebase console → Project Settings →
 * Service Accounts → Generate new private key), stored as a GitHub Actions
 * secret. Read-only Firestore access — this script never writes anything
 * back to Firestore.
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const RECUR_HORIZON_DAYS = 182;
const LOOKBACK_DAYS = 30;

function pad(n){ return String(n).padStart(2, "0"); }
function toDateStr(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function addDays(dateStr, days){
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}
function icsDateStamp(){
  const d = new Date();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function icsFloatingValue(dateStr, timeStr){
  const datePart = dateStr.replace(/-/g, "");
  if(!timeStr) return { value: datePart, allDay: true };
  const [h, m] = timeStr.split(":");
  return { value: `${datePart}T${pad(+h)}${pad(+m)}00`, allDay: false };
}
function icsEscape(text){
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
function foldLine(line){
  if(line.length <= 75) return line;
  let out = line.slice(0, 75);
  let rest = line.slice(75);
  while(rest.length > 0){
    out += "\r\n " + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return out;
}
function buildEvent({ uid, title, notes, dateStr, timeStr, rrule, sourceLabel }){
  const { value, allDay } = icsFloatingValue(dateStr, timeStr);
  const lines = ["BEGIN:VEVENT"];
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${icsDateStamp()}`);
  lines.push(allDay ? `DTSTART;VALUE=DATE:${value}` : `DTSTART:${value}`);
  lines.push(`SUMMARY:${icsEscape(title)}`);
  const desc = [notes, sourceLabel].filter(Boolean).join("\n\n");
  if(desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
  if(rrule) lines.push(`RRULE:${rrule}`);
  lines.push("END:VEVENT");
  return lines.map(foldLine).join("\r\n");
}
function rruleFor(repeat, startDateStr, timeStr, repeatUntil){
  const freq = { daily: "DAILY", weekly: "WEEKLY", biweekly: "WEEKLY", monthly: "MONTHLY" }[repeat];
  if(!freq) return null;
  const interval = repeat === "biweekly" ? ";INTERVAL=2" : "";
  const untilDateStr = repeatUntil || addDays(startDateStr, RECUR_HORIZON_DAYS);
  const { value: untilValue, allDay } = icsFloatingValue(untilDateStr, timeStr);
  const until = allDay ? `${untilValue}T235959` : untilValue;
  return `FREQ=${freq}${interval};UNTIL=${until}`;
}

function icsUnfold(text){
  return text.replace(/\r\n/g, "\n").split("\n").reduce((lines, line) => {
    if((line.startsWith(" ") || line.startsWith("\t")) && lines.length){
      lines[lines.length - 1] += line.slice(1);
    }else{
      lines.push(line);
    }
    return lines;
  }, []);
}
function icsUnescapeIncoming(text){
  return text.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
function parseIncomingIcs(text){
  const lines = icsUnfold(text);
  const results = [];
  let cur = null;
  lines.forEach((line) => {
    if(line.startsWith("BEGIN:VEVENT")){
      cur = {};
    }else if(line.startsWith("END:VEVENT")){
      if(cur && cur.dtstart) results.push(cur);
      cur = null;
    }else if(cur){
      const idx = line.indexOf(":");
      if(idx === -1) return;
      const rawKey = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const key = rawKey.split(";")[0].toUpperCase();
      if(key === "SUMMARY") cur.summary = icsUnescapeIncoming(value);
      else if(key === "DESCRIPTION") cur.description = icsUnescapeIncoming(value);
      else if(key === "DTSTART"){
        const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
        if(m){
          const [, y, mo, d, h, mi] = m;
          cur.dtstart = { date: `${y}-${mo}-${d}`, time: h === undefined ? "" : `${h}:${mi}` };
        }
      }
    }
  });
  return results;
}

async function main(){
  const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if(!keyJson){
    console.error("Missing FIREBASE_SERVICE_ACCOUNT_KEY env var.");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(keyJson)) });
  const db = admin.firestore();

  const today = toDateStr(new Date());
  const rangeStart = addDays(today, -LOOKBACK_DAYS);

  const eventsSnap = await db.collection("events").where("approved", "==", true).get();
  const veventBlocks = [];

  eventsSnap.forEach((doc) => {
    const e = doc.data();
    if(!e.date) return;
    if(e.repeat && e.repeat !== "none"){
      const seriesEnd = e.repeatUntil || addDays(e.date, RECUR_HORIZON_DAYS);
      if(seriesEnd < rangeStart) return;
      veventBlocks.push(buildEvent({
        uid: `${doc.id}@kaoz-emporium`,
        title: e.title,
        notes: e.notes,
        dateStr: e.date,
        timeStr: e.time,
        rrule: rruleFor(e.repeat, e.date, e.time, e.repeatUntil)
      }));
    }else{
      if(e.date < rangeStart) return;
      veventBlocks.push(buildEvent({
        uid: `${doc.id}@kaoz-emporium`,
        title: e.title,
        notes: e.notes,
        dateStr: e.date,
        timeStr: e.time
      }));
    }
  });

  const subsSnap = await db.collection("calendarSubscriptions").get();
  await Promise.all(subsSnap.docs.map(async (doc) => {
    const sub = doc.data();
    if(!sub.url) return;
    try{
      const resp = await fetch(sub.url, { signal: AbortSignal.timeout(10000) });
      if(!resp.ok) return;
      const text = await resp.text();
      parseIncomingIcs(text).forEach((ev, i) => {
        if(ev.dtstart.date < rangeStart) return;
        veventBlocks.push(buildEvent({
          uid: `sub-${doc.id}-${i}@kaoz-emporium`,
          title: ev.summary || "Untitled event",
          notes: ev.description,
          dateStr: ev.dtstart.date,
          timeStr: ev.dtstart.time,
          sourceLabel: `Synced from ${sub.name || sub.url}`
        }));
      });
    }catch(err){
      console.error(`Subscribed feed fetch failed for ${sub.name || sub.url}:`, err.message);
    }
  }));

  const icsBody = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kaoz Emporium//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Kaoz Emporium Calendar",
    "X-WR-TIMEZONE:UTC",
    ...veventBlocks,
    "END:VCALENDAR"
  ].map(foldLine).join("\r\n") + "\r\n";

  const outDir = path.join(__dirname, "..", "public");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "calendar.ics"), icsBody, "utf8");
  console.log(`Wrote ${veventBlocks.length} event(s) to public/calendar.ics`);
}

main().catch((err) => {
  console.error("Failed to generate calendar feed:", err);
  process.exit(1);
});
