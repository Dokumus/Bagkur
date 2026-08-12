import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendJobEvaluationAlert } from './telegram-notify.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const TODAY = new Date().toISOString().slice(0, 10);

function getEnvKey(keyName) {
  if (process.env[keyName]) return process.env[keyName];
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${keyName}=`)) {
        return trimmed.split('=').slice(1).join('=').trim();
      }
    }
  }
  return '';
}

const slug = (s) => (s || "")
  .toLowerCase()
  .replace(/[ğ]/g, "g").replace(/[ü]/g, "u").replace(/[ş]/g, "s")
  .replace(/[ı]/g, "i").replace(/[ö]/g, "o").replace(/[ç]/g, "c")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Strict Filter: Title Exclusions, Agency Exclusions, Confidential Exclusions, NO REMOTE Policy
 */
function isValidTargetJob(company, title, location) {
  const c = (company || "").trim().toLowerCase();
  const t = (title || "").trim().toLowerCase();
  const l = (location || "").trim().toLowerCase();

  // 1. CONFIDENTIAL / SECRET EMPLOYER EXCLUSION (GİZLİ İlanlar)
  if (!c || c === '?' || c === 'gizli' || c.includes('gizli firma') || c.includes('confidential') || c.includes('sektorunde oncu firma') || c.includes('firma bilgisi gizli')) {
    return { ok: false, reason: "GİZLİ / İsimsiz Şirket" };
  }

  // 2. RECRUITMENT / STAFFING AGENCY EXCLUSION (Aracı Firma İlanları)
  const agencyList = [
    'pentanom', 'adecco', 'michael page', 'gini talent', 'experis', 'harnham', 
    'brunel', 'manpower', 'randstad', 'talentown', 'es kariyer', 'es kariyer danis manlik',
    'danismanlik', 'danismani', 'human resources', 'recruitment'
  ];
  if (agencyList.some(a => c.includes(a))) {
    return { ok: false, reason: "Aracı / İşe Alım Ajansı İlanı" };
  }

  // 3. NEGATIVE TITLE EXCLUSIONS (Data Engineer, Software Engineer, Growth, Consultant / Danışman)
  const excludedTitleKeywords = [
    'data engineer', 'veri muhendisi', 'veri muhendisligi',
    'software engineer', 'yazilim muhendisi', 'yazilim muhendisligi',
    'growth', 'buyume',
    'consultant', 'danisman', 'danismani', 'danismanlik'
  ];
  if (excludedTitleKeywords.some(k => t.includes(k))) {
    return { ok: false, reason: `Kapsam Dışı Unvan (${title})` };
  }

  // 4. STRICT NO REMOTE POLICY (Remote İlanlar Gösterilmeyecek)
  if (l.includes('remote') || l.includes('uzak') || t.includes('remote') || t.includes('uzak')) {
    return { ok: false, reason: "Remote İlan (Sadece TR İçi Fiziksel/Hibrit İsteniyor)" };
  }

  // 5. Turkey Location Match
  const trSignal = /\b(türkiye|turkey|turkiye|istanbul|ankara|izmir|kocaeli|izmit|gebze|antalya|samsun|eskişehir|eskisehir|kadıköy|ümraniye|şişli|beşiktaş|maslak|levent|ataşehir|kartal|pendik)\b/i.test(l);
  if (!trSignal && l.length > 0) {
    return { ok: false, reason: "Türkiye Dışı Lokasyon" };
  }

  return { ok: true };
}

/**
 * Strict, Rational AI Evaluation Logic with Specific Penalties
 */
async function evaluateJobStrict(jobData, cvContent) {
  const anthropicKey = getEnvKey('ANTHROPIC_API_KEY');
  const geminiKey = getEnvKey('GEMINI_API_KEY');

  const text = ((jobData.role || '') + ' ' + (jobData.description || '')).toLowerCase();

  // Pre-check specific domain penalties
  const has10YearsReq = /10\+?\s*years|10\+?\s*yıl|10\s*yılı|minimum 10/i.test(text);
  const hasCreditRisk = /ifrs|ecl|rwa|pd\b|lgd\b|ead\b|kredi riski|kredi tahsis/i.test(text);
  const hasProductionDE = /3\+?\s*years.*data engineer|spark|airflow|lakehouse|data pipeline/i.test(text);

  const prompt = `
Sen son derece objektif, rasyonel ve gerçekçi bir İnsan Kaynakları ve Veri Bilimi Teknik Değerlendirme Uzmanısın.
Görevin, aşağıdaki adayın profilini ilanla karşılaştırıp CİDDİ VE GERÇEKÇİ BİR PUANLAMA (1.0 - 5.0) yapmaktır.

Puan Enflasyonundan Kaçın! Ortalama bir ilan 2.5 - 3.5 arasında kalmalıdır. 3.7 ve üzeri puanlar SADECE Adayın profilinin BİREBİR ÖRTÜŞTÜĞÜ nadir durumlar içindir.

ADAY PROFİLİ (Doğa Okumuş):
- Deneyim: 9 Yıl Toplam (Turkcell 2 Patent sahibi - Kampanya ROI Ölçümleme & Kampanya Öneri Motoru, Tilburg M.Sc. Data Science, KPN Amsterdam, Getir).
- Temel Yetkinlikler: İleri SQL, Python (scikit-learn, XGBoost, LightGBM), Power BI, OR-Tools CP-SAT optimizasyonu, Müşteri Segmentasyonu, Raporlama, Süreç Analizi.
- Eksik Olduğu Alanlar (GÖRÜRSEK KESİNLİKLE CEZA UYGULA):
  * Banka Kredi Riski (PD, LGD, EAD, IFRS-9, ECL, RWA modelleri) tecrübesi YOKTUR (İlan istiyorsa Puan < 3.0 ver).
  * Saf Veri Mühendisliği (Production Data Engineering / Spark / Airflow 3+ yıl) tecrübesi YOKTUR (İlan istiyorsa Puan < 3.0 ver).
  * 10+ Yıl Yönetici/Müdür kıdemi beklentisi adayın 9 yıllık uzmanlık seviyesiyle örtüşmez (İlan istiyorsa Puan < 3.0 ver).

DEĞERLENDİRİLECEK İLAN:
-------------------
Şirket: ${jobData.company || 'Bilinmiyor'}
Pozisyon: ${jobData.role || 'Bilinmiyor'}
Lokasyon: ${jobData.location || 'Türkiye'}
İlan Metni:
${(jobData.description || '').slice(0, 3000)}

PUANLAMA KURALLARI:
- 4.5 - 5.0: Mükemmel Uyum (SQL+Python+Power BI + Telekom/Perakende kampanya/müşteri analitiği + tam kıdem).
- 3.7 - 4.4: Güçlü Uyum (Teknik yetkinlikler tam, adayın uzmanlık alanına oturuyor).
- 3.0 - 3.6: Sınırda / Zayıf Uyum (Telegram'a gönderilmeyecek).
- 1.0 - 2.9: DÜŞÜK UYUM (Domain uyuşmazlığı: Banka kredi riski, 10+ yıl yönetici, saf DE, MLOps, C++).

Lütfen cevabını SADECE şu JSON formatında yaz:
{
  "score": 2.8,
  "summary": "İlan kredi riski (IFRS-9/PD) tecrübesi gerektirdiğinden adayın profiline uymamaktadır.",
  "strengths": ["İleri SQL ve Veri Analizi tecrübesi"],
  "gaps": ["Banka Kredi Riski ve ECL/RWA modelleme tecrübesi bulunmamaktadır"],
  "recommendation": "Pas Geçilebilir"
}
`;

  // 1. Anthropic Claude Call
  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await res.json();
      if (data.content && data.content[0]?.text) {
        const match = data.content[0].text.match(/\{[\s\S]*\}/);
        if (match) {
          const evalRes = JSON.parse(match[0]);
          // Post-process domain penalties if model missed it
          if ((hasCreditRisk || has10YearsReq || hasProductionDE) && evalRes.score > 3.2) {
            evalRes.score = 2.8;
            evalRes.recommendation = "Pas Geçilebilir (Domain/Kıdem Uyuşmazlığı)";
          }
          return { ok: true, evaluation: evalRes };
        }
      }
    } catch (err) {
      console.warn('⚠️ Anthropic call error:', err.message);
    }
  }

  // 2. Heuristic Strict Rule Engine
  let score = 3.2;
  const strengths = [];
  const gaps = [];

  if (/sql|power bi|dashboard|raporlama|veri analisti|data analyst/i.test(text)) {
    score += 0.4;
    strengths.push("İleri düzey SQL & Power BI veri analizi tecrübesi");
  }
  if (/python|machine learning|veri bilimci|data scientist/i.test(text)) {
    score += 0.4;
    strengths.push("M.Sc. Veri Bilimi ve Python modelleme altyapısı");
  }

  // Strict Deductions
  if (hasCreditRisk) {
    score -= 1.5;
    gaps.push("Banka Kredi Riski (PD, LGD, EAD, IFRS-9, ECL, RWA) modelleme tecrübesi yoktur");
  }
  if (has10YearsReq) {
    score -= 1.4;
    gaps.push("10+ Yıl tecrübe / Üst düzey yöneticilik beklentisi kıdem seviyesiyle örtüşmüyor");
  }
  if (hasProductionDE) {
    score -= 1.4;
    gaps.push("Üretim ortamında saf Veri Mühendisliği (Spark/Airflow) tecrübesi bulunmamaktadır");
  }

  score = Math.min(4.5, Math.max(1.5, Math.round(score * 10) / 10));

  return {
    ok: true,
    evaluation: {
      score,
      summary: `Rasyonel Değerlendirme: CV yetkinlikleri ile ilan gereksinimleri %${Math.round(score * 20)} oranında uyumludur.`,
      strengths: strengths.length ? strengths : ["Analitik düşünce ve veri analizi temeli"],
      gaps: gaps.length ? gaps : ["Spesifik domain/araç gereksinimi"],
      recommendation: score >= 3.7 ? "Başvurulabilir" : "Pas Geçilebilir"
    }
  };
}

async function main() {
  const cachePath = path.join(ROOT, 'batch', 'jd-cache.json');
  if (!fs.existsSync(cachePath)) {
    console.error('❌ batch/jd-cache.json bulunamadı!');
    return;
  }

  const cvPath = path.join(ROOT, 'cv.md');
  const cvContent = fs.existsSync(cvPath) ? fs.readFileSync(cvPath, 'utf8') : '';

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  console.log(`📊 Toplam ${cache.length} adet ilan kullanıcı özel kriterleriyle taranıyor...`);

  const additionsDir = path.join(ROOT, 'batch', 'tracker-additions');
  if (!fs.existsSync(additionsDir)) fs.mkdirSync(additionsDir, { recursive: true });

  const reportsDir = path.join(ROOT, 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  let count = 0;
  let sentAlerts = 0;
  let skippedFilter = 0;
  let skippedLowScore = 0;

  for (const job of cache) {
    count++;
    
    // Check Strict Filters (Location, Title, Agency, Confidential)
    const check = isValidTargetJob(job.company, job.title, job.location);
    if (!check.ok) {
      console.log(`⏭️ [${count}/${cache.length}] ELEDİ (${check.reason}): ${job.company} — ${job.title} (${job.location})`);
      skippedFilter++;
      continue;
    }

    console.log(`\n[${count}/${cache.length}] Sıkı Değerlendirme: ${job.company} — ${job.title} (${job.location})`);

    const result = await evaluateJobStrict({
      company: job.company,
      role: job.title,
      location: job.location,
      description: job.jd
    }, cvContent);

    if (result.ok && result.evaluation) {
      const ev = result.evaluation;
      const reportNum = job.report || String(945 + count);
      const cslug = slug(job.company);
      const reportFile = `${reportNum}-${cslug}-${TODAY}.md`;
      const reportPath = path.join(reportsDir, reportFile);

      // Markdown Raporu oluştur
      const reportContent = `# Evaluation: ${job.company} -- ${job.title}

**Date:** ${TODAY}
**Score:** ${ev.score}/5.0
**URL:** ${job.url}
**Location:** ${job.location}

---

## Değerlendirme Özeti
${ev.summary || ''}

## Güçlü Yönler (CV Uyum)
${(ev.strengths || []).map(s => `- ${s}`).join('\n')}

## Eksikler / Gelişim Alanları
${(ev.gaps || []).map(g => `- ${g}`).join('\n')}

**Sonuç:** ${ev.recommendation || 'Evaluated'}
`;

      fs.writeFileSync(reportPath, reportContent, 'utf8');

      // TSV dosyasını yaz
      const note = (ev.summary || ev.recommendation || 'Sıkı kriterlerle değerlendirildi').replace(/\t/g, ' ').replace(/\n/g, ' ');
      const tsvContent = `${reportNum}\t${TODAY}\t${job.company}\t${job.title}\tEvaluada\t${ev.score}/5\t❌\t[${reportNum}](reports/${reportFile})\t${note}\n`;
      fs.writeFileSync(path.join(additionsDir, `${reportNum}-${cslug}.tsv`), tsvContent, 'utf8');

      // Telegram Uyarısı Gönder — YALNIZCA SKOR >= 3.7 İSE!
      if (ev.score >= 3.7) {
        const alertRes = await sendJobEvaluationAlert({
          company: job.company,
          role: job.title,
          score: ev.score,
          notes: ev.summary || ev.recommendation,
          jobUrl: job.url,
          reportUrl: `reports/${reportFile}`
        });

        if (alertRes && alertRes.ok) sentAlerts++;
      } else {
        console.log(`⏭️ Skor (${ev.score}) 3.7 alt sınırının altında kaldığı için Telegram'a gönderilmedi.`);
        skippedLowScore++;
      }
    }

    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n🎉 TAMAMLANDI: Toplam ${cache.length} ilan işlendi.`);
  console.log(`🚫 Ön Filtre ile Elenen (Remote/Unvan/Aracı Firma/Gizli): ${skippedFilter}`);
  console.log(`🛑 Skoru 3.7 Altında Kalıp Elenen İlan: ${skippedLowScore}`);
  console.log(`📲 Telegram'a Gönderilen Gerçek Uyumlu İlan: ${sentAlerts}`);
}

main().catch(err => console.error('Hata:', err));
