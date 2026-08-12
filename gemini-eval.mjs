import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '.env');

function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('GEMINI_API_KEY=')) {
        return trimmed.split('=')[1].trim();
      }
    }
  }
  return '';
}

/**
 * Evaluates a Job Description against Doga Okumus CV using Google Gemini API (Free Tier)
 */
export async function evaluateJobWithGemini(jobData) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY is not configured in .env or secrets.');
    return { ok: false, error: 'NO_GEMINI_KEY' };
  }

  let cvPath = path.join(__dirname, 'cv.md');
  if (!fs.existsSync(cvPath)) cvPath = path.join(__dirname, 'examples', 'cv-example.md');
  const cvContent = fs.existsSync(cvPath) ? fs.readFileSync(cvPath, 'utf8') : '';

  const prompt = `
Sen kıdemli bir İnsan Kaynakları ve Veri Bilimi Teknik Değerlendirme Uzmanısın.
Aşağıda adayın güncel özgeçmişi (CV) ve değerlendirilecek iş ilanı metni verilmiştir.

Adayın Özgeçmişi (CV):
-------------------
${cvContent}

Değerlendirilecek İş İlanı:
-------------------
Şirket: ${jobData.company || 'Bilinmiyor'}
Pozisyon: ${jobData.role || 'Bilinmiyor'}
Lokasyon: ${jobData.location || 'Türkiye / Remote TR'}
İlan Metni:
${jobData.description || jobData.rawContent || 'Metin belirtilmedi.'}

GÖREVİN:
İlanı incele ve adayın tecrübeleriyle (Turkcell 2 patenti, Tilburg M.Sc. Data Science, OR-Tools CP-SAT optimizasyonu, SQL, Python, Power BI, telekom/perakende) ne kadar örtüştüğünü 1.0 ile 5.0 arasında bir puan vererek değerlendir.

Lütfen cevabını SADECE aşağıdaki JSON formatında ver:
{
  "score": 4.2,
  "status": "Evaluated",
  "summary": "Teknik yetkinlikler ve 2 patent geçmişi ilanla %90+ örtüşüyor.",
  "strengths": ["Patent geçmişi", "İleri SQL ve Python", "Optimizasyon"],
  "gaps": ["Aranan spesifik bir BI tool eksikliği (varsa)"],
  "recommendation": "Kesinlikle başvurulmalı"
}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    const data = await res.json();
    if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
      const jsonText = data.candidates[0].content.parts[0].text;
      const parsed = JSON.parse(jsonText);
      console.log(`✅ Gemini Evaluation completed! Score: ${parsed.score}/5.0`);
      return { ok: true, evaluation: parsed };
    } else {
      console.error('❌ Gemini API Response error:', data);
      return { ok: false, error: 'INVALID_GEMINI_RESPONSE' };
    }
  } catch (err) {
    console.error('❌ Failed to call Gemini API:', err.message);
    return { ok: false, error: err.message };
  }
}
