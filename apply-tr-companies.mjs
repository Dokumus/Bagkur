#!/usr/bin/env node
/**
 * apply-tr-companies.mjs — resolve-tr-careers.mjs çıktısını portals.yml'ye işler.
 *
 * config/tr-companies.resolved.json içindeki firmaları portals.yml'nin
 * "TÜRKİYE — doğrudan takip edilen şirketler" bölümüne ekler:
 *   - careers_url doğrulanmış firmalar → enabled: true
 *   - doğrulanamayanlar → enabled: false + neden notu (il bazlı LinkedIn/kariyer.net
 *     aramasıyla zaten kapsanıyorlar; URL uydurulmaz)
 * portals.yml'de zaten kayıtlı olan firmalara dokunmaz.
 *
 * Kullanım:
 *   node apply-tr-companies.mjs --dry-run   # sadece raporlar
 *   node apply-tr-companies.mjs             # yeni firmaları ekler (.bak alır)
 *   node apply-tr-companies.mjs --update     # ZATEN KAYITLI firmalarda sonradan
 *                                            # doğrulanan URL'yi işler (enabled:true yapar)
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const RESOLVED = join(ROOT, "config", "tr-companies.resolved.json");
const PORTALS = join(ROOT, "portals.yml");
const DRY = process.argv.includes("--dry-run");
// --update: portals.yml'de zaten kayıtlı olup URL'si sonradan doğrulanan firmaların
// bloklarını yeniden yazar (careers_url ekler, enabled:false → true).
const UPDATE = process.argv.includes("--update");

// portals.yml'de zaten başka adla kayıtlı olan firmalar (çift kayıt olmasın)
const ALIASES = { "MKE Samsun": "MKE (Makina ve Kimya Endüstrisi)" };

const MARKER = "# ===== TÜRKİYE — ekran görüntüsündeki firma listesi (7 il + uzaktan) =====";

const norm = (s) => s.toLowerCase()
  .replace(/[ıİ]/g, "i").replace(/[şŞ]/g, "s").replace(/[ğĞ]/g, "g")
  .replace(/[üÜ]/g, "u").replace(/[öÖ]/g, "o").replace(/[çÇ]/g, "c")
  .replace(/[^a-z0-9]/g, "");

const yamlStr = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

function entry(c) {
  const lines = [];
  lines.push(`  - name: ${/[:#]/.test(c.name) ? yamlStr(c.name) : c.name}`);
  if (c.careers_url) {
    lines.push(`    careers_url: ${c.careers_url}`);
    // Yalnızca Greenhouse api'si yazılır: tarayıcı (scan-jobs.mjs atsFor) slug'ı
    // api URL'sinden çıkarıyor ve Ashby/Workable api yolları yanlış slug veriyor
    // (api.ashbyhq.com/posting-api/... → "posting-api"). careers_url doğru slug'ı taşıyor.
    if (c.api && /boards-api\.greenhouse\.io/.test(c.api)) lines.push(`    api: ${c.api}`);
  }
  const loc = [c.city, c.district].filter(Boolean).join(" / ");
  const notes = [`${loc}. ${c.category}.`];
  if (c.note_extra) notes.push(c.note_extra);
  if (!c.careers_url) notes.push("Kariyer URL'si doğrulanamadı — il bazlı LinkedIn/kariyer.net aramasıyla kapsanıyor.");
  else if (c.tr_signal === false) notes.push("ATS panosunda TR ilanı görülmedi — pano başka bir şirkete ait olabilir, ilk taramada teyit et.");
  lines.push(`    notes: ${yamlStr(notes.join(" "))}`);
  lines.push(`    enabled: ${c.careers_url ? "true" : "false"}`);
  return lines.join("\n");
}

// Bir firmanın YAML bloğunu bulan desen (blok = "- name:" satırı + girintili satırlar)
function blockRe(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n  - name: ["']?${esc}["']?\\n(?:    .*\\n)*`);
}

async function runUpdate() {
  const data = JSON.parse(await readFile(RESOLVED, "utf8"));
  let yaml = await readFile(PORTALS, "utf8");
  const done = [];
  for (const c of data.companies) {
    if (!c.careers_url) continue;
    // yalnızca YAML'de URL'siz/pasif duran kayıtlar güncellenir
    const re = blockRe(c.name);
    const m = yaml.match(re);
    if (!m || /careers_url:/.test(m[0])) continue;
    yaml = yaml.replace(re, "\n" + entry(c) + "\n");
    done.push(c.name);
  }
  if (!done.length) { console.log("Güncellenecek kayıt yok."); return; }
  console.log(`Güncellenen (${done.length}): ${done.join(", ")}`);
  if (DRY) return;
  await copyFile(PORTALS, PORTALS + ".bak");
  await writeFile(PORTALS, yaml, "utf8");
  console.log("portals.yml güncellendi (yedek: portals.yml.bak)");
}

async function main() {
  if (UPDATE) return runUpdate();
  const data = JSON.parse(await readFile(RESOLVED, "utf8"));
  let yaml = await readFile(PORTALS, "utf8");

  const trackedSection = yaml.split(/\ntracked_companies:/)[1] || "";
  const existing = new Set(
    [...trackedSection.matchAll(/\n\s*-\s+name:\s*(.+)/g)].map((m) => norm(m[1].trim().replace(/^["']|["']$/g, ""))),
  );

  const added = [], skipped = [];
  const byCity = new Map();
  for (const c of data.companies) {
    const aliasOf = ALIASES[c.name];
    if (existing.has(norm(c.name)) || (aliasOf && existing.has(norm(aliasOf)))) {
      skipped.push(aliasOf ? `${c.name} (zaten: ${aliasOf})` : c.name);
      continue;
    }
    if (!byCity.has(c.city)) byCity.set(c.city, []);
    byCity.get(c.city).push(c);
    added.push(c);
  }

  if (!added.length) { console.log("Eklenecek yeni firma yok."); return; }

  const blocks = [
    "",
    MARKER,
    "# Kaynak: config/tr-companies.seed.json — kariyer URL'leri resolve-tr-careers.mjs ile",
    "# (ATS JSON API + Playwright render doğrulaması) teyit edildi. URL'si doğrulanamayanlar",
    "# enabled:false bırakıldı; bunlar zaten il bazlı LinkedIn/kariyer.net sorgularıyla taranıyor.",
  ];
  for (const [city, list] of byCity) {
    blocks.push("", `  # --- ${city} ---`);
    for (const c of list) blocks.push("", entry(c));
  }
  const block = blocks.join("\n") + "\n";

  const okCount = added.filter((c) => c.careers_url).length;
  console.log(`Eklenecek: ${added.length} firma (${okCount} doğrulanmış URL, ${added.length - okCount} enabled:false)`);
  if (skipped.length) console.log(`Zaten kayıtlı, atlandı: ${skipped.join(", ")}`);

  if (DRY) { console.log("\n--- portals.yml'ye eklenecek blok ---\n" + block); return; }

  await copyFile(PORTALS, PORTALS + ".bak");
  yaml = yaml.replace(/\s*$/, "\n") + block;
  await writeFile(PORTALS, yaml, "utf8");
  console.log(`portals.yml güncellendi (yedek: portals.yml.bak)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
