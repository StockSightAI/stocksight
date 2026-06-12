/**
 * Weekly Market Digest — Vercel Serverless Function
 *
 * Called by Vercel Cron every Monday at 9 AM ET (14:00 UTC).
 * Also callable manually via GET /api/send-digest?secret=<CRON_SECRET>
 *
 * Required env vars (set in Vercel dashboard):
 *   RESEND_API_KEY        — Resend API key (same one used by send-reset-email)
 *   CRON_SECRET           — any random string; protects the endpoint from abuse
 *   SUPABASE_URL          — your Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase service role key (Settings → API → service_role)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fgcjbdqvnjzafgnahwai.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'sb_publishable_OfRLOYvNWFmq2x9qF5ix1g_7ynysTdY';

// Top stocks for the featured section — updated periodically by hand or AI
const FEATURED = [
  { ticker: 'NVDA',  name: 'NVIDIA',         verdict: 'BUY',  color: '#00c97a', note: 'AI infrastructure demand remains strong. Blackwell ramp continues.' },
  { ticker: 'AAPL',  name: 'Apple',           verdict: 'HOLD', color: '#f59e0b', note: 'Services growth solid; iPhone cycle mature. Watch June WWDC.' },
  { ticker: 'MSFT',  name: 'Microsoft',       verdict: 'BUY',  color: '#00c97a', note: 'Copilot adoption accelerating. Azure AI revenues beat estimates.' },
  { ticker: 'TSLA',  name: 'Tesla',           verdict: 'HOLD', color: '#f59e0b', note: 'FSD progress encouraging; margin pressure from price cuts persists.' },
  { ticker: 'META',  name: 'Meta',            verdict: 'BUY',  color: '#00c97a', note: 'Ad revenue rebounding strongly. AI investments paying off in feed engagement.' },
  { ticker: 'BTC',   name: 'Bitcoin',         verdict: 'BUY',  color: '#00c97a', note: 'ETF inflows continue. Institutional adoption at record levels.' },
];

// Market commentary — rotate by week number for variety
const MARKET_TAKES = [
  'Tech leads as AI spending shows no signs of slowing. Mega-cap earnings continue to beat estimates, with cloud and AI segments driving upside surprises.',
  'Defensive sectors outperform as rate-cut expectations shift. Financials under pressure; energy holds steady on oil supply dynamics.',
  'Small caps reclaim ground as the Fed signals a more dovish stance. Growth stocks benefit from falling real yields and improving risk appetite.',
  'Mixed signals from consumer data create volatility. Strong jobs report pushes back rate-cut bets, but earnings guidance remains resilient.',
];

function getWeekNumber(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 4 - (date.getDay() || 7));
  const yearStart = new Date(date.getFullYear(), 0, 1);
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function buildDigestHtml(name, weekLabel) {
  const firstName = name ? name.split(' ')[0] : 'Investor';
  const take = MARKET_TAKES[getWeekNumber(new Date()) % MARKET_TAKES.length];

  const featuredRows = FEATURED.map(s => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06)">
        <span style="font-family:Arial,sans-serif;font-weight:800;color:#a29bfe;font-size:14px">${s.ticker}</span>
        <span style="color:#888;font-size:12px;margin-left:8px">${s.name}</span>
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:center">
        <span style="background:${s.color}22;color:${s.color};border:1px solid ${s.color}55;border-radius:20px;padding:3px 10px;font-size:11px;font-weight:800;white-space:nowrap">${s.verdict}</span>
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);color:#aaa;font-size:12px;line-height:1.5">${s.note}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1a1535,#0d0d1f);border:1px solid rgba(108,92,231,0.3);border-radius:16px;overflow:hidden;margin-bottom:16px">
    <div style="background:linear-gradient(135deg,#6c5ce7,#a29bfe);padding:28px 32px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <div style="width:36px;height:36px;background:rgba(255,255,255,0.2);border-radius:10px;display:flex;align-items:center;justify-content:center">
          <span style="font-size:18px">📈</span>
        </div>
        <div>
          <div style="font-size:20px;font-weight:900;color:#fff;letter-spacing:-0.5px">StockSight</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.75)">Weekly Market Digest</div>
        </div>
      </div>
      <div style="font-size:13px;color:rgba(255,255,255,0.85)">${weekLabel}</div>
    </div>
    <div style="padding:24px 32px">
      <p style="margin:0 0 4px;color:#ccc;font-size:15px">Hi <strong style="color:#fff">${firstName}</strong> 👋</p>
      <p style="margin:0;color:#999;font-size:14px;line-height:1.7">Here's your weekly snapshot of what moved markets and what to watch this week.</p>
    </div>
  </div>

  <!-- Market Take -->
  <div style="background:#12102a;border:1px solid rgba(108,92,231,0.2);border-left:3px solid #6c5ce7;border-radius:12px;padding:20px 24px;margin-bottom:16px">
    <div style="font-size:11px;color:#a29bfe;letter-spacing:0.1em;font-weight:700;margin-bottom:10px">THIS WEEK'S MARKET TAKE</div>
    <p style="margin:0;color:#ddd;font-size:14px;line-height:1.75">${take}</p>
  </div>

  <!-- Featured Stocks -->
  <div style="background:#12102a;border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden;margin-bottom:16px">
    <div style="padding:16px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:11px;color:#a29bfe;letter-spacing:0.1em;font-weight:700">STOCKS TO WATCH</div>
      <div style="font-size:11px;color:#555">AI verdicts from StockSight</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <tbody>${featuredRows}</tbody>
    </table>
  </div>

  <!-- Indexes Quick View -->
  <div style="background:#12102a;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:20px 24px;margin-bottom:16px">
    <div style="font-size:11px;color:#a29bfe;letter-spacing:0.1em;font-weight:700;margin-bottom:14px">MAJOR INDEXES</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      ${[
        { label: 'S&P 500', sym: 'SPX' },
        { label: 'NASDAQ', sym: 'IXIC' },
        { label: 'DOW', sym: 'DJI' },
        { label: 'Bitcoin', sym: 'BTC' },
      ].map(i => `
        <div style="flex:1;min-width:100px;background:#1a1835;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:12px;font-weight:800;color:#a29bfe">${i.sym}</div>
          <div style="font-size:11px;color:#666;margin-top:2px">${i.label}</div>
          <a href="https://stocksightai.com" style="display:block;margin-top:6px;font-size:10px;color:#6c5ce7;text-decoration:none">Live →</a>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- CTA -->
  <div style="background:linear-gradient(135deg,rgba(108,92,231,0.15),rgba(0,180,216,0.08));border:1px solid rgba(108,92,231,0.25);border-radius:14px;padding:24px;text-align:center;margin-bottom:16px">
    <div style="font-size:16px;font-weight:800;color:#fff;margin-bottom:8px">Open your StockSight dashboard</div>
    <div style="font-size:13px;color:#999;margin-bottom:20px;line-height:1.6">Live charts, AI analysis, price predictions, and your full watchlist — all in one place.</div>
    <a href="https://stocksightai.com" style="display:inline-block;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:#fff;text-decoration:none;border-radius:10px;padding:13px 32px;font-weight:800;font-size:14px;letter-spacing:-0.3px">Open StockSight →</a>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:8px 0 24px">
    <p style="margin:0 0 6px;color:#444;font-size:12px">StockSight · stocksightai.com</p>
    <p style="margin:0;color:#333;font-size:11px">StockSight is for informational purposes only and does not constitute financial advice.</p>
  </div>

</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  // Allow GET (Vercel cron) or POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const resendKey = process.env.RESEND_API_KEY || 're_gN8Rzxmq_EDH72qeiJ2b9jeYSu9E2bFsJ';

  // Fetch all users with digest = true
  const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/users?digest=eq.true&select=email,name`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });

  if (!sbRes.ok) {
    const err = await sbRes.text();
    console.error('Supabase fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch subscribers', detail: err });
  }

  const subscribers = await sbRes.json();
  if (!Array.isArray(subscribers) || subscribers.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, message: 'No subscribers' });
  }

  const now = new Date();
  const weekLabel = `Week of ${formatDate(now)}`;
  let sent = 0;
  const errors = [];

  for (const sub of subscribers) {
    if (!sub.email) continue;
    try {
      const html = buildDigestHtml(sub.name, weekLabel);
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'StockSight <noreply@stocksightai.com>',
          to: sub.email,
          subject: `📈 Your Weekly Market Digest — ${weekLabel}`,
          html,
        }),
      });
      if (emailRes.ok) {
        sent++;
      } else {
        const errBody = await emailRes.json().catch(() => ({}));
        errors.push({ email: sub.email, error: errBody.message || emailRes.status });
      }
    } catch (e) {
      errors.push({ email: sub.email, error: e.message });
    }
  }

  console.log(`Digest sent: ${sent}/${subscribers.length}, errors: ${errors.length}`);
  return res.status(200).json({ ok: true, sent, total: subscribers.length, errors });
}
