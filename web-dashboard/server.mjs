#!/usr/bin/env node
// career-ops web dashboard — zero-dependency local server.
//
// Reads the canonical tracker (data/applications.md) + report headers and serves
// a scored job board. Marking a job (Applied / Discarded / status change) writes
// back to applications.md using the system's canonical states, so the scanner's
// dedup logic stops re-surfacing it. Single source of truth, no extra state file.
//
// Usage:  node web-dashboard/server.mjs   (then open http://localhost:4317)

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, ".."); // career-ops project root
const PORT = process.env.PORT || 4317;

// applications.md lives in data/ (fallback to root for compatibility).
const TRACKER_CANDIDATES = [join(ROOT, "data", "applications.md"), join(ROOT, "applications.md")];
// Location scope — source of truth for which countries/cities the scanner targets.
const LOCATIONS_PATH = join(ROOT, "config", "locations.json");
// User-added job-search sources (sites/boards) — fed back into the scanner.
const SOURCES_PATH = join(ROOT, "config", "sources.json");
const PORTALS_PATH = join(ROOT, "portals.yml");
const HEADHUNTERS_PATH = join(ROOT, "config", "headhunters.json");

// Recruitment/intermediary firms to hide from the board (Randstad, Michael Page…).
let HH = { company_names: [], name_keywords: [] };
try {
  const raw = JSON.parse(readFileSync(HEADHUNTERS_PATH, "utf8"));
  HH.company_names = (raw.company_names || []).map((s) => s.toLowerCase());
  HH.name_keywords = (raw.name_keywords || []).map((s) => s.toLowerCase());
} catch {}
function isHeadhunterCompany(company) {
  const c = " " + String(company || "").toLowerCase() + " ";
  return HH.company_names.some((n) => c.includes(n)) || HH.name_keywords.some((k) => c.includes(k));
}

// Layoff / instability risk (feature #4). Curated company map + JD/notes keyword
// heuristic. The whole point of this project is layoff-aversion, so this turns
// that judgement into a first-class, filterable signal instead of a manual read.
const COMPANY_RISK_PATH = join(ROOT, "config", "company-risk.json");
let RISK = { companies: {}, keywords_high: [], keywords_medium: [] };
function loadRiskConfig() {
  try {
    const raw = JSON.parse(readFileSync(COMPANY_RISK_PATH, "utf8"));
    RISK = {
      companies: raw.companies || {},
      keywords_high: (raw.keywords_high || []).map((s) => s.toLowerCase()),
      keywords_medium: (raw.keywords_medium || []).map((s) => s.toLowerCase()),
    };
    // precompute lowercased company keys for substring matching
    RISK._companyKeys = Object.keys(RISK.companies).map((k) => [k.toLowerCase(), k]);
  } catch { RISK = { companies: {}, keywords_high: [], keywords_medium: [], _companyKeys: [] }; }
}
loadRiskConfig();

const RANK = { high: 2, medium: 1, low: 0, "": -1 };
// Assess a job's instability risk from (a) the curated company map and (b) a
// keyword scan of the report + tracker notes. Returns the strongest signal.
function assessRisk(company, text) {
  let best = { level: "", reason: "", source: "" };
  const c = String(company || "").toLowerCase();
  for (const [key, orig] of (RISK._companyKeys || [])) {
    if (c && c.includes(key)) {
      const e = RISK.companies[orig];
      if (RANK[e.level] > RANK[best.level]) best = { level: e.level, reason: e.reason, source: e.source || "company list" };
    }
  }
  const t = String(text || "").toLowerCase();
  const hiHit = RISK.keywords_high.find((k) => t.includes(k));
  const medHit = RISK.keywords_medium.find((k) => t.includes(k));
  if (hiHit && RANK.high > RANK[best.level]) best = { level: "high", reason: `posting language: “${hiHit}”`, source: "jd keyword" };
  else if (medHit && RANK.medium > RANK[best.level]) best = { level: "medium", reason: `posting language: “${medHit}”`, source: "jd keyword" };
  return best.level ? best : null;
}

// --- unified filter engine (config/filters.json) --------------------------
// Single source of truth for EVERY elimination rule. The dashboard's Filters
// panel renders this same config with live counts, so what you see filtered is
// exactly what is configured — no hidden rules scattered through the code.
const FILTERS_PATH = join(ROOT, "config", "filters.json");
let FILTERS = { keep_threshold: 3.6, filters: [], scoring_rules: [], keep_rule: {} };
function compileFilters() {
  try {
    const raw = JSON.parse(readFileSync(FILTERS_PATH, "utf8"));
    raw.filters = (raw.filters || []).map((f) => ({
      ...f,
      _title: (f.title_patterns || []).map((p) => new RegExp(p, "i")),
      _company: (f.company_patterns || []).map((p) => new RegExp(p, "i")),
      _text: (f.text_patterns || []).map((p) => new RegExp(p, "i")),
      _except: (f.title_exceptions || []).map((p) => new RegExp(p, "i")),
    }));
    FILTERS = raw;
  } catch { /* keep previous */ }
}
compileFilters();

// Which filters exclude this job? Returns the matched rule ids (+ what matched).
// `lane` = "fulltime" | "freelance". A filter may carry a `lanes` array; if present
// and it does not include the job's lane, the rule is skipped for that job. This is
// how the freelance lane bypasses fixed_term / consultancy / headhunter (contract,
// client-project and broker postings are the NORMAL, wanted channel for ZZP work).
function excludedBy({ company, role, text, dsde, deInfra, seniorish, junior, lane = "fulltime" }) {
  const out = [];
  for (const f of FILTERS.filters) {
    if (f.enabled === false) continue;
    if (Array.isArray(f.lanes) && !f.lanes.includes(lane)) continue;
    let hit = null;
    if (f.id === "headhunter") {
      if (isHeadhunterCompany(company)) hit = "company blocklist";
    } else if (f.id === "senior_dsde") {
      // 2026-08: güncel CV'ye göre daraltıldı. Data Scientist ve Analytics Engineer
      // artık panelde GİZLENMEZ — adayın profesyonel modelleme (öngörü/regresyon,
      // OR-Tools optimizasyon) ve boyutsal modelleme işi var; uygun tavanı LLM
      // değerlendirmesi koyuyor. Yalnızca altyapı ailesi (Data/ML Engineer, MLOps)
      // kıdemli seviyede gizlenir — orada gerçekten alan tecrübesi yok.
      if (deInfra && seniorish && !junior) hit = "senior/mid Data/ML Engineer";
    } else {
      if (f._except.some((re) => re.test(role || ""))) continue; // e.g. "Junior ..." survives above_level
      const t = f._title.find((re) => re.test(role || ""));
      const c = f._company.find((re) => re.test(company || ""));
      const x = f._text.find((re) => re.test(text || ""));
      const m = (t && (role || "").match(t)) || (c && (company || "").match(c)) || (x && (text || "").match(x));
      if (m) hit = String(m[0]).trim();
    }
    if (hit) out.push({ id: f.id, label: f.label, matched: hit });
  }
  return out;
}

// --- outcome feedback log (feature #3) -----------------------------------
const OUTCOMES_PATH = join(ROOT, "data", "outcomes.json");
async function loadOutcomes() {
  try {
    const raw = JSON.parse(await readFile(OUTCOMES_PATH, "utf8"));
    return raw.outcomes || {};
  } catch { return {}; }
}
async function saveOutcome(reportNumber, patch) {
  let doc = { outcomes: {} };
  try { doc = JSON.parse(await readFile(OUTCOMES_PATH, "utf8")); doc.outcomes = doc.outcomes || {}; } catch {}
  doc.outcomes[reportNumber] = { ...(doc.outcomes[reportNumber] || {}), ...patch };
  await writeFile(OUTCOMES_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return doc.outcomes[reportNumber];
}

// Classify a role for the "no direct DS/DE experience" rule: the candidate wants
// Data Scientist / Data Engineer roles ONLY at junior / 0–2yr level (senior ones
// are dropped), while analytics/BI/BA roles keep the normal mid–senior treatment.
const SENIOR_RE = /\b(senior|sr\.?|lead|principal|staff|head|director|manager|expert|chief|vp|iii|iv|medior|mid[- ]?level)\b/i;
const JUNIOR_RE = /\b(junior|jr\.?|entry|graduate|trainee|working student|werkstudent|associate|intern)\b/i;
// "Above the candidate's level" for ANY archetype. The candidate is realistically a
// junior–mid Data/BI/Business Analyst: ~2yr of real analyst work (Turkcell) + a fresh
// M.Sc., NO people-leadership and NO senior/staff ownership track record. So senior /
// lead / principal / staff / head / director / (people) manager titles are out of reach
// and should NOT be surfaced as targets — regardless of whether it's DS/DE or analytics.
// NB: "medior"/"mid-level" are deliberately excluded here → mid stays visible.
const ABOVE_LEVEL_RE = /\b(senior|sr\.?|lead|principal|staff|head\s+of|head|director|chief|vp|vice[- ]president|manager)\b/i;
// Which lane does a tracker row belong to? Freelance rows are written by the
// freelance evaluator, which stamps the report Archetype as "Freelance — …" and
// prefixes the tracker note with "FREELANCE:". Either signal is sufficient; the
// colon in the note marker avoids matching full-time SKIP notes that merely mention
// the word "freelance" as a rejection reason.
function detectLane(archetype, notes) {
  if (/^\s*freelance\b/i.test(archetype || "")) return "freelance";
  if (/\bFREELANCE:/.test(notes || "")) return "freelance";
  return "fulltime";
}
function classifyRole(role, seniority) {
  const t = `${role || ""} ${seniority || ""}`;
  const junior = JUNIOR_RE.test(t);
  const isDSorDE = /\bdata scientist\b|\bdata science\b|\bdata engineer\b|\bmachine learning engineer\b|\bml engineer\b|\bmlops\b|\banalytics engineer\b/i.test(role || "");
  const seniorish = SENIOR_RE.test(t);
  // aboveLevel: judge by the TITLE only (the seniority enrichment field is a noisy
  // guess and wrongly buries plain "Data Analyst"/"Business Analyst" roles). A title
  // literally saying Senior/Lead/Principal/Staff/Head/Manager is above the candidate's
  // level; an unlabelled title stays visible and the LLM eval applies the finer cap.
  const aboveLevel = ABOVE_LEVEL_RE.test(role || "") && !JUNIOR_RE.test(role || "");
  return { dsde: isDSorDE, deInfra, dropSeniorDSDE: deInfra && seniorish && !junior, aboveLevel };
}
// Example scope, used only if config/locations.json is missing. Set your real
// target country/cities from the dashboard "Locations" panel (it writes
// config/locations.json, which is gitignored and personal).
const DEFAULT_LOCATIONS = {
  remote_ok: true,
  regions: [
    { id: "example", label: "Example — set your own", country: "Your country", cities: ["Your city"], keywords: ["Your country"], enabled: true },
  ],
};

// Canonical states (mirror templates/states.yml).
const CANONICAL = ["Evaluated", "Applied", "Responded", "Interview", "Offer", "Rejected", "Discarded", "SKIP", "Archived"];
// Un-reviewed (still "evaluated") jobs older than this many days, or past their
// deadline, are treated as stale and shown in the Archive tab instead of To-Apply.
const STALE_DAYS = 30;
// Keep-bar: after each scan+evaluate, jobs scoring below this are purged from the
// tracker (row + report deleted) and tombstoned in data/rejected.tsv so they never
// come back. Anything you applied to is kept regardless of score.
const PRUNE_THRESHOLD = parseFloat(process.env.PRUNE_THRESHOLD || "3.4");

// --- helpers -------------------------------------------------------------

async function resolveTrackerPath() {
  for (const p of TRACKER_CANDIDATES) {
    try {
      await readFile(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return TRACKER_CANDIDATES[0];
}

// Normalize raw (possibly Spanish) status text to a canonical bucket for display/filtering.
function normalizeStatus(raw) {
  let s = (raw || "").replace(/\*\*/g, "").trim().toLowerCase();
  const dateIdx = s.indexOf(" 202");
  if (dateIdx > 0) s = s.slice(0, dateIdx).trim();
  if (/no aplicar|no_aplicar|geo blocker/.test(s) || s === "skip") return "skip";
  if (/interview|entrevista/.test(s)) return "interview";
  if (s === "offer" || /oferta/.test(s)) return "offer";
  if (/responded|respondido/.test(s)) return "responded";
  if (/applied|aplicad|enviada|sent/.test(s)) return "applied";
  if (/rejected|rechazad/.test(s)) return "rejected";
  if (/archived|archive|archivad|arsiv/.test(s)) return "archived";
  if (/discarded|descartad|cerrada|cancelada/.test(s) || s.startsWith("dup")) return "discarded";
  if (/evaluated|evaluad|condicional|hold|monitor|evaluar|verificar/.test(s)) return "evaluated";
  return s || "evaluated";
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

// Detect a Dutch/German language requirement from free text.
function detectLanguage(text) {
  const t = text.toLowerCase();
  const dutch = /(fluent|native|required|must speak|proficient|business level|nodig|vereist)[^.\n]{0,30}(dutch|nederlands)/.test(t) ||
    /(dutch|nederlands)[^.\n]{0,30}(required|fluent|native|mandatory|is a must|nodig|vereist)/.test(t);
  const german = /(fluent|native|required|must speak|proficient|business level|erforderlich)[^.\n]{0,30}(german|deutsch)/.test(t) ||
    /(german|deutsch)[^.\n]{0,30}(required|fluent|native|mandatory|is a must|erforderlich)/.test(t);
  if (dutch) return "Dutch";
  if (german) return "German";
  return "";
}

// Parse the "Gaps" table (| Gap | Severity | Mitigation |) into {name, severity}[].
function parseGaps(text) {
  const m = text.match(/###?\s*Gaps\s*\n([\s\S]*?)(\n#{1,3}\s|\n---|\n\n#|$)/i);
  if (!m) return [];
  const gaps = [];
  for (const line of m[1].split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|\s*-+/.test(t) || /\|\s*Gap\s*\|/i.test(t)) continue;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.replace(/\*\*/g, "").trim());
    if (cells.length < 2 || !cells[0]) continue;
    gaps.push({ name: cells[0], severity: cells[1] || "" });
  }
  return gaps.slice(0, 4);
}

// Count "**Strong**" cells (requirements-mapping table) across the report.
function countStrengths(text) {
  return (text.match(/\*\*Strong\*\*/gi) || []).length;
}

// Map a location/remote string to a canonical country for the dashboard filter.
const COUNTRY_KEYS = [
  ["Netherlands", ["netherlands", "nederland", "holland", "amsterdam", "rotterdam", "the hague", "den haag", "utrecht", "eindhoven", "groningen", "tilburg", "nijmegen", "haarlem", "arnhem", "delft", "leiden", "randstad"]],
  ["Germany", ["germany", "deutschland", "munich", "münchen", "munchen", "bavaria", "bayern", "berlin", "hamburg", "frankfurt", "cologne", "köln", "stuttgart", "düsseldorf"]],
  ["Denmark", ["denmark", "danmark", "copenhagen", "københavn", "kobenhavn", "aarhus", "odense", "aalborg"]],
  ["Sweden", ["sweden", "sverige", "stockholm", "gothenburg", "göteborg", "goteborg", "malmö", "malmo", "uppsala", "solna", "södertälje"]],
  ["Finland", ["finland", "suomi", "helsinki", "espoo", "tampere", "oulu"]],
  ["Turkey", ["turkey", "türkiye", "turkiye", "ankara", "istanbul", "i̇stanbul", "izmir", "i̇zmir", "muğla", "mugla", "antalya", "bodrum", "fethiye", "marmaris", "gölbaşı", "çankaya"]],
  ["Belgium", ["belgium", "brussels", "antwerp", "ghent", "belgië", "belgique"]],
  ["United Kingdom", ["united kingdom", "london", "manchester", " uk", "uk,", "england"]],
  ["Spain", ["spain", "madrid", "barcelona", "españa", "valencia"]],
  ["France", ["france", "paris", "lyon", "toulouse"]],
  ["Ireland", ["ireland", "dublin"]],
  ["United States", ["united states", "usa", "u.s.", "new york", "san francisco", "remote - us"]],
];
function detectCountry(str) {
  const t = (str || "").toLowerCase();
  if (!t) return null;
  for (const [name, keys] of COUNTRY_KEYS) if (keys.some((k) => t.includes(k))) return name;
  return null;
}

// Pull enrichment fields from a report.
function enrichFromReport(text) {
  const head = text.slice(0, 2500);
  const cell = (label) => firstMatch(head, new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*([^|]+?)\\s*\\|`, "i"));
  return {
    url: firstMatch(head, /^\*\*URL:\*\*\s*(\S+)/m),
    sector: cell("Domain") || cell("Sector"),
    seniority: cell("Seniority"),
    remote: cell("Remote"),
    country: detectCountry(cell("Remote")) || detectCountry(head) || "Other",
    comp: cell("Comp"),
    archetype: cell("Archetype") || firstMatch(head, /^\*\*Archetype:\*\*\s*(.+)$/m),
    deadlineRaw: cell("Deadline"),
    language: detectLanguage(text),
    gaps: parseGaps(text),
    strengths: countStrengths(text),
  };
}

// Parse a loose date string ("April 27, 2026", "Apr 16", "2026-04-16") to an ISO date or null.
// Returns null for non-dates like "Not stated", "Rolling", "ASAP", "N/A".
function parseDate(raw, fallbackYear) {
  if (!raw) return null;
  let s = raw.trim().replace(/^(by|until|before|deadline)\s*:?\s*/i, "");
  if (/^(not\s|n\/?a|none|rolling|asap|open|ongoing|tbd|unspecified|immediately|-|—|–)/i.test(s)) return null;
  const hasMonth = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s);
  const hasNumericDate = /\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?/.test(s) || /\d{4}-\d{2}-\d{2}/.test(s);
  if (!hasMonth && !hasNumericDate) return null; // not a real date
  if (!/\d{4}/.test(s) && fallbackYear) s += " " + fallbackYear;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

// Parse a markdown table row of applications.md into cells (inner cells only).
function rowCells(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

// Real posting dates (from backfill-posted-dates.mjs), keyed by URL (no query).
function readPostedCache() {
  try { return JSON.parse(readFileSync(join(ROOT, "data", "posted-dates.json"), "utf8")); }
  catch { return {}; }
}

// Liveness sweep sonuçları (liveness-sweep.mjs), rapor numarasına göre.
// { "<num>": { url, verdict: "active"|"expired"|"uncertain", reason, checkedAt } }
function readLivenessCache() {
  try { return JSON.parse(readFileSync(join(ROOT, "data", "liveness.json"), "utf8")); }
  catch { return {}; }
}

async function loadJobs() {
  const trackerPath = await resolveTrackerPath();
  let content = "";
  try {
    content = await readFile(trackerPath, "utf8");
  } catch {
    return [];
  }

  const POSTED = readPostedCache();
  const LIVENESS = readLivenessCache();
  const OUTCOMES = await loadOutcomes();
  const jobs = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    if (t.startsWith("|---") || t.startsWith("| #") || t.startsWith("|#")) continue;
    const cells = rowCells(t);
    if (cells.length < 8) continue;
    // Columns: #, Date, Company, Role, Score, Status, PDF, Report, Notes
    const [num, date, company, role, scoreRaw, statusRaw, pdf, reportCell, notes = ""] = cells;
    if (!/^\d+$/.test(num)) continue;

    const reportLink = reportCell.match(/\[(\d+)\]\(([^)]+)\)/);
    const reportNumber = reportLink ? reportLink[1] : num.padStart(3, "0");
    const reportPath = reportLink ? reportLink[2] : "";

    const scoreM = scoreRaw.match(/(\d+\.?\d*)\s*\/\s*5/);
    const score = scoreM ? parseFloat(scoreM[1]) : 0;

    let enrich = { url: "", sector: "", seniority: "", remote: "", comp: "", archetype: "", deadlineRaw: "", language: "", gaps: [], strengths: 0 };
    let repText = "";
    if (reportPath) {
      try {
        repText = await readFile(join(ROOT, reportPath), "utf8");
        enrich = enrichFromReport(repText);
      } catch {
        /* report missing — skip enrichment */
      }
    }

    const status = normalizeStatus(statusRaw);
    const lane = detectLane(enrich.archetype, notes);

    // Deadline: prefer report's **Deadline**, else a "DEADLINE <date>" hint in notes.
    const fallbackYear = (date.match(/(\d{4})/) || [])[1] || String(new Date().getFullYear());
    let deadlineRaw = enrich.deadlineRaw || firstMatch(notes, /deadline[:\s]+([A-Za-z0-9 ,\/-]+?)(?:!|\.|$|\|)/i);
    const deadline = parseDate(deadlineRaw, fallbackYear);

    // Staleness: un-reviewed (evaluated) jobs that are past deadline or older than STALE_DAYS.
    // Yaş, ilanın GERÇEK yayın tarihinden (posted-dates.json) hesaplanır; yoksa
    // değerlendirme tarihine düşer. Aksi halde 6 ay önce yayınlanmış bir ilan,
    // dün değerlendirildiği için "taze" görünüyordu.
    const today = new Date().toISOString().slice(0, 10);
    const postedDate = (POSTED[(enrich.url || "").split("?")[0]] || "") || null;
    const ageBasis = postedDate || date;
    const ageDays = ageBasis ? Math.round((Date.now() - Date.parse(ageBasis)) / 864e5) : 0;
    const evalAgeDays = date ? Math.round((Date.now() - Date.parse(date)) / 864e5) : 0;
    // Liveness süpürmesi kapalı dediyse ilan To-Apply'da durmamalı.
    const live = LIVENESS[String(parseInt(num, 10))] || null;
    const deadByLiveness = live?.verdict === "expired";
    const deadlinePassed = deadline ? deadline < today : false;
    const stale = status === "evaluated" && (deadByLiveness || deadlinePassed || (Number.isFinite(ageDays) && ageDays > STALE_DAYS));
    const daysToDeadline = deadline ? Math.round((Date.parse(deadline) - Date.now()) / 864e5) : null;
    const urgent = status === "evaluated" && daysToDeadline !== null && daysToDeadline >= 0 && daysToDeadline <= 7;

    jobs.push({
      reportNumber,
      number: parseInt(num, 10),
      date,
      company,
      role,
      score,
      scoreRaw,
      statusRaw,
      status,
      lane,
      hasPDF: pdf.includes("✅"),
      reportPath,
      notes,
      ...enrich,
      postedDate,
      evalAgeDays,
      liveness: live ? { verdict: live.verdict, checkedAt: live.checkedAt } : null,
      isHeadhunter: isHeadhunterCompany(company),
      ...classifyRole(role, enrich.seniority),
      risk: assessRisk(company, `${repText} ${notes}`),
      excludedBy: excludedBy({
        company, role, text: `${repText} ${notes}`, lane,
        ...(() => { const cr = classifyRole(role, enrich.seniority); return { dsde: cr.dsde, deInfra: cr.deInfra, seniorish: SENIOR_RE.test(`${role} ${enrich.seniority || ""}`), junior: JUNIOR_RE.test(`${role} ${enrich.seniority || ""}`) }; })(),
      }),
      outcome: OUTCOMES[reportNumber] || OUTCOMES[String(parseInt(num, 10))] || null,
      dupKey: `${company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${role.toLowerCase().replace(/[()]/g, " ").replace(/[^a-z0-9 /]/g, "").replace(/\s+/g, " ").trim()}`,
      deadline,
      deadlineRaw: deadlineRaw || "",
      daysToDeadline,
      stale,
      urgent,
      ageDays,
    });
  }

  // Duplicate detection (feature #5): same normalized company+role appearing more
  // than once. Flag every copy except the highest-scored "primary" so the UI can
  // surface + bulk-archive the redundant rows.
  const byKey = new Map();
  for (const j of jobs) {
    if (!byKey.has(j.dupKey)) byKey.set(j.dupKey, []);
    byKey.get(j.dupKey).push(j);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const primary = group.slice().sort((a, b) => b.score - a.score)[0];
    for (const j of group) { j.dupCount = group.length; j.isDuplicate = j !== primary; }
  }

  jobs.sort((a, b) => b.score - a.score);
  return jobs;
}

// Update a job's status cell in applications.md by report number.
// The system's scripts (verify/merge/normalize) accept the lowercase id or the
// Spanish aliases from states.yml — NOT the capitalized English labels. Translate
// the dashboard's English choice to a system-accepted form on write.
const TO_SYS = {
  Evaluated: "Evaluada", Applied: "Aplicada", Responded: "Respondido", Interview: "Entrevista",
  Offer: "Oferta", Rejected: "Rechazada", Discarded: "Descartada", Archived: "archivado", SKIP: "skip",
};

async function updateStatus(reportNumber, newStatus) {
  if (!CANONICAL.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`);
  }
  newStatus = TO_SYS[newStatus] || newStatus;
  const trackerPath = await resolveTrackerPath();
  const content = await readFile(trackerPath, "utf8");
  const lines = content.split("\n");
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("|")) continue;
    if (!t.includes(`[${reportNumber}]`)) continue;
    const cells = rowCells(t);
    if (cells.length < 8) continue;
    cells[5] = newStatus; // Status column
    lines[i] = `| ${cells.join(" | ")} |`;
    found = true;
    break;
  }
  if (!found) throw new Error(`Job not found: report ${reportNumber}`);
  await writeFile(trackerPath, lines.join("\n"), "utf8");
  return true;
}

// --- insights: funnel + conversion + rejection-reason loop (feature #2/#3) ---
// Canonical rejection reasons the UI offers; free text is bucketed to "other".
const REASON_LABELS = {
  "no-sponsorship": "No visa sponsorship",
  "language": "Wanted Dutch/German",
  "too-senior": "Too senior for me",
  "under-level": "Below my level / pay",
  "domain-mismatch": "Sector experience required",
  "agency": "Agency / intermediary",
  "location": "Location / relocation",
  "ghosted": "Ghosted — no reply",
  "rejected-screen": "Rejected after screen/interview",
  "withdrew": "I withdrew",
  "other": "Other",
};

const APPLIED_SET = new Set(["applied", "responded", "interview", "offer"]);
const REPLIED_SET = new Set(["responded", "interview", "offer"]);

function computeInsights(jobs) {
  const n = (set) => jobs.filter((j) => set.has(j.status)).length;
  const cnt = (s) => jobs.filter((j) => j.status === s).length;
  const funnel = {
    scored: jobs.length,
    applied: n(APPLIED_SET),
    replied: n(REPLIED_SET),
    interview: n(new Set(["interview", "offer"])),
    offer: cnt("offer"),
    rejected: cnt("rejected"),
    discarded: cnt("discarded") + cnt("skip"),
    archived: cnt("archived"),
  };
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
  const rates = {
    applyOfScored: pct(funnel.applied, funnel.scored),
    replyOfApplied: pct(funnel.replied, funnel.applied),
    interviewOfReplied: pct(funnel.interview, funnel.replied),
  };

  // Per-segment apply -> reply conversion (learning signal). Only segments with
  // enough applications to mean something are surfaced.
  function segment(dimFn, label) {
    const map = new Map();
    for (const j of jobs) {
      if (!APPLIED_SET.has(j.status)) continue;
      const key = dimFn(j) || "—";
      if (!map.has(key)) map.set(key, { key, label, applied: 0, replied: 0 });
      const s = map.get(key);
      s.applied++;
      if (REPLIED_SET.has(j.status)) s.replied++;
    }
    return [...map.values()].filter((s) => s.applied >= 2)
      .map((s) => ({ ...s, rate: pct(s.replied, s.applied) }))
      .sort((a, b) => a.rate - b.rate);
  }
  const scoreBand = (j) => j.score >= 4 ? "4.0+" : j.score >= 3.5 ? "3.5–3.9" : j.score >= 3 ? "3.0–3.4" : "<3.0";
  const companyType = (j) => j.isHeadhunter ? "agency/HH" : (j.risk && j.risk.level === "high" ? "high-risk co." : "direct employer");
  const segments = {
    byCountry: segment((j) => j.country, "country"),
    byScore: segment(scoreBand, "score band"),
    byArchetype: segment((j) => (j.archetype || "").split(/[/,]/)[0].trim(), "archetype"),
    byType: segment(companyType, "company type"),
  };

  // Rejection-reason tally → suggested auto-filters (closes the loop).
  const reasons = {};
  for (const j of jobs) {
    const r = j.outcome && j.outcome.rejectionReason;
    if (!r) continue;
    reasons[r] = (reasons[r] || 0) + 1;
  }
  const reasonTally = Object.entries(reasons)
    .map(([k, count]) => ({ key: k, label: REASON_LABELS[k] || k, count }))
    .sort((a, b) => b.count - a.count);
  const suggestions = reasonTally.filter((r) => r.count >= 2 && ["no-sponsorship", "language", "domain-mismatch", "agency"].includes(r.key))
    .map((r) => `You've closed ${r.count} jobs for “${r.label}” — consider auto-eliminating this pattern earlier in the pipeline.`);

  return { funnel, rates, segments, reasonTally, suggestions, reasonLabels: REASON_LABELS };
}

// Per-job calibration hint: how have *similar* past applications converted?
// Used to annotate To-Apply cards. Non-destructive — never rewrites the score.
function calibrationFor(job, jobs) {
  // Only meaningful once reply-tracking has actually started. If no applied job
  // has been marked Replied/Interview/Offer yet, a "0/N replied" chip would be a
  // logging artefact, not a signal — so suppress it entirely.
  if (!jobs.some((j) => REPLIED_SET.has(j.status))) return null;
  const band = job.score >= 4 ? "4.0+" : job.score >= 3.5 ? "3.5–3.9" : job.score >= 3 ? "3.0–3.4" : "<3.0";
  const bandOf = (j) => j.score >= 4 ? "4.0+" : j.score >= 3.5 ? "3.5–3.9" : j.score >= 3 ? "3.0–3.4" : "<3.0";
  const peers = jobs.filter((j) => j.number !== job.number && APPLIED_SET.has(j.status) &&
    (j.archetype || "").split(/[/,]/)[0].trim() === (job.archetype || "").split(/[/,]/)[0].trim() &&
    bandOf(j) === band);
  if (peers.length < 3) return null;
  const replied = peers.filter((j) => REPLIED_SET.has(j.status)).length;
  return { applied: peers.length, replied, rate: Math.round((replied / peers.length) * 100), archetype: (job.archetype || "similar").split(/[/,]/)[0].trim() };
}

// --- hygiene: stale + duplicate sweep (feature #5) -----------------------
function computeHygiene(jobs) {
  const today = new Date().toISOString().slice(0, 10);
  const staleJobs = jobs.filter((j) => j.status === "evaluated" && j.stale);
  const expired = staleJobs.filter((j) => (j.deadline && j.deadline < today) || j.ageDays > 45);
  const duplicates = jobs.filter((j) => j.isDuplicate && j.status === "evaluated");
  const ids = [...new Set([...staleJobs, ...duplicates].map((j) => j.reportNumber))];
  return {
    staleCount: staleJobs.length,
    expiredCount: expired.length,
    duplicateCount: duplicates.length,
    archivableIds: ids,
    stale: staleJobs.slice(0, 60).map((j) => ({ n: j.reportNumber, company: j.company, role: j.role, ageDays: j.ageDays })),
    duplicates: duplicates.slice(0, 60).map((j) => ({ n: j.reportNumber, company: j.company, role: j.role, dupCount: j.dupCount })),
  };
}

// --- pipeline (raw discovered offers, not yet evaluated) -----------------

async function loadPipeline(lane = "fulltime") {
  const file = lane === "freelance" ? "freelance-pipeline.md" : "pipeline.md";
  try {
    const md = await readFile(join(ROOT, "data", file), "utf8");
    // Anchor the section start to a real heading LINE (^## …$) — not any "## Pendientes"
    // substring, which can appear inside a malformed offer cell and truncate the list.
    const startM = md.match(/^##\s*Pendientes.*$/m);
    const sec = startM ? md.slice(startM.index + startM[0].length).split(/\n##\s/)[0] : "";
    const items = [];
    for (const line of sec.split("\n")) {
      const m = line.match(/^-\s*\[ \]\s*(\S+)\s*\|\s*(.+)$/);
      if (!m) continue;
      const parts = m[2].split("|").map((s) => s.trim());
      items.push({ url: m[1], company: parts[0] || "", title: parts[1] || "", location: parts[2] || "", isHeadhunter: isHeadhunterCompany(parts[0]) });
    }
    return items;
  } catch {
    return [];
  }
}

// --- locations -----------------------------------------------------------

async function loadLocations() {
  try {
    const raw = await readFile(LOCATIONS_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.regions)) throw new Error("bad shape");
    return data;
  } catch {
    // Self-heal: write defaults if missing/corrupt.
    await saveLocations(DEFAULT_LOCATIONS);
    return DEFAULT_LOCATIONS;
  }
}

function sanitizeLocations(input) {
  const slug = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const regions = (Array.isArray(input.regions) ? input.regions : [])
    .filter((r) => r && (r.label || r.country))
    .map((r) => {
      const label = String(r.label || r.country || "").trim();
      const toArr = (v) =>
        Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
          : String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
      return {
        id: slug(r.id) || slug(label) || "region-" + Math.random().toString(36).slice(2, 7),
        label,
        country: String(r.country || "").trim(),
        cities: toArr(r.cities),
        keywords: toArr(r.keywords),
        enabled: r.enabled !== false,
      };
    });
  return { remote_ok: input.remote_ok !== false, regions };
}

async function saveLocations(data) {
  const clean = sanitizeLocations(data);
  await writeFile(LOCATIONS_PATH, JSON.stringify(clean, null, 2) + "\n", "utf8");
  return clean;
}

// --- sources (search sites the scanner queries) --------------------------

// Static list of search engines / portals the local scanner + portals.yml use.
const SEARCH_ENGINES = [
  { name: "LinkedIn Jobs (guest)", url: "https://www.linkedin.com/jobs/search", note: "Rol × lokasyon, login'siz — yerel tarayıcı otomatik çeker", auto: true },
  { name: "Greenhouse Job Boards", url: "https://www.greenhouse.io", note: "Takip edilen şirketlerin ATS panoları (JSON API)", auto: true },
  { name: "Lever", url: "https://jobs.lever.co", note: "ATS panoları (JSON API)", auto: true },
  { name: "SmartRecruiters", url: "https://jobs.smartrecruiters.com", note: "ATS panoları (JSON API)", auto: true },
  { name: "Ashby", url: "https://jobs.ashbyhq.com", note: "ATS panoları (JSON API)", auto: true },
  // config/job-boards.json adaptörleri — scan-jobs.mjs her koşuda çeker
  { name: "kariyer.net", url: "https://www.kariyer.net", note: "TR panosu — Türkçe rol sorguları, yerel tarayıcı otomatik çeker", auto: true },
  { name: "techcareer.net", url: "https://www.techcareer.net/jobs", note: "TR teknoloji panosu — en yeni ilanlar, otomatik", auto: true },
  { name: "Arbeitnow", url: "https://www.arbeitnow.com", note: "Avrupa panosu (public JSON API), otomatik", auto: true },
  { name: "Remotive", url: "https://remotive.com", note: "Uzaktan panosu (public JSON API) — TR/EU uygun ilanlar, otomatik", auto: true },
  { name: "Jobicy", url: "https://jobicy.com", note: "Uzaktan panosu (public JSON API) — Europe/EMEA, otomatik", auto: true },
  { name: "Himalayas", url: "https://himalayas.app", note: "Uzaktan panosu (public JSON API) — worldwide/EU, otomatik", auto: true },
  { name: "hiring.cafe", url: "https://hiring.cafe", note: "Aggregatör (portals.yml arama sorguları)", auto: false },
  { name: "Indeed NL/DE", url: "https://nl.indeed.com", note: "Aggregatör (portals.yml arama sorguları)", auto: false },
  { name: "Glassdoor", url: "https://www.glassdoor.com/Job", note: "Aggregatör (portals.yml arama sorguları)", auto: false },
];

// Parse tracked_companies from portals.yml (name + board url + enabled).
async function loadPortalCompanies() {
  let yaml = "";
  try { yaml = await readFile(PORTALS_PATH, "utf8"); } catch { return []; }
  // Only the tracked_companies section (search_queries also use "- name:").
  yaml = yaml.split(/\ntracked_companies:/)[1] || "";
  const out = [];
  const blocks = yaml.split(/\n\s*-\s+name:\s*/).slice(1);
  for (const b of blocks) {
    const name = (b.match(/^(.+)/) || [])[1]?.trim();
    const careers = (b.match(/careers_url:\s*(\S+)/) || [])[1];
    const api = (b.match(/\n\s*api:\s*(\S+)/) || [])[1];
    const enabled = !/enabled:\s*false/.test(b);
    if (name) out.push({ name, url: careers || api || "", enabled });
  }
  return out;
}

// Classify a user-pasted URL so the UI/scanner knows how it'll be handled.
function detectSourceKind(url) {
  const u = (url || "").toLowerCase();
  if (/greenhouse\.io|lever\.co|smartrecruiters|ashbyhq|recruitee\.com|personio/.test(u)) return "ats";
  if (/linkedin\.com/.test(u)) return "linkedin";
  return "careers";
}

async function loadCustomSources() {
  try {
    const data = JSON.parse(await readFile(SOURCES_PATH, "utf8"));
    return Array.isArray(data.custom) ? data.custom : [];
  } catch {
    return [];
  }
}

async function saveCustomSources(custom) {
  await writeFile(SOURCES_PATH, JSON.stringify({ custom }, null, 2) + "\n", "utf8");
  return custom;
}

// --- cover letter generation ---------------------------------------------
// Composes a plain, natural English cover letter strictly from cv.md facts +
// the job's evaluation report. No invented experience; nothing that contradicts
// the CV. Deliberately avoids AI-slop phrasing (no "I am confident", "leverage",
// "passionate", "I am excited to", em-dash pile-ups).

const CV_PATHS = [join(ROOT, "cv.md"), join(ROOT, "data", "cv.md")];
const STOP = new Set("the and for with that into from your you our are was were will have has had can not but a an of to in on at by as is be it this their they them using use used able across team teams work working role roles".split(" "));

function stripCite(s) { return (s || "").replace(/\[cite_start\]/gi, "").replace(/\[cite:[^\]]*\]/gi, "").replace(/\s+/g, " ").trim(); }
function titleCase(s) { return (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()); }
function lcFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
function shortCompany(s) {
  return (s || "").split(",")[0].replace(/\b(Teknoloji|İletişim|Iletisim|A\.?Ş\.?|A\.?S\.?|B\.?V\.?|N\.?V\.?|GmbH|Inc|Ltd|LLC|Group)\b.*$/i, "").trim() || (s || "").split(",")[0].trim();
}

async function loadCvFacts() {
  let md = "";
  for (const p of CV_PATHS) { try { md = await readFile(p, "utf8"); break; } catch {} }
  if (!md) return null;
  const lines = md.split("\n");
  const name = titleCase((lines.find((l) => l.startsWith("# ")) || "# Candidate").replace(/^#\s*/, "").trim());
  const head = md.slice(0, 600);
  const email = (md.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || "";
  const phone = (md.match(/\+\d[\d ()-]{6,}\d/) || [])[0]?.trim() || "";
  const linkedin = (md.match(/linkedin\.com\/in\/[\w-]+\/?/i) || [])[0] || "";
  const years = (md.match(/\d+\+?\s*years/i) || ["several years"])[0];
  // experience entries
  const expSec = (md.split(/##\s*WORK EXPERIENCE/i)[1] || "").split(/\n##\s/)[0];
  const exp = [];
  for (const block of expSec.split(/\n###\s+/).slice(1)) {
    const bl = block.split("\n");
    const role = stripCite(bl[0]);
    const compLine = bl.find((l) => /\*\*/.test(l)) || "";
    const company = shortCompany(stripCite(compLine.replace(/\*\*/g, "").split("|")[0]));
    const bullets = bl.filter((l) => /^\s*\*\s/.test(l)).map((l) => stripCite(l.replace(/^\s*\*\s/, ""))).filter(Boolean);
    if (company && bullets.length) exp.push({ role, company, bullets });
  }
  // --- everything below is parsed live from cv.md, so editing the CV flows through ---
  const summary = stripCite((md.split(/##\s*PROFESSIONAL SUMMARY/i)[1] || "").split(/\n##\s/)[0]).trim();
  const university = (md.match(/\*\*([^*]*University[^*]*)\*\*/i) || [])[1]?.split(",")[0].trim() || "";
  const degreeRaw = (md.match(/Master of Science:?\s*([^\n*|]+)/i) || md.match(/M\.?Sc\.?(?:\s+in)?:?\s*([^\n*|.,]+)/i) || [])[1] || "";
  const degree = stripCite(degreeRaw).replace(/\s+and society/i, "").trim() || "Data Science";
  const eduLine = `an M.Sc. in ${degree}${university ? ` from ${university}` : ""}`;
  const proof = {
    cost: (md.match(/costs?\s+by\s+up\s+to\s+(\d+%)/i) || [])[1] || "",
    records: (md.match(/([\d,]{4,})\+?\s*records/i) || [])[1] || "",
    accuracy: (md.match(/accuracy\s+to\s+(\d+%)/i) || [])[1] || "",
    patent: (md.match(/Patent[^:]*:\**\s*([A-Za-z][^(.\n]+)/i) || [])[1]?.trim() || "",
  };
  // skills detected from the CV text
  const TOOLS = ["SQL", "Python", "Power BI", "Tableau", "MicroStrategy", "Looker", "Qlik", "BigQuery", "dbt", "R", "Excel", "TensorFlow", "PyTorch", "Spark", "Snowflake", "Databricks", "SAS", "SPSS", "Google Analytics"];
  const BI = new Set(["Power BI", "Tableau", "MicroStrategy", "Looker", "Qlik"]);
  const found = TOOLS.filter((t) => new RegExp("(^|[^\\w])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^\\w]|$)", "i").test(md));
  const asList = (a) => a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : (a[0] || "");
  const skills = asList(found.filter((t) => !BI.has(t)).slice(0, 4)) || "SQL and Python";
  const biSkills = asList(found.filter((t) => BI.has(t)).slice(0, 3)) || "Power BI";
  // background span ("8-year ... background")
  const background = (summary.match(/(\d+)-year/i) || [])[1] || "";
  // academic / portfolio projects
  const projSec = (md.split(/##\s*ACADEMIC PROJECTS/i)[1] || md.split(/##\s*PROJECTS/i)[1] || "").split(/\n##\s/)[0];
  const projects = [];
  for (const block of projSec.split(/\n###\s+/).slice(1)) {
    const bl = block.split("\n");
    const rawTitle = stripCite(bl[0]).replace(/\*\*/g, "").trim();
    const title = rawTitle.replace(/^[^:]*Thesis:\s*/i, "").replace(/^[^:]+:\s*/, (m) => /thesis|project/i.test(m) ? "" : m);
    const bullets = bl.filter((l) => /^\s*\*\s/.test(l)).map((l) => stripCite(l.replace(/^\s*\*\s/, ""))).filter(Boolean);
    const metric = (block.match(/(\d+%|\$[\d,]+|[\d,]{4,}\+?\s*records)/i) || [])[0] || "";
    if (rawTitle) projects.push({ rawTitle, title: title || rawTitle, bullets, metric });
  }
  const methods = { xai: /\b(SHAP|explainable|XAI)\b/i.test(md), opt: /\b(LP|MILP|optimi[sz]ation|linear programming)\b/i.test(md), dl: /\b(deep learning|CNN|neural network)\b/i.test(md) };
  return { name, email, phone, linkedin, years, exp, summary, eduLine, degree, university, proof, skills, biSkills, background, projects, methods };
}

// Optional personal profile (config/profile.yml is gitignored & user-specific).
// Lets answers state base location / work eligibility without hardcoding them.
async function loadProfile() {
  try {
    const y = await readFile(join(ROOT, "config", "profile.yml"), "utf8");
    const get = (k) => { const m = y.match(new RegExp("^\\s*" + k + ":\\s*\"?([^\"\\n]+?)\"?\\s*(?:#.*)?$", "mi")); return m ? m[1].replace(/\[cite_start\]/g, "").trim() : ""; };
    return { city: get("city"), country: get("country"), location: get("location"), visa: get("visa_status") };
  } catch { return {}; }
}

async function reportMarkdown(n) {
  try {
    const files = await readdir(join(ROOT, "reports"));
    const variants = [n, n.padStart(3, "0"), String(parseInt(n, 10))];
    const f = files.find((x) => x.endsWith(".md") && variants.some((v) => x.startsWith(v + "-")));
    if (f) return await readFile(join(ROOT, "reports", f), "utf8");
  } catch {}
  return "";
}

function parseReportForLetter(md, fallbackCompany, fallbackRole) {
  const titleLine = (md.match(/^#\s*Evaluation[^:]*:\s*(.+)$/im) || [])[1] || "";
  let company = fallbackCompany || "", role = fallbackRole || "";
  if (titleLine.includes("--")) {
    const [c, r] = titleLine.split(/\s+--\s+/);
    company = company || (c || "").trim();
    role = role || (r || "").trim();
  }
  role = (role || "this role").replace(/\((?:all genders|m\/w\/d|f\/m\/d|m\/f\/d|w\/m\/d|f\/m\/x|m\/f\/x|d\/f\/m)\)/gi, "").replace(/\s+/g, " ").trim();
  const sector = (md.match(/\|\s*\*\*Domain\*\*\s*\|\s*([^|]+?)\s*\|/i) || [])[1] || "";
  const strong = [];
  for (const line of md.split("\n")) {
    if (!/\*\*Strong\*\*/i.test(line) || !line.trim().startsWith("|")) continue;
    const first = line.replace(/^\|/, "").split("|")[0].replace(/\*\*/g, "").trim();
    if (first) strong.push(first);
  }
  return { company: company || "your company", role: role || "this role", sector, strong };
}

function composeCoverLetter(cv, rep, seed) {
  const s = Math.abs(seed | 0);
  const jobText = [rep.role, rep.sector, rep.strong.join(" ")].join(" ");
  const kw = new Set((jobText.toLowerCase().match(/[a-zçğıöşü]+/g) || []).filter((w) => w.length >= 3 && !STOP.has(w)));
  // high-value data terms get a standing bonus; weak "support" verbs get a penalty,
  // so concrete achievements outrank generic intern/PMO lines.
  const HIGHVAL = new Set("sql python power bi tableau forecasting forecast predictive modeling model optimization optimisation dashboard dashboards etl analysis analytics statistical campaign conversion segmentation roi kpi journey time series microstrategy".split(" "));
  const WEAKLEAD = /^(facilitated|supported|assisted|documented|tracked|helped|participated|attended)/i;
  const scored = [];
  for (const e of cv.exp) for (const b of e.bullets) {
    const words = b.toLowerCase().match(/[a-zçğıöşü]+/g) || [];
    let sc = 0;
    for (const w of words) { if (kw.has(w)) sc += 1; if (HIGHVAL.has(w)) sc += 2; }
    if (WEAKLEAD.test(b)) sc -= 4;
    scored.push({ company: e.company, bullet: b, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  const picks = []; const seen = new Set();
  for (const x of scored) { if (picks.length >= 2) break; if (seen.has(x.company)) continue; picks.push(x); seen.add(x.company); }
  for (const x of scored) { if (picks.length >= 2) break; if (!picks.includes(x)) picks.push(x); }

  const headline = /scientist/i.test(rep.role) ? "data scientist"
    : /business analyst/i.test(rep.role) ? "analyst with a strong data and BI background"
    : /engineer/i.test(rep.role) ? "data analyst who works close to the data and the business"
    : "data analyst";

  const openings = [
    `I'd like to apply for the ${rep.role} position at ${rep.company}.`,
    `I'm writing about the ${rep.role} role at ${rep.company}.`,
    `The ${rep.role} opening at ${rep.company} matches my background well, so I'd like to put myself forward.`,
  ];
  const closings = [
    `I'd welcome the chance to talk about how I can help ${rep.company} get more out of its data. Thank you for considering my application.`,
    `Happy to walk through any of this in more detail. Thanks for your time.`,
    `I'd be glad to discuss how my experience could support the team at ${rep.company}. Thank you for reading.`,
  ];

  const end = (b) => /[.!?]$/.test(b) ? b : b + ".";
  const p1 = `${openings[s % openings.length]} I'm a ${headline} with ${cv.years} of hands-on experience in reporting, forecasting, and turning messy data into decisions people can act on.`;

  let p2 = "";
  if (picks[0]) p2 += `At ${picks[0].company}, I ${end(lcFirst(picks[0].bullet))}`;
  if (picks[1]) p2 += ` Before that, at ${picks[1].company}, I ${end(lcFirst(picks[1].bullet))}`;

  // pick a topic-like strong requirement (skip years/degree/language/location lines)
  const topicReq = rep.strong.find((r) => !/^\s*\d/.test(r) && !/\b(years?|yrs|degree|bachelor|master|location|english|dutch|german|onsite|on-site|remote|relocat|eligib|visa|permit)\b/i.test(r));
  const reqLine = topicReq ? ` Your emphasis on ${topicReq.replace(/\.$/, "")} maps directly to the core of my recent work.` : "";
  const p3 = `I recently completed ${cv.eduLine}, and I work day to day across ${cv.skills}, with ${cv.biSkills} for reporting and dashboards.${reqLine}`;

  const p4 = closings[s % closings.length];
  const contact = [cv.email, cv.phone, cv.linkedin].filter(Boolean).join(" · ");
  const sign = `Best regards,\n${cv.name}${contact ? "\n" + contact : ""}`;

  return [`Dear ${rep.company} team,`, p1, p2.trim(), p3, p4, sign].filter(Boolean).join("\n\n");
}

// --- interview prep ------------------------------------------------------
// Builds likely questions for a given interviewer persona + role, each with a
// CV-consistent English sample answer. Same anti-AI-slop, no-invention rules.

const PERSONA_LABELS = { hr: "HR / Recruiter", manager: "Hiring Manager", technical: "Technical Screen", director: "Director / Senior Leader" };

function composeInterview(cv, rep, persona, prof = {}) {
  persona = PERSONA_LABELS[persona] ? persona : "hr";
  const role = rep.role, company = rep.company;
  const sectorShort = (rep.sector || "").split(/[—,(]/)[0].trim();
  const strong = rep.strong[0] ? rep.strong[0].replace(/\.$/, "") : "";
  const topicReq = rep.strong.find((r) => !/^\s*\d/.test(r) && !/\b(years?|yrs|degree|location|english|dutch|german|onsite|on-site|remote|relocat|visa|permit)\b/i.test(r));
  const gap = (rep.gaps && rep.gaps[0] && rep.gaps[0].name) ? rep.gaps[0].name.replace(/\.$/, "") : "";
  const isDS = /scientist/i.test(role), isDE = /engineer/i.test(role), isBA = /business analyst/i.test(role);
  const fname = (cv.name || "").split(" ")[0] || "I";

  // location / work-eligibility come from config/profile.yml (gitignored), never hardcoded
  const baseLoc = (prof.city || (prof.location || "").split(",")[0] || "").replace(/\(.*$/, "").trim();
  const country = (prof.country || "").trim();
  const theCountry = country && /^(netherlands|united states|usa|uk|united kingdom|philippines|uae|emirates)$/i.test(country) ? "the " + country : country;
  const noSponsor = /no sponsorship|does not need|work authoriz|work authoris|full .*work/i.test(prof.visa || "");
  const workAnswer = (baseLoc || country)
    ? `Yes — I'm based in ${baseLoc || theCountry} and authorised to work in ${theCountry || baseLoc}${noSponsor ? ", so there's no sponsorship needed" : ""}. I can start on a standard notice and I'm flexible on the exact date.`
    : `Yes — I can work in this role's location. (Set your base location and work-eligibility in config/profile.yml to personalise this answer.) I can start on a standard notice and I'm flexible on the exact date.`;
  const salaryAnswer = `I'm flexible and mostly focused on the fit and the scope of the role. I've looked at the market for ${role} roles${theCountry ? ` in ${theCountry}` : ""} and I'd expect something in line with that range — happy to discuss specifics once we both feel it's a match.`;

  const bulletWith = (kw) => { for (const e of cv.exp) for (const b of e.bullets) if (b.toLowerCase().includes(kw)) return { c: e.company, b: b.replace(/\.$/, "") }; return null; };
  const fc = bulletWith("forecast"), camp = bulletWith("campaign") || bulletWith("predictive"), journey = bulletWith("journey"), demand = bulletWith("demand"), biB = bulletWith("business requirements") || bulletWith("power bi");
  const proofLine = [
    cv.proof.cost && `at the World Food Programme I modelled supply chains with LP/MILP and found scenarios that cut costs by up to ${cv.proof.cost}`,
    camp && `at ${camp.c} I ${lcFirst(camp.b)}`,
  ].filter(Boolean)[0] || "I focus on work that moves a real business metric";

  // pick the CV project most relevant to this job (falls back to the first)
  const pickProject = () => {
    if (!cv.projects || !cv.projects.length) return null;
    const pk = new Set(((role + " " + (rep.sector || "") + " " + rep.strong.join(" ")).toLowerCase().match(/[a-zçğıöşü]{4,}/g) || []));
    let best = cv.projects[0], bs = -1;
    for (const p of cv.projects) {
      const txt = (p.rawTitle + " " + p.bullets.join(" ")).toLowerCase();
      let sc = 0; for (const w of pk) if (txt.includes(w)) sc++;
      if (sc > bs) { bs = sc; best = p; }
    }
    return best;
  };
  const proj = pickProject();
  const projDesc = proj && proj.bullets[0] ? lcFirst(proj.bullets[0]).replace(/\.$/, "") : "";

  // project deep-dive story (DS/technical lead with a portfolio project; others with applied BI)
  const projectStory = (isDS || persona === "technical") && proj
    ? `A good example is my project, "${proj.title}". I ${projDesc || "built and validated the model end to end"}${proj.metric && !projDesc.toLowerCase().includes(proj.metric.toLowerCase()) ? ` (${proj.metric})` : ""}.${cv.methods.xai ? " I leaned on explainable methods like SHAP so stakeholders could see why the model behaved as it did and run what-if scenarios." : ""} The interesting part was making the results both accurate and easy to trust.`
    : `${fc ? `At ${fc.c}, I ${lcFirst(fc.b)} to support planning.` : "I led forecasting and reporting work."} I owned it end to end: pulling and cleaning the data in SQL, building the model, then turning it into ${biB ? `${cv.biSkills} dashboards the business actually used` : "dashboards the business actually used"}.${cv.proof.cost ? ` In a separate optimisation project I found scenarios that surfaced up to ${cv.proof.cost} in potential savings.` : ""}`;

  const gapAnswer = gap
    ? `Honestly, ${lcFirst(gap)} is the area I'd be newest to, and I'd rather be straight about that. The adjacent experience is there — strong SQL, modelling and BI work — and I pick up tools quickly; I taught myself the dbt and BigQuery side recently. I'd expect to be productive fast and ask good questions early.`
    : `I'd want to understand the team's stack and priorities first, then lean on my SQL, modelling and BI background to contribute quickly while filling any specific tool gaps as I go.`;

  const P = {
    hr: [
      ["Tell me about yourself.", `I'm a data analyst with ${cv.years} of hands-on analytics experience, across telecom, e-commerce and tech, and I recently finished ${cv.eduLine}. Day to day I work in ${cv.skills}, and I'm at my best turning messy data into something a business can decide on. The ${role} role at ${company} is exactly the kind of work I want to keep doing.`],
      [`Why do you want to work at ${company}?`, `${sectorShort ? `I like that the role sits in ${sectorShort.toLowerCase()}, where good data work has a clear, measurable impact.` : "The role looks like a place where analytics directly shapes decisions."} ${topicReq ? `Your focus on ${lcFirst(topicReq)} lines up closely with what I've been doing.` : ""} I'm also looking for a team where I can grow into more senior, ownership-heavy work, and ${company} fits that.`],
      ["Why are you looking now?", `I just completed my M.Sc. in Data Science, so the timing is natural — I'm ready to put it to work in a role with more scope. I've built a solid analytics foundation over ${cv.years}, and I want my next step to be a place where I can own data products end to end.`],
      ["What are your salary expectations?", salaryAnswer],
      ["Are you authorised to work here, and when could you start?", workAnswer],
      ["What's a strength, and something you're working on?", `My strength is sitting between the technical and the business side — I can write the SQL and build the model, but also explain it to stakeholders so they act on it. ${gap ? `Something I'm actively building is ${lcFirst(gap)}; I've been closing that gap with self-study and projects.` : "Something I keep working on is staying concise when I present technical results to non-technical audiences."}`],
    ],
    manager: [
      ["Walk me through a data project you're proud of.", projectStory],
      ["How do you approach a new reporting request or a fresh dataset?", `I start with the question behind the request, not the data — what decision does this support? Then I profile the data, check quality and gaps, build the simplest thing that answers it, and validate against something known. I show an early version to the stakeholder fast, because the first version is usually wrong in a useful way, and iterate from there.`],
      ["How strong is your SQL and BI tooling?", `SQL is my core tool. ${fc ? `At ${fc.c}, I ${lcFirst(fc.b)}.` : "I use it daily for analysis and modelling."} On the BI side I've built dashboards in ${cv.biSkills}${biB ? `; at ${biB.c}, I ${lcFirst(biB.b)}` : ", and I focus on making them genuinely useful rather than just pretty"}.`],
      ["Tell me about working with stakeholders.", `${biB ? `At ${biB.c}, I ${lcFirst(biB.b)}, which meant a lot of back-and-forth to translate vague business asks into something concrete.` : "Most of my work has involved translating vague business questions into concrete analysis."} ${journey ? `Earlier, at ${journey.c}, I ${lcFirst(journey.b)}.` : ""} I've learned to confirm the question early and report in plain language.`],
      [topicReq ? `This role leans on ${topicReq.toLowerCase()}. How would you handle it?` : "How would you make an impact in the first 90 days?", `${topicReq ? `That's close to my recent work. ` : ""}I'd spend the first weeks understanding the data, the stakeholders and the current reporting, find one or two quick wins to build trust, and in parallel map the foundational work. ${proofLine.charAt(0).toUpperCase() + proofLine.slice(1)} — I'd bring that same outcome-first mindset here.`],
      [gap ? `We also need ${gap}. How comfortable are you with that?` : "What part of this role would be a stretch for you?", gapAnswer],
    ],
    technical: [
      ["How would you find, say, the top customer per region in SQL?", `I'd use a window function — RANK() or ROW_NUMBER() partitioned by region and ordered by the metric, then filter to rank 1. I reach for window functions a lot; in my forecasting and trend work I used them for running totals, period-over-period and ranking.`],
      ["How do you handle missing data and outliers?", `It depends on why they're missing. I'll use mean/median or a constant for simple cases, model-based or logic-driven imputation when the pattern matters, and I'm careful to flag rather than silently fill. For outliers I check whether they're errors or real signal before deciding to cap, transform or keep them.`],
      ["Explain a model you built and how you evaluated it.", `${proj ? `In "${proj.title}", I ${projDesc || "built and validated the model"}${/%|\$/.test(proj.metric) && !projDesc.includes(proj.metric) ? `, reaching ${proj.metric}` : ""}. ` : ""}I always hold out a validation set and choose metrics that match the business cost of being wrong, not just accuracy.${cv.methods.xai ? " When stakeholders need to trust the output, I add SHAP so the drivers are transparent." : ""}`],
      ["When would you use classification vs. regression, or an optimisation model?", `Regression when I'm predicting a number like demand, classification for a category like churn yes/no, and optimisation when the goal is the best decision under constraints. I've used all three — time-series forecasting for planning, classification with deep learning, and LP/MILP optimisation for a supply-chain network${cv.proof.cost ? ` that found up to ${cv.proof.cost} in cost savings` : ""}.`],
      ["How would you speed up a slow dashboard or a heavy query?", `I'd push aggregation down into SQL instead of the BI layer, pre-compute heavy joins, add the right indexes or partitions, and only pull the grain the dashboard actually needs. For very large files I process in chunks rather than loading everything into memory at once.`],
      ["How would you automate a recurring report in Python?", `I'd script the pull-transform-output in Python, parameterise the dates, and schedule it so it runs on its own and writes to the same place each time. I use Python mainly for data processing and automation like this, which removes the manual copy-paste work and the errors that come with it.`],
    ],
    director: [
      ["How does your work drive business impact?", `I try to tie every analysis to a number the business cares about. ${cv.proof.cost ? `In a supply-chain optimisation project I found scenarios that could cut operating costs by up to ${cv.proof.cost}.` : ""} ${camp ? `At ${camp.c} I ${lcFirst(camp.b)}.` : ""} ${cv.proof.patent ? `I also hold a patent for a ${cv.proof.patent.toLowerCase()} that automated post-campaign analysis.` : ""}`.replace(/\s+/g, " ").trim()],
      ["How do you prioritise when everything is urgent?", `I rank by business value and reversibility — what unblocks a decision, what's expensive to get wrong, what's a quick win that buys trust. I'll be explicit with stakeholders about trade-offs rather than quietly trying to do everything, and I separate the foundational work from the firefighting so the foundation actually gets built.`],
      ["How do you make data trustworthy for decision-makers?", `Two things: rigour and explainability. I validate against known numbers and keep the lineage clear, and I lean on explainable methods — in my thesis I used SHAP specifically so non-technical stakeholders could see why a forecast moved and run what-if scenarios. People act on numbers they understand and can question.`],
      ["Tell me about influencing across teams without formal authority.", `${journey ? `At ${journey.c}, I ${lcFirst(journey.b)} across both face-to-face and digital channels, which only worked by getting different teams aligned on the same picture.` : "Most of my impact has come from getting different teams aligned on the same data."} ${cv.summary && /stakeholder/i.test(cv.summary) ? "Bridging technical teams and business stakeholders is genuinely the part I'm known for." : "I bring people along by making the analysis clear and the trade-offs honest."}`],
      [sectorShort ? `Where do you see ${sectorShort.toLowerCase()} and data heading, and how do you fit?` : "Where do you see this role heading?", `Data work is moving toward faster, more self-serve insight and more accountability for outcomes, not just dashboards. That suits me — I combine a fresh M.Sc. on the modelling and XAI side with ${cv.years} of practical analytics and a business background, so I can build the thing and explain why it matters.`],
      ["Why should we hire you over other candidates?", `It's the combination. I have ${cv.years} of real analytics delivery, a recent ${cv.eduLine} with hands-on ${cv.methods.opt ? "optimisation and " : ""}${cv.methods.xai ? "explainable-AI work" : "modelling work"}, and ${cv.background ? `a ${cv.background}-year` : "a long"} career that started on the business side — so I read the business and the data. For a ${role} at ${company}, that mix means quick contribution without losing the bigger picture.`],
    ],
  };

  const items = (P[persona] || P.hr).map(([q, a]) => ({ q, a: a.replace(/\s+/g, " ").trim() }));
  return { persona, personaLabel: PERSONA_LABELS[persona], company, role, items };
}

// --- pros & cons (rational, critical decision aid) -----------------------
// Reads the job's evaluation report + CV facts and produces a clear-eyed
// pros / cons split plus a bottom-line call. Critical, not a cheerleader.

function parseReportFull(md, fc, fr) {
  const base = parseReportForLetter(md, fc, fr);
  const score = parseFloat((md.match(/\*\*Score:\*\*\s*([\d.]+)\s*\/\s*5/i) || [])[1] || "0") || 0;
  const language = detectLanguage(md);
  const gaps = parseGaps(md);
  const cellOf = (label) => (md.slice(0, 2500).match(new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*([^|]+?)\\s*\\|`, "i")) || [])[1] || "";
  const remote = cellOf("Remote");
  const seniority = cellOf("Seniority");
  const verdict = stripCite((md.match(/\*\*Verdict:\*\*\s*([\s\S]*?)(?:\n#{1,3}\s|\n---|\n\n|$)/i) || [])[1] || "").trim();
  return { ...base, score, language, gaps, remote, seniority, verdict };
}

function composeProsCons(cv, rep) {
  const pros = [], cons = [];
  const role = rep.role, company = rep.company;

  // ---- pros ----
  rep.strong.slice(0, 4).forEach((r) => pros.push(`Direct match — ${r.replace(/\.$/, "")}; this is already in your background.`));
  if (rep.score >= 4.0) pros.push(`High overall fit (${rep.score}/5) — one of your stronger options, so the effort is well spent.`);
  if (!rep.language) pros.push("No Dutch or German requirement flagged — language isn't a barrier here.");
  if (/remote|hybrid/i.test(rep.remote)) pros.push(`Working setup is flexible (${rep.remote.trim()}).`);
  if (rep.sector) pros.push(`The domain (${rep.sector}) maps to your analytics experience, so you can speak the business language.`);
  if (cv.proof.cost || cv.proof.records) pros.push("You have quantified, portfolio-grade proof points to lead with (cost savings, large-scale modelling, a patent).");

  // ---- cons ----
  (rep.gaps || []).forEach((g) => cons.push(`${g.name.replace(/\.$/, "")}${g.severity ? ` — ${g.severity.toLowerCase()} severity` : ""}; prepare a credible answer for this.`));
  if (rep.language) cons.push(`${rep.language} is required and yours is ${rep.language === "Dutch" ? "only A1" : "limited"} — treat this as a likely hard blocker unless the team genuinely works in English.`);
  if (/data engineer/i.test(role) && !/analyt|analyst|scientist/i.test(role)) cons.push("This is a Data Engineer role — more pipelines and infrastructure than analytics; it sits adjacent to your profile, not at its centre.");
  if (/principal|head of|director|staff/i.test(role)) cons.push("Seniority is pitched high (Principal/Staff/Head) — you'd be competing against more tenured candidates and may be down-levelled.");
  if (/intern|werkstudent|working student|entry[- ]level|junior/i.test(role)) cons.push("The title is framed junior/entry-level — likely below your experience and pay expectations.");
  if (/recruit|staffing|consult|professionals|global|associates|agency/i.test(company)) cons.push("Looks like a recruiter/agency listing — weaker signal; the real employer, stack and comp may differ from the post.");
  if (rep.score && rep.score < 3.5) cons.push(`Modest overall fit (${rep.score}/5) — be honest about whether this clears the bar versus your stronger targets.`);
  if (!rep.gaps?.length && !rep.language && rep.score >= 4) cons.push("Few obvious gaps surfaced — double-check the full JD yourself; a clean report can also mean a thin one.");

  // ---- bottom line ----
  let bottom;
  if (rep.language) bottom = `Bottom line: probably skip unless the working language is actually English. The ${rep.language} requirement outweighs the skills match — confirm it before spending time tailoring.`;
  else if (rep.score >= 4.0) bottom = `Bottom line: apply, and prioritise it. Strong fit with no hard blocker — tailor the CV to "${rep.strong[0] || "the core requirement"}" and lead with a quantified result.`;
  else if (rep.score >= 3.5) bottom = `Bottom line: a selective apply. The core is there but not overwhelming — worth it only if you tailor for "${rep.strong[0] || "the role's focus"}" and you're genuinely interested.`;
  else if (/data engineer/i.test(role) && !/analyt|analyst|scientist/i.test(role)) bottom = "Bottom line: low priority. It's adjacent (engineering-leaning) rather than a core analytics fit — apply only if you want to move toward data engineering on purpose.";
  else bottom = `Bottom line: low priority. The fit is partial (${rep.score || "—"}/5); only apply if something specific about ${company} motivates you beyond the score.`;

  return { company, role, score: rep.score, pros, cons, bottom, reportVerdict: rep.verdict };
}

// --- reference finder (LinkedIn referral targets) ------------------------
// Given the job's company + title, derives 3 high-value referral targets
// (hiring manager / a future peer / the recruiter) and builds LinkedIn
// people-search deep links scoped to that company + archetype. We NEVER
// invent names — each link opens LinkedIn in the user's own session and
// surfaces the real, current people who match. ToS-safe, always works.

function roleDomain(role) {
  const r = (role || "").toLowerCase();
  const map = [
    [/business intelligence|\bbi\b/, "Business Intelligence"],
    [/data scien/, "Data Science"],
    [/machine learning|\bml\b|\bai\b|\bnlp\b/, "Machine Learning"],
    [/business analy/, "Business Analytics"],
    [/data analy|\banalytics\b|\banalyst\b/, "Data Analytics"],
    [/data engineer/, "Data Engineering"],
    [/product (manage|owner|lead)/, "Product"],
    [/software|backend|front.?end|full.?stack|developer|\bengineer\b/, "Engineering"],
    [/market/, "Marketing"],
    [/financ|controll/, "Finance"],
    [/operations|supply|logistic/, "Operations"],
    [/sales|account exec|business develop/, "Sales"],
    [/people|talent|recruit|\bhr\b/, "People / HR"],
  ];
  for (const [re, d] of map) if (re.test(r)) return d;
  const words = (role || "").replace(/[^A-Za-z ]/g, " ").match(/[A-Za-z]{3,}/g) || [];
  return words.slice(0, 2).join(" ") || "the team";
}

// guess a LinkedIn company slug from a name (overridable via config/li-companies.json)
function slugifyCompany(name) {
  return (name || "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(b\.?v\.?|n\.?v\.?|gmbh|inc|ltd|llc|plc|corp|group|holding|international|global|benelux|emea)\b/g, " ")
    // drop a trailing country qualifier ("Acme Netherlands" → "acme")
    .replace(/\b(nederland|netherlands|deutschland|germany|belgium|belgie|france|espana|spain|italia|italy|the)\b\s*$/g, " ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function loadLiSlugs() {
  try { return JSON.parse(await readFile(join(ROOT, "config", "li-companies.json"), "utf8")); }
  catch { return {}; }
}

async function saveLiSlugs(map) {
  await writeFile(join(ROOT, "config", "li-companies.json"), JSON.stringify(map, null, 2) + "\n");
}

// pull a company slug and/or numeric id out of a pasted LinkedIn URL.
// accepts a company page (…/company/acme) or a people-search URL filtered
// to the company (…currentCompany=["1149"]…). Either is enough to scope right.
function parseLiCompanyInput(input) {
  const s = String(input || "").trim();
  let slug = "", id = "";
  let dec = s; try { dec = decodeURIComponent(s); } catch {}
  const idm = dec.match(/currentCompany=\[?"?(\d{2,})"?\]?/i) || dec.match(/fsd_company:(\d+)/i);
  if (idm) id = idm[1];
  const sm = s.match(/\/company\/([^/?#]+)/i);
  if (sm) {
    const v = decodeURIComponent(sm[1]);
    if (/^\d+$/.test(v)) id = id || v; else slug = v.toLowerCase();
  }
  return { slug, id };
}

// short, natural LinkedIn connection note per contact type — CV-grounded, no slop.
// [name] is left as a placeholder for the user to drop in the recipient's first name.
function outreachNote(kind, cv, company, role, domain, extra = {}) {
  const yrs = (cv.years || "several years").replace(/^over\s+/i, "");
  const skill = (cv.skills || "SQL").split(/,| and /)[0].trim();
  const dl = (domain || "data").toLowerCase();
  const M = {
    manager: `Hi [name], I came across the ${role} role at ${company} and it maps closely to my background — ${yrs} in ${dl} with ${skill}. I'd love to connect and learn more about the team, and to share how I could help.`,
    peer: `Hi [name], I'm exploring the ${role} role at ${company} and saw you're on the team. I'd love to connect and hear what the work is really like day to day — your perspective would mean a lot.`,
    recruiter: `Hi [name], I'm very interested in the ${role} role at ${company} — ${yrs} in ${dl}, strong with ${skill}. Would love to connect and make sure my application is on your radar.`,
    alumni: `Hi [name], fellow ${extra.university || "alum"} graduate here. I'm looking at the ${role} role at ${company} and noticed you work there — would love to connect and hear about your experience on the team.`,
    exEmployer: `Hi [name], I saw we both spent time at ${extra.pastCompany}. I'm exploring the ${role} role at ${company} where you are now — would love to connect and hear how you're finding it.`,
  };
  return (M[kind] || M.peer).replace(/\s+/g, " ").trim();
}

// expand bare country codes so the location term actually matches profiles
function normLocation(s) {
  const t = (s || "").trim();
  if (!t || /^remote$/i.test(t) || t === "-") return "";
  const codes = { nl: "Netherlands", nld: "Netherlands", de: "Germany", deu: "Germany", be: "Belgium", lu: "Luxembourg", uk: "United Kingdom", gb: "United Kingdom", us: "United States", usa: "United States", fr: "France", es: "Spain", it: "Italy", ie: "Ireland", ch: "Switzerland", at: "Austria", pl: "Poland", se: "Sweden", dk: "Denmark", pt: "Portugal" };
  return codes[t.toLowerCase()] || t;
}

function composeReferences(cv, rep, slugMap = {}) {
  const company = rep.company || "this company";
  const role = rep.role || "this role";
  const domain = roleDomain(role);
  const city = normLocation(rep.location);
  const cityOK = !!city;

  // resolve LinkedIn slug + (optional) numeric company id from cache.
  // cache value may be a plain slug string, or { slug, id }.
  const entry = slugMap[company];
  let slug = "", id = "";
  if (typeof entry === "string") slug = entry;
  else if (entry && typeof entry === "object") { slug = entry.slug || ""; id = String(entry.id || ""); }
  const slugGuessed = !slug;
  slug = slug || slugifyCompany(company);

  // All people links go through GLOBAL people search — the only filter LinkedIn
  // reliably honours via URL. (The company People-tab keyword param does NOT
  // deep-link a filter, so we dropped it.) With a numeric company id we add the
  // currentCompany facet → a true "works there NOW" filter; without it we anchor
  // on the quoted company name (real people, may include some past/fuzzy hits).
  const CC = id ? `&currentCompany=%5B%22${encodeURIComponent(id)}%22%5D` : "";
  const NET = "&network=%5B%22S%22%5D";
  const companyKw = id ? "" : `"${company}" `; // facet already scopes by company when id is known
  const search = (term, { net = false, loc = false } = {}) =>
    "https://www.linkedin.com/search/results/people/?keywords=" +
    encodeURIComponent((companyKw + term).trim() + (loc && cityOK ? ` ${city}` : "")) +
    CC + (net ? NET : "") + "&origin=FACETED_SEARCH";

  // clean peer title: drop seniority noise, keep the core role
  const peer = role.replace(/\b(senior|junior|lead|principal|staff|sr\.?|jr\.?|intern|werkstudent|m\/w\/d|f\/m\/d)\b/gi, "")
    .replace(/\s+/g, " ").trim() || domain;

  // urlBroad → all matching people at the company (any degree).
  // urlNet   → same, narrowed to 2nd-degree + location (people you can reach).
  const mk = (o) => ({ ...o, urlBroad: search(o.term), urlNet: search(o.term, { net: true, loc: true }) });

  const contacts = [
    mk({ archetype: "Hiring manager / team lead", kind: "manager",
      target: `${domain} leadership at ${company}`, term: `${domain} Manager`,
      why: `Most likely owns the ${role} headcount. A warm intro here puts your CV in front of the actual decision-maker.`,
      message: outreachNote("manager", cv, company, role, domain) }),
    mk({ archetype: "Future peer", kind: "peer",
      target: `${peer} already at ${company}`, term: peer,
      why: "Does this job today — the most credible person to refer you and tell you what the team is really like.",
      message: outreachNote("peer", cv, company, role, domain) }),
    mk({ archetype: "Recruiter / talent acquisition", kind: "recruiter",
      target: `${company} recruiting team`, term: "Recruiter Talent Acquisition",
      why: "Owns the pipeline for this opening. A short, specific message often gets you past the ATS filter.",
      message: outreachNote("recruiter", cv, company, role, domain) }),
  ];

  // --- CV-based warm paths (highest-converting referral routes) ---
  const warmPaths = [];
  if (cv && cv.university) {
    warmPaths.push(mk({ type: "alumni", label: `${cv.university} alumni at ${company}`,
      target: `${cv.university} graduates now at ${company}`, term: `"${cv.university}"`,
      why: "Shared university is the warmest possible opener — alumni reply far more often than cold contacts.",
      message: outreachNote("alumni", cv, company, role, domain, { university: cv.university }) }));
  }
  // most recent past employer that isn't the target company
  const past = (cv && cv.exp ? cv.exp.map((e) => e.company) : [])
    .filter((c) => c && c.toLowerCase() !== company.toLowerCase());
  if (past.length) {
    const pastCompany = past[0];
    warmPaths.push(mk({ type: "exEmployer", label: `Ex-${pastCompany} people now at ${company}`,
      target: `People who worked at ${pastCompany}, now at ${company}`, term: `"${pastCompany}"`,
      why: `Someone who also worked at ${pastCompany} shares your context — an easy, credible reason to reach out.`,
      message: outreachNote("exEmployer", cv, company, role, domain, { pastCompany }) }));
  }

  // browse-all link → the company People tab (lists current employees; the
  // user can search in-page). Uses the slug, so a wrong guess shows a generic
  // page — fix it once in config/li-companies.json.
  const peopleUrl = slug ? `https://www.linkedin.com/company/${slug}/people/` : "";

  const tip = `Connect with a short, specific note — name the ${role} role and one concrete reason you fit. Ask a genuine question before asking for a referral.`;
  return { company, role, domain, location: city, hasId: !!id, contacts, warmPaths, peopleUrl, slug, slugGuessed, tip };
}

// --- scanner trigger -----------------------------------------------------
// Runs web-dashboard/scan-jobs.mjs as a child process. This machine needs the
// system CA store for TLS, so we spawn node with --use-system-ca (same as the
// "scan:local" npm script). New in-scope offers land in data/pipeline.md →
// the dashboard's "Discovered" tab.

// Two independent scan lanes: full-time (scan-jobs.mjs → data/pipeline.md) and
// freelance (scan-freelance.mjs → data/freelance-pipeline.md). Each keeps its own
// status object so the dashboard can poll them separately. Property mutation (not
// reassignment) keeps the chosen reference valid inside the async child callbacks.
const scanStates = {
  fulltime: { running: false, startedAt: null, finishedAt: null, added: null, summary: "", error: null },
  freelance: { running: false, startedAt: null, finishedAt: null, added: null, summary: "", error: null },
};

function startScan(lane = "fulltime") {
  const st = scanStates[lane] || scanStates.fulltime;
  if (st.running) return false;
  Object.assign(st, { running: true, startedAt: Date.now(), finishedAt: null, added: null, summary: "", error: null });
  const script = lane === "freelance" ? "scan-freelance.mjs" : "scan-jobs.mjs";
  let out = "";
  try {
    const child = spawn(process.execPath, ["--use-system-ca", join(__dirname, script)], { cwd: ROOT });
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("error", (e) => { st.running = false; st.error = String(e.message || e); st.finishedAt = Date.now(); });
    child.on("close", (code) => {
      const m = out.match(/NEW (?:in-scope|freelance) added to pipeline:\s*(\d+)/i);
      st.added = m ? parseInt(m[1], 10) : 0;
      const cand = out.match(/Candidates:[^\n]*/i);
      st.summary = (cand ? cand[0] : "").trim();
      if (code !== 0 && st.added === null) st.error = `scan exited with code ${code}`;
      st.running = false; st.finishedAt = Date.now();
    });
  } catch (e) {
    st.running = false; st.error = String(e.message || e); st.finishedAt = Date.now();
  }
  return true;
}

// --- evaluate (Discovered → To Apply) ------------------------------------
// One-click scorer: caches JDs (fetch-jds.mjs), then runs the bundled Claude
// Code CLI headlessly (claude -p) against web-dashboard/evaluate-prompt.md to
// score each discovered job vs the CV and write reports/ + tracker-additions/,
// then merges into applications.md. Uses the user's existing Claude auth — no
// API key. Claude only writes files (acceptEdits), the deterministic steps run
// as node child processes.

let evalState = { running: false, startedAt: null, finishedAt: null, phase: "", evaluated: 0, error: null };

// locate the claude.exe the user already has (VS Code extension bundle), or fall
// back to a CLAUDE_BIN override / `claude` on PATH.
async function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const extRoot = join(home, ".vscode", "extensions");
  try {
    const dirs = (await readdir(extRoot)).filter((d) => /^anthropic\.claude-code-/.test(d)).sort();
    for (const d of dirs.reverse()) {
      const bin = join(extRoot, d, "resources", "native-binary", "claude.exe");
      if (existsSync(bin)) return bin;
    }
  } catch {}
  return process.platform === "win32" ? "claude.exe" : "claude";
}

// spawn a child, capture combined output, resolve with { code, out }. stdin is
// closed so `claude -p` doesn't wait for piped input.
function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd: ROOT, ...opts, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { return res({ code: -1, out: String(e.message || e), error: String(e.message || e) }); }
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("error", (e) => res({ code: -1, out: out + "\n" + String(e.message || e), error: String(e.message || e) }));
    child.on("close", (code) => res({ code, out }));
  });
}

function startEvaluate({ max = 40, perRound = 8, lane = "fulltime" } = {}) {
  if (evalState.running || scanStates.fulltime.running || scanStates.freelance.running) return false;
  const isFreelance = lane === "freelance";
  const promptFile = isFreelance ? "evaluate-freelance-prompt.md" : "evaluate-prompt.md";
  evalState = { running: true, startedAt: Date.now(), finishedAt: null, phase: "caching JDs", evaluated: 0, error: null, lane };
  (async () => {
    try {
      const bin = await resolveClaudeBin();
      // 1. cache JDs from the current lane's pipeline (deterministic, needs system CA)
      const fetchArgs = ["--use-system-ca", join(__dirname, "fetch-jds.mjs")];
      if (isFreelance) fetchArgs.push("--pipeline", join("data", "freelance-pipeline.md"));
      await run(process.execPath, fetchArgs);
      // 2. score in rounds — each round is a fresh headless Claude context
      evalState.phase = "scoring";
      let total = 0, rounds = 0;
      const maxRounds = Math.ceil(max / perRound) + 1;
      while (rounds < maxRounds && total < max) {
        rounds++;
        const lim = Math.min(perRound, max - total);
        const prompt = `Read web-dashboard/${promptFile} and follow it exactly. Evaluate up to ${lim} not-yet-evaluated jobs from batch/jd-cache.json (skip any job that already has a reports/<num>-*.md file). End your output with the "EVALUATED: <n>" line.`;
        const r = await run(bin, ["-p", prompt, "--permission-mode", "acceptEdits"]);
        const m = r.out.match(/EVALUATED:\s*(\d+)/i);
        const n = m ? parseInt(m[1], 10) : 0;
        if (r.code !== 0 && !m) { evalState.error = `evaluator exited (code ${r.code})`; break; }
        total += n;
        evalState.evaluated = total;
        if (n === 0) break; // nothing left to evaluate
      }
      // 3. merge tracker additions into applications.md
      evalState.phase = "merging tracker";
      await run(process.execPath, [join(ROOT, "merge-tracker.mjs")]);
      // 4. prune: keep only jobs >= PRUNE_THRESHOLD (plus anything you applied to);
      //    purged jobs are tombstoned to data/rejected.tsv so the scanner never
      //    re-surfaces them. Keeps the repo from hoarding dead evaluations.
      evalState.phase = "pruning";
      const pr = await run(process.execPath, [join(ROOT, "prune-tracker.mjs"), "--threshold", String(PRUNE_THRESHOLD)]);
      evalState.pruned = ((pr.out || "").match(/reports deleted:\s*(\d+)/) || [])[1] || "0";
      evalState.phase = "done";
    } catch (e) {
      evalState.error = String(e.message || e);
    } finally {
      evalState.running = false;
      evalState.finishedAt = Date.now();
    }
  })();
  return true;
}

// --- HTTP ----------------------------------------------------------------

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(__dirname, "index.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      const jobs = await loadJobs();
      // annotate to-apply jobs with a calibration hint from similar past outcomes
      for (const j of jobs) if (j.status === "evaluated") j.calibration = calibrationFor(j, jobs);
      return send(res, 200, JSON.stringify({ jobs, states: CANONICAL }));
    }

    if (req.method === "GET" && url.pathname === "/api/pipeline") {
      const items = await loadPipeline();
      return send(res, 200, JSON.stringify({ items }));
    }

    // Freelance-lane discovery pipeline (data/freelance-pipeline.md).
    if (req.method === "GET" && url.pathname === "/api/freelance-pipeline") {
      const items = await loadPipeline("freelance");
      return send(res, 200, JSON.stringify({ items }));
    }

    // GET /api/report/:num  → full evaluation markdown for the report drawer
    const rep = url.pathname.match(/^\/api\/report\/(\d+)$/);
    if (req.method === "GET" && rep) {
      const n = rep[1];
      let files = [];
      try { files = await readdir(join(ROOT, "reports")); } catch {}
      const variants = [n, n.padStart(3, "0"), String(parseInt(n, 10))];
      const file = files.find((f) => f.endsWith(".md") && variants.some((v) => f.startsWith(v + "-")));
      if (!file) return send(res, 404, JSON.stringify({ error: "report not found" }));
      const markdown = await readFile(join(ROOT, "reports", file), "utf8");
      return send(res, 200, JSON.stringify({ markdown, file }));
    }

    // GET /api/cover-letter/:num?company=&role=&v=  → tailored cover letter text
    const clm = url.pathname.match(/^\/api\/cover-letter\/(\d+)$/);
    if (req.method === "GET" && clm) {
      const n = clm[1];
      const cv = await loadCvFacts();
      if (!cv) return send(res, 500, JSON.stringify({ error: "cv.md not found" }));
      let markdown = "";
      try {
        let files = await readdir(join(ROOT, "reports"));
        const variants = [n, n.padStart(3, "0"), String(parseInt(n, 10))];
        const file = files.find((f) => f.endsWith(".md") && variants.some((v) => f.startsWith(v + "-")));
        if (file) markdown = await readFile(join(ROOT, "reports", file), "utf8");
      } catch {}
      const qc = url.searchParams.get("company") || "";
      const qr = url.searchParams.get("role") || "";
      const rep = parseReportForLetter(markdown, qc, qr);
      const seed = parseInt(url.searchParams.get("v") || "", 10);
      const text = composeCoverLetter(cv, rep, Number.isFinite(seed) ? seed : n.length + (rep.company.length || 0));
      return send(res, 200, JSON.stringify({ text, company: rep.company, role: rep.role }));
    }

    // GET /api/interview/:num?company=&role=&persona=  → persona-tailored Q&A
    const ivm = url.pathname.match(/^\/api\/interview\/(\d+)$/);
    if (req.method === "GET" && ivm) {
      const cv = await loadCvFacts();
      if (!cv) return send(res, 500, JSON.stringify({ error: "cv.md not found" }));
      const markdown = await reportMarkdown(ivm[1]);
      const rep = parseReportForLetter(markdown, url.searchParams.get("company") || "", url.searchParams.get("role") || "");
      const prof = await loadProfile();
      const data = composeInterview(cv, rep, (url.searchParams.get("persona") || "hr").toLowerCase(), prof);
      return send(res, 200, JSON.stringify(data));
    }

    // GET /api/proscons/:num?company=&role=  → rational pros/cons + bottom line
    const pcm = url.pathname.match(/^\/api\/proscons\/(\d+)$/);
    if (req.method === "GET" && pcm) {
      const cv = await loadCvFacts();
      if (!cv) return send(res, 500, JSON.stringify({ error: "cv.md not found" }));
      const markdown = await reportMarkdown(pcm[1]);
      const rep = parseReportFull(markdown, url.searchParams.get("company") || "", url.searchParams.get("role") || "");
      return send(res, 200, JSON.stringify(composeProsCons(cv, rep)));
    }

    // GET /api/reference/:num?company=&role=  → LinkedIn referral-target deep links
    const rfm = url.pathname.match(/^\/api\/reference\/(\d+)$/);
    if (req.method === "GET" && rfm) {
      const markdown = await reportMarkdown(rfm[1]);
      const rep = parseReportForLetter(markdown, url.searchParams.get("company") || "", url.searchParams.get("role") || "");
      const loc = (markdown.match(/\|\s*\*\*(?:Location|Ubicaci[oó]n)\*\*\s*\|\s*([^|]+?)\s*\|/i) || [])[1] || "";
      rep.location = loc.split(/[,/–-]/)[0].trim();
      const [cv, slugMap] = await Promise.all([loadCvFacts(), loadLiSlugs()]);
      return send(res, 200, JSON.stringify(composeReferences(cv || {}, rep, slugMap)));
    }

    // POST /api/reference/company  body { company, input }
    //   teach the system a company's LinkedIn slug/id (parsed from a pasted URL)
    if (req.method === "POST" && url.pathname === "/api/reference/company") {
      const body = await readBody(req);
      const company = String(body.company || "").trim();
      const { slug, id } = parseLiCompanyInput(body.input);
      if (!company || (!slug && !id))
        return send(res, 400, JSON.stringify({ error: "company and a LinkedIn company/people URL required" }));
      const map = await loadLiSlugs();
      const prev = map[company];
      const cur = (prev && typeof prev === "object") ? { ...prev } : (typeof prev === "string" ? { slug: prev } : {});
      if (slug) cur.slug = slug;
      if (id) cur.id = id;
      map[company] = cur;
      await saveLiSlugs(map);
      return send(res, 200, JSON.stringify({ ok: true, company, saved: cur }));
    }

    // POST /api/jobs/:report  body { status, reason?, note? }
    // Writes status to applications.md; if a rejection/discard reason is given,
    // logs it to data/outcomes.json for the learning loop (feature #3).
    const m = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
    if (req.method === "POST" && m) {
      const { status, reason, note } = await readBody(req);
      await updateStatus(m[1], status);
      if (reason || note) {
        await saveOutcome(m[1], {
          rejectionReason: reason || undefined,
          note: note || undefined,
          status: (status || "").toLowerCase(),
          at: new Date().toISOString().slice(0, 10),
        });
      }
      return send(res, 200, JSON.stringify({ ok: true, reportNumber: m[1], status }));
    }

    // GET /api/filters   → every elimination rule + how many jobs each one removes
    // POST /api/filters/:id body { enabled }  → toggle a rule on/off
    if (req.method === "GET" && url.pathname === "/api/filters") {
      const jobs = await loadJobs();
      const counts = {};
      const samples = {};
      for (const j of jobs) {
        for (const e of j.excludedBy || []) {
          counts[e.id] = (counts[e.id] || 0) + 1;
          (samples[e.id] = samples[e.id] || []).length < 3 &&
            samples[e.id].push({ company: j.company, role: j.role, matched: e.matched });
        }
      }
      const rules = FILTERS.filters.map((f) => ({
        id: f.id, label: f.label, why: f.why, enabled: f.enabled !== false,
        source: f.source || null,
        lanes: Array.isArray(f.lanes) ? f.lanes : ["fulltime", "freelance"],
        patterns: [...(f.title_patterns || []), ...(f.company_patterns || []), ...(f.text_patterns || [])],
        count: counts[f.id] || 0,
        samples: samples[f.id] || [],
      }));
      return send(res, 200, JSON.stringify({
        rules,
        scoringRules: FILTERS.scoring_rules || [],
        keepRule: FILTERS.keep_rule || {},
        keepThreshold: FILTERS.keep_threshold ?? PRUNE_THRESHOLD,
        totalJobs: jobs.length,
        totalExcluded: jobs.filter((j) => (j.excludedBy || []).length).length,
      }));
    }
    const fm = url.pathname.match(/^\/api\/filters\/([\w-]+)$/);
    if (req.method === "POST" && fm) {
      const body = await readBody(req);
      const doc = JSON.parse(await readFile(FILTERS_PATH, "utf8"));
      const rule = (doc.filters || []).find((f) => f.id === fm[1]);
      if (!rule) return send(res, 404, JSON.stringify({ error: "no such filter" }));
      rule.enabled = !!body.enabled;
      await writeFile(FILTERS_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");
      compileFilters();
      return send(res, 200, JSON.stringify({ ok: true, id: rule.id, enabled: rule.enabled }));
    }

    // GET /api/insights  → funnel + per-segment conversion + rejection-reason loop
    if (req.method === "GET" && url.pathname === "/api/insights") {
      const jobs = await loadJobs();
      return send(res, 200, JSON.stringify(computeInsights(jobs)));
    }

    // GET /api/hygiene  → stale / expired / duplicate counts + archivable ids
    if (req.method === "GET" && url.pathname === "/api/hygiene") {
      const jobs = await loadJobs();
      return send(res, 200, JSON.stringify(computeHygiene(jobs)));
    }

    // POST /api/hygiene/archive  body { which: "stale"|"dupes"|"all", ids?: [] }
    //   bulk-archives stale/duplicate rows (feature #5). Non-destructive: only
    //   flips Status to Archived; nothing is deleted.
    if (req.method === "POST" && url.pathname === "/api/hygiene/archive") {
      const body = await readBody(req);
      const jobs = await loadJobs();
      const h = computeHygiene(jobs);
      let targets;
      if (Array.isArray(body.ids) && body.ids.length) targets = body.ids.map(String);
      else if (body.which === "stale") targets = h.stale.map((j) => j.n);
      else if (body.which === "dupes") targets = h.duplicates.map((j) => j.n);
      else targets = h.archivableIds;
      let archived = 0;
      for (const n of targets) { try { await updateStatus(n, "Archived"); archived++; } catch {} }
      return send(res, 200, JSON.stringify({ ok: true, archived }));
    }

    // GET /api/company-risk  → the curated risk map (for review/editing)
    // POST /api/company-risk body { company, level, reason, source? } → add/update
    if (url.pathname === "/api/company-risk") {
      if (req.method === "GET") {
        return send(res, 200, JSON.stringify(RISK));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const company = String(body.company || "").trim();
        const level = String(body.level || "").toLowerCase();
        if (!company || !["high", "medium", "low"].includes(level))
          return send(res, 400, JSON.stringify({ error: "company and level (high|medium|low) required" }));
        let doc = { companies: {}, keywords_high: [], keywords_medium: [] };
        try { doc = JSON.parse(await readFile(COMPANY_RISK_PATH, "utf8")); } catch {}
        doc.companies = doc.companies || {};
        doc.companies[company] = { level, reason: String(body.reason || "").trim(), source: String(body.source || "manual").trim(), date: new Date().toISOString().slice(0, 7) };
        await writeFile(COMPANY_RISK_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");
        loadRiskConfig();
        return send(res, 200, JSON.stringify({ ok: true, company, saved: doc.companies[company] }));
      }
    }

    if (url.pathname === "/api/locations") {
      if (req.method === "GET") {
        return send(res, 200, JSON.stringify(await loadLocations()));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const saved = await saveLocations(body);
        return send(res, 200, JSON.stringify({ ok: true, ...saved }));
      }
    }

    // /api/scan?lane=fulltime|freelance  — GET status, POST to trigger.
    if (url.pathname === "/api/scan") {
      const lane = url.searchParams.get("lane") === "freelance" ? "freelance" : "fulltime";
      const st = scanStates[lane];
      if (req.method === "GET") return send(res, 200, JSON.stringify(st));
      if (req.method === "POST") {
        const started = startScan(lane);
        return send(res, 200, JSON.stringify({ started, lane, ...st }));
      }
    }

    // /api/evaluate?lane=… (or body.lane). One evaluator runs at a time (shared
    // jd-cache.json), so the lane just picks the pipeline + prompt.
    if (url.pathname === "/api/evaluate") {
      if (req.method === "GET") return send(res, 200, JSON.stringify(evalState));
      if (req.method === "POST") {
        const body = await readBody(req);
        const lane = (body.lane || url.searchParams.get("lane")) === "freelance" ? "freelance" : "fulltime";
        const max = Math.max(1, Math.min(parseInt(body.max, 10) || 60, 200));
        const started = startEvaluate({ max, lane });
        return send(res, 200, JSON.stringify({ started, lane, ...evalState }));
      }
    }

    if (url.pathname === "/api/sources") {
      if (req.method === "GET") {
        const [companies, custom] = await Promise.all([loadPortalCompanies(), loadCustomSources()]);
        return send(res, 200, JSON.stringify({ engines: SEARCH_ENGINES, companies, custom }));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const srcUrl = String(body.url || "").trim();
        const name = String(body.name || "").trim();
        if (!srcUrl && !name) return send(res, 400, JSON.stringify({ error: "name or url required" }));
        const custom = await loadCustomSources();
        const id = "src-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        custom.push({
          id, name: name || srcUrl, url: srcUrl,
          kind: detectSourceKind(srcUrl), enabled: true,
          added: new Date().toISOString().slice(0, 10),
        });
        await saveCustomSources(custom);
        return send(res, 200, JSON.stringify({ ok: true, custom }));
      }
    }

    // POST /api/sources/:id  body { action: "delete" | "toggle" }
    const sm = url.pathname.match(/^\/api\/sources\/([\w-]+)$/);
    if (req.method === "POST" && sm) {
      const body = await readBody(req);
      const custom = await loadCustomSources();
      const i = custom.findIndex((s) => s.id === sm[1]);
      if (i < 0) return send(res, 404, JSON.stringify({ error: "not found" }));
      if (body.action === "delete") custom.splice(i, 1);
      else if (body.action === "toggle") custom[i].enabled = custom[i].enabled === false;
      await saveCustomSources(custom);
      return send(res, 200, JSON.stringify({ ok: true, custom }));
    }

    return send(res, 404, JSON.stringify({ error: "Not found" }));
  } catch (err) {
    return send(res, 500, JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  career-ops dashboard → http://localhost:${PORT}`);
  console.log(`  tracker: ${TRACKER_CANDIDATES[0]}`);
  console.log(`  (Ctrl+C to stop)\n`);
});
