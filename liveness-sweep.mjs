#!/usr/bin/env node
/**
 * liveness-sweep.mjs — "To Apply" listesindeki ilanların hâlâ açık olup olmadığını denetler.
 *
 * İki aşamalı: (1) ucuz HTTP taraması tüm URL'leri gezer — JSON-LD validThrough,
 * HTTP 404/410 ve kapanma kalıplarına bakar; (2) şüpheli çıkanlar Playwright ile
 * teyit edilir (proje kuralı: kapalı/açık kararını Playwright verir).
 *
 * Kapalı doğrulananlar applications.md'de Descartada'ya çekilir ve nota sebep yazılır.
 * Her koşu data/liveness.json'a işlenir; 48 saatten yeni "active" sonuçlar atlanır.
 *
 * Kullanım:
 *   node --use-system-ca liveness-sweep.mjs            # tam süpürme, sonucu uygular
 *   node --use-system-ca liveness-sweep.mjs --dry-run  # sadece raporlar, dosya değiştirmez
 *   node --use-system-ca liveness-sweep.mjs --limit 40 # ilk N kaydı dener
 *   node --use-system-ca liveness-sweep.mjs --all      # önbelleği yok say, hepsini yeniden kontrol et
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const TODAY = new Date().toISOString().slice(0, 10);
const NOW = Date.now();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const ALL = argv.includes("--all");
const LIMIT = (() => { const i = argv.indexOf("--limit"); return i >= 0 ? parseInt(argv[i + 1], 10) : Infinity; })();
// "active" sonucu bu süre boyunca taze sayılır (saat)
const FRESH_HOURS = 40;

const EXPIRED_TEXT = [
  /job (is )?no longer available/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /position has been filled/i,
  /this job (listing )?is closed/i,
  /job (posting )?has expired/i,
  /bu ilan (yayından kaldırılmış|sona ermiş|kapanmış)/i,
  /ilan (süresi )?dolmuş/i,
  /başvuru süresi (sona ermiş|dolmuş)/i,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- aşama 1: HTTP ----------
async function httpProbe(url) {
  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" }, redirect: "follow" });
  } catch (e) {
    return { verdict: "suspect", reason: `ağ hatası: ${e.message}` };
  }
  if (r.status === 404 || r.status === 410) return { verdict: "expired", reason: `HTTP ${r.status}` };
  if (r.status === 429 || r.status === 403) return { verdict: "suspect", reason: `HTTP ${r.status} (engellendi)` };
  if (!r.ok) return { verdict: "suspect", reason: `HTTP ${r.status}` };

  const html = await r.text();

  // LinkedIn ve çoğu ATS JSON-LD JobPosting yayınlar: validThrough geçmişse kapalı.
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const block of ld) {
    try {
      const j = JSON.parse(block.replace(/<script type="application\/ld\+json">/, "").replace(/<\/script>/, ""));
      const node = Array.isArray(j) ? j.find((x) => x["@type"] === "JobPosting") : j;
      if (node && node["@type"] === "JobPosting" && node.validThrough) {
        const vt = String(node.validThrough).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(vt) && vt < TODAY) {
          return { verdict: "expired", reason: `validThrough ${vt} geçmiş` };
        }
      }
    } catch {}
  }

  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  for (const p of EXPIRED_TEXT) if (p.test(text)) return { verdict: "expired", reason: `kalıp: ${p.source}` };

  // LinkedIn kapalı ilanları çoğunlukla "no longer accepting" bloğu döndürür;
  // gövde çok kısaysa da şüpheli say.
  if (text.replace(/\s+/g, " ").trim().length < 400) return { verdict: "suspect", reason: "içerik çok kısa" };

  return { verdict: "active", reason: "içerik dolu, kapanma işareti yok" };
}

// ---------- aşama 2: Playwright teyidi ----------
const APPLY_PATTERNS = [/\bapply\b/i, /başvur/i, /\bsolicitar\b/i, /\bbewerben\b/i, /easy apply/i, /submit application/i];

async function playwrightConfirm(urls) {
  if (!urls.length) return new Map();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  // İngilizce locale: LinkedIn'in "No longer accepting applications" uyarısı
  // yalnızca sayfa dilinde basılır, Hollandaca sürümde kalıp tutmaz.
  const page = await browser.newPage({
    userAgent: UA, locale: "en-US", extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  const out = new Map();
  for (const url of urls) {
    let verdict = "expired", reason = "";
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const st = resp?.status() ?? 0;
      if (st === 404 || st === 410) { reason = `HTTP ${st}`; }
      // 429/403 = hız sınırı/engel. Sayfa kısa gelir ve varsayılan "expired"
      // kararına düşerdi — açık ilanı yanlışlıkla kapatmamak için belirsiz say.
      else if (st === 429 || st === 403) { verdict = "uncertain"; reason = `HTTP ${st} (hız sınırı/engel)`; }
      else {
        await page.waitForTimeout(1800);
        const body = await page.evaluate(() => document.body?.innerText ?? "");
        const applyDom = await page.evaluate(() =>
          !!document.querySelector(".jobs-apply-button, .top-card-layout__cta, [data-tracking-control-name*=apply]"));
        // Kapanma metni başvuru butonundan ÖNCE bakılır: LinkedIn kapalı ilanlarda
        // butonu bırakıp üstüne uyarı basabiliyor.
        if (EXPIRED_TEXT.some((p) => p.test(body))) { reason = "kapanma metni bulundu"; }
        else if (applyDom || APPLY_PATTERNS.some((p) => p.test(body))) { verdict = "active"; reason = "başvuru butonu var"; }
        else if (body.trim().length < 300) { reason = "sayfa boş/yalnızca menü"; }
        else { verdict = "uncertain"; reason = "içerik var ama başvuru butonu yok"; }
      }
    } catch (e) {
      reason = `gezinme hatası: ${e.message.split("\n")[0]}`;
    }
    out.set(url, { verdict, reason });
    process.stdout.write(verdict === "active" ? "." : verdict === "expired" ? "x" : "?");
    // LinkedIn az istekten sonra 429 döndürüyor; oraya belirgin şekilde yavaş git.
    await sleep(/linkedin\.com/i.test(url) ? 1500 : 400);
  }
  await browser.close();
  process.stdout.write("\n");
  return out;
}

// ---------- tracker okuma ----------
async function loadToApply() {
  const md = await readFile(join(ROOT, "data", "applications.md"), "utf8");
  const files = await readdir(join(ROOT, "reports"));
  const byNum = new Map();
  for (const f of files) { const m = f.match(/^(\d{3})-/); if (m) byNum.set(String(parseInt(m[1], 10)), f); }

  const rows = [];
  for (const line of md.split("\n")) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const c = line.split("|").map((s) => s.trim());
    // | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
    const [, num, date, company, role, score, status] = c;
    if (!/^(Evaluada|Evaluated)$/i.test(status || "")) continue; // yalnızca "To Apply"
    const file = byNum.get(String(parseInt(num, 10)));
    if (!file) continue;
    rows.push({ num, date, company, role, score, status, file });
  }
  // rapor başlığından URL
  const out = [];
  for (const r of rows) {
    const txt = await readFile(join(ROOT, "reports", r.file), "utf8");
    const url = (txt.match(/^\*\*URL:\*\*\s*(\S+)/m) || [])[1];
    if (url && /^https?:/.test(url)) out.push({ ...r, url });
  }
  return out;
}

// ---------- keşfedilen (henüz değerlendirilmemiş) ilanlar ----------
// Dashboard'un "Discovered" sekmesi data/pipeline.md'deki "## Pendientes"
// bölümünü okur. Buradaki ilanlar daha önce hiç canlılık denetiminden
// geçmiyordu — kapanmış ilanlar ekranda kalıyordu.
const PIPELINE_FILES = ["pipeline.md", "freelance-pipeline.md"];
const CLOSED_HEADING = "## Kapandı (liveness)";

async function loadPipelineItems(file) {
  let md;
  try { md = await readFile(join(ROOT, "data", file), "utf8"); } catch { return []; }
  const startM = md.match(/^##\s*Pendientes.*$/m);
  if (!startM) return [];
  const sec = md.slice(startM.index + startM[0].length).split(/\n##\s/)[0];
  const items = [];
  for (const line of sec.split("\n")) {
    const m = line.match(/^-\s*\[ \]\s*(\S+)\s*\|\s*(.+)$/);
    if (!m || !/^https?:/.test(m[1])) continue;
    const parts = m[2].split("|").map((s) => s.trim());
    items.push({ file, url: m[1], company: parts[0] || "?", title: parts[1] || "?", line });
  }
  return items;
}

/** Kapanan satırları Pendientes'ten çıkarır, "Kapandı" bölümüne taşır. */
async function retirePipelineLines(file, deadByUrl) {
  const path = join(ROOT, "data", file);
  let md = await readFile(path, "utf8");
  const moved = [];
  md = md.split("\n").filter((line) => {
    const m = line.match(/^-\s*\[ \]\s*(\S+)\s*\|/);
    if (!m || !deadByUrl.has(m[1])) return true;
    moved.push(`- ${line.replace(/^-\s*\[ \]\s*/, "")} | KAPANDI ${TODAY}: ${deadByUrl.get(m[1])}`);
    return false;
  }).join("\n");
  if (!moved.length) return 0;
  if (md.includes(CLOSED_HEADING)) {
    md = md.replace(CLOSED_HEADING, `${CLOSED_HEADING}\n${moved.join("\n")}`);
  } else {
    md = md.replace(/\s*$/, "\n") + `\n${CLOSED_HEADING}\n<!-- Canlılık denetimi kapalı buldu; dashboard'da gösterilmez. -->\n${moved.join("\n")}\n`;
  }
  await writeFile(path, md, "utf8");
  return moved.length;
}

async function sweepPipeline(cache) {
  let items = [];
  for (const f of PIPELINE_FILES) items.push(...await loadPipelineItems(f));
  const before = items.length;
  if (!ALL) {
    items = items.filter((it) => {
      const c = cache[`url:${it.url}`];
      if (!c || c.verdict !== "active") return true;
      return NOW - Date.parse(c.checkedAt || 0) > FRESH_HOURS * 3600e3;
    });
  }
  items = items.slice(0, LIMIT);
  console.log(`\nKeşfedilenler (pipeline): ${before} kayıt — bu koşuda kontrol: ${items.length}`);
  if (!items.length) return;

  const stage1 = [];
  for (const it of items) {
    const p = await httpProbe(it.url);
    stage1.push({ ...it, ...p });
    process.stdout.write(p.verdict === "active" ? "." : p.verdict === "expired" ? "x" : "?");
    await sleep(/linkedin\.com/i.test(it.url) ? 1200 : 200);
  }
  process.stdout.write("\n");

  const needConfirm = stage1.filter((j) => j.verdict !== "active");
  const confirmed = await playwrightConfirm(needConfirm.map((j) => j.url));
  const results = stage1.map((j) => {
    const c = confirmed.get(j.url);
    return c ? { ...j, verdict: c.verdict, reason: `${j.reason} → PW: ${c.reason}` } : j;
  });

  for (const r of results) cache[`url:${r.url}`] = { url: r.url, verdict: r.verdict, reason: r.reason, checkedAt: new Date().toISOString() };

  const dead = results.filter((r) => r.verdict === "expired");
  console.log(`Pipeline sonucu: ${results.length - dead.length} açık, ${dead.length} KAPALI`);
  for (const d of dead) console.log(`  · ${d.company} — ${d.title} (${d.reason})`);
  if (DRY || !dead.length) { if (DRY && dead.length) console.log("DRY RUN — pipeline değiştirilmedi."); return; }

  for (const f of PIPELINE_FILES) {
    const map = new Map(dead.filter((d) => d.file === f).map((d) => [d.url, d.reason]));
    if (!map.size) continue;
    const n = await retirePipelineLines(f, map);
    console.log(`${f}: ${n} kapanmış ilan "Kapandı" bölümüne taşındı (Discovered'da görünmez).`);
  }
}

async function main() {
  let cache = {};
  try { cache = JSON.parse(await readFile(join(ROOT, "data", "liveness.json"), "utf8")); } catch {}

  let jobs = await loadToApply();
  const before = jobs.length;
  if (!ALL) {
    jobs = jobs.filter((j) => {
      const c = cache[j.num];
      if (!c || c.verdict !== "active") return true;
      return NOW - Date.parse(c.checkedAt || 0) > FRESH_HOURS * 3600e3;
    });
  }
  jobs = jobs.slice(0, LIMIT);
  console.log(`To Apply: ${before} kayıt — bu koşuda kontrol edilecek: ${jobs.length}${DRY ? "  (DRY RUN)" : ""}`);
  if (!jobs.length) {
    console.log("To Apply icin kontrol edilecek yeni kayit yok.");
    await sweepPipeline(cache);
    if (!DRY) await writeFile(join(ROOT, "data", "liveness.json"), JSON.stringify(cache, null, 1), "utf8");
    return;
  }

  // aşama 1
  const stage1 = [];
  for (let i = 0; i < jobs.length; i++) {
    const p = await httpProbe(jobs[i].url);
    stage1.push({ ...jobs[i], ...p });
    process.stdout.write(p.verdict === "active" ? "." : p.verdict === "expired" ? "x" : "?");
    if ((i + 1) % 60 === 0) process.stdout.write(` ${i + 1}\n`);
    await sleep(/linkedin\.com/i.test(jobs[i].url) ? 1200 : 200);
  }
  process.stdout.write("\n");

  // aşama 2: expired + suspect olanları Playwright ile teyit et
  const needConfirm = stage1.filter((j) => j.verdict !== "active");
  console.log(`HTTP: ${stage1.length - needConfirm.length} açık, ${needConfirm.length} şüpheli → Playwright teyidi`);
  const confirmed = await playwrightConfirm(needConfirm.map((j) => j.url));

  const results = stage1.map((j) => {
    const c = confirmed.get(j.url);
    return c ? { ...j, verdict: c.verdict, reason: `${j.reason} → PW: ${c.reason}` } : j;
  });

  const dead = results.filter((r) => r.verdict === "expired");
  const unsure = results.filter((r) => r.verdict === "uncertain");
  const alive = results.filter((r) => r.verdict === "active");

  for (const r of results) cache[r.num] = { url: r.url, verdict: r.verdict, reason: r.reason, checkedAt: new Date().toISOString() };

  console.log(`\nSonuç: ${alive.length} açık  ${dead.length} KAPALI  ${unsure.length} belirsiz`);
  if (dead.length) {
    console.log("\nKapanan ilanlar:");
    for (const d of dead) console.log(`  #${d.num} ${d.company} — ${d.role}  (${d.reason})`);
  }
  if (unsure.length) {
    console.log("\nBelirsiz (elle bakılmalı, durumu değiştirilmedi):");
    for (const d of unsure) console.log(`  #${d.num} ${d.company} — ${d.role}`);
  }

  if (DRY) { console.log("\nDRY RUN — dosya değiştirilmedi."); return; }

  await writeFile(join(ROOT, "data", "liveness.json"), JSON.stringify(cache, null, 1), "utf8");

  if (dead.length) {
    const path = join(ROOT, "data", "applications.md");
    let md = await readFile(path, "utf8");
    const deadNums = new Set(dead.map((d) => String(parseInt(d.num, 10))));
    md = md.split("\n").map((line) => {
      if (!/^\|\s*\d+\s*\|/.test(line)) return line;
      const c = line.split("|");
      const n = String(parseInt(c[1].trim(), 10));
      if (!deadNums.has(n)) return line;
      c[6] = " Descartada ";                                   // status
      c[9] = ` İLAN KAPANDI (liveness ${TODAY}) — ${c[9].trim()} `; // notes
      return c.join("|");
    }).join("\n");
    await writeFile(path, md, "utf8");
    console.log(`\napplications.md güncellendi: ${dead.length} kayıt Descartada yapıldı.`);
  }
}

main().catch((e) => { console.error("Hata:", e); process.exit(1); });
