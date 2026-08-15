/**
 * Kaoz Emporium — self-updating Discord embed
 * ---------------------------------------------
 * Posts (first run) or edits (every run after) a single Discord message
 * showing upcoming events, so the same message in a channel keeps itself
 * current over time instead of you seeing a new post every 30 minutes.
 *
 * This uses a Discord WEBHOOK, not a bot — a webhook can only post/edit
 * messages in the one channel it was created for, nothing else. Much lower
 * risk than a bot token if it ever leaked, and it's stored only as a
 * GitHub Actions secret, never in code or visible to site visitors.
 *
 * How the "same message" trick works: after creating the message the first
 * time, Discord gives us its message ID. We save that ID to
 * state/discord-message.json and commit it back to the repo. Every run
 * after that, we read the saved ID and PATCH (edit) that exact message
 * instead of creating a new one.
 *
 * Required env var: DISCORD_WEBHOOK_URL
 * Required env var: FIREBASE_SERVICE_ACCOUNT_KEY (same one used for the .ics feed)
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const LOOKAHEAD_DAYS = 60;
const MAX_EVENTS_SHOWN = 12;
const STATE_FILE = path.join(__dirname, "..", "state", "discord-message.json");
const EMBED_COLOR = 0xD4A017; // amber/gold

function pad(n){ return String(n).padStart(2, "0"); }
function toDateStr(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function addDays(dateStr, days){
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}
function niceDate(dateStr){
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function niceTime(timeStr){
  if(!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// Renders a small ASCII month calendar for a monospace code block — the
// closest thing to "looks like a calendar" that a Discord embed can do
// (there's no real grid/table UI component available here). Days with an
// event get a trailing marker; it can't show event titles in the grid
// itself (no room), which is what the event list below it is for.
function buildMonthGrid(year, month, eventDatesInMonth){
  const monthName = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const firstDow = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const lines = [];
  lines.push(monthName.toUpperCase());
  lines.push("Su Mo Tu We Th Fr Sa");

  let row = "";
  for(let i = 0; i < firstDow; i++) row += "   ";
  for(let day = 1; day <= daysInMonth; day++){
    const dStr = `${year}-${pad(month + 1)}-${pad(day)}`;
    const hasEvent = eventDatesInMonth.has(dStr);
    row += `${String(day).padStart(2)}${hasEvent ? "*" : " "}`;
    const dow = (firstDow + day - 1) % 7;
    if(dow === 6 || day === daysInMonth){
      lines.push(row.trimEnd());
      row = "";
    }
  }
  lines.push("");
  lines.push("* = event that day — see list below for details");
  return lines.join("\n");
}

// Mirrors the client-side / .ics-generator recurrence expansion — walks a
// repeating event forward and returns every occurrence date within range.
function occurrenceDates(e, rangeStart, rangeEnd){
  if(!e.repeat || e.repeat === "none"){
    return (e.date >= rangeStart && e.date <= rangeEnd) ? [e.date] : [];
  }
  const horizonCap = addDays(e.date, 182);
  const seriesEnd = e.repeatUntil || horizonCap;
  const scanEnd = seriesEnd < rangeEnd ? seriesEnd : rangeEnd;
  const dates = [];
  let cursor = e.date;
  let guard = 0;
  while(cursor <= scanEnd && guard < 400){
    if(cursor >= rangeStart) dates.push(cursor);
    if(e.repeat === "monthly"){
      const d = new Date(cursor + "T00:00:00");
      const day = d.getDate();
      d.setMonth(d.getMonth() + 1);
      if(d.getDate() !== day) d.setDate(0);
      cursor = toDateStr(d);
    }else{
      cursor = addDays(cursor, e.repeat === "daily" ? 1 : (e.repeat === "biweekly" ? 14 : 7));
    }
    guard++;
  }
  return dates;
}

async function main(){
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if(!webhookUrl){ console.error("Missing DISCORD_WEBHOOK_URL env var."); process.exit(1); }
  if(!keyJson){ console.error("Missing FIREBASE_SERVICE_ACCOUNT_KEY env var."); process.exit(1); }

  if(!admin.apps.length){
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(keyJson)) });
  }
  const db = admin.firestore();

  const today = toDateStr(new Date());
  const rangeEnd = addDays(today, LOOKAHEAD_DAYS);

  const eventsSnap = await db.collection("events").where("approved", "==", true).get();
  let upcoming = [];
  eventsSnap.forEach((doc) => {
    const e = doc.data();
    if(!e.date) return;
    occurrenceDates(e, today, rangeEnd).forEach((d) => {
      upcoming.push({ title: e.title, date: d, time: e.time || "" });
    });
  });

  const subsSnap = await db.collection("calendarSubscriptions").get();
  await Promise.all(subsSnap.docs.map(async (doc) => {
    const sub = doc.data();
    if(!sub.url) return;
    try{
      const resp = await fetch(sub.url, { signal: AbortSignal.timeout(10000) });
      if(!resp.ok) return;
      const text = await resp.text();
      const lines = text.replace(/\r\n/g, "\n").split("\n").reduce((acc, line) => {
        if((line.startsWith(" ") || line.startsWith("\t")) && acc.length) acc[acc.length - 1] += line.slice(1);
        else acc.push(line);
        return acc;
      }, []);
      let cur = null;
      lines.forEach((line) => {
        if(line.startsWith("BEGIN:VEVENT")) cur = {};
        else if(line.startsWith("END:VEVENT")){
          if(cur && cur.date && cur.date >= today && cur.date <= rangeEnd){
            upcoming.push({ title: (cur.summary || "Untitled event") + ` (${sub.name || "external"})`, date: cur.date, time: cur.time || "" });
          }
          cur = null;
        }else if(cur){
          const idx = line.indexOf(":");
          if(idx === -1) return;
          const key = line.slice(0, idx).split(";")[0].toUpperCase();
          const value = line.slice(idx + 1);
          if(key === "SUMMARY") cur.summary = value;
          else if(key === "DTSTART"){
            const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
            if(m){ const [, y, mo, d, h, mi] = m; cur.date = `${y}-${mo}-${d}`; cur.time = h === undefined ? "" : `${h}:${mi}`; }
          }
        }
      });
    }catch(err){
      console.error(`Subscribed feed fetch failed for ${sub.name || sub.url}:`, err.message);
    }
  }));

  const now = new Date();
  const eventDatesInMonth = new Set(
    upcoming
      .filter((e) => {
        const d = new Date(e.date + "T00:00:00");
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      })
      .map((e) => e.date)
  );
  const monthGrid = buildMonthGrid(now.getFullYear(), now.getMonth(), eventDatesInMonth);

  upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  upcoming = upcoming.slice(0, MAX_EVENTS_SHOWN);

  const eventListText = upcoming.length === 0
    ? "Nothing on the calendar in the next 60 days."
    : upcoming.map((e) => {
        const t = niceTime(e.time);
        return `**${niceDate(e.date)}**${t ? ` · ${t}` : ""} — ${e.title}`;
      }).join("\n");

  const description = "```\n" + monthGrid + "\n```\n\n**Upcoming Events**\n" + eventListText;

  const embed = {
    title: "📅 Calendar",
    description,
    color: EMBED_COLOR,
    timestamp: new Date().toISOString(),
    footer: { text: "Kaoz Emporium · updates automatically every 30 min" }
  };

  let state = { messageId: null };
  try{ state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }catch(e){ /* first run, no state yet */ }

  let messageId = state.messageId;

  if(messageId){
    const editRes = await fetch(`${webhookUrl}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });
    if(editRes.status === 404){
      // The message was deleted (e.g. someone cleared the channel) — fall
      // through and create a fresh one below.
      console.log("Saved message no longer exists — creating a new one.");
      messageId = null;
    }else if(!editRes.ok){
      throw new Error(`Discord edit failed: HTTP ${editRes.status} ${await editRes.text()}`);
    }else{
      console.log(`Edited existing Discord message ${messageId}.`);
    }
  }

  if(!messageId){
    const createRes = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });
    if(!createRes.ok) throw new Error(`Discord post failed: HTTP ${createRes.status} ${await createRes.text()}`);
    const data = await createRes.json();
    messageId = data.id;
    console.log(`Posted new Discord message ${messageId} — go pin it in the channel!`);
  }

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ messageId }, null, 2));
}

main().catch((err) => {
  console.error("Failed to update Discord embed:", err);
  process.exit(1);
});
