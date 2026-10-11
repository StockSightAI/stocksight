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
 * Optional: DIGEST_REPORT_TO  your email (comma-separate several); after every Monday send it gets a
 *           short report: how many went out, which sections had data, and any errors or a failure.
 */
import { db, unsubscribeUrl } from './_auth.js';
import { gatherMarket, buildEmail, healthOf } from './_digest.js';

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

const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The after-send report to the owner (only for the real weekly send, never for tests or previews)
async function sendReport(resendKey, { ok, subject, lines = [], health = [], errors = [], started }) {
  const to = String(process.env.DIGEST_REPORT_TO || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!to.length || !resendKey) return;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const row = (k, v, good = true) => `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${escHtml(k)}</td><td style="padding:6px 0;color:${good ? '#17152b' : '#c62f46'}">${good ? '' : '⚠ '}${escHtml(v)}</td></tr>`;
  const html = `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;color:#17152b;max-width:560px">
    <p style="font-size:18px;font-weight:800;margin:0 0 4px">${ok ? '✅' : '❌'} ${escHtml(subject)}</p>
    <p style="color:#666;margin:0 0 16px">${new Date(started).toUTCString()} · took ${secs}s</p>
    <table style="border-collapse:collapse">${lines.map(([k, v, good]) => row(k, v, good !== false)).join('')}</table>
    ${health.length ? `<p style="font-weight:700;margin:18px 0 4px">What was in this week's email</p><table style="border-collapse:collapse">${health.map(([k, v, good]) => row(k, v, good)).join('')}</table>` : ''}
    ${errors.length ? `<p style="font-weight:700;margin:18px 0 4px;color:#c62f46">Errors (${errors.length})</p><ul style="margin:0;padding-left:18px">${errors.slice(0, 15).map(e => `<li>${escHtml(e.email || (e.batch != null ? `batch ${e.batch + 1}` : 'send'))}: ${escHtml(e.error)}</li>`).join('')}</ul>` : ''}
    <p style="color:#999;font-size:12px;margin:20px 0 0">Sent by /api/send-digest. To stop these reports, remove DIGEST_REPORT_TO in Vercel.</p></div>`;
  const text = [subject, ...lines.map(([k, v]) => `${k}: ${v}`), '', ...health.map(([k, v, good]) => `${good ? '' : '! '}${k}: ${v}`), ...errors.slice(0, 15).map(e => `ERROR ${e.email || 'batch'}: ${e.error}`)].join('\n');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'StockSight <digest@stocksightai.com>', to, subject: `[StockSight] ${subject}`, html, text }),
    });
    if (!r.ok) console.error('digest report not sent:', r.status);
  } catch (e) { console.error('digest report not sent:', e.message); }
}

export default async function handler(req, res) {
  const started = Date.now();
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
  const report = (to || preview) ? async () => {} : opts => sendReport(resendKey, { started, ...opts });
  try {
    return await run();
  } catch (e) {
    console.error('digest crashed:', e);
    await report({ ok: false, subject: 'Digest NOT sent: the job crashed', lines: [['Error', e.message || String(e), false]] });
    return res.status(500).json({ error: 'Digest failed' });
  }

  async function run() {
    let subscribers;
    try {
      subscribers = to
        ? await db(`users?email=eq.${encodeURIComponent(to)}&select=${COLUMNS}&limit=1`)
        : await db(`users?digest=eq.true&select=${COLUMNS}&limit=5000`);
    } catch (e) {
      console.error('digest: could not load subscribers', e.detail || e.message);
      await report({ ok: false, subject: 'Digest NOT sent: could not load subscribers', lines: [['Database', e.message, false]] });
      return res.status(500).json({ error: 'Failed to fetch subscribers' });
    }
    subscribers = (Array.isArray(subscribers) ? subscribers : []).filter(s => s?.email);
    if (preview && !subscribers.length) subscribers = [SAMPLE];
    if (!subscribers.length) return res.status(200).json({ ok: true, sent: 0, message: to ? 'No account with that email' : 'No subscribers' });

    let market;
    try { market = await gatherMarket(preview ? subscribers.slice(0, 1) : subscribers); }
    catch (e) {
      console.error('digest: market data unavailable', e.message);
      await report({ ok: false, subject: 'Digest NOT sent: market data unavailable', lines: [['Subscribers', String(subscribers.length)], ['Reason', e.message, false], ['What to do', 'Yahoo Finance likely had an outage. Re-run later with /api/send-digest?secret=YOUR_CRON_SECRET', false]] });
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
    const all = sent === subscribers.length;
    await report({
      ok: sent > 0 && all,
      subject: all ? `Digest sent to all ${sent} subscriber${sent === 1 ? '' : 's'}` : `Digest: ${sent} of ${subscribers.length} sent, ${subscribers.length - sent} failed`,
      lines: [['Sent', `${sent} of ${subscribers.length}`, all], ['Week', weekKey]],
      health: healthOf(market), errors,
    });
    return res.status(200).json({ ok: true, sent, total: subscribers.length, errors });
  }
}
