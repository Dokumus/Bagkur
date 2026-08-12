#!/usr/bin/env node
/**
 * prune-tracker.mjs — Keep only jobs worth acting on; purge the rest.
 *
 * Policy (the user's rule): after every scan+evaluation, keep jobs scoring
 * >= THRESHOLD (default 3.6) and purge everything below it, so the repo does
 * not hoard dead data.
 *
 * The catch this solves: the scanner dedups against data/applications.md
 * (company+role) and scan-history.tsv (URL). If we simply deleted low-score
 * rows, the scanner would happily re-discover and re-evaluate those exact jobs
 * on the next run — burning tokens forever. So instead of deleting the memory
 * of a job, we shrink it to a tombstone:
 *
 *   HEAVY (deleted): the tracker row + its reports/NNN-*.md evaluation file
 *   LIGHT (kept)   : one line in data/rejected.tsv  →  url, company, role, score
 *
 * scan-jobs.mjs loads rejected.tsv into its dedup sets, so a purged job is
 * never surfaced again — by URL *or* by company+role.
 *
 * NEVER purged (regardless of score): anything you actually engaged with —
 * Applied / Responded / Interview / Offer. Losing those would destroy your
 * application history and the dashboard's conversion/learning loop.
 *
 * Usage:
 *   node prune-tracker.mjs --dry-run        # show what would go
 *   node prune-tracker.mjs                  # do it (backs up applications.md)
 *   node prune-tracker.mjs --threshold 3.8  # different bar
 */

import { readFile, writeFile, unlink, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPS = existsSync(join(ROOT, "data/applications.md"))
  ? join(ROOT, "data/applications.md")
  : join(ROOT, "applications.md");
const REJECTED = join(ROOT, "data", "rejected.tsv");

const DRY = process.argv.includes("--dry-run");
const tIdx = process.argv.indexOf("--threshold");
const THRESHOLD = tIdx > -1 ? parseFloat(process.argv[tIdx + 1]) : 3.4;

// Statuses that mean "you engaged with this" — never purge these.
const ENGAGED = /aplicad|applied|respondido|responded|entrevista|interview|oferta|offer/i;

const cells = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

async function main() {
  const md = await readFile(APPS, "utf8");
  const lines = md.split("\n");

  const keptLines = [];
  const purged = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|") || t.startsWith("|---") || /^\|\s*#/.test(t)) { keptLines.push(line); continue; }
    const c = cells(t);
    if (c.length < 8 || !/^\d+$/.test(c[0])) { keptLines.push(line); continue; }

    const [num, , company, role, scoreRaw, status, , reportCell] = c;
    const score = parseFloat((scoreRaw.match(/([\d.]+)/) || [])[1] || "0");

    if (ENGAGED.test(status)) { keptLines.push(line); continue; }   // engaged → always keep
    if (score >= THRESHOLD) { keptLines.push(line); continue; }     // worth acting on → keep

    const reportPath = (reportCell.match(/\((reports\/[^)]+\.md)\)/) || [])[1] || "";
    purged.push({ num, company, role, score, reportPath });
  }

  // pull each purged job's URL out of its report (for URL-level dedup)
  for (const p of purged) {
    if (!p.reportPath) continue;
    try {
      const rep = await readFile(join(ROOT, p.reportPath), "utf8");
      p.url = ((rep.match(/^\*\*URL:\*\*\s*(\S+)/m) || [])[1] || "").split("?")[0];
    } catch { /* report already gone */ }
  }

  const kept = keptLines.filter((l) => /^\|\s*\d+\s*\|/.test(l.trim())).length;
  console.log(`threshold: ${THRESHOLD}`);
  console.log(`keep:   ${kept} rows (score >= ${THRESHOLD}, or engaged: Applied/Interview/Offer)`);
  console.log(`purge:  ${purged.length} rows + their report files → tombstoned in data/rejected.tsv`);

  if (DRY) {
    console.log("\n--dry-run: nothing written. Sample of what would go:");
    for (const p of purged.slice(0, 12)) console.log(`  ${p.score} ${p.company} — ${p.role}`);
    if (purged.length > 12) console.log(`  … and ${purged.length - 12} more`);
    return;
  }

  // 1. backup the tracker — but ONLY when we're actually about to remove rows.
  //    A no-op prune must never clobber a good backup with the already-pruned
  //    state (that bug destroyed the pre-prune tracker once; rejected.tsv was
  //    the only thing that saved it).
  if (purged.length) await copyFile(APPS, APPS + ".bak");

  // 2. append tombstones (url \t company \t role \t score \t date)
  let tomb = "";
  try { tomb = await readFile(REJECTED, "utf8"); } catch {
    tomb = "# Purged jobs — kept ONLY so the scanner never re-surfaces them.\n# url\tcompany\trole\tscore\tdate\n";
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const p of purged) tomb += `${p.url || "-"}\t${p.company}\t${p.role}\t${p.score}\t${today}\n`;
  await writeFile(REJECTED, tomb, "utf8");

  // 3. delete the heavy report files
  let deleted = 0;
  for (const p of purged) {
    if (!p.reportPath) continue;
    try { await unlink(join(ROOT, p.reportPath)); deleted++; } catch {}
  }

  // 4. rewrite the tracker without the purged rows
  await writeFile(APPS, keptLines.join("\n"), "utf8");

  // 5. sweep orphan reports — evaluation files no surviving tracker row points at.
  //    (Report links and row numbers drift apart over time, so purging by row
  //    alone leaves dead .md files behind.)
  const survivors = keptLines.join("\n");
  const referenced = new Set([...survivors.matchAll(/\((reports\/[^)]+\.md)\)/g)].map((m) => m[1].replace("reports/", "")));
  let orphans = 0;
  try {
    const files = (await readdir(join(ROOT, "reports"))).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      if (referenced.has(f)) continue;
      try { await unlink(join(ROOT, "reports", f)); orphans++; } catch {}
    }
  } catch {}

  console.log(`\ndone. reports deleted: ${deleted} | orphan reports swept: ${orphans} | tombstones: ${purged.length} → data/rejected.tsv`);
  console.log(`backup: ${APPS}.bak`);
}

main().catch((e) => { console.error(e); process.exit(1); });
