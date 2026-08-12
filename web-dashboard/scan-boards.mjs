// İş panosu adaptörleri — config/job-boards.json'daki kaynakları çeker.
//
// scan-jobs.mjs bu modülü çağırır; her adaptör ortak şekli döndürür:
//   { title, company, url, location, source }
// Konum/başlık filtresi ve dedup çağıran tarafta (scan-jobs.mjs) yapılır —
// burada yalnızca "bu ilan Türkiye'den çalışılabilir mi" ön elemesi var
// (uzaktan panolarda ABD-only ilanları taşımamak için).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, opts = {}) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { ok: false, status: r.status, text: "" };
    return { ok: true, status: r.status, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, text: "", err: e.message };
  }
}
async function getJSON(url, opts) {
  const r = await getText(url, opts);
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

const decode = (s) => (s || "")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'")
  .replace(/&nbsp;/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

// Uzaktan panolar: Türkiye'den çalışılabilir mi? Belirsizse ELEME (gürültü yüksek).
const TR_ELIGIBLE = /(worldwide|anywhere|global|emea|europe|european|eu\b|türkiye|turkey|turkiye|cet|gmt|remote - eu)/i;
const NOT_ELIGIBLE = /(usa only|us only|united states only|us-based|canada only|latam only|apac only|india only|philippines only|australia only|uk only|us residents)/i;
function remoteEligible(text) {
  const t = text || "";
  if (NOT_ELIGIBLE.test(t)) return false;
  return TR_ELIGIBLE.test(t);
}

// --- TR il kapsamı ---------------------------------------------------------
// TR panoları ülke geneli ilan döndürüyor, oysa kapsam config/locations.json'daki
// illerle sınırlı (varsayılan: 7 il). Tanınan ama kapsam dışı bir il görürsek eleriz;
// ili okunamayan ilanı elemeyiz (belirsizi atmak, kaçırmaktan kötü).
const TR_PROVINCES = [
  "adana","adiyaman","afyon","afyonkarahisar","agri","aksaray","amasya","ankara","antalya","ardahan","artvin","aydin",
  "balikesir","bartin","batman","bayburt","bilecik","bingol","bitlis","bolu","burdur","bursa","canakkale","cankiri",
  "corum","denizli","diyarbakir","duzce","edirne","elazig","erzincan","erzurum","eskisehir","gaziantep","giresun",
  "gumushane","hakkari","hatay","igdir","isparta","istanbul","izmir","kahramanmaras","karabuk","karaman","kars",
  "kastamonu","kayseri","kilis","kirikkale","kirklareli","kirsehir","kocaeli","konya","kutahya","malatya","manisa",
  "mardin","mersin","mugla","mus","nevsehir","nigde","ordu","osmaniye","rize","sakarya","samsun","sanliurfa","siirt",
  "sinop","sivas","sirnak","tekirdag","tokat","trabzon","tunceli","usak","van","yalova","yozgat","zonguldak",
];
const foldTr = (s) => (s || "")
  .replace(/[İIı]/g, "i").replace(/[Şş]/g, "s").replace(/[Ğğ]/g, "g")
  .replace(/[Üü]/g, "u").replace(/[Öö]/g, "o").replace(/[Çç]/g, "c")
  .toLowerCase();

let _trScope = null;
async function trScope() {
  if (_trScope) return _trScope;
  const keys = new Set();
  try {
    const loc = JSON.parse(await readFile(join(ROOT, "config", "locations.json"), "utf8"));
    for (const r of loc.regions || []) {
      if (r.enabled === false) continue;
      if (!/turkey|türkiye/i.test(`${r.country} ${r.label} ${r.id}`)) continue;
      // Sadece ŞEHİR anahtarları: `keywords` ülke adını ("Türkiye") içerdiği için
      // buraya katılırsa her TR ilanı kapsam içi görünür ve il süzgeci işlevsizleşir.
      for (const c of [...(r.cities || []), ...(r.li_locations || [])]) {
        const k = foldTr(String(c)).split(",")[0].trim();
        if (!k || k.length <= 2 || /^(turkiye|turkey|tr)$/.test(k)) continue;
        keys.add(k);
      }
    }
  } catch { /* okunamazsa süzme yapma */ }
  _trScope = keys;
  return keys;
}

/** Kapsam dışı TR ili ise false. İl okunamıyorsa true (belirsizi koru). */
async function inTrScope(locationText) {
  const scope = await trScope();
  if (!scope.size) return true;
  const t = foldTr(locationText);
  if (!t) return true;
  if ([...scope].some((k) => t.includes(k))) return true;
  // Kapsamda değil: metinde tanınan başka bir il geçiyorsa ele, geçmiyorsa koru.
  return !TR_PROVINCES.some((p) => new RegExp(`(^|[^a-z])${p}([^a-z]|$)`).test(t));
}

async function filterTrScope(rows) {
  const out = [];
  for (const r of rows) if (await inTrScope(r.location)) out.push(r);
  return out;
}

// --- TR: kariyer.net -------------------------------------------------------
// Arama sayfası sunucu tarafında render ediliyor. Kartlar `data-test="ad-card"`
// bloklarında; pozisyon/şehir kart özniteliklerinde, şirket adı logo alt'ında.
function parseKariyerNet(html) {
  const out = [];
  for (const block of html.split('data-test="ad-card"').slice(1)) {
    const href = (block.match(/href="(\/is-ilani\/[^"]+)"/) || [])[1];
    const title = decode((block.match(/positionName="([^"]*)"/) || [])[1]);
    const city = decode((block.match(/cityName="([^"]*)"/) || [])[1]);
    const company = decode((block.match(/alt="([^"]*)"/) || [])[1]);
    if (!href || !title) continue;
    out.push({
      title,
      company: company || "?",
      url: "https://www.kariyer.net" + href,
      location: city ? `${city}, Türkiye` : "Türkiye",
      source: "kariyer.net",
    });
  }
  return out;
}
async function fromKariyerNet(board) {
  const out = [];
  for (const q of board.queries || []) {
    const r = await getText("https://www.kariyer.net/is-ilanlari/" + encodeURIComponent(q));
    if (!r.ok) continue;
    out.push(...parseKariyerNet(r.text));
    await sleep(500);
  }
  return filterTrScope(out);
}

// --- TR: techcareer.net ----------------------------------------------------
// Next.js — ilanlar __NEXT_DATA__ içinde initialJobList.jobListItems olarak geliyor.
async function fromTechcareer() {
  const r = await getText("https://www.techcareer.net/jobs");
  if (!r.ok) return [];
  const m = r.text.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let items = [];
  try { items = JSON.parse(m[1])?.props?.pageProps?.initialJobList?.jobListItems || []; } catch { return []; }
  const rows = items
    .filter((j) => j.slug)
    .map((j) => ({
      title: decode(j.jobTitle || j.title),
      company: decode(j.owner?.name) || (j.isCompanyHidden ? "Gizli firma" : "?"),
      url: `https://www.techcareer.net/jobs/${j.slug}`,
      location: decode(j.location) || "Türkiye",
      source: "techcareer.net",
    }));
  return filterTrScope(rows);
}

// --- EU: Arbeitnow ---------------------------------------------------------
async function fromArbeitnow() {
  const j = await getJSON("https://www.arbeitnow.com/api/job-board-api");
  if (!j?.data) return [];
  return j.data.map((x) => ({
    title: decode(x.title),
    company: decode(x.company_name),
    url: x.url,
    location: decode(x.location) || (x.remote ? "Remote" : ""),
    source: "arbeitnow",
  }));
}

// --- Remote: Remotive ------------------------------------------------------
async function fromRemotive(board) {
  const out = [];
  for (const q of board.queries || ["data analyst"]) {
    const j = await getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=50`);
    for (const x of j?.jobs || []) {
      const loc = x.candidate_required_location || "";
      if (!remoteEligible(loc)) continue;
      out.push({ title: decode(x.title), company: decode(x.company_name), url: x.url, location: `Remote (${loc})`, source: "remotive" });
    }
    await sleep(400);
  }
  return out;
}

// --- Remote: Jobicy --------------------------------------------------------
async function fromJobicy() {
  const out = [];
  for (const geo of ["europe", "emea", "anywhere"]) {
    const j = await getJSON(`https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}&industry=data-science`);
    for (const x of j?.jobs || []) {
      out.push({
        title: decode(x.jobTitle),
        company: decode(x.companyName),
        url: x.url,
        location: `Remote (${decode(x.jobGeo) || geo})`,
        source: "jobicy",
      });
    }
    await sleep(400);
  }
  return out;
}

// --- Remote: Himalayas -----------------------------------------------------
async function fromHimalayas() {
  const j = await getJSON("https://himalayas.app/jobs/api?limit=100");
  const out = [];
  for (const x of j?.jobs || []) {
    const loc = [].concat(x.locationRestrictions || []).join(", ");
    // locationRestrictions boş = kısıt yok (dünya geneli) → uygun say
    if (loc && !remoteEligible(loc)) continue;
    out.push({
      title: decode(x.title),
      company: decode(x.companyName),
      url: x.applicationLink || x.guid,
      location: `Remote (${loc || "worldwide"})`,
      source: "himalayas",
    });
  }
  return out;
}

// --- Remote: RemoteOK (varsayılan kapalı) ----------------------------------
async function fromRemoteOk() {
  const j = await getJSON("https://remoteok.com/api");
  if (!Array.isArray(j)) return [];
  return j.slice(1).map((x) => ({
    title: decode(x.position || x.title),
    company: decode(x.company),
    url: x.url || x.apply_url,
    location: `Remote (${decode(x.location) || "worldwide"})`,
    source: "remoteok",
  })).filter((x) => x.url && x.title && remoteEligible(x.location));
}

const ADAPTERS = {
  kariyernet: fromKariyerNet,
  techcareer: fromTechcareer,
  arbeitnow: fromArbeitnow,
  remotive: fromRemotive,
  jobicy: fromJobicy,
  himalayas: fromHimalayas,
  remoteok: fromRemoteOk,
};

export async function loadBoards() {
  try {
    const j = JSON.parse(await readFile(join(ROOT, "config", "job-boards.json"), "utf8"));
    return (j.boards || []).filter((b) => b.enabled !== false && b.adapter && ADAPTERS[b.adapter]);
  } catch {
    return [];
  }
}

/** Etkin panoları çeker. Dönüş: { rows, stats: [{id, count, error}] } */
export async function fetchBoards(boards) {
  const rows = [];
  const stats = [];
  for (const b of boards) {
    try {
      const got = await ADAPTERS[b.adapter](b);
      rows.push(...got);
      stats.push({ id: b.id, count: got.length, error: got.length ? null : "0 ilan döndü (kaynak kırılmış olabilir)" });
    } catch (e) {
      stats.push({ id: b.id, count: 0, error: e.message });
    }
  }
  return { rows, stats };
}

export { ADAPTERS };
