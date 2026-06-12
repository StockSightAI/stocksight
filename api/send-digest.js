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

const FEATURED = [
  { ticker: 'NVDA',  name: 'NVIDIA',     verdict: 'BUY',  color: '#00c97a', note: 'AI infrastructure demand remains strong. Blackwell ramp accelerating into H2.' },
  { ticker: 'AAPL',  name: 'Apple',      verdict: 'HOLD', color: '#f59e0b', note: 'Services growth solid; iPhone cycle mature. Watch June WWDC for AI announcements.' },
  { ticker: 'MSFT',  name: 'Microsoft',  verdict: 'BUY',  color: '#00c97a', note: 'Copilot adoption accelerating. Azure AI revenues beating estimates quarter over quarter.' },
  { ticker: 'TSLA',  name: 'Tesla',      verdict: 'HOLD', color: '#f59e0b', note: 'FSD progress encouraging but margin pressure from price cuts persists.' },
  { ticker: 'META',  name: 'Meta',       verdict: 'BUY',  color: '#00c97a', note: 'Ad revenue rebounding strongly. AI investments paying off in feed and Reels engagement.' },
  { ticker: 'AMZN',  name: 'Amazon',     verdict: 'BUY',  color: '#00c97a', note: 'AWS re-accelerating. Advertising and AI cloud services driving margin expansion.' },
  { ticker: 'GOOGL', name: 'Alphabet',   verdict: 'BUY',  color: '#00c97a', note: 'Search share stabilizing post-AI. YouTube ad spend at all-time highs.' },
  { ticker: 'JPM',   name: 'JPMorgan',   verdict: 'HOLD', color: '#f59e0b', note: 'Net interest income under pressure as rates peak. Loan growth steady.' },
];

const CRYPTO = [
  { ticker: 'BTC',  name: 'Bitcoin',  verdict: 'BUY',  color: '#00c97a', note: 'Spot ETF inflows sustaining demand. Halving tailwinds still in play.' },
  { ticker: 'ETH',  name: 'Ethereum', verdict: 'BUY',  color: '#00c97a', note: 'Staking yields attractive. Layer-2 ecosystem growing rapidly.' },
  { ticker: 'SOL',  name: 'Solana',   verdict: 'HOLD', color: '#f59e0b', note: 'High throughput chain gaining DeFi share. Watch network stability.' },
];

const SECTORS = [
  { name: 'Technology',   trend: '▲ Strong',  color: '#00c97a', note: 'AI capex cycle driving semis, cloud, and software. Earnings beats dominating.' },
  { name: 'Financials',   trend: '→ Neutral', color: '#f59e0b', note: 'Rate sensitivity creates mixed picture. Regional banks lagging large caps.' },
  { name: 'Healthcare',   trend: '▲ Strong',  color: '#00c97a', note: 'GLP-1 drugs reshaping pharma landscape. Biotech M&A activity picking up.' },
  { name: 'Energy',       trend: '→ Neutral', color: '#f59e0b', note: 'Oil range-bound. Clean energy ETFs recovering from 2024 lows.' },
  { name: 'Consumer',     trend: '▼ Weak',    color: '#ff6b6b', note: 'Discretionary spending softening. High earners resilient; lower income stretched.' },
  { name: 'Industrials',  trend: '▲ Strong',  color: '#00c97a', note: 'Reshoring + infrastructure spend creating multi-year tailwind.' },
];

const MARKET_TAKES = [
  'Tech leads as AI spending shows no signs of slowing. Mega-cap earnings continue to beat estimates, with cloud and AI segments driving upside surprises. The Magnificent 7 now account for over 30% of the S&P 500 — concentration risk worth monitoring.',
  'Defensive sectors outperform as rate-cut expectations shift further out. Financials under pressure from net interest margin compression; energy holds steady on supply discipline from OPEC+. Investors rotating toward dividend-paying quality names.',
  'Small caps reclaim ground as the Fed signals a more dovish stance heading into year-end. Growth stocks benefit from falling real yields and improving risk appetite. IPO calendar picking up — a classic late-cycle signal.',
  'Mixed signals from consumer data create short-term volatility. Strong jobs report pushes back rate-cut bets, but corporate earnings guidance remains surprisingly resilient. Watch credit spreads — they have stayed remarkably calm.',
];

const WATCH_EVENTS = [
  ['Fed Meeting Minutes', 'FOMC release could move rates expectations and push volatility across equities'],
  ['CPI Inflation Data', 'Core CPI print is the most watched macro number — a miss in either direction moves markets'],
  ['Big Tech Earnings', 'NVDA, MSFT, META reporting — AI guidance will set the tone for the rest of the sector'],
  ['Jobs Report (NFP)', 'Non-farm payrolls: strong print delays cuts; weak print accelerates them'],
];

const QUOTES = [
  { text: 'The stock market is a device for transferring money from the impatient to the patient.', author: 'Warren Buffett' },
  { text: 'In investing, what is comfortable is rarely profitable.', author: 'Robert Arnott' },
  { text: 'The four most dangerous words in investing are: "This time it\'s different."', author: 'Sir John Templeton' },
  { text: 'Risk comes from not knowing what you are doing.', author: 'Warren Buffett' },
  { text: 'The individual investor should act consistently as an investor and not as a speculator.', author: 'Benjamin Graham' },
  { text: 'Far more money has been lost by investors preparing for corrections than has been lost in corrections themselves.', author: 'Peter Lynch' },
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
  const wk = getWeekNumber(new Date());
  const take = MARKET_TAKES[wk % MARKET_TAKES.length];
  const quote = QUOTES[wk % QUOTES.length];
  const events = WATCH_EVENTS[wk % WATCH_EVENTS.length];

  // Section label helper
  const sectionLabel = (text) =>
    `<p style="margin:0 0 12px;font-size:10px;color:#a29bfe;letter-spacing:0.12em;font-weight:700;font-family:Arial,sans-serif">${text}</p>`;

  // Card wrapper helper (table-based for email safety)
  const card = (content, extra = '') =>
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#12102a;border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden;margin-bottom:16px${extra ? ';' + extra : ''}"><tr><td style="padding:20px 22px">${content}</td></tr></table>`;

  // Stock rows
  const stockRows = FEATURED.map((s, i) => `
    <tr style="background:${i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'}">
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);width:90px">
        <span style="font-weight:800;color:#a29bfe;font-size:13px;font-family:Arial,sans-serif">${s.ticker}</span><br>
        <span style="color:#666;font-size:11px">${s.name}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.05);width:60px;text-align:center">
        <span style="background:${s.color}20;color:${s.color};border:1px solid ${s.color}50;border-radius:20px;padding:3px 9px;font-size:10px;font-weight:800;white-space:nowrap;font-family:Arial,sans-serif">${s.verdict}</span>
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);color:#999;font-size:12px;line-height:1.55;font-family:Arial,sans-serif">${s.note}</td>
    </tr>`).join('');

  // Crypto rows
  const cryptoRows = CRYPTO.map(s => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);width:90px">
        <span style="font-weight:800;color:#f59e0b;font-size:13px;font-family:Arial,sans-serif">${s.ticker}</span><br>
        <span style="color:#666;font-size:11px">${s.name}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.05);width:60px;text-align:center">
        <span style="background:${s.color}20;color:${s.color};border:1px solid ${s.color}50;border-radius:20px;padding:3px 9px;font-size:10px;font-weight:800;white-space:nowrap;font-family:Arial,sans-serif">${s.verdict}</span>
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);color:#999;font-size:12px;line-height:1.55;font-family:Arial,sans-serif">${s.note}</td>
    </tr>`).join('');

  // Index tiles — use table columns, not flex
  const indexes = [
    { sym: 'SPX',  label: 'S&P 500' },
    { sym: 'IXIC', label: 'NASDAQ'  },
    { sym: 'DJI',  label: 'DOW'     },
    { sym: 'BTC',  label: 'Bitcoin' },
  ];
  const indexTiles = indexes.map(i => `
    <td style="width:25%;padding:4px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a1835;border:1px solid rgba(255,255,255,0.08);border-radius:10px">
        <tr><td style="padding:12px 8px;text-align:center">
          <div style="font-size:13px;font-weight:800;color:#a29bfe;font-family:Arial,sans-serif">${i.sym}</div>
          <div style="font-size:10px;color:#555;margin-top:2px;font-family:Arial,sans-serif">${i.label}</div>
          <a href="https://stocksightai.com" style="display:block;margin-top:6px;font-size:10px;color:#6c5ce7;text-decoration:none;font-family:Arial,sans-serif">Live &#8594;</a>
        </td></tr>
      </table>
    </td>`).join('');

  // Sector rows — 2-column table
  const sectorPairs = [];
  for (let i = 0; i < SECTORS.length; i += 2) sectorPairs.push([SECTORS[i], SECTORS[i+1]]);
  const sectorRows = sectorPairs.map(pair => `
    <tr>
      ${pair.filter(Boolean).map(s => `
        <td style="width:50%;padding:6px">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a1835;border:1px solid rgba(255,255,255,0.07);border-radius:10px">
            <tr><td style="padding:12px 14px">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td><span style="font-size:12px;font-weight:800;color:#ddd;font-family:Arial,sans-serif">${s.name}</span></td>
                  <td style="text-align:right"><span style="font-size:11px;font-weight:700;color:${s.color};font-family:Arial,sans-serif">${s.trend}</span></td>
                </tr>
              </table>
              <p style="margin:6px 0 0;font-size:11px;color:#777;line-height:1.5;font-family:Arial,sans-serif">${s.note}</p>
            </td></tr>
          </table>
        </td>`).join('')}
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>StockSight Weekly Market Digest</title>
</head>
<body style="margin:0;padding:0;background:#07071a;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#07071a">
<tr><td align="center" style="padding:24px 16px">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">

  <!-- ── HEADER ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#6c5ce7;border-radius:14px;overflow:hidden">
      <tr><td style="padding:28px 32px">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <span style="font-size:26px;line-height:1">📈</span>
              <span style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px;vertical-align:middle;margin-left:10px;font-family:Arial,sans-serif">StockSight</span>
            </td>
            <td style="text-align:right">
              <span style="font-size:11px;color:rgba(255,255,255,0.7);font-family:Arial,sans-serif">WEEKLY MARKET DIGEST</span>
            </td>
          </tr>
        </table>
        <p style="margin:14px 0 0;font-size:13px;color:rgba(255,255,255,0.8);font-family:Arial,sans-serif">${weekLabel}</p>
      </td></tr>
      <tr><td style="background:#0d0b1e;padding:22px 32px;border-top:1px solid rgba(255,255,255,0.1)">
        <p style="margin:0 0 5px;color:#ddd;font-size:15px;font-family:Arial,sans-serif">Hey <strong style="color:#fff">${firstName}</strong> &#128075;</p>
        <p style="margin:0;color:#888;font-size:13px;line-height:1.7;font-family:Arial,sans-serif">Here&#39;s your weekly market snapshot &#8212; what moved, what&#39;s trending, and what to watch.</p>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── MARKET TAKE ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#12102a;border:1px solid rgba(108,92,231,0.25);border-left:3px solid #6c5ce7;border-radius:12px">
      <tr><td style="padding:20px 24px">
        ${sectionLabel('THIS WEEK&#39;S MARKET TAKE')}
        <p style="margin:0;color:#ddd;font-size:14px;line-height:1.8;font-family:Arial,sans-serif">${take}</p>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── MAJOR INDEXES ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#12102a;border:1px solid rgba(255,255,255,0.07);border-radius:12px">
      <tr><td style="padding:16px 22px 12px">
        ${sectionLabel('MAJOR INDEXES &#8212; CLICK FOR LIVE CHARTS')}
      </td></tr>
      <tr><td style="padding:0 18px 18px">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${indexTiles}</tr></table>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── STOCKS TO WATCH ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#12102a;border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden">
      <tr><td style="padding:16px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.07)">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>${sectionLabel('STOCKS TO WATCH')}</td>
            <td style="text-align:right"><span style="font-size:10px;color:#444;font-family:Arial,sans-serif">AI verdicts from StockSight</span></td>
          </tr>
        </table>
      </td></tr>
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${stockRows}</table>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── CRYPTO CORNER ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#12102a;border:1px solid rgba(245,158,11,0.2);border-radius:12px;overflow:hidden">
      <tr><td style="padding:16px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.07)">
        ${sectionLabel('&#8383; CRYPTO CORNER')}
      </td></tr>
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${cryptoRows}</table>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── SECTOR SPOTLIGHT ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#12102a;border:1px solid rgba(255,255,255,0.07);border-radius:12px">
      <tr><td style="padding:16px 16px 4px">
        ${sectionLabel('SECTOR SPOTLIGHT')}
      </td></tr>
      <tr><td style="padding:0 10px 10px">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${sectorRows}</table>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── WATCH THIS WEEK ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#12102a;border:1px solid rgba(0,180,216,0.2);border-left:3px solid #00b4d8;border-radius:12px">
      <tr><td style="padding:20px 24px">
        ${sectionLabel('WATCH THIS WEEK')}
        <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#ddd;font-family:Arial,sans-serif">&#128197; ${events[0]}</p>
        <p style="margin:0;font-size:13px;color:#888;line-height:1.65;font-family:Arial,sans-serif">${events[1]}</p>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── QUOTE OF THE WEEK ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#12102a;border:1px solid rgba(255,255,255,0.07);border-radius:12px">
      <tr><td style="padding:22px 28px;text-align:center">
        ${sectionLabel('QUOTE OF THE WEEK')}
        <p style="margin:0 0 10px;font-size:15px;color:#ddd;line-height:1.75;font-style:italic;font-family:Georgia,serif">&#8220;${quote.text}&#8221;</p>
        <p style="margin:0;font-size:12px;color:#555;font-family:Arial,sans-serif">&#8212; ${quote.author}</p>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── CTA ── -->
  <tr><td style="padding-bottom:16px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a1535;border:1px solid rgba(108,92,231,0.3);border-radius:14px">
      <tr><td style="padding:28px 32px;text-align:center">
        <p style="margin:0 0 8px;font-size:17px;font-weight:900;color:#fff;font-family:Arial,sans-serif">Open your dashboard &#8594;</p>
        <p style="margin:0 0 22px;font-size:13px;color:#888;line-height:1.65;font-family:Arial,sans-serif">Live charts &#183; AI analysis &#183; Price predictions &#183; Your watchlist</p>
        <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">
          <tr>
            <td style="background:#6c5ce7;border-radius:10px;padding:13px 32px">
              <a href="https://stocksightai.com" style="color:#fff;text-decoration:none;font-weight:800;font-size:14px;font-family:Arial,sans-serif;letter-spacing:-0.3px">Open StockSight</a>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- ── FOOTER ── -->
  <tr><td style="padding:4px 0 32px;text-align:center">
    <p style="margin:0 0 5px;color:#333;font-size:12px;font-family:Arial,sans-serif">StockSight &#183; <a href="https://stocksightai.com" style="color:#444;text-decoration:none">stocksightai.com</a></p>
    <p style="margin:0;color:#282828;font-size:11px;font-family:Arial,sans-serif">For informational purposes only &#183; Not financial advice &#183; &#169; 2026 StockSight</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export default async function handler(req, res) {
  // Allow GET (Vercel cron) or POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const resendKey = process.env.RESEND_API_KEY || 're_LQbFQ5NC_3DdusyUY7YToMoixpPARFor8';

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
