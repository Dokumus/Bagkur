import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '.env');

// Read .env helper
function getEnvConfig() {
  const config = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    MIN_TELEGRAM_SCORE: parseFloat(process.env.MIN_TELEGRAM_SCORE || '3.7'),
  };

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valParts] = trimmed.split('=');
        const keyName = key.trim();
        const val = valParts.join('=').trim();
        if (keyName === 'TELEGRAM_BOT_TOKEN') config.TELEGRAM_BOT_TOKEN = val;
        if (keyName === 'TELEGRAM_CHAT_ID') config.TELEGRAM_CHAT_ID = val;
        if (keyName === 'MIN_TELEGRAM_SCORE') config.MIN_TELEGRAM_SCORE = parseFloat(val);
      }
    });
  }

  return config;
}

// Persistent Telegram Sent History (dedup)
const sentHistoryPath = path.join(__dirname, 'data', 'sent-telegram.json');

function getSentHistory() {
  try {
    if (fs.existsSync(sentHistoryPath)) {
      return new Set(JSON.parse(fs.readFileSync(sentHistoryPath, 'utf8')));
    }
  } catch {}
  return new Set();
}

function saveSentHistory(historySet) {
  try {
    const dataDir = path.dirname(sentHistoryPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(sentHistoryPath, JSON.stringify([...historySet], null, 2), 'utf8');
  } catch (err) {
    console.error('❌ Failed to save sent history:', err.message);
  }
}

// Update .env with new key-value pair
function updateEnvFile(key, value) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
}

/**
 * Sends a message via Telegram Bot API
 */
export async function sendTelegramMessage(text, options = {}) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = getEnvConfig();

  if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not configured in .env');
    return { ok: false, error: 'NO_TOKEN' };
  }

  const chatId = options.chatId || TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn('⚠️ TELEGRAM_CHAT_ID is not configured. User needs to send a message to @iskur_bot on Telegram.');
    return { ok: false, error: 'NO_CHAT_ID' };
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: options.parse_mode || 'HTML',
    disable_web_page_preview: options.disable_web_page_preview || false,
  };

  const maxRetries = options.maxRetries || 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        console.log('✅ Telegram message sent successfully!');
        return { ok: true, data };
      } else if (data.error_code === 429) {
        const retryAfter = (data.parameters?.retry_after || 4) + 1;
        console.warn(`⏳ Telegram Rate Limit (429). Waiting ${retryAfter}s before retry...`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      } else {
        console.error('❌ Telegram API error:', data);
        return { ok: false, error: data.description };
      }
    } catch (err) {
      console.error('❌ Failed to connect to Telegram API:', err.message);
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'MAX_RETRIES_EXCEEDED' };
}

export function normCompany(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[ğ]/g, 'g').replace(/[ü]/g, 'u').replace(/[ş]/g, 's')
    .replace(/[ı]/g, 'i').replace(/[ö]/g, 'o').replace(/[ç]/g, 'c')
    .replace(/\b(inc|llc|ltd|gmbh|bv|nv|group|technologies|the|a\.s\.|as)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function normRole(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[ğ]/g, 'g').replace(/[ü]/g, 'u').replace(/[ş]/g, 's')
    .replace(/[ı]/g, 'i').replace(/[ö]/g, 'o').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(senior|junior|lead|staff|principal|kidemli|uzman|uzmani|analist|analisti|engineer|muhendisi)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractDedupKeys(jobData) {
  const keys = new Set();
  if (!jobData) return [];

  const company = jobData.company || '';
  const role = jobData.role || '';
  const cNorm = normCompany(company);
  const rNorm = normRole(role);

  if (cNorm && rNorm) {
    keys.add(`comp:${cNorm}::role:${rNorm}`);
  }

  const rawUrls = [jobData.jobUrl, jobData.reportUrl].filter(Boolean);
  for (const raw of rawUrls) {
    const rawStr = String(raw).trim();
    // Check if markdown link format [num](url)
    const mdMatch = rawStr.match(/\[(?:[^\]]+)\]\(([^)]+)\)/);
    const targetUrl = mdMatch ? mdMatch[1] : rawStr;

    // Extract report number if any (e.g. reports/1176-teb-2026-08-12.md or [1176])
    const repNumMatch = targetUrl.match(/reports\/(\d+)-/) || rawStr.match(/\[(\d+)\]/);
    if (repNumMatch) {
      keys.add(`report:${repNumMatch[1]}`);
    }

    if (targetUrl.startsWith('http')) {
      const cleanUrl = targetUrl.split('?')[0].split('#')[0].replace(/\/$/, '').toLowerCase();
      keys.add(cleanUrl);
    } else if (targetUrl.includes('reports/')) {
      const repPath = targetUrl.slice(targetUrl.indexOf('reports/')).toLowerCase();
      keys.add(repPath);
    }
  }

  return [...keys];
}

/**
 * Formats and sends a Job Evaluation Alert to Telegram if score >= minScore (3.7) and not previously sent
 */
export async function sendJobEvaluationAlert(jobData) {
  const { MIN_TELEGRAM_SCORE } = getEnvConfig();
  const minScore = jobData.minScore || MIN_TELEGRAM_SCORE || 3.7;
  const score = parseFloat(jobData.score);

  if (isNaN(score) || score < minScore) {
    console.log(`ℹ️ Score (${jobData.score}) is below threshold (${minScore}). Skipping Telegram alert.`);
    return { skipped: true, reason: 'SCORE_BELOW_THRESHOLD' };
  }

  // Dedup check against sent-telegram.json
  const sentSet = getSentHistory();
  const keys = extractDedupKeys(jobData);

  const alreadySent = keys.some(k => sentSet.has(k));
  if (alreadySent) {
    console.log(`⏭️ Job "${jobData.company} - ${jobData.role}" already sent to Telegram previously. Skipping duplicate.`);
    return { skipped: true, reason: 'ALREADY_SENT' };
  }

  const scoreEmoji = score >= 4.5 ? '🌟' : score >= 4.0 ? '🔥' : '✅';

  const messageHtml = `
<b>${scoreEmoji} Yeni Yüksek Uyumlu İlan Fırsatı! (3.7+)</b>

🏢 <b>Şirket:</b> ${escapeHtml(jobData.company || 'Bilinmiyor')}
💼 <b>Pozisyon:</b> ${escapeHtml(jobData.role || 'Bilinmiyor')}
⭐ <b>Skor:</b> <code>${jobData.score}/5.0</code>

📝 <b>Özet Uyum Değerlendirmesi:</b>
<i>${escapeHtml(jobData.notes || 'Detaylı değerlendirme raporu oluşturuldu.')}</i>

🔗 <a href="${jobData.jobUrl || '#'}">İlan Sayfasına Git</a>
📄 <a href="${jobData.reportUrl || '#'}">Değerlendirme Raporunu İncele</a>

📱 <i>Career-Ops Agent Turkey System</i>
`.trim();

  const res = await sendTelegramMessage(messageHtml, { parse_mode: 'HTML' });
  if (res && res.ok) {
    for (const k of keys) {
      sentSet.add(k);
    }
    saveSentHistory(sentSet);
  }
  return res;
}

/**
 * Checks for updates from Telegram to automatically discover TELEGRAM_CHAT_ID
 */
export async function checkAndUpdateChatId() {
  const { TELEGRAM_BOT_TOKEN } = getEnvConfig();
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is missing in .env');
    return null;
  }

  console.log('🔍 Checking Telegram getUpdates for chat_id...');
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
    const data = await res.json();
    
    if (data.ok && data.result && data.result.length > 0) {
      // Find latest message from a user
      const lastUpdate = data.result[data.result.length - 1];
      const chat = lastUpdate.message?.chat || lastUpdate.my_chat_member?.chat;
      if (chat && chat.id) {
        const chatId = String(chat.id);
        console.log(`🎉 Found Chat ID: ${chatId} (${chat.first_name || chat.username || 'User'})`);
        updateEnvFile('TELEGRAM_CHAT_ID', chatId);
        
        // Send confirmation message
        await sendTelegramMessage(
          `🚀 <b>Tebrikler!</b>\n\nTelegram bot entegrasyonunuz başarıyla tamamlandı.\n<b>Skoru 3.3 ve üzeri</b> olan Türkiye ilanları anında buraya gönderilecektir.`,
          { chatId }
        );
        return chatId;
      }
    } else {
      console.log('ℹ️ Henüz bota mesaj gönderilmemiş. Telegram\'da @iskur_bot hesabına bir mesaj (ör. /start) gönderdikten sonra tekrar çalıştırın.');
      return null;
    }
  } catch (err) {
    console.error('❌ Error checking updates:', err.message);
    return null;
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// CLI handler
if (process.argv[1] && process.argv[1].endsWith('telegram-notify.mjs')) {
  const action = process.argv[2];
  if (action === 'check-chat-id' || action === 'check') {
    checkAndUpdateChatId();
  } else if (action === 'test') {
    sendTelegramMessage('🧪 <b>Career-Ops Test Bildirimi</b>\n\nBot bağlantınız çalışıyor!');
  } else if (action === 'notify') {
    const [, , , company, role, score, jobUrl, notes] = process.argv;
    sendJobEvaluationAlert({ company, role, score, jobUrl, notes });
  } else {
    console.log('Kullanım: node telegram-notify.mjs [check-chat-id | test | notify]');
  }
}
