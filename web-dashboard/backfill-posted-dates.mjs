#!/usr/bin/env node
// Fetch the REAL posting date (datePosted) for every job URL we know about and
// cache it to data/posted-dates.json ({ "<url>": "YYYY-MM-DD" }). The dashboard
// reads this cache to sort by actual posting date instead of the evaluation date.
//
// Sources handled: LinkedIn JSON-LD (datePosted), Greenhouse (updated_at/first
// published), Lever (createdAt), Ashby (publishedDate), plus a generic JSON-LD
// datePosted fallback. Unknown/blocked URLs are skipped.
//
// Run with system CA on this machine:
//   NODE_OPTIONS=--use-system-ca node web-dashboard/backfill-posted-dates.mjs
// Re-runnable: only fetches URLs not already in the cache.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CACHE_PATH = join(ROOT, "data", "posted-dates.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };

async function getText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
    return r.ok ? await r.text() : "";
  } catch { return ""; }
}

async function fetchPosted(url) {
  // Greenhouse board API
  let m = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (url.includes("greenhouse.io") && m) {
    const t = await getText(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`);
    try { const j = JSON.parse(t); return iso(j.first_published || j.updated_at); } catch {}
  }
  // Lever
  m = url.match(/lever\.co\/([^/]+)\/([0-9a-f-]+)/);
  if (url.includes("lever.co") && m) {
    const t = await getText(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}?mode=json`);
    try { const j = JSON.parse(t); return iso(j.createdAt); } catch {}
  }
  // Generic + LinkedIn: pull datePosted from JSON-LD JobPosting
  const html = await getText(url);
  if (html) {
    for (const mm of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try { const j = JSON.parse(mm[1]); const d = j.datePosted || j.datePublished; if (d) return iso(d); } catch {}
    }
    const dm = html.match(/"datePosted"\s*:\s*"([^"]+)"/);
    if (dm) return iso(dm[1]);
  }
  return null;
}

// Collect job URLs from reports (**URL:** line) and the pipeline inbox.
async function collectUrls() {
  const urls = new Set();
  try {
    const files = await readdir(join(ROOT, "reports"));
    for (const f of files.filter((f) => f.endsWith(".md"))) {
      const txt = await readFile(join(ROOT, "reports", f), "utf8");
      const u = txt.match(/^\*\*URL:\*\*\s*(\S+)/m);
      if (u && /^https?:/.test(u[1])) urls.add(u[1].split("?")[0]);
    }
  } catch {}
  try {
    const pipe = await readFile(join(ROOT, "data", "pipeline.md"), "utf8");
    for (const mm of pipe.matchAll(/^-\s*\[ \]\s*(https?:\/\/\S+)/gm)) urls.add(mm[1].split("?")[0]);
  } catch {}
  return [...urls];
}

async function main() {
  let cache = {};
  try { cache = JSON.parse(await readFile(CACHE_PATH, "utf8")); } catch {}
  const urls = await collectUrls();
  const todo = urls.filter((u) => !(u in cache));
  console.log(`Known URLs: ${urls.length} | cached: ${urls.length - todo.length} | fetching: ${todo.length}`);
  let ok = 0, miss = 0;
  for (let i = 0; i < todo.length; i++) {
    const d = await fetchPosted(todo[i]);
    cache[todo[i]] = d || ""; // cache empty string so we don't re-fetch dead URLs every run
    d ? ok++ : miss++;
    if ((i + 1) % 25 === 0) { console.log(`  …${i + 1}/${todo.length} (ok:${ok} miss:${miss})`); await writeFile(CACHE_PATH, JSON.stringify(cache, null, 0), "utf8"); }
    await sleep(220);
  }
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 0), "utf8");
  console.log(`Done. Got posting dates for ${ok}, missed ${miss}. Cache → data/posted-dates.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
