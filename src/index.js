import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = 'o1Utd0sitgdDan3Bw';

// Simple in-memory rate limiter: 3 analyses per IP per hour
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const limit = 3;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length >= limit) {
    const oldest = timestamps[0];
    const resetMs = windowMs - (now - oldest);
    const resetMin = Math.ceil(resetMs / 60000);
    return { allowed: false, resetMin };
  }

  timestamps.push(now);
  return { allowed: true };
}

// Clean up old rate limit entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap.entries()) {
    const fresh = timestamps.filter(t => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) {
      rateLimitMap.delete(ip);
    } else {
      rateLimitMap.set(ip, fresh);
    }
  }
}, 30 * 60 * 1000);

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

app.get('/analyze', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Normalize URL
  let storeUrl = url.trim();
  if (!storeUrl.startsWith('http')) {
    storeUrl = 'https://' + storeUrl;
  }

  // Rate limit check
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `Rate limit reached. You can run 3 free analyses per hour. Try again in ${rateCheck.resetMin} minute(s).`
    });
  }

  if (!APIFY_TOKEN) {
    return res.status(500).json({ error: 'Server misconfiguration: missing APIFY_TOKEN' });
  }

  try {
    const apifyUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

    const response = await fetch(apifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'analyze_store', store_url: storeUrl }),
      signal: AbortSignal.timeout(120_000), // 2 min timeout
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Apify error:', response.status, text);
      return res.status(502).json({ error: 'Analysis service error. Please try again.' });
    }

    const items = await response.json();

    // The actor returns an array of dataset items; flatten if needed
    const data = Array.isArray(items) && items.length > 0 ? items[0] : items;

    return res.json({ success: true, data });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'Analysis timed out. The store may be slow or blocking requests.' });
    }
    console.error('Analyze error:', err);
    return res.status(500).json({ error: 'Unexpected error. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`ShopifySpy running on port ${PORT}`);
});
