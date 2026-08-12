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
 * Strict Location Validator — ONLY Turkey (7 il) and Turkey-accessible Remote
 */
function isTrOrGlobalRemote(locText) {
  const t = (locText || "").toLowerCase();
  if (!t) return true; // Bilinmiyorsa detayda elenebilir

  // Türkiye Şehirleri ve Terimleri
  const trSignal = /\b(türkiye|turkey|turkiye|istanbul|ankara|izmir|kocaeli|izmit|gebze|antalya|samsun|eskişehir|eskisehir|kadıköy|ümraniye|şişli|beşiktaş|maslak|levent|ataşehir|kartal|pendik|ümraniye)\b/i.test(t);
  
  if (trSignal) return true;

  // Yabancı Ülke / Şehir Kısıtları (Türkiye Dışı)
  const foreignOnly = /\b(united states|usa|u\.s\.|us only|canada|uk|united kingdom|london|germany|berlin|munich|münchen|amsterdam|netherlands|holland|india|bangalore|singapore|australia|spain|madrid|france|paris)\b/i.test(t);

  // Global / EMEA Remote kontrolü
  const isRemote = /\bremote\b|anywhere|work from home/i.test(t);
  const isEmeaGlobal = /\b(emea|worldwide|global|europe|eu)\b/i.test(t);

  if (isRemote && (!foreignOnly || isEmeaGlobal)) {
    return true;
  }

  return false;
}

/**
 * Strict, Rational AI Evaluation Logic
 */
async function evaluateJobStrict(jobData, cvContent) {
  const anthropicKey = getEnvKey('ANTHROPIC_API_KEY');
  const geminiKey = getEnvKey('GEMINI_API_KEY');

  const prompt = `
Sen rasyonel, oldukça objektif ve sıkı bir İnsan Kaynakları ve Veri Bilimi Değerlendirme Uzmanısın.
Görevin, aşağıdaki adayın profilini ilanla karşılaştırıp CİDDİ VE GERÇEKÇİ BİR PUANLAMA (1.0 - 5.0) yapmaktır.

Puan Enflasyonundan Kaçın! Ortalama bir ilan 2.5 - 3.5 arasında kalmalıdır. 4.0 ve üzeri puanlar SADECE Adayın profilinin BİREBİR ÖRTÜŞTÜĞÜ nadir durumlar için saklanmalıdır.

ADAY PROFİLİ (Doğa Okumuş):
- Tecrübe: 9 Yıl (Turkcell 2 Patent sahibi - Kampanya ROI Ölçümleme & Kampanya Öneri Motoru, KPN Amsterdam, Getir).
- Eğitim: Tilburg Üniversitesi M.Sc. Data Science (Hollanda).
- Temel Yetkinlikler: İleri SQL, Python (scikit-learn, XGBoost, LightGBM), Power BI, OR-Tools CP-SAT optimizasyonu, Müşteri Segmentasyonu, Raporlama, Süreç Analizi.
- Hedef Rol: Senior Data Analyst, BI Specialist, Data Scientist (Müşteri/Kampanya Analitiği), Business Analyst.

DEĞERLENDİRİLECEK İLAN:
-------------------
Şirket: ${jobData.company || 'Bilinmiyor'}
Pozisyon: ${jobData.role || 'Bilinmiyor'}
Lokasyon: ${jobData.location || 'Türkiye'}
İlan Metni:
${(jobData.description || '').slice(0, 3000)}

PUANLAMA KURALLARI (ÇOK SIKI VE RASYONEL UYGULA):
- 4.5 - 5.0: Olağanüstü Uyum (SQL+Python+Power BI + Telekom/Perakende kampanya/müşteri analitiği + tam kıdem).
- 4.0 - 4.4: Güçlü Uyum (Teknik yetkinlikler tam, en fazla 1 önemsiz araç eksikliği).
- 3.3 - 3.9: Sınırda / Şartlı Uyum (Pozisyon adayın tecrübesine göre biraz farklı bir alanda veya hafif alt/üst kıdemde).
- 1.0 - 3.2: DÜŞÜK UYUM (Adayın alanıyla ilgisiz, pure Java/C++ yazılım, pure MLOps altyapı, veya basit Excel veri girişi).

Lütfen cevabını SADECE şu JSON formatında yaz:
{
  "score": 3.4,
  "summary": "Teknik yetkinlikler kısmen örtüşüyor, ancak domain farkı ve MLOps şartı nedeniyle puan kısıtlandı.",
  "strengths": ["İleri SQL ve Veri Analizi tecrübesi"],
  "gaps": ["Zorunlu C++ ve altyapı mühendisliği tecrübesi eksik"],
  "recommendation": "Koşullu Başvurulabilir"
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
        const text = data.content[0].text;
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          return { ok: true, evaluation: JSON.parse(match[0]) };
        }
      }
    } catch (err) {
      console.warn('⚠️ Anthropic call error:', err.message);
    }
  }

  // 2. Gemini Call
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      });
      const data = await res.json();
      if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
        return { ok: true, evaluation: JSON.parse(data.candidates[0].content.parts[0].text) };
      }
    } catch (err) {
      console.warn('⚠️ Gemini call error:', err.message);
    }
  }

  // 3. Strict Heuristic Rule-Engine
  const text = ((jobData.role || '') + ' ' + (jobData.description || '')).toLowerCase();
  let score = 2.8; // Baseline lowered to prevent inflation
  const strengths = [];
  const gaps = [];

  if (/sql|power bi|dashboard|raporlama|veri analisti|data analyst/i.test(text)) {
    score += 0.5;
    strengths.push("İleri düzey SQL & Power BI veri analizi tecrübesi");
  }
  if (/python|machine learning|veri bilimci|data scientist/i.test(text)) {
    score += 0.4;
    strengths.push("M.Sc. Veri Bilimi ve Python modelleme altyapısı");
  }
  if (/turkcell|telekom|crm|kampanya|roi|retention|churn/i.test(text)) {
    score += 0.4;
    strengths.push("Turkcell patentli ROI & Kampanya yönetimi domain uyumu");
  }

  // Deductions (Strictness)
  if (/java|c\+\+|golang|embedded|firmware|devops|kubernetes/i.test(text)) {
    score -= 0.8;
    gaps.push("Yazılım altyapı / MLOps gereksinimleri aday profili dışındadır");
  }
  if (/staj|intern|working student|0-1 yıl/i.test(text)) {
    score -= 0.6;
    gaps.push("Başlangıç/Stajyer seviye pozisyon (9 yıllık kıdemle uyuşmuyor)");
  }

  score = Math.min(4.5, Math.max(1.5, Math.round(score * 10) / 10));

  return {
    ok: true,
    evaluation: {
      score,
      summary: `Rasyonel Değerlendirme: CV yetkinlikleri ile ilan gereksinimleri %${Math.round(score * 20)} oranında uyumludur.`,
      strengths: strengths.length ? strengths : ["Analitik düşünce ve veri analizi temeli"],
      gaps: gaps.length ? gaps : ["Sektöre özgü araç/yazılım gereksinimi"],
      recommendation: score >= 4.0 ? "Güçlü Başvurulmalı" : score >= 3.3 ? "Makul / Değerlendirilebilir" : "Pas Geçilebilir"
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
  console.log(`📊 Toplam ${cache.length} adet ilan rasyonel kriterlerle filtreleniyor...`);

  // 1. Sıkı Lokasyon Filtresi: Sadece Türkiye ve TR-Uyumlu Global Remote
  const trJobs = cache.filter(j => isTrOrGlobalRemote(j.location));
  console.log(`🇹🇷 Filtre Sonrası Türkiye & TR-Remote İlan Sayısı: ${trJobs.length} (Yabancı lokasyonlu ${cache.length - trJobs.length} ilan elendi)`);

  const additionsDir = path.join(ROOT, 'batch', 'tracker-additions');
  if (!fs.existsSync(additionsDir)) fs.mkdirSync(additionsDir, { recursive: true });

  const reportsDir = path.join(ROOT, 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  let count = 0;
  let sentAlerts = 0;
  let skippedLowScore = 0;

  for (const job of trJobs) {
    count++;
    console.log(`\n[${count}/${trJobs.length}] Sıkı Değerlendirme: ${job.company} — ${job.title} (${job.location})`);

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

  console.log(`\n🎉 TAMAMLANDI: ${trJobs.length} ilan rasyonel kriterlerle değerlendirildi.`);
  console.log(`📲 Telegram'a Gönderilen Gerçek Uyumlu İlan: ${sentAlerts}`);
  console.log(`🛑 Skoru 3.3 Altında Kalıp Elenen İlan: ${skippedLowScore}`);
}

main().catch(err => console.error('Hata:', err));
