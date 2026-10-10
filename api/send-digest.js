/**
 * Weekly Market Digest — Vercel Serverless Function
 *
 * Vercel Cron calls this every Monday at 14:00 UTC (10 AM ET in summer, 9 AM in winter).
 * Every number in the email is real (see _digest.js), and each subscriber gets their own
 * portfolio, watchlist and paper trading sections.
 *
 * GET /api/send-digest                          send to everyone with digest = true (the cron)
 * GET /api/send-digest?to=you@x.com             send only to that account (a test)
 * GET /api/send-digest?preview=1[&to=you@x.com] show the email in the browser, send nothing
 * Outside the cron, add &secret=<CRON_SECRET>.
 *
 * Env vars (Vercel dashboard): RESEND_API_KEY, SUPABASE_SERVICE_KEY, CRON_SECRET
 */
import { db, unsubscribeUrl } from './_auth.js';
import { gatherMarket, buildEmail } from './_digest.js';

const SITE = process.env.DIGEST_BASE_URL || 'https://stocksightai.com';
const COLUMNS = 'email,name,watchlist,portfolio';

const SAMPLE = {
  email: 'sample@stocksightai.com', name: 'Alex',
  watchlist: [{ ticker: 'NVDA', type: 's' }, { ticker: 'AAPL', type: 's' }, { ticker: 'TSLA', type: 's' }, { ticker: 'BTC', type: 'c' }],
  portfolio: {
    holdings: [{ ticker: 'VOO', shares: 12, buyPrice: 480, type: 's' }, { ticker: 'MSFT', shares: 8, buyPrice: 410, type: 's' }, { ticker: 'AMZN', shares: 15, buyPrice: 185, type: 's' }],
    paper_trade: { cash: 4200, holdings: { NVDA: { shares: 20 }, AMD: { shares: 15 } } },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Only Vercel Cron ("Authorization: Bearer <CRON_SECRET>") or someone holding the secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers?.authorization || '';
    if (auth !== `Bearer ${cronSecret}` && req.query?.secret !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  }
  const resendKey = process.env.RESEND_API_KEY;
  const preview = req.query?.preview === '1';
  if (!process.env.SUPABASE_SERVICE_KEY || (!resendKey && !preview)) {
    console.error('digest: RESEND_API_KEY and SUPABASE_SERVICE_KEY must be set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const to = String(req.query?.to || '').trim().toLowerCase();
  let subscribers;
  try {
    subscribers = to
      ? await db(`users?email=eq.${encodeURIComponent(to)}&select=${COLUMNS}&limit=1`)
      : await db(`users?digest=eq.true&select=${COLUMNS}&limit=5000`);
  } catch (e) {
    console.error('digest: could not load subscribers', e.detail || e.message);
    return res.status(500).json({ error: 'Failed to fetch subscribers' });
  }
  subscribers = (Array.isArray(subscribers) ? subscribers : []).filter(s => s?.email);
  if (preview && !subscribers.length) subscribers = [SAMPLE];
  if (!subscribers.length) return res.status(200).json({ ok: true, sent: 0, message: to ? 'No account with that email' : 'No subscribers' });

  let market;
  try { market = await gatherMarket(preview ? subscribers.slice(0, 1) : subscribers); }
  catch (e) {
    console.error('digest: market data unavailable', e.message);
    return res.status(503).json({ error: 'Market data unavailable, nothing was sent' });
  }

  if (preview) {
    const { html } = buildEmail(subscribers[0], market, unsubscribeUrl(subscribers[0].email, SITE));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
  }

  const emails = [];
  const errors = [];
  for (const sub of subscribers) {
    try {
      const unsub = unsubscribeUrl(sub.email, SITE);
      const { subject, html, text } = buildEmail(sub, market, unsub);
      emails.push({
        from: 'StockSight <digest@stocksightai.com>', to: [sub.email], subject, html, text,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
    } catch (e) { errors.push({ email: sub.email, error: e.message }); }
  }

  // Resend takes up to 100 emails per call. The idempotency key stops a retried cron from double-sending.
  const weekKey = new Date(market.week.to).toISOString().slice(0, 10);
  let sent = 0;
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    try {
      const r = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json',
          ...(to ? {} : { 'Idempotency-Key': `digest-${weekKey}-${i / 100}` }),
        },
        body: JSON.stringify(chunk),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) sent += Array.isArray(body.data) ? body.data.length : chunk.length;
      else errors.push({ batch: i / 100, error: body.message || r.status });
    } catch (e) { errors.push({ batch: i / 100, error: e.message }); }
  }

  console.log(`Digest sent: ${sent}/${subscribers.length}, errors: ${errors.length}`);
  return res.status(200).json({ ok: true, sent, total: subscribers.length, errors });
}
