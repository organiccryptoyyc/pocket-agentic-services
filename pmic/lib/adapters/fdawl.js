// FDA warning letters: the table behind fda.gov's warning letter listing (a Drupal datatables
// JSON view), no key. Paged newest first by posted date until the oldest needed month. Monthly
// counts by posted date (all letters, drug and biologic letters from CDER and CBER, device letters
// from CDRH); drug and device letters become events, tied to Pfizer, Lilly or J&J when named.
"use strict";

const { SchemaError, parseJson, anyDate, monthlyCounts } = require("./common");

const LISTING = "https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters";
const AJAX = "https://www.fda.gov/datatables/views/ajax";
const UA = "Mozilla/5.0 (compatible; PMIC-collector/1.0)";
const PAGE = 500;
const FIRMS = [[/\bpfizer\b/i, "pfe"], [/\beli lilly\b|\blilly\b/i, "lly"], [/johnson\s*&\s*johnson|\bjanssen\b/i, "jnj"]];

const strip = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const href = (html) => (/href="([^"]+)"/.exec(String(html || "")) || [])[1] || null;

function kindOf(office) {
  if (/Drug Evaluation|CDER|Biologics Evaluation|CBER/i.test(office)) return "drug";
  if (/Devices and Radiological|CDRH/i.test(office)) return "device";
  return "other";
}

// One datatables row: [posted, issued, company link, office, subject, ...].
function letterOf(row) {
  const posted = anyDate(strip(row[0]));
  if (!posted) return null;
  const link = href(row[2]);
  return { posted, issued: anyDate(strip(row[1])), company: strip(row[2]), office: strip(row[3]), subject: strip(row[4]), url: link ? new URL(link, "https://www.fda.gov").toString() : LISTING };
}

async function collect(series, ctx) {
  const out = { observations: [], events: [] };
  try {
    const since = [...series.map((s) => ctx.since(s)), ctx.eventSince()].sort()[0];
    const letters = [];
    let sha = null;
    for (let start = 0; start < 20000; start += PAGE) {
      const q = new URLSearchParams({ view_name: "warning_letter_solr_index", view_display_id: "warning_letter_solr_block", view_path: "/node/360089", view_args: "", draw: "1", start: String(start), length: String(PAGE), "order[0][column]": "0", "order[0][dir]": "desc", "search[value]": "" });
      const r = await ctx.get(`fdawl:${start}`, `${AJAX}?${q}`, { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } });
      sha = sha || r.sha256;
      const body = parseJson(r.text, "fda warning letters");
      if (!Array.isArray(body.data)) throw new SchemaError("fda warning letters: no data array");
      const page = body.data.map(letterOf).filter(Boolean);
      letters.push(...page);
      if (body.data.length < PAGE || (page.length && page[page.length - 1].posted < since)) break;
    }
    if (!letters.length) throw new SchemaError("fda warning letters: empty table");
    for (const s of series) {
      const pick = letters.filter((l) => s.params.feed === "all" || kindOf(l.office) === s.params.feed);
      for (const [m, n] of monthlyCounts(pick.map((l) => [l.posted, 1]), ctx.since(s), ctx.now)) {
        out.observations.push({ series_id: s.series_id, observation_time: m, period: m.slice(0, 7), value: n, source_url: LISTING, raw_sha256: sha });
      }
    }
    const evSince = ctx.eventSince();
    for (const l of letters) {
      const kind = kindOf(l.office);
      if (l.posted < evSince || kind === "other") continue;
      const firm = FIRMS.find(([re]) => re.test(l.company));
      out.events.push({
        external_id: `fdawl:${l.url}`,
        entity_id: firm ? firm[1] : "us-fda-compliance",
        event_type: "warning_letter",
        event_time: l.posted,
        title: `FDA warning letter: ${l.company} (${l.subject || l.office})`.slice(0, 300),
        severity: /CGMP|Adulterated/i.test(l.subject) ? "medium" : "low",
        detail: { company: l.company, office: l.office, subject: l.subject, issued: l.issued, kind },
        source_url: l.url,
        raw_sha256: sha,
      });
    }
  } catch (e) {
    ctx.fail(series.map((s) => s.series_id), e);
  }
  return out;
}

module.exports = { collect, letterOf, kindOf };
