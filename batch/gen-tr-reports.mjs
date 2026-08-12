#!/usr/bin/env node
// Türkiye lane'i toplu değerlendirme çıktısı üreteci.
// batch/tr-scores-*.json içindeki puanları jd-cache.json ile eşleştirir,
// reports/*.md ve batch/tracker-additions/*.tsv dosyalarını yazar.
// Detay eşiği config/profile.yml → evaluation.detail_threshold (3.3).

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATE = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE || "")) {
  console.error("Kullanım: node batch/gen-tr-reports.mjs YYYY-MM-DD");
  process.exit(1);
}
const THRESHOLD = 3.3;

const slug = (s) => (s || "")
  .toLowerCase()
  .replace(/[ğ]/g, "g").replace(/[ü]/g, "u").replace(/[ş]/g, "s")
  .replace(/[ı]/g, "i").replace(/[ö]/g, "o").replace(/[ç]/g, "c")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const cache = JSON.parse(await readFile(join(ROOT, "batch", "jd-cache.json"), "utf8"));
const byReport = new Map(cache.map((j) => [j.report, j]));

// puan dosyaları
const scoreFiles = (await readdir(join(ROOT, "batch"))).filter((f) => /^tr-scores-\d+\.json$/.test(f)).sort();
let scores = [];
for (const f of scoreFiles) scores.push(...JSON.parse(await readFile(join(ROOT, "batch", f), "utf8")));

// isteğe bağlı: APPLY katmanı için elle yazılmış detay blokları
let details = {};
try { details = JSON.parse(await readFile(join(ROOT, "batch", "tr-details.json"), "utf8")); } catch {}

await mkdir(join(ROOT, "batch", "tracker-additions"), { recursive: true });
const existing = await readdir(join(ROOT, "reports"));
const already = new Set(existing.map((f) => (f.match(/^(\d{3})-/) || [])[1]).filter(Boolean));

let full = 0, condensed = 0, stub = 0, skipped = 0;
const summary = [];

for (const s of scores) {
  const j = byReport.get(s.report);
  if (!j) { console.error("cache'te yok:", s.report); continue; }
  if (already.has(s.report)) { skipped++; continue; }
  const cslug = slug(j.company);
  const file = `${s.report}-${cslug}-${DATE}.md`;
  const head = `# Evaluation: ${j.company} -- ${j.title}\n\n**Date:** ${DATE}\n**Archetype:** ${s.archetype}\n**Score:** ${s.score.toFixed(1)}/5\n**URL:** ${j.url}\n**PDF:** Pending\n\n---\n\n`;

  let body;
  const d = details[s.report];
  if (d) {
    // tam detaylı rapor
    body = `## Role Summary\n\n| Dimension | Detail |\n|-----------|--------|\n`
      + `| **Domain** | ${d.domain} |\n| **Seniority** | ${d.seniority} |\n| **Remote** | ${d.remote} |\n\n`
      + `${d.summary}\n\n## Requirements Mapping\n\n| JD Requirement | CV Match | Strength |\n|---------------|----------|----------|\n`
      + d.mapping.map((r) => `| ${r[0]} | ${r[1]} | **${r[2]}** |`).join("\n")
      + `\n\n## Gaps\n\n| Gap | Severity | Mitigation |\n|-----|----------|------------|\n`
      + d.gaps.map((g) => `| ${g[0]} | ${g[1]} | ${g[2]} |`).join("\n")
      + `\n\n**Verdict:** ${d.verdict}\n`;
    full++;
  } else if (s.score >= THRESHOLD) {
    // yoğunlaştırılmış rapor (eşik üstü, tam eşleme tablosu yok)
    body = `## Role Summary\n\n| Dimension | Detail |\n|-----------|--------|\n`
      + `| **Domain** | ${j.company} — ${j.title} |\n| **Seniority** | ${/senior|kıdemli|lead/i.test(j.title) ? "Senior/Lead" : /junior|jr\.|new grad/i.test(j.title) ? "Junior" : "Mid"} |\n| **Remote** | ${j.location} |\n\n`
      + `**Verdict:** ${s.verdict} — ${s.reason}. _(Eşik üstü; toplu Türkiye taramasında yoğunlaştırılmış formatta değerlendirildi, tam Requirements Mapping tablosu çıkarılmadı.)_\n`;
    condensed++;
  } else {
    body = `**Verdict:** ${s.verdict === "SKIP" ? "Do NOT apply" : s.verdict} — ${s.reason}. _(${THRESHOLD} detay eşiğinin altında; hızlı puanlandı, detaylı eşleme yapılmadı.)_\n`;
    stub++;
  }

  await writeFile(join(ROOT, "reports", file), head + body, "utf8");

  const note = `${s.verdict}: ${s.reason}`.replace(/\t/g, " ").replace(/\n/g, " ");
  const tsv = [s.report, DATE, j.company, j.title, "Evaluated", `${s.score.toFixed(1)}/5`, "❌", `[${s.report}](reports/${file})`, note].join("\t");
  await writeFile(join(ROOT, "batch", "tracker-additions", `${s.report}-${cslug}.tsv`), tsv + "\n", "utf8");
  summary.push({ report: s.report, company: j.company, title: j.title, score: s.score, verdict: s.verdict, url: j.url, location: j.location });
}

summary.sort((a, b) => b.score - a.score);
await writeFile(join(ROOT, "batch", "tr-summary.json"), JSON.stringify(summary, null, 1), "utf8");
console.log(`Rapor yazıldı — tam detay: ${full}, yoğunlaştırılmış: ${condensed}, stub: ${stub}, atlanan (zaten var): ${skipped}`);
console.log(`Toplam: ${summary.length}`);
