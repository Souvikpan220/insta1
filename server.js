const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// ---- ENV ----
const FALCON_API_KEY = process.env.FALCON_API_KEY;
const FALCON_API_URL = 'https://falconsmmpanel.com/api/v2';
const SERVICE_ID = '3030';
const QUANTITY = 500;

const ORDER_WEBHOOK = process.env.ORDER_WEBHOOK;
const VISITOR_WEBHOOK = process.env.VISITOR_WEBHOOK;
const DISCORD_LINK = process.env.DISCORD_LINK || 'https://discord.gg/YOUR_DISCORD';

// ---- RATE LIMIT STORE (in-memory) ----
// Structure: { ip: { uses: [{timestamp}], lastUse: timestamp } }
// Free: max 3 uses per 24h, 10 min cooldown between uses
const RATE_STORE = {};
const FREE_DAILY_LIMIT = 3;
const COOLDOWN_MS = 10 * 60 * 1000;       // 10 minutes
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Purge old entries every hour to prevent memory bloat
setInterval(() => {
  const now = Date.now();
  for (const ip in RATE_STORE) {
    RATE_STORE[ip].uses = RATE_STORE[ip].uses.filter(t => now - t < DAILY_WINDOW_MS);
    if (RATE_STORE[ip].uses.length === 0) delete RATE_STORE[ip];
  }
}, 60 * 60 * 1000);

function checkRateLimit(ip) {
  const now = Date.now();
  if (!RATE_STORE[ip]) RATE_STORE[ip] = { uses: [] };
  const entry = RATE_STORE[ip];

  // Filter to only uses within last 24h
  entry.uses = entry.uses.filter(t => now - t < DAILY_WINDOW_MS);

  // Check daily quota
  if (entry.uses.length >= FREE_DAILY_LIMIT) {
    // How long until oldest use expires
    const oldestUse = Math.min(...entry.uses);
    const resetSeconds = Math.ceil((oldestUse + DAILY_WINDOW_MS - now) / 1000);
    return { allowed: false, limitType: 'quota', resetSeconds };
  }

  // Check cooldown from last use
  if (entry.uses.length > 0) {
    const lastUse = Math.max(...entry.uses);
    const elapsed = now - lastUse;
    if (elapsed < COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      return { allowed: false, limitType: 'cooldown', remainingSeconds };
    }
  }

  return { allowed: true };
}

function recordUse(ip) {
  if (!RATE_STORE[ip]) RATE_STORE[ip] = { uses: [] };
  RATE_STORE[ip].uses.push(Date.now());
}


async function getIpInfo(ip) {
  try {
    const clean = ip === '::1' || ip === '127.0.0.1' ? '' : ip;
    const url = clean ? `https://ipapi.co/${clean}/json/` : 'https://ipapi.co/json/';
    const res = await axios.get(url, { timeout: 3000 });
    return res.data;
  } catch {
    return {};
  }
}

// ---- HELPER: parse device ----
function parseDevice(ua = '') {
  if (/Mobile|Android|iPhone|iPad/.test(ua)) return '📱 Mobile';
  if (/Tablet/.test(ua)) return '💻 Tablet';
  return '🖥️ Desktop';
}

function parseBrowser(ua = '') {
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome';
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
  if (ua.includes('Edg')) return 'Edge';
  return 'Unknown';
}

// ---- POST /api/order ----
app.post('/api/order', async (req, res) => {
  const { link } = req.body;

  if (!link || (!link.includes('instagram.com/reel/') && !link.includes('instagram.com/p/'))) {
    return res.json({ success: false, error: 'Invalid Instagram link.' });
  }

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'Unknown';

  // Rate limit check (premium users can pass a token to bypass — extend here as needed)
  const isPremium = req.body.premiumToken === process.env.PREMIUM_TOKEN;
  if (!isPremium) {
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      return res.json({ success: false, ...limit });
    }
  }

  if (!FALCON_API_KEY) {
    return res.json({ success: false, error: 'Service not configured. Please contact support.' });
  }

  try {
    // Place order on Falcon SMM Panel
    const falconRes = await axios.post(FALCON_API_URL, null, {
      params: {
        key: FALCON_API_KEY,
        action: 'add',
        service: SERVICE_ID,
        link: link,
        quantity: QUANTITY,
      },
    });

    const orderData = falconRes.data;

    if (orderData.error) {
      return res.json({ success: false, error: orderData.error });
    }

    // Record successful use for rate limiting
    if (!isPremium) recordUse(ip);

    // Get IP info for logging
    const ipInfo = await getIpInfo(ip);
    const ua = req.headers['user-agent'] || '';
    const now = new Date().toUTCString();

    // Send order webhook to Discord
    if (ORDER_WEBHOOK) {
      await axios.post(ORDER_WEBHOOK, {
        embeds: [
          {
            title: '📦 New Order Placed',
            color: 0x7c4dff,
            fields: [
              { name: '🔗 Instagram Link', value: link, inline: false },
              { name: '📊 Quantity', value: String(QUANTITY), inline: true },
              { name: '🌍 Country', value: ipInfo.country_name || 'Unknown', inline: true },
              { name: '📍 Region', value: ipInfo.region || 'Unknown', inline: true },
              { name: '🌐 IP', value: ip, inline: true },
              { name: '🖥️ Device', value: parseDevice(ua), inline: true },
              { name: '🌐 Browser', value: parseBrowser(ua), inline: true },
              { name: '🕐 Time', value: now, inline: false },
              { name: '🪪 Order ID', value: String(orderData.order || 'N/A'), inline: true },
            ],
            footer: { text: 'InstaBoost Orders' },
          },
        ],
      }).catch(() => {});
    }

    return res.json({ success: true, order: orderData.order });
  } catch (err) {
    console.error('Order error:', err.message);
    return res.json({ success: false, error: 'Failed to place order. Please try again.' });
  }
});

// ---- POST /api/track ----
app.post('/api/track', async (req, res) => {
  const { referrer, userAgent, language, screen } = req.body;

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'Unknown';

  const ipInfo = await getIpInfo(ip);
  const now = new Date().toUTCString();

  if (VISITOR_WEBHOOK) {
    await axios.post(VISITOR_WEBHOOK, {
      embeds: [
        {
          title: '👁️ New Visitor',
          color: 0xe040fb,
          fields: [
            { name: '🌍 Country', value: ipInfo.country_name || 'Unknown', inline: true },
            { name: '📍 Region', value: ipInfo.region || 'Unknown', inline: true },
            { name: '🏙️ City', value: ipInfo.city || 'Unknown', inline: true },
            { name: '🌐 IP', value: ip, inline: true },
            { name: '🖥️ Device', value: parseDevice(userAgent), inline: true },
            { name: '🌐 Browser', value: parseBrowser(userAgent), inline: true },
            { name: '📐 Screen', value: screen || 'Unknown', inline: true },
            { name: '🌍 Language', value: language || 'Unknown', inline: true },
            { name: '🔗 Referrer', value: referrer || 'Direct', inline: false },
            { name: '🕐 Time', value: now, inline: false },
          ],
          footer: { text: 'InstaBoost Visitors' },
        },
      ],
    }).catch(() => {});
  }

  return res.json({ ok: true });
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
