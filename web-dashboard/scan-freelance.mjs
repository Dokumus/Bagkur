#!/usr/bin/env node
// career-ops FREELANCE lane scanner.
//
// A separate discovery pass for freelance / ZZP / interim assignments in the
// Netherlands (+ NL-billable remote), for a candidate with a Dutch sole
// proprietorship who can invoice. This is deliberately DISTINCT from the
// full-time scanner (scan-jobs.mjs): freelance/contract work is DESIRED here,
// not eliminated. New offers land in data/freelance-pipeline.md and are shown
// under the dashboard's separate "Freelance" lane.
//
// Sources (tiered reliability — see config/freelance-sources.json):
//   • LinkedIn guest jobs with the Contract/Temporary filter (f_JT=C,T)  [HIGH]
//   • NL freelance boards' public listing pages (Freelance.nl, Hoofdkraan) [MEDIUM, best-effort]
//   • Broker/global platforms (Striive, Jellow, Malt, Upwork…)            [MANUAL — login-gated]
//     → only fetched when you add a specific public listing URL to
//       config/freelance-sources.json "manual_urls".
//
// IMPORTANT: this machine needs the system CA store for TLS. Run with:
//   NODE_OPTIONS=--use-system-ca node web-dashboard/scan-freelance.mjs
// (the npm script "scan:freelance" sets this for you).

import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TODAY = new Date().toISOString().slice(0, 10);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PIPELINE_PATH = join(ROOT, "data", "freelance-pipeline.md");
const HISTORY_PATH = join(ROOT, "data", "freelance-scan-history.tsv");
const SOURCES_PATH = join(ROOT, "config", "freelance-sources.json");

async function getText(url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en,nl;q=0.8", ...(opts.headers || {}) } });
    if (!r.ok) return { ok: false, status: r.status, text: "" };
    return { ok: true, status: r.status, text: await r.text() };
  } catch (e) { return { ok: false, status: 0, text: "", err: e.message }; }
}

const decode = (s) => (s || "")
  .replace(/&amp;/g, "&").replace(/&#8211;/g, "–").replace(/&#x27;|&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function normRole(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(senior|junior|lead|staff|principal|m w d|m f x|f m d|freelance|zzp|interim|contract)\b/g, "").trim(); }
function normCompany(s) { return (s || "").toLowerCase().replace(/\b(inc|llc|ltd|gmbh|bv|nv|group|technologies|the)\b/g, "").replace(/[^a-z0-9]+/g, "").trim(); }

// ---- config ----
async function loadSources() {
  try { return JSON.parse(await readFile(SOURCES_PATH, "utf8")); }
  catch { return null; }
}

// A freelance offer must be (a) on-field (data/BI/analytics/business analyst) and
// (b) NOT a senior Data Scientist / Data Engineer title. Contract-nature is already
// guaranteed by the source (LinkedIn f_JT=C, freelance boards).
const POSITIVE = ["data analyst", "data analytics", "business intelligence", "bi analyst", "bi developer", "bi consultant", "analytics", "power bi", "data visuali", "business analyst", "data consultant", "reporting analyst", "rapportage", "data analist", "insights analyst", "kpi"];
const NEGATIVE = ["sales", "account manager", "recruiter", "teacher", "docent", "nurse", "verpleeg", "driver", "chauffeur", "cleaner", "schoonmaak", "developer (front", "front-end", "frontend", "backend", "full stack", "fullstack", "devops", "site reliability", "security engineer", "network engineer"];

function titleOk(title) {
  const t = " " + (title || "").toLowerCase() + " ";
  if (NEGATIVE.some((n) => t.includes(n))) return false;
  return POSITIVE.some((p) => t.includes(p));
}

// Freelance location gate: Netherlands OR NL-billable remote only (DE/TR excluded).
function locationOk(locText, scope) {
  const t = (locText || "").toLowerCase();
  if (!t) return { ok: true, why: "unknown" }; // keep, flag
  const nl = (scope.nl_keywords || []).some((k) => t.includes(k));
  if (nl) return { ok: true, why: "nl" };
  const remote = scope.remote_ok !== false && (scope.remote_keywords || ["remote"]).some((k) => t.includes(k));
  // A bare "remote" with a non-NL country in the string (e.g. "Remote, Germany") is out.
  const foreignHint = /\b(germany|deutschland|münchen|munich|berlin|turkey|türkiye|istanbul|ankara|belgium|france|spain|united kingdom|london|united states|usa|india|poland|portugal)\b/.test(t);
  if (remote && !foreignHint) return { ok: true, why: "remote-nl" };
  return { ok: false, why: "out-of-scope" };
}

// ---- LinkedIn guest (Contract/Temporary) ----
function parseLinkedIn(html) {
  const cards = [];
  for (const block of html.split(/<li>/).slice(1)) {
    const url = (block.match(/href="(https:\/\/[a-z]{0,3}\.?linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1];
    const title = (block.match(/base-search-card__title">\s*([\s\S]*?)<\/h3>/) || [])[1]?.replace(/<[^>]+>/g, "").trim();
    const company = (block.match(/hidden-nested-link[^>]*>\s*([\s\S]*?)<\/a>/) || block.match(/base-search-card__subtitle"[^>]*>\s*([\s\S]*?)<\//) || [])[1]?.replace(/<[^>]+>/g, "").trim();
    const location = (block.match(/job-search-card__location"[^>]*>\s*([\s\S]*?)<\//) || [])[1]?.replace(/<[^>]+>/g, "").trim();
    if (url && title) cards.push({ title, company: company || "?", url: url.split("?")[0], location: location || "" });
  }
  return cards;
}
async function fromLinkedIn(roles, locs, jobTypes, remote) {
  const out = [];
  const jt = (jobTypes || ["C"]).join(",");
  for (const loc of locs) {
    for (const role of roles) {
      for (let start = 0; start <= 50; start += 25) {
        let u = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(role)}&location=${encodeURIComponent(loc)}&f_JT=${jt}&start=${start}`;
        if (remote) u += "&f_WT=2"; // remote work type
        const r = await getText(u);
        if (!r.ok) { if (r.status === 429) await sleep(1500); break; }
        const cards = parseLinkedIn(r.text);
        out.push(...cards.map((c) => ({ ...c, source: "linkedin" })));
        if (cards.length < 5) break;
        await sleep(400);
      }
    }
  }
  return out;
}

// ---- best-effort board / manual-URL listing scrape ----
// Generic: pull <a href> anchors whose text looks like a data/BI/analytics
// assignment. Deliberately conservative — freelance boards vary, so we only keep
// anchors that both link somewhere plausible and carry an on-field title.
async function fromListingPage(url, name) {
  const r = await getText(url);
  if (!r.ok) return { rows: [], ok: false, status: r.status };
  const rows = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(r.text))) {
    let href = m[1];
    const text = decode(m[2]);
    if (!text || text.length < 6 || text.length > 120) continue;
    if (!titleOk(text)) continue;
    // resolve relative URLs against the listing page origin
    try { href = new URL(href, url).toString(); } catch { continue; }
    if (!/^https?:/i.test(href)) continue;
    const key = href.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ title: text, company: name, url: key, location: "Netherlands (freelance board)", source: name });
    if (rows.length >= 40) break;
  }
  return { rows, ok: true, status: r.status };
}

// ---- dedup ----
async function loadDedup() {
  const seenUrls = new Set();
  const compRole = new Set();
  const addUrl = (u) => { if (u && u.startsWith("http")) seenUrls.add(u.split("?")[0]); };
  // freelance history + freelance pipeline
  try { const h = await readFile(HISTORY_PATH, "utf8"); for (const line of h.split("\n")) addUrl(line.split("\t")[0]); } catch {}
  try { const p = await readFile(PIPELINE_PATH, "utf8"); for (const mm of p.matchAll(/(https?:\/\/\S+)/g)) addUrl(mm[1]); } catch {}
  // full-time pipeline + scan history (avoid cross-lane URL duplicates)
  try { const p = await readFile(join(ROOT, "data", "pipeline.md"), "utf8"); for (const mm of p.matchAll(/(https?:\/\/\S+)/g)) addUrl(mm[1]); } catch {}
  try { const h = await readFile(join(ROOT, "data", "scan-history.tsv"), "utf8"); for (const line of h.split("\n")) addUrl(line.split("\t")[0]); } catch {}
  // already-evaluated jobs (either lane): company+role
  try {
    const apps = await readFile(join(ROOT, "data", "applications.md"), "utf8");
    for (const line of apps.split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const c = line.split("|").map((x) => x.trim());
      if (c.length > 4 && /^\d+$/.test(c[1])) compRole.add(normCompany(c[3]) + "::" + normRole(c[4]));
    }
  } catch {}
  // purged tombstones (rejected.tsv) — never re-surface
  try {
    const rej = await readFile(join(ROOT, "data", "rejected.tsv"), "utf8");
    for (const line of rej.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [url, company, role] = line.split("\t");
      addUrl(url);
      if (company && role) compRole.add(normCompany(company) + "::" + normRole(role));
    }
  } catch {}
  return { seenUrls, compRole };
}

async function ensurePipeline() {
  if (existsSync(PIPELINE_PATH)) return;
  const header = `# Freelance Pipeline (Netherlands + NL-remote)

Ayrı freelance/ZZP lane'i için keşfedilen ama henüz değerlendirilmemiş opdracht'lar.
Değerlendir: dashboard "Freelance" lane → 🧠 Evaluate (evaluate-freelance-prompt.md).

## Pendientes
<!-- scan-freelance.mjs bu bölüme "- [ ] URL | Company | Title | Location" satırları ekler -->
`;
  await writeFile(PIPELINE_PATH, header, "utf8");
}

// ---- main ----
async function main() {
  const cfg = await loadSources();
  if (!cfg) { console.error("freelance-sources.json okunamadı."); process.exit(1); }
  await ensurePipeline();
  const scope = cfg.location_scope || { nl_keywords: ["netherlands", "nederland"], remote_ok: true, remote_keywords: ["remote"] };
  const roles = cfg.roles && cfg.roles.length ? cfg.roles : ["Data Analyst", "Business Intelligence", "Business Analyst"];
  const { seenUrls, compRole } = await loadDedup();

  const stats = { linkedin: 0, boards: {}, manual: 0, found: 0, title: 0, location: 0, dup: 0, added: 0, sources: [] };
  const candidates = [];

  // 1) LinkedIn Contract/Temporary — the reliable backbone
  if (cfg.linkedin && cfg.linkedin.enabled !== false) {
    const li = cfg.linkedin;
    try {
      const normal = await fromLinkedIn(roles, li.locations || ["Netherlands"], li.job_types || ["C", "T"], false);
      const remote = await fromLinkedIn(roles, ["Netherlands"], li.job_types || ["C", "T"], true);
      const all = [...normal, ...remote];
      candidates.push(...all);
      stats.linkedin = all.length;
      stats.sources.push(`LinkedIn/contract(${all.length})`);
    } catch (e) { stats.sources.push(`LinkedIn(err:${e.message})`); }
  }

  // 2) NL freelance boards — best-effort public-listing scrape
  for (const b of (cfg.boards || []).filter((x) => x.enabled !== false && x.list_url)) {
    try {
      const { rows, ok, status } = await fromListingPage(b.list_url, b.name);
      candidates.push(...rows);
      stats.boards[b.id] = rows.length;
      stats.sources.push(`${b.name}(${ok ? rows.length : "http " + status})`);
    } catch (e) { stats.sources.push(`${b.name}(err)`); }
    await sleep(500);
  }

  // 3) manual URLs (broker/global gigs you pasted in) — fetch each listing page
  for (const mu of (cfg.manual_urls || [])) {
    const url = typeof mu === "string" ? mu : mu.url;
    const name = typeof mu === "string" ? "Manual" : (mu.name || "Manual");
    if (!url) continue;
    try {
      const { rows } = await fromListingPage(url, name);
      candidates.push(...rows);
      stats.manual += rows.length;
    } catch {}
    await sleep(500);
  }
  if (cfg.manual_urls && cfg.manual_urls.length) stats.sources.push(`manual(${stats.manual})`);

  // brokers that are login-gated: surfaced in the summary so you know they're skipped
  const gated = [...(cfg.brokers || []), ...(cfg.global_remote || [])]
    .filter((x) => x.enabled !== false && x.reliability === "manual").map((x) => x.name);

  // filter + dedup
  const newOffers = [];
  const seenThisRun = new Set();
  const seenCompRoleRun = new Set();
  for (const o of candidates) {
    stats.found++;
    o.title = decode(o.title); o.company = decode(o.company); o.location = decode(o.location);
    if (!o.url || !o.title) continue;
    const url = o.url.split("?")[0];
    if (seenThisRun.has(url)) continue;
    if (!titleOk(o.title)) { stats.title++; continue; }
    const loc = locationOk(o.location, scope);
    if (!loc.ok) { stats.location++; continue; }
    if (seenUrls.has(url)) { stats.dup++; continue; }
    const cr = normCompany(o.company) + "::" + normRole(o.title);
    if (compRole.has(cr) || seenCompRoleRun.has(cr)) { stats.dup++; continue; }
    seenThisRun.add(url);
    seenCompRoleRun.add(cr);
    newOffers.push({ ...o, url, locWhy: loc.why });
  }

  // write
  if (newOffers.length) {
    let pipe = await readFile(PIPELINE_PATH, "utf8");
    // Sanitize every cell: "|" is the column delimiter and "#" starts a markdown
    // heading — either inside a scraped title/company/location would corrupt the
    // pipeline's structure (a scam gig once carried "## Pendientes" as its location).
    const cell = (s) => (s || "").replace(/[|#]/g, " ").replace(/\s+/g, " ").trim();
    const lines = newOffers.map((o) => `- [ ] ${o.url} | ${cell(o.company)} | ${cell(o.title)} | ${cell(o.location) || "?"}${o.locWhy === "unknown" ? " (location?)" : ""}`).join("\n");
    pipe = pipe.replace(/(##\s*Pendientes\s*\n(?:<!--[\s\S]*?-->\n)?)/, `$1${lines}\n`);
    await writeFile(PIPELINE_PATH, pipe, "utf8");
    const hist = newOffers.map((o) => `${o.url}\t${TODAY}\t${o.source || "freelance-scan"}\t${o.title}\t${o.company}\tadded`).join("\n") + "\n";
    await appendFile(HISTORY_PATH, hist, "utf8");
    stats.added = newOffers.length;
  }

  // summary
  console.log(`\n=== Freelance scan ${TODAY} (NL + NL-remote) ===`);
  console.log(`Sources: ${stats.sources.join(", ") || "none"}`);
  if (gated.length) console.log(`Login-gated (skipped, add public URLs to manual_urls): ${gated.join(", ")}`);
  console.log(`Candidates: ${stats.found} | skipped title: ${stats.title} | skipped location: ${stats.location} | dedup: ${stats.dup}`);
  console.log(`>>> NEW freelance added to pipeline: ${stats.added}`);
  newOffers.slice(0, 40).forEach((o) => console.log(`   • ${o.company} | ${o.title} | ${o.location} [${o.source || "?"}]`));
}

main().catch((e) => { console.error("freelance scan error:", e); process.exit(1); });
