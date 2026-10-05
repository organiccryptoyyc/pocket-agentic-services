// BLS and BEA release calendars (iCalendar feeds), no key. Each scheduled release becomes an
// event on us-calendar (past ones inside the event window and every future one the feeds list);
// the number of major releases in the next 30 days is a daily snapshot. Release times are
// stored in UTC. A release that moves gets a new event: the date is part of its id.
"use strict";

const { SchemaError, ymd } = require("./common");

const FEEDS = [
  { id: "bls", url: "https://www.bls.gov/schedule/news_release/bls.ics", cite: "https://www.bls.gov/schedule/news_release/" },
  { id: "bea", url: "https://www.bea.gov/index.php/news/schedule/ics/online-calendar-subscription.ics", cite: "https://www.bea.gov/news/schedule" },
];
const UA = "Mozilla/5.0 (compatible; PMIC-collector/1.0)";
// Market-moving releases. Matched on the start of the title (BEA titles add the period).
const MAJOR = [/^Employment Situation/, /^Consumer Price Index/, /^Producer Price Index/, /^Job Openings and Labor Turnover/, /^Employment Cost Index/,
  /^Gross Domestic Product(?! by)/, /^GDP \(/, /^Personal Income and Outlays/, /^U\.S\. International Trade in Goods and Services/, /^Productivity and Costs/];

// Unfolded VEVENT blocks as {UID, SUMMARY, DTSTART, DTSTART_TZID}.
function icsEvents(text) {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") { if (cur) out.push(cur); cur = null; }
    else if (cur) {
      const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (!m) continue;
      cur[m[1]] = m[3].replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").trim();
      const tz = /;TZID=([^;:]+)/.exec(m[2]);
      if (m[1] === "DTSTART" && tz) cur.DTSTART_TZID = tz[1];
    }
  }
  return out;
}

// Minutes New York is behind UTC on a date (240 in summer, 300 in winter).
function nyOffsetMinutes(y, mo, d) {
  const probe = new Date(Date.UTC(y, mo - 1, d, 12));
  const ny = new Date(probe.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((utc - ny) / 60000);
}

// DTSTART (20261015T083000Z, or local Eastern time with a TZID) into an ISO UTC time.
function startUtc(ev) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(ev.DTSTART || "");
  if (!m) return null;
  const [y, mo, d, h = "00", mi = "00"] = m.slice(1, 6).map((x) => x || undefined);
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (!m[7] && m[4]) t += nyOffsetMinutes(Number(y), Number(mo), Number(d)) * 60000; // Eastern local time
  return new Date(t).toISOString().replace(".000Z", "Z");
}

const isMajor = (title) => MAJOR.some((re) => re.test(title));

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  const all = [];
  let sha = null;
  for (const f of FEEDS) {
    try {
      const r = await ctx.get(`releases:${f.id}`, f.url, { headers: { "User-Agent": UA, Accept: "text/calendar" } });
      if (!/BEGIN:VCALENDAR/.test(r.text)) throw new SchemaError(`releases ${f.id}: not an iCalendar feed`);
      sha = r.sha256;
      for (const ev of icsEvents(r.text)) {
        const when = startUtc(ev);
        if (!when || !ev.SUMMARY) continue;
        all.push({ feed: f, ev, when, sha: r.sha256 });
      }
    } catch (e) {
      ctx.fail(series.map((s) => s.series_id), e);
      return out;
    }
  }
  const since = ctx.eventSince();
  for (const x of all) {
    if (x.when.slice(0, 10) < since) continue;
    const major = isMajor(x.ev.SUMMARY);
    out.events.push({
      external_id: `${x.feed.id}:${x.ev.UID || x.ev.SUMMARY}:${x.when.slice(0, 10)}`,
      entity_id: "us-calendar",
      event_type: "scheduled_release",
      event_time: x.when,
      title: `${x.feed.id.toUpperCase()}: ${x.ev.SUMMARY}`.slice(0, 300),
      severity: major ? "high" : "low",
      detail: { agency: x.feed.id.toUpperCase(), release: x.ev.SUMMARY, major },
      source_url: x.feed.cite,
      raw_sha256: x.sha,
    });
  }
  const now = ctx.now.getTime();
  const today = ymd(ctx.now);
  const upcoming = all.filter((x) => isMajor(x.ev.SUMMARY) && Date.parse(x.when) >= now && Date.parse(x.when) < now + 30 * 86400000).length;
  for (const s of series) {
    out.observations.push({ series_id: s.series_id, observation_time: today, period: today, value: upcoming, source_url: FEEDS[0].cite, raw_sha256: sha });
  }
  return out;
}

module.exports = { collect, icsEvents, startUtc, isMajor };
