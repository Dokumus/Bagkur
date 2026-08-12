#!/usr/bin/env node
/**
 * resolve-tr-careers.mjs — Türkiye takip listesi için kariyer sayfası çözümleyici.
 *
 * config/tr-companies.seed.json içindeki her firma için:
 *   1) ATS panoları (Greenhouse/Lever/Ashby/Workable/Teamtailor) JSON API ile denenir.
 *      Varlık kontrolü DAİMA API üzerinden yapılır: Ashby/Workable var olmayan slug için
 *      de HTML 200 döndüğünden HTML'e bakmak sahte eşleşme üretiyor.
 *   2) Firma alan adı Playwright ile açılır, ana sayfadaki kariyer bağlantıları taranır,
 *      sonra bilinen kariyer yolu kalıpları denenir. Sayfa gerçekten kariyer içeriği
 *      gösteriyorsa (render sonrası metin) kabul edilir.
 *
 * Uydurma URL portals.yml'ye girmesin diye tek doğrulama noktası burasıdır.
 * Çıktı: config/tr-companies.resolved.json
 *
 * Kullanım:
 *   node --use-system-ca resolve-tr-careers.mjs
 *   node --use-system-ca resolve-tr-careers.mjs --limit 10
 *   node --use-system-ca resolve-tr-careers.mjs --only "Logo"
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SEED = join(ROOT, "config", "tr-companies.seed.json");
const OUT = join(ROOT, "config", "tr-companies.resolved.json");

const argv = process.argv.slice(2);
const LIMIT = (() => { const i = argv.indexOf("--limit"); return i >= 0 ? parseInt(argv[i + 1], 10) : Infinity; })();
const ONLY = (() => { const i = argv.indexOf("--only"); return i >= 0 ? argv[i + 1].toLowerCase() : null; })();
// --retry: yalnızca daha önce çözülemeyen firmalar, genişletilmiş kalıplarla yeniden denenir
const RETRY = argv.includes("--retry");
// --new: tohum dosyasına sonradan eklenen, hiç denenmemiş firmaları çözümler
const NEW_ONLY = argv.includes("--new");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FETCH_TIMEOUT = 12000;
const NAV_TIMEOUT = 25000;
const CONCURRENCY = 4;

// Sayfanın gerçekten kariyer sayfası olduğunu gösteren metinler.
// "başvur" gibi genel kelimeler bilerek dışarıda: form/haber sayfalarını yakalıyordu.
const CAREER_TEXT = [
  /kariyer/i, /açık pozisyon/i, /acik pozisyon/i, /iş ilan/i, /is ilan/i, /insan kaynak/i,
  /career/i, /job openings/i, /open position/i, /we.re hiring/i, /vacanc/i, /current openings/i,
  /aramıza katıl/i, /ekibimize katıl/i, /join (our|the) team/i, /iş başvuru/i, /başvuru formu/i,
];
const NOT_FOUND_TEXT = [
  /sayfa bulunamad/i, /page not found/i, /404 not found/i, /aradığınız sayfa/i,
  /bu sayfa (bulunamad|kaldır)/i, /error 404/i, /sayfaya ulaşılamıyor/i,
];
// Nihai URL yolunda aranan izler ("basvur"/"ilan" gibi genel parçalar bilerek yok).
const CAREER_PATH_RE = /(kariyer|career|jobs?|vacanc|insan-kaynak|insankaynak|is-ilanlari|hiring|acik-pozisyon|werkenbij|join-us)/i;
// Ürün/içerik sayfalarını ele: örn. Logo Yazılım'ın "insan kaynakları yönetimi"
// ÜRÜN kategorisi kariyer sayfası değildir.
const NON_CAREER_PATH_RE = /(kategori|category|\/urun|\/product|cozum|solution|\/blog|haber|\/news|etkinlik|\/event|akademi|\/egitim|webinar|yonetimi|referans|destek|support|basin-bulten|basin-odasi|press-release|duyuru|medya|sponsor)/i;

const DOMAIN_PATHS = [
  "/kariyer", "/tr/kariyer", "/careers", "/career", "/insan-kaynaklari",
  "/tr/insan-kaynaklari", "/en/careers", "/jobs", "/tr/careers",
  "/kariyer/acik-pozisyonlar", "/kariyer-firsatlari",
];

// İkinci tur (--retry) için ek yol ve alt alan adı kalıpları
const EXTRA_PATHS = [
  "/tr-tr/kariyer", "/kurumsal/kariyer", "/hakkimizda/kariyer", "/tr/hakkimizda/kariyer",
  "/ik", "/insankaynaklari", "/tr/insan-kaynaklari/kariyer", "/company/careers",
  "/about/careers", "/en/career", "/en/kariyer", "/kariyer/", "/careers/jobs",
  "/acik-pozisyonlar", "/is-ilanlari", "/join-us", "/work-with-us",
];
const CAREER_SUBDOMAINS = ["kariyer", "career", "careers", "jobs", "ik", "is"];

const ATS_PATTERNS = [
  (s) => ({ probe: `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, url: `https://job-boards.greenhouse.io/${s}`, api: `https://boards-api.greenhouse.io/v1/boards/${s}/jobs` }),
  (s) => ({ probe: `https://api.lever.co/v0/postings/${s}?mode=json`, url: `https://jobs.lever.co/${s}`, api: `https://api.lever.co/v0/postings/${s}?mode=json` }),
  (s) => ({ probe: `https://api.ashbyhq.com/posting-api/job-board/${s}`, url: `https://jobs.ashbyhq.com/${s}`, api: `https://api.ashbyhq.com/posting-api/job-board/${s}` }),
  (s) => ({ probe: `https://apply.workable.com/api/v1/widget/accounts/${s}`, url: `https://apply.workable.com/${s}/`, api: `https://apply.workable.com/api/v1/widget/accounts/${s}` }),
];

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[ıİ]/g, "i").replace(/[şŞ]/g, "s").replace(/[ğĞ]/g, "g")
    .replace(/[üÜ]/g, "u").replace(/[öÖ]/g, "o").replace(/[çÇ]/g, "c")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "");

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": UA, accept: "application/json,*/*" } });
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: "", err: e.name === "AbortError" ? "timeout" : e.message || "hata" };
  } finally {
    clearTimeout(t);
  }
}

async function probeAts(cand) {
  let r = await getJson(cand.probe);
  if (r.status === 429) { // hız sınırı — kısa bekleyip bir kez daha dene
    await new Promise((res) => setTimeout(res, 2500));
    r = await getJson(cand.probe);
  }
  if (r.status !== 200) return { ok: false, reason: r.err || `http ${r.status}` };
  let j;
  try { j = JSON.parse(r.body); } catch { return { ok: false, reason: "api yanıtı JSON değil" }; }
  const jobs = Array.isArray(j) ? j : j.jobs;
  if (!Array.isArray(jobs)) return { ok: false, reason: "api yanıtında iş listesi yok" };
  // Slug çakışması riski: pano gerçek ama başka şirkete ait olabilir → TR sinyalini işaretle.
  const blob = JSON.stringify(jobs).slice(0, 200_000);
  const trSignal = jobs.length === 0 ? null
    : /türkiye|turkey|turkiye|istanbul|ankara|izmir|antalya|kocaeli|gebze|samsun|eskisehir|eskişehir|bursa|remote/i.test(blob);
  const acct = typeof j?.name === "string" ? ` [hesap: ${j.name}]` : "";
  const trNote = jobs.length === 0 ? " ilan yok" : trSignal ? " TR/remote sinyali var" : " TR sinyali YOK — doğrula";
  return { ok: true, trSignal, reason: `ATS API doğrulandı (${jobs.length} ilan)${acct}${trNote}` };
}

// --- Playwright tarafı --------------------------------------------------

const CLOSED_RE = /(Target page, context or browser has been closed|Target closed|browser has been closed|Protocol error)/i;

// Oturum: chromium uzun koşularda çökebiliyor — çökerse kendini yeniden kurar.
// (İlk --retry turu bu yüzden geçersizdi: tarayıcı kapandıktan sonra tüm
// gezinmeler "browser has been closed" ile hata verip firmaları yanlışlıkla
// "çözülemedi" olarak işaretlemişti.)
async function newSession() {
  const sess = {
    browser: null, ctx: null, page: null,
    async reset() {
      try { await this.browser?.close(); } catch { /* yoksay */ }
      this.browser = await chromium.launch({ headless: true });
      this.ctx = await this.browser.newContext({ userAgent: UA, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
      await this.ctx.route("**/*", (route) => {
        const t = route.request().resourceType();
        return ["image", "font", "media", "stylesheet"].includes(t) ? route.abort() : route.continue();
      });
      this.page = await this.ctx.newPage();
    },
    async close() { try { await this.browser?.close(); } catch { /* yoksay */ } },
  };
  await sess.reset();
  return sess;
}

async function open(sess, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await sess.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await sess.page.waitForTimeout(1200);
      return { status: res ? res.status() : 0, final: sess.page.url() };
    } catch (e) {
      const msg = (e.message || "hata").split("\n")[0].slice(0, 120);
      if (attempt === 0 && CLOSED_RE.test(msg)) { await sess.reset(); continue; } // tarayıcı çöktü → yeniden kur
      return { status: 0, final: url, err: msg };
    }
  }
  return { status: 0, final: url, err: "açılamadı" };
}

async function pageText(sess) {
  try { return (await sess.page.locator("body").innerText({ timeout: 5000 })).slice(0, 60_000); }
  catch { return ""; }
}

// Sayfa gerçekten kariyer sayfası mı? (render sonrası metin + nihai yol)
async function verifyCareerPage(sess, url, allowAnyPath = false) {
  const nav = await open(sess, url);
  if (nav.status === 0) return { ok: false, reason: nav.err || "açılamadı" };
  // 404/410 kesin yok. Diğer 4xx/5xx'ler bot korumasından gelebiliyor (ör. THY'nin
  // kariyer sitesi 478 döndürüyor ama sayfa normal render ediliyor) — bu durumda
  // karar içeriğe bırakılır, statü nota yazılır.
  if (nav.status === 404 || nav.status === 410) return { ok: false, reason: `http ${nav.status}` };
  const wafNote = nav.status >= 400 ? ` [http ${nav.status} — bot koruması, içerikle doğrulandı]` : "";
  const text = await pageText(sess);
  if (!text) return { ok: false, reason: "boş sayfa" };
  if (NOT_FOUND_TEXT.some((re) => re.test(text))) return { ok: false, reason: "404 metni" };
  let path = "/";
  try { path = new URL(nav.final).pathname; } catch { /* yoksay */ }
  const hit = CAREER_TEXT.find((re) => re.test(text));
  if (!hit) return { ok: false, reason: "kariyer içeriği yok" };
  let host = "";
  try { host = new URL(nav.final).hostname; } catch { /* yoksay */ }
  const pathOk = CAREER_PATH_RE.test(path) || (allowAnyPath && CAREER_PATH_RE.test(host));
  if (!pathOk) return { ok: false, reason: `kariyer dışı adrese yönlendi (${path})` };
  if (NON_CAREER_PATH_RE.test(path)) return { ok: false, reason: `ürün/içerik sayfası (${path})` };
  return { ok: true, final: nav.final, reason: `render doğrulandı (${hit})${wafNote}` };
}

async function discoverCareerLinks(sess, host) {
  const nav = await open(sess, host);
  if (nav.status === 0 || nav.status >= 400) return { links: [], err: nav.err || `http ${nav.status}` };
  let links = [];
  try {
    links = await sess.page.$$eval("a[href]", (as) =>
      as.slice(0, 800).map((a) => ({ href: a.href, text: (a.textContent || "").trim().slice(0, 80) })));
  } catch { /* yoksay */ }
  const scored = [];
  for (const l of links) {
    if (!/^https?:/i.test(l.href)) continue;
    if (/linkedin|facebook|twitter|x\.com|instagram|youtube|mailto|\.pdf$/i.test(l.href)) continue;
    if (NON_CAREER_PATH_RE.test(l.href)) continue;
    let score = 0;
    if (CAREER_PATH_RE.test(l.href)) score += 2;
    if (CAREER_TEXT.some((re) => re.test(l.text))) score += 2;
    if (/kariyer|career/i.test(l.href)) score += 1;
    if (score === 0) continue;
    scored.push({ ...l, score });
  }
  scored.sort((a, b) => b.score - a.score || a.href.length - b.href.length);
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    const key = s.href.replace(/[#?].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= 5) break;
  }
  return { links: out, err: null };
}

// sitemap.xml içinden kariyer URL'si adayları — CMS siteleri için etkili.
async function sitemapCandidates(host) {
  const out = [];
  const roots = [`${host}/sitemap.xml`, `${host}/sitemap_index.xml`, `${host}/sitemap-index.xml`];
  for (const root of roots) {
    const r = await getJson(root);
    if (r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    // Alt sitemap listesiyse kariyer geçen alt sitemap'i de aç
    if (/<sitemapindex/i.test(r.body)) {
      for (const sub of locs.filter((l) => CAREER_PATH_RE.test(l)).slice(0, 3)) {
        const rs = await getJson(sub);
        if (rs.status === 200) locs.push(...[...rs.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]));
      }
    }
    for (const l of locs) {
      if (!CAREER_PATH_RE.test(l) || NON_CAREER_PATH_RE.test(l)) continue;
      if (!out.includes(l)) out.push(l);
      if (out.length >= 5) break;
    }
    if (out.length) break;
  }
  return out;
}

async function resolveOne(sess, c) {
  const tried = [];
  const slug = slugify(c.name);

  if (slug.length >= 3) {
    for (const p of ATS_PATTERNS) {
      const cand = p(slug);
      const r = await probeAts(cand);
      tried.push({ url: cand.probe, ok: r.ok, reason: r.reason });
      if (r.ok) return { ...c, careers_url: cand.url, api: cand.api, tr_signal: r.trSignal, evidence: r.reason, tried };
    }
  }

  // İkinci turda kariyer alt alan adlarını da dene (kariyer.firma.com gibi)
  if (RETRY) {
    for (const d of c.domains || []) {
      if (d.startsWith("http")) continue;
      for (const sub of CAREER_SUBDOMAINS) {
        const url = `https://${sub}.${d}`;
        const r = await verifyCareerPage(sess, url, true);
        tried.push({ url, ok: r.ok, reason: `alt alan adı: ${r.reason}` });
        if (r.ok) return { ...c, careers_url: r.final || url, api: null, tr_signal: null, evidence: r.reason, tried };
      }
    }
  }

  for (const d of c.domains || []) {
    const bases = d.startsWith("http") ? [d] : [`https://www.${d}`, `https://${d}`, `http://${d}`];
    for (const host of bases) {
      const { links, err } = await discoverCareerLinks(sess, host);
      if (err) { tried.push({ url: host, ok: false, reason: `anasayfa: ${err}` }); continue; }

      if (RETRY) {
        for (const sm of await sitemapCandidates(host)) {
          const r = await verifyCareerPage(sess, sm);
          tried.push({ url: sm, ok: r.ok, reason: `sitemap: ${r.reason}` });
          if (r.ok) return { ...c, careers_url: r.final || sm, api: null, tr_signal: null, evidence: r.reason, tried };
        }
      }

      for (const link of links) {
        const r = await verifyCareerPage(sess, link);
        tried.push({ url: link, ok: r.ok, reason: `anasayfa bağlantısı: ${r.reason}` });
        if (r.ok) return { ...c, careers_url: r.final || link, api: null, tr_signal: null, evidence: r.reason, tried };
      }

      for (const path of (RETRY ? [...DOMAIN_PATHS, ...EXTRA_PATHS] : DOMAIN_PATHS)) {
        const url = host + path;
        const r = await verifyCareerPage(sess, url);
        tried.push({ url, ok: r.ok, reason: r.reason });
        if (r.ok) return { ...c, careers_url: r.final || url, api: null, tr_signal: null, evidence: r.reason, tried };
      }
      break; // ana sayfa açıldı ama kariyer sayfası bulunamadı — www varyantını tekrar deneme
    }
  }

  return { ...c, careers_url: null, api: null, tr_signal: null, evidence: "doğrulanan kariyer URL'si yok", tried };
}

async function main() {
  const seed = JSON.parse(await readFile(SEED, "utf8"));
  let list = seed.companies;
  let previous = null;
  if (RETRY || NEW_ONLY) {
    previous = JSON.parse(await readFile(OUT, "utf8"));
    if (NEW_ONLY) {
      // Tohum dosyasına sonradan eklenen firmalar: daha önce hiç denenmemiş olanlar.
      const known = new Set(previous.companies.map((c) => c.name));
      list = list.filter((c) => !known.has(c.name));
      console.log(`--new: ${list.length} yeni firma çözümleniyor (mevcut ${previous.companies.length} kayıt korunuyor)`);
    } else {
      const unresolved = new Set(previous.companies.filter((c) => !c.careers_url).map((c) => c.name));
      list = list.filter((c) => unresolved.has(c.name));
      console.log(`--retry: ${list.length} çözülemeyen firma yeniden deneniyor`);
    }
  }
  if (ONLY) list = list.filter((c) => c.name.toLowerCase().includes(ONLY));
  list = list.slice(0, LIMIT);

  const results = new Array(list.length);
  let idx = 0, done = 0;

  async function worker() {
    const sess = await newSession();
    while (idx < list.length) {
      const i = idx++;
      try { results[i] = await resolveOne(sess, list[i]); }
      catch (e) {
        if (CLOSED_RE.test(e.message || "")) { try { await sess.reset(); } catch { /* yoksay */ } }
        results[i] = { ...list[i], careers_url: null, api: null, evidence: `hata: ${e.message}`, tried: [] };
      }
      done++;
      const r = results[i];
      console.log(`[${done}/${list.length}] ${r.careers_url ? "OK  " : "YOK "} ${r.name}${r.careers_url ? " → " + r.careers_url : ""}`);
    }
    await sess.close();
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // --retry / --new sadece alt kümeyi işler: önceki sonuçların üzerine yazma, birleştir.
  let all = results;
  if (previous && NEW_ONLY) {
    // yeni firmalar mevcut listeye EKLENİR (üzerine yazma yok)
    all = [...previous.companies, ...results];
    console.log(`\nBu turda çözülen (yeni firma): ${results.filter((r) => r.careers_url).length}/${results.length}`);
  } else if (previous) {
    const fresh = new Map(results.filter((r) => r.careers_url).map((r) => [r.name, r]));
    all = previous.companies.map((c) => fresh.get(c.name) || c);
    console.log(`\nBu turda yeni çözülen: ${fresh.size}/${results.length}`);
  }
  const resolved = all.filter((r) => r.careers_url).length;
  await writeFile(OUT, JSON.stringify({ generated_for: "portals.yml tracked_companies", total: all.length, resolved, companies: all }, null, 2) + "\n", "utf8");
  console.log(`${resolved}/${all.length} firma için kariyer URL'si doğrulandı → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
