import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const TODAY = new Date().toISOString().slice(0, 10);

const appliedJobs = [
  { company: "HubX", role: "Senior Data Analyst", score: "4.0/5", url: "https://www.linkedin.com/jobs/view/senior-data-analyst-growthlab-at-hubx-4435600386/" },
  { company: "Hepsiburada", role: "Senior Data Scientist (Search)", score: "4.1/5", url: "https://www.linkedin.com/jobs/view/senior-data-scientist-search-at-hepsiburada-nasdaq-heps-4426939969/" },
  { company: "Rollic", role: "Data Scientist", score: "4.0/5", url: "https://www.linkedin.com/jobs/view/data-scientist-at-rollic-4440128485/" },
  { company: "Arkas Holding", role: "İş Zekası Uzmanı", score: "4.0/5", url: "https://www.linkedin.com/jobs/view/i%CC%87%C5%9F-zekas%C4%B1-uzman%C4%B1-at-arkas-holding-4448876193/" },
  { company: "Turknet", role: "Senior Data Analyst", score: "4.2/5", url: "https://www.linkedin.com/jobs/view/senior-data-analyst-at-turknet-4414603719/" },
  { company: "LC Waikiki", role: "Analytics Engineer", score: "4.0/5", url: "https://www.linkedin.com/jobs/view/analytics-engineer-at-lc-waikiki-4448780599/" },
  { company: "Viennalife", role: "Veri Analitiği Bölüm Yönetmeni", score: "4.1/5", url: "https://www.linkedin.com/jobs/view/veri-analiti%C4%9Fi-b%C3%B6l%C3%BCm-y%C3%B6netmeni-at-viennalife-4451647479/" },
  { company: "Sigortam.net", role: "Senior Data Analyst", score: "4.1/5", url: "https://www.linkedin.com/jobs/view/senior-data-analyst-at-sigortam-net-4452384980/" }
];

const closedJobs = [
  { company: "EliteBI", role: "Veri Mühendisi", score: "3.2/5", url: "https://www.linkedin.com/jobs/view/veri-m%C3%BChendisi-at-elitebi-4447025181/" },
  { company: "Yapı Kredi", role: "Veri Bilimi Uzmanı/Danışmanı", score: "3.2/5", url: "https://www.linkedin.com/jobs/view/veri-bilimi-uzman%C4%B1-dan%C4%B1%C5%9Fman%C4%B1-at-yap%C4%B1-kredi-4444881967/" },
  { company: "Trendyol Group", role: "Pricing Data Analyst", score: "4.0/5", url: "https://www.linkedin.com/jobs/view/pricing-data-analyst-at-trendyol-group-4429636300/" }
];

function updateTracker() {
  const filePath = path.join(ROOT, 'data', 'applications.md');
  if (!fs.existsSync(filePath)) return;

  let content = fs.readFileSync(filePath, 'utf8');

  // 1. Update Viennalife & Sigortam.net existing lines
  content = content.replace(/(Viennalife\s*\|\s*Veri Analitiği Bölüm Yönetmeni\s*\|\s*[\d\.]+\/5\s*\|\s*)Evaluada/, '$1Aplicado');
  content = content.replace(/(Sigortam\.net\s*\|\s*Senior Data Analyst\s*\|\s*[\d\.]+\/5\s*\|\s*)Evaluada/, '$1Aplicado');

  // 2. Register any missing entries
  let maxId = 1002;
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^\|\s*(\d+)\s*\|/);
    if (match) {
      const id = parseInt(match[1], 10);
      if (id > maxId) maxId = id;
    }
  }

  const newLines = [];
  for (const item of appliedJobs) {
    if (!content.includes(item.company) || !content.includes(item.role)) {
      maxId++;
      newLines.push(`| ${maxId} | ${TODAY} | ${item.company} | ${item.role} | ${item.score} | Aplicado | ❌ | [${maxId}](${item.url}) | Kullanıcı tarafından başvuruldu |`);
    }
  }

  for (const item of closedJobs) {
    if (!content.includes(item.company) || !content.includes(item.role)) {
      maxId++;
      newLines.push(`| ${maxId} | ${TODAY} | ${item.company} | ${item.role} | ${item.score} | Descartado | ❌ | [${maxId}](${item.url}) | İlan kapandı / süresi doldu |`);
    }
  }

  if (newLines.length > 0) {
    content = content.trim() + '\n' + newLines.join('\n') + '\n';
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✅ ${appliedJobs.length} başvuru Yapıldı (Aplicado) ve ${closedJobs.length} Kapanan İlan (Descartado) güncellendi.`);
}

updateTracker();
