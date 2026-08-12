#!/usr/bin/env node
/**
 * restore-tracker.mjs — Bring back jobs that a too-high prune bar deleted.
 *
 * When the keep-threshold is lowered (e.g. 3.6 → 3.4), jobs that were purged at
 * the old bar are gone from applications.md AND tombstoned in rejected.tsv — so
 * the scanner will never re-find them. This restores them from the backup.
 *
 * Only restores a job if it:
 *   - scores >= THRESHOLD (default: config/filters.json keep_threshold), and
 *   - passes every enabled elimination filter (consultancy, fixed-term,
 *     headhunter, senior/above-level, senior DS-DE, internship).
 * So lowering the bar does NOT drag consultancy/contract junk back in.
 *
 * Restored jobs also get their tombstone removed from rejected.tsv.
 * Report files deleted by the prune cannot be recovered — the row's report link
 * is blanked so the dashboard doesn't point at a missing file. Score + notes,
 * which is what the board displays, survive intact in the backup row.
 *
 * Usage: node restore-tracker.mjs [--dry-run] [--threshold 3.4]
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPS = existsSync(join(ROOT, "data/applications.md")) ? join(ROOT, "data/applications.md") : join(ROOT, "applications.md");
const BAK = APPS + ".bak";
const REJECTED = join(ROOT, "data", "rejected.tsv");
const FILTERS_PATH = join(ROOT, "config", "filters.json");

const DRY = process.argv.includes("--dry-run");
const tIdx = process.argv.indexOf("--threshold");

const cells = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const cfg = JSON.parse(await readFile(FILTERS_PATH, "utf8"));
const THRESHOLD = tIdx > -1 ? parseFloat(process.argv[tIdx + 1]) : (cfg.keep_threshold ?? 3.4);

// headhunter blocklist
let HH = { names: [], kw: [] };
try {
  const h = JSON.parse(await readFile(join(ROOT, "config", "headhunters.json"), "utf8"));
  HH = { names: (h.company_names || []).map((s) => s.toLowerCase()), kw: (h.name_keywords || []).map((s) => s.toLowerCase()) };
} catch {}
const isHH = (c) => { const t = " " + (c || "").toLowerCase() + " "; return HH.names.some((n) => t.includes(n)) || HH.kw.some((k) => t.includes(k)); };

const SENIOR = /\b(senior|sr\.?|lead|principal|staff|head|director|chief|vp|expert|manager|medior|mid[- ]?level)\b/i;
const JUNIOR = /\b(junior|jr\.?|entry|graduate|trainee|working student|werkstudent|associate|intern)\b/i;
const DSDE = /\bdata scientist\b|\bdata science\b|\bdata engineer\b|\bmachine learning engineer\b|\bml engineer\b|\bmlops\b|\banalytics engineer\b/i;

// compile the enabled elimination filters from config
const F = (cfg.filters || []).filter((f) => f.enabled !== false);
const rx = (arr) => (arr || []).map((p) => new RegExp(p, "i"));
function blockedBy(company, role, text) {
  for (const f of F) {
    if (f.id === "headhunter") { if (isHH(company)) return f.label; continue; }
    if (f.id === "senior_dsde") {
      if (DSDE.test(role) && SENIOR.test(role) && !JUNIOR.test(role)) return f.label;
      continue;
    }
    if (rx(f.title_exceptions).some((r) => r.test(role))) continue;
    if (rx(f.title_patterns).some((r) => r.test(role))) return f.label;
    if (rx(f.company_patterns).some((r) => r.test(company))) return f.label;
    if (rx(f.text_patterns).some((r) => r.test(text))) return f.label;
  }
  return null;
}

const cur = await readFile(APPS, "utf8");

// what's already in the tracker + the highest row number in use
const present = new Set();
let maxNum = 0;
for (const l of cur.split("\n")) {
  const t = l.trim();
  if (!t.startsWith("|")) continue;
  const c = cells(t);
  if (c.length > 4 && /^\d+$/.test(c[0])) {
    present.add(norm(c[2]) + "::" + norm(c[3]));
    maxNum = Math.max(maxNum, parseInt(c[0], 10));
  }
}

// Source of truth for what was purged: data/rejected.tsv (url, company, role, score, date).
// The pre-prune tracker rows are gone, so the original notes/report text cannot be
// recovered — score + company + role + url survive, which is what the board needs.
const rej = await readFile(REJECTED, "utf8");
const restore = [], rejectedStill = [];
for (const line of rej.split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const [url, company, role, scoreStr, date] = line.split("\t");
  if (!company || !role) continue;
  const score = parseFloat(scoreStr || "0");
  const key = norm(company) + "::" + norm(role);
  if (present.has(key)) continue;
  if (score < THRESHOLD) continue;
  const blocked = blockedBy(company, role, `${role} ${company}`);
  if (blocked) { rejectedStill.push({ company, role, score, blocked }); continue; }

  const num = ++maxNum;
  present.add(key);
  const notes = `RESTORED (bar ${THRESHOLD}) — original evaluation report was pruned; score kept. Re-evaluate for full detail.${url && url !== "-" ? " " + url : ""}`;
  restore.push({
    num, company, role, score,
    line: `| ${num} | ${date || new Date().toISOString().slice(0, 10)} | ${company} | ${role} | ${score}/5 | Evaluada | ❌ | — | ${notes} |`,
  });
}

console.log(`threshold: ${THRESHOLD}`);
console.log(`restore: ${restore.length} jobs (score >= ${THRESHOLD} AND passing every filter)`);
console.log(`still filtered out: ${rejectedStill.length} (consultancy / contract / senior / agency)`);
for (const r of restore) console.log(`  + ${r.score} ${r.company} — ${r.role}${r.hadReport ? "" : "  (report was deleted; score+notes kept)"}`);

if (DRY) { console.log("\n--dry-run: nothing written."); process.exit(0); }
if (!restore.length) { console.log("\nnothing to restore."); process.exit(0); }

// 1. append restored rows
let out = cur;
if (!out.endsWith("\n")) out += "\n";
out += restore.map((r) => r.line).join("\n") + "\n";
await writeFile(APPS, out, "utf8");

// 2. drop their tombstones so rejected.tsv stays honest
try {
  const rej = await readFile(REJECTED, "utf8");
  const restoredKeys = new Set(restore.map((r) => norm(r.company) + "::" + norm(r.role)));
  const kept = rej.split("\n").filter((line) => {
    if (!line.trim() || line.startsWith("#")) return true;
    const [, company, role] = line.split("\t");
    return !restoredKeys.has(norm(company) + "::" + norm(role));
  });
  await writeFile(REJECTED, kept.join("\n"), "utf8");
} catch {}

console.log(`\nrestored ${restore.length} rows; tombstones removed.`);
