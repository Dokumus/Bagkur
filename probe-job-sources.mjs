#!/usr/bin/env node
/**
 * probe-job-sources.mjs — iş panosu kaynaklarının sağlık kontrolü.
 *
 * config/job-boards.json'daki etkin her kaynağı çeker ve şunu sorar:
 * hâlâ ilan döndürüyor mu, alanlar (başlık/şirket/URL/konum) dolu mu?
 * HTML parse eden kaynaklar (kariyer.net, techcareer.net) site değişince sessizce
 * boş dönmeye başlar; bu betik onu görünür kılar.
 *
 * Kullanım:
 *   node --use-system-ca probe-job-sources.mjs
 *   node --use-system-ca probe-job-sources.mjs --json   # makine okunur çıktı
 *
 * Çıkış kodu: tüm etkin kaynaklar sağlıklıysa 0, biri bile bozuksa 1.
 */

import { loadBoards, ADAPTERS } from "./web-dashboard/scan-boards.mjs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const JSON_OUT = process.argv.includes("--json");

function quality(rows) {
  if (!rows.length) return { score: 0, issues: ["0 ilan döndü"] };
  const issues = [];
  const miss = (f) => rows.filter((r) => !r[f]).length;
  if (miss("title")) issues.push(`${miss("title")} kayıtta başlık yok`);
  if (miss("url")) issues.push(`${miss("url")} kayıtta URL yok`);
  if (miss("company") > rows.length / 2) issues.push("kayıtların yarısından fazlasında şirket yok");
  if (miss("location") > rows.length / 2) issues.push("kayıtların yarısından fazlasında konum yok");
  const badUrl = rows.filter((r) => r.url && !/^https?:\/\//.test(r.url)).length;
  if (badUrl) issues.push(`${badUrl} kayıtta geçersiz URL`);
  return { score: rows.length, issues };
}

async function main() {
  const boards = await loadBoards();
  const all = JSON.parse(await readFile(join(ROOT, "config", "job-boards.json"), "utf8")).boards || [];
  const results = [];

  for (const b of boards) {
    const t0 = process.hrtime.bigint();
    let rows = [], err = null;
    try { rows = await ADAPTERS[b.adapter](b); }
    catch (e) { err = e.message; }
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    const q = quality(rows);
    results.push({
      id: b.id, name: b.name, reliability: b.reliability, scope: b.scope,
      count: rows.length, ms, error: err, issues: q.issues,
      healthy: !err && rows.length > 0 && q.issues.length === 0,
      sample: rows[0] ? { title: rows[0].title, company: rows[0].company, location: rows[0].location } : null,
    });
  }

  const skipped = all.filter((b) => b.enabled === false || !b.adapter)
    .map((b) => ({ id: b.id, name: b.name, reliability: b.reliability, reason: b.adapter ? "enabled:false" : "adaptör yok (manuel kaynak)" }));

  if (JSON_OUT) {
    console.log(JSON.stringify({ checked: results, skipped }, null, 2));
  } else {
    console.log(`=== İş panosu sağlık kontrolü (${results.length} etkin kaynak) ===\n`);
    for (const r of results) {
      const mark = r.healthy ? "OK " : "BOZUK";
      console.log(`${mark} ${r.name.padEnd(16)} ${String(r.count).padStart(4)} ilan  ${String(r.ms).padStart(5)}ms  [${r.reliability}/${r.scope}]`);
      if (r.error) console.log(`      hata: ${r.error}`);
      for (const i of r.issues) console.log(`      sorun: ${i}`);
      if (r.sample) console.log(`      örnek: ${r.sample.title} — ${r.sample.company} — ${r.sample.location}`);
    }
    if (skipped.length) {
      console.log(`\nKapsam dışı (${skipped.length}):`);
      for (const s of skipped) console.log(`  · ${s.name} — ${s.reason}`);
    }
  }

  process.exit(results.every((r) => r.healthy) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
